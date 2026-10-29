import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAssetLibrary } from '../lib/assets.js'
import { createHandlers, readJsonBody, toErrorBody } from '../lib/handlers.js'
import { describeState } from '../lib/config.js'

const builtin = JSON.parse(await readFile(new URL('../assets/builtin.json', import.meta.url), 'utf8'))

function memoryStore() {
  const data = new Map()
  return {
    async read(key) {
      return data.get(key)
    },
    async write(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)))
    }
  }
}

function fakeSettings(overrides = {}) {
  const state = {
    revision: 1,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-1234',
    imageModel: 'gpt-image-2',
    promptModel: 'gpt-6-luna',
    protocol: 'responses',
    timeoutMs: 1000,
    ...overrides
  }
  return {
    async read() { return state },
    async describe() {
      return describeState(state)
    },
    async active() {
      return state
    },
    async save(input) {
      return describeState({ ...state, ...input, revision: state.revision + 1 })
    }
  }
}

function makeHandlers({ settings = fakeSettings(), generate, fetchImpl } = {}) {
  const assets = createAssetLibrary({ builtin, store: memoryStore() })
  return createHandlers({
    settings,
    assets,
    generate:
      generate ||
      (async ({ prompt }) => ({ images: [{ kind: 'base64', data: 'A'.repeat(400), mime: 'image/png' }], meta: { prompt } })),
    fetch: fetchImpl
  })
}

function post(path, body) {
  return new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })
}

test('settingsGet 不泄露 apiKey', async () => {
  const handlers = makeHandlers()
  const response = await handlers.settingsGet()
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.configured, true)
  assert.equal(payload.keyHint, 'sk-***1234')
  assert.equal(JSON.stringify(payload).includes('sk-test-1234'), false)
})

test('assetsGet 返回内置资产，支持检索', async () => {
  const handlers = makeHandlers()
  const all = await (await handlers.assetsGet(new Request('http://localhost/api/image-studio.assets'))).json()
  assert.equal(all.templates.length, 10)
  const found = await (
    await handlers.assetsGet(new Request('http://localhost/api/image-studio.assets?q=石榴'))
  ).json()
  assert.equal(found.templates.length, 1)
})

test('compose 用模板 + 变量 + 增强预设组装', async () => {
  const handlers = makeHandlers()
  const response = await handlers.compose(
    post('/api/image-studio.compose', {
      templateId: 'builtin-gu-zhuang',
      variables: { ratio: '3:4' },
      enhancerId: 'quality'
    })
  )
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.ok(payload.prompt.includes('画幅比例：3:4'))
  assert.ok(payload.prompt.includes('Quality only; original prompt and references take priority.'))
  assert.equal(payload.prompt.includes('{argument'), false, '变量必须被替换掉')
  assert.equal(payload.enhancer.id, 'quality')
})

test('compose 用字段集组装', async () => {
  const handlers = makeHandlers()
  const payload = await (
    await handlers.compose(
      post('/api/image-studio.compose', {
        fieldsetId: 'portrait-cn',
        fieldValues: { theme: '古风封面', makeup: '石榴妆' }
      })
    )
  ).json()
  assert.equal(payload.prompt, '主题风格：古风封面\n妆感目标：石榴妆')
})

test('compose 关掉增强时不拼', async () => {
  const handlers = makeHandlers()
  const payload = await (
    await handlers.compose(
      post('/api/image-studio.compose', {
        templateId: 'builtin-meishi',
        enhancerId: 'quality',
        enhance: false
      })
    )
  ).json()
  assert.equal(payload.prompt.includes('Quality only'), false)
})

test('compose 空结果返回 400', async () => {
  const handlers = makeHandlers()
  const response = await handlers.compose(post('/api/image-studio.compose', {}))
  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.code, 'EMPTY_PROMPT')
})

test('compose 未知模板返回 404', async () => {
  const handlers = makeHandlers()
  const response = await handlers.compose(post('/api/image-studio.compose', { templateId: 'nope' }))
  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, 'TEMPLATE_NOT_FOUND')
})

test('generate 直接给 prompt 时透传给 provider', async () => {
  let used
  const handlers = makeHandlers({
    generate: async (params) => {
      used = params
      return { images: [{ kind: 'base64', data: 'A'.repeat(400) }], meta: { protocol: 'responses' } }
    }
  })
  const response = await handlers.generate(
    post('/api/image-studio.generate', { prompt: '一只猫', ratio: '1:1', quality: 'high' })
  )
  assert.equal(response.status, 200)
  assert.equal(used.prompt, '一只猫\n\nAspect ratio: 1:1.')
  assert.equal(used.quality, 'high')
  const payload = await response.json()
  assert.equal(payload.images.length, 1)
})

