import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generate, normalizeConfig, retryDelayFromHeaders } from '../lib/provider.js'

const config = normalizeConfig({ baseUrl: 'https://api.example.com', apiKey: 'sk-test', timeoutMs: 2000 })

test('上游 4xx/5xx 带上 upstreamStatus 与可判定 code', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: '无效的 Key' } }), { status: 401 })
  try {
    await assert.rejects(generate({ config, prompt: '猫' }), (error) => {
      assert.equal(error.upstreamStatus, 401)
      assert.equal(error.code, 'UPSTREAM_ERROR')
      assert.equal(error.status, 502, '对外仍投影成 502，方便上层统一处理')
      assert.equal(error.retryable, undefined, '401 不该被标成可重试')
      assert.match(error.message, /无效的 Key/)
      return true
    })
  } finally { globalThis.fetch = original }
})

test('Retry-After 头解析成 retryAfterMs（秒与 HTTP-date）', () => {
  const headers = new Headers({ 'retry-after': '2' })
  assert.equal(retryDelayFromHeaders(headers), 2000)
  assert.equal(retryDelayFromHeaders(new Headers({ 'retry-after': '0' })), 0)
  assert.equal(retryDelayFromHeaders(new Headers({ 'retry-after-ms': '250' })), 250)
  const far = new Date(Date.now() + 3000).toUTCString()
  const parsed = retryDelayFromHeaders(new Headers({ 'retry-after': far }))
  assert.ok(parsed >= 0 && parsed <= 3000, 'date 形式应解析成 ms：' + parsed)
  assert.equal(retryDelayFromHeaders(new Headers({ 'retry-after': 'not-a-date' })), null)
  assert.equal(retryDelayFromHeaders(new Headers()), null)
  assert.equal(retryDelayFromHeaders(undefined), null)
  assert.equal(retryDelayFromHeaders(new Headers({ 'retry-after': '999999' })), 30000, '过长等待必须被钳到 30s')
})

test('上游 429 带 Retry-After 时错误里带 retryAfterMs', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'retry-after': '1' } })
  try {
    await assert.rejects(generate({ config, prompt: '猫' }), (error) => {
      assert.equal(error.retryAfterMs, 1000)
      assert.equal(error.upstreamStatus, 429)
      return true
    })
  } finally { globalThis.fetch = original }
})

test('网络层失败标为 FETCH_FAILED 且可重试', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }
  try {
    await assert.rejects(generate({ config, prompt: '猫' }), (error) => {
      assert.equal(error.code, 'ECONNRESET', '保留底层 code 便于排障')
      assert.equal(error.retryable, true)
      return true
    })
  } finally { globalThis.fetch = original }
})

test('超时报 TIMEOUT 且可重试', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const reason = init.signal.reason
      reject(reason instanceof Error ? reason : Object.assign(new Error('生成超时'), { name: 'AbortError' }))
    }, { once: true })
  })
  try {
    await assert.rejects(generate({ config: { ...config, timeoutMs: 25 }, prompt: '猫' }), (error) => {
      assert.equal(error.code, 'TIMEOUT')
      assert.equal(error.retryable, true)
      return true
    })
  } finally { globalThis.fetch = original }
})

test('调用方取消标为 ABORT_ERR 且不可重试', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted by caller'), { name: 'AbortError' })), { once: true })
  })
  const controller = new AbortController()
  try {
    const pending = generate({ config, prompt: '猫', signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'ABORT_ERR')
      assert.equal(error.retryable, undefined)
      return true
    })
  } finally { globalThis.fetch = original }
})

test('generate 接受注入的 fetch（host 可在装配后换实现）', async () => {
  const calls = []
  const result = await generate({
    config,
    prompt: '猫',
    fetch: async (url, init) => {
      calls.push({ url: String(url), hasAuth: Boolean(init.headers.authorization) })
      return new Response(JSON.stringify({ data: [{ b64_json: 'Z'.repeat(300) }] }), { status: 200 })
    }
  })
  assert.equal(calls[0].url, 'https://api.example.com/v1/images/generations')
  assert.equal(calls[0].hasAuth, true)
  assert.equal(result.images[0].data.slice(0, 3), 'ZZZ')
})

test('URL 交付时的下载失败也带可读错误', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/images/generations')) return new Response(JSON.stringify({ data: [{ url: '/files/x.png' }] }), { status: 200 })
    return new Response('gone', { status: 404 })
  }
  try {
    await assert.rejects(generate({ config, prompt: '猫' }), /取图失败（HTTP 404）/)
  } finally { globalThis.fetch = original }
})
