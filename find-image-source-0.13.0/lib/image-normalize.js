/**
 * 统一的图片规范化：所有入口（右键 / 粘贴 / 拖入 / 视频帧 / 本地上传）都先过这里。
 *
 * 目标：不管图从哪来，上传给引擎的字节一定是「站点认得的格式」。
 *   - 用**魔数**判断真实格式，不信 file.type，也不看扩展名；
 *   - 只放行 JPEG / PNG / GIF，其它（WebP / AVIF / BMP / ICO / SVG…）一律 canvas 重绘成 PNG；
 *   - PNG 超过 ~2MB 改用 JPEG(0.92)，因为 SauceNAO 上限是 2MB；
 *   - 转完检查 size > 0，空字节直接报错，不发出去。
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 只认魔数；认不出来返回 '' */
export function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 4) return '';
  const b = bytes;

  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';

  // RIFF....WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }

  // ftyp + avif / mif1 / heic
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (brand.startsWith('avi') || brand.startsWith('mif')) return 'image/avif';
    if (brand.startsWith('hei') || brand.startsWith('hvc')) return 'image/heic';
    return 'image/avif';
  }

  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';

  // SVG：文本开头
  const head = String.fromCharCode.apply(null, Array.from(b.slice(0, 256))).trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.indexOf('<svg') >= 0)) return 'image/svg+xml';

  return '';
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + 'MB';
  if (v >= 1024) return Math.round(v / 1024) + 'KB';
  return v + 'B';
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

async function loadBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* 某些格式不支持，退回 <img> */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.addEventListener('load', () => {
      URL.revokeObjectURL(url);
      resolve(img);
    });
    img.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    });
    img.src = url;
  });
}

async function drawToBlob(blob, type, quality) {
  const bitmap = await loadBitmap(blob);
  const w0 = bitmap.width || bitmap.naturalWidth || 0;
  const h0 = bitmap.height || bitmap.naturalHeight || 0;
  if (!w0 || !h0) throw new Error('图片尺寸为 0');

  const MAX_EDGE = 1600;
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 不可用');
    ctx.drawImage(bitmap, 0, 0, w, h);
    try {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    } catch {
      /* 无所谓 */
    }
    return canvas.convertToBlob({ type, quality });
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 不可用');
  ctx.drawImage(bitmap, 0, 0, w, h);
  try {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  } catch {
    /* 无所谓 */
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('编码失败'))), type, quality);
  });
}

const PASSTHROUGH = new Set(['image/jpeg', 'image/png', 'image/gif']);

/** 硬保险：规范化之后只允许这三种，其它一律报错，绝不原样透传 */
function assertAllowed(mime) {
  if (!PASSTHROUGH.has(mime)) {
    throw new Error('规范化后仍不是受支持格式（' + mime + '），已阻止上传');
  }
}

/**
 * @param {{b64:string, mime?:string}} image
 * @param {{maxPngBytes?:number}} options
 * @returns {Promise<{b64:string, mime:string, bytes:number, detected:string, converted:boolean, note:string}>}
 */
export async function normalizeImage(image, { maxPngBytes = 2 * 1024 * 1024 } = {}) {
  if (!image || !image.b64) throw new Error('这张图取不到内容');

  const bytes = b64ToBytes(image.b64);
  if (!bytes.length) throw new Error('这张图取不到内容（字节为空）');

  const detected = sniffImageMime(bytes);
  // 魔数优先；认不出来时才退回声明的类型（避免把不认识的合法图直接判死）
  const effective = detected || (/^image\/(jpeg|png|gif)$/i.test(image.mime || '') ? image.mime : '');

  const result = await normalizeInner(image, bytes, detected, effective, maxPngBytes);
  assertAllowed(result.mime);
  return result;
}

