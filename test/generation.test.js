import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BATCH_CONCURRENCY, MAX_BATCH_IMAGES, generateBatch, isRetryable } from '../lib/generation.js'

const pngImage = { kind: 'base64', data: 'A'.repeat(400), mime: 'image/png' }
const ok = (delay = 0, extra = {}) => async () => {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  return { images: [pngImage], meta: { protocol: 'images', ...extra } }
}

test('generateBatch 一次请求一张，按张并发且不超过上限', async () => {
  let live = 0
  let peak = 0
  const generate = async () => {
    live++
    peak = Math.max(peak, live)
    await new Promise((resolve) => setTimeout(resolve, 12))
    live--
    return { images: [pngImage], meta: { protocol: 'images' } }
  }
  const result = await generateBatch({ generate, n: 4, concurrency: 2, retries: 0 })
  assert.equal(result.images.length, 4)
  assert.equal(peak, 2, '并发应当用满设置的上限，实际 ' + peak)
  assert.equal(result.meta.requested, 4)
  assert.equal(result.meta.generated, 4)
  assert.equal(result.meta.failed, 0)
  assert.equal(result.meta.concurrency, 2)
  assert.equal(result.meta.attempts, 4, '没有失败就不该有额外尝试')
})

test('generateBatch 把 n 钳到 1..4，并发钳到 1..4', async () => {
  let requested = 0
  const generate = async () => { requested++; return { images: [pngImage], meta: {} } }
  await generateBatch({ generate, n: 99, concurrency: 99, retries: 0 })
  assert.equal(requested, MAX_BATCH_IMAGES)
  assert.equal(MAX_BATCH_CONCURRENCY, 4)
})

test('generateBatch 部分失败时保留成功结果并列出错误', async () => {
  let calls = 0
  const generate = async () => {
    calls++
    if (calls === 1) {
      const error = new Error('上游返回 503：busy')
      error.upstreamStatus = 503
      throw error
    }
    return { images: [pngImage], meta: { protocol: 'images' } }
  }
  const result = await generateBatch({ generate, n: 3, concurrency: 3, retries: 0 })
  assert.equal(result.images.length, 2, '两张成功必须保留')
  assert.equal(result.meta.generated, 2)
  assert.equal(result.meta.failed, 1)
  assert.equal(result.meta.errors.length, 1)
  assert.equal(result.meta.errors[0].error, '上游返回 503：busy')
})

test('generateBatch 全部失败时抛出聚合错误（保留首个原因与状态码）', async () => {
  const generate = async () => {
    const error = new Error('上游返回 401：无效的 Key')
    error.upstreamStatus = 401
    error.status = 502
    error.code = 'UPSTREAM_ERROR'
    throw error
  }
  await assert.rejects(generateBatch({ generate, n: 2, concurrency: 2, retries: 0 }), (error) => {
    assert.match(error.message, /2 张图片均生成失败/)
    assert.match(error.message, /无效的 Key/)
    assert.equal(error.code, 'UPSTREAM_ERROR')
    assert.equal(error.status, 502)
    return true
  })
})

test('generateBatch 对可重试错误退避重试，成功计入 attempts', async () => {
  let calls = 0
  const generate = async () => {
    calls++
    if (calls === 1) {
      const error = new Error('上游返回 429：限流')
      error.upstreamStatus = 429
      error.retryAfterMs = 1
      throw error
    }
    return { images: [pngImage], meta: {} }
  }
  const result = await generateBatch({ generate, n: 1, concurrency: 1, retries: 2, retryDelayMs: 1 })
  assert.equal(calls, 2)
  assert.equal(result.meta.attempts, 2, '重试次数应被统计进 attempts')
  assert.equal(result.images.length, 1)
})

test('generateBatch 不重试 4xx（除了 408/409/429）', async () => {
  let calls = 0
  const generate = async () => {
    calls++
    const error = new Error('上游返回 400：提示词违规')
    error.upstreamStatus = 400
    throw error
  }
  await assert.rejects(generateBatch({ generate, n: 1, concurrency: 1, retries: 3, retryDelayMs: 1 }))
  assert.equal(calls, 1, '400 不该重试')
})