test('generate 没给 prompt 时用 compose 组装', async () => {
  let used
  const handlers = makeHandlers({
    generate: async (params) => {
      used = params
      return { images: [{ kind: 'base64', data: 'A'.repeat(400) }], meta: {} }
    }
  })
  const response = await handlers.generate(
    post('/api/image-studio.generate', { templateId: 'builtin-meishi', enhancerId: 'quality' })
  )
  assert.equal(response.status, 200)
  assert.ok(used.prompt.includes('专业美食摄影'))
  assert.ok(used.prompt.includes('Quality only'))
})

test('generate 参考图超过 8 张时显式 400（edits 上限）', async () => {
  const handlers = makeHandlers()
  const response = await handlers.generate(
    post('/api/image-studio.generate', {
      prompt: 'cat',
      referenceImages: Array.from({ length: 9 }, (_, i) => ({ id: i }))
    })
  )
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'TOO_MANY_REFERENCES')
})

test('generate 正好 8 张参考图时全部透传', async () => {
  let used
  const handlers = makeHandlers({
    generate: async (params) => {
      used = params
      return { images: [{ kind: 'base64', data: 'A'.repeat(400) }], meta: {} }
    }
  })
  const response = await handlers.generate(
    post('/api/image-studio.generate', {
      prompt: 'cat',
      referenceImages: Array.from({ length: 8 }, (_, i) => ({ id: i }))
    })
  )
  assert.equal(response.status, 200)
  assert.equal(used.referenceImages.length, 8)
})

test('toErrorBody 把异常投影成状态码 + code', () => {
  const body = toErrorBody(new Error('boom'))
  assert.equal(body.status, 500)
  assert.equal(body.body.code, 'INTERNAL')
  const conflict = Object.assign(new Error('冲突'), { code: 'CONFLICT' })
  assert.equal(toErrorBody(conflict).status, 409)
})

test('models 用草稿 baseUrl/key 拉取并归一列表', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization })
    return new Response(JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'nano-banana-2' }, { id: 'gpt-image-2' }] }), { status: 200 })
  }
  const handlers = makeHandlers({ fetchImpl })
  const response = await handlers.models(
    post('/api/image-studio.models', { baseUrl: 'https://api.other.com', apiKey: 'sk-draft' })
  )
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.deepEqual(payload.models, ['gpt-image-2', 'nano-banana-2'])
  assert.equal(calls[0].url, 'https://api.other.com/v1/models')
  assert.equal(calls[0].auth, 'Bearer sk-draft')
})

test('models 支持 { models: [...] } 与字符串数组', async () => {
  const handlers = makeHandlers({
    fetchImpl: async () => new Response(JSON.stringify({ models: ['a', { id: 'b' }] }), { status: 200 })
  })
  const payload = await (await handlers.models(post('/api/image-studio.models', {}))).json()
  assert.deepEqual(payload.models, ['a', 'b'])
})

test('models 空列表与上游报错都返回可读错误', async () => {
  const empty = makeHandlers({ fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) })
  const emptyResponse = await empty.models(post('/api/image-studio.models', {}))
  assert.equal(emptyResponse.status, 502)
  assert.equal((await emptyResponse.json()).code, 'MODELS_EMPTY')

  const bad = makeHandlers({ fetchImpl: async () => new Response('nope', { status: 401 }) })
  const badResponse = await bad.models(post('/api/image-studio.models', {}))
  assert.equal(badResponse.status, 502)
  assert.match((await badResponse.json()).error, /401/)
})

test('models 连接失败给出 CONNECT_FAILED', async () => {
  const handlers = makeHandlers({
    fetchImpl: async () => { throw new Error('ECONNREFUSED') }
  })
  const response = await handlers.models(post('/api/image-studio.models', {}))
  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'CONNECT_FAILED')
})

test('generate 把取消传播到 provider（浏览器断开时上游真的中止）', async () => {
  let sawSignal
  const handlers = makeHandlers({
    generate: async (params) => {
      sawSignal = params.signal
      return { images: [{ kind: 'base64', data: 'A'.repeat(400) }], meta: {} }
    }
  })
  const controller = new AbortController()
  const response = await handlers.generate(
    new Request('http://localhost/api/image-studio.generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: '一只猫' }),
      signal: controller.signal
    })
  )
  assert.equal(response.status, 200)
  assert.ok(sawSignal, 'provider 必须拿到 AbortSignal')
  // 请求正常结束：宿主内部的桥接控制器已经摘掉 request.signal 监听（无泄漏），
  // 因此事后 abort 不会再改动这个已完成请求的 signal。
  controller.abort()
  assert.equal(sawSignal.aborted, false, '完成后不应残留 abort 监听')
})

