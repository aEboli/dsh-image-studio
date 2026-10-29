import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  datePathFor,
  extensionForMime,
  isImageName,
  isRelativeImagePath,
  newestFirst,
  mimeForImageName,
  outputDirPath,
  readJpegSize,
  readPngSize,
  readPngSizeFrom,
  readWebpSize,
  resolveOutputFile
} from '../lib/outputs.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 造一个只含头部的最小 PNG（签名 + IHDR 长度 + 'IHDR' + 宽高）。 */
function pngHeader(width, height) {
  const bytes = Buffer.alloc(24)
  PNG_SIGNATURE.copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

test('readPngSize 从 IHDR 读出宽高', () => {
  assert.deepEqual(readPngSize(pngHeader(1536, 1024)), { width: 1536, height: 1024 })
  assert.deepEqual(readPngSize(pngHeader(1, 1)), { width: 1, height: 1 })
})

test('readPngSize 对非 PNG / 截断 / 零尺寸返回 null', () => {
  assert.equal(readPngSize(null), null)
  assert.equal(readPngSize(Buffer.alloc(0)), null)
  assert.equal(readPngSize(Buffer.from('GIF89a................')), null)
  assert.equal(readPngSize(pngHeader(800, 600).subarray(0, 20)), null)
  assert.equal(readPngSize(pngHeader(0, 600)), null)
  const noIhdr = pngHeader(800, 600)
  noIhdr.write('IDAT', 12, 'latin1')
  assert.equal(readPngSize(noIhdr), null)
})

test('readPngSizeFrom 只读文件头就能拿到尺寸', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'image-studio-png-'))
  try {
    const good = path.join(dir, 'image-studio-a.png')
    await writeFile(good, pngHeader(1024, 768))
    assert.deepEqual(await readPngSizeFrom(good), { width: 1024, height: 768 })
    assert.equal(await readPngSizeFrom(path.join(dir, 'missing.png')), null)
    const text = path.join(dir, 'not-a-png.png')
    await writeFile(text, 'hello')
    assert.equal(await readPngSizeFrom(text), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('isImageName 只认本插件的文件名', () => {
  assert.equal(isImageName('image-studio-2026-10-25T04-29-58-123Z-1.png'), true)
  assert.equal(isImageName('image-studio-a.b_c-d.png'), true)
  // 网关偶尔回 JPEG/WebP：白名单内的扩展名都算合法产物。
  assert.equal(isImageName('image-studio-x.jpg'), true)
  assert.equal(isImageName('image-studio-x.jpeg'), true)
  assert.equal(isImageName('image-studio-x.webp'), true)
  assert.equal(isImageName('photo.png'), false)
  assert.equal(isImageName('image-studio-.png'), false)
  assert.equal(isImageName('../image-studio-x.png'), false)
  assert.equal(isImageName('image-studio-x/../evil.png'), false)
  assert.equal(isImageName('image-studio-x\\..\\evil.png'), false)
  assert.equal(isImageName(''), false)
  assert.equal(isImageName(undefined), false)
})

test('resolveOutputFile 收敛在输出目录内，穿越一律 null', () => {
  const root = path.resolve(tmpdir(), 'studio-out')
  const name = 'image-studio-2026-10-25T04-29-58-123Z-1.png'
  assert.equal(resolveOutputFile(root, name), path.join(root, name))

  for (const evil of [
    '../image-studio-a.png',
    '..\\image-studio-a.png',
    'image-studio-a/../../image-studio-b.png',
    '/etc/image-studio-a.png',
    'C:\\Windows\\image-studio-a.png',
    'image-studio-a.png.exe',
    '',
    null
  ]) {
    assert.equal(resolveOutputFile(root, evil), null, `应拒绝：${String(evil)}`)
  }
  assert.equal(resolveOutputFile('', name), null, '没有输出目录时不解析')
})

test('outputDirPath 支持相对路径与留空', () => {
  const absolute = path.resolve(tmpdir(), 'studio-abs')
  const cwd = path.resolve(tmpdir(), 'studio-cwd')
  assert.equal(outputDirPath(absolute, cwd), absolute)
  assert.equal(outputDirPath('out', cwd), path.resolve(cwd, 'out'))
  assert.equal(outputDirPath('   ', cwd), '')
  assert.equal(outputDirPath(undefined), '')
})

test('newestFirst 按文件名时间戳倒序并过滤非本插件产物', () => {
  const names = [
    'image-studio-2026-10-25T04-29-58-123Z-1.png',
    'image-studio-2026-10-25T04-29-58-123Z-2.png',
    'image-studio-2026-10-26T01-00-00-000Z-1.png',
    'notes.txt',
    'image-studio-broken.exe'
  ]
  assert.deepEqual(newestFirst(names), [
    'image-studio-2026-10-26T01-00-00-000Z-1.png',
    'image-studio-2026-10-25T04-29-58-123Z-2.png',
    'image-studio-2026-10-25T04-29-58-123Z-1.png'
  ])
  assert.deepEqual(newestFirst([]), [])
})

test('datePathFor 生成 yyyy/mm/dd', () => {
  assert.equal(datePathFor(new Date(2026, 9, 25)), '2026/10/25')
  assert.equal(datePathFor(new Date(2026, 0, 5)), '2026/01/05')
})

test('扩展名映射：mime 与文件名互转', () => {
  assert.equal(extensionForMime('image/jpeg'), 'jpg')
  assert.equal(extensionForMime('image/jpg'), 'jpg')
  assert.equal(extensionForMime('image/webp'), 'webp')
  assert.equal(extensionForMime('image/png'), 'png')
  assert.equal(extensionForMime(undefined), 'png', '缺 mime 一律当 png（界面只暴露 PNG）')
  assert.equal(extensionForMime('application/octet-stream'), 'png')
  assert.equal(mimeForImageName('a.jpg'), 'image/jpeg')
  assert.equal(mimeForImageName('a.jpeg'), 'image/jpeg')
  assert.equal(mimeForImageName('a.webp'), 'image/webp')
  assert.equal(mimeForImageName('a.png'), 'image/png')
  assert.equal(mimeForImageName(undefined), 'image/png')
})

test('readJpegSize 从 SOF 段读出宽高', () => {
  // FFD8 + FFDB(quant, len=2+0) + FFC0(SOF0, len=17) + 精度1 + 高600 + 宽800
  const bytes = Buffer.alloc(40)
  bytes[0] = 0xff; bytes[1] = 0xd8
  bytes[2] = 0xff; bytes[3] = 0xdb; bytes[4] = 0x00; bytes[5] = 0x02
  bytes[6] = 0xff; bytes[7] = 0xc0; bytes[8] = 0x00; bytes[9] = 0x11
  bytes[10] = 0x08
  bytes[11] = 0x02; bytes[12] = 0x58 // height 600
  bytes[13] = 0x03; bytes[14] = 0x20 // width 800
  assert.deepEqual(readJpegSize(bytes), { width: 800, height: 600 })
  assert.equal(readJpegSize(Buffer.from('PNG!')), null)
  assert.equal(readJpegSize(null), null)
  assert.equal(readJpegSize(Buffer.alloc(4)), null)
})

test('readWebpSize 支持 VP8/VP8L/VP8X 三种 chunk', () => {
  const riff = (chunk, tail) => {
    const bytes = Buffer.alloc(30)
    bytes.write('RIFF', 0, 'latin1'); bytes.write('WEBP', 8, 'latin1'); bytes.write(chunk, 12, 'latin1')
    for (const [at, value] of tail) bytes[at] = value
    return bytes
  }
  assert.deepEqual(readWebpSize(riff('VP8X', [[24, 9], [25, 0], [26, 0], [27, 19], [28, 0], [29, 0]])), { width: 10, height: 20 })
  assert.deepEqual(readWebpSize(riff('VP8 ', [[26, 0x40], [27, 0x01], [28, 0x2c], [29, 0x00]])), { width: 320, height: 44 })
  // 非 WEBP / 太短都返回 null
  assert.equal(readWebpSize(Buffer.alloc(10)), null)
  assert.equal(readWebpSize(Buffer.alloc(30)), null)
})

test('isRelativeImagePath 允许 yyyy/mm/dd/文件名，挡住穿越', () => {
  assert.equal(isRelativeImagePath('2026/10/25/image-studio-a.png'), true)
  assert.equal(isRelativeImagePath('image-studio-a.png'), true)
  assert.equal(isRelativeImagePath('2026/10/image-studio-a.png'), true)
  assert.equal(isRelativeImagePath('../2026/10/25/image-studio-a.png'), false)
  assert.equal(isRelativeImagePath('2026/10/25/../../x.png'), false)
  assert.equal(isRelativeImagePath('2026/10/25/other.png'), false)
  assert.equal(isRelativeImagePath('2026/10/25/image-studio-a.png/x'), false)
  assert.equal(isRelativeImagePath('2026/10/25/26/image-studio-a.png'), false)
})

test('resolveOutputFile 支持日期子目录，穿越仍返回 null', () => {
  const dir = path.join(tmpdir(), 'dsh-is-out')
  const nested = resolveOutputFile(dir, '2026/10/25/image-studio-a.png')
  assert.equal(nested, path.join(dir, '2026', '10', '25', 'image-studio-a.png'))
  assert.equal(resolveOutputFile(dir, '2026/10/25/../../escape.png'), null)
  assert.equal(resolveOutputFile(dir, '/etc/passwd.png'), null)
})

test('newestFirst 支持日期子目录并按文件名里的时间戳倒序', () => {
  const list = [
    '2026/10/24/image-studio-2026-10-24T04-00-00-000Z-1.png',
    '2026/10/25/image-studio-2026-10-25T04-00-00-000Z-1.png',
    '2026/10/25/other.png',
    'image-studio-2026-10-23T04-00-00-000Z-1.png'
  ]
  assert.deepEqual(newestFirst(list), [
    '2026/10/25/image-studio-2026-10-25T04-00-00-000Z-1.png',
    '2026/10/24/image-studio-2026-10-24T04-00-00-000Z-1.png',
    'image-studio-2026-10-23T04-00-00-000Z-1.png'
  ])
})
