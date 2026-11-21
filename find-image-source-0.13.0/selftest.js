/**
 * 开发自检页：在 chrome-extension://<id>/selftest.html 打开，
 * 检查扩展环境、权限、storage、右键菜单是否就绪。
 * 不参与 manifest，不影响正常使用。
 */

const rows = [];
const $ = (id) => document.getElementById(id);

function report(label, ok, detail = '') {
  rows.push({ label, ok, detail });
}
function render() {
  const tbody = document.querySelector('#out tbody');
  if (!tbody) return;
  tbody.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    a.textContent = r.label;
    const b = document.createElement('td');
    b.className = r.ok ? 'ok' : 'bad';
    b.textContent = (r.ok ? 'OK ' : 'FAIL ') + r.detail;
    tr.append(a, b);
    tbody.append(tr);
  }
  document.documentElement.setAttribute('data-selftest-done', String(rows.length));
  document.title = 'selftest: ' + rows.map((r) => (r.ok ? '1' : '0')).join('');
}

/* ---------------- 设置区（与面板共用同一批 storage 键） ---------------- */

function maskKey(key) {
  const s = String(key || '');
  return s.length <= 8 ? '（长度 ' + s.length + '）' : s.slice(0, 4) + '…' + s.slice(-4);
}

async function loadSettings() {
  try {
    const { saucenaoApiKey = '', saucenaoHighOnly = false } = await chrome.storage.local.get([
      'saucenaoApiKey',
      'saucenaoHighOnly'
    ]);
    const hint = $('key-hint');
    if (hint) {
      hint.textContent = saucenaoApiKey
        ? '已保存 ' + maskKey(saucenaoApiKey) + ' → 走 JSON API'
        : '未填 → 走匿名 HTML 模式（能搜，额度低）';
    }
    const box = $('high-only');
    if (box) box.checked = Boolean(saucenaoHighOnly);

    // 本地缓存占用（图片从不落盘，这里反映的是 Key/开关等配置体积）
    try {
      const used = await chrome.storage.local.getBytesInUse(null);
      const msg = $('storage-msg');
      if (msg) msg.textContent = '本地缓存占用：' + Math.max(1, Math.round(used / 1024)) + ' KB' + (used < 1024 ? '（约 ' + used + ' 字节）' : '');
    } catch {
      /* 忽略 */
    }
  } catch (e) {
    const hint = $('key-hint');
    if (hint) hint.textContent = '读取设置失败：' + e.message;
  }
}

/** 只清扩展自己的本地数据；图片本来就不在磁盘上 */
async function clearLocalData() {
  const msg = $('storage-msg');
  try {
    const before = await chrome.storage.local.getBytesInUse(null).catch(() => 0);
    await chrome.storage.local.clear();
    await chrome.storage.session.clear().catch(() => {});
    if (msg) msg.textContent = '已清空本地数据（释放 ' + Math.max(1, Math.round(before / 1024)) + ' KB），Key 也一起清了';
    await loadSettings();
  } catch (e) {
    if (msg) msg.textContent = '清空失败：' + (e && e.message ? e.message : e);
  }
}

async function saveKey() {
  const input = $('key-input');
  const value = (input && input.value ? input.value : '').trim();

  // 和面板同样的守卫：空输入不能把已存的 Key 抹掉
  if (!value) {
    $('key-hint').textContent = '输入框是空的，Key 没有改动；要清空请点「清除」';
    return;
  }
  await chrome.storage.local.set({ saucenaoApiKey: value });
  if (input) input.value = '';
  $('key-hint').textContent = '已保存 ' + maskKey(value) + ' → 走 JSON API（回面板重搜即可）';
}

async function clearKey() {
  await chrome.storage.local.set({ saucenaoApiKey: '' });
  const input = $('key-input');
  if (input) input.value = '';
  $('key-hint').textContent = '已清除 → 会退回匿名 HTML 模式';
}

/** 这个页面是普通标签页，读剪贴板和手动粘贴都走得通 */
async function pasteKey() {
  const hint = $('key-hint');
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    if (hint) hint.textContent = '读剪贴板失败：' + (e && e.message ? e.message : e) + '（可以直接手动粘贴）';
    return;
  }
  const m = String(text || '').match(/[A-Za-z0-9]{16,}/);
  const token = m ? m[0] : String(text || '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9]{8,}$/.test(token)) {
    if (hint) hint.textContent = '剪贴板里没找到像 Key 的字符串';
    return;
  }
  await chrome.storage.local.set({ saucenaoApiKey: token });
  if (hint) hint.textContent = '已从剪贴板保存 ' + maskKey(token) + ' → 走 JSON API（回面板重搜即可）';
}

