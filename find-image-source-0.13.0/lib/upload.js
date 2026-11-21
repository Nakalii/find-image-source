/**
 * 上传前的图片规范化。
 *
 * 起因：SauceNAO 的 JSON API 只认 JPEG / PNG，收到 WebP 会返回
 * `status: 4 —— The image must be a JPEG/PNG ...`。而很多站点现在直接发 WebP，
 * 页面内抓图走到 fetch 回退路径时就会拿到 `image/webp`。
 * （TraceMoe 无所谓，它服务端会自己转，所以同一张图它反而正常。）
 *
 * 所以这里做两件事：
 *   1. 判断需不需要转码（jpeg/png 直接用）；
 *   2. 需要就用 canvas 重新编码成 JPEG，并给出带正确扩展名的文件名。
 */

import { b64ToBlob } from './net.js';

const SAFE_MIME = /^image\/(jpeg|png)$/i;

/** SauceNAO 这类只认 JPEG/PNG 的引擎需要转码吗 */
export function needsReencode(mime) {
  return !SAFE_MIME.test(String(mime || ''));
}

/** 按 mime 给一个带正确扩展名的文件名 */
export function pickFilename(mime) {
  return /^image\/png$/i.test(String(mime || '')) ? 'image.png' : 'image.jpg';
}

async function loadBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* 有些环境不支持某些格式，退回 <img> */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

async function reencodeToJpeg(blob) {
  const bitmap = await loadBitmap(blob);
  const w0 = bitmap.width || bitmap.naturalWidth || 0;
  const h0 = bitmap.height || bitmap.naturalHeight || 0;
  if (!w0 || !h0) throw new Error('图片尺寸为 0');

  const MAX_EDGE = 1600;
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 不可用');

  ctx.drawImage(bitmap, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (!b64) throw new Error('重新编码失败');
  return b64ToBlob(b64, 'image/jpeg');
}

/**
 * 统一成「可以直接塞进 multipart 的图片文件」。
 * @returns {Promise<{blob: Blob, mime: string, filename: string, converted: boolean}>}
 */
export async function toUploadFile(image) {
  if (!image || !image.b64) throw new Error('没有图片字节');

  const original = b64ToBlob(image.b64, image.mime || 'image/jpeg');
  if (original.size === 0) throw new Error('图片字节是空的');

  const mime = original.type || image.mime || '';
  if (!needsReencode(mime)) {
    return { blob: original, mime: mime || 'image/jpeg', filename: pickFilename(mime), converted: false };
  }

  try {
    const jpeg = await reencodeToJpeg(original);
    if (jpeg && jpeg.size > 0) {
      return { blob: jpeg, mime: 'image/jpeg', filename: 'image.jpg', converted: true };
    }
  } catch {
    /* 转不了就原样传，让服务端把问题说清楚 */
  }

  return { blob: original, mime: mime || 'image/jpeg', filename: pickFilename(mime), converted: false };
}

/** 引擎侧最后一道闸：blob 的 MIME 不在白名单就不许发 */
export function assertUploadable(file) {
  const type = String((file && file.mime) || '').toLowerCase();
  if (!/^image\/(jpeg|png|gif)$/.test(type)) {
    const err = new Error('图片格式不支持：' + (type || '(空)'));
    err.code = 'format';
    err.kind = 'format';
    throw err;
  }
  if (!file.blob || file.blob.size === 0) {
    const err = new Error('图片字节是空的');
    err.code = 'format';
    err.kind = 'format';
    throw err;
  }
  return file;
}

/** 组装 multipart 里的那个「文件部件」：确保有 filename 和 Content-Type */
export function attachImagePart(form, field, file) {
  if (typeof File === 'function') {
    form.set(field, new File([file.blob], file.filename, { type: file.mime }), file.filename);
  } else {
    form.set(field, file.blob, file.filename);
  }
  return { name: file.filename, type: file.mime, size: file.blob.size };
}
