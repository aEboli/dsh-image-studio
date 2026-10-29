# NOTICE

## 本包许可

dsh-plugin-image-studio 本体代码以 **MIT** 发布。

## 随包与不随包的第三方内容

**随包**：`assets/builtin.json` —— 本插件自带的 10 条模板、2 套字段集、4 套增强预设，随 MIT 代码一同发布。

**不随包**：`assets/repo-templates.json` —— 从 [aEboli/GPT-Image2-Studio](https://github.com/aEboli/GPT-Image2-Studio)
导出的 520 条 YouMind Prompt Kit 模板，来源标注为 **CC BY 4.0**。

该文件**刻意不打进发布包**，原因有两条：

1. 它是第三方作品，CC BY 4.0 要求保留署名（每条模板的 `source` 字段），
   把它随 MIT 代码一起分发会让接收方承担额外的署名义务；
2. 插件代码从不读取它（`host.js` 只加载 `assets/builtin.json`），
   留着它只会让包体积翻倍而不增加任何功能。

## 想用那 520 条模板怎么办

自行从上游仓库导出，再通过界面或 `POST /api/image-studio.assets.import` 导入：

```bash
node scripts/export-repo-templates.mjs --repo "C:\\path\\to\\GPT-Image2-Studio"
```

导出结果里每条模板都带 `source`（repo / license / author / sourceId），
**导入后请保留署名**，符合 CC BY 4.0 的要求。

## 运行时依赖

本包不打包任何运行时依赖。以下由 DSH 宿主提供（已声明为 optional peerDependencies）：

- `react`
- `@deepseek-ai/dsh-tools`
- `@deepseek-ai/dsh-credentials`
- `@deepseek-ai/schemastery`
- `@deepseek-ai/dsh-client-ui-primitives`
