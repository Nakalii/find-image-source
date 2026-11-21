/**
 * 从 Google 返回的搜索结果页里抽「视觉匹配」的来源站点。
 *
 * 为什么单独成文件：Google 的页面结构随时改，这里只是一层保守的启发式提取，
 * 哪天失效了只需要改这一个函数，而且能被单测覆盖（tools/test-google-parse.mjs）。
 *
 * 抽法（按可信度排序）：
 *   1. 页面里的 <a>，包括 Google 包装过的 /url?q=<真实地址>
 *   2. <script> 里 Lens 的内嵌数据（AF_initDataCallback 之类的 JSON 串）
 * 全部过滤掉 Google 自家域名，去重，限条数。
 */

const BANNED_HOST = /(^|\.)(google\.[a-z.]+|googleusercontent\.com|googleapis\.com|gstatic\.com|ggpht\.com|schema\.org|w3\.org|g\.co|goo\.gl)$/i;

const ASSET_EXT = /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)(?:\?|#|$)/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function unwrapGoogleRedirect(href) {
  // /url?q=https%3A%2F%2Fexample.com%2Fa&sa=U...
  if (!href) return href;
  const m = href.match(/^\/url\?(?:.*&)?(?:q|url)=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href;
}

function acceptable(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  const host = hostOf(url);
  if (!host) return false;
  if (BANNED_HOST.test(host)) return false;
  if (ASSET_EXT.test(url)) return false;
  // Google 自己的搜索/偏好页偶尔会以绝对地址出现
  if (/\/search\?|accounts\.|policies\.|\/preferences|\/setprefs|\/sorry\//i.test(url)) return false;
  return true;
}

/**
 * @param {Document} doc 已解析的结果页
 * @param {{limit?: number}} options
 * @returns {{url: string, title: string, host: string}[]}
 */
export function extractGoogleMatches(doc, { limit = 6 } = {}) {
  const out = [];
  const seen = new Set();

  const push = (rawUrl, title, thumb) => {
    if (!rawUrl || seen.size >= limit * 6) return;
    let url = String(rawUrl).trim();
    // JSON 串里常见 https:\/\/x\/
    url = url.replace(/\\\//g, '/').replace(/^"+|"+$/g, '');
    if (!acceptable(url)) return;
    const clean = url.split('#')[0];
    if (seen.has(clean)) return;
    seen.add(clean);
    const label = (title || '').replace(/\s+/g, ' ').trim();
    out.push({ url: clean, title: label.slice(0, 120), host: hostOf(clean), thumb: thumb || null });
  };

  // 0) Google 的图片跳转器：/imgres?imgurl=<源图>&imgrefurl=<出处页面>
  //    imgrefurl 才是「出处页面」，优先用它
  function decodeImgres(href) {
    try {
      const u = new URL(href, 'https://www.google.com/');
      if (!/\/imgres$/.test(u.pathname)) return null;
      return {
        imgurl: u.searchParams.get('imgurl') || '',
        imgrefurl: u.searchParams.get('imgrefurl') || ''
      };
    } catch {
      return null;
    }
  }

  // 1) 可见链接
  for (const a of doc.querySelectorAll('a[href]')) {
    if (out.length >= limit) break;
    const rawHref = a.getAttribute('href') || '';

    const imgres = decodeImgres(rawHref);
    if (imgres) {
      if (imgres.imgrefurl) push(imgres.imgrefurl, a.textContent || '', imgres.imgurl);
      continue;
    }

    const href = unwrapGoogleRedirect(rawHref);
    if (!/^https?:\/\//i.test(href)) continue;
    push(href, a.textContent || '');
  }

  // 2) 内嵌 JSON 数据（Lens 把匹配结果放在 script 里）
  if (out.length < limit) {
    // 注意 JSON 里的斜杠常常被转义成 \/，所以这里要容错
    const urlRe = /(https?:\\?\/\\?\/[^"'\s<>]{8,300})/g;
    for (const script of doc.querySelectorAll('script')) {
      const text = script.textContent || '';
      if (text.length < 50 || text.indexOf('http') === -1) continue;
      let m;
      while ((m = urlRe.exec(text)) !== null && out.length < limit) {
        push(m[1], '');
      }
      if (out.length >= limit) break;
    }
  }

  return out.slice(0, limit);
}

export { hostOf };
