/**
 * 批次进度登记（进程内、带 TTL）。
 *
 * 浏览器一次 POST 生成 N 张（host 内部并发），期间靠 GET /api/image-studio.progress?batch=id
 * 轮询真实进度，而不是靠「猜的百分比」。这样也不用赌宿主的 connection.fetch 支不支持流式响应。
 */
import { clampInteger } from './concurrency.js';

export const MAX_BATCH_ID_LENGTH = 64;
const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function isBatchId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_BATCH_ID_LENGTH && BATCH_ID_PATTERN.test(value);
}

export function createBatchRegistry({ ttlMs = 60_000, maxEntries = 64 } = {}) {
  const entries = new Map();
  const deadline = ttlMs > 0 ? ttlMs : 60_000;
  const capacity = clampInteger(maxEntries, 64, 8, 512);

  /** 过期清理：完成的批次留 ttlMs 供界面收尾读取，超时或未完成的僵尸批次也一并回收。 */
  function sweep(now = Date.now()) {
    for (const [id, entry] of entries) {
      const done = entry.completed >= entry.requested || entry.failed >= entry.requested;
      const age = now - (entry.updatedAt ?? entry.startedAt);
      if ((done && age > deadline) || age > deadline * 10) entries.delete(id);
    }
    trim();
  }

  /** 容量兜底：Map 按插入顺序迭代，删掉的就是最旧的批次。 */
  function trim() {
    while (entries.size > capacity) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  function begin(id, requested, extra = {}) {
    if (!isBatchId(id)) return null;
    sweep();
    const now = Date.now();
    const entry = {
      id,
      requested: clampInteger(requested, 1, 1, 32),
      completed: 0,
      generated: 0,
      failed: 0,
      startedAt: now,
      updatedAt: now,
      lastError: null,
      cancelRequested: false,
      ...extra
    };
    entries.set(id, entry);
    trim();
    return entry;
  }

  /** 只允许覆盖已知字段，免得调用方塞进几 MB 的数据。 */
  function update(id, patch = {}) {
    const entry = entries.get(id);
    if (!entry) return null;
    if (Number.isFinite(Number(patch.completed))) entry.completed = Number(patch.completed);
    if (Number.isFinite(Number(patch.generated))) entry.generated = Number(patch.generated);
    if (Number.isFinite(Number(patch.failed))) entry.failed = Number(patch.failed);
    const message = patch.error ? String(patch.error?.message || patch.error).slice(0, 300) : null;
    if (message) entry.lastError = message;
    entry.updatedAt = Date.now();
    return entry;
  }

  function snapshot(entry, queue) {
    if (!entry) return null;
    const now = Date.now();
    const finished = entry.completed >= entry.requested;
    return {
      id: entry.id,
      requested: entry.requested,
      completed: entry.completed,
      generated: entry.generated,
      failed: entry.failed,
      elapsedMs: now - entry.startedAt,
      finished,
      cancelRequested: Boolean(entry.cancelRequested),
      lastError: entry.lastError,
      queue: queue ?? null
    };
  }

  /**
   * 取消一个还在跑的批次：调用登记时带进来的 cancel 回调（通常是 AbortController.abort）。
   * 快照里不会带函数，所以这里直接取原始 entry。
   */
  function cancel(id) {
    sweep();
    const entry = entries.get(id);
    if (!entry) return { cancelled: false, reason: 'NOT_FOUND' };
    if (entry.completed >= entry.requested) return { cancelled: false, reason: 'ALREADY_DONE' };
    if (typeof entry.cancel !== 'function') return { cancelled: false, reason: 'NO_CANCEL_HANDLE' };
    entry.cancel();
    entry.cancelRequested = true;
    entry.updatedAt = Date.now();
    return { cancelled: true, reason: null };
  }

  function get(id, queue) {
    sweep();
    return snapshot(entries.get(id), queue);
  }

  /** 供「上次耗时 / 队列状态」这类面板用。 */
  function list(queue) {
    sweep();
    return [...entries.values()].map(entry => snapshot(entry, queue));
  }

  function clear(id) {
    entries.delete(id);
  }

  return { begin, update, get, list, clear, cancel, sweep, size: () => entries.size };
}
