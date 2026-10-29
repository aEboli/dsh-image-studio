#!/usr/bin/env node
/**
 * 一键发布 dsh-plugin-image-studio 到 npm。
 *
 * 前提：先 npm login（这一步必须你本人做，脚本代替不了认证）。
 * 用法：node publish.mjs
 *
 * 之所以用 Node 而不是 PowerShell：
 *   - Windows 上 npm 会解析到 npm.ps1 包装器，未登录时它自己会因 $LASTEXITCODE 未定义而抛错；
 *   - PowerShell 5.1 读 UTF-8 文件的中文容易乱码；
 *   - 插件的 engines 本来就要求 Node >= 20，用 Node 没有额外前提。
 */
import { spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', 'dsh-plugin-image-studio')

/** Windows 上要用 .cmd 版本，绕开 npm.ps1 包装器的 LASTEXITCODE 问题。 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(args, options = {}) {
  const result = spawnSync(NPM, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false
  })
  return {
    ok: result.status === 0,
    status: result.status,
    out: ((result.stdout ?? '') + (result.stderr ?? '')).trim()
  }
}

function step(label) {
  console.log(`\n[\x1b[36m•\x1b[0m] ${label}`)
}

function done(label) {
  console.log(`    \x1b[32m✓\x1b[0m ${label}`)
}

function abort(message) {
  console.error(`\n\x1b[31m✗ ${message}\x1b[0m\n`)
  process.exit(1)
}

// ── 0. 读包信息 ────────────────────────────────────────────────────────────────
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const { name, version } = pkg

if (pkg.private === true) abort('package.json 仍是 private:true，npm 会拒绝发布。先删掉该字段。')
if (!pkg.engines?.dsh) abort('package.json 缺少顶层 engines.dsh，宿主无法判定兼容性。')

// ── 1. 登录检查 ────────────────────────────────────────────────────────────────
step('检查 npm 登录状态')
const who = run(['whoami'], { capture: true })
if (!who.ok || !who.out) {
  abort('未登录 npm。先在你自己的终端执行：\n\n    npm login\n\n（登录需要你的密码 / 2FA，脚本无法代办。）')
}
done(`已登录：${who.out.split('\n').pop()}`)

// ── 2. 测试 ────────────────────────────────────────────────────────────────────
step('运行测试')
const test = spawnSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8' })
if (test.status !== 0) {
  console.error((test.stdout ?? '') + (test.stderr ?? ''))
  abort('测试未通过，已中止发布。')
}
const summary = (test.stdout ?? '').split('\n').filter((l) => /ℹ (tests|pass|fail)/.test(l)).join('  ·  ')
done(summary || '测试通过')

// ── 3. 打包 ────────────────────────────────────────────────────────────────────
step('打包')
const stale = join(here, `${name}-${version}.tgz`)
await rm(stale, { force: true })
const pack = run(['pack', '--pack-destination', here], { capture: true })
if (!pack.ok) abort(`npm pack 失败：\n${pack.out}`)
done(pack.out.split('\n').pop())

// ── 4. 发布 ────────────────────────────────────────────────────────────────────
step(`发布 ${name}@${version}`)
const publish = run(['publish'])
if (!publish.ok) {
  abort(`npm publish 失败。常见原因：\n  · 版本号 ${version} 已存在（改用 npm version patch 升版本）\n  · 包名无权发布（改 package.json 的 name 加作用域）\n  · 未通过 2FA`)
}
done('已推送到 registry')

// ── 5. 验证 ────────────────────────────────────────────────────────────────────
step('验证线上版本')
await new Promise((r) => setTimeout(r, 5000))
const live = run(['view', name, 'version'], { capture: true })
if (!live.ok) {
  console.log('    \x1b[33m⚠\x1b[0m registry 尚未反映新版本，可能有 CDN 延迟，稍等再查。')
} else {
  done(`registry 现在提供 ${name}@${live.out.trim()}`)
}

console.log(`
\x1b[32m发布完成。\x1b[0m 市场索引里的 \`${name}@${version}\` 现在可安装了。

下一步（唯一剩下的一步）：
  把 ${join(here, 'market', 'index.json')}
  传到任意 https 静态托管，然后在 DSH 的 设置 → 插件市场 里填入该 URL。
`)
