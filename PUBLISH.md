# 发布到 DSH 插件市场

## 一句话结论

**我能做的都做完了**，只剩"用你的账号登录"这一步——那需要你的密码 / 2FA，不是权限问题，是认证本身无法代持。

```
npm login            ← 只有这一步需要你
node publish.mjs     ← 剩下的全部自动完成
```

---

## 市场是怎么工作的（决定了"发布"到底指什么）

DSH 的市场**不是中心化商店**，是个索引聚合器。源码里：

```js
indexes: z.array(z.string().pattern(/^https?:\/\/\S+$/u)).default([])
```

默认空数组。数据流：

```
用户填索引 URL → 市场拉 index.json → 校验 format 1 → 显示卡片
    → 点安装 → 生成安装参数 → plugin_manager 走 pnpm → 重启生效
```

所以"发布"= **① 把包推到 npm 或 git ② 把索引放到 https ③ 把 URL 给别人**。
来源只支持 `npm` 和 `git` 两种，不能放本地路径或直接给 tgz。

---

## 已为你完成的部分

| 项 | 状态 |
|---|---|
| `package.json` 发布元数据 | ✅ 已配（name/version/license/publishConfig/engines） |
| `private:true` 移除 | ✅（不移除 npm 会拒绝） |
| `engines.dsh` 位置 | ✅ 已修正到**顶层**（宿主读这里） |
| 宿主兼容性 | ✅ 用 `evaluatePluginCompatibility()` 实测通过 |
| 包内容裁剪 | ✅ 61.6 KB，无测试、无第三方模板、无本机路径 |
| 市场索引 `market/index.json` | ✅ 已生成并通过宿主校验器 |
| 一键发布脚本 `publish.mjs` | ✅ 已写好并试跑（未登录时正确中止、不误发） |
| 安装后回归 | ✅ 148 项测试全过 |

---

## 方案 A：npm（推荐）

### 你只做这一步

```bash
npm login
```

### 然后跑脚本

```bash
cd dsh-image-studio-dist
node publish.mjs
```

脚本会依次：查登录 → 跑测试 → 打包 → 发布 → 等 5 秒验证 registry 版本。任一步失败就停下并说明原因，不会发半截。

> 为什么不用 PowerShell：Windows 上 `npm` 解析到 `npm.ps1` 包装器，未登录时它自己会因 `$LASTEXITCODE` 未定义而抛错；而且 PowerShell 5.1 读 UTF-8 中文易乱码。用 Node 没这些坑（插件本来就要求 Node ≥20）。

### 包名

`dsh-image-studio` 在 npm 上**当前未被占用**（查过返回 E404）。

- 想用这个名字 → 直接 publish 抢占
- 已被抢 → 改成作用域名 `@你的名字/dsh-image-studio`，需同步改：
  - `package.json` 的 `name`
  - `market/index.json` 里 `plugins[0].name`

---

## 方案 B：git（不占 npm 名字 / 私有仓库）

```bash
cd dsh-image-studio
git init && git add . && git commit -m "feat: image studio 0.2.0"
git remote add origin https://github.com/你的用户名/你的仓库.git
git push -u origin main
git rev-parse HEAD        # 记住这个 40 位 commit
```

然后拿 `market/index.git.example.json` 作模板，改三处：

```json
"source": {
  "type": "git",
  "url": "https://github.com/你的用户名/你的仓库",
  "commit": "<40位小写hex>",
  "path": "dsh-image-studio"
}
```

规则（校验器强制）：
- `url` 必须 https、至少两段路径、不能是 tarball、不能带 query/fragment
- `commit` 必须 **40 位小写十六进制**
- `path` 是仓库内子目录，插件在根目录就删掉该字段

---

## 第三步：索引放哪里

把 `market/index.json` 丢到任意 **https** 静态托管：

- GitHub Pages（`https://你.github.io/repo/index.json`）
- jsDelivr（直接用 GitHub 仓库拼接）
- Cloudflare Pages / Netlify / Vercel
- 自己的对象存储

**不能**用 http 本地地址（`127.0.0.1` 只对本机有效），不能带 query 或 `#`。

然后对方在 DSH：**设置 → 插件市场 → 索引地址** 填这个 URL。

---

## 索引字段速查

| 字段 | 说明 |
|---|---|
| `format: 1` | 固定值 |
| `title` | 索引标题，**必须含 `en`** |
| `metadata.categories/labels/sortKeys` | 先声明，插件内才能引用 |
| `plugins[].name` | 必须与 `package.json` 的 name 一致 |
| `plugins[].icon` | `data:` 内联（解码后 ≤32KiB）或 https 相对路径 |
| `versions[].publishTimestamp` | Unix **秒**，整数 |
| `versions[].engines.dsh` | 可选，声明兼容范围 |

---

## 我踩过并已修正的坑

**1. `engines.dsh` 必须在顶层**
宿主判断走的是 `fields.engines`，放 `dsh.engines` 不生效。

**2. 版本号是 `0.2.x`，不是 `0.11+`**
- Desktop 外壳 = `0.12.1`
- **dsh 运行时 = `0.2.1-rc.2`**（兼容性判定用这个）

所以 `>=0.11.0` 永远不满足（0.11 > 0.2）。正确的是 `>=0.2.0`。

**3. 语言 id 必须全小写**
`"zh-CN"` 会被拒：`must be a keyed by a lowercase language id`。要写 `"zh-cn"`。

**4. PowerShell 的 `$LASTEXITCODE` 会被管道污染**
`node --test | Select-String ...` 之后 `$LASTEXITCODE` 是 Select-String 的，测试失败也检测不到。

---

## 发新版流程

1. `package.json` 改 `version`（如 0.2.1）
2. `node publish.mjs`
3. `market/index.json` 的 `versions` 数组**最前面加一条**（旧版留着便于回退）
4. 重新上传索引

市场按版本倒序展示，用户会看到"有更新"。

---

## 当前产物

| 文件 | 大小 |
|---|---|
| `dsh-image-studio-0.2.0.tgz` | 61.6 KB |
| `market/index.json` | 2.5 KB |
| `market/index.git.example.json` | 2.7 KB |
| `publish.mjs` | 5.2 KB |
| `INSTALL.md` | 3.4 KB |
| `PUBLISH.md` | 本文件 |

sha256: `57375574ddbde69d4d6b33203c2c060a7aac20873628e075a7ca612f80c13cd1`

测试：148 项全过 ｜ 宿主兼容性：✅
