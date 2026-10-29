/**
 * 提示词组装引擎（纯函数，无 IO、无框架依赖）。
 *
 * 目标：把「仓库提示词模式」里散落的三层东西，收敛成同一条可测试的流水线：
 *   模板正文 / 结构化字段值  →  最终 prompt  →  （可选）增强文本
 *
 * 与上游（GPT-Image2-Studio）的差异：
 *   - 上游 `{argument name="x" default="y"}` 占位符没有运行时替换（直接发给模型）；
 *     这里补上替换，并且支持用户在界面上覆盖变量。
 *   - 上游字段拼装只存在于写真模式（portrait-planner.mjs:413-436）；
 *     这里抽成通用的 fieldset → 中文标签行 拼装，空值自动跳过。
 */

const VARIABLE_PATTERN = /\{argument\s+name="([^"]*)"\s+default="([^"]*)"\}/g;

/**
 * 从模板正文里抽出占位符变量。
 * @param {string} body
 * @returns {{name: string, default: string, label: string}[]}
 */
export function extractVariables(body) {
  const found = new Map();
  for (const match of String(body || '').matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (!found.has(name)) found.set(name, { name, default: match[2], label: name });
  }
  return [...found.values()];
}

/**
 * 用给定变量值替换模板里的 `{argument ...}`，未提供的回落到默认值。
 * @param {string} body
 * @param {Record<string, unknown>} [values]
 * @returns {string}
 */
export function applyVariables(body, values = {}) {
  return String(body || '').replace(VARIABLE_PATTERN, (_full, name, fallback) => {
    const value = values[name];
    return value === undefined || value === null || value === '' ? fallback : String(value);
  });
}

/**
 * 校验并归一用户给的变量对象（只保留模板声明过的变量）。
 * @param {string} body
 * @param {Record<string, unknown>} [values]
 */
export function resolveVariables(body, values = {}) {
  const resolved = {};
  for (const variable of extractVariables(body)) {
    const raw = values[variable.name];
    resolved[variable.name] =
      raw === undefined || raw === null || raw === '' ? variable.default : String(raw);
  }
  return resolved;
}

/**
 * 把字段集的值拼成「中文标签：值」逐行文本（空值跳过，保持字段顺序）。
 * @param {{key: string, label: string}[]} fields
 * @param {Record<string, unknown>} [values]
 * @returns {string}
 */
export function composeFieldset(fields, values = {}) {
  const lines = [];
  for (const field of fields || []) {
    if (!field || typeof field.label !== 'string') continue;
    const raw = values[field.key];
    if (raw === undefined || raw === null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    lines.push(`${field.label}：${text}`);
  }
  return lines.join('\n');
}

/**
 * 按上游 `appendRatioHintToPrompt`（aspect-ratios.mjs:92-96）的思路追加比例提示，
 * 幂等：已经写过就不再追加。
 * @param {string} prompt
 * @param {string} [ratio]
 */
export function appendRatioHint(prompt, ratio) {
  const text = String(prompt || '').trim();
  if (!ratio) return text;
  const hint = `Aspect ratio: ${ratio}.`;
  return text.includes(hint) ? text : `${text}\n\n${hint}`;
}

/**
 * 拼增强文本。规则与上游一致（public/app.js:171）：
 *   prompt + "\n\n" + 增强文本；若增强文本以 "," 开头则不加换行。
 * @param {string} prompt
 * @param {string} [enhance]
 */
export function applyEnhance(prompt, enhance) {
  const base = String(prompt || '').trim();
  const extra = String(enhance || '').trim();
  if (!extra) return base;
  return `${base}${extra.startsWith(',') ? '' : '\n\n'}${extra}`;
}

/**
 * 组装完整提示词。
 *
 * @param {object} input
 * @param {string} [input.body]        模板正文（可含变量）
 * @param {Record<string, unknown>} [input.variables]
 * @param {{key: string, label: string}[]} [input.fields] 字段定义
 * @param {Record<string, unknown>} [input.fieldValues]
 * @param {string} [input.prompt]      直接给的提示词（与上面二者互斥，优先级最低）
 * @param {string} [input.ratio]       画幅比例，写成 Aspect ratio 提示
 * @param {string} [input.enhance]     增强文本；空/未启用则不拼
 * @returns {{ prompt: string, parts: Record<string, string> }}
 */
export function composePrompt(input = {}) {
  const parts = {};
  let text = '';

  if (input.body) {
    const resolved = resolveVariables(input.body, input.variables);
    text = applyVariables(input.body, resolved).trim();
    parts.template = text;
  }

  if (!text && Array.isArray(input.fields) && input.fields.length > 0) {
    text = composeFieldset(input.fields, input.fieldValues);
    parts.fields = text;
  }

  if (!text && input.prompt) text = String(input.prompt).trim();

  if (input.ratio) {
    text = appendRatioHint(text, input.ratio);
    parts.ratio = `Aspect ratio: ${input.ratio}.`;
  }

  if (input.enhance) {
    text = applyEnhance(text, input.enhance);
    parts.enhance = String(input.enhance).trim();
  }

  return { prompt: text.trim(), parts };
}
