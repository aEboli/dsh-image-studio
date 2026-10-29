# 生图工作台（dsh-plugin-image-studio）· 状态

> 版本：0.2.0 ｜ 界面 BUILD **r18** ｜ 测试 **148 项全过**（`node --test`）｜ 已装入 profile（重启后生效）

## 本轮优化：并发 + 稳健性

**多层并发，全部有界**
- 每次点「开始生成」可出 1~4 张，**按张并发**（单批内部并发 1~4），不再靠上游 `n` 字段。
- host 侧一层**进程级信号量**（`createLimiter`，默认并发 3，设置里 1~8 可调、保存后热更新）：多开窗口 / Agent 工具 / 多个批次共用同一个上限，界面并发 4 不会变成上游同时 16 个请求。
- 队列满返回 429 `QUEUE_FULL`（不排队打死）；`retries>0` 时会自动退避重试恢复。
- 图片取回、画廊扫描、参考图转 base64 都改成有界并发（`mapLimit` /`mapBounded`），30 张画廊不再串行 60 次 IO。

**逐张落盘 + 真实进度**
- 每张出图**立刻落盘**并把带鉴权的 URL 回填给浏览器（几 MB base64 不回传），不必等整批。
- 新增 `GET /api/image-studio.progress?batch=xxx`：界面每 900ms 轮询**真实进度**（已完成 X/N + 进度条），不再是按时间猜的百分比。
- 生成中切走再回来会接回同一批的进度轮询。
- 新增 `POST /api/image-studio.cancel`：按 batchId 让 host 端真的中止还在跑的批次（`abortRef` 属于旧组件实例时也能停）。

**失败不浪费已付费产物**
- 部分失败：成功的照常返回并落盘，失败明细进 `meta.errors`，HTTP 仍 200。
- 全部失败：聚合首个原因，投影 502（`UPSTREAM_ERROR`/`GENERATION_FAILED`）；取消投影 499；超时 504。
- 可重试错误（5xx/429/408/409、网络类）指数退避，尊重 `Retry-After` / `Retry-After-Ms`（单位分别按秒/毫秒解析）。

**格式正确性**
- 落盘扩展名跟随上游 mime（png/jpg/webp），回图 `content-type` 与之匹配；新增 JPEG(SOF)/WebP(VP8/VP8L/VP8X) 尺寸解析，画廊显示真实宽高。
- 图片路由改 `cache-control: public, max-age=1年, immutable`（文件名含时间戳+随机后缀，删除后不会原样重建）。

## 其他修复（顺带）

- `npm test` 之前是 `node --test test/`，在 Node 25 下把 `test/` 当模块解析直接报错；改成 `node --test` 自动发现。
- `debugLog` 从同步 `appendFileSync` 改成异步串行队列（并发出图时不再阻塞事件循环）。
- 资产库：`merged()` 加单飞缓存（并发 list/search 不再各自全量 clone）；`importAssets` 用写锁串行化，并发导入不再丢更新。
- 浏览器 blob 缓存做 LRU（上限 80，超出回收），`hydrateImages` 用 `relPath` 取图（日期子目录里的图不再 404）。
- 参考图：拖拽/“加入参考图”统一 8 张 + 单张 4MB 上限（原来一处写死 15），函数式更新防连点超限。
- 保存设置用独立 `saving` 态（不再借用 busy 把界面当“正在生成”）；409 冲突自动重拉最新配置。
- `call()` 的 404 兜底把 path 与 query 分开处理，避免 `?batch=a.b` 被点号替换破坏。

## 已知限制

1. **edits 兼容性**：multipart 仍带 `model` 字段；个别中转拒绝就去掉 `lib/provider.js` 里 `form.append('model', ...)`。
2. **删除确认**用 `window.confirm`；WebView 屏蔽时会静默不删。
3. **模板列表**最多渲染 300 条，未做虚拟滚动。
4. **进度轮询依赖宿主透传**：`/progress` 走同源 fetch，与是否流式无关，稳妥；真正取消是否停上游取决于网关（已用假上游冒烟验证 host 侧 signal 传导）。

## 接口一览（host）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/image-studio.settings` | 读/存配置（含并发上限、默认张数）|
| POST | `/api/image-studio.models` | 拉模型列表 |
| GET | `/api/image-studio.assets` | 模板/字段集/增强预设 |
| POST | `/api/image-studio.compose` | 组装 prompt（免费）|
| POST | `/api/image-studio.generate` | 出图（按张并发 / 参考图 edits / 逐张落盘）|
| GET | `/api/image-studio.progress` | 批次真实进度（?batch=xxx 或全量）|
| POST | `/api/image-studio.cancel` | 按 batchId 取消正在跑的批次 |
| GET | `/api/image-studio.queue` | 队列状态（并发上限/运行中/排队中）|
| GET | `/api/image-studio.gallery` | 最近图片（含宽高，?limit=）|
| POST | `/api/image-studio.delete` | 删除输出目录里的图 |
| POST | `/api/image-studio.openDir` | 打开输出目录 |
| GET | `/api/image-studio.image` | 图片二进制（immutable 缓存）|

## 验证

```powershell
node --check host.js; node --check client.js   # 或 npm run check:syntax
node --test                                      # 或 npm test，148 项
```
纯逻辑 + 集成：`compose / assets / provider / provider-errors / handlers / handlers-batch / config / outputs / concurrency / generation / batch-registry / routes`。
另有一套假上游端到端冒烟（`apply()` + 路由 + 落盘 + 进度 + 取消 + 重试 + 队列满），已验证并发不越界、部分失败保留成功产物、取消保留已完成图。
