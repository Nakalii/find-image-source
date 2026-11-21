/**
 * 侧边栏主控：监听 storage.session 里的 pending 任务，把图片分别丢给各家引擎，
 * 每家一张卡片，独立更新（谁先回谁先显示，不互相等）。
 */

import * as saucenao from './engines/saucenao.js';
import * as tracemoe from './engines/tracemoe.js';
import * as ascii2d from './engines/ascii2d.js';
import * as google from './engines/google.js';
import * as yandex from './engines/yandex.js';
import { EngineError, b64ToBlob } from './lib/net.js';
import { normalizeImage, fmtBytes } from './lib/image-normalize.js';

const ENGINES = [saucenao, tracemoe, google, ascii2d, yandex];
const PENDING_KEY = 'pending';
const TASK_KEY = 'videoTask';
// 每个引擎的独立超时：悬挂的 promise 必须变成状态，不能一直转圈
// （测试可以用 globalThis.__engineTimeoutMs 把它调小）
const ENGINE_TIMEOUT_MS = Number(globalThis.__engineTimeoutMs) || 20000;
// 两家以上同时报「需要代理」就认定整条网络路径要走代理。
// （跳转类的那列不发请求，永远凑不满三，所以阈值取 2 比 3 更实用）
const PROXY_BANNER_MIN = 2;
const CAPTURE_WATCHDOG_MS = 12000;

const $ = (id) => document.getElementById(id);
const gridEl = $('grid');
const emptyEl = $('empty');
const previewEl = $('preview');
const pageTitleEl = $('page-title');

let lastRunId = null;
let currentPayload = null;
let controller = null;
let watchdog = null;
let cardUi = new Map();
const lastResults = new Map(); // engineId → { items, note } | { error }

/* ---------------- 小工具 ---------------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function scoreClass(score) {
  if (score === null || score === undefined) return 'low';
  if (score >= 85) return '';
  if (score >= 60) return 'mid';
  return 'low';
}

function showEmpty() {
  emptyEl.hidden = false;
  gridEl.replaceChildren();
  gridEl.hidden = true;
}

/* ---------------- 本地图片 / 粘贴 / 拖入 ---------------- */

const MAX_LOCAL_BYTES = 4 * 1024 * 1024;
const MAX_EDGE = 1600;

function openFilePicker() {
  const input = $('file-input');
  if (input) input.click();
}

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这个文件不是能解码的图片'));
    img.src = src;
  });
}

/** 本地图统一处理：小图直接用原字节，大图/超尺寸用 canvas 压到 1600px 内 */
async function prepareLocalImage(file) {
  if (!file) return { ok: false, message: '没有拿到文件' };
  if (!/^image\//.test(file.type || '')) {
    return { ok: false, message: '这不是图片文件（' + (file.type || '未知类型') + '）' };
  }

  let dataUrl;
  try {
    dataUrl = await readAsDataURL(file);
  } catch (e) {
    return { ok: false, message: e.message || '读取失败' };
  }

  const comma = dataUrl.indexOf(',');
  const rawB64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mime = file.type || 'image/png';
  const rawBytes = rawB64.length * 0.75;

  let img = null;
  try {
    img = await loadImage(dataUrl);
  } catch {
    img = null;
  }

  const w = img ? img.naturalWidth : 0;
  const h = img ? img.naturalHeight : 0;
  const needResize = !img || rawBytes > MAX_LOCAL_BYTES || Math.max(w, h) > 2000;

  if (!needResize) {
    return { ok: true, image: { ok: true, b64: rawB64, mime, width: w, height: h, via: 'local' } };
  }
  if (!img) {
    return rawBytes <= MAX_LOCAL_BYTES
      ? { ok: true, image: { ok: true, b64: rawB64, mime, width: null, height: null, via: 'local' } }
      : { ok: false, message: '图片超过 4MB 而且解不出来，先压一下再用' };
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, message: 'canvas 不可用，无法缩放' };
  ctx.drawImage(img, 0, 0, tw, th);
  const out = canvas.toDataURL('image/jpeg', 0.92);
  const b64 = out.slice(out.indexOf(',') + 1);

  if (!b64 || b64.length * 0.75 > MAX_LOCAL_BYTES) {
    return { ok: false, message: '压缩后还是超过 4MB，换张小一点的图' };
  }
  return { ok: true, image: { ok: true, b64, mime: 'image/jpeg', width: tw, height: th, via: 'local-resized' } };
}

async function handleLocalFile(file) {
  const prepared = await prepareLocalImage(file);
  if (!prepared.ok) {
    showNotice('本地图片没读进来：' + prepared.message);
    return;
  }
  const name = file && file.name ? file.name : '';
  const payload = {
    id: 'local-' + Date.now(),
    ts: Date.now(),
    kind: 'image',
    srcUrl: '',
    pageUrl: '',
    pageTitle: name ? '本地图片 · ' + name : '本地图片',
    phase: 'ready',
    image: prepared.image,
    note: ''
  };
  lastRunId = null;
  void run(payload);
}