test('isRetryable 判定：网络/超时/5xx/429 可重试，取消与 4xx 不可', () => {
  assert.equal(isRetryable(Object.assign(new Error('x'), { upstreamStatus: 500 })), true)
  assert.equal(isRetryable(Object.assign(new Error('x'), { upstreamStatus: 429 })), true)
  assert.equal(isRetryable(Object.assign(new Error('x'), { upstreamStatus: 408 })), true)
  assert.equal(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true)
  assert.equal(isRetryable(Object.assign(new Error('x'), { code: 'TIMEOUT' })), false, 'TIMEOUT 由 code 决定，需显式 retryable')
  assert.equal(isRetryable(Object.assign(new Error('x'), { code: 'TIMEOUT', retryable: true })), true)
  assert.equal(isRetryable(Object.assign(new Error('x'), { upstreamStatus: 404 })), false)
  assert.equal(isRetryable(Object.assign(new Error('x'), { name: 'AbortError' })), false)
})

test('generateBatch 逐张回调按完成顺序触发，并可用回调返回值替换图片', async () => {
  const seen = []
  const generate = async ({ signal }) => {
    // 第二张故意慢：验证回调是“完成即触发”，不是等整批。
    await new Promise((resolve) => setTimeout(resolve, 8))
    return { images: [{ kind: 'base64', data: 'B'.repeat(400) }], meta: {} }
  }
  const result = await generateBatch({
    generate,
    n: 2,
    concurrency: 2,
    retries: 0,
    onProgress: async (progress) => {
      seen.push({ completed: progress.completed, index: progress.index, count: progress.images.length })
      return [{ kind: 'url', url: '/api/x', relPath: progress.index + '/x.png' }]
    }
  })
  assert.deepEqual(seen.map(item => item.completed), [1, 2], '每次完成都要回调一次')
  assert.equal(result.images.length, 2)
  assert.ok(result.images.every(item => item.kind === 'url'), '回调返回值应替换原始图片形态')
})

test('generateBatch 回调抛错不会毁掉整批（记入 warnings）', async () => {
  const result = await generateBatch({
    generate: ok(1),
    n: 2,
    concurrency: 2,
    retries: 0,
    onProgress: async () => { throw new Error('磁盘写满了') }
  })
  assert.equal(result.images.length, 2, '原始 base64 图片仍要交回')
  assert.equal(result.meta.warnings.length, 2)
  assert.equal(result.meta.warnings[0].code, 'SAVE_FAILED')
})

test('generateBatch 支持全局队列 schedule：跨批次共享并发', async () => {
  let live = 0
  let peak = 0
  const task = () => async () => {
    live++
    peak = Math.max(peak, live)
    await new Promise((resolve) => setTimeout(resolve, 10))
    live--
    return { images: [pngImage], meta: {} }
  }
  const { createLimiter } = await import('../lib/concurrency.js')
  const limiter = createLimiter({ concurrency: 2 })
  const schedule = (fn, options) => limiter.run(fn, options)
  const batches = await Promise.all([
    generateBatch({ generate: task(), schedule, n: 3, concurrency: 3, retries: 0 }),
    generateBatch({ generate: task(), schedule, n: 3, concurrency: 3, retries: 0 })
  ])
  assert.equal(batches.reduce((sum, b) => sum + b.images.length, 0), 6)
  assert.ok(peak <= 2, '全局队列必须限住宿主同时请求数，peak=' + peak)
})

test('generateBatch 取消后停止启动新任务，已完成的图仍返回', async () => {
  const controller = new AbortController()
  let started = 0
  const generate = async () => {
    started++
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (controller.signal.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    return { images: [pngImage], meta: {} }
  }
  const pending = generateBatch({ generate, n: 4, concurrency: 1, retries: 0, signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  const result = await pending
  assert.ok(result.meta.cancelled, 'meta.cancelled 应为 true')
  assert.ok(result.images.length >= 1, '已完成的图不能因为取消而丢掉')
  assert.ok(started < 4, '取消后不应继续跑完整批，started=' + started)
  assert.equal(result.meta.requested, 4)
  assert.equal(result.meta.generated + result.meta.failed, 4, '统计口径必须闭合')
})

test('generateBatch 空提示词由 provider 抛出（不吞错误）', async () => {
  await assert.rejects(
    generateBatch({
      generate: async () => { throw new Error('提示词不能为空') },
      n: 1,
      concurrency: 1,
      retries: 0,
      prompt: '  '
    }),
    /提示词不能为空/
  )
})
