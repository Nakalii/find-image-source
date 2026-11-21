/**
 * SauceNAO **HTML** 结果页解析器（纯函数，可单测）。
 *
 * 为什么需要它：SauceNAO 的 JSON API（output_type=2）现在只对带 Key 的账号开放，
 * 匿名调用会返回 {"header":{"status":-1,"message":"The anonymous account type does not
 * permit API usage."}}。但**网页版匿名搜索是通的**（官网不登录就能搜），所以不带
 * output_type 拿回 HTML 就成了无 Key 时的替代路径。
 *
 * 结构（容错式，宁可少认几个类名也别抛）：
 *   <div class="result" id="result-0">
 *     <div class="resultimage"><a href="..."><img src="..."></a></div>
 *     <div class="resultcontent">
 *       <div class="resulttitle"><a href="...">标题</a> <strong>95.2% similarity</strong></div>
 *       <div class="resultcontentcolumn">Author: ... <a href="...">pixiv</a></div>
 *     </div>
 *   </div>
 */

const SAUCENAO_HOST = /(^|\.)saucenao\.com$/i;

const SITE_LABEL = [
  [/pixiv/i, 'pixiv'],
  [/twitter|x\.com/i, 'X'],
  [/danbooru/i, 'danbooru'],
  [/gelbooru/i, 'gelbooru'],
  [/yande\.re/i, 'yande.re'],
  [/sankaku/i, 'sankaku'],
  [/deviantart/i, 'deviantart'],
  [/artstation/i, 'artstation'],
  [/fanbox/i, 'fanbox'],
  [/fantia/i, 'fantia'],
  [/nijie/i, 'nijie'],
  [/anime-pictures/i, 'anime-pictures']
];

function siteLabel(host) {
  for (const [re, label] of SITE_LABEL) {
    if (re.test(host)) return label;
  }
  return host;
}

function safeHttpUrl(raw, base = 'https://saucenao.com/') {
  if (!raw) return null;
  try {
    const u = new URL(String(raw).trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * @param {Document} doc
 * @param {{limit?: number}} options
 */
export function parseSauceNaoHtml(doc, { limit = 8 } = {}) {
  const out = [];
  const seen = new Set();

  let blocks = Array.from(doc.querySelectorAll('.result'));
  if (!blocks.length) blocks = Array.from(doc.querySelectorAll('[id^="result-"]'));
  if (!blocks.length) return out;

  for (const block of blocks) {
    if (out.length >= limit) break;

    // 第一条通常是「你上传的图」的提示块，没有外链，会被下面过滤掉
    const links = [];
    const taken = new Set();
    for (const a of Array.from(block.querySelectorAll('a[href]'))) {
      const href = safeHttpUrl(a.getAttribute('href'));
      if (!href) continue;
      let host = '';
      try {
        host = new URL(href).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      if (!host || SAUCENAO_HOST.test(host)) continue; // 站内链接不算出处
      if (taken.has(href)) continue;
      taken.add(href);
      links.push({ url: href, host, label: siteLabel(host) });
    }
    if (!links.length) continue;

    const key = links[0].url;
    if (seen.has(key)) continue;
    seen.add(key);

    const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
    const simMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    const titleEl = block.querySelector('.resulttitle a') || block.querySelector('.resulttitle');
    let title = titleEl ? (titleEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
    title = title.replace(/\d{1,3}(?:\.\d+)?\s*%.*$/, '').trim();

    const infoEl = block.querySelector('.resultcontentcolumn');
    const info = infoEl ? (infoEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140) : '';

    const imgEl = block.querySelector('.resultimage img') || block.querySelector('img');
    const thumb = imgEl ? safeHttpUrl(imgEl.getAttribute('src')) : null;

    out.push({
      thumb: thumb && /^https?:/i.test(thumb) ? thumb : null,
      title: (title || links[0].label || '（无标题）').slice(0, 120),
      sub: info,
      similarity: simMatch ? Math.round(Number(simMatch[1])) : null,
      site: links[0].label,
      extra: '候補 #' + (out.length + 1),
      links: links.slice(0, 3).map((l) => ({ label: l.label, url: l.url }))
    });
  }

  return out;
}
