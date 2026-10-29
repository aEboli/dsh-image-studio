# dsh-image-studio

DSH 生图工作台插件。入口在侧栏**工作区列表上方**那排图标行，点开是整页工作台；
界面按参考截图分区（参考图 / 提示词 / 增强模式 / 参数 / 大画布 / 底部画廊）；
提示词模式取自 [aEboli/GPT-Image2-Studio](https://github.com/aEboli/GPT-Image2-Studio)。

## 现在有什么

| 能力 | 说明 |
|---|---|
| 侧栏入口 + 整页工作台 | `sidebar.panellist` 一行入口（order 20），点开切到 `main` 的 `image-studio` 页 |
| 提示词模式 | 模板库（10 条内置 + 可导入仓库 520 条）、结构化字段集（人像 11 项 / 通用 10 项）、4 套增强预设 |
| 变量替换 | `{argument name="x" default="y"}` 在组装时替换（上游缺失的一步） |
| 实时预览 | 左栏底部实时显示最终会发出去的 prompt；组装接口不消耗积分 |
| 出图 | images 协议；host 代理，Key 只在 host；**1~4 张按张并发 + 进程级队列限流**，逐张落盘 |
| 真实进度 | `/progress` 轮询「已完成 X/N」+ 进度条；切走再回来接回同一批；`/cancel` 按 batchId 中止 |
| 容错 | 单张失败不影响同批其它图（成功产物照常落盘）；5xx/429/网络错误指数退避重试，尊重 Retry-After |
| 画廊 | 底部缩略图条 + `ImageLightbox` 大图查看 |
| Agent 工具 | `image_studio_assets` / `image_studio_compose` / `image_studio_generate` |

## 安装

从 GitHub 安装（推荐，市场索引用的就是这个来源）：

```powershell
plugin_manager install_bundle
  target: git+https://github.com/aEboli/dsh-image-studio.git
```

从本地 tarball 安装：

```powershell
plugin_manager install_bundle
  target: file:<插件目录>/dsh-image-studio-0.2.0.tgz
```

开发调试用 link 方式：

```powershell
plugin_manager install_bundle
  target: link:<插件目录的绝对路径>
```

装好后侧栏出现"生图工作台"，第一次打开会提示配置 Base URL / API Key。**装完需要完全退出并重开 DSH Desktop。**

## 加入你的插件市场

本仓库自带市场索引 `market/index.json`。把它放到任意 https 静态托管，然后在
DSH 的 **设置 → 插件市场 → 索引地址** 填入该 URL 即可看到本插件。

详见 [PUBLISH.md](./PUBLISH.md)。

## 配置

设置弹窗里填：

- **协议**：`Images API`（`POST /v1/images/generations`）或 `Responses API`（`POST /v1/responses` + `tools[image_generation]`，即上游仓库默认路径）
- **Base URL**：如 `https://api.example.com/v1`（末尾不带 `/` 也可以，会自动补 `/v1`）
- **API Key**：只存 host 侧 credentials，浏览器拿不到；换域名时必须重新填
- **生图模型**：如 `gpt-image-2`

## 提示词资产

- 内置：`assets/builtin.json`（10 模板 / 2 字段集 / 4 增强预设）
- 从上游仓库导出 520 条 Prompt Kit 模板：

```powershell
node scripts/export-repo-templates.mjs --repo "C:\path\to\GPT-Image2-Studio"
```

导出文件是 CC BY 4.0，每条都带 `source` 字段，**导入后请保留署名**。

## 测试

```powershell
npm test   # 等价于 node --test（自动发现 test/ 下所有用例）
```

纯逻辑 + 集成 148 项用例（组装 / 资产 / 协议 / 路由 / 并发队列 / 批量生成 / 进度登记 / 路由一致性守护），不依赖 DSH 运行时。

## 结构

```
host.js              cordis 插件入口：注册路由 + 工具 + 系统提示
client.js            浏览器半边：侧栏入口 + 整页工作台
lib/compose.js       模板变量替换 / 字段拼装 / 增强拼接（纯函数）
lib/assets.js        资产库（内置 + 用户，可注入存储）
lib/provider.js      images / responses 两种协议 + SSE 解析
lib/handlers.js      路由处理层（校验、错误投影、批次编排）
lib/concurrency.js   并发原语：有界 mapLimit + 进程级信号量（取消/队列满）
lib/generation.js    多图批次：按张并发、指数退避重试、部分失败保留
lib/batch-registry.js 批次进度登记（TTL + 容量上限 + 按 id 取消）
lib/config.js        配置形状、脱敏投影、保存校验（纯函数）
lib/settings.js      host 侧配置 IO（credentials 记录）
assets/              内置资产包 + 可选导出的仓库模板
scripts/             从上游仓库导出模板
test/                node:test 用例
```

## 已知边界

- 图片落盘到设置里的输出目录（按日期分目录），还没有接入 DSH 附件体系（`ctx.attachments.saveImage`）。
- 参考图只做 base64 透传，尚未做尺寸压缩；单张 4MB / 最多 8 张在上限内。
- `Menu` / `Switch` / `Button` 的用法已按 `dsh-client-ui-primitives` 真实签名核对；`ImageLightbox` 需要 `labels.dialog` / `labels.close`。
- 上游 SVG 图标未随包，侧栏入口用内联 SVG。
