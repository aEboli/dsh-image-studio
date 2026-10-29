/**
 * 生图通道：只实现仓库（GPT-Image2-Studio）用的两种 OpenAI 兼容协议。
 *
 *   images     → POST {baseUrl}/images/generations   （最通用，很多中转只认这个）
 *              → 有参考图时改走 POST {baseUrl}/images/edits（multipart/form-data）
 *   responses  → POST {baseUrl}/responses + tools[image_generation]
 *                （仓库默认路径，支持 reasoning.effort / output_format / background）
 *
 * 没有第三方依赖，只用全局 fetch / FormData / Blob / AbortSignal，方便 host 侧直接调用与单测。
 */

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** images/edits 的 image 字段上限（OpenAI 兼容网关通常也是 1~8 张）。 */
export const MAX_EDIT_IMAGES = 8;

/** 单次重试最多愿意等这么久，再久不如直接报错让用户手动重试。 */
const MAX_RETRY_WAIT_MS = 30_000;

/** 把用户填的 baseUrl 归一：去掉尾部斜杠，未写 /v1 时补上。 */
export function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || '').trim();
  if (!url) throw new Error('缺少 baseUrl');
  url = url.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(url)) url = `${url}/v1`;
  return url;
}

export function normalizeConfig(config = {}) {
  const protocol = config.protocol === 'responses' ? 'responses' : 'images';
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKey: String(config.apiKey || '').trim(),
    imageModel: String(config.imageModel || 'gpt-image-2').trim(),
    promptModel: String(config.promptModel || config.imageModel || 'gpt-image-2').trim(),
    protocol,
    timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS
  };
}

function headersFor(config) {
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

/**
 * 构造 images 协议请求体。
 * 仓库里 n 固定为 1（responses-workflow.mjs:489），这里保持一致；多图靠多次调用。
 */
export function buildImagesBody({ model, prompt, size, quality, n = 1, responseFormat = 'b64_json' }) {
  const body = { model, prompt, n: Math.max(1, Math.min(Number(n) || 1, 4)), response_format: responseFormat };
  if (size && size !== 'auto') body.size = size;
  if (quality && quality !== 'auto') body.quality = quality;
  return body;
}

/**
 * 构造 responses 协议请求体（对齐 responses-workflow.mjs:448-468）。
 */
export function buildResponsesBody({ model, prompt, imageModel, size, quality, outputFormat, background, reasoningEffort, referenceImages = [] }) {
  const content = [{ type: 'input_text', text: prompt }];
  for (const image of referenceImages) {
    if (image?.dataUrl) content.push({ type: 'input_image', image_url: image.dataUrl });
  }
  const tool = { type: 'image_generation' };
  if (imageModel) tool.model = imageModel;
  if (size && size !== 'auto') tool.size = size;
  if (quality && quality !== 'auto') tool.quality = quality;
  if (outputFormat) tool.output_format = outputFormat;
  if (background) tool.background = background;

  const body = {
    model,
    input: [{ role: 'user', content }],
    stream: true,
    tool_choice: { type: 'image_generation' },
    tools: [tool]
  };
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  return body;
}

/** 把 data:image/png;base64,... 解成 { mime, bytes }；不合法的输入返回 null。 */
export function decodeImageDataUrl(value) {
  const raw = typeof value === 'string' ? value : value?.dataUrl || value?.data || '';
  const source = String(raw || '').trim();
  if (!source) return null;
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(source);
  // 只认 data URL：裸字符串没法判断是 base64 还是随手填的地址，宁可当作没给。
  if (!match) return null;
  const meta = match[1];
  const payload = match[2].replace(/\s+/g, '');
  if (!payload) return null;
  const isBase64 = /;base64(;|$)/i.test(meta);
  if (isBase64 && !/^[A-Za-z0-9+/=_-]+$/.test(payload)) return null;
  let bytes;
  try {
    bytes = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'binary');
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const mime = (/^([^;]+)/.exec(meta)?.[1] || 'image/png').trim().toLowerCase();
  return { mime: mime.startsWith('image/') ? mime : 'image/png', bytes };
}

function extensionFor(mime) {
  if (/jpe?g/.test(mime)) return 'jpg';
  if (/webp/.test(mime)) return 'webp';
  if (/gif/.test(mime)) return 'gif';
  return 'png';
}

/**
 * 构造 images/edits 的 multipart 表单。
 * image 字段重复（最多 8 张），其余字段与 generations 对齐；n 固定 1（多图靠多次调用）。
 * 参考图全都解不出来时返回 count: 0，调用方回退到 generations。
 */
export function buildEditsForm({ model, prompt, size, quality, referenceImages = [] } = {}) {
  if (typeof globalThis.FormData !== 'function' || typeof globalThis.Blob !== 'function') {
    throw new Error('当前运行时不支持 FormData/Blob');
  }
  const form = new FormData();
  let count = 0;
  for (const item of Array.isArray(referenceImages) ? referenceImages : []) {
    if (count >= MAX_EDIT_IMAGES) break;
    const decoded = decodeImageDataUrl(item);
    if (!decoded) continue;
    count += 1;
    form.append(
      'image',
      new Blob([decoded.bytes], { type: decoded.mime }),
      `reference-${count}.${extensionFor(decoded.mime)}`
    );
  }
  if (model) form.append('model', model);
  form.append('prompt', String(prompt || ''));
  form.append('n', '1');
  if (size && size !== 'auto') form.append('size', size);
  if (quality && quality !== 'auto') form.append('quality', quality);
  return { form, count };
}

/** 从 Responses 的 SSE 文本里抠出最终图片（b64 或 url）。 */
export function extractImageFromSse(text) {
  const images = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    const candidates = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (node.type === 'image_generation_call' || node.result || node.image_url || node.b64_json) {
        candidates.push(node);
      }
      for (const value of Object.values(node)) visit(value);
    };
    visit(event);
    for (const candidate of candidates) {
      const b64 = candidate.b64_json || (candidate.result && candidate.result.b64_json) || candidate.result;
      if (typeof b64 === 'string' && b64.length > 256 && !b64.startsWith('http')) {
        images.push({ kind: 'base64', data: b64, mime: 'image/png' });
      } else if (typeof candidate.image_url === 'string') {
        images.push({ kind: 'url', url: candidate.image_url });
      }
    }
  }
  return images;
}