/** 全都没结果时给的自救提示（顶栏只放一行短的，全文挂 title） */
const TIPS = '裁剪太狠会搜不到：尽量带完整一格（对白框、边框、背景），别只抠脸。';
const TIPS_FULL =
  '搜不到多半不是图不对，是裁剪太狠：截图尽量带完整一格（对白框、边框、背景都在），别只抠脸；' +
  '分辨率别太小；黑白漫画优先看 ascii2d 的「特徴」。';

function showTips() {
  const banner = cardUi.get('__banner__');
  if (!banner) return;
  banner.hidden = false;
  const prefix = (banner.textContent || '').trim();
  banner.textContent = prefix ? prefix + '　' + TIPS : TIPS;
  banner.title = TIPS_FULL;
}

/** 抓当前标签页里正在播的那一帧：交给后台（它会挑正在播/画幅最大的 video） */
async function captureCurrentVideo() {
  const btn = $('btn-video');
  if (btn) btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'video.capture' });
    if (!r || !r.ok) {
      showNotice('抓帧没开始：' + ((r && r.message) || '后台没有响应'));
    }
    // 成功时后台会写 storage.session，面板自己会收到变化开始搜索
  } catch (e) {
    showNotice('抓帧请求失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 把这次的结果压成一段可粘贴的摘要（做命中率对比时用） */
function buildSummaryText() {
  const version = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?';
  const p = currentPayload || {};
  const lines = [];

  lines.push('找图出处 v' + version + ' · ' + new Date().toLocaleString('zh-CN', { hour12: false }));
  lines.push('页面: ' + (p.pageTitle || p.pageUrl || '(未知)'));
  if (p.image && p.image.ok) {
    lines.push(
      '图片: ' +
        (p.image.via || '?') +
        ' ' +
        (p.image.width || '?') +
        '×' +
        (p.image.height || '?') +
        (p.image.at != null ? ' @' + p.image.at + 's' : '')
    );
  } else {
    lines.push('图片: (只有链接 / 没拿到字节)');
  }
  lines.push('SauceNAO 门槛: ' + ($('high-only') && $('high-only').checked ? '≥80%' : '50%'));

  for (const eng of ENGINES) {
    const r = lastResults.get(eng.meta.id);
    if (!r) continue;
    if (r.error) {
      lines.push(eng.meta.name + ': 失败 — ' + r.error + (r.detail ? ' | ' + r.detail : ''));
      continue;
    }
    const sims = r.items
      .map((i) => i.similarity)
      .filter((s) => s !== null && s !== undefined);
    lines.push(
      eng.meta.name +
        ': ' +
        r.items.length +
        ' 条' +
        (sims.length ? ' · ' + sims.join('%, ') + '%' : '') +
        (r.needKey ? ' · 需要 Key' : '') +
        (r.note ? ' · ' + r.note : '')
    );
    for (const it of r.items.slice(0, 3)) {
      const link = (it.links && it.links[0] && it.links[0].url) || '';
      lines.push('  - ' + (it.title || '(无标题)') + ' | ' + (it.site || '') + (link ? ' | ' + link : ''));
    }
  }

  return lines.join('\n');
}

async function copySummary() {
  const text = buildSummaryText();
  try {
    await navigator.clipboard.writeText(text);
    setCaptureStatus('已复制结果摘要', 'busy');
    setTimeout(() => {
      if (($('capture-status')?.textContent || '') === '已复制结果摘要') setCaptureStatus('');
    }, 2000);
  } catch {
    setCaptureStatus('复制失败（剪贴板被拒），可以手动截图', 'bad');
  }
}

/** 一条提示占满整栏（本地图读取失败等） */
function showNotice(text) {
  emptyEl.hidden = true;
  gridEl.hidden = false;
  cardUi = new Map();
  const banner = el('p', { class: 'hint banner' }, text);
  const btn = el('button', { type: 'button', text: '再选一张', onclick: openFilePicker });
  banner.append(' ', btn);
  gridEl.replaceChildren(banner);
}

/** 视频帧抓不到：把原因说清楚，并把本地图入口摆在眼前（不静默失败） */
function showVideoFailure(payload) {
  const banner = cardUi.get('__banner__');
  if (banner) {
    banner.hidden = false;
    banner.textContent = payload.note || '这一帧拿不到';
    const btn = el('button', {
      type: 'button',
      text: '选本地图片 / 粘贴截图',
      onclick: openFilePicker
    });
    banner.append(' ', btn);
  }

  for (const eng of ENGINES) {
    const ui = cardUi.get(eng.meta.id);
    if (!ui) continue;
    ui.items.replaceChildren();
    ui.err.hidden = true;
    ui.status.textContent = '跳过';
    ui.status.className = 'status';
    ui.note.textContent = '';
  }
}

/* ---------------- 初始化 ---------------- */

init();

async function init() {
  bindUi();
  const verEl = document.getElementById('ver');
  if (verEl) verEl.textContent = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?';
  await loadKey();

  chrome.storage.session.onChanged.addListener((changes) => {
    const taskChange = changes[TASK_KEY];
    if (taskChange && taskChange.newValue) applyTask(taskChange.newValue);

    const change = changes[PENDING_KEY];
    if (!change || !change.newValue) return;
    handlePayload(change.newValue);
  });

  let stored = null;
  let task = null;
  try {
    const got = await chrome.storage.session.get(PENDING_KEY);
    stored = got[PENDING_KEY];
    const t = await chrome.storage.session.get(TASK_KEY);
    task = t[TASK_KEY];
  } catch {
    stored = null;
  }

  // 刚发生过的抓帧任务（60 秒内）也要显示，避免面板比后台晚加载时什么都看不到
  if (task && Date.now() - (task.at || 0) < 60000) applyTask(task);

  if (stored) handlePayload(stored);
  else showEmpty();
}

/** 抓帧任务状态 → 顶栏状态行（「正在抓帧…」/「抓帧失败：原因」） */
function applyTask(task) {
  if (!task) return;
  if (task.state === 'capturing' || task.state === 'pending') {
    // 顶栏只放短句，页面标题挂 title，别把整行撑爆
    setCaptureStatus('正在抓帧…', 'busy', task.pageTitle ? '正在抓帧：' + task.pageTitle : '正在抓帧…');
  } else if (task.state === 'error') {
    setCaptureStatus('抓帧失败', 'bad', task.message || '抓帧失败');
  } else if (task.state === 'ok') {
    setCaptureStatus('');
  }
}

function setCaptureStatus(text, kind, titleText) {
  const el = $('capture-status');
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    el.removeAttribute('title');
    el.className = 'capture-status';
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.title = titleText || text;
  el.className = 'capture-status' + (kind ? ' ' + kind : '');
}

function bindUi() {
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-local').addEventListener('click', openFilePicker);

  $('file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) void handleLocalFile(file);
    e.target.value = ''; // 允许连续选同一个文件
  });

  // 剪贴板粘贴（Win+Shift+S 截图直接 Ctrl+V）
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
    const item = items.find((it) => it.type && it.type.indexOf('image/') === 0);
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (file) void handleLocalFile(file);
  });

  // 拖进来
  document.addEventListener('dragover', (e) => {
    const types = e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    if (types.includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
    if (!file) return;
    e.preventDefault();
    void handleLocalFile(file);
  });

  $('btn-retry').addEventListener('click', () => {
    if (currentPayload) {
      lastRunId = null;
      void run(currentPayload);
    }
  });

  $('btn-tab').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
  });

  $('key-save').addEventListener('click', () => void saveKey());
  $('key-clear').addEventListener('click', () => void clearKey());
  $('key-paste').addEventListener('click', () => void readKeyFromClipboard());
  $('key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void saveKey();
  });
  $('high-only').addEventListener('change', () => void saveHighOnly());
  $('btn-copy-summary').addEventListener('click', () => void copySummary());

  // 抓当前标签页里正在播的那一帧（B 站等播放器接管右键时的入口）
  $('btn-video').addEventListener('click', () => void captureCurrentVideo());
}

