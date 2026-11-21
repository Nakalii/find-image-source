/**
 * Google 视觉搜索（走页面上下文上传）。
 *
 * 实测结论（2026-11）：
 *   - `POST https://www.google.com/searchbyimage/upload`（multipart: encoded_image + image_content）
 *     在 www.google.com 页面里同源发 → **200**，并 302 到带 `vsrid=` 的结果页；
 *   - `/v3/upload` 在 www 和 lens 两个域名下都是 404/403，不要再试；
 *   - 扩展侧直连会被当成可疑流量（unusual traffic 拦截页），所以走注入。
 *
 * 上传本身在 background（要开标签页 + chrome.scripting）；这里只负责把 HTML 解析成条目。
 */

import { EngineError, safeHttpUrl, TEXT_CHALLENGE, TEXT_NETWORK_BLOCKED } from '../lib/net.js';
import { extractGoogleMatches } from './google-parse.js';

export const meta = {
  id: 'google',
  name: 'Google Lens',
  home: 'https://lens.google.com/',
  hint: '真实照片 / 商品 / 网页配图（视觉搜索）',
  uploads: true,
  needsKey: false,
  timeoutMs: 45000
};

const LENS_BY_URL = 'https://lens.google.com/uploadbyurl?url=';

export async function search({ image, srcUrl }, { signal } = {}) {
  // 没有字节：只能把链接交给 Lens（公开图片才有效）
  if (!image || !image.b64) {
    const target = safeHttpUrl(srcUrl);
    if (!target) {
      throw new EngineError('没有读到图片字节，也没有公开链接，Lens 这边没法搜', { code: 'no-input' });
    }
    return {
      items: [],
      actions: [{ label: '在 Google Lens 里打开', url: LENS_BY_URL + encodeURIComponent(target) }],
      note: '没读到图片字节，只能把链接交给 Lens（登录可见 / 防盗链的图它抓不到）'
    };
  }

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'google.lensUpload',
      payload: { b64: image.b64, mime: image.mime || 'image/jpeg' }
    });
  } catch (e) {
    throw new EngineError('联系后台失败：' + (e && e.message ? e.message : e), {
      code: 'no-background',
      kind: 'request'
    });
  }

  if (signal && signal.aborted) return { items: [], note: '已取消' };
  if (!res) throw new EngineError('后台没有响应（Service Worker 可能已休眠）', { code: 'no-response', kind: 'request' });

  if (!res.ok) {
    const phase = String(res.phase || '');
    if (phase === 'challenge') {
      const err = new EngineError(TEXT_CHALLENGE, { code: 'challenge', kind: 'challenge' });
      err.detail = res.body || '';
      throw err;
    }
    if (phase === 'proxy') {
      const err = new EngineError(TEXT_NETWORK_BLOCKED, { code: 'network', kind: 'proxy', retryable: true });
      err.detail = res.message || '';
      throw err;
    }
    if (phase === 'http') {
      const err = new EngineError('请求失败：HTTP ' + res.status, { code: 'http-' + res.status, kind: 'request' });
      err.detail = res.body || '';
      const open = safeHttpUrl(res.finalUrl);
      if (open) err.openUrl = open;
      throw err;
    }
    const err = new EngineError('请求失败：' + (res.message || '未知原因'), { code: 'request', kind: 'request' });
    if (res.body) err.detail = res.body;
    throw err;
  }

  const finalUrl = safeHttpUrl(res.finalUrl);
  const html = String(res.html || '');

  let matches = [];
  try {
    matches = extractGoogleMatches(new DOMParser().parseFromString(html, 'text/html'), { limit: 8 });
  } catch {
    matches = [];
  }

  if (!matches.length) {
    return {
      items: [],
      actions: finalUrl ? [{ label: '在 Google 追这次搜索', url: finalUrl }] : [],
      openUrl: finalUrl || undefined,
      note: '结果页拿到了（' + (res.htmlLength || 0) + ' 字节），但没解析出来源，可能被改版'
    };
  }

  return {
    items: matches.map((m, i) => ({
      thumb: m.thumb || null,
      title: m.title || m.host,
      sub: m.host,
      similarity: null,
      site: m.host,
      extra: '视觉匹配 #' + (i + 1),
      links: [{ label: m.host, url: m.url }]
    })),
    openUrl: finalUrl || undefined,
    note: 'Google 视觉搜索（结果页 ' + (res.htmlLength || 0) + ' 字节；含 vsrid 的地址可分享）'
  };
}
