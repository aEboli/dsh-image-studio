import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHandlers } from '../lib/handlers.js'

const hostSource = await readFile(new URL('../host.js', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const stubSettings = {
  async read() { return {} },
  async describe() { return {} },
  async active() { throw new Error('x') },
  async save() { return {} }
}
const stubAssets = {
  async list() { return {} },
  async search() { return {} },
  async importAssets() { return {} }
}
const handlers = Object.keys(createHandlers({
  settings: stubSettings,
  assets: stubAssets,
  generate: async () => ({ images: [], meta: {} })
}))

function suffixesIn(source) {
  return [...new Set([...source.matchAll(/register\(\s*'([^']+)'/g)].map((m) => m[1]))]
}

/** client 里所有可能打到 host 的路径写法：call('.x')、request(api('.x'))、fetch('/api/image-studio.x')。 */
function calledSuffixes(source) {
  const found = new Set()
  for (const match of source.matchAll(/(?:call|request)\(\s*(?:api\()?['\"`]\.([\w.]+)/g)) found.add(match[1])
  for (const match of source.matchAll(/\/api\/image-studio\.([\w.]+)/g)) found.add(match[1])
  return found
}

// host 注册但界面不调用的路由：留给外部脚本 / Agent / 老 client 兼容，是有意为之的 API 面。
const HOST_ONLY = new Set(['save', 'assets.import', 'queue'])

test('client 调用的每个路由 host 都已注册（拼错路径会直接 404）', () => {
  const registered = new Set(suffixesIn(hostSource))
  const called = [...calledSuffixes(clientSource)]
  assert.ok(called.length >= 8, '至少覆盖主要路由，实际 ' + called.length)
  const unknown = called.filter((item) => !registered.has(item))
  assert.deepEqual(unknown, [], 'client 调用了 host 没有的路由：' + unknown.join(','))
})

test('host 注册的路由要么被 client 调用，要么在 HOST_ONLY 白名单里', () => {
  const called = calledSuffixes(clientSource)
  const unused = suffixesIn(hostSource).filter((item) => !called.has(item) && !HOST_ONLY.has(item))
  assert.deepEqual(unused, [], '新增路由必须同步接线，或在白名单里说明用途：' + unused.join(','))
})

test('生成与进度轮询在 client 侧真的接上了', () => {
  assert.ok(clientSource.includes("api('.generate')"), 'client 缺少 generate 调用')
  assert.ok(clientSource.includes('.progress?batch='), 'client 缺少进度轮询')
  assert.ok(clientSource.includes('startProgressPolling'), 'client 缺少进度轮询实现')
  assert.ok(clientSource.includes('maxConcurrentImages'), 'client 缺少并发上限设置')
  assert.ok(clientSource.includes('n: imageCount'), 'client 没把张数发给 host')
})

test('host 侧并发能力齐备', () => {
  assert.ok(hostSource.includes('createLimiter'), 'host 缺少全局并发队列')
  assert.ok(hostSource.includes('createBatchRegistry'), 'host 缺少进度表')
  assert.ok(hostSource.includes("register('progress'"), 'host 缺少进度路由')
  assert.ok(hostSource.includes("register('queue'"), 'host 缺少队列路由')
  assert.ok(hostSource.includes('schedule:'), 'host 没把队列接进 handlers')
})

test('handlers 暴露的方法都被 host 接线（没有孤立实现）', () => {
  const missing = handlers.filter((name) => !hostSource.includes('handlers.' + name))
  assert.deepEqual(missing, [], '未接线的 handler：' + missing.join(','))
})

test('点号与斜杠两种路径都会注册（老 client 兜底）', () => {
  // 断言 host 里 register() 的真实模板串：点号 + 斜杠两种都要注册
  assert.ok(hostSource.includes('/api/image-studio.${suffix}'), '缺少点号路径注册')
  assert.ok(hostSource.includes('/api/image-studio/${'), '缺少斜杠路径注册')
  const registerBody = hostSource.slice(hostSource.indexOf('const register ='))
  assert.ok(registerBody.includes("replaceAll('.', '/')"), '斜杠兜底要把点号换成斜杠')
})
test('client 的 404 兜底分开处理 path 与 query，避免改坏 batchId', () => {
  assert.ok(clientSource.includes("pathWithQuery.indexOf('?')"), 'call() 必须先切出 query')
})
