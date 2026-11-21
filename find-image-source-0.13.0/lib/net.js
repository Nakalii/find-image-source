/** 公共网络/格式化工具（侧边栏模块共用） */

export class EngineError extends Error {
  constructor(message, { code = 'error', retryable = false, kind = '' } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = retryable;
    /** '' | 'proxy'（需要代理）| 'challenge'（人机校验） */
    this.kind = kind;
  }
}

/* ---------- 失败分类：把「被墙」「人机校验」「普通错误」分开 ---------- */

export const TEXT_NETWORK_BLOCKED = '网络不通或被拦截，需要代理';
export const TEXT_CHALLENGE = '被站点的人机校验拦住了：换个节点，或先在浏览器里打开该站点过一次校验';
export const TEXT_REJECTED = '请求到达了，但被站点拒绝（HTTP %s）';

/** 站点的反滥用页：unusual traffic / sorry / captcha 这类，其实是「被当成机器人」而不是网络问题 */
export function looksLikeAbusePage(body) {
  return /unusual traffic|sorry|detected unusual|captcha|not a robot|automated queries/i.test(String(body || '').slice(0, 4000));
}

/** fetch 层面的失败（连接被重置 / DNS / 代理 / 超时），基本都是网络路径问题 */
export function isNetworkError(e) {
  const text = String((e && e.name) || '') + ' ' + String((e && e.message) || e || '');
  return /TypeError|Failed to fetch|NetworkError|Load failed|fetch failed|timeout|aborted|net::ERR/i.test(text);
}

/** 站点的人机校验（Cloudflare 之类）：看响应头 Cf-Mitigated 或页面特征 */
export function looksLikeChallenge(status, headers, body) {
  let mitigated = '';
  try {
    mitigated = (headers && typeof headers.get === 'function' && headers.get('cf-mitigated')) || '';
  } catch {
    mitigated = '';
  }
  const sample = String(mitigated) + ' ' + String(body || '').slice(0, 3000);
  if (/cf-mitigated|challenge-platform|cf-browser-verification|cf-chl/i.test(sample)) return true;
  // 「Just a moment...」这类拦截页，通常配 403/503
  return (status === 403 || status === 503) && /just a moment|checking your browser|verify you are human/i.test(sample);
}

/** 已经被明确拒绝的直接访问（403/451 且有响应体） */
export function isHttpDenied(status) {
  return status === 403 || status === 451;
}

export function fetchWithTimeout(url, options = {}, { signal, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return fetch(url, { ...options, signal: ctrl.signal })
    .finally(() => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    });
}

/** base64 字符串 → Blob */
export function b64ToBlob(b64, mime = 'image/jpeg') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function extFromMime(mime) {
  if (!mime) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  return 'jpg';
}

/** 把 0~1 或 0~100 的相似度统一成 0~100 的整数，拿不到就返回 null */
export function normalizeScore(value) {
  if (value === null || value === undefined || value === '') return null;
  let n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 1.0001 && n > 0) n *= 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function fmtScore(score) {
  return score === null ? '' : score + '%';
}

/** 秒 → mm:ss */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

/** 只保留 http(s) 链接，挡掉 javascript: 之类 */
export function safeHttpUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const parsed = new URL(u, location.href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}
