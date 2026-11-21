/**
 * Yandex：只走「开后台标签页、把图塞进网页版自己的上传入口」这一条路。
 * 现抓/写死的 images-apphost 接口是给头像用的，会回 400 Incorrect avatar size，
 * 已经砍掉——失败就如实报原因，不再静默降级。
 */

import { EngineError, safeHttpUrl } from '../lib/net.js';

export const meta = {
  id: 'yandex',
  name: 'Yandex',
  home: 'https://yandex.com/images/',
  hint: '照片 / 图库溯源（网页版上传，需要能访问）',
  needsKey: false,
  uploads: true,
  timeoutMs: 60000
};

export async function search({ image, srcUrl }, { signal } = {}) {
  if (!image || !image.b64) {
    const target = safeHttpUrl(srcUrl);
    if (!target) {
      throw new EngineError('没有读到图片字节，也没有公开链接，Yandex 这边没法搜', { code: 'no-input' });
    }
    return {
      items: [],
      actions: [
        {
          label: '在 Yandex 里搜',
          url: 'https://yandex.com/images/search?rpt=imageview&url=' + encodeURIComponent(target)
        }
      ],
      note: '没读到图片字节，只能把链接交给 Yandex'
    };
  }

  let r = null;
  try {
    r = await chrome.runtime.sendMessage({
      type: 'yandex.pasteUpload',
      payload: { b64: image.b64, mime: image.mime || 'image/png' }
    });
  } catch (e) {
    throw new EngineError('联系后台失败：' + (e && e.message ? e.message : e), {
      code: 'no-background',
      kind: 'request'
    });
  }

  if (signal && signal.aborted) return { items: [], note: '已取消' };

  if (r && r.ok && r.finalUrl) {
    return {
      items: [],
      actions: [{ label: '在 Yandex 看这次的结果', url: r.finalUrl }],
      openUrl: r.finalUrl,
      note:
        '已通过网页版上传' +
        (r.injected && r.injected.via ? '（' + r.injected.via + '）' : '') +
        ' · ' +
        String(r.finalUrl).replace(/^https?:\/\//, '').slice(0, 60)
    };
  }

  // 如实报失败，不再退回头像上传接口
  const reason = (r && r.reason) || '未知原因';
  const err = new EngineError('页内上传失败：' + reason, { code: 'paste-failed', kind: 'request' });
  err.detail = [
    'tabUrl: ' + ((r && r.tabUrl) || '(无)'),
    '注入结果: ' + JSON.stringify((r && r.injected) || null),
    '页面就绪: ' + ((r && r.ready) || '(未知)')
  ].join('\n');
  throw err;
}