/** 统一的 POST：超时与外部取消都落到同一个 AbortController 上。 */
async function postRaw(url, { body, headers = {}, timeoutMs, signal, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('生成超时')), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.('abort', abort, { once: true });
  try {
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
    } catch (cause) {
      const abortedByCaller = Boolean(signal?.aborted);
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (abortedByCaller) {
        error.code = error.code || 'ABORT_ERR';
      } else if (String(error.message || '').includes('生成超时') || error.name === 'TimeoutError') {
        error.code = 'TIMEOUT';
        error.retryable = true;
      } else {
        error.code = error.code || 'FETCH_FAILED';
        error.retryable = true;
      }
      throw error;
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 500);
      try {
        detail = JSON.parse(text)?.error?.message || detail;
      } catch {
        /* 保留原文 */
      }
      const error = new Error(`上游返回 ${response.status}：${detail}`);
      error.code = 'UPSTREAM_ERROR';
      error.status = 502;
      // upstreamStatus 供重试判断（429/5xx 可重试）；status 本身留给错误投影用 502。
      error.upstreamStatus = response.status;
      const retryAfterMs = retryDelayFromHeaders(response.headers);
      if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
      throw error;
    }
    return { response, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

/**
 * 解析 Retry-After，统一返回毫秒；解析不出来返回 null（退回指数退避）。
 * 两种头单位不同，必须分开处理：
 *   Retry-After-Ms → 已经是毫秒
 *   Retry-After    → 秒数，或 HTTP-date（要换算成「还有多久」）
 */
export function retryDelayFromHeaders(headers) {
  if (!headers?.get) return null;
  const millis = headers.get('retry-after-ms');
  if (millis !== null && millis !== undefined && millis !== '') {
    const value = Number(millis);
    if (Number.isFinite(value) && value >= 0) return Math.min(value, MAX_RETRY_WAIT_MS);
  }
  const raw = headers.get('retry-after');
  if (raw === null || raw === undefined || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  const at = Date.parse(String(raw));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(at - Date.now(), MAX_RETRY_WAIT_MS));
}

function postJson(url, { body, apiKey, timeoutMs, signal, fetchImpl }) {
  return postRaw(url, { body: JSON.stringify(body), headers: headersFor({ apiKey }), timeoutMs, signal, fetchImpl });
}

/** multipart 不能自己写 content-type（boundary 由 fetch 生成）。 */
function postForm(url, { form, apiKey, timeoutMs, signal, fetchImpl }) {
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return postRaw(url, { body: form, headers, timeoutMs, signal, fetchImpl });
}

function parseUpstreamJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`无法解析上游响应：${String(text).slice(0, 200)}`);
  }
}

