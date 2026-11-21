/**
 * 注入到 ascii2d 页面的探针（content script）。
 *
 * 用途：只做「页内同源请求」这一件事，把结果原样回传，用来区分三种失败：
 *   1. 页内请求拿到 200 —— 路是通的，问题在别处；
 *   2. 页内请求拿到 403/503 + 挑战页 —— 站点在拦机器人；
 *   3. 页内请求抛 TypeError —— 请求根本没拿到响应（网络/被中断）。
 *
 * 解析不在这里做，保持"只发请求"。
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ascii2d.probe') return undefined;

  (async () => {
    const out = {
      origin: location.origin,
      href: location.href,
      title: document.title
    };

    try {
      const bin = atob(String(msg.b64 || ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

      // 和主链路一致：先 GET 首页拿会话 cookie + CSRF token，再 POST
      let token = '';
      try {
        const home = await fetch('/', { credentials: 'include', cache: 'no-store' });
        const homeHtml = await home.text();
        token = (homeHtml.match(/name="authenticity_token"[^>]*value="([^"]+)"/) || [])[1] || '';
      } catch {
        token = '';
      }
      out.token = token ? '有' : '无';

      const form = new FormData();
      form.set('utf8', '✓');
      if (token) form.set('authenticity_token', token);
      form.set('file', new Blob([bytes], { type: msg.mime || 'image/jpeg' }), 'image.jpg');

      const resp = await fetch('/search/file', {
        method: 'POST',
        body: form,
        credentials: 'include',
        redirect: 'follow'
      });

      const html = await resp.text().catch(() => '');
      out.ok = resp.ok;
      out.status = resp.status;
      out.finalUrl = resp.url || '';
      out.htmlLength = html.length;
      out.hasItems = /class="[^"]*item-box/.test(html);
      out.body = html.replace(/\s+/g, ' ').slice(0, 300);
    } catch (e) {
      out.ok = false;
      out.status = 0;
      out.error = String((e && e.name) || '') + ': ' + String((e && e.message) || e);
    }

    sendResponse(out);
  })();

  return true;
});
