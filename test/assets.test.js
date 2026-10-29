import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createAssetLibrary } from '../lib/assets.js'

const builtin = JSON.parse(await readFile(new URL('../assets/builtin.json', import.meta.url), 'utf8'))

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    async read(key) {
      return data.get(key)
    },
    async write(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)))
    }
  }
}

test('内置资产包结构完整', () => {
  assert.equal(builtin.schema, 1)
  assert.equal(builtin.templates.length, 10)
  assert.equal(builtin.fieldsets.length, 2)
  assert.equal(builtin.enhancers.length, 4)
  for (const item of builtin.templates) {
    assert.ok(item.id && item.name && item.body, `模板字段缺失：${item.id}`)
  }
  for (const set of builtin.fieldsets) {
    assert.ok(set.id && set.name && Array.isArray(set.fields))
    for (const field of set.fields) assert.ok(field.key && field.label)
  }
})

test('内置模板的人像字段与截图一致', () => {
  const portrait = builtin.fieldsets.find((item) => item.id === 'portrait-cn')
  const labels = portrait.fields.map((field) => field.label)
  for (const expected of ['妆感目标', '五官方向', '发型与发饰方向', '服装方向', '场景方向', '镜头方向', '画幅比例', '创意自由度', '补充要求']) {
    assert.ok(labels.includes(expected), `缺少字段：${expected}`)
  }
})

test('增强预设第一条与上游原文一致', () => {
  const quality = builtin.enhancers.find((item) => item.id === 'quality')
  assert.ok(quality.text.startsWith('Quality only; original prompt and references take priority.'))
  assert.ok(quality.text.includes('Size follows settings.'))
})

test('资产库合并内置与用户资产，同 id 以用户为准', async () => {
  const store = memoryStore()
  const lib = createAssetLibrary({ builtin, store })
  const before = await lib.list()
  assert.equal(before.templates.length, 10)

  await lib.importAssets({
    templates: [{ id: 'builtin-meishi', name: '覆盖后的美食', body: 'x', category: ['自定义'] }]
  })
  const after = await lib.list()
  assert.equal(after.templates.length, 10)
  assert.equal(after.templates.find((item) => item.id === 'builtin-meishi').name, '覆盖后的美食')
})

test('导入用户资产后可检索、可导出', async () => {
  const store = memoryStore()
  const lib = createAssetLibrary({ builtin, store })
  await lib.importAssets({
    templates: [{ id: 'user-1', name: '我的赛博朋克模板', body: 'cyberpunk street', category: ['自定义'] }],
    enhancers: [{ id: 'user-enhance', name: '冷色调', text: 'cool tones' }]
  })
  const found = await lib.search('赛博朋克')
  assert.equal(found.templates.length, 1)
  assert.equal(found.templates[0].id, 'user-1')

  const all = await lib.search('')
  assert.equal(all.templates.length, 11)
  assert.equal(all.enhancers.length, 5)

  const exported = await lib.exportUserAssets()
  assert.equal(exported.templates.length, 1)
  assert.equal(exported.enhancers.length, 1)
})

test('模板可按 id 取到并带变量声明', async () => {
  const lib = createAssetLibrary({ builtin, store: memoryStore() })
  const template = await lib.template('builtin-gu-zhuang')
  assert.ok(template)
  assert.ok(template.body.includes('{argument name="ratio" default="9:16"}'))
  assert.equal((await lib.fieldset('portrait-cn')).id, 'portrait-cn')
  assert.equal((await lib.enhancer('quality')).id, 'quality')
})

test('没有 store 时用户资产为空但不报错', async () => {
  const lib = createAssetLibrary({ builtin })
  const all = await lib.list()
  assert.equal(all.templates.length, 10)
  const result = await lib.importAssets({ templates: [{ id: 'x', name: 'x', body: 'x' }] })
  assert.equal(result.imported, 1)
})
