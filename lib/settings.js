/**
 * host 侧配置 IO：把配置整份存进一条 host-only 的 credentials 记录。
 *
 * 约定与官方 dsh-image-generation 一致：
 *   - key 只存在 host 进程的凭据存储里，不写 profile 明文、不下发 client；
 *   - client 只能拿到 describe() 的脱敏投影（是否已配置 / key 尾号 4 位）。
 * 纯逻辑见 lib/config.js。
 */
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { homedir } from 'node:os';
import { CONFIG_DEFAULTS, describeState, mergeSaveInput } from './config.js';

const KEY = credentialKey('dsh-plugin-image-studio', 'configuration');

/** 默认输出目录：`图片/DSH-Image`（Windows），其它平台 ~/Pictures/DSH-Image。 */
function defaultOutputDir() {
  try {
    const home = homedir();
    return process.platform === 'win32' ? `${home}\\Pictures\\DSH-Image` : `${home}/Pictures/DSH-Image`;
  } catch {
    return '';
  }
}

export function createSettings(ctx) {
  async function read() {
    const fallback = { ...CONFIG_DEFAULTS, outputDir: defaultOutputDir() };
    if (!ctx.credentials?.readRecord) return fallback;
    const record = await ctx.credentials.readRecord(KEY);
    if (!record || record.kind !== 'grant' || !record.payload) return fallback;
    const state = { ...fallback, ...record.payload };
    if (!state.outputDir) state.outputDir = defaultOutputDir();
    return state;
  }

  async function writable() {
    try {
      const info = await ctx.credentials?.describeRecord?.(KEY);
      return info?.writable !== false;
    } catch {
      return true;
    }
  }

  async function describe() {
    return describeState(await read(), await writable());
  }

  async function active() {
    const state = await read();
    if (!state.baseUrl) throw new Error('还没有配置生图通道（baseUrl 为空）');
    if (!state.apiKey) throw new Error('还没有配置 API Key');
    return state;
  }

  async function save(input = {}) {
    if (!(await writable())) {
      const error = new Error('host 凭据存储当前只读');
      error.code = 'READ_ONLY';
      throw error;
    }
    const before = await read();
    const next = mergeSaveInput(before, input);
    await ctx.credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: next }));
    ctx.logger?.info?.('image-studio: configuration saved; protocol=%s model=%s', next.protocol, next.imageModel);
    return describeState(next, await writable());
  }

  return { read, describe, active, save };
}
