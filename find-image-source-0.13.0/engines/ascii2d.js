/**
 * ascii2d 适配器（同人图 / 二创溯源）
 *
 * 为什么不能像另外两家一样直接 fetch：
 *   ascii2d 前面挂着 Cloudflare managed challenge，而且是在路由**之前**就拦，
 *   HTTP 层的 UA / Referer / CSRF 都过不去（实测响应头 Cf-Mitigated: challenge）。
 *   另外它没有官方 API，URL 搜索还要先从首页取 authenticity_token。
 *
 * 所以这里把活交给后台：后台开一个**后台标签页**打开 ascii2d（真实浏览器导航，
 * Cloudflare 按正常用户放行），再往那个页面里注入脚本，用同源 fetch 提交搜索并解析。
 * 完成后标签页自动关闭。侧边栏只负责收结果。
 */

import { EngineError, safeHttpUrl, TEXT_CHALLENGE } from '../lib/net.js';

export const meta = {
  id: 'ascii2d',
  name: 'ascii2d',
  home: 'https://ascii2d.net/',
  hint: '同人图 / 二创出处，走后台标签页，约 5–15 秒',
  needsKey: false,
  timeoutMs: 60000
};

export async function search({ image, srcUrl }, { signal } = {}) {
  const payload =
    image && image.b64
      ? { b64: image.b64, mime: image.mime || 'image/jpeg' }
      : { srcUrl };

  let res;
  try {
    res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'ascii2d.search', payload }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('后台通道超时（45 秒）')), 45000)
      )
    ]);
  } catch (e) {
    throw new EngineError('ascii2d 通道没走通：' + (e && e.message ? e.message : String(e)) + '，可点下面的链接手动搜', {
      code: 'channel-failed'
    });
  }

  if (signal && signal.aborted) return { items: [], note: '已取消' };

  if (!res) throw new EngineError('后台没有响应，重试一次', { code: 'no-response' });

  if (!res.ok) {
    const phase = String(res.phase || '');
    const raw = String(res.message || '');
    const status = Number(res.status) || 0;
    const detail = [
      res.waitMs !== undefined ? '等待 file input: ' + res.waitMs + 'ms' : '',
      res.filesSet !== undefined ? 'input.files: ' + res.filesSet : '',
      res.via ? '提交方式: ' + res.via + (res.sub && res.sub.buttonText ? '（' + res.sub.buttonText + '）' : '') : '',
      res.action ? 'form: ' + res.action + ' ' + (res.method || '') + (res.sub && res.sub.enctype ? ' ' + res.sub.enctype : '') : '',
      res.location ? '提交后 location: ' + res.location : '',
      res.hasBox !== undefined ? '结果条目: ' + (res.hasBox ? '有' : '无') : '',
      res.mode ? '模式: ' + res.mode + (res.action ? ' / action: ' + res.action : '') : '',
      res.bytesKind ? '上传字节: ' + res.bytesKind + ' (' + (res.bytesHead || '') + ') · ' + (res.bytesSize || 0) + 'B' : '',
      'phase=' + (phase || '(未标注)'),
      status ? 'HTTP ' + status : '',
      raw,
      res.isResultPage === false ? '最终地址（不是结果页）: ' + (res.href || '') : res.href ? '最终地址: ' + res.href : '',
      res.fields ? 'FormData keys: ' + [].concat(res.fields).join(',') : '',
      res.fileBytes !== undefined ? 'FormData file.size: ' + res.fileBytes : '',
      res.enctype ? 'enctype: ' + res.enctype + ' / method: ' + (res.method || '?') : '',
      res.fileType ? '文件部件: ' + res.fileType + ' / ' + (res.fileName || '(无文件名)') : '',
      res.snippet ? '页面关键词（首页样板话也可能命中，仅供参考）：' + res.snippet : '',
      res.tokenFrom ? 'token 来源: ' + res.tokenFrom : '',
      res.warmLog
        ? '预热: ' +
          res.warmLog.url +
          ' HTTP ' +
          res.warmLog.status +
          ' · 首页 ' +
          res.warmLog.htmlLen +
          'B · token ' +
          (res.warmLog.token ? '有（前 8 位 ' + res.warmLog.tokenHead + '）' : '无')
        : '',
      res.warmError ? '预热失败原因: ' + res.warmError : '',
      res.warmLog && res.warmLog.head ? '首页开头: ' + res.warmLog.head : '',
      res.warmLog ? 'cookie 前: ' + (res.warmLog.cookieBefore || '(空)') : '',
      res.warmLog ? 'cookie 后: ' + (res.warmLog.cookieAfter || '(空)') : '',
      res.warmLog && res.warmLog.httpOnly ? '（' + res.warmLog.httpOnly + '）' : '',
      res.forms && res.forms.length
        ? '首页表单: ' +
          res.forms
            .map((f) => (f.action || '(无 action)') + ' ' + (f.method || 'get') + ' [' + (f.inputs || []).join(',') + ']')
            .join(' | ')
        : '',
      res.probe
        ? '探针: ' +
          (res.probe.error
            ? res.probe.error
            : 'HTTP ' +
              res.probe.status +
              ' / 最终 ' +
              res.probe.finalUrl +
              ' / ' +
              res.probe.len +
              ' 字节' +
              (res.probe.redirected !== undefined ? ' / 重定向: ' + (res.probe.redirected ? '是' : '否') : '') +
              (res.probe.cookieNames ? ' / cookie: ' + res.probe.cookieNames.join(',') : '') +
              ' / 开头 ' +
              String(res.probe.head || '').slice(0, 120))
        : '',
      res.htmlLength !== undefined ? '页面长度 ' + res.htmlLength : '',
      res.body ? '正文开头：' + String(res.body).slice(0, 2000) : ''
    ]
      .filter(Boolean)
      .join('\n');

    // 页面正常、只是没匹配 —— 这不是错误，按「0 条结果」返回
    if (phase === 'empty') {
      return {
        items: [],
        mode: 'html',
        note: '没有匹配结果（页面正常，只是这个库里没找到）'
      };
    }

    let kind = 'request';
    let text = 'ascii2d 请求失败';

    if (phase === 'format') {
      const err = new EngineError('内部错误：规范化没生效（上传字节不是 PNG/JPEG/GIF），已阻止提交', {
        code: 'format',
        kind: 'format'
      });
      err.detail = detail;
      throw err;
    }

    if (phase === 'throttled') {
      const wait = Number(res.waitSeconds) || 0;
      const err = new EngineError('距上次搜索还需等 ' + wait + ' 秒（ascii2d 限制搜索间隔）', {
        code: 'throttled',
        kind: 'throttled'
      });
      err.detail = detail;
      throw err;
    }

    if (phase === 'challenge') {
      kind = 'challenge';
      text = TEXT_CHALLENGE;
    } else if (phase === 'blocked-by-interval') {
      kind = 'interval';
      text = '搜索太频繁：稍等一会儿再试';
    } else if (phase === 'submit') {
      kind = 'request';
      text = '请求失败：服务器没有处理这次上传（回到了首页）';
    } else if (phase === 'timeout') {
      kind = 'timeout';
      text = '超时：结果页 30 秒内没就绪';
    } else if (phase === 'http') {
      text = '请求失败：HTTP ' + status;
    } else if (phase === 'parse') {
      kind = 'parse';
      text = '被拦或改版：页面拿到了，但没有可解析的结果块';
    } else if (phase === 'nav') {
      text = '请求失败：没能打开 ascii2d 页面';
    } else {
      text = '请求失败：' + (raw || '没拿到响应');
    }

    const summary = [
      res.mode ? '模式 ' + res.mode : '',
      res.tokenFrom ? 'token ' + res.tokenFrom : '',
      res.warmLog
        ? '预热 ' + res.warmLog.url + ' HTTP ' + res.warmLog.status + ' · 首页 ' + res.warmLog.htmlLen + 'B · token ' + (res.warmLog.token ? '有(' + res.warmLog.tokenHead + ')' : '无')
        : res.warmError
          ? '预热 失败'
          : '',
      res.bytesKind ? '字节 ' + res.bytesKind + ' ' + (res.bytesSize || 0) + 'B' : ''
    ]
      .filter(Boolean)
      .join(' · ');
    const real = [
      res.waitMs !== undefined ? '等待 ' + res.waitMs + 'ms' : '',
      res.filesSet !== undefined ? 'files=' + res.filesSet : '',
      res.via ? '提交 ' + res.via : '',
      res.location ? '落到 ' + String(res.location).replace(/^https?:\/\//, '').slice(0, 40) : ''
    ]
      .filter(Boolean)
      .join(' · ');
    if (real) text = text + (summary ? '｜' : '｜') + real;
    if (summary) text = text.replace('｜' + summary + '｜' + real, '｜' + summary + ' · ' + real);

    const err = new EngineError(text, { code: res.code || 'ascii2d-failed', kind });
    err.detail = detail;
    const open = safeHttpUrl(res.openUrl);
    if (open) err.openUrl = open;
    throw err;
  }

  const items = (Array.isArray(res.items) ? res.items : []).map((it) => ({
    thumb: safeHttpUrl(it.thumb),
    title: it.title || '（无标题）',
    sub: it.sub || '',
    similarity: null,
    site: it.site || '',
    extra: it.extra || '',
    links: (Array.isArray(it.links) ? it.links : [])
      .map((l) => ({ label: l.label || '链接', url: safeHttpUrl(l.url) }))
      .filter((l) => l.url)
  }));

  return {
    items,
    openUrl: safeHttpUrl(res.openUrl) || meta.home,
    note: '按 ascii2d 排序，越靠前越像；它不给相似度数值。「色合い / 特徴」两套结果需在结果页里切换'
  };
}
