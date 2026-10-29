/**
 * host 半边入口（cordis 插件）。
 *
 * 只做装配：
 *   - 读内置资产包；
 *   - 建配置 / 资产库 / 路由处理层；
 *   - 注册同源 HTTP 路由（走 connection.fetch，带鉴权通道）；
 *   - 注册 agent 工具；
 *   - 插一段系统提示。
 *
 * 具体逻辑在 lib/ 下，都是纯函数，可脱离 DSH 单测。
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createSettings } from './lib/settings.js';
import { createAssetLibrary } from './lib/assets.js';
import { createHandlers, json, toErrorBody } from './lib/handlers.js';
import {
  DATE_SEGMENT_PATTERN,
  datePathFor,
  extensionForMime,
  isImageName,
  isRelativeImagePath,
  mimeForImageName,
  newestFirst,
  outputDirPath,
  readImageSizeFrom,
  resolveOutputFile
} from './lib/outputs.js';
import { generate } from './lib/provider.js';
import { createLimiter, mapLimit } from './lib/concurrency.js';
import { createBatchRegistry } from './lib/batch-registry.js';

export const name = 'dsh-plugin-image-studio';
// 只 inject 一定存在的服务；storageDomain 视组合而定，用 ctx.get 惰性取。
// subprocess 用来「打开文件夹」；视组合而定，取不到就退化成无操作并提示。
export const inject = ['credentials', 'connection', 'tools', 'systemPrompt'];
export const Config = z.object({});

export const PROMPT_SECTION = 'tool:image-studio';
export const UNCONFIGURED_PROMPT =
  'Do not call image_studio_generate. The user configures the image studio in Settings > Plugins > Image studio. Never ask for an API key in conversation.';
export const CONFIGURED_PROMPT =
  'An image studio is available. For prompt work, prefer image_studio_compose (free, no credits) so the user can review the exact prompt; then call image_studio_generate. Reuse image_studio_assets to pick a template or enhancer instead of inventing style words.';

/** 读内置资产包（随包发布）。 */
async function loadBuiltinAssets() {
  const file = fileURLToPath(new URL('./assets/builtin.json', import.meta.url));
  return JSON.parse(await readFile(file, 'utf8'));
}

/** 一套最小的存储适配器：DSH host 的 storageDomain 没就绪时退化成内存。 */
function createAssetStore(ctx) {
  const memory = new Map();
  return {
    async read(key) {
      try {
        const domain = ctx.get?.('storageDomain');
        const store = domain?.get?.('image-studio-assets');
        if (store?.get) return await store.get(key);
      } catch {
        /* 退化成内存 */
      }
      return memory.get(key);
    },
    async write(key, value) {
      try {
        const domain = ctx.get?.('storageDomain');
        const store = domain?.get?.('image-studio-assets');
        if (store?.set) {
          await store.set(key, value);
          return;
        }
      } catch {
        /* 退化成内存 */
      }
      memory.set(key, value);
    }
  };
}

/**
 * 开发期诊断日志：写到临时目录，便于从宿主外部确认真实加载路径与请求。
 * 异步串行队列：原来每条日志都 appendFileSync 同步写，并发出图时会阻塞事件循环，
 * 把等待上游的空档白白占掉。日志丢了也无所谓，绝不影响主流程。
 */
const DEBUG_LOG_FILE = path.join(tmpdir(), 'image-studio-boot.log');
let debugQueue = Promise.resolve();
function debugLog(line) {
  debugQueue = debugQueue
    .then(() => appendFile(DEBUG_LOG_FILE, `${new Date().toISOString()} ${line}\n`))
    .catch(() => {
      /* 忽略：日志失败不影响生图 */
    });
}