test('readJsonBody 接受 1MB 以上的请求体（参考图 base64）', async () => {
  const dataUrl = `data:image/png;base64,${'A'.repeat(1_500_000)}`
  const parsed = await readJsonBody(post('/api/image-studio.generate', { prompt: '猫', referenceImages: [{ dataUrl }] }))
  assert.equal(parsed.referenceImages[0].dataUrl.length, dataUrl.length)
})

test('readJsonBody 仍拒绝非 JSON 与超大体积', async () => {
  const broken = new Request('http://localhost/api/image-studio.generate', { method: 'POST', body: '{not json' })
  await assert.rejects(readJsonBody(broken), /不是合法 JSON/)
  const tiny = new Request('http://localhost/api/image-studio.generate', {
    method: 'POST',
    body: JSON.stringify({ a: 'x'.repeat(2048) })
  })
  await assert.rejects(readJsonBody(tiny, 1024), /请求体过大/)
})

test('delete 删除输出目录里的图片', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'image-studio-del-'))
  try {
    const name = 'image-studio-2026-10-25T04-29-58-123Z-1.png'
    await writeFile(path.join(dir, name), 'png-bytes')
    const handlers = makeHandlers({ settings: fakeSettings({ outputDir: dir }) })
    const response = await handlers.deleteImage(post('/api/image-studio.delete', { name }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, deleted: true })
    await assert.rejects(stat(path.join(dir, name)), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('delete 不存在的图片返回 404', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'image-studio-del-'))
  try {
    const handlers = makeHandlers({ settings: fakeSettings({ outputDir: dir }) })
    const response = await handlers.deleteImage(
      post('/api/image-studio.delete', { name: 'image-studio-2026-10-25T04-29-58-123Z-9.png' })
    )
    assert.equal(response.status, 404)
    assert.equal((await response.json()).code, 'NOT_FOUND')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('delete 拒绝非法文件名与路径穿越，不删到目录外', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'image-studio-del-'))
  const outDir = path.join(root, 'out')
  try {
    await writeFile(path.join(root, 'image-studio-2026-10-25T04-29-58-123Z-1.png'), 'outside')
    await mkdir(outDir)
    const handlers = makeHandlers({ settings: fakeSettings({ outputDir: outDir }) })
    for (const name of [
      '../image-studio-2026-10-25T04-29-58-123Z-1.png',
      '..\\image-studio-2026-10-25T04-29-58-123Z-1.png',
      'sub/image-studio-x.png',
      'photo.png',
      'image-studio-x.exe',
      'image-studio-x.gif',
      'image-studio-x.png.exe'
    ]) {
      const response = await handlers.deleteImage(post('/api/image-studio.delete', { name }))
      assert.equal(response.status, 400, `应拒绝：${name}`)
      assert.equal((await response.json()).code, 'BAD_FILE')
    }
    // jpg/jpeg/webp 是网关可能交付的格式，带本插件前缀时属于合法产物名：
    // 不再当「非法文件名」拒绝，而是走「找不到 → 404」。
    for (const name of ['image-studio-x.jpg', 'image-studio-x.jpeg', 'image-studio-x.webp']) {
      const response = await handlers.deleteImage(post('/api/image-studio.delete', { name }))
      assert.equal(response.status, 404, `${name} 应被当作合法名字去找：${response.status}`)
      assert.equal((await response.json()).code, 'NOT_FOUND')
    }
    // 目录外的同名文件必须还在。
    assert.equal((await stat(path.join(root, 'image-studio-2026-10-25T04-29-58-123Z-1.png'))).isFile(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete 缺 name 或没设输出目录时报 400', async () => {
  const missing = await makeHandlers().deleteImage(post('/api/image-studio.delete', {}))
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).code, 'MISSING_FIELD')

  const noDir = await makeHandlers({ settings: fakeSettings({ outputDir: '' }) }).deleteImage(
    post('/api/image-studio.delete', { name: 'image-studio-a.png' })
  )
  assert.equal(noDir.status, 400)
  assert.equal((await noDir.json()).code, 'NO_DIR')
})

