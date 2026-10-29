import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CONCURRENT_IMAGES, MAX_IMAGES_PER_BATCH, clampOption, describeState, mergeSaveInput, sanitizeBaseUrl } from '../lib/config.js'

const base = {
  revision: 3,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-1234',
  imageModel: 'gpt-image-2',
  protocol: 'responses',
  outputDir: 'D:\\images\\studio'
}

test('mergeSaveInput 保留 Windows 反斜杠路径', () => {
  const next = mergeSaveInput(base, { outputDir: 'D:\\images\\studio' })
  assert.equal(next.outputDir, 'D:\\images\\studio')
  assert.equal(next.revision, 4)
})

test('mergeSaveInput 去掉包裹引号与首尾空白', () => {
  assert.equal(mergeSaveInput(base, { outputDir: '  "D:\\a b\\c"  ' }).outputDir, 'D:\\a b\\c')
  assert.equal(mergeSaveInput(base, { outputDir: "'/tmp/out'" }).outputDir, '/tmp/out')
})

test('mergeSaveInput 允许清空输出目录', () => {
  assert.equal(mergeSaveInput(base, { outputDir: '' }).outputDir, '')
})

test('mergeSaveInput 拒绝过长路径', () => {
  assert.throws(() => mergeSaveInput(base, { outputDir: 'x'.repeat(2000) }), /过长/)
})

test('protocol 始终归一为 images', () => {
  assert.equal(mergeSaveInput(base, {}).protocol, 'images')
  assert.equal(describeState(base).protocol, 'images')
})

test('describeState 投影 outputDir 且不泄露 key', () => {
  const view = describeState(base)
  assert.equal(view.outputDir, 'D:\\images\\studio')
  assert.equal(JSON.stringify(view).includes('sk-test-1234'), false)
})

test('describeState 去掉 baseUrl 的 userinfo 与 query', () => {
  const view = describeState({ ...base, baseUrl: 'https://user:p%40ssw0rd@api.example.com/v1?token=abc&x=1' })
  assert.equal(view.baseUrl, 'https://api.example.com/v1')
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('p%40ssw0rd'), false)
  assert.equal(serialized.includes('token=abc'), false)
})

test('并发/默认张数：非法值回落、越界钳制、留空走默认', () => {
  assert.equal(mergeSaveInput(base, { maxConcurrentImages: 99 }).maxConcurrentImages, MAX_CONCURRENT_IMAGES)
  assert.equal(mergeSaveInput(base, { maxConcurrentImages: 0 }).maxConcurrentImages, 1)
  assert.equal(mergeSaveInput(base, { maxConcurrentImages: 5 }).maxConcurrentImages, 5)
  assert.equal(mergeSaveInput(base, { maxConcurrentImages: 'x' }).maxConcurrentImages, 3, '非法值回落到默认 3')
  assert.equal(mergeSaveInput(base, {}).maxConcurrentImages, 3, '未传时用默认')
  assert.equal(mergeSaveInput(base, { defaultImageCount: 7 }).defaultImageCount, MAX_IMAGES_PER_BATCH)
  assert.equal(mergeSaveInput(base, { defaultImageCount: 2 }).defaultImageCount, 2)
  assert.equal(mergeSaveInput(base, { defaultImageCount: null }).defaultImageCount, 1)
})

test('describeState 暴露并发/张数给界面（不含 key）', () => {
  const view = describeState({ ...base, maxConcurrentImages: 6, defaultImageCount: 3 })
  assert.equal(view.maxConcurrentImages, 6)
  assert.equal(view.defaultImageCount, 3)
  assert.equal(JSON.stringify(view).includes('sk-test-1234'), false)
  const fallback = describeState(base)
  assert.equal(fallback.maxConcurrentImages, 3, '老记录没有该字段时给默认')
})

test('clampOption 处理小数/字符串/非有限值', () => {
  assert.equal(clampOption(2.7, 1, 1, 8), 2)
  assert.equal(clampOption('4', 1, 1, 8), 4)
  assert.equal(clampOption(undefined, 5, 1, 8), 5)
  assert.equal(clampOption(NaN, 5, 1, 8), 5)
  assert.equal(clampOption(Infinity, 5, 1, 8), 5, '非有限值一律回落，不做钳到上限的意外行为')
  assert.equal(clampOption(1e9, 5, 1, 8), 8, '巨大的有限值钳到上限')
  assert.equal(clampOption(-1e9, 5, 1, 8), 1, '极小值钳到下限')
})

test('sanitizeBaseUrl 保留 scheme/host/port/path，去掉尾斜杠', () => {
  assert.equal(sanitizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1')
  assert.equal(sanitizeBaseUrl('http://127.0.0.1:8787/v1/'), 'http://127.0.0.1:8787/v1')
  assert.equal(sanitizeBaseUrl('https://user:pass@api.example.com'), 'https://api.example.com')
  assert.equal(sanitizeBaseUrl('https://api.example.com/v1?key=secret'), 'https://api.example.com/v1')
  assert.equal(sanitizeBaseUrl(''), '')
  assert.equal(sanitizeBaseUrl(undefined), '')
  assert.equal(sanitizeBaseUrl('not a url'), '')
})
