import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_EDIT_IMAGES,
  buildEditsForm,
  buildImagesBody,
  buildResponsesBody,
  decodeImageDataUrl,
  extractImageFromSse,
  generate,
  normalizeBaseUrl,
  normalizeConfig
} from '../lib/provider.js'

test('normalizeBaseUrl 补 /v1 且去尾斜杠', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8787/v1'), 'http://127.0.0.1:8787/v1')
  assert.throws(() => normalizeBaseUrl(''))
})

test('normalizeConfig 默认值', () => {
  const config = normalizeConfig({ baseUrl: 'https://api.example.com' })
  assert.equal(config.protocol, 'images')
  assert.equal(config.imageModel, 'gpt-image-2')
  assert.equal(config.timeoutMs, 20 * 60 * 1000)
})

test('buildImagesBody 只放有效字段，n 被钳到 1..4', () => {
  const body = buildImagesBody({ model: 'gpt-image-2', prompt: '猫', size: '1024x1024', quality: 'high', n: 9 })
  assert.deepEqual(body, {
    model: 'gpt-image-2',
    prompt: '猫',
    n: 4,
    response_format: 'b64_json',
    size: '1024x1024',
    quality: 'high'
  })
  const minimal = buildImagesBody({ model: 'm', prompt: 'p', size: 'auto', quality: 'auto' })
  assert.deepEqual(minimal, { model: 'm', prompt: 'p', n: 1, response_format: 'b64_json' })
})

test('buildResponsesBody 对齐仓库请求体', () => {
  const body = buildResponsesBody({
    model: 'gpt-6-luna',
    prompt: '画一只猫',
    imageModel: 'gpt-image-2',
    size: '1536x1024',
    quality: 'high',
    outputFormat: 'png',
    background: 'opaque',
    reasoningEffort: 'xhigh',
    referenceImages: [{ dataUrl: 'data:image/png;base64,AAA' }]
  })
  assert.equal(body.model, 'gpt-6-luna')
  assert.equal(body.stream, true)
  assert.deepEqual(body.tool_choice, { type: 'image_generation' })
  assert.deepEqual(body.reasoning, { effort: 'xhigh' })
  assert.equal(body.input[0].content.length, 2)
  assert.equal(body.input[0].content[1].type, 'input_image')
  assert.deepEqual(body.tools[0], {
    type: 'image_generation',
    model: 'gpt-image-2',
    size: '1536x1024',
    quality: 'high',
    output_format: 'png',
    background: 'opaque'
  })
})

