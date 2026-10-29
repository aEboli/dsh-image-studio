/**
 * 资产库：内置资产包 + 用户资产（存储层由调用方注入，便于测试与 host/client 共用）。
 *
 * 设计要点：
 *   - 内置资产随包发布（assets/builtin.json），只读；
 *   - 用户资产（自定义模板 / 增强预设）落在 DSH host 侧存储，键空间 `image-studio/assets`；
 *   - 仓库里 520 条 YouMind 模板属于 CC BY 4.0，默认不打包，走 scripts/export-repo-templates.mjs
 *     按需导出成用户资产，保留署名。
 */

const STORAGE_DEFAULT = { schema: 1, templates: [], enhancers: [], fieldsets: [] };

/** 计数「带合法 id 的导入条目」，非法条目不混进统计里。 */
function countIncoming(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && item.id).length;
}

/** 简单深拷贝，避免调用方改到内置资产。 */
function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * @param {object} deps
 * @param {object} deps.builtin  内置资产包（assets/builtin.json 的内容）
 * @param {object} [deps.store]  存储适配器：{ read(key), write(key, value) }
 */
export function createAssetLibrary({ builtin, store } = {}) {
  let cache = null;
  /**
   * 读-改-写串行锁：并发 import 时两个调用都读到同一份基线、后写的会覆盖前一个（丢更新）。
   * 只串行化「写」这条路径，读缓存逻辑不受影响。
   */
  let writeChain = Promise.resolve();
  function withWriteLock(action) {
    const next = writeChain.then(action, action);
    // 锁链本身永远不 reject，错误只回传给当次调用方。
    writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  function normalizedBuiltin() {
    const source = builtin || {};
    return {
      schema: source.schema || 1,
      enhancers: Array.isArray(source.enhancers) ? clone(source.enhancers) : [],
      fieldsets: Array.isArray(source.fieldsets) ? clone(source.fieldsets) : [],
      templates: Array.isArray(source.templates) ? clone(source.templates) : []
    };
  }

  async function readUser() {
    if (!store) return clone(STORAGE_DEFAULT);
    try {
      const raw = await store.read('image-studio/assets');
      if (!raw || typeof raw !== 'object') return clone(STORAGE_DEFAULT);
      return {
        schema: raw.schema || 1,
        templates: Array.isArray(raw.templates) ? clone(raw.templates) : [],
        enhancers: Array.isArray(raw.enhancers) ? clone(raw.enhancers) : [],
        fieldsets: Array.isArray(raw.fieldsets) ? clone(raw.fieldsets) : []
      };
    } catch {
      return clone(STORAGE_DEFAULT);
    }
  }

  /**
   * 合并结果缓存 + 单飞（single-flight）：
   * 并发 list()/search()/template() 以前会各自 clone 一遍全量资产（520 条时很贵），
   * 现在同一时刻只有一次真正构建，其余调用共享同一个 promise。
   */
  let loading = null;

  async function build() {
    const base = normalizedBuiltin();
    const user = await readUser();
    const byId = (items) => {
      const map = new Map();
      for (const item of items) if (item && item.id) map.set(item.id, item);
      return map;
    };

    const templates = byId([...base.templates, ...user.templates]);
    const enhancers = byId([...base.enhancers, ...user.enhancers]);
    const fieldsets = byId([...base.fieldsets, ...user.fieldsets]);

    cache = {
      schema: 1,
      templates: [...templates.values()],
      enhancers: [...enhancers.values()],
      fieldsets: [...fieldsets.values()]
    };
    return cache;
  }

  async function merged() {
    // 缓存命中直接返回引用；调用方只读，不再深拷贝 500 条（原来每次 list/search 都要 clone 全量）。
    if (cache) return cache;
    if (!loading) loading = build().finally(() => { loading = null; });
    return loading;
  }

  return {
    /** 全量资产（内置 + 用户）。 */
    list: () => merged(),

    /** 按 id 找模板。 */
    async template(id) {
      const all = await merged();
      return all.templates.find((item) => item.id === id);
    },

    /** 按 id 找字段集。 */
    async fieldset(id) {
      const all = await merged();
      return all.fieldsets.find((item) => item.id === id);
    },

    /** 按 id 找增强预设。 */
    async enhancer(id) {
      const all = await merged();
      return all.enhancers.find((item) => item.id === id);
    },

    /** 轻量检索：按名称/分类/正文匹配。 */
    async search(query, kind) {
      const all = await merged();
      const needle = String(query || '').trim().toLowerCase();
      const pick = (items) =>
        !needle
          ? items
          : items.filter((item) => {
              const haystack = [
                item.name,
                item.id,
                Array.isArray(item.category) ? item.category.join(' ') : '',
                item.body,
                item.text,
                item.description
              ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
              return haystack.includes(needle);
            });
      const result = {};
      if (!kind || kind === 'templates') result.templates = pick(all.templates);
      if (!kind || kind === 'enhancers') result.enhancers = pick(all.enhancers);
      if (!kind || kind === 'fieldsets') result.fieldsets = pick(all.fieldsets);
      return result;
    },

    /**
     * 导入用户资产（模板/增强预设/字段集），同 id 覆盖。
     * 返回本次真正新增/覆盖的条目数与合并后的总量，界面能显示「新增 X 条」。
     */
    async importAssets(payload = {}) {
      const current = await readUser();
      const mergeIn = (target, incoming) => {
        if (!Array.isArray(incoming)) return target;
        const map = new Map(target.filter((i) => i && i.id).map((i) => [i.id, i]));
        for (const item of incoming) if (item && item.id) map.set(item.id, clone(item));
        return [...map.values()];
      };
      const next = {
        schema: 1,
        templates: mergeIn(current.templates, payload.templates),
        enhancers: mergeIn(current.enhancers, payload.enhancers),
        fieldsets: mergeIn(current.fieldsets, payload.fieldsets)
      };
      if (store) await store.write('image-studio/assets', next);
      cache = null;
      return { imported: next.templates.length + next.enhancers.length + next.fieldsets.length };
    },

    /** 导出用户资产（便于备份/分享）。 */
    async exportUserAssets() {
      return readUser();
    }
  };
}
