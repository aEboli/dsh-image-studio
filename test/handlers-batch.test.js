import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAssetLibrary } from '../lib/assets.js'
import { createHandlers } from '../lib/handlers.js'
import { createBatchRegistry } from '../lib/batch-registry.js'
import { createLimiter } from '../lib/concurrency.js'
import { describeState } from '../lib/config.js'
import { readFile } from 'node:fs/promises'

const builtin = JSON.parse(await readFile(new URL('../assets/builtin.json', import.meta.url), 'utf8'))

function fakeSettings(overrides = {}) {
  const state = {
    revision: 1,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-1234',
    imageModel: 'gpt-image-2',
    protocol: 'images',
    timeoutMs: 5000,
    maxConcurrentImages: 3,
    defaultImageCount: 2,
    ...overrides
  }
  return {
    async read() { return state },
    async describe() { return describeState(state) },
    async active() { return state },
    async save(input) { return describeState({ ...state, ...input, revision: state.revision + 1 }) }
  }
}

const image = (tag) => ({ kind: 'base64', data: tag.repeat(120), mime: 'image/png' })

function makeHandlers(deps = {}) {
  const assets = createAssetLibrary({ builtin, store: { async read() {}, async write() {} } })
  return createHandlers({
    settings: fakeSettings(),
    assets,
    generate: deps.generate || (async () => ({ images: [image('A')], meta: { protocol: 'images' } })),
    ...deps
  })
}

const post = (path, body) => new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })
const get = (path) => new Request(`http://localhost${path}`)

test('n>1 时逐张调用 provider，并把结果合并返回', async () => {
  let calls = 0
  const handlers = makeHandlers({
    generate: async () => { calls++; return { images: [image('B'.repeat(calls))], meta: { protocol: 'images' } } }
  })
  const payload = await (await handlers.generate(post('/api/image-studio.generate', { prompt: 'cat', n: 3 }))).json()
  assert.equal(calls, 3, 'n=3 应当发 3 次单图请求')
  assert.equal(payload.images.length, 3)
  assert.equal(payload.meta.requested, 3)
  assert.equal(payload.meta.generated, 3)
  assert.equal(payload.meta.failed, 0)
})

test('n 超过 4 会被钳到 4（界面/Agent 都不能越权多烧）', async () => {
  let calls = 0
  const handlers = makeHandlers({ generate: async () => { calls++; return { images: [image('C')], meta: {} } } })
  await handlers.generate(post('/api/image-studio.generate', { prompt: 'cat', n: 99 }))
  assert.equal(calls, 4)
})

test('逐张落盘：每张出图立刻调用 onGenerated，base64 不回传浏览器', async () => {
  const seen = []
  const handlers = makeHandlers({
    generate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { images: [image('D')], meta: {} }
    },
    onGenerated: async (payload) => {
      assert.equal(payload.partial, true)
      assert.ok(Number.isFinite(payload.meta.imageIndex))
      // 模拟 host 落盘：原地替换成 URL 形态并返回磁盘描述符
      payload.images = [{ kind: 'url', url: '/api/image-studio.image?file=x', relPath: payload.meta.imageIndex + '/x.png', bytes: 12 }]
      seen.push(payload.meta.imageIndex)
      return [{ path: 'C:/x.png', relPath: payload.meta.imageIndex + '/x.png', bytes: 12, name: 'x.png' }]
    }
  })
  const payload = await (await handlers.generate(post('/api/image-studio.generate', { prompt: 'cat', n: 3, batchId: 'h-1' }))).json()
  assert.equal(seen.length, 3, '每张都应触发一次落盘')
  assert.equal(payload.saved.length, 3)
  assert.ok(payload.images.every(item => item.kind === 'url'), '回给浏览器的必须是 URL 形态')
  assert.equal(payload.images.some(item => item.data), false)
})