/* ---------------- 任务处理 ---------------- */

function handlePayload(payload) {
  if (!payload || !payload.id) return;
  if (payload.id === lastRunId) return;

  // 抓图还没结束：先把界面立起来（骨架屏），等下一轮 storage 变化
  if (payload.phase === 'capturing') {
    currentPayload = payload;
    renderHeader(payload);
    renderShell(payload);
    if (payload.kind === 'video') {
      setCaptureStatus(
        '正在抓帧…',
        'busy',
        payload.pageTitle ? '正在抓帧：' + payload.pageTitle : '正在抓帧…'
      );
    }
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (payload.id !== lastRunId) {
        run({ ...payload, image: null, note: '抓图超时，已退回「只传链接」模式' });
      }
    }, CAPTURE_WATCHDOG_MS);
    return;
  }

  void run(payload);
}

async function run(payload) {
  lastRunId = payload.id;
  currentPayload = payload;
  clearTimeout(watchdog);

  if (controller) controller.abort();
  controller = new AbortController();
  const signal = controller.signal;

  renderHeader(payload);
  renderShell(payload);

  // 统一规范化：所有入口（右键/粘贴/拖入/视频帧/本地图）都先过这一层，
  // 保证上传给引擎的一定是 JPEG / PNG / GIF
  const rawImage = payload.image && payload.image.ok ? payload.image : null;
  let image = null;
  if (payload.image && payload.image.ok) {
    try {
      const norm = await normalizeImage(payload.image);
      // 双保险：规范化层已经拦过，这里再挡一次，绝不让未知格式进入上传
      if (!['image/jpeg', 'image/png', 'image/gif'].includes(norm.mime)) {
        throw new Error('规范化后仍不是受支持格式（' + norm.mime + '）');
      }
      image = {
        ok: true,
        b64: norm.b64,
        mime: norm.mime,
        width: payload.image.width || null,
        height: payload.image.height || null,
        via: payload.image.via || '',
        bytes: norm.bytes,
        uploadLabel: norm.mime + ' · ' + fmtBytes(norm.bytes),
        converted: norm.converted,
        convertNote: norm.note || '',
        viaLabel:
          payload.image.via === 'capture'
            ? payload.image.captureNote || '截屏裁剪'
            : payload.image.via === 'background'
              ? '后台 fetch'
              : payload.image.via === 'canvas'
                ? '页面 canvas'
                : payload.image.via === 'fetch'
                  ? '页面 fetch'
                  : payload.image.via || '未知'
      };
    } catch (e) {
      setCaptureStatus('图片不可用', 'bad', e.message || '这张图取不到内容');
      showNotice('这张图取不到内容：' + (e && e.message ? e.message : e) + '。换一张，或者重新截一次');
      return;
    }
  }

  // 硬性约定：拿不到字节就停。绝不把裸 URL 交给引擎（那就绕过了规范化层）
  if (!image && payload.kind === 'image') {
    setCaptureStatus('抓图失败', 'bad', payload.note || '没取到图片字节');
    showNotice(
      '没取到图片字节，已停止搜索（不会把裸链接交给引擎）。\n' + (payload.note || '换一张图，或用「本地图」上传截图')
    );
    return;
  }

  // 视频帧没抓到：没有可搜的字节。硬拿视频地址去搜只会得到垃圾结果，这里直接说清楚原因。
  if (!image && payload.kind === 'video') {
    // 顶栏只写「抓帧失败」，原因放 title + 下面的提示条，避免一行被截成半句话
    setCaptureStatus('抓帧失败', 'bad', payload.note || '抓帧失败');
    showVideoFailure(payload);
    return;
  }

  setCaptureStatus('');

  const degraded = !image;
  if (degraded) {
    const banner = cardUi.get('__banner__');
    if (banner) {
      banner.hidden = false;
      banner.textContent = payload.note || '没能读到图片本体，已改用「只传链接」方式（防盗链站点容易失败）';
    }
  }

  const results = await Promise.all(ENGINES.map((eng) => runEngine(eng, payload, image, signal, rawImage)));
  // 本次搜索的图片字节用完即弃（只保留在内存里，不写任何存储）
  image = null;
  if (signal.aborted) return;

  const total = results.reduce((sum, r) => sum + (r && Number.isFinite(r.n) ? r.n : 0), 0);
  if (total === 0) showTips();

  // 多家同时「需要代理」= 网络路径问题，顶部给一行总览，别让每张卡片各自红一片
  const proxyNames = results.filter((r) => r && r.proxy).map((r) => r.name);
  if (proxyNames.length >= PROXY_BANNER_MIN) showProxyNotice(proxyNames);

  // 失败/被拒的列默认折叠，只在用户点开时展开
  const failed = results.filter((r) => r && r.failed);
  if (failed.length >= 2) collapseFailures(failed);
}

