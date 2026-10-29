/**
 * 输出目录的纯逻辑：文件名校验、路径收敛、PNG 尺寸解析、画廊排序。
 *
 * 这里不碰 cordis / DSH，host.js 与 handlers.js 共用同一套规则，
 * 免得「落盘允许的格式」和「删除允许的格式」漂移。
 */
import { open } from 'node:fs/promises';
import path from 'node:path';

/**
 * 本插件写出的文件名格式；同时挡住任何分隔符与路径穿越。
 * 扩展名白名单化：网关偶尔会回 JPEG/WebP，硬写 .png 会得到「扩展名与内容不符」的文件。
 */
export const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
export const IMAGE_NAME_PATTERN = /^image-studio-[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/;

/** 日期目录段：2026 / 10 / 25 这种纯数字（2~4 位）。 */
export const DATE_SEGMENT_PATTERN = /^\d{2,4}$/;

/** 输出目录里允许的相对路径：可选的 yyyy/mm/dd/ + 本插件文件名。 */
export function isRelativeImagePath(value) {
  if (typeof value !== 'string' || !value) return false;
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return false;
  if (!parts.every((part) => part !== '.' && part !== '..')) return false;
  const name = parts.at(-1);
  if (!isImageName(name)) return false;
  return parts.slice(0, -1).every((part) => DATE_SEGMENT_PATTERN.test(part));
}

/** 生成日期目录：2026/10/25（按本地时区）。 */
export function datePathFor(date = new Date()) {
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

/** mime → 落盘扩展名；未知/缺失一律 png（界面本身只暴露 PNG 选项）。 */
export function extensionForMime(mime) {
  const value = String(mime || '').toLowerCase();
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg';
  if (value.includes('webp')) return 'webp';
  return 'png';
}

/** 落盘扩展名 → 回图时的 content-type。 */
export function mimeForImageName(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

/**
 * JPEG 尺寸：扫 SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15 段。
 * 非渐进式与渐进式都能取到；解析不出来返回 null（不抛异常，画廊照常显示）。
 */
export function readJpegSize(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xdd) { offset += 6; continue; }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return width && height ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** WebP 尺寸：支持 VP8（有损）/ VP8L（无损）/ VP8X（扩展）三种 chunk。 */
export function readWebpSize(bytes) {
  if (!bytes || bytes.length < 30) return null;
  const tag = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
  const chunk = tag(12);
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    const width = bytes[26] | (bytes[27] << 8);
    const height = bytes[28] | (bytes[29] << 8);
    return (width & 0xc000) === 0 ? { width: width & 0x3fff, height: height & 0x3fff } : null;
  }
  if (chunk === 'VP8L') {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** PNG 头：8 字节签名 + IHDR 长度(4) + 'IHDR'(4) + 宽(4) + 高(4)。 */
export const PNG_HEADER_BYTES = 24;

/** JPEG 前导段（含 EXIF 缩略图）通常远小于这个数，128KB 足够摸到 SOF。 */
export const JPEG_HEADER_BYTES = 128 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isImageName(name) {
  return typeof name === 'string' && IMAGE_NAME_PATTERN.test(name);
}

/** 把设置里的输出目录归一成绝对路径；留空返回空串。 */
export function outputDirPath(dir, cwd = process.cwd()) {
  const value = String(dir || '').trim();
  if (!value) return '';
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

/**
 * 相对路径（yyyy/mm/dd/name.png 或旧版根目录 name.png）→ 输出目录内的绝对路径。
 * 不合法的路径、或者 resolve 之后跑出目录的，一律返回 null（调用方按 400 处理）。
 */
export function resolveOutputFile(dir, relativePath, cwd = process.cwd()) {
  if (!isRelativeImagePath(relativePath)) return null;
  const base = outputDirPath(dir, cwd);
  if (!base) return null;
  const target = path.resolve(base, relativePath.replaceAll('\\', '/'));
  const relative = path.relative(base, target);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..')) return null;
  return target;
}

/**
 * 解析 PNG 的宽高（零依赖，只看 IHDR）。
 * 失败（不是 PNG / 头被截断 / 尺寸为 0）返回 null，不抛异常。
 */
export function readPngSize(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < PNG_HEADER_BYTES) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  // IHDR 必须是第一个块，宽度/高度就在它后面。
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (!width || !height) return null;
  return { width, height };
}

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

/** 只读文件前 24 字节拿尺寸，避免为了画廊把整张图读进内存。 */
export async function readImageSizeFrom(file, name = file) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  // JPEG/WebP 的 SOF/chunk 位置不固定，多读一点；PNG 只看头 24 字节。
  const wanted = ext === 'jpg' || ext === 'jpeg' || ext === 'webp' ? JPEG_HEADER_BYTES : PNG_HEADER_BYTES;
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
    if (bytesRead < PNG_HEADER_BYTES) return null;
    const view = buffer.subarray(0, bytesRead);
    return readPngSize(view) || readJpegSize(view) || readWebpSize(view);
  } catch {
    return null;
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

/** 旧名字保留（host/测试已在用），等价于按 PNG 读。 */
export function readPngSizeFrom(file) {
  return readImageSizeFrom(file, 'x.png');
}

/**
 * 画廊候选：只留本插件的产物，按文件名里的时间戳倒序。
 * 支持根目录文件名与 yyyy/mm/dd 子目录相对路径两种形态。
 */
export function newestFirst(paths = []) {
  const base = (value) => String(value).split(/[\\/]/).at(-1);
  return [...paths]
    .filter(isRelativeImagePath)
    .sort((a, b) => (base(a) < base(b) ? 1 : base(a) > base(b) ? -1 : 0));
}