test('schedule 队列跨请求限流：两个批次共用同一个并发上限', async () => {
  let live = 0
  let peak = 0
  const limiter = createLimiter({ concurrency: 2 })
  const handlers = makeHandlers({
    schedule: (task, options) => limiter.run(task, options),
    getQueueStats: () => limiter.stats(),
    generate: async () => {
      live++
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 15))
      live--
      return { images: [image('E')], meta: {} }
    }
  })
  await Promise.all([
    handlers.generate(post('/api/image-studio.generate', { prompt: 'a', n: 3, concurrency: 3 })),
    handlers.generate(post('/api/image-studio.generate', { prompt: 'b', n: 3, concurrency: 3 }))
  ])
  assert.ok(peak <= 2, '全局并发被击穿：peak=' + peak)
  assert.ok(peak >= 2, '并发没有被用起来：peak=' + peak)
})

test('progress 端点反映批次真实进度；未知批次 404', async () => {
  const registry = createBatchRegistry()
  const handlers = makeHandlers({
    batch: registry,
    getQueueStats: () => ({ concurrency: 3, active: 0, pending: 0, maxPending: 64 }),
    generate: async () => { await new Promise((r) => setTimeout(r, 6)); return { images: [image('F')], meta: {} } }
  })
  const inFlight = handlers.generate(post('/api/image-studio.generate', { prompt: 'cat', n: 2, batchId: 'p-1' }))
  // begin() 在 readJsonBody/settings 之后执行；真实界面 900ms 才轮询，这里等一个 tick 即可。
  await new Promise((resolve) => setTimeout(resolve, 2))
  const early = await handlers.progress(get('/api/image-studio.progress?batch=p-1'))
  const earlyBody = await early.json()
  assert.equal(early.status, 200)
  assert.equal(earlyBody.requested, 2)
  await inFlight
  const done = await (await handlers.progress(get('/api/image-studio.progress?batch=p-1'))).json()
  assert.equal(done.completed, 2)
  assert.equal(done.generated, 2)
  assert.equal(done.finished, true)
  assert.equal(done.queue.concurrency, 3)
  const missing = await handlers.progress(get('/api/image-studio.progress?batch=nope'))
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'BATCH_NOT_FOUND')
  const listing = await (await handlers.progress(get('/api/image-studio.progress'))).json()
  assert.ok(Array.isArray(listing.batches))
})

test('progress 挡住非法 batchId（不查表、不泄露）', async () => {
  const registry = createBatchRegistry()
  const handlers = makeHandlers({ batch: registry })
  const bad = await handlers.progress(get('/api/image-studio.progress?batch=' + encodeURIComponent('../../etc/passwd')))
  assert.equal(bad.status, 404)
})

test('queue 端点暴露并发上限/运行中/排队中', async () => {
  const limiter = createLimiter({ concurrency: 4 })
  const handlers = makeHandlers({ schedule: (t, o) => limiter.run(t, o), getQueueStats: () => limiter.stats() })
  const body = await (await handlers.queue(get('/api/image-studio.queue'))).json()
  assert.equal(body.concurrency, 4)
  assert.equal(body.active, 0)
  assert.equal(body.pending, 0)
})

test('部分失败：成功的那张照常返回，失败信息进 meta.errors，状态码仍是 200', async () => {
  let calls = 0
  const handlers = makeHandlers({
    retries: 0,
    generate: async () => {
      calls++
      if (calls === 1) { const e = new Error('上游返回 429：限流'); e.upstreamStatus = 429; throw e }
      return { images: [image('G')], meta: {} }
    }
  })
  const response = await handlers.generate(post('/api/image-studio.generate', { prompt: 'cat', n: 2, retries: 0 }))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.images.length, 1)
  assert.equal(payload.meta.failed, 1)
  assert.match(payload.meta.errors[0].error, /限流/)
})

test('全部失败投影为 502 + GENERATION_FAILED/UPSTREAM_ERROR 语义', async () => {
  const handlers = makeHandlers({
    generate: async () => {
      const e = new Error('上游返回 401：无效的 Key')
      e.upstreamStatus = 401
      e.code = 'UPSTREAM_ERROR'
      e.status = 502
      throw e
    }
  })
  const response = await handlers.generate(post('/api/image-studio.generate', { prompt: 'cat', n: 2, retries: 0 }))
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.match(body.error, /2 张图片均生成失败/)
  assert.match(body.error, /无效的 Key/)
  assert.equal(body.code, 'UPSTREAM_ERROR')
})