/** 把没出结果的列折叠成一行，点「展开」恢复卡片 */
function collapseFailures(list) {
  const line = cardUi.get('__fails__');
  if (!line) return;

  for (const r of list) {
    const ui = cardUi.get(r.id);
    if (ui && ui.card) ui.card.hidden = true;
  }

  line.hidden = false;
  const summary = list.map((r) => r.name + ' · ' + r.label).join(' / ');
  const span = el('span', { text: '已折叠 ' + list.length + ' 个没出结果的列：' + summary + '　' });
  const btn = el('button', {
    type: 'button',
    text: '展开',
    onclick: () => {
      for (const r of list) {
        const ui = cardUi.get(r.id);
        if (ui && ui.card) ui.card.hidden = false;
      }
      btn.remove();
      span.textContent = '已展开没出结果的列：' + list.map((r) => r.name).join('、');
    }
  });
  line.replaceChildren(span, btn);
}

/** 顶部总览：需要代理的列合并成一行 */
function showProxyNotice(names) {
  const notice = cardUi.get('__proxy__');
  if (!notice) return;
  notice.hidden = false;
  notice.textContent = '这几列需要代理才能用，当前是直连：' + names.join('、');
}

async function runEngine(eng, payload, image, signal, rawImage) {
  // ascii2d 实测连 avif 都收：直接送原始字节，避免"转 PNG 出错"这条变量
  const engineImage = eng.meta.id === 'ascii2d' && rawImage ? rawImage : image;
  const ui = cardUi.get(eng.meta.id);
  const name = eng.meta.name;
  if (!ui) return { n: 0, proxy: false, name };

  ui.status.textContent = '搜索中…';
  ui.status.className = 'status';
  ui.items.replaceChildren(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
  ui.err.hidden = true;
  ui.note.textContent = eng.meta.hint || '';

  const started = performance.now();

  // 每家一个独立 AbortController + 超时：引擎的 promise 可能永远不落地
  // （比如后台通道没回），超时也必须变成状态，不能一直「搜索中」
  const engineCtrl = new AbortController();
  const onParentAbort = () => engineCtrl.abort();
  signal.addEventListener('abort', onParentAbort, { once: true });
  const limit =
    Number(globalThis.__engineTimeoutMs) || Number(eng.meta.timeoutMs) || ENGINE_TIMEOUT_MS;
  let timer = null;

  try {
    const out = await Promise.race([
      eng.search({ image: engineImage, srcUrl: payload.srcUrl, pageUrl: payload.pageUrl }, { signal: engineCtrl.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          engineCtrl.abort();
          reject(
            new EngineError(name + ' 超过 ' + Math.round(limit / 1000) + ' 秒没响应（超时）', {
              code: 'timeout',
              kind: 'timeout',
              retryable: true
            })
          );
        }, limit);
      })
    ]);
    if (signal.aborted) return { n: 0, proxy: false, name };
    const ms = Math.round(performance.now() - started);

    const items = Array.isArray(out.items) ? out.items : [];
    const actions = (Array.isArray(out.actions) ? out.actions : []).filter(
      (a) => a && /^https?:/i.test(String(a.url || ''))
    );
    lastResults.set(eng.meta.id, { items, note: out.note || '', needKey: Boolean(out.needKey) });

    // 副标题按实际模式更新（比如 SauceNAO：有 Key 走 JSON，没 Key 走匿名 HTML）
    if (out.mode && ui.hintEl) {
      ui.hintEl.textContent =
        out.mode === 'json'
          ? 'JSON 模式 · 官方接口'
          : out.mode === 'html'
            ? '匿名 HTML 模式 · 不消耗 Key，额度较低'
            : eng.meta.hint || '';
    }

    const nodes = items.map(renderItem);
    if (!items.length && !actions.length) {
      nodes.push(el('li', { class: 'item' }, el('p', { class: 'item-sub', text: '没有匹配结果' })));
      ui.status.textContent = '0 条 · ' + ms + 'ms';
      ui.status.className = 'status warn';
    } else if (items.length) {
      ui.status.textContent = items.length + ' 条 · ' + ms + 'ms';
      ui.status.className = 'status done';
    } else {
      // 只有跳转按钮（Lens / Yandex）
      ui.status.textContent = '可跳转 · ' + ms + 'ms';
      ui.status.className = 'status done';
    }

    if (actions.length) {
      nodes.push(
        el(
          'li',
          { class: 'card-actions' },
          actions.map((a) =>
            el('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', text: a.label || '打开' })
          )
        )
      );
    }

    // SauceNAO 需要 Key：别显示成「失败」，给个一键跳到设置区的按钮
    if (out.needKey) {
      ui.status.textContent = '需要 Key';
      ui.status.className = 'status warn';
      nodes.push(
        el('li', { class: 'card-actions' }, [
          el('button', { type: 'button', text: '填写 API Key', onclick: focusKeyField })
        ])
      );
    }

    ui.items.replaceChildren(...nodes);
    ui.note.textContent =
      (out.note || '') +
      (eng.meta.uploads && image && image.uploadLabel
        ? ' · 上传 ' + image.uploadLabel + (image.viaLabel ? '（取图: ' + image.viaLabel + '）' : '')
        : '');
    if (out.openUrl) ui.footLink.href = out.openUrl;
    return { n: items.length, proxy: false, name };
  } catch (err) {
    if (signal.aborted) return { n: 0, proxy: false, name };
    ui.items.replaceChildren();
    ui.err.hidden = false;

    const message = err && err.message ? err.message : String(err);
    const kind = err && err.kind ? err.kind : '';
    lastResults.set(eng.meta.id, {
      error: message,
      kind,
      detail: err && err.detail ? String(err.detail).slice(0, 300) : ''
    });
    const parts = [el('span', { text: '✕ ' + message })];
    // 上传前实际发出的 MIME / 字节数：以后这类「格式不对」一眼可见
    if (eng.meta.uploads && image && image.uploadLabel) {
      parts.push(
        el('pre', {
          class: 'err-detail',
          text:
            '上传: ' +
            image.uploadLabel +
            (image.viaLabel ? ' · 取图: ' + image.viaLabel : '') +
            (image.convertNote ? '（' + image.convertNote + '）' : '')
        })
      );
    }
    // 原始响应片段：别把接口的报错吞成一句「失败」，要能直接拿去定位
    if (err && err.detail) {
      parts.push(el('pre', { class: 'err-detail', text: String(err.detail).slice(0, 600) }));
    }
    if (err && err.openUrl) {
      const href = String(err.openUrl);
      if (/^https?:/i.test(href)) {
        parts.push(el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: '在浏览器里打开 →' }));
      }
    }
    // 兜底：把图放进剪贴板 + 打开上传页，用户 Ctrl+V 自己搜（页内请求那条还没打通时用）
    if (eng.meta.id === 'google' && image) {
      parts.push(
        el('button', {
          type: 'button',
          text: '复制图 + 打开 Lens',
          onclick: () => void copyImageAndOpenLens(image)
        })
      );
    }
    parts.push(
      el('button', { type: 'button', text: '复制详情', onclick: () => void copyErrorDetail(eng, err) }),
      el('button', {
        type: 'button',
        text: '只重试这一家',
        onclick: () => {
          if (controller && !controller.signal.aborted) runEngine(eng, payload, image, controller.signal);
        }
      })
    );
    ui.err.replaceChildren(...parts);

    const httpCode = err && typeof err.code === 'string' && err.code.indexOf('http-') === 0 ? ' ' + err.code.slice(5) : '';
    if (kind === 'proxy') {
      // 直连被拒 / 网络不通：这不是「失败」，是缺代理
      ui.status.textContent = '需要代理';
      ui.status.className = 'status warn';
    } else if (kind === 'challenge') {
      ui.status.textContent = '人机校验';
      ui.status.className = 'status warn';
    } else if (kind === 'timeout') {
      ui.status.textContent = '超时';
      ui.status.className = 'status warn';
    } else if (kind === 'request') {
      ui.status.textContent = '请求失败';
      ui.status.className = 'status fail';
    } else if (kind === 'throttled') {
      ui.status.textContent = '限频';
      ui.status.className = 'status warn';
    } else if (kind === 'interval') {
      ui.status.textContent = '太频繁';
      ui.status.className = 'status warn';
    } else if (kind === 'parse') {
      ui.status.textContent = '被拦或改版';
      ui.status.className = 'status warn';
    } else if (kind === 'format' || (err && err.code === 'bad-image')) {
      ui.status.textContent = '图片格式不支持';
      ui.status.className = 'status fail';
    } else if (kind === 'rejected') {
      // 请求到了、也通了，但对方不认这次请求（不是网络问题）
      ui.status.textContent = '被拒绝';
      ui.status.className = 'status warn';
    } else {
      ui.status.textContent = '失败' + httpCode;
      ui.status.className = 'status fail';
    }
    return {
      n: 0,
      proxy: kind === 'proxy',
      failed: true,
      id: eng.meta.id,
      name,
      label: ui.status.textContent
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onParentAbort);
  }
}

