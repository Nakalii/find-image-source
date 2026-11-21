/**
 * SauceNAO 适配器。
 *
 * 2026 年的现状（实测 + 公开资料）：
 *   - JSON API（output_type=2）**只对带 Key 的账号开放**，匿名调用返回
 *     {"header":{"status":-1,"message":"The anonymous account type does not permit API usage."}} + 403。
 *   - 但**网页版匿名搜索是通的**（官网不登录也能搜）。所以没 Key 时改抓 HTML，
 *     有 Key 时走 JSON（更干净、字段更全）。
 *
 * 另外：minsim 默认 80，会把裁剪过的本子图（常常只有 50~79%）在服务端直接吃掉，
 * 所以显式放开到 50，需要时用「只看 ≥80%」开关切回去。
 */

import {
  EngineError,
  fetchWithTimeout,
  normalizeScore,
  safeHttpUrl,
  isNetworkError,
  TEXT_NETWORK_BLOCKED
} from '../lib/net.js';
import { parseSauceNaoHtml } from './saucenao-html-parse.js';
import { toUploadFile, attachImagePart, assertUploadable } from '../lib/upload.js';

export const meta = {
  id: 'saucenao',
  name: 'SauceNAO',
  home: 'https://saucenao.com/',
  hint: '动漫 / 插画 / 本子出处',
  uploads: true,
  needsKey: false
};

const ENDPOINT = 'https://saucenao.com/search.php';
const KEY_PAGE = 'https://saucenao.com/user.php?page=search-api';

/** SauceNAO 的 Key 现在只影响「用 JSON 还是 HTML」，没 Key 也还能用 HTML */
function needKeyResult(reason) {
  return {
    items: [],
    needKey: true,
    actions: [{ label: '去 saucenao.com 拿 Key（免费账号就有）', url: KEY_PAGE }],
    note:
      (reason || 'SauceNAO 拒绝了这个请求') +
      '。匿名 HTML 模式也没走通；填 Key 后会切到 JSON API，更稳。注册要邮箱 + 验证码，Key 粘到侧边栏底部。'
  };
}

/** 从响应体里尽力取出 SauceNAO 的 header.message（403 时也是 JSON） */
function extractApiMessage(text) {
  try {
    const j = JSON.parse(text);
    return String((j && j.header && j.header.message) || '');
  } catch {
    return '';
  }
}

export async function search({ image, srcUrl }, { signal } = {}) {
  const { saucenaoApiKey = '', saucenaoHighOnly = false } = await chrome.storage.local.get([
    'saucenaoApiKey',
    'saucenaoHighOnly'
  ]);
  const apiKey = String(saucenaoApiKey || '').trim();
  const minSim = saucenaoHighOnly ? 80 : 50;

  const form = new FormData();
  form.set('db', '999'); // 999 = 全部索引库
  form.set('numres', '8');
  form.set('hide', '0');
  form.set('minsim', String(minSim));

  let partInfo = null;
  if (image && image.b64) {
    let upload;
    try {
      upload = assertUploadable(await toUploadFile(image));
    } catch (e) {
      throw new EngineError('这张图没法作为文件上传：' + (e.message || e), { code: 'bad-image' });
    }
    // 显式给 filename + Content-Type：SauceNAO 靠这两个判断「这是不是图片」
    partInfo = attachImagePart(form, 'file', upload);
  } else if (srcUrl) {
    form.set('url', srcUrl);
  } else {
    throw new EngineError('没有可用的图片或链接', { code: 'no-input' });
  }

  const useJson = Boolean(apiKey);
  if (useJson) {
    form.set('output_type', '2');
    form.set('api_key', apiKey);
  }

  let resp;
  try {
    resp = await fetchWithTimeout(
      ENDPOINT,
      {
        method: 'POST',
        body: form,
        // 网页版会带 Referer；扩展发不出完全一致的，尽力给上（被浏览器剥掉也无害）
        referrer: 'https://saucenao.com/'
      },
      { signal, timeoutMs: 45000 }
    );
  } catch (e) {
    if (signal && signal.aborted) throw e;
    const kind = isNetworkError(e) ? 'proxy' : '';
    const err = new EngineError(
      kind === 'proxy' ? TEXT_NETWORK_BLOCKED : '请求 SauceNAO 失败：' + (e.message || e),
      { code: 'network', retryable: true, kind }
    );
    err.detail = 'error.name=' + (e && e.name) + ' / message=' + (e && e.message);
    throw err;
  }

  if (resp.status === 429) {
    const text = await resp.text().catch(() => '');
    const err = new EngineError('被 SauceNAO 限流了（HTTP 429），等 30 秒再试', { code: 'rate-limit', retryable: true });
    err.detail = text.slice(0, 400) || '(响应体为空)';
    throw err;
  }

  return useJson ? handleJson(resp, minSim, partInfo) : handleHtml(resp);
}

/* ---------------- 有 Key：JSON API ---------------- */

function partDetail(partInfo) {
  if (!partInfo) return '';
  return `\nfile part: name=${partInfo.name} type=${partInfo.type} size=${partInfo.size}B`;
}