test('取消：已完成的图仍落盘并返回（不浪费已付费产物）', async () => {
  const controller = new AbortController()
  let calls = 0
  const saved = []
  const handlers = makeHandlers({
    onGenerated: (payload) => { saved.push(payload.meta.imageIndex); payload.images = [{ kind: 'url', url: '/x', relPath: 'x.png' }]; return [{ relPath: 'x.png' }] },
    generate: async ({ signal }) => {
      calls++
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 12)
        signal?.addEventListener?.('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
      })
      if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return { images: [image('H')], meta: {} }
    }
  })
  const request = new Request('http://localhost/api/image-studio.generate', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'cat', n: 4, concurrency: 1, retries: 0, batchId: 'c-1' }),
    signal: controller.signal
  })
  setTimeout(() => controller.abort(), 20)
  const response = await handlers.generate(request)
  const payload = await response.json()
  assert.ok(calls >= 1 && calls < 4, '应当提前收工，calls=' + calls)
  if (response.status === 200) {
    assert.equal(payload.meta.cancelled, true)
    assert.ok(payload.images.length >= 1, '已完成的图必须还给界面')
    assert.equal(payload.meta.generated + payload.meta.failed, 4, '统计口径闭合')
  } else {
    assert.ok([499, 502].includes(response.status), 'status ' + response.status)
  }
})

test('队列满时返回 429 QUEUE_FULL', async () => {
  const limiter = createLimiter({ concurrency: 1, maxPending: 1 })
  const handlers = makeHandlers({
    schedule: (task, options) => limiter.run(task, options),
    getQueueStats: () => limiter.stats(),
    generate: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { images: [image('I')], meta: {} } }
  })
  const first = handlers.generate(post('/api/image-studio.generate', { prompt: 'a', n: 1, retries: 0 }))
  const second = handlers.generate(post('/api/image-studio.generate', { prompt: 'b', n: 1, retries: 0 }))
  const third = handlers.generate(post('/api/image-studio.generate', { prompt: 'c', n: 1, retries: 0 }))
  const responses = await Promise.all([first, second, third])
  const codes = responses.map(r => r.status)
  assert.ok(codes.includes(429), '至少一个请求应被拒：' + codes.join(','))
  const rejected = responses.find(r => r.status === 429)
  assert.equal((await rejected.json()).code, 'QUEUE_FULL')
  await Promise.all(responses.filter(r => r !== rejected).map(r => r.json()))
})

test('队列稍满时会自动重试（retries>0 走退避恢复，不直接失败）', async () => {
  const limiter = createLimiter({ concurrency: 1, maxPending: 1 })
  const handlers = makeHandlers({
    retries: 2,
    schedule: (task, options) => limiter.run(task, options),
    getQueueStats: () => limiter.stats(),
    generate: async () => { await new Promise((resolve) => setTimeout(resolve, 12)); return { images: [image('K')], meta: {} } }
  })
  const responses = await Promise.all([1, 2, 3, 4].map((i) => handlers.generate(post('/api/image-studio.generate', { prompt: 'p' + i, n: 1 }))))
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200, 200], '退避重试应让全部批次最终成功')
  const bodies = await Promise.all(responses.map(r => r.json()))
  assert.ok(bodies.some(b => (b.meta?.attempts ?? 0) > 1), '至少一个批次发生过重试')
})

