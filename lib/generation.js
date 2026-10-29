import { abortError, clampInteger, mapLimit } from './concurrency.js'
import { generate as defaultGenerate } from './provider.js'

export const MAX_BATCH_IMAGES = 4
export const MAX_BATCH_CONCURRENCY = 4

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      reject(abortError(signal?.reason))
    }
    const done = () => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }
    timer = setTimeout(done, ms)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export function isRetryable(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return false
  const status = Number(error?.upstreamStatus ?? error?.status)
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true
  return error?.retryable === true || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'FETCH_FAILED', 'UPSTREAM_DISCONNECTED'].includes(error?.code)
}

async function withRetry(task, options) {
  const { retries, signal, retryDelayMs } = options
  let attempt = 0
  while (true) {
    try {
      return { value: await task(attempt), attempts: attempt + 1 }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal.reason || error)
      if (attempt >= retries || !isRetryable(error)) throw error
      const retryAfter = Number(error?.retryAfterMs)
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(retryAfter, 30_000)
        : Math.min(400 * (2 ** attempt), 4000)
      await sleep(Number.isFinite(retryDelayMs) ? retryDelayMs : delay, signal)
      attempt += 1
    }
  }
}

export async function generateBatch(params = {}) {
  const {
    generate = defaultGenerate,
    schedule,
    n,
    concurrency,
    retries = 1,
    retryDelayMs,
    signal,
    onProgress,
    ...single
  } = params
  const count = clampInteger(n, 1, 1, MAX_BATCH_IMAGES)
  const parallel = Math.min(count, clampInteger(concurrency, 2, 1, MAX_BATCH_CONCURRENCY))
  const retryCount = clampInteger(retries, 1, 0, 3)
  const startedAt = Date.now()
  let completed = 0
  const warnings = []

  const settled = await mapLimit(Array.from({ length: count }, (_, index) => index), parallel, async index => {
    if (signal?.aborted) return { status: 'rejected', reason: abortError(signal.reason), index }
    try {
      const run = () => generate({ ...single, n: 1, signal })
      const result = await withRetry(
        () => schedule ? schedule(run, { signal }) : run(),
        { retries: retryCount, signal, retryDelayMs }
      )
      completed += 1
      let value = result.value
      try {
        const hook = await onProgress?.({ completed, requested: count, index, images: value.images || [], meta: value.meta || {} })
        // hook 可以返回替换后的图片列表（例如落盘后换成带鉴权的 URL），省掉几 MB base64 回传。
        const replacement = Array.isArray(hook) ? hook : hook?.images
        if (Array.isArray(replacement) && replacement.length > 0) value = { ...value, images: replacement }
      } catch (error) {
        warnings.push({ index, code: 'SAVE_FAILED', error: String(error?.message || error) })
      }
      return { status: 'fulfilled', value, attempts: result.attempts, index }
    } catch (reason) {
      completed += 1
      try { await onProgress?.({ completed, requested: count, index, error: reason }) } catch { /* 进度不影响结果 */ }
      return { status: 'rejected', reason, index }
    }
  }, { signal })

  // 取消会让 mapLimit 提前收工、留下空洞：补齐成“被取消”，统计口径才和 requested 一致。
  const normalized = settled.map((item, index) => item || {
    status: 'rejected',
    index,
    reason: signal?.aborted ? abortError(signal.reason || '生成已取消') : new Error('未执行')
  })
  const successful = normalized.filter(item => item.status === 'fulfilled')
  const failed = normalized.filter(item => item.status === 'rejected')
  const images = successful.flatMap(item => item.value.images || [])
  const errors = failed.map(item => ({
    index: item.index,
    code: String(item.reason?.code || 'GENERATION_FAILED'),
    error: String(item.reason?.message || item.reason || '生成失败')
  }))
  if (images.length === 0) {
    const first = failed[0]?.reason || new Error('生成已取消')
    if (signal?.aborted) throw abortError(signal.reason || first)
    const error = new Error(count > 1 ? count + ' 张图片均生成失败；第 1 张：' + (first.message || first) : String(first.message || first))
    error.code = first.code || 'GENERATION_FAILED'
    error.status = first.status || 502
    error.upstreamStatus = first.upstreamStatus
    error.cause = first
    throw error
  }

  const firstMeta = successful[0]?.value.meta || {}
  return {
    images,
    meta: {
      ...firstMeta,
      requested: count,
      generated: images.length,
      failed: errors.length,
      concurrency: parallel,
      attempts: successful.reduce((sum, item) => sum + item.attempts, 0),
      cancelled: Boolean(signal?.aborted),
      batchMs: Date.now() - startedAt,
      ...(errors.length > 0 ? { errors } : {}),
      ...(warnings.length > 0 ? { warnings } : {})
    }
  }
}
