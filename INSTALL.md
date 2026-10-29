# dsh-plugin-image-studio 0.2.0 安装说明

本目录包含一个可离线安装的插件包：

    dsh-plugin-image-studio-0.2.0.tgz     (61.6 KB)

校验（sha256）：

    57375574ddbde69d4d6b33203c2c060a7aac20873628e075a7ca612f80c13cd1

## 前提

- DSH Desktop **>= 0.11**（本包在 0.12.1 上验证通过）
- 不需要联网，不需要 npm registry（包内无任何运行时依赖）
- 宿主自带的 `react` / `@deepseek-ai/*` 由 DSH 提供，本包不打包它们

## 安装方式 A：让助手装（最简单）

在 DSH 里新开一个会话，把本 tgz 放到工作区，然后说：

> 用 plugin_manager 安装 dsh-plugin-image-studio，target 指向
> <你的路径>\dsh-plugin-image-studio-0.2.0.tgz

对应调用：

    plugin_manager install_bundle
      target: file:C:\path\to\dsh-plugin-image-studio-0.2.0.tgz

## 安装方式 B：命令行

    dsh plugin --profile web add file:C:\path\to\dsh-plugin-image-studio-0.2.0.tgz

## 安装方式 C：解压后按 link 安装（开发调试用）

    tar -xzf dsh-plugin-image-studio-0.2.0.tgz
    # 得到 package/ 目录，把它重命名成 dsh-plugin-image-studio
    plugin_manager install_bundle target: link:<该目录绝对路径>

## 装完必须重启

宿主只在启动时加载插件代码。**装完要完全退出并重开 DSH Desktop**。

重启后自查三处（任一不对就是没生效）：

1. 侧栏「生图工作台」→ 右下「当前调用」→ **界面版本** = `r18`
2. 参数区出现 **生成张数**（1 / 2 / 3 / 4 四个按钮）
3. 设置弹窗出现 **并发上限**（1–8 路）和 **默认张数**

## 首次配置

打开工作台 → 「打开设置」，填：

- **Base URL**：如 `https://api.example.com/v1`（不带 /v1 会自动补）
- **API Key**：只存在宿主凭据里，浏览器拿不到
- **生图模型**：如 `gpt-image-2`
- **输出目录**：图片落盘位置，留空则只预览不保存

## 这个版本有什么

- **多图并发**：一次出 1–4 张，按张并发；进程级队列兜底（默认 3 路，可调 1–8），
  多开窗口也不会把上游打爆
- **真实进度**：轮询「已完成 X/N」+ 进度条，不是估的
- **可取消**：切走再回来仍能按批次取消
- **失败不浪费**：单张失败不影响同批其它图，成功的那几张照常落盘
- **自动重试**：5xx / 429 / 网络错误指数退避，尊重 Retry-After
- **格式正确**：落盘扩展名跟随上游 mime（png/jpg/webp），画廊能读 JPEG/WebP 尺寸

## 关于提示词模板

包内自带 **10 条**模板 + 2 套字段集 + 4 套增强预设（`assets/builtin.json`）。

另有 520 条 YouMind Prompt Kit 模板（CC BY 4.0，来自 aEboli/GPT-Image2-Studio）
**刻意没有打进包里**，原因见 `NOTICE.md`。需要的话自行导出导入：

    node scripts/export-repo-templates.mjs --repo "<上游仓库路径>"

然后走界面导入，或用 `POST /api/image-studio.assets.import`。导入后请保留署名。

## 卸载

    plugin_manager remove_bundle target: dsh-plugin-image-studio

或：

    dsh plugin --profile web remove dsh-plugin-image-studio

## 出问题怎么查

- 装完没变化 → 99% 是没重启，或装的 profile 不是当前在用的那个
- 界面出现但按钮灰 → 设置里没配 Base URL / API Key
- 出图报 401/403 → Key 或 baseUrl 不对
- 报「队列已满」→ 并发调低，或等当前批次跑完