test('extractImageFromSse 从 output_item.done 里取 b64', () => {
  const b64 = 'A'.repeat(400)
  const sse = [
    'event: response.output_item.done',
    `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: b64 } })}`,
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  const images = extractImageFromSse(sse)
  assert.equal(images.length, 1)
  assert.equal(images[0].kind, 'base64')
  assert.equal(images[0].data.length, 400)
})

test('extractImageFromSse 跳过非 JSON 行', () => {
  assert.deepEqual(extractImageFromSse('data: not-json\n\n'), [])
  assert.deepEqual(extractImageFromSse(''), [])
})

test('generate 使用 images 协议并返回 base64', async () => {
  const b64 = 'B'.repeat(300)
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 })
  }
  try {
    const result = await generate({
      config: normalizeConfig({ baseUrl: 'https://api.example.com', apiKey: 'sk-test' }),
      prompt: '一只猫',
      size: '1024x1024',
      quality: 'high'
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.example.com/v1/images/generations')
    assert.equal(result.images[0].data, b64)
    assert.equal(result.meta.protocol, 'images')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generate 上游报错时抛出可读信息', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: '无效的 Key' } }), { status: 401 })
  try {
    await assert.rejects(
      generate({ config: normalizeConfig({ baseUrl: 'https://api.example.com' }), prompt: '猫' }),
      /上游返回 401：无效的 Key/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generate 提示词为空时直接报错', async () => {
  await assert.rejects(
    generate({ config: normalizeConfig({ baseUrl: 'https://api.example.com' }), prompt: '   ' }),
    /提示词不能为空/
  )
})

test('generate 用 url 交付时自行下载二进制', async () => {
  const originalFetch = globalThis.fetch
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    if (String(url).endsWith('/images/generations')) {
      return new Response(JSON.stringify({ data: [{ url: '/files/tmp/abc.png' }] }), { status: 200 })
    }
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  try {
    const result = await generate({
      config: normalizeConfig({ baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'sk-x' }),
      prompt: '一只猫'
    })
    assert.equal(calls[1], 'http://127.0.0.1:8787/files/tmp/abc.png')
    assert.equal(result.images[0].kind, 'binary')
    assert.equal(result.images[0].bytes.length, png.length)
    assert.equal(typeof result.meta.jsonMs, 'number')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---- images/edits（参考图） -------------------------------------------

function dataUrlOf(text, mime = 'image/png') {
  return `data:${mime};base64,${Buffer.from(text).toString('base64')}`
}

test('decodeImageDataUrl 解析 data URL，坏输入返回 null', () => {
  const decoded = decodeImageDataUrl(dataUrlOf('abc'))
  assert.equal(decoded.mime, 'image/png')
  assert.equal(decoded.bytes.toString(), 'abc')
  assert.equal(decodeImageDataUrl(''), null)
  assert.equal(decodeImageDataUrl('not-a-data-url'), null)
  assert.equal(decodeImageDataUrl('data:image/png;base64,@@@'), null)
  assert.equal(decodeImageDataUrl({ dataUrl: 'data:image/png;base64,===' }), null)
  assert.equal(decodeImageDataUrl({ dataUrl: dataUrlOf('x', 'image/jpeg') }).mime, 'image/jpeg')
})

test('buildEditsForm：image 字段重复、其余字段对齐，最多 8 张', () => {
  const references = Array.from({ length: MAX_EDIT_IMAGES + 4 }, (_, index) => ({ dataUrl: dataUrlOf(`img-${index}`) }))
  const { form, count } = buildEditsForm({
    model: 'gpt-image-2',
    prompt: '改成水彩',
    size: '1024x1024',
    quality: 'high',
    referenceImages: references
  })
  assert.equal(count, MAX_EDIT_IMAGES)
  assert.equal(form.getAll('image').length, MAX_EDIT_IMAGES)
  assert.equal(form.get('prompt'), '改成水彩')
  assert.equal(form.get('size'), '1024x1024')
  assert.equal(form.get('quality'), 'high')
  assert.equal(form.get('n'), '1')
  assert.equal(form.get('model'), 'gpt-image-2')
})

test('buildEditsForm：size/quality 为 auto 时不发送；参考图全坏时 count 为 0', () => {
  const ok = buildEditsForm({ prompt: 'p', size: 'auto', quality: 'auto', referenceImages: [{ dataUrl: dataUrlOf('a') }] })
  assert.equal(ok.form.has('size'), false)
  assert.equal(ok.form.has('quality'), false)
  const broken = buildEditsForm({ prompt: 'p', referenceImages: [{ dataUrl: 'data:image/png;base64,%%%' }, {}] })
  assert.equal(broken.count, 0)
  assert.equal(broken.form.getAll('image').length, 0)
})

test('有参考图时走 /images/edits 的 multipart', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const b64 = 'C'.repeat(300)
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 })
  }
  try {
    const result = await generate({
      config: normalizeConfig({ baseUrl: 'https://api.example.com', apiKey: 'sk-test' }),
      prompt: '把这张图变成水彩',
      size: '1024x1024',
      quality: 'high',
      referenceImages: [{ dataUrl: dataUrlOf('first-png') }, { dataUrl: dataUrlOf('second-jpeg', 'image/jpeg') }]
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.example.com/v1/images/edits')
    assert.equal(calls[0].init.method, 'POST')
    assert.ok(calls[0].init.body instanceof FormData, 'body 必须是 FormData')
    assert.ok(calls[0].init.signal, '调用方信号必须接到 fetch 上')
    assert.equal(calls[0].init.headers['content-type'], undefined, 'content-type 交给 fetch 带 boundary')
    assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')

    const form = calls[0].init.body
    const images = form.getAll('image')
    assert.equal(images.length, 2)
    assert.equal(images[0].type, 'image/png')
    assert.equal(images[1].type, 'image/jpeg')
    assert.equal(await images[0].text(), 'first-png')
    assert.equal(await images[1].text(), 'second-jpeg')
    assert.equal(form.get('prompt'), '把这张图变成水彩')
    assert.equal(form.get('size'), '1024x1024')
    assert.equal(form.get('quality'), 'high')
    assert.equal(form.get('n'), '1')

    assert.equal(result.images[0].data, b64)
    assert.equal(result.meta.mode, 'edits')
    assert.equal(result.meta.references, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('参考图都不可用时回退 generations', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ data: [{ b64_json: 'D'.repeat(300) }] }), { status: 200 })
  }
  try {
    const result = await generate({
      config: normalizeConfig({ baseUrl: 'https://api.example.com', apiKey: 'sk-test' }),
      prompt: '一只猫',
      referenceImages: [{ dataUrl: 'not-a-data-url' }, {}]
    })
    assert.equal(calls[0], 'https://api.example.com/v1/images/generations')
    assert.equal(result.meta.mode, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('取消会真的中止上游请求', async () => {
  const originalFetch = globalThis.fetch
  let sawSignal
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      sawSignal = init.signal
      init.signal.addEventListener('abort', () => reject(new Error('aborted by caller')), { once: true })
    })
  try {
    const controller = new AbortController()
    const pending = generate({
      config: normalizeConfig({ baseUrl: 'https://api.example.com' }),
      prompt: '一只猫',
      signal: controller.signal
    })
    controller.abort()
    await assert.rejects(pending, /aborted by caller/)
    assert.equal(sawSignal.aborted, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('edits 的 FormData 能被真实 Request 序列化成 multipart', async () => {
  const { form, count } = buildEditsForm({
    model: 'gpt-image-2',
    prompt: '改成水彩',
    referenceImages: [{ dataUrl: dataUrlOf('ref-one') }]
  })
  assert.equal(count, 1)
  const request = new Request('https://api.example.com/v1/images/edits', { method: 'POST', body: form })
  assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/)
  const text = await request.text()
  assert.match(text, /name="image"; filename="reference-1\.png"/)
  assert.match(text, /name="prompt"\r\n\r\n改成水彩/)
  assert.match(text, /name="n"\r\n\r\n1/)
  assert.match(text, /name="model"\r\n\r\ngpt-image-2/)
})