test('取消接口：host 端按 batchId 能真的中止还在跑的批次', async () => {
  const registry = createBatchRegistry()
  let sawSignal
  const handlers = makeHandlers({
    batch: registry,
    generate: async ({ signal }) => {
      sawSignal = signal
      await new Promise((resolve) => setTimeout(resolve, 60))
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
      return { images: [image('L')], meta: {} }
    }
  })
  const inFlight = handlers.generate(post('/api/image-studio.generate', { prompt: 'cat', n: 1, batchId: 'x-1' }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const cancel = await handlers.cancel(post('/api/image-studio.cancel', { batchId: 'x-1' }))
  assert.equal(cancel.status, 200)
  assert.ok(sawSignal, 'provider 必须拿到取消 signal')
  assert.equal(sawSignal.aborted, true, 'host 端取消应立刻反映到 provider')
  const response = await inFlight
  assert.ok([200, 499, 502].includes(response.status), 'status ' + response.status)
})

test('取消接口：非法编号 400、未知批次 404、已完成 409', async () => {
  const registry = createBatchRegistry()
  const handlers = makeHandlers({ batch: registry, generate: async () => ({ images: [image('M')], meta: {} }) })
  assert.equal((await handlers.cancel(post('/api/image-studio.cancel', { batchId: '../evil' }))).status, 400)
  assert.equal((await handlers.cancel(post('/api/image-studio.cancel', { batchId: 'nope' }))).status, 404)
  registry.begin('done', 1)
  registry.update('done', { completed: 1, generated: 1 })
  const late = await handlers.cancel(post('/api/image-studio.cancel', { batchId: 'done' }))
  assert.equal(late.status, 409)
  assert.equal((await late.json()).code, 'BATCH_DONE')
})

test('浏览器断开（request.signal abort）会传到 provider', async () => {
  let sawSignal
  const controller = new AbortController()
  const handlers = makeHandlers({
    generate: async ({ signal }) => {
      sawSignal = signal
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
      return { images: [image('N')], meta: {} }
    }
  })
  const inFlight = handlers.generate(
    new Request('http://localhost/api/image-studio.generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'cat', n: 1, retries: 0, batchId: 'y-1' }),
      signal: controller.signal
    })
  )
  await new Promise((resolve) => setTimeout(resolve, 6))
  controller.abort()
  const response = await inFlight
  assert.ok(sawSignal.aborted, 'request.signal 断开必须桥接到内部控制器')
  assert.ok([200, 499, 502].includes(response.status), 'status ' + response.status)
})

test('设置保存后会触发 onConfigSaved（热更新并发上限）', async () => {
  let fired = 0
  const handlers = makeHandlers({ onConfigSaved: async () => { fired++ } })
  const response = await handlers.settingsSave(post('/api/image-studio.settings', { baseUrl: 'https://api.example.com/v1', maxConcurrentImages: 6 }))
  assert.equal(response.status, 200)
  assert.equal(fired, 1)
})

test('onConfigSaved 抛错不影响配置保存成功', async () => {
  const handlers = makeHandlers({ onConfigSaved: async () => { throw new Error('boom') } })
  const response = await handlers.settingsSave(post('/api/image-studio.settings', { baseUrl: 'https://api.example.com/v1' }))
  assert.equal(response.status, 200)
})

test('非法 batchId 被忽略（不影响生成，也不污染进度表）', async () => {
  const registry = createBatchRegistry()
  const handlers = makeHandlers({ batch: registry })
  const response = await handlers.generate(post('/api/image-studio.generate', { prompt: 'cat', n: 1, batchId: '../evil' }))
  assert.equal(response.status, 200)
  assert.equal(registry.size(), 0)
})

test('配置里的 maxConcurrentImages 决定批次并发（界面不传时）', async () => {
  let live = 0
  let peak = 0
  const handlers = createHandlers({
    settings: fakeSettings({ maxConcurrentImages: 1 }),
    assets: createAssetLibrary({ builtin, store: { async read() {}, async write() {} } }),
    retries: 0,
    generate: async () => {
      live++
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 8))
      live--
      return { images: [image('J')], meta: {} }
    }
  })
  await handlers.generate(post('/api/image-studio.generate', { prompt: 'cat', n: 4 }))
  assert.equal(peak, 1, '配置为 1 时不得并发，peak=' + peak)
})