async function normalizeInner(image, bytes, detected, effective, maxPngBytes) {
  if (PASSTHROUGH.has(effective)) {
    if (effective === 'image/png' && bytes.length > maxPngBytes) {
      const blob = new Blob([bytes], { type: 'image/png' });
      const jpeg = await drawToBlob(blob, 'image/jpeg', 0.92);
      const out = await blobToBytes(jpeg);
      if (!out.length) throw new Error('转码后字节为空');
      return {
        b64: bytesToB64(out),
        mime: 'image/jpeg',
        bytes: out.length,
        detected: detected || effective,
        converted: true,
        note: 'PNG 超过 2MB，已转 JPEG'
      };
    }
    return {
      b64: image.b64,
      mime: effective,
      bytes: bytes.length,
      detected: detected || effective,
      converted: false,
      note: ''
    };
  }

  // 其它格式：统一重绘成 PNG
  const srcType = detected || image.mime || 'application/octet-stream';
  const blob = new Blob([bytes], { type: srcType });

  let png;
  try {
    png = await drawToBlob(blob, 'image/png');
  } catch (e) {
    throw new Error('这张图取不到内容（无法解码：' + (e && e.message ? e.message : e) + '）');
  }

  const pngBytes = await blobToBytes(png);
  if (!pngBytes.length) throw new Error('这张图取不到内容（转码后为空）');

  if (pngBytes.length > maxPngBytes) {
    const jpeg = await drawToBlob(blob, 'image/jpeg', 0.92);
    const jpegBytes = await blobToBytes(jpeg);
    if (!jpegBytes.length) throw new Error('转码后字节为空');
    return {
      b64: bytesToB64(jpegBytes),
      mime: 'image/jpeg',
      bytes: jpegBytes.length,
      detected: srcType,
      converted: true,
      note: '已转 JPEG（PNG 超过 2MB）'
    };
  }

  return {
    b64: bytesToB64(pngBytes),
    mime: 'image/png',
    bytes: pngBytes.length,
    detected: srcType,
    converted: true,
    note: '已转 PNG（原格式 ' + srcType.replace('image/', '') + '）'
  };
}

/**
 * 缩到指定长边并转成 JPEG（Yandex 这类「按头像尺寸校验」的接口用）。
 * @returns {Promise<{b64:string, mime:string, bytes:number, width:number, height:number}>}
 */
export async function toScaledJpeg(image, maxEdge = 1024, quality = 0.85) {
  if (!image || !image.b64) throw new Error('这张图取不到内容');
  const bytes = b64ToBytes(image.b64);
  if (!bytes.length) throw new Error('这张图取不到内容（字节为空）');
  const srcType = sniffImageMime(bytes) || image.mime || 'application/octet-stream';
  const blob = new Blob([bytes], { type: srcType });

  const bitmap = await loadBitmap(blob);
  const w0 = bitmap.width || bitmap.naturalWidth || 0;
  const h0 = bitmap.height || bitmap.naturalHeight || 0;
  if (!w0 || !h0) throw new Error('图片尺寸为 0');

  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  let out;
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 不可用');
    ctx.drawImage(bitmap, 0, 0, w, h);
    out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 不可用');
    ctx.drawImage(bitmap, 0, 0, w, h);
    out = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('编码失败'))), 'image/jpeg', quality);
    });
  }
  try {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  } catch {
    /* 无所谓 */
  }

  const outBytes = new Uint8Array(await out.arrayBuffer());

  // 重新解码一次，回报"实际"尺寸：避免只报目标档位、真正发出去的却是旧图
  let actualW = w;
  let actualH = h;
  try {
    if (typeof createImageBitmap === 'function') {
      const check = await createImageBitmap(new Blob([outBytes], { type: 'image/jpeg' }));
      actualW = check.width || w;
      actualH = check.height || h;
      if (typeof check.close === 'function') check.close();
    }
  } catch {
    /* 校验失败就用目标尺寸 */
  }

  return {
    b64: bytesToB64(outBytes),
    mime: 'image/jpeg',
    bytes: outBytes.length,
    width: actualW,
    height: actualH
  };
}