async function saveHighOnly() {
  const box = $('high-only');
  await chrome.storage.local.set({ saucenaoHighOnly: Boolean(box && box.checked) });
  $('key-hint').textContent = box && box.checked ? '只看 ≥80%：已开' : '只看 ≥80%：已关（会显示低分候选）';
}

/**
 * 注入到页面执行：按「同源」原则逐个试上传地址，每个都回报**实际请求 URL**。
 * 只能用参数，不能引用扩展作用域。
 *
 * mode='page'：当前页可能是 www.google.com，试相对 /v3/upload + searchbyimage/upload
 * mode='lens'：当前页是 lens.google.com，试相对 /v3/upload
 */
async function lensProbeBatch(payload) {
  const results = [];

  function abs(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  async function attempt(label, url, field) {
    const request = abs(url);
    try {
      const bin = atob(payload.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

      const fd = new FormData();
      fd.append(field, new Blob([bytes], { type: payload.mime || 'image/jpeg' }), 'image.jpg');
      if (field === 'encoded_image') fd.append('image_content', '');

      const started = Date.now();
      const r = await fetch(request, {
        method: 'POST',
        body: fd,
        credentials: 'include',
        redirect: 'follow'
      });
      const text = await r.text();
      results.push({
        label,
        request,
        status: r.status,
        finalUrl: r.url,
        len: text.length,
        ms: Date.now() - started,
        head: String(text).replace(/\s+/g, ' ').slice(0, 160)
      });
    } catch (e) {
      results.push({
        label,
        request,
        status: 0,
        error: String((e && e.name) || '') + ': ' + String((e && e.message) || e)
      });
    }
  }

  if (payload.mode === 'page') {
    await attempt('相对 /v3/upload', '/v3/upload?stcs=' + Date.now(), 'encoded_image');
    await attempt('searchbyimage/upload', 'https://www.google.com/searchbyimage/upload', 'encoded_image');
  } else {
    await attempt('lens 相对 /v3/upload', '/v3/upload?stcs=' + Date.now(), 'encoded_image');
  }

  return { pageUrl: location.href, results };
}

/** 实验：开标签页 → 等 complete → 读真实 URL → 同源逐个试，打印每次实际请求地址 */
async function runLensProbe() {
  const msg = $('lens-msg');
  const btn = $('lens-probe');
  if (btn) btn.disabled = true;
  const lines = [];
  const say = () => {
    if (msg) msg.textContent = lines.join('\n');
  };

  const waitComplete = async (tabId) => {
    for (let i = 0; i < 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 400));
      // eslint-disable-next-line no-await-in-loop
      const info = await chrome.tabs.get(tabId).catch(() => null);
      if (info && info.status === 'complete') return info;
    }
    return null;
  };

  try {
    lines.push('抓示例图…');
    say();

    const resp = await fetch(SMOKE_IMAGE_URL, { cache: 'force-cache' });
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('读图失败'));
      fr.readAsDataURL(blob);
    });
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const mime = blob.type || 'image/png';

    lines.push('打开 https://lens.google.com/upload …');
    say();
    const tab = await chrome.tabs.create({ url: 'https://lens.google.com/upload', active: false });

    const first = await waitComplete(tab.id);
    const firstUrl = (first && (first.url || first.pendingUrl)) || '';
    lines.push('第一步停在：' + (firstUrl || '(空)'));
    say();

    // 当前页（可能是 www）→ 试相对路径 + 老接口
    const [{ result: batch1 }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: lensProbeBatch,
      args: [{ mode: 'page', b64, mime }]
    });
    lines.push('页面 origin：' + (batch1.pageUrl || ''));
    for (const r of batch1.results || []) {
      lines.push(
        '· ' +
          r.label +
          '\n  请求: ' +
          r.request +
          '\n  结果: ' +
          (r.error ? r.error : 'HTTP ' + r.status + ' / 最终 ' + (r.finalUrl || '') + ' / ' + r.len + ' 字节') +
          (r.head ? '\n  开头: ' + r.head.slice(0, 120) : '')
      );
    }
    say();

    // 如果落在 www，再导航到 lens 根，在真正的 lens origin 上试相对路径
    if (!/^https:\/\/lens\.google\.com\//.test(firstUrl)) {
      lines.push('第二步：导航到 https://lens.google.com/ …');
      say();
      await chrome.tabs.update(tab.id, { url: 'https://lens.google.com/' });
      const second = await waitComplete(tab.id);
      const secondUrl = (second && (second.url || second.pendingUrl)) || '';
      lines.push('第二步停在：' + (secondUrl || '(空)'));

      const [{ result: batch2 }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: lensProbeBatch,
        args: [{ mode: 'lens', b64, mime }]
      });
      lines.push('页面 origin：' + (batch2.pageUrl || ''));
      for (const r of batch2.results || []) {
        lines.push(
          '· ' +
            r.label +
            '\n  请求: ' +
            r.request +
            '\n  结果: ' +
            (r.error ? r.error : 'HTTP ' + r.status + ' / 最终 ' + (r.finalUrl || '') + ' / ' + r.len + ' 字节') +
            (r.head ? '\n  开头: ' + r.head.slice(0, 120) : '')
        );
      }
      say();
    }

    chrome.tabs.remove(tab.id).catch(() => {});
  } catch (e) {
    lines.push('注入/执行失败：' + (e && e.message ? e.message : e));
    say();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runAscii2dProbe() {
  const msg = $('ascii2d-msg');
  const btn = $('ascii2d-probe');
  if (btn) btn.disabled = true;
  const lines = [];
  const say = () => {
    if (msg) msg.textContent = lines.join('\n');
  };

  try {
    // 示例图
    say();
    const resp = await fetch(SMOKE_IMAGE_URL, { cache: 'force-cache' });
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('读图失败'));
      fr.readAsDataURL(blob);
    });
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const mime = blob.type || 'image/png';

    // A. 扩展侧直连
    lines.push('A. 扩展侧直连 ascii2d.net：');
    try {
      const r = await fetch('https://ascii2d.net/', { cache: 'no-store', credentials: 'omit' });
      lines.push('   HTTP ' + r.status + (r.ok ? '（可达）' : '（被拒）'));
    } catch (e) {
      lines.push('   ' + (e && e.name) + ': ' + (e && e.message));
    }
    say();

    // B. 页面上下文
    lines.push('B. 页内同源请求：');
    const existing = await chrome.tabs.query({ url: 'https://ascii2d.net/*' });
    let tabId = existing && existing[0] ? existing[0].id : null;
    let createdTab = null;

    if (tabId) {
      lines.push('   复用已打开的标签页 #' + tabId);
    } else {
      const tab = await chrome.tabs.create({ url: 'https://ascii2d.net/', active: false });
      createdTab = tab.id;
      tabId = tab.id;
      lines.push('   没有现成标签页，开了后台标签页 #' + tabId + '（用完会关）');
    }
    say();

    let out = null;
    let lastErr = '';
    const trySend = async (id) =>
      chrome.tabs.sendMessage(id, { type: 'ascii2d.probe', b64, mime }).catch((e) => {
        lastErr = e && e.message ? e.message : String(e);
        return null;
      });

    // 先给已开标签页 3 次机会（它可能没装 content script —— 装扩展前就打开的页面）
    for (let i = 0; i < 3 && tabId && !out; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500));
      // eslint-disable-next-line no-await-in-loop
      out = await trySend(tabId);
    }
    if (out) lines.push('   复用的标签页探针就绪');

    // 复用失败 → 开一个全新的后台标签页（新页面一定会加载 content script）
    if (!out && !createdTab) {
      lines.push('   复用失败（' + lastErr + '），改用新开的后台标签页');
      const tab = await chrome.tabs.create({ url: 'https://ascii2d.net/', active: false });
      createdTab = tab.id;
      tabId = tab.id;
      for (let i = 0; i < 30 && !out; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        // eslint-disable-next-line no-await-in-loop
        out = await trySend(tabId);
      }
    }
    say();

    if (out) {
      lines.push('   origin: ' + out.origin + '  title: ' + out.title);
      if (out.token) lines.push('   表单 token：' + out.token);
      if (out.error) {
        lines.push('   请求抛错：' + out.error);
        lines.push('   → 这条是「没拿到响应」，不是 CORS（同源请求不受 CORS 限制）');
      } else {
        lines.push('   HTTP ' + out.status + (out.ok ? '（成功）' : '（失败）'));
        lines.push('   页面长度：' + out.htmlLength + '，有结果块：' + (out.hasItems ? '是' : '否'));
        if (out.finalUrl && out.finalUrl !== location.href) lines.push('   最终地址：' + out.finalUrl);
        if (out.body) lines.push('   响应开头：' + out.body.slice(0, 160));
      }
    } else {
      lines.push('   探针没响应：' + lastErr);
    }

    if (createdTab) {
      chrome.tabs.remove(createdTab).catch(() => {});
      lines.push('（已关闭临时标签页）');
    }
    say();
  } catch (e) {
    lines.push('实验出错：' + (e && e.message ? e.message : e));
    say();
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 实验：走主链路（表单提交）跑一次 ascii2d，把阶段原样打出来 */
async function runAscii2dFormProbe() {
  const msg = $('ascii2d-form-msg');
  const btn = $('ascii2d-form');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = '抓示例图…';

  try {
    const resp = await fetch(SMOKE_IMAGE_URL, { cache: 'force-cache' });
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('读图失败'));
      fr.readAsDataURL(blob);
    });
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

    if (msg) msg.textContent = '后台执行中（开标签页 → 表单 submit → 等结果页）…';
    const r = await chrome.runtime.sendMessage({
      type: 'ascii2d.formProbe',
      payload: { b64, mime: blob.type || 'image/png' }
    });

    if (msg) {
      msg.textContent = [
        '结果：' + (r && r.ok ? '成功' : '失败'),
        'phase: ' + ((r && r.phase) || '(无)'),
        'status: ' + ((r && r.status) || 0),
        '条目数: ' + ((r && r.itemCount) || 0),
        'token: ' + ((r && r.token) || '(未返回)'),
        r && r.htmlLength !== undefined ? '页面长度: ' + r.htmlLength : '',
        r && r.body ? '页面开头: ' + String(r.body).slice(0, 160) : '',
        'message: ' + ((r && r.message) || ''),
        r && r.openUrl ? '结果页: ' + r.openUrl : ''
      ]
        .filter(Boolean)
        .join('\n');
    }
  } catch (e) {
    if (msg) msg.textContent = '实验出错：' + (e && e.message ? e.message : e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function main() {
  $('smoke')?.addEventListener('click', smoke);
  $('menu-ensure')?.addEventListener('click', ensureMenu);

  // 设置区（这个页面就是「扩展程序选项」，所以它必须是能真正填 Key 的地方）
  $('key-save')?.addEventListener('click', () => void saveKey());
  $('key-clear')?.addEventListener('click', () => void clearKey());
  $('key-paste')?.addEventListener('click', () => void pasteKey());
  $('clear-local')?.addEventListener('click', () => void clearLocalData());
  $('lens-probe')?.addEventListener('click', () => void runLensProbe());
  $('ascii2d-probe')?.addEventListener('click', () => void runAscii2dProbe());
  $('ascii2d-form')?.addEventListener('click', () => void runAscii2dFormProbe());
  $('high-only')?.addEventListener('change', () => void saveHighOnly());
  await loadSettings();

  report('扩展页环境', location.protocol === 'chrome-extension:', location.origin);
  report('扩展 ID', true, chrome.runtime.id);
  report('正确的自检页地址', true, chrome.runtime.getURL('selftest.html'));

  const perms = ['contextMenus', 'sidePanel', 'storage', 'scripting', 'activeTab'];
  for (const p of perms) {
    let ok = false;
    try {
      ok = await chrome.permissions.contains({ permissions: [p] });
    } catch (e) {
      ok = false;
    }
    report('权限 ' + p, ok);
  }

  let hosts = false;
  try {
    hosts = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch {}
  report('host 权限 <all_urls>', hosts);

  try {
    await chrome.storage.session.set({ __selftest: 42 });
    const got = await chrome.storage.session.get('__selftest');
    report('storage.session 读写', got.__selftest === 42, String(got.__selftest));
  } catch (e) {
    report('storage.session 读写', false, e.message);
  }

  try {
    await chrome.storage.local.set({ __selftest_local: 'x' });
    const got = await chrome.storage.local.get('__selftest_local');
    report('storage.local 读写', got.__selftest_local === 'x');
  } catch (e) {
    report('storage.local 读写', false, e.message);
  }

  // SauceNAO 现在必须带 Key，这里直接显示有没有
  try {
    const { saucenaoApiKey = '' } = await chrome.storage.local.get('saucenaoApiKey');
    report(
      'SauceNAO Key',
      Boolean(saucenaoApiKey),
      saucenaoApiKey
        ? '已保存 → 走 JSON API'
        : '未填 → 走匿名 HTML 模式（能用，额度低）；Key 在 saucenao.com/user.php?page=search-api'
    );
  } catch (e) {
    report('SauceNAO Key', false, e.message);
  }

  try {
    const sw = await navigator.serviceWorker?.getRegistrations?.();
    report('service worker 注册', Array.isArray(sw) && sw.length >= 0, sw ? String(sw.length) : 'n/a');
  } catch (e) {
    report('service worker 注册', false, e.message);
  }

  // 引擎模块能否被正常 import（语法 / 依赖链）
  for (const mod of ['saucenao', 'tracemoe', 'ascii2d', 'google', 'yandex']) {
    try {
      const m = await import('./engines/' + mod + '.js');
      report('模块 ' + mod, typeof m.search === 'function', m.meta?.name || '');
    } catch (e) {
      report('模块 ' + mod, false, e.message);
    }
  }

  // 把 manifest 里注册的 content_scripts 原样打出来（排查「脚本到底注没注」）
  try {
    const cs = chrome.runtime.getManifest().content_scripts || [];
    report(
      'content_scripts',
      cs.length > 0,
      cs.length ? JSON.stringify(cs.map((c) => ({ matches: c.matches, js: c.js }))) : '（没有注册任何 content script）'
    );
  } catch (e) {
    report('content_scripts', false, e.message);
  }

  await probe('SauceNAO', 'https://saucenao.com/');
  await probe('TraceMoe', 'https://api.trace.moe/');
  await probe('Google', 'https://www.google.com/');
  // ascii2d 预期就是 403 挑战：说明网络通，但扩展必须走后台标签页
  await probe('ascii2d', 'https://ascii2d.net/', { expect: [403] });
  await probe('Yandex', 'https://yandex.com/images/');

  render();
}

async function probe(label, url, { expect = [] } = {}) {
  const t0 = performance.now();
  try {
    const resp = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    const ms = Math.round(performance.now() - t0);
    const ok = resp.ok || expect.includes(resp.status);
    const note =
      resp.status === 403 && label === 'ascii2d'
        ? 'HTTP 403 Cloudflare 挑战（正常，搜索走后台标签页）'
        : 'HTTP ' + resp.status + ' · ' + ms + 'ms';
    report('连通 ' + label, ok, note);
  } catch (e) {
    report('连通 ' + label, false, '连不上：' + (e && e.message ? e.message : String(e)));
  }
}

/** 手动重建右键菜单（菜单丢了时的修复入口） */
async function ensureMenu() {
  const msg = $('menu-msg');
  const btn = $('menu-ensure');
  btn.disabled = true;
  msg.textContent = '请求后台重建…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'menu.ensure' });
    if (r && r.ok) {
      const titles = (r.titles || []).join(' / ');
      msg.textContent = '后台已重建右键菜单：' + (titles || '（无标题返回）') + '。图片项只在图片上出现，帧项只在视频上出现。';
    } else {
      msg.textContent = '重建失败：' + ((r && r.message) || '后台没有响应，看看服务工作线程的控制台报了什么');
    }
  } catch (e) {
    msg.textContent = '请求后台失败：' + (e && e.message ? e.message : String(e));
  } finally {
    btn.disabled = false;
  }
}

/** 烟雾测试：抓一张公开图片、带上字节写进任务，让侧边栏真的跑一遍（含 Lens 的 POST 上传） */
const SMOKE_IMAGE_URL =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png';

async function smoke() {
  const msg = $('smoke-msg');
  const btn = $('smoke');
  btn.disabled = true;
  msg.textContent = '抓示例图…';

  let image = null;
  try {
    const resp = await fetch(SMOKE_IMAGE_URL, { cache: 'force-cache' });
    if (resp.ok) {
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('读图失败'));
        fr.readAsDataURL(blob);
      });
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (b64.length > 0 && b64.length * 0.75 < 4 * 1024 * 1024) {
        image = { ok: true, b64, mime: blob.type || 'image/png', width: null, height: null, via: 'selftest' };
      }
    }
  } catch {
    image = null;
  }

  try {
    await chrome.storage.session.set({
      pending: {
        id: 'selftest-' + Date.now(),
        ts: Date.now(),
        srcUrl: SMOKE_IMAGE_URL,
        pageUrl: location.href,
        pageTitle: '自检示例图',
        phase: 'ready',
        image,
        note: image ? '' : '自检：没抓到字节，只好用链接模式'
      }
    });
    msg.textContent = image
      ? '已写入（带图片字节，Lens 会真上传）。点工具栏的放大镜图标打开侧边栏看五列结果；会消耗 1 次 SauceNAO 额度。'
      : '已写入，但没抓到字节，只能用链接模式。点工具栏图标看结果（Lens/Yandex 可能抓不到图）。';
  } catch (e) {
    msg.textContent = '写入失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

main().catch((e) => {
  report('自检脚本异常', false, e.message);
  render();
});
