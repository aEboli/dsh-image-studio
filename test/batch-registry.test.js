import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BATCH_ID_LENGTH, createBatchRegistry, isBatchId } from '../lib/batch-registry.js'

test('isBatchId 接受安全字符并挡住超长/非法/路径穿越', () => {
  assert.equal(isBatchId('b-1'), true)
  assert.equal(isBatchId('178f0c2e-3d4a-5b6c-7d8e-9f0a1b2c3d4e'), true)
  assert.equal(isBatchId('a.b:c_d-1'), true)
  assert.equal(isBatchId(''), false)
  assert.equal(isBatchId(undefined), false)
  assert.equal(isBatchId(123), false)
  assert.equal(isBatchId('a/../b'), false)
  assert.equal(isBatchId('a?b=1'), false)
  assert.equal(isBatchId('x'.repeat(MAX_BATCH_ID_LENGTH)), true)
  assert.equal(isBatchId('x'.repeat(MAX_BATCH_ID_LENGTH + 1)), false)
})

test('begin/update/get 记录真实进度并标记 finished', () => {
  const registry = createBatchRegistry()
  const entry = registry.begin('b-1', 3)
  assert.equal(entry.requested, 3)
  assert.equal(entry.completed, 0)
  registry.update('b-1', { completed: 1, generated: 1 })
  registry.update('b-1', { completed: 2, generated: 2 })
  const partial = registry.get('b-1', { active: 2 })
  assert.equal(partial.completed, 2)
  assert.equal(partial.finished, false)
  assert.equal(partial.queue.active, 2)
  registry.update('b-1', { completed: 3, generated: 3 })
  const done = registry.get('b-1')
  assert.equal(done.finished, true)
  assert.equal(done.elapsedMs >= 0, true)
})

test('update 记录错误摘要（截断）并保留最后一条', () => {
  const registry = createBatchRegistry()
  registry.begin('b-2', 2)
  registry.update('b-2', { completed: 1, failed: 1, error: new Error('上游返回 500：' + 'x'.repeat(500)) })
  const snap = registry.get('b-2')
  assert.equal(snap.failed, 1)
  assert.ok(snap.lastError.startsWith('上游返回 500：'))
  assert.ok(snap.lastError.length <= 300, '错误摘要必须截断')
})

test('未知批次：get 返回 null，非法 id 的 begin 被拒绝', () => {
  const registry = createBatchRegistry()
  assert.equal(registry.get('missing'), null)
  assert.equal(registry.begin('../../etc/passwd', 1), null)
  assert.equal(registry.size(), 0, '非法 id 不能占位')
  assert.equal(registry.update('missing', { completed: 1 }), null)
})

test('过期批次被回收，完成的批次在 TTL 内可读', async () => {
  const registry = createBatchRegistry({ ttlMs: 30 })
  registry.begin('b-3', 1)
  registry.update('b-3', { completed: 1, generated: 1 })
  assert.ok(registry.get('b-3'), '刚完成仍可读')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(registry.get('b-3'), null, '超过 TTL 必须回收，避免内存无限增长')
})

test('未完成但僵尸的批次也会被回收', async () => {
  const registry = createBatchRegistry({ ttlMs: 10 })
  registry.begin('zombie', 5)
  await new Promise((resolve) => setTimeout(resolve, 130))
  assert.equal(registry.get('zombie'), null)
})

test('容量上限按 FIFO 淘汰最旧批次（maxEntries 会被钳到 >=8）', () => {
  const registry = createBatchRegistry({ maxEntries: 8 })
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) registry.begin(id, 1)
  assert.equal(registry.size(), 8)
  assert.equal(registry.get('a'), null, '最旧的应被淘汰')
  assert.equal(registry.get('b'), null)
  assert.ok(registry.get('j'))
  // 传入低于下限的 maxEntries 时按最小 8 生效，而不是变成 1 把队列削没。
  const clamped = createBatchRegistry({ maxEntries: 1 })
  for (const id of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) clamped.begin(id, 1)
  assert.equal(clamped.size(), 8)
})

test('list 返回全部快照（供无 batchId 的界面兜底）', () => {
  const registry = createBatchRegistry()
  registry.begin('x', 2)
  registry.begin('y', 1)
  const all = registry.list({ active: 0 })
  assert.equal(all.length, 2)
  assert.deepEqual(all.map(item => item.id).sort(), ['x', 'y'])
})

test('clear 立即移除批次', () => {
  const registry = createBatchRegistry()
  registry.begin('c', 1)
  registry.clear('c')
  assert.equal(registry.get('c'), null)
})

test('begin 会把 requested 钳到 1..32', () => {
  const registry = createBatchRegistry()
  assert.equal(registry.begin('big', 999).requested, 32)
  assert.equal(registry.begin('zero', 0).requested, 1)
})
