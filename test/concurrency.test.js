import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abortError, clampInteger, createLimiter, mapLimit } from '../lib/concurrency.js'

test('clampInteger 钳制区间并回落默认值', () => {
  assert.equal(clampInteger(7, 1, 1, 4), 4)
  assert.equal(clampInteger(-3, 1, 1, 4), 1)
  assert.equal(clampInteger('2.9', 1, 1, 4), 2)
  assert.equal(clampInteger(undefined, 3, 1, 4), 3)
  assert.equal(clampInteger(NaN, 3, 1, 4), 3)
  assert.equal(clampInteger(Infinity, 3, 1, 4), 3, '非有限值一律回落默认')
  assert.equal(clampInteger(1e9, 3, 1, 4), 4, '巨大的有限值会被钳到上限')
})

test('mapLimit 保持输入顺序且并发不超过上限', async () => {
  let live = 0
  let peak = 0
  const items = [10, 1, 5, 2, 8, 3]
  const out = await mapLimit(items, 2, async (ms, index) => {
    live++
    peak = Math.max(peak, live)
    await new Promise((resolve) => setTimeout(resolve, ms))
    live--
    return `${index}:${items[index]}`
  })
  assert.deepEqual(out, ['0:10', '1:1', '2:5', '3:2', '4:8', '5:3'], '结果顺序必须等于输入顺序')
  assert.ok(peak <= 2, '并发不得超过上限，实际 ' + peak)
  assert.equal(peak, 2, '并发应当真的用满上限')
})

test('mapLimit 空输入与 limit 大于长度', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), [])
  assert.deepEqual(await mapLimit([1, 2], 9, async (v) => v * 2), [2, 4])
})

test('mapLimit 取消后不再启动新任务', async () => {
  const controller = new AbortController()
  const started = []
  const pending = mapLimit([1, 2, 3, 4], 1, async (value) => {
    started.push(value)
    await new Promise((resolve) => setTimeout(resolve, 10))
    return value
  }, { signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 15))
  controller.abort()
  await pending
  assert.ok(started.length <= 3, '取消后不应继续跑完全部，started=' + started.join(','))
})

test('createLimiter 跨调用共享并发上限', async () => {
  const limiter = createLimiter({ concurrency: 2 })
  let live = 0
  let peak = 0
  const job = (ms) => async () => {
    live++
    peak = Math.max(peak, live)
    await new Promise((resolve) => setTimeout(resolve, ms))
    live--
    return ms
  }
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => limiter.run(job(12 * i), {})))
  assert.deepEqual(results, [12, 24, 36, 48, 60], '完成值按调用顺序返回')
  assert.ok(peak <= 2, '全局上限被击穿，peak=' + peak)
  assert.deepEqual(limiter.stats().active, 0)
  assert.deepEqual(limiter.stats().pending, 0)
})

test('createLimiter 队列满时拒绝并给出 QUEUE_FULL/429', async () => {
  const limiter = createLimiter({ concurrency: 1, maxPending: 2 })
  const slow = () => new Promise((resolve) => setTimeout(() => resolve('x'), 30))
  const running = limiter.run(slow)
  const queuedA = limiter.run(slow)
  const queuedB = limiter.run(slow)
  await assert.rejects(limiter.run(slow), (error) => {
    assert.equal(error.code, 'QUEUE_FULL')
    assert.equal(error.status, 429)
    return true
  })
  await Promise.all([running, queuedA, queuedB])
})

test('createLimiter 排队中的任务可被取消', async () => {
  const limiter = createLimiter({ concurrency: 1 })
  const blocker = limiter.run(() => new Promise((resolve) => setTimeout(() => resolve('x'), 40)))
  const controller = new AbortController()
  const queued = limiter.run(() => Promise.resolve('never'), { signal: controller.signal })
  controller.abort()
  await assert.rejects(queued, (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
  assert.equal(limiter.stats().pending, 0, '被取消的任务必须真的离开队列')
  assert.equal(await blocker, 'x', '占位任务不受影响，正常完成')
})

test('createLimiter 热更新并发上限会立即放行排队任务', async () => {
  const limiter = createLimiter({ concurrency: 1 })
  const first = limiter.run(() => new Promise((resolve) => setTimeout(resolve, 20)))
  const second = limiter.run(() => 'second')
  limiter.setConcurrency(4)
  await first
  assert.equal(await second, 'second')
  assert.equal(limiter.stats().concurrency, 4)
})

test('abortError 保留 Error 或合成 AbortError', () => {
  const original = new Error('boom')
  assert.equal(abortError(original), original)
  const synthesized = abortError('用户取消')
  assert.equal(synthesized.name, 'AbortError')
  assert.equal(synthesized.message, '用户取消')
  assert.equal(abortError(undefined).message, '已取消')
})