/** 把 blob 转成 PNG（剪贴板图片只可靠支持 PNG） */
function toPngBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.addEventListener('load', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 不可用');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(
          (b) => {
            URL.revokeObjectURL(url);
            if (b) resolve(b);
            else reject(new Error('转换失败'));
          },
          'image/png'
        );
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    });
    img.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    });
    img.src = url;
  });
}

/** 兜底方案：图放剪贴板 + 打开上传页，Ctrl+V 即可 */
async function copyImageAndOpenLens(image) {
  try {
    const blob = b64ToBlob(image.b64, image.mime);
    const png = await toPngBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    setCaptureStatus('图已复制，到新打开的页面里 Ctrl+V', 'busy');
    setTimeout(() => setCaptureStatus(''), 5000);
  } catch (e) {
    setCaptureStatus('复制图片失败：' + (e && e.message ? e.message : e), 'bad');
  }
  chrome.tabs.create({ url: 'https://lens.google.com/upload' });
}

/** 把错误原文复制到剪贴板，方便直接贴出来定位 */
async function copyErrorDetail(eng, err) {
  const lines = [
    '扩展 ' + (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?') + ' / ' + eng.meta.name,
    '时间 ' + new Date().toISOString(),
    'message: ' + (err && err.message ? err.message : String(err)),
    'code: ' + (err && err.code ? err.code : '(无)')
  ];
  if (err && err.detail) lines.push('detail:\n' + String(err.detail).slice(0, 1200));
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
  } catch {
    /* 剪贴板被拒就算了，用户还能手抄 pre 里的内容 */
  }
}

