export function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  const integer = Number.isFinite(number) ? Math.floor(number) : fallback
  return Math.max(min, Math.min(max, integer))
}

export function abortError(reason) {
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' ? reason : '已取消')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

export async function mapLimit(items, limit, mapper, options = {}) {
  const signal = options.signal
  const values = Array.from(items || [])
  if (values.length === 0) return []
  // 必须是稠密数组：new Array(n) 的空洞会被 map/filter 跳过，取消时留下的空洞会漏计。
  const results = new Array(values.length).fill(undefined)
  let cursor = 0
  const worker = async () => {
    while (!signal?.aborted) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      results[index] = await mapper(values[index], index)
    }
  }
  const count = Math.min(values.length, clampInteger(limit, 1, 1, values.length))
  await Promise.all(Array.from({ length: count }, worker))
  return results
}

export function createLimiter(options = {}) {
  const maxPending = options.maxPending ?? 64
  let limit = clampInteger(options.concurrency, 3, 1, 32)
  let active = 0
  const pending = []

  function stats() {
    return { concurrency: limit, active, pending: pending.length, maxPending }
  }

  function pump() {
    while (active < limit && pending.length > 0) {
      const job = pending.shift()
      job.cleanup()
      if (job.signal?.aborted) {
        job.reject(abortError(job.signal.reason))
        continue
      }
      active += 1
      job.startedAt = Date.now()
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
        active -= 1
        pump()
      })
    }
  }

  function run(task, options = {}) {
    const signal = options.signal
    if (typeof task !== 'function') return Promise.reject(new TypeError('task 必须是函数'))
    if (signal?.aborted) return Promise.reject(abortError(signal.reason))
    if (pending.length >= maxPending) {
      const error = new Error('生成队列已满，请稍后重试或减少并发')
      error.code = 'QUEUE_FULL'
      error.status = 429
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      let onAbort
      const job = {
        task, signal, resolve, reject, enqueuedAt: Date.now(),
        cleanup: () => signal?.removeEventListener?.('abort', onAbort)
      }
      onAbort = () => {
        const index = pending.indexOf(job)
        if (index < 0) return
        pending.splice(index, 1)
        job.cleanup()
        reject(abortError(signal.reason))
        pump()
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      pending.push(job)
      pump()
    })
  }

  function setConcurrency(value) {
    limit = clampInteger(value, limit, 1, 32)
    pump()
    return limit
  }

  return { run, setConcurrency, stats }
}
