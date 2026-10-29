/**
 * 配置的纯逻辑部分：默认值、脱敏投影、保存校验。
 * 不 import 任何 DSH 包，方便单测；IO 在 lib/settings.js。
 */
import { clampInteger } from './concurrency.js';

export const MAX_CONCURRENT_IMAGES = 8;
export const MAX_IMAGES_PER_BATCH = 4;

/**
 * clamp 到整数区间；非法/非有限值回落到 fallback。
 * 复用 lib/concurrency.js 的唯一实现，避免「配置校验」和「队列钳制」两套规则漂移。
 */
export const clampOption = clampInteger;

export const CONFIG_DEFAULTS = Object.freeze({
  revision: 0,
  protocol: 'images',
  baseUrl: '',
  imageModel: 'gpt-image-2',
  promptModel: '',
  timeoutMs: 20 * 60 * 1000,
  outputDir: '',
  // 进程级出图并发上限（跨窗口 / 跨 Agent 工具共享），默认 3；1~8 可调。
  maxConcurrentImages: 3,
  // 每次点「生成」默认出几张；界面可临时改，1~4。
  defaultImageCount: 1,
  apiKey: ''
});

/** 只把可公开的字段投影给 client（key 永不出现）。 */
export function describeState(state, writable = true) {
  const merged = { ...CONFIG_DEFAULTS, ...(state || {}) };
  const hasKey = Boolean(merged.apiKey);
  return {
    revision: merged.revision,
    writable,
    configured: Boolean(merged.baseUrl && hasKey),
    // 固定 Images API：老记录里可能还留着 responses，投影时归一。
    protocol: 'images',
    baseUrl: sanitizeBaseUrl(merged.baseUrl),
    imageModel: merged.imageModel,
    promptModel: merged.promptModel || merged.imageModel,
    timeoutMs: merged.timeoutMs,
    outputDir: String(merged.outputDir || ''),
    maxConcurrentImages: clampOption(merged.maxConcurrentImages, CONFIG_DEFAULTS.maxConcurrentImages, 1, MAX_CONCURRENT_IMAGES),
    defaultImageCount: clampOption(merged.defaultImageCount, CONFIG_DEFAULTS.defaultImageCount, 1, MAX_IMAGES_PER_BATCH),
    keyPresent: hasKey,
    keyHint: hasKey ? `${String(merged.apiKey).slice(0, 3)}***${String(merged.apiKey).slice(-4)}` : ''
  };
}

/**
 * 投影用的 baseUrl：只保留 scheme://host[:port]/path。
 * 去掉 userinfo（user:pass@）与 query，免得把账号密码回显到浏览器；
 * 解析不了就返回空串——宁可让用户重填，也不把原文带出去。
 */
export function sanitizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * 校验并合并「保存配置」的输入（纯函数，不写存储）。
 * @param {object} before 当前状态
 * @param {object} input  用户输入
 * @returns {object} 下一份完整状态
 */
export function mergeSaveInput(before, input = {}) {
  const current = { ...CONFIG_DEFAULTS, ...(before || {}) };

  if (input.revision !== undefined && Number(input.revision) !== current.revision) {
    const error = new Error('配置已在别处修改，请刷新后重试');
    error.code = 'CONFLICT';
    throw error;
  }

  const baseUrl = String(input.baseUrl ?? current.baseUrl)
    .trim()
    .replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('baseUrl 需要以 http:// 或 https:// 开头');

  const rawKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (rawKey && (/[\s\u0000-\u001f\u007f]/.test(rawKey) || rawKey.length > 4096)) {
    throw new Error('API Key 格式不正确');
  }

  const targetOrigin = baseUrl ? new URL(baseUrl).origin : '';
  const previousOrigin = current.baseUrl ? new URL(current.baseUrl).origin : '';
  const apiKey = rawKey || (targetOrigin === previousOrigin ? current.apiKey : '');
  if (!apiKey) throw new Error('换了 API 地址后需要重新填写 Key');

  const timeout = Number(input.timeoutMs);
  // 并发/张数：非法值回落到当前值，越界钳制；允许显式传 null/'' 走默认。
  const maxConcurrentImages = input.maxConcurrentImages === undefined || input.maxConcurrentImages === null || input.maxConcurrentImages === ''
    ? current.maxConcurrentImages
    : clampOption(input.maxConcurrentImages, CONFIG_DEFAULTS.maxConcurrentImages, 1, MAX_CONCURRENT_IMAGES);
  const defaultImageCount = input.defaultImageCount === undefined || input.defaultImageCount === null || input.defaultImageCount === ''
    ? current.defaultImageCount
    : clampOption(input.defaultImageCount, CONFIG_DEFAULTS.defaultImageCount, 1, MAX_IMAGES_PER_BATCH);
  // 输出目录：允许留空（不落盘）；去掉首尾空白与包裹引号，Windows 反斜杠原样保留。
  const outputDir = String(input.outputDir ?? current.outputDir ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1')
    .trim();
  if (outputDir.length > 1024) throw new Error('输出目录路径过长');
  return {
    revision: current.revision + 1,
    // 只保留 Images API（/v1/images/generations），不再提供协议切换。
    protocol: 'images',
    baseUrl,
    imageModel: String(input.imageModel ?? current.imageModel ?? 'gpt-image-2').trim() || 'gpt-image-2',
    promptModel: String(input.promptModel ?? current.promptModel ?? '').trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : current.timeoutMs,
    outputDir,
    maxConcurrentImages,
    defaultImageCount,
    apiKey
  };
}