/* ---------------- 渲染 ---------------- */

function renderHeader(payload) {
  pageTitleEl.textContent = payload.pageTitle || payload.pageUrl || '（未知页面）';
  pageTitleEl.title = payload.pageTitle || '';

  const img = payload.image && payload.image.ok ? payload.image : null;
  if (img) {
    previewEl.src = 'data:' + (img.mime || 'image/jpeg') + ';base64,' + img.b64;
    previewEl.hidden = false;
  } else if (payload.srcUrl && /^data:/.test(payload.srcUrl)) {
    previewEl.src = payload.srcUrl;
    previewEl.hidden = false;
  } else if (payload.srcUrl) {
    previewEl.src = payload.srcUrl;
    previewEl.hidden = false;
    previewEl.addEventListener('error', () => { previewEl.hidden = true; }, { once: true });
  } else {
    previewEl.hidden = true;
  }
}

function renderShell() {
  emptyEl.hidden = true;
  gridEl.hidden = false;
  cardUi = new Map();
  lastResults.clear();

  const banner = el('p', { class: 'hint banner', hidden: true });
  cardUi.set('__banner__', banner);

  // 需要代理的列合并成一行总览（不然每张卡片各红一片）
  const proxyNotice = el('p', { class: 'hint banner proxy', hidden: true });
  cardUi.set('__proxy__', proxyNotice);

  // 没出结果的列默认折叠成一行，点「展开」再看细节
  const failLine = el('p', { class: 'hint banner fails', hidden: true });
  cardUi.set('__fails__', failLine);

  const cards = ENGINES.map((eng) => {
    const status = el('span', { class: 'status', text: '排队中' });
    const hintEl = el('p', { class: 'card-hint', text: eng.meta.hint || '' });
    const items = el('ul', { class: 'items' });
    const err = el('p', { class: 'err', hidden: true });
    const note = el('span', { class: 'note', text: eng.meta.hint || '' });
    const footLink = el('a', {
      href: eng.meta.home,
      target: '_blank',
      rel: 'noopener noreferrer',
      text: '在 ' + eng.meta.name + ' 打开'
    });

    const card = el('section', { class: 'card', 'data-engine': eng.meta.id }, [
      el('header', { class: 'card-head' }, [el('h2', { text: eng.meta.name }), status]),
      hintEl,
      items,
      err,
      el('footer', { class: 'card-foot' }, [note, footLink])
    ]);

    cardUi.set(eng.meta.id, { card, status, items, err, note, footLink, hintEl });
    return card;
  });

  gridEl.replaceChildren(banner, proxyNotice, failLine, ...cards);
}

