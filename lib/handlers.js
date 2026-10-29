/**
 * 纯逻辑的 HTTP 处理层（不依赖 cordis，便于单测）。
 *
 * host.js 只做三件事：构造依赖 → 注册路由 → 注册工具。
 * 所有请求校验、错误投影都在这里；每个 handler 自己兜住异常并返回 Response，
 * 路由侧不需要再写 try/catch。
 */
import { unlink } from 'node:fs/promises';
import { createAssetLibrary } from './assets.js';
import { composePrompt } from './compose.js';
import { isRelativeImagePath, resolveOutputFile } from './outputs.js';
import { generate as defaultGenerate, normalizeBaseUrl } from './provider.js';
import { generateBatch, MAX_BATCH_CONCURRENCY, MAX_BATCH_IMAGES } from './generation.js';
import { isBatchId } from './batch-registry.js';
import { clampInteger } from './concurrency.js';

// 参考图是 base64 直传，256KB 的老上限连一张 512×512 的 PNG 都放不下。
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export class HttpError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 把异常统一投影成 { code, error }，不泄露堆栈。 */
export function toErrorBody(error) {
  const status =
    Number(error?.status) ||
    (error?.code === 'CONFLICT' ? 409
      : error?.code === 'READ_ONLY' ? 403
        // 取消/超时要有明确状态，别让「用户主动取消」混进 500。
        : error?.code === 'ABORT_ERR' || error?.name === 'AbortError' ? 499
          : error?.code === 'TIMEOUT' ? 504
            : error?.code === 'QUEUE_FULL' ? 429
              : 500);
  return {
    status: status >= 400 && status <= 599 ? status : 500,
    body: { code: String(error?.code || 'INTERNAL').toUpperCase(), error: String(error?.message || '未知错误') }
  };
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  if (!request?.body) return {};
  const text = await request.text();
  if (text.length > limit) throw new HttpError('请求体过大', 413, 'BODY_TOO_LARGE');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('请求体不是合法 JSON', 400, 'BAD_JSON');
  }
}

function text(value, name, { max = 20000, required = true } = {}) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (required && !out) throw new HttpError(`${name}不能为空`, 400, 'MISSING_FIELD');
  if (out.length > max) throw new HttpError(`${name}过长（上限 ${max} 字符）`, 400, 'FIELD_TOO_LONG');
  return out;
}

/** handler 的兜底包装：任何异常都变成 JSON 错误响应。 */
function guard(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (error) {
      const { status, body } = toErrorBody(error);
      return json(body, status);
    }
  };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./settings.js').createSettings>} deps.settings
 * @param {ReturnType<typeof createAssetLibrary>} deps.assets
 * @param {typeof defaultGenerate} [deps.generate] 单张出图函数（可注入便于测试）
 * @param {(payload: object) => Promise<object|Array>} [deps.onGenerated] 落盘/附件回调；可返回替换后的图片列表
 * @param {(task: Function, options?: { signal?: AbortSignal }) => Promise<any>} [deps.schedule] 全局并发队列（跨请求限流）
 * @param {{begin: Function, update: Function}} [deps.batch] 批次进度登记（供界面轮询真实进度）
 * @param {() => object} [deps.getQueueStats] 队列状态投影（active/pending）
 * @param {() => Promise<void>} [deps.onConfigSaved] 保存配置后的钩子（热更新并发上限）
 */