async function handleJson(resp, minSim, partInfo) {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const apiMsg = extractApiMessage(text);

    if (/anonymous|does not permit|invalid api ?key/i.test(apiMsg)) {
      return needKeyResult('SauceNAO 拒绝了这个 Key（' + apiMsg + '）');
    }

    const err = new EngineError('SauceNAO 返回 HTTP ' + resp.status + (apiMsg ? '：' + apiMsg : ''), {
      code: 'http-' + resp.status,
      retryable: resp.status >= 500
    });
    err.detail = (text.slice(0, 400) || '(响应体为空)') + partDetail(partInfo);
    throw err;
  }

  const rawText = await resp.text().catch(() => '');
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    const err = new EngineError('SauceNAO 返回的不是 JSON（HTTP ' + resp.status + '）', { code: 'bad-json' });
    err.detail = rawText.slice(0, 400) || '(响应体为空)';
    throw err;
  }

  const header = data.header || {};
  const status = typeof header.status === 'number' ? header.status : 0;

  if (status < 0) {
    const apiMsg = typeof header.message === 'string' ? header.message : '';
    if (/anonymous|does not permit|invalid api ?key/i.test(apiMsg)) {
      return needKeyResult('SauceNAO 说当前 Key 不被允许（' + apiMsg + '）');
    }
    const msg = status === -2 ? 'SauceNAO 搜索额度用完了' : 'SauceNAO 拒绝请求（status ' + status + '）';
    const err = new EngineError(msg + (apiMsg ? '：' + apiMsg : ''), { code: 'status-' + status, retryable: true });
    err.detail = 'header: ' + JSON.stringify(header).slice(0, 400) + partDetail(partInfo);
    throw err;
  }

  const raw = Array.isArray(data.results) ? data.results : [];
  const items = raw
    .map((r) => {
      const rHeader = r.header || {};
      const d = r.data || {};
      const links = [];
      const extUrls = Array.isArray(d.ext_urls) ? d.ext_urls : [];
      for (const u of extUrls.slice(0, 3)) {
        const safe = safeHttpUrl(u);
        if (safe) links.push({ label: shortLabel(safe), url: safe });
      }
      if (!links.length) {
        const source = safeHttpUrl(d.source);
        if (source) links.push({ label: shortLabel(source), url: source });
      }
      return {
        thumb: safeHttpUrl(rHeader.thumbnail) || null,
        title: d.title || d.jp_name || d.eng_name || d.material || '(无标题)',
        sub: [d.author_name || d.creator, d.member_name, d.part].filter(Boolean).join(' · '),
        similarity: normalizeScore(rHeader.similarity),
        site: (rHeader.index_name || '').split(' - ')[0] || '',
        extra: d.episode ? '第 ' + d.episode + ' 话' : '',
        links
      };
    })
    .filter((it) => (it.title && it.title !== '(无标题)') || it.links.length || it.thumb);

  // 额度：short_remaining 是「30 秒滑动窗口」的余量，long_remaining 是当天余量。
  // SauceNAO 这几个字段有时是字符串，统一转数字再显示，并把上限一起带上（1/4 比 1 好懂）。
  const shortLeft = Number(header.short_remaining);
  const shortLimit = Number(header.short_limit);
  const longLeft = Number(header.long_remaining);
  const longLimit = Number(header.long_limit);

  const quota = [];
  if (Number.isFinite(shortLeft)) {
    quota.push(
      '30 秒窗口 ' + shortLeft + (Number.isFinite(shortLimit) && shortLimit > 0 ? '/' + shortLimit : ' 次')
    );
  }
  if (Number.isFinite(longLeft)) {
    quota.push('今日 ' + longLeft + (Number.isFinite(longLimit) && longLimit > 0 ? '/' + longLimit : ' 次'));
  }

  return {
    items,
    mode: 'json',
    note: [
      'JSON 模式',
      raw.length ? '共 ' + raw.length + ' 条结果' : '没有匹配结果',
      '相似度门槛 ' + minSim + '%',
      quota.join(' · ')
    ]
      .filter(Boolean)
      .join(' · ')
  };
}

/* ---------------- 没 Key：匿名 HTML 模式 ---------------- */

async function handleHtml(resp) {
  const html = await resp.text().catch(() => '');

  if (!resp.ok) {
    // 匿名网页搜索被 Cloudflare 拦（或策略又改了）→ 引导去填 Key
    if (resp.status === 403 || resp.status === 503 || /just a moment|cf-chl|challenge-platform/i.test(html)) {
      return needKeyResult('匿名 HTML 模式被 SauceNAO 拦了（HTTP ' + resp.status + '）');
    }
    const err = new EngineError('SauceNAO 返回 HTTP ' + resp.status, { code: 'http-' + resp.status });
    err.detail = html.slice(0, 400);
    throw err;
  }

  let items = [];
  try {
    items = parseSauceNaoHtml(new DOMParser().parseFromString(html, 'text/html'), { limit: 8 });
  } catch {
    items = [];
  }

  if (!items.length) {
    return {
      items: [],
      actions: [{ label: '在 SauceNAO 网页版看结果', url: 'https://saucenao.com/' }],
      note: '匿名 HTML 模式没解析出结果（可能被拦或页面结构变了）。填个 Key 会切到 JSON API，更稳'
    };
  }

  return {
    items,
    mode: 'html',
    note: '匿名 HTML 模式（不消耗 Key，额度较低）；填 Key 后自动切到 JSON API'
  };
}

function shortLabel(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (/pixiv\.net$/.test(host)) return 'pixiv';
    if (/twitter\.com$|(^|\.)x\.com$/.test(host)) return 'X';
    if (/danbooru/.test(host)) return 'danbooru';
    if (/yande\.re/.test(host)) return 'yande.re';
    if (/sankaku/.test(host)) return 'sankaku';
    if (/deviantart/.test(host)) return 'deviantart';
    if (/artstation/.test(host)) return 'artstation';
    if (/anime-pictures/.test(host)) return 'anime-pictures';
    return host;
  } catch {
    return '链接';
  }
}
