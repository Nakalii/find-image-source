/**
 * TraceMoe 适配器（动画截图溯源）
 * 文档：https://soruly.github.io/trace.moe-api/
 * POST /search?anilistInfo  （multipart 字段名 image）
 * GET  /search?anilistInfo&url=<图片地址>
 * 免费额度约 1000 次/天，超了返回 429。
 */

import { EngineError, fetchWithTimeout, b64ToBlob, extFromMime, normalizeScore, safeHttpUrl, fmtTime } from '../lib/net.js';

export const meta = {
  id: 'tracemoe',
  name: 'TraceMoe',
  home: 'https://trace.moe/',
  hint: '动画截图：第几集、第几秒',
  needsKey: false
};

const ENDPOINT = 'https://api.trace.moe/search';

export async function search({ image, srcUrl }, { signal } = {}) {
  const params = new URLSearchParams({ anilistInfo: '', cutBorders: '' });

  let url;
  let init;
  if (image && image.b64) {
    const blob = b64ToBlob(image.b64, image.mime);
    const form = new FormData();
    form.set('image', blob, 'image.' + extFromMime(image.mime));
    url = ENDPOINT + '?' + params.toString();
    init = { method: 'POST', body: form };
  } else if (srcUrl) {
    url = ENDPOINT + '?' + params.toString() + '&url=' + encodeURIComponent(srcUrl);
    init = { method: 'GET' };
  } else {
    throw new EngineError('没有可用的图片或链接', { code: 'no-input' });
  }

  let resp;
  try {
    resp = await fetchWithTimeout(url, init, { signal, timeoutMs: 30000 });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    throw new EngineError('请求 TraceMoe 失败：' + (e.message || e), { code: 'network', retryable: true });
  }

  if (resp.status === 429) {
    throw new EngineError('TraceMoe 今日额度已用完（免费约 1000 次/天）', { code: 'rate-limit', retryable: true });
  }
  if (resp.status === 413) {
    throw new EngineError('图片太大，TraceMoe 拒收', { code: 'too-large' });
  }
  if (!resp.ok) {
    throw new EngineError('TraceMoe 返回 HTTP ' + resp.status, { code: 'http-' + resp.status, retryable: resp.status >= 500 });
  }

  const data = await resp.json().catch(() => null);
  if (!data) throw new EngineError('TraceMoe 返回的不是合法 JSON', { code: 'bad-json' });
  if (data.error) throw new EngineError('TraceMoe：' + data.error, { code: 'api-error' });

  const raw = Array.isArray(data.result) ? data.result : [];
  const items = raw.slice(0, 5).map((r) => {
    const anilist = r.anilist || {};
    const titles = anilist.title || {};
    const title = titles.native || titles.romaji || titles.english || r.filename || '(未知作品)';
    const ep = r.episode != null && r.episode !== '' ? '第 ' + r.episode + ' 集' : (r.filename || '');
    const timeRange = Number.isFinite(r.from) && Number.isFinite(r.to)
      ? fmtTime(r.from) + '–' + fmtTime(r.to)
      : '';

    const links = [];
    const anilistUrl = anilist.id ? 'https://anilist.co/anime/' + anilist.id : null;
    if (anilistUrl) links.push({ label: 'AniList', url: anilistUrl });
    const preview = safeHttpUrl(r.video);
    if (preview) links.push({ label: '片段预览', url: preview });

    return {
      thumb: safeHttpUrl(r.image) || null,
      preview: safeHttpUrl(r.video) || null, // 无声 mp4 片段，面板里直接放
      title,
      sub: [ep, timeRange].filter(Boolean).join(' · '),
      similarity: normalizeScore(r.similarity),
      site: '动画',
      extra: anilist.isAdult ? '18+' : '',
      links
    };
  });

  return {
    items,
    note: [
      raw.length ? '共 ' + raw.length + ' 条匹配' : '没有匹配到动画',
      data.quota ? '剩余额度 ' + data.quota : '',
      data.limit ? '上限 ' + data.limit : ''
    ]
      .filter(Boolean)
      .join(' · ')
  };
}