export function createHandlers({
  settings,
  assets,
  generate = defaultGenerate,
  onGenerated,
  schedule,
  batch,
  getQueueStats,
  onConfigSaved,
  concurrency = 2,
  retries = 1,
  fetch: fetchImpl
} = {}) {
  /**
   * fetch 在调用时解析，而不是在建构时抓死引用：
   * 宿主可能晚一点才包装全局 fetch（重试/代理），测试也可在装配后替换实现。
   */
  const resolveFetch = () => fetchImpl ?? globalThis.fetch;
  /**
   * 组装提示词：模板 / 字段集 / 直给 三选一（优先模板，其次字段，最后直给）。
   * 逻辑与 /compose 完全一致，出图与预览不会漂移。
   */
  async function resolvePrompt(body = {}) {
    const template = body.templateId ? await assets.template(String(body.templateId)) : null;
    if (body.templateId && !template) throw new HttpError('模板不存在', 404, 'TEMPLATE_NOT_FOUND');
    const fieldset = body.fieldsetId ? await assets.fieldset(String(body.fieldsetId)) : null;
    if (body.fieldsetId && !fieldset) throw new HttpError('字段集不存在', 404, 'FIELDSET_NOT_FOUND');
    const enhancer = body.enhancerId ? await assets.enhancer(String(body.enhancerId)) : null;
    if (body.enhancerId && !enhancer) throw new HttpError('增强预设不存在', 404, 'ENHANCER_NOT_FOUND');

    const enhance =
      body.enhanceText !== undefined
        ? text(body.enhanceText, '增强文本', { required: false, max: 4000 })
        : body.enhance === false || !enhancer
          ? ''
          : enhancer.text;

    const composed = composePrompt({
      body: template ? template.body : undefined,
      variables: body.variables || {},
      fields: fieldset ? fieldset.fields : undefined,
      fieldValues: body.fieldValues || {},
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      ratio: text(body.ratio, '画幅比例', { required: false, max: 32 }) || undefined,
      enhance
    });
    if (!composed.prompt) {
      throw new HttpError('组装结果是空提示词，请填写模板/字段或直接给提示词', 400, 'EMPTY_PROMPT');
    }
    return {
      prompt: composed.prompt,
      parts: composed.parts,
      template: template ? { id: template.id, name: template.name } : null,
      fieldset: fieldset ? { id: fieldset.id, name: fieldset.name } : null,
      enhancer: enhancer && enhance ? { id: enhancer.id, name: enhancer.name } : null
    };
  }

  return {
    /** GET /api/image-studio.settings */
    settingsGet: guard(async () => json(await settings.describe())),

    /** POST /api/image-studio.settings（兼容旧路径 .save） */
    settingsSave: guard(async (request) => {
      const saved = await settings.save(await readJsonBody(request));
      if (onConfigSaved) {
        try {
          await onConfigSaved();
        } catch {
          /* 钩子失败不影响配置已保存这个事实 */
        }
      }
      return json(saved);
    }),

    /** POST /api/image-studio.models —— 用（草稿或已保存的）baseUrl + key 拉模型列表 */
    models: guard(async (request) => {
      const body = await readJsonBody(request);
      const saved = await settings.read();
      const baseUrl = normalizeBaseUrl(body.baseUrl || saved.baseUrl);
      const apiKey = String(body.apiKey || '').trim() || saved.apiKey;
      if (!apiKey) throw new HttpError('需要 API Key 才能拉取模型', 400, 'MISSING_KEY');
      const doFetch = resolveFetch();
      if (!doFetch) throw new HttpError('当前运行时不支持 fetch', 500, 'NO_FETCH');

      let response;
      try {
        response = await doFetch(`${baseUrl}/models`, {
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          signal: request.signal
        });
      } catch (cause) {
        throw new HttpError(`连接不上 ${baseUrl}：${cause?.message || cause}`, 502, 'CONNECT_FAILED');
      }
      const text = await response.text();
      if (!response.ok) {
        let detail = text.slice(0, 300);
        try {
          detail = JSON.parse(text)?.error?.message || detail;
        } catch {
          /* 保留原文 */
        }
        throw new HttpError(`拉取模型失败（HTTP ${response.status}）：${detail}`, 502, 'MODELS_FAILED');
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new HttpError('模型列表不是合法 JSON', 502, 'MODELS_BAD_JSON');
      }
      const raw = Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
      const models = [...new Set(
        raw
          .map((item) => (typeof item === 'string' ? item : item?.id || item?.name))
          .filter((item) => typeof item === 'string' && item.trim())
      )].sort((a, b) => a.localeCompare(b));
      if (models.length === 0) throw new HttpError('接口返回的模型列表为空', 502, 'MODELS_EMPTY');
      return json({ models });
    }),

    /** GET /api/image-studio.assets */
    assetsGet: guard(async (request) => {
      const url = new URL(request.url);
      const query = url.searchParams.get('q') || '';
      const kind = url.searchParams.get('kind') || '';
      if (query || kind) return json(await assets.search(query, kind));
      return json(await assets.list());
    }),

    /** POST /api/image-studio.assets.import */
    assetsImport: guard(async (request) => json(await assets.importAssets(await readJsonBody(request)))),

    /** POST /api/image-studio.compose —— 纯组装，不烧钱 */
    compose: guard(async (request) => json(await resolvePrompt(await readJsonBody(request)))),

    /**
     * POST /api/image-studio.generate
     *
     * 多图走「按张并发」：批次内部有界并发（默认 2，上限 4），再套一层进程级队列，
     * 多开窗口 / Agent 同时调用也不会把上游打爆。
     * 每张出图立刻落盘并把带鉴权的 URL 回填给浏览器；单张失败不影响同批其它图。
     * 带 batchId 时同时写进度表，界面可以轮询真实进度（已完成 X/N）。
     */
    generate: guard(async (request) => {
      const body = await readJsonBody(request);
      const config = await settings.active();
      const composed = await resolvePrompt(body);

      // 透明背景在 Images API 里没有对应字段，只能写成提示；其它参数原样透传。
      const finalPrompt = body.transparent ? `${composed.prompt}\n\n背景透明。` : composed.prompt;
      const requested = clampInteger(body.n, 1, 1, MAX_BATCH_IMAGES);
      const batchId = isBatchId(body.batchId) ? body.batchId : null;
      // 内部再套一层 AbortController：request.signal 只反映“浏览器断开”，
      // 界面切走/重进后还想停这一批，得靠 host 端按 batchId 取消。
      const controller = new AbortController();
      const onRequestAbort = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) controller.abort(request.signal.reason);
      else request.signal?.addEventListener?.('abort', onRequestAbort, { once: true });
      if (batch) batch.begin(batchId, requested, { cancel: () => controller.abort('界面请求取消') });
      const report = (patch) => {
        if (batch && batchId) {
          try {
            batch.update(batchId, patch);
          } catch {
            /* 进度表不参与结果判定 */
          }
        }
      };

      const startedAt = Date.now();
      const saved = [];
      let generatedTotal = 0;
      const fail = (error) => {
        report({ completed: requested, error });
        throw error;
      };

      let result;
      try {
        result = await generateBatch({
          generate: (params) => generate({ ...params, fetch: resolveFetch() }),
          schedule,
          prompt: finalPrompt,
          config: {
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            imageModel: config.imageModel,
            promptModel: config.promptModel || config.imageModel,
            protocol: config.protocol,
            timeoutMs: config.timeoutMs
          },
          ratio: body.ratio,
          size: text(body.size, '尺寸', { required: false, max: 32 }) || 'auto',
          quality: text(body.quality, '质量', { required: false, max: 16 }) || 'auto',
          outputFormat: body.outputFormat,
          background: body.background,
          reasoningEffort: body.reasoningEffort,
          n: requested,
          concurrency: clampInteger(
            body.concurrency ?? config.maxConcurrentImages ?? concurrency,
            concurrency,
            1,
            MAX_BATCH_CONCURRENCY
          ),
          retries: Number.isFinite(Number(body.retries)) ? clampInteger(body.retries, retries, 0, 3) : retries,
          referenceImages: (() => {
            const refs = Array.isArray(body.referenceImages) ? body.referenceImages : [];
            if (refs.length > 8) throw new HttpError('参考图最多 8 张（/images/edits 上限）', 400, 'TOO_MANY_REFERENCES');
            return refs;
          })(),
          // 取消要能真的中止上游：浏览器断开 / host 端按 batchId 取消 / 工具侧 abort 都会落到这里。
          signal: controller.signal,
          onProgress: async (progress) => {
            generatedTotal += Array.isArray(progress.images) ? progress.images.length : 0;
            report({
              completed: progress.completed,
              generated: generatedTotal,
              failed: progress.error ? 1 : 0,
              error: progress.error || null
            });
            if (!onGenerated) return null;
            if (!Array.isArray(progress.images) || progress.images.length === 0) return null;
            const payload = {
              prompt: finalPrompt,
              images: progress.images,
              meta: { ...progress.meta, imageIndex: progress.index, batch: { completed: progress.completed, requested: progress.requested } },
              partial: true
            };
            const returned = await onGenerated(payload);
            // 回调可能原地把 payload.images 换成 URL 形态（saveImages 的行为）；
            // 用它作为本张的替换结果——返回的 saved 只是磁盘描述符，不能当图片用。
            if (Array.isArray(returned) && returned.length > 0) saved.push(...returned);
            const replaced = Array.isArray(payload.images) && payload.images.length > 0 ? payload.images : null;
            if (!replaced && Array.isArray(payload.saved) && payload.saved.length > 0) saved.push(...payload.saved);
            return replaced;
          }
        });
      } catch (error) {
        // 先把失败写进进度表（界面正在轮询），再原样抛出交给 guard() 投影。
        fail(error);
      } finally {
        request.signal?.removeEventListener?.('abort', onRequestAbort);
      }

      const meta = {
        ...result.meta,
        protocol: config.protocol,
        imageModel: config.imageModel,
        templateId: composed.template?.id ?? null,
        enhancerId: composed.enhancer?.id ?? null,
        requested,
        generated: result.images.length,
        upstreamMs: Date.now() - startedAt
      };
      report({ completed: requested, generated: meta.generated, failed: meta.failed ?? 0 });
      const payload = { prompt: finalPrompt, images: result.images, meta };
      if (saved.length > 0) payload.saved = saved;
      payload.meta.totalMs = Date.now() - startedAt;
      if (getQueueStats) payload.meta.queue = getQueueStats();
      return json(payload);
    }),

    /** GET /api/image-studio.progress?batch=xxx —— 界面轮询真实进度 */
    progress: guard(async (request) => {
      const url = new URL(request.url);
      const id = url.searchParams.get('batch') || '';
      const stats = getQueueStats ? getQueueStats() : null;
      if (!id) return json({ batches: batch?.list?.(stats) ?? [], queue: stats });
      const found = batch?.get?.(id, stats) ?? null;
      return found ? json(found) : json({ code: 'BATCH_NOT_FOUND', error: '批次不存在或已过期' }, 404);
    }),

    /** GET /api/image-studio.queue —— 队列状态（含并发上限，用于界面提示与排障） */
    queue: guard(async () => json(getQueueStats ? getQueueStats() : { concurrency: 1, active: 0, pending: 0 })),

    /** POST /api/image-studio.cancel —— 界面切走/重进后仍能停掉正在跑的批次 */
    cancel: guard(async (request) => {
      const body = await readJsonBody(request);
      const id = body.batchId ?? body.batch ?? body.id;
      if (!isBatchId(id)) throw new HttpError('批次编号不合法', 400, 'BAD_BATCH');
      const outcome = batch?.cancel?.(id);
      if (!outcome || outcome.reason === 'NOT_FOUND') throw new HttpError('批次不存在或已过期', 404, 'BATCH_NOT_FOUND');
      if (!outcome.cancelled) {
        // ALREADY_DONE / NO_CANCEL_HANDLE：批次已经收尾，界面按“已结束”处理即可。
        throw new HttpError('批次已结束，无法取消', 409, 'BATCH_DONE');
      }
      return json({ ok: true, cancelled: true });
    }),

    /** POST /api/image-studio.delete —— 删掉输出目录里本插件写出的一张图（支持 yyyy/mm/dd 相对路径） */
    deleteImage: guard(async (request) => {
      const body = await readJsonBody(request);
      const name = text(body.name ?? body.path ?? body.relPath, '文件名', { required: true, max: 512 });
      if (!isRelativeImagePath(name)) throw new HttpError('文件路径不合法', 400, 'BAD_FILE');
      const dir = (await settings.read()).outputDir || '';
      if (!dir) throw new HttpError('还没有设置输出目录', 400, 'NO_DIR');
      // resolveOutputFile 已经做了「仍在输出目录内」的校验，双保险。
      const file = resolveOutputFile(dir, name);
      if (!file) throw new HttpError('文件路径不合法', 400, 'BAD_FILE');
      try {
        await unlink(file);
      } catch (error) {
        if (error?.code === 'ENOENT') throw new HttpError('图片不存在', 404, 'NOT_FOUND');
        throw new HttpError(`删除失败：${error?.message || error}`, 500, 'DELETE_FAILED');
      }
      return json({ ok: true, deleted: true });
    })
  };
}
