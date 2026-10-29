/**
 * 从 GPT-Image2-Studio 仓库导出提示词模板（YouMind Prompt Kit，CC BY 4.0）。
 *
 * 用法：
 *   node scripts/export-repo-templates.mjs --repo "C:\\path\\to\\GPT-Image2-Studio"
 *   node scripts/export-repo-templates.mjs --repo <path> --out assets/repo-templates.json
 *
 * 说明：
 *   - 上游是 ESM 数据文件，直接用动态 import 读取 `YOUMIND_PROFILE_ENTRIES`；
 *   - 只导出提示词相关字段（id/title/prompt/category/source/license/author），不带预览图；
 *   - 授权要求：CC BY 4.0，**必须保留署名**，所以每条都写 source + license + author。
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = true
    }
  }
  return args
}

const args = parseArgs(process.argv)
const repo = args.repo ? resolve(String(args.repo)) : null
const out = resolve(String(args.out || 'assets/repo-templates.json'))

if (!repo) {
  console.error('缺少 --repo <GPT-Image2-Studio 仓库路径>')
  process.exit(1)
}

const entriesUrl = pathToFileURL(resolve(repo, 'lib/youmind-profile-entries.mjs')).href
const taxonomyUrl = pathToFileURL(resolve(repo, 'lib/prompt-template-taxonomy.mjs')).href

const entriesModule = await import(entriesUrl)
const entries = entriesModule.YOUMIND_PROFILE_ENTRIES || []

let taxonomy = null
try {
  taxonomy = await import(taxonomyUrl)
} catch {
  taxonomy = null
}

const templates = []
for (const entry of entries) {
  const prompt = String(entry?.prompt || '').trim()
  if (!prompt) continue
  templates.push({
    id: String(entry.id || entry.sourceId || `repo-${templates.length + 1}`),
    name: String(entry.title || entry.name || '未命名模板'),
    category: [String(entry.category || '仓库导入')],
    body: prompt,
    variables: [],
    source: {
      repo: 'aEboli/GPT-Image2-Studio',
      license: String(entry.license || 'CC BY 4.0'),
      author: String(entry.author || entry.creator || '未署名'),
      sourceId: entry.sourceId ? String(entry.sourceId) : undefined
    }
  })
}

const payload = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: {
    repo: 'aEboli/GPT-Image2-Studio',
    license: 'CC BY 4.0',
    note: '导入后请保留每条模板的 source 字段（署名要求）。'
  },
  taxonomy: taxonomy?.PROMPT_TEMPLATE_LIBRARY
    ? {
        categories: taxonomy.PROMPT_TEMPLATE_LIBRARY.map((item) => ({
          id: item.id,
          name: item.name,
          children: (item.children || []).map((child) => ({ id: child.id, name: child.name }))
        }))
      }
    : undefined,
  templates
}

await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(`导出完成：${templates.length} 条模板 → ${out}`)