export async function apply(ctx) {
  debugLog(`apply start @ ${import.meta.url}`);
  const builtin = await loadBuiltinAssets();
  const settings = createSettings(ctx);
  const assets = createAssetLibrary({ builtin, store: createAssetStore(ctx) });
  /**
   * 进程级出图队列：多开窗口、Agent 工具、界面批次全部走同一个信号量，
   * 这样「界面并发 4」不会变成「上游同时 16 个请求」。
   * 并发上限跟随设置里的 maxConcurrentImages，保存配置后热更新。
   */
  const limiter = createLimiter({ concurrency: 3, maxPending: 64 });
  const batches = createBatchRegistry({ ttlMs: 120_000 });
  limiter.setConcurrency((await settings.read()).maxConcurrentImages || 3);
  /**
   * 出图后按设置里的输出目录落盘，并按日期分目录：<outputDir>/2026/10/25/xxx.png。
   * 目录不存在会自动创建；文件名带时间戳，避免覆盖。
   */
  const saveImages = async (payload) => {
    let dir = '';
    try {
      dir = (await settings.read()).outputDir || '';
    } catch {
      return [];
    }
    if (!dir) return [];
    const target = outputDirPath(dir);
    const datePath = datePathFor(new Date());
    const dateDir = path.join(target, ...datePath.split('/'));
    await mkdir(dateDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const indexHint = Number.isFinite(Number(payload.meta?.imageIndex)) ? Number(payload.meta.imageIndex) + 1 : null;
    const saved = (await Promise.all((payload.images || []).map(async (image, localIndex) => {
      if (image.kind !== 'base64' && image.kind !== 'binary') return null;
      const ordinal = indexHint !== null ? indexHint : localIndex + 1;
      // 扩展名跟着上游给的 mime 走：网关回 JPEG 时不该存成 .png。
      const ext = extensionForMime(image.mime);
      const name = `image-studio-${stamp}-${ordinal}-${randomUUID().slice(0, 8)}.${ext}`;
      const file = path.join(dateDir, name);
      const bytes = image.kind === 'binary' ? image.bytes : Buffer.from(image.data, 'base64');
      await writeFile(file, bytes);
      return { path: file, bytes: bytes.length, name, relPath: `${datePath}/${name}`, mime: mimeForImageName(name) };
    }))).filter(Boolean);
    // 关键：不再把几 MB 的 base64 回传给浏览器（那会让响应体走桥接慢几十秒），
    // 回给浏览器的是带登录态的 /api 图片地址；client 用 fetch 取字节后转 Blob URL 显示。
    if (saved.length > 0) {
      payload.images = saved.map(item => ({
        kind: 'url',
        url: `/api/image-studio.image?file=${encodeURIComponent(item.relPath)}`,
        name: item.name,
        relPath: item.relPath,
        bytes: item.bytes
      }));
    }
    debugLog(`saved ${saved.length} -> ${dateDir} (upstream ${payload.meta?.upstreamMs ?? "?"}ms)`);
    return saved;
  };

  /**
   * 最近的生成记录，用于底部胶片条。
   * 支持根目录旧文件与 yyyy/mm/dd 子目录；按文件名时间戳倒序，只处理前 limit 个。
   * 每项补 width/height（只读 PNG 头 24 字节），界面直接显示真实尺寸。
   */
  const listGallery = async (limit = 30) => {
    const dir = (await settings.read()).outputDir || '';
    if (!dir) return [];
    const target = outputDirPath(dir);
    const relativePaths = [];
    const walk = async (base, prefix, depth) => {
      let entries;
      try {
        entries = await readdir(base, { withFileTypes: true });
      } catch {
        return;
      }
      const subdirs = [];
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (depth < 3 && DATE_SEGMENT_PATTERN.test(entry.name)) subdirs.push([path.join(base, entry.name), relative, depth + 1]);
          continue;
        }
        if (entry.isFile() && isImageName(entry.name)) relativePaths.push(relative);
      }
      // 日期目录之间互不依赖，并行展开。
      await Promise.all(subdirs.map(([dir, relative, nextDepth]) => walk(dir, relative, nextDepth)));
    };
    await walk(target, '', 0);

    const candidates = newestFirst(relativePaths).slice(0, Math.max(1, Number(limit) || 30));
    // 每张要 stat + 读 24 字节的 PNG 头：30 张串行就是 60 次 IO 往返，改 8 路并发。
    return (await mapLimit(candidates, 8, async (relativePath) => {
      const file = path.join(target, ...relativePath.split('/'));
      try {
        const [info, size] = await Promise.all([stat(file), readImageSizeFrom(file, relativePath)]);
        if (!info.isFile()) return null;
        return {
          name: relativePath.split('/').at(-1),
          relPath: relativePath,
          bytes: info.size,
          mtime: info.mtimeMs,
          width: size?.width ?? null,
          height: size?.height ?? null,
          url: `/api/image-studio.image?file=${encodeURIComponent(relativePath)}`
        };
      } catch {
        /* 跳过读不到的文件 */
        return null;
      }
    })).filter(Boolean);
  };

  /** 设置保存后热更新全局并发上限（不用重启插件）。 */
  const applyConcurrency = async () => {
    try {
      const state = await settings.read();
      limiter.setConcurrency(state.maxConcurrentImages || 3);
    } catch {
      /* 读不到就用当前值 */
    }
  };

  const handlers = createHandlers({
    settings,
    assets,
    generate,
    onGenerated: saveImages,
    batch: batches,
    schedule: (task, options) => limiter.run(task, options),
    getQueueStats: () => limiter.stats(),
    onConfigSaved: applyConcurrency
  });

  /** 打开输出目录（或在不存在时创建），让用户直接在资源管理器里看图。 */
  const openOutputDir = async () => {
    const dir = (await settings.read()).outputDir || '';
    if (!dir) throw new Error('还没有设置输出目录');
    const target = outputDirPath(dir);
    await mkdir(target, { recursive: true });
    const platform = process.platform;
    const command = platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open';
    const subprocess = ctx.get?.('subprocess');
    if (!subprocess?.spawn) throw new Error('当前环境不支持打开文件夹，请手动打开该路径');
    try {
      const child = subprocess.spawn({
        argv: [command, target],
        cwd: target,
        env: process.env,
        signal: AbortSignal.timeout(4000),
        graceMs: 500,
        stdio: {
          stdin: { data: '' },
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 2048 }
        }
      });
      // explorer.exe 打开目录后会立刻退出；超时也无所谓，目录已经打开了。
      await Promise.race([
        child.done,
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
    } catch (error) {
      debugLog(`open dir failed: ${error?.message || error}`);
      throw new Error(`打不开目录：${error?.message || error}`);
    }
    debugLog(`open dir ${target}`);
    return { path: target };
  };

  /** 统一注册 JSON 路由，异常都变成 {code,error}。 */
  const route = (path, methods, handler) => {
    ctx.connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        debugLog(`hit ${request.method} ${path}`);
        try {
          const response = await handler(request);
          debugLog(`done ${request.method} ${path} -> ${response.status}`);
          return response;
        } catch (error) {
          const { status, body } = toErrorBody(error);
          debugLog(`error ${request.method} ${path} -> ${status} ${body.error}`);
          return json(body, status);
        }
      }
    });
    debugLog(`route ${path}`);
  };

  // 同时注册点号与斜杠两种路径：点号是 DSH 官方惯例，斜杠作为兼容兜底。
  const register = (suffix, methods, handler) => {
    route(`/api/image-studio.${suffix}`, methods, handler);
    route(`/api/image-studio/${suffix.replaceAll('.', '/')}`, methods, handler);
  };

  register('settings', ['GET', 'POST'], (request) =>
    request.method === 'GET' ? handlers.settingsGet(request) : handlers.settingsSave(request)
  );
  // 兼容旧 client 的 .save 路径（新 client 走 .settings POST）。
  register('save', ['POST'], handlers.settingsSave);
  register('models', ['POST'], handlers.models);
  register('assets', ['GET'], handlers.assetsGet);
  register('assets.import', ['POST'], handlers.assetsImport);
  register('compose', ['POST'], handlers.compose);
  register('generate', ['POST'], handlers.generate);
  register('delete', ['POST'], handlers.deleteImage);
  register('cancel', ['POST'], handlers.cancel);
  register('openDir', ['POST'], async () => json(await openOutputDir()));
  register('gallery', ['GET'], async (request) => {
    const limit = new URL(request.url).searchParams.get('limit');
    return json({ images: await listGallery(limit ? Number(limit) : undefined) });
  });
  register('progress', ['GET'], handlers.progress);
  register('queue', ['GET'], handlers.queue);
  register('image', ['GET'], async (request) => {
    const url = new URL(request.url);
    const name = url.searchParams.get('file') || '';
    if (!isRelativeImagePath(name)) {
      return json({ code: 'BAD_FILE', error: '文件路径不合法' }, 400);
    }
    const dir = (await settings.read()).outputDir || '';
    if (!dir) return json({ code: 'NO_DIR', error: '还没有设置输出目录' }, 400);
    const file = resolveOutputFile(dir, name);
    if (!file) return json({ code: 'BAD_FILE', error: '文件路径不合法' }, 400);
    try {
      const bytes = await readFile(file);
      // 文件名带时间戳+随机后缀、且删除后不可能原样重建 → 可以永久缓存，
      // 画廊反复滚动时浏览器直接命中磁盘缓存，不再回源。
      return new Response(bytes, {
        headers: {
          'content-type': mimeForImageName(name),
          'content-length': String(bytes.length),
          'cache-control': 'public, max-age=31536000, immutable'
        }
      });
    } catch {
      return json({ code: 'NOT_FOUND', error: '图片不存在' }, 404);
    }
  });
  debugLog('routes registered');

  // ---- agent 工具 -------------------------------------------------------
  const tools = [
    defineTool({
      name: 'image_studio_assets',
      description:
        'List or search the image studio prompt assets: templates (image+prompt pairs), fieldsets (structured prompt forms) and enhancers (quality/style suffixes). Call this before composing so the prompt reuses an existing asset instead of inventing style words.',
      parameters: {
        kind: {
          type: 'string',
          enum: ['templates', 'fieldsets', 'enhancers', 'all'],
          description: 'Asset kind; defaults to all.'
        },
        query: { type: 'string', description: 'Optional keyword matched against name, category and body.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            assets: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } }
          }
        },
        render: (_args, value) => [{ type: 'text', text: summarize(value) }]
      },
      timeoutMs: 20_000,
      async execute(args = {}) {
        const kind = args.kind && args.kind !== 'all' ? args.kind : undefined;
        const found = await assets.search(args.query || '', kind);
        const flat = [
          ...(found.templates || []).map((item) => ({ kind: 'template', id: item.id, name: item.name })),
          ...(found.fieldsets || []).map((item) => ({ kind: 'fieldset', id: item.id, name: item.name })),
          ...(found.enhancers || []).map((item) => ({ kind: 'enhancer', id: item.id, name: item.name }))
        ];
        return { count: flat.length, assets: flat };
      }
    }),
    defineTool({
      name: 'image_studio_compose',
      description:
        'Compose the final image prompt from a template (+variables), a fieldset (+values), or a raw prompt, optionally appending an aspect-ratio hint and an enhancer suffix. Free: it never calls the image provider, so use it to show the user the exact prompt before generating.',
      parameters: {
        templateId: { type: 'string', description: 'Template id from image_studio_assets.' },
        variables: { type: 'object', additionalProperties: true, description: 'Template variable values.' },
        fieldsetId: { type: 'string', description: 'Fieldset id from image_studio_assets.' },
        fieldValues: { type: 'object', additionalProperties: true, description: 'Fieldset values keyed by field key.' },
        prompt: { type: 'string', description: 'Raw prompt when no template/fieldset is used.' },
        ratio: { type: 'string', description: 'Aspect ratio such as 9:16.' },
        enhancerId: { type: 'string', description: 'Enhancer id; omit for no enhancer.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { prompt: { type: 'string', required: true } }
        },
        render: (_args, value) => [{ type: 'text', text: value.prompt }]
      },
      timeoutMs: 20_000,
      async execute(args = {}) {
        const response = await handlers.compose(
          new Request('http://localhost/api/image-studio.compose', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args)
          })
        );
        const payload = await response.json();
        if (response.status !== 200) throw new Error(payload.error || 'compose failed');
        return { prompt: payload.prompt };
      }
    }),
    defineTool({
      name: 'image_studio_generate',
      description:
        'Generate one or more images through the configured image studio provider and return them as attachments. Accepts the same template/fieldset/compose arguments plus image parameters.',
      parameters: {
        prompt: { type: 'string', description: 'Final prompt; omit to compose from template/fieldset.' },
        templateId: { type: 'string' },
        variables: { type: 'object', additionalProperties: true },
        fieldsetId: { type: 'string' },
        fieldValues: { type: 'object', additionalProperties: true },
        enhancerId: { type: 'string' },
        ratio: { type: 'string' },
        size: { type: 'string', description: 'Pixel size such as 1536x1024, or auto.' },
        quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
        n: { type: 'integer', description: '1-4; the studio caps at 4.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', required: true },
            imageCount: { type: 'integer', required: true }
          }
        },
        render: (_args, value) => [{ type: 'text', text: `已生成 ${value.imageCount} 张。\n\n${value.prompt}` }]
      },
      timeoutMs: 20 * 60 * 1000,
      async execute(args = {}, exec) {
        if (exec?.signal?.aborted) throw new Error('已取消');
        const response = await handlers.generate(
          new Request('http://localhost/api/image-studio.generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args),
            // 工具被取消时把信号带进去，上游请求会真的中止。
            signal: exec?.signal
          })
        );
        const payload = await response.json();
        if (response.status !== 200) throw new Error(payload.error || 'generate failed');
        return { prompt: payload.prompt, imageCount: (payload.images || []).length };
      }
    })
  ];
  for (const tool of tools) ctx.tools.register(tool);

  // ---- 系统提示 ---------------------------------------------------------
  ctx.systemPrompt.section({ name: PROMPT_SECTION, order: 116, text: UNCONFIGURED_PROMPT });
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    let configured = false;
    try {
      configured = (await settings.describe()).configured;
    } catch {
      /* 当未配置处理 */
    }
    const assembly = await next();
    return {
      ...assembly,
      sections: assembly.sections.map((section) =>
        section.name === PROMPT_SECTION
          ? { ...section, text: configured ? CONFIGURED_PROMPT : UNCONFIGURED_PROMPT }
          : section
      )
    };
  });

  ctx.logger?.info?.('image-studio: ready; assets=%d', builtin.templates?.length ?? 0);
}

function summarize(value) {
  const list = Array.isArray(value?.assets) ? value.assets : [];
  if (list.length === 0) return '没有匹配的资产。';
  return list.slice(0, 40).map((item) => `${item.kind} · ${item.id} · ${item.name}`).join('\n');
}