function renderItem(it) {
  const hasPreview = Boolean(it.preview);
  const li = el('li', { class: 'item' + (hasPreview ? ' item-video' : '') });

  if (hasPreview) {
    // TraceMoe 会给一段无声 mp4 片段，直接放出来比缩略图有用得多
    const video = el('video', {
      class: 'item-preview',
      src: it.preview,
      poster: it.thumb || null,
      autoplay: true,
      loop: true,
      muted: true,
      playsinline: true,
      preload: 'metadata'
    });
    // muted 走属性不一定生效，直接设 property，否则自动播放会被浏览器的静音策略拦住
    video.muted = true;
    li.append(video);
  } else if (it.thumb) {
    const img = el('img', {
      class: 'item-thumb',
      src: it.thumb,
      alt: '',
      loading: 'lazy',
      referrerpolicy: 'no-referrer'
    });
    img.addEventListener('error', () => { img.hidden = true; }, { once: true });
    li.append(img);
  }

  const body = el('div', { class: 'item-body' });

  // 标题做成链接，直接指向第一个出处（比下面那行小字好点）
  const firstLink = (it.links || []).filter((l) => l && l.url)[0];
  if (firstLink) {
    body.append(
      el('a', {
        class: 'item-title item-title-link',
        href: firstLink.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: firstLink.url,
        text: it.title || '（无标题）'
      })
    );
  } else {
    body.append(el('p', { class: 'item-title', text: it.title || '（无标题）' }));
  }
  if (it.sub) body.append(el('p', { class: 'item-sub', text: it.sub }));

  const meta = el('div', { class: 'item-meta' });
  if (it.similarity !== null && it.similarity !== undefined) {
    meta.append(el('span', { class: 'badge score ' + scoreClass(it.similarity), text: it.similarity + '%' }));
  }
  if (it.site) meta.append(el('span', { class: 'badge', text: it.site }));
  if (it.extra) meta.append(el('span', { class: 'badge', text: it.extra }));
  if (meta.childElementCount) body.append(meta);

  // 出处链接：必须用完整 ext_url（带 path），能点进那张图，不是站点首页
  const shownLinks = (it.links || []).filter((l) => l && l.url).slice(0, 3);
  if (shownLinks.length) {
    const linksEl = el('div', { class: 'item-links' });
    for (const link of shownLinks) {
      linksEl.append(
        el('a', {
          href: link.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: link.url, // 悬停看完整地址
          text: linkText(link)
        })
      );
    }
    body.append(linksEl);

    const hint = linkHint(shownLinks);
    if (hint) body.append(el('p', { class: 'item-hint', text: hint }));
  }

  li.append(body);
  return li;
}

/** 链接显示文字：站点名 + 路径尾巴（截断了靠 title 看全） */
function linkText(link) {
  let host = '';
  let tail = '';
  try {
    const u = new URL(link.url);
    host = u.hostname.replace(/^www\./, '');
    tail = u.pathname === '/' ? '' : decodeURI(u.pathname + u.search);
  } catch {
    return link.url;
  }
  const base = link.label && link.label !== host ? link.label : host;
  const text = tail ? base + ' · ' + tail : base || link.url;
  return text.length > 48 ? text.slice(0, 46) + '…' : text;
}

/**
 * 打开后可能落到登录页 / 拦截页的来源，给一句中性提示。
 * 不点名任何站点，只按 URL 形态判断：
 *   - 只有域名根路径 → 到不了具体页面；
 *   - 路径里有很长的十六进制 token 段 → 这类作品页通常要登录。
 */
