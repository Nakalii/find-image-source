/**
 * ascii2d 搜索结果解析器（**经典脚本，不是 ES module**）
 *
 * 单独成文件的原因：它会被 chrome.scripting.executeScript({files}) 注入到页面里，
 * 注入的脚本不能带 import/export。挂到 globalThis 上给同一次注入流程调用。
 *
 * 结果页结构（2025-2026 实测，见 README）：
 *   div.row.item-box
 *     ├─ div.hash / small
 *     ├─ img                      缩略图，相对路径 /thumbnail/...
 *     └─ div.detail-box
 *          ├─ h6                  标题兜底
 *          ├─ small               站点名
 *          ├─ a[href]             第一条=标题链接，第二条=作者链接（都是原始出处）
 *          └─ .external           无链接时的纯文本
 *
 * 注意：第一块 item-box 是「你上传的那张图」，没有 detail-box / 没有出处链接，必须跳过。
 */
;(function () {
  function hostLabel(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (/pixiv\.net$/.test(host)) return 'pixiv';
      if (/twitter\.com$|(^|\.)x\.com$/.test(host)) return 'X';
      if (/danbooru/.test(host)) return 'danbooru';
      if (/fanbox/.test(host)) return 'fanbox';
      if (/fantia/.test(host)) return 'fantia';
      if (/nijie/.test(host)) return 'nijie';
      if (/misskey/.test(host)) return 'misskey';
      if (/nicovideo|niconico/.test(host)) return 'niconico';
      if (/yande\.re/.test(host)) return 'yande.re';
      if (/sankaku/.test(host)) return 'sankaku';
      return host;
    } catch {
      return '出处';
    }
  }

  function parseAscii2d(doc, base) {
    const out = [];
    const boxes = Array.from(doc.querySelectorAll('.item-box'));
    for (const box of boxes) {
      const detail = box.querySelector('.detail-box');
      if (!detail) continue; // 上传图本身没有 detail-box

      const anchors = Array.from(detail.querySelectorAll('a[href]'));
      const external = [];
      const seen = new Set();
      for (const a of anchors) {
        const raw = a.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(raw)) continue;
        let u;
        try {
          u = new URL(raw);
        } catch {
          continue;
        }
        if (u.hostname.replace(/^www\./, '') === 'ascii2d.net') continue;
        if (seen.has(u.href)) continue;
        seen.add(u.href);
        external.push({ url: u.href, text: (a.textContent || '').trim() });
      }
      if (!external.length) continue; // 没有出处链接的块不是命中项

      const img = box.querySelector('img');
      let thumb = null;
      if (img) {
        const src = img.getAttribute('src') || '';
        try {
          thumb = new URL(src, base).href;
        } catch {
          thumb = null;
        }
      }

      const h6 = detail.querySelector('h6');
      const title = (external[0].text || (h6 && h6.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const author = (external[1] && (external[1].text || '').replace(/\s+/g, ' ').trim()) || '';

      out.push({
        thumb: thumb && /^https?:/i.test(thumb) ? thumb : null,
        title: title || '（无标题）',
        sub: author,
        similarity: null, // ascii2d 不给数值，只有排序
        site: hostLabel(external[0].url),
        extra: '候选 #' + (out.length + 1),
        links: external.slice(0, 3).map((e) => ({ label: hostLabel(e.url), url: e.url }))
      });

      if (out.length >= 6) break;
    }
    return out;
  }

  globalThis.__parseAscii2d = parseAscii2d;
})();