/**
 * 把 {data:[{b64_json|url}]} 统一成内部图片结构。
 * 网关先回短 URL 时自行取二进制：避免几 MB 的 base64 在 JSON 里慢慢传。
 */
async function collectImages(parsed, { config, signal, fetchImpl = globalThis.fetch }) {
  const images = [];
  for (const item of parsed?.data || []) {
    if (item?.b64_json) {
      images.push({ kind: 'base64', data: item.b64_json, mime: 'image/png' });
    } else if (item?.url) {
      const absolute = new URL(item.url, `${config.baseUrl}/`).href;
      const response = await fetchImpl(absolute, {
        signal,
        headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}
      });
      if (!response.ok) throw new Error(`取图失败（HTTP ${response.status}）`);
      const bytes = Buffer.from(await response.arrayBuffer());
      images.push({ kind: 'binary', bytes, mime: response.headers.get('content-type') || 'image/png' });
    }
  }
  return images;
}

/**
 * 出图。返回 { images: [{kind:'base64'|'url', data?, url?, mime?}], meta }
 * @param {object} params
 * @param {object} params.config  normalizeConfig 的结果
 * @param {AbortSignal} [params.signal] 浏览器/工具侧取消
 */
export async function generate(params) {
  const { config } = params;
  const fetchImpl = params.fetch || globalThis.fetch;
  const prompt = String(params.prompt || '').trim();
  if (!prompt) throw new Error('提示词不能为空');

  if (config.protocol === 'responses') {
    const body = buildResponsesBody({
      model: config.promptModel,
      prompt,
      imageModel: config.imageModel,
      size: params.size,
      quality: params.quality,
      outputFormat: params.outputFormat,
      background: params.background,
      reasoningEffort: params.reasoningEffort,
      referenceImages: params.referenceImages
    });
    const { text } = await postJson(`${config.baseUrl}/responses`, {
      body,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      signal: params.signal,
      fetchImpl
    });
    const images = extractImageFromSse(text);
    if (images.length === 0) throw new Error('上游响应里没有找到图片（可能是文本回复或流被截断）');
    return { images, meta: { protocol: 'responses', size: params.size, quality: params.quality } };
  }

  // 有参考图就走 edits（真正的图生图）；没有参考图保持原来的 generations。
  let edits = null;
  if (Array.isArray(params.referenceImages) && params.referenceImages.length > 0) {
    edits = buildEditsForm({
      model: config.imageModel,
      prompt,
      size: params.size,
      quality: params.quality,
      referenceImages: params.referenceImages
    });
  }

  if (edits && edits.count > 0) {
    const editsStartedAt = Date.now();
    const { text } = await postForm(`${config.baseUrl}/images/edits`, {
      form: edits.form,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      signal: params.signal,
      fetchImpl
    });
    const jsonMs = Date.now() - editsStartedAt;
    const parsed = parseUpstreamJson(text);
    const fileStartedAt = Date.now();
    const images = await collectImages(parsed, { config, signal: params.signal, fetchImpl });
    if (images.length === 0) throw new Error('上游没有返回图片');
    return {
      images,
      meta: {
        protocol: 'images',
        mode: 'edits',
        references: edits.count,
        size: params.size,
        quality: params.quality,
        jsonMs,
        fileMs: Date.now() - fileStartedAt
      }
    };
  }

  const jsonStartedAt = Date.now();
  const body = buildImagesBody({
    model: config.imageModel,
    prompt,
    size: params.size,
    quality: params.quality,
    n: params.n,
    responseFormat: params.responseFormat || 'url'
  });
  const { text } = await postJson(`${config.baseUrl}/images/generations`, {
    body,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    signal: params.signal,
    fetchImpl
  });
  const jsonMs = Date.now() - jsonStartedAt;
  const parsed = parseUpstreamJson(text);
  const fileStartedAt = Date.now();
  const images = await collectImages(parsed, { config, signal: params.signal, fetchImpl });
  if (images.length === 0) throw new Error('上游没有返回图片');
  const fileMs = Date.now() - fileStartedAt;
  return { images, meta: { protocol: 'images', size: params.size, quality: params.quality, jsonMs, fileMs } };
}