function linkHint(links) {
  for (const l of links) {
    let u;
    try {
      u = new URL(l.url);
    } catch {
      continue;
    }
    const path = u.pathname || '/';
    if (path === '/' || path === '') return '这个来源只给了首页地址，可能到不了具体页面';
    if (/\/[0-9a-f]{12,}(\/|$)/i.test(path)) return '该站点需要登录，可能无法直接查看';
  }
  return '';
}

/* ---------------- SauceNAO key ---------------- */

async function loadKey() {
  try {
    const { saucenaoApiKey = '', saucenaoHighOnly = false } = await chrome.storage.local.get([
      'saucenaoApiKey',
      'saucenaoHighOnly'
    ]);
    $('key-hint').textContent = saucenaoApiKey
      ? '已保存 ' + maskKey(saucenaoApiKey) + '（只存在本机，不云同步）→ 走 JSON API'
      : '未填 → 走匿名 HTML 模式（能搜，额度低）；填了切到 JSON API';
    const box = $('high-only');
    if (box) box.checked = Boolean(saucenaoHighOnly);
  } catch {
    $('key-hint').textContent = '';
  }
}

/** Key 打码显示，确认存的是哪一把 */
function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return '（长度 ' + s.length + '）';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

/** 顶栏「⚙ 设置」：展开底部设置区并聚焦 Key 输入框（点了必须有可见变化） */
function openSettings() {
  const details = $('key-details');
  if (details) {
    details.open = true;
    if (typeof details.scrollIntoView === 'function') details.scrollIntoView({ block: 'nearest' });
  }
  focusKeyField();
  const hint = $('key-hint');
  if (hint && !hint.textContent) hint.textContent = '把 SauceNAO 的 API Key 粘到上面，点保存';
}

/** 打开设置区并聚焦 Key 输入框（卡片上「填写 API Key」按钮用） */
function focusKeyField() {
  const details = $('key-details');
  if (details) details.open = true;
  const input = $('key-input');
  if (input) {
    input.focus();
    if (typeof input.scrollIntoView === 'function') input.scrollIntoView({ block: 'center' });
  }
}

/** 从一段文本里挑出 Key：优先 16 位以上的字母数字串，其次去掉空白后的整串 */
function pickToken(text) {
  const s = String(text || '');
  const m = s.match(/[A-Za-z0-9]{16,}/);
  if (m) return m[0];
  const t = s.replace(/\s+/g, '');
  return /^[A-Za-z0-9]{8,}$/.test(t) ? t : '';
}

/**
 * 「读剪贴板」：不依赖点输入框。
 * 侧边栏里合成点击有时激活不了 input，这条路径只点按钮，键盘一个字都不用打。
 */
async function readKeyFromClipboard() {
  const hint = $('key-hint');
  let text = '';

  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    if (hint) {
      hint.textContent =
        '读剪贴板失败：' +
        (e && e.message ? e.message : e) +
        '。可以改用扩展的「扩展程序选项」页（普通标签页）粘贴';
    }
    return;
  }

  const token = pickToken(text);
  if (!token) {
    if (hint) hint.textContent = '剪贴板里没找到像 Key 的字符串（' + (text ? '内容长度 ' + text.length : '剪贴板是空的') + '）';
    return;
  }

  await chrome.storage.local.set({ saucenaoApiKey: token });
  if (hint) hint.textContent = '已从剪贴板保存 ' + maskKey(token) + ' → 走 JSON API';

  if (currentPayload) {
    lastRunId = null;
    void run(currentPayload);
  }
}

/** 「只看 ≥80%」开关：改完立即用当前这张图重搜，不用手动点重搜 */
async function saveHighOnly() {
  const box = $('high-only');
  const on = Boolean(box && box.checked);
  await chrome.storage.local.set({ saucenaoHighOnly: on });
  if (currentPayload) {
    lastRunId = null;
    void run(currentPayload);
  }
}

async function saveKey() {
  const input = $('key-input');
  const value = (input.value || '').trim();

  // 关键：空输入框不能当成「清除」。以前这里会把已保存的 Key 抹掉。
  if (!value) {
    $('key-hint').textContent = '输入框是空的，Key 没有改动；要清空请点「清除」';
    return;
  }

  await chrome.storage.local.set({ saucenaoApiKey: value });
  input.value = '';
  $('key-hint').textContent = '已保存（只存在本机，不云同步）→ 走 JSON API';

  if (currentPayload) {
    lastRunId = null;
    void run(currentPayload);
  }
}

/** 显式清除（只有这个按钮能清空 Key） */
async function clearKey() {
  await chrome.storage.local.set({ saucenaoApiKey: '' });
  const input = $('key-input');
  if (input) input.value = '';
  $('key-hint').textContent = '已清除 → 会退回匿名 HTML 模式';
  if (currentPayload) {
    lastRunId = null;
    void run(currentPayload);
  }
}
