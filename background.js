/**
 * 后台 service worker：
 * 1) 注册右键菜单「用这张图找出处」（幂等：每次 SW 启动都自愈一次）
 * 2) 点击后立刻打开侧边栏（必须同步调用，否则用户手势失效）
 * 3) 在页面上下文里抓取图片字节（带上页面 cookie/referer），写进 storage.session
 *    侧边栏监听 storage 变化，拿到字节后开始搜索。抓不到字节就退回「只传 URL」模式。
 */

const MENU_IMAGE_ID = 'find-image-source';
const MENU_PICK_ID = 'find-image-source-pick';
const MENU_VIDEO_ID = 'find-video-frame-source';
const MENU_ACTION_ID = 'find-video-frame-from-action';
const TASK_KEY = 'videoTask'; // 抓帧任务状态：让面板能把「没收到 / 正在抓 / 失败」分开显示
const PENDING_KEY = 'pending';
const MAX_B64 = 7 * 1024 * 1024; // storage.session 单条写入留余量（配额 10MB）
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 后台取图上限
const EXT_VERSION_KEY = 'extVersion';
// 只有这两个键值得跨版本保留（用户设置）；其它一律当缓存清掉
const KEEP_LOCAL_KEYS = ['saucenaoApiKey', 'saucenaoHighOnly'];

/**
 * 升级迁移：旧版本可能把图片/临时数据写进了 storage.local。
 * 版本一变就清一次（保留 API Key 和开关），避免磁盘上留下看不见的图片。
 */
async function migrateStorage() {
  try {
    const version = chrome.runtime.getManifest().version;
    const got = await chrome.storage.local.get([EXT_VERSION_KEY]);
    if (got[EXT_VERSION_KEY] === version) return;

    const all = await chrome.storage.local.get(null);
    const junk = Object.keys(all).filter((k) => !KEEP_LOCAL_KEYS.includes(k));
    if (junk.length) await chrome.storage.local.remove(junk);
    // 会话存储里的零散数据也清掉（图片本体只该存在于内存）
    await chrome.storage.session.clear().catch(() => {});
    await chrome.storage.local.set({ [EXT_VERSION_KEY]: version });

    if (junk.length) console.log('[找图出处] 升级迁移：清理', junk.length, '个旧键');
  } catch {
    /* 迁移失败不影响使用 */
  }
}
const MENU_IMAGE_TITLE = '用这张图找出处';
const MENU_VIDEO_TITLE = '用当前这一帧找出处';

function nowId() {
  return (self.crypto && self.crypto.randomUUID)
    ? self.crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

/**
 * 幂等创建右键菜单。
 *
 * 为什么不能只在 onInstalled 里建：菜单由浏览器进程持有，但「创建」这个动作跑在 SW 里。
 * 扩展被重新加载/更新、或 SW 在建菜单的过程中被回收，菜单就可能一直缺失，而 onInstalled
 * 不保证每次重载都触发（实测就踩到了：菜单消失后再怎么点「重新加载」都回不来）。
 * 所以每次 SW 启动都在顶层重跑一遍，先 removeAll 再 create，重复 id 的错误直接吞掉。
 */
function ensureContextMenu() {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.removeAll(() => {
        // 读掉 lastError，避免 "Unchecked runtime.lastError" 噪音
        void chrome.runtime.lastError;

        const items = [
          { id: MENU_IMAGE_ID, title: MENU_IMAGE_TITLE, contexts: ['image'] },
          { id: MENU_VIDEO_ID, title: MENU_VIDEO_TITLE, contexts: ['video'] },
          // 右键工具栏图标：不依赖快捷键，也不会被页面的右键拦截影响
          { id: MENU_ACTION_ID, title: '抓这一页视频的当前帧', contexts: ['action'] },
          // 背景图 / canvas 不是 <img>，右键命不中 image 上下文：给一个页面级入口
          { id: MENU_PICK_ID, title: '用页面上的图找出处（背景图 / canvas）', contexts: ['page'] }
        ];
        const results = [];
        let pending = items.length;

        const done = () => {
          pending -= 1;
          if (pending > 0) return;
          const failed = results.filter((r) => !r.ok);
          if (failed.length) {
            console.warn('[找图出处] 右键菜单创建失败:', failed.map((f) => f.id + ': ' + f.message).join('; '));
            resolve({ ok: false, message: failed[0].message, results });
          } else {
            resolve({ ok: true, results, titles: [MENU_IMAGE_TITLE, MENU_VIDEO_TITLE] });
          }
        };

        for (const item of items) {
          chrome.contextMenus.create(item, () => {
            const err = chrome.runtime.lastError;
            results.push({ id: item.id, ok: !err, message: err ? err.message : '' });
            done();
          });
        }
      });
    } catch (e) {
      resolve({ ok: false, message: e && e.message ? e.message : String(e) });
    }
  });
}

function ensurePanelBehavior() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// SW 顶层：每次启动（含被浏览器回收后唤醒）都自愈一次
void ensureContextMenu();
void migrateStorage();

chrome.runtime.onInstalled.addListener(() => {
  void ensureContextMenu();
  void migrateStorage();
  ensurePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureContextMenu();
  void migrateStorage();
  ensurePanelBehavior();
});

/**
 * 统一入口：图片右键、视频右键、快捷键、侧边栏按钮都走这里。
 * openPanel=false 用于侧边栏自己触发的场景（面板已经开着，再调 open 会被判成非手势）。
 */
function beginSearch(tab, { kind, srcUrl = '', frameId = 0, openPanel = true } = {}) {
  if (!tab || typeof tab.id !== 'number') return null;

  const payload = {
    id: nowId(),
    ts: Date.now(),
    kind,
    srcUrl,
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    tabId: tab.id,
    windowId: typeof tab.windowId === 'number' ? tab.windowId : undefined,
    frameId: typeof frameId === 'number' ? frameId : 0,
    phase: 'capturing',
    image: null,
    note: ''
  };

  // 先落盘再开面板：面板可能比抓取先加载完成
  chrome.storage.session.set({ [PENDING_KEY]: payload }).catch(() => {});

  if (kind === 'video') {
    void setTask({
      state: 'capturing',
      message: '正在抓帧…',
      tabId: tab.id,
      jobId: payload.id,
      pageTitle: payload.pageTitle
    });
  }

  if (openPanel) {
    // 注意：必须在用户手势内同步调用 open()，前面不能 await
    chrome.sidePanel.open({ tabId: tab.id }).catch((err) => {
      // 老版本 Chrome 或某些受限页面：退化成独立窗口打开同一个页面
      chrome.storage.session
        .set({ [PENDING_KEY]: { ...payload, phase: 'ready', note: 'panel-open-failed: ' + (err && err.message) } })
        .catch(() => {});
      chrome.windows
        .create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', width: 760, height: 900 })
        .catch(() => {});
    });
  }

  void captureAndStore(payload);
  return payload;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ACTION_ID) {
    beginSearch(tab, { kind: 'video' });
    return;
  }

  // 背景图 / canvas：进页面让用户点一下要搜的元素
  if (info.menuItemId === MENU_PICK_ID) {
    pickImageOnPage(tab).then((r) => {
      if (!r || !r.ok) {
        void setTask({ state: 'error', message: '没取到图：' + ((r && r.reason) || '未知原因') });
        return;
      }
      beginSearch(tab, { kind: 'image', srcUrl: r.srcUrl, frameId: info.frameId });
    });
    return;
  }

  const kind =
    info.menuItemId === MENU_VIDEO_ID ? 'video' : info.menuItemId === MENU_IMAGE_ID ? 'image' : null;
  if (!kind) return;
  // 图片必须有 srcUrl；视频可能只有 <source>，允许空，靠页面里找 <video> 元素
  if (!info.srcUrl && kind === 'image') return;
  beginSearch(tab, { kind, srcUrl: info.srcUrl || '', frameId: info.frameId });
});

// 快捷键（Ctrl+Shift+Y）：B 站这类播放器自己接管了右键，原生菜单根本不出现，
// 这是不依赖右键的入口之一（另两个：右键工具栏图标、面板里的「抓帧」按钮）。
// 坑：Ctrl+L 这类浏览器自带键会被浏览器先吃掉；Ctrl+Alt 在 Windows 上是 AltGr，
// Chromium 会判定 suggested_key 非法并**拒绝加载整个扩展**，所以永远别用 Alt。
async function pickImageOnPage(tab) {
  if (!tab || typeof tab.id !== 'number') return { ok: false, reason: '没有标签页' };
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pickImageInPage
    });
    return (frames && frames[0] && frames[0].result) || { ok: false, reason: '没有返回值' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

/** 截屏兜底：滚动到元素 → 截可见页 → 按设备像素 rect 裁剪成 PNG */
async function captureElementImage(payload) {
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: payload.tabId, frameIds: [payload.frameId || 0] },
      func: elementRectFor,
      args: [payload.srcUrl || '']
    });
    const rect = frames && frames[0] && frames[0].result;
    if (!rect || !rect.ok) return { ok: false, reason: (rect && rect.reason) || '找不到元素' };

    // captureVisibleTab 只能截当前可见标签页：必要时先激活，截完再还回去
    const [active] = await chrome.tabs.query({ active: true, windowId: payload.windowId });
    const needSwitch = !active || active.id !== payload.tabId;
    if (needSwitch) {
      await chrome.tabs.update(payload.tabId, { active: true });
      await sleep(150);
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(payload.windowId, { format: 'png' });

    if (needSwitch && active && active.id !== undefined) {
      chrome.tabs.update(active.id, { active: true }).catch(() => {});
    }

    const cropped = await cropDataUrl(dataUrl, rect);
    return {
      ok: true,
      b64: cropped.b64,
      mime: 'image/png',
      width: cropped.width,
      height: cropped.height,
      via: 'capture',
      captureNote: '截屏裁剪 ' + cropped.width + '×' + cropped.height
    };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

async function cropDataUrl(dataUrl, rect) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 不可用');
  ctx.drawImage(bmp, Math.round(rect.x), Math.round(rect.y), w, h, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await out.arrayBuffer());
  if (!bytes.length) throw new Error('裁剪结果为空');
  return { b64: bytesToB64(bytes), width: w, height: h };
}

/** 注入：找到目标元素、滚到视口中间、返回设备像素 rect。不能引用外部作用域 */
async function elementRectFor(srcUrl) {
  const urlOf = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.tagName === 'IMG') return el.currentSrc || el.src || '';
    const bg = getComputedStyle(el).backgroundImage || '';
    const m = bg.match(/url\((['"]?)(.+?)\1\)/);
    return m ? m[2] : '';
  };

  let candidates = Array.from(
    document.querySelectorAll('img, video, canvas, [style*="background-image"], [style*="background:"]')
  );
  let target = candidates.find((el) => urlOf(el) === srcUrl);

  if (!target) {
    target = candidates.find((el) => {
      const u = urlOf(el);
      return u && srcUrl && (u.includes(srcUrl) || srcUrl.includes(u));
    });
  }

  if (!target) return { ok: false, reason: '页面里找不到这张图对应的元素' };

  try {
    target.scrollIntoView({ block: 'center', inline: 'center' });
  } catch {
    /* 无所谓 */
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  let box = target.getBoundingClientRect();

  // 选中的元素太小（缩略图）→ 换页面上面积最大、且同源的那张图
  if (box.width * box.height < 10000 || box.width < 64 || box.height < 64) {
    let bestEl = null;
    let bestArea = 0;
    const srcHost = (() => {
      try {
        return new URL(srcUrl).host;
      } catch {
        return '';
      }
    })();
    for (const el of Array.from(document.images || [])) {
      const u = el.currentSrc || el.src || '';
      if (!u) continue;
      let host = '';
      try {
        host = new URL(u).host;
      } catch {
        continue;
      }
      if (srcHost && host !== srcHost) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width >= 64 && r.height >= 64) {
        bestArea = area;
        bestEl = el;
      }
    }
    if (bestEl) {
      console.log('[capture] 原元素太小，改用页面上最大的同源图', bestEl.currentSrc || bestEl.src);
      target = bestEl;
      box = target.getBoundingClientRect();
    }
  }
  const dpr = window.devicePixelRatio || 1;
  const pad = box.width < 64 || box.height < 64 ? 32 : 0;

  let x = Math.max(0, (box.left - pad) * dpr);
  let y = Math.max(0, (box.top - pad) * dpr);
  let w = (box.width + pad * 2) * dpr;
  let h = (box.height + pad * 2) * dpr;

  const vw = window.innerWidth * dpr;
  const vh = window.innerHeight * dpr;
  x = Math.min(x, Math.max(0, vw - 1));
  y = Math.min(y, Math.max(0, vh - 1));
  w = Math.max(1, Math.min(w, vw - x));
  h = Math.max(1, Math.min(h, vh - y));

  return { ok: true, x, y, w, h, dpr };
}

/** 字节 → base64（分块，避免超长字符串溢出） */function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

/**
 * 后台取图：Service Worker 带 host 权限，不受 CORS 限制。
 * 之前所有「页面内 fetch 跨域 → Failed to fetch」都走这里兜底。
 */
async function fetchImageInBackground(url, pageUrl) {
  try {
    const resp = await fetch(url, {
      credentials: 'include',
      // 图片不进 HTTP 缓存：否则每搜一张就在 profile 里留一份
      cache: 'no-store',
      // 有些图床看 Referer：带上来源页（后台 fetch 不能手写 Referer 头，只能用 referrer 选项）
      referrer: pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : undefined,
      referrerPolicy: 'no-referrer-when-downgrade'
    });
    if (!resp.ok) return { ok: false, reason: 'http-' + resp.status };
    const blob = await resp.blob();
    if (!blob || blob.size === 0) return { ok: false, reason: 'empty-body' };
    if (blob.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      ok: true,
      b64: bytesToB64(bytes),
      mime: blob.type || '',
      width: null,
      height: null,
      via: 'background',
      bytes: blob.size
    };
  } catch (e) {
    return {
      ok: false,
      reason:
        '后台取图失败（' +
        String((e && e.name) || '') +
        ' ' +
        String((e && e.message) || e) +
        '）'
    };
  }
}
function pickImageInPage() {
  return new Promise((resolve) => {
    if (window.__findSourcePicking) {
      resolve({ ok: false, reason: '已经在选择中' });
      return;
    }
    window.__findSourcePicking = true;

    const prevCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';

    let last = null;
    let lastOutline = '';

    const urlOf = (el) => {
      if (!el || el.nodeType !== 1) return '';
      if (el.tagName === 'CANVAS') {
        try {
          return el.toDataURL('image/png');
        } catch {
          return '';
        }
      }
      if (el.tagName === 'IMG') return el.currentSrc || el.src || '';
      const bg = getComputedStyle(el).backgroundImage || '';
      const m = bg.match(/url\((['"]?)(.+?)\1\)/);
      return m ? m[2] : '';
    };

    const cleanup = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      document.documentElement.style.cursor = prevCursor;
      if (last) last.style.outline = lastOutline;
      window.__findSourcePicking = false;
    };

    const finish = (v) => {
      cleanup();
      resolve(v);
    };

    const onMove = (e) => {
      const el = e.target;
      if (!el || el === last) return;
      if (last) last.style.outline = lastOutline;
      last = el;
      lastOutline = el.style.outline;
      el.style.outline = '2px solid #2563eb';
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target;
      const url = urlOf(el) || urlOf(el && el.parentElement);
      if (url) finish({ ok: true, srcUrl: url });
      else finish({ ok: false, reason: '这个元素没有图片地址' });
    };

    const onKey = (e) => {
      if (e.key === 'Escape') finish({ ok: false, reason: '已取消' });
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => finish({ ok: false, reason: '超时（20 秒没点）' }), 20000);
  });
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'capture-video-frame') return;

  if (!tab || typeof tab.id !== 'number') {
    // 有些版本不会给第二个参数：记录下来 + 自己查一次
    void setTask({ state: 'error', message: '命令收到了，但没拿到活动标签页（键位可能被浏览器占用）' });
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        const active = tabs && tabs[0];
        if (!active) {
          void setTask({ state: 'error', message: '找不到活动标签页' });
          return;
        }
        beginSearch(active, { kind: 'video' });
      })
      .catch((e) => void setTask({ state: 'error', message: '查询标签页失败：' + (e && e.message) }));
    return;
  }

  beginSearch(tab, { kind: 'video' });
});

/** 抓帧任务状态（面板据此显示「正在抓帧…/抓帧失败：…」） */
function setTask(patch) {
  return chrome.storage.session.set({ [TASK_KEY]: { at: Date.now(), ...patch } }).catch(() => {});
}

/** 抓帧失败的原因 → 给人看的话（视频拿不到帧必须明说，不能静默） */
const REASON_TEXT = {
  'video-not-found': '没找到这个 <video> 元素——可能它在跨域 iframe 里，或者已经被页面换掉了',
  'no-video-data': '视频还没解码出画面：先让它播一下（哪怕 1 秒）再右键',
  'tainted-frame': '这一帧拿不到：视频是跨域加载的（blob / m3u8 常见），canvas 被浏览器的跨域安全策略挡住了',
  'canvas-error': '这一帧拿不到：canvas 绘制失败',
  'too-large': '这一帧太大（超过 4MB），换个更小的视频或者直接截图',
  'unsupported-scheme': '这个地址类型不支持抓帧',
  'not-attempted': '没有尝到抓帧'
};

async function captureAndStore(payload) {
  const isVideo = payload.kind === 'video';
  let image = { ok: false, reason: 'not-attempted' };

  const canInject = isVideo || /^(https?:|data:|blob:)/i.test(payload.srcUrl);
  if (canInject) {
    try {
      const frames = await chrome.scripting.executeScript({
        target: { tabId: payload.tabId, frameIds: [payload.frameId] },
        func: isVideo ? grabVideoFrameInPage : grabImageInPage,
        args: [payload.srcUrl],
        injectImmediately: true
      });
      const r = frames && frames[0] && frames[0].result;
      if (r && r.ok && typeof r.b64 === 'string' && r.b64.length <= MAX_B64) {
        image = r;
      } else if (r && r.ok) {
        image = { ok: false, reason: 'too-large' };
      } else {
        image = { ok: false, reason: (r && r.reason) || 'no-result' };
      }
    } catch (e) {
      image = { ok: false, reason: 'inject-failed', detail: e && e.message ? e.message : String(e) };
    }
  } else {
    image = { ok: false, reason: 'unsupported-scheme' };
  }

  // 页面里取不到（跨域 fetch 必挂）→ 后台 fetch：SW 有 host 权限，不受 CORS 限制
  if (!image.ok && !isVideo && /^https?:/i.test(payload.srcUrl || '')) {
    const bg = await fetchImageInBackground(payload.srcUrl, payload.pageUrl);
    if (bg.ok && bg.b64.length <= MAX_B64) {
      image = bg;
    } else {
      image = {
        ok: false,
        reason: 'fetch-failed',
        detail:
          (image.detail ? image.detail + '；' : '') +
          (bg.ok ? '图太大' : bg.reason || '后台取图失败')
      };
    }
  }

  // 兜底：截当前可见页，按元素 rect 裁剪。人眼看得到什么就截什么，永远能拿到像素。
  if (!image.ok && !isVideo && payload.tabId !== undefined) {
    const shot = await captureElementImage(payload);
    if (shot.ok && shot.b64.length <= MAX_B64) {
      image = shot;
    } else if (shot && shot.reason) {
      image = {
        ok: false,
        reason: 'fetch-failed',
        detail: (image.detail ? image.detail + '；' : '') + '截屏兜底也失败：' + shot.reason
      };
    }
  }

  const note = image.ok
    ? ''
    : REASON_TEXT[image.reason] ||
      ('抓图失败：' + (image.detail || image.reason || '未知原因'));
  // 任务状态要无条件写：这样即使面板没拿到 pending，也能看到「抓帧失败：原因」
  if (isVideo) {
    void setTask({
      state: image.ok ? 'ok' : 'error',
      message: image.ok ? '抓到帧了' : note,
      tabId: payload.tabId,
      jobId: payload.id,
      reason: image.ok ? '' : image.reason || ''
    });
  }

  const current = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
  // 用户可能已经换了一张图，别覆盖新的那次搜索
  if (!current || current.id !== payload.id) return;

  await chrome.storage.session
    .set({ [PENDING_KEY]: { ...current, phase: 'ready', image, note: note || current.note || '' } })
    .catch(() => {});
}

/**
 * 抓 <video> 的当前帧。同样会被序列化注入页面，不能引用外部作用域。
 *
 * 注意 canvas 的跨域限制：drawImage 对跨域视频不会报错，但 toDataURL 会抛
 * SecurityError（canvas 被 taint）。这种情况必须如实返回 tainted-frame，
 * 由上层告诉用户「这一帧拿不到」，不能静默失败。
 */
async function grabVideoFrameInPage(srcUrl) {
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_EDGE = 1600;

  function pickBest(list) {
    // 优先正在播的，其次画幅最大的（播放器页面常同时存在预览/广告 video）
    const playing = list.find((v) => !v.paused && v.readyState >= 2 && v.videoWidth > 0);
    if (playing) return playing;
    const byArea = [...list].sort(
      (a, b) => (b.videoWidth || 0) * (b.videoHeight || 0) - (a.videoWidth || 0) * (a.videoHeight || 0)
    );
    return byArea[0] || null;
  }

  function findVideo() {
    const list = Array.from(document.querySelectorAll('video'));
    if (!list.length) return null;

    if (srcUrl) {
      const exact = list.find((v) => v.currentSrc === srcUrl || v.src === srcUrl);
      if (exact) return exact;
      const bySource = list.find((v) =>
        Array.from(v.querySelectorAll('source')).some(
          (s) => s.src === srcUrl || s.getAttribute('src') === srcUrl
        )
      );
      if (bySource) return bySource;
      // 明确点的是某个视频但地址对不上：只有一个视频时才赌它
      return list.length === 1 ? list[0] : null;
    }

    // 没有指定视频（快捷键 / 面板按钮）：挑正在播的、或画幅最大的
    return pickBest(list);
  }

  const video = findVideo();
  if (!video) return { ok: false, reason: 'video-not-found' };

  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (!vw || !vh || video.readyState < 2) return { ok: false, reason: 'no-video-data' };

  const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, reason: 'canvas-error' };

    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92); // 跨域会在这里抛 SecurityError
    const comma = dataUrl.indexOf(',');
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    if (!b64) return { ok: false, reason: 'canvas-error' };
    if (b64.length * 0.75 > MAX_BYTES) return { ok: false, reason: 'too-large' };

    return {
      ok: true,
      b64,
      mime: 'image/jpeg',
      width: w,
      height: h,
      via: 'video-frame',
      at: Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 10) / 10 : null
    };
  } catch (e) {
    const text = String((e && e.name) || '') + ' ' + String((e && e.message) || '');
    const tainted = /SecurityError|taint|insecure|cross-origin|not allowed/i.test(text);
    return { ok: false, reason: tainted ? 'tainted-frame' : 'canvas-error' };
  }
}

/**
 * 这个函数会被序列化后注入到页面里执行，不能引用外部作用域。
 * 优先用 canvas 取真实像素（还原缩放、避开原图超大），canvas 被 CORS 污染时
 * 退回页面内 fetch（带 cookie / referer），两者都失败就只传 URL。
 */
async function grabImageInPage(srcUrl) {
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_EDGE = 1600;
  const TIMEOUT_MS = 8000;

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('read-failed'));
      fr.readAsDataURL(blob);
    });
  }

  function stripDataUrl(dataUrl) {
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  }

  // 1) 找到页面上的 <img>，用 canvas 重新编码
  try {
    const imgs = Array.from(document.images || []);
    const img =
      imgs.find((i) => i.currentSrc === srcUrl) ||
      imgs.find((i) => i.src === srcUrl);
    if (img && img.complete && img.naturalWidth > 0) {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const b64 = stripDataUrl(dataUrl);
        if (b64.length * 0.75 <= MAX_BYTES) {
          return { ok: true, b64, mime: 'image/jpeg', width: w, height: h, via: 'canvas' };
        }
      }
    }
  } catch (e) {
    // canvas 被污染（跨域图片未开 CORS），继续走 fetch
  }

  // 2) 页面上下文 fetch：带 cookie，绕开防盗链
  try {
    // data: URL 直接解，不用 fetch
    if (/^data:/i.test(srcUrl)) {
      const comma = srcUrl.indexOf(',');
      const head = srcUrl.slice(0, comma);
      const b64 = srcUrl.slice(comma + 1);
      const mime = (head.match(/data:([^;,]+)/) || [])[1] || 'image/jpeg';
      return { ok: true, b64, mime, width: null, height: null, via: 'data-url' };
    }

    const resp = await withTimeout(
      fetch(srcUrl, { credentials: 'include', referrer: location.href, cache: 'force-cache' }),
      TIMEOUT_MS
    );
    if (!resp.ok) return { ok: false, reason: 'http-' + resp.status };
    const blob = await resp.blob();
    if (!blob || blob.size === 0) return { ok: false, reason: 'empty-body' };
    if (blob.size > MAX_BYTES) return { ok: false, reason: 'too-large' };
    const dataUrl = await blobToDataUrl(blob);
    return {
      ok: true,
      b64: stripDataUrl(dataUrl),
      mime: blob.type || 'image/jpeg',
      width: null,
      height: null,
      via: 'fetch'
    };
  } catch (e) {
    // 把「请求的是谁」写进原因，否则只能看到一句 Failed to fetch
    const host = (() => {
      try {
        return new URL(srcUrl).host;
      } catch {
        return '(无效地址)';
      }
    })();
    const hint = (() => {
      try {
        if (typeof document.querySelector !== 'function') return '';
        const sel = 'img[src="' + String(srcUrl).replace(/"/g, '\\"') + '"]';
        return document.querySelector(sel) ? '' : '；页面里没有能对上的 <img>（可能被 canvas / 背景图替换）';
      } catch {
        return '';
      }
    })();
    return {
      ok: false,
      reason:
        '页面内取图失败（' +
        ((typeof location !== 'undefined' && location.origin) || '(未知 origin)') +
        ' → ' +
        host +
        '）：' +
        String((e && e.name) || '') +
        ' ' +
        String((e && e.message) || e) +
        hint +
        '\n请求地址: ' +
        String(srcUrl).slice(0, 160)
    };
  }
}

/* ==========================================================================
 * ascii2d：Cloudflare 在路由之前就拦 HTTP 请求，只能走「真实浏览器通道」
 *   1) 开一个后台标签页打开 ascii2d（正常导航，Cloudflare 按真实用户放行）
 *   2) 注入解析器 + 搜索脚本，用同源 fetch 提交图片（文件或 URL）
 *   3) 拿到结果就地解析，返回给侧边栏，然后关掉标签页
 * ========================================================================== */

const ASCII2D_ORIGIN = 'https://ascii2d.net/';
const ASCII2D_TAB_TIMEOUT_MS = 15000;
const ASCII2D_TOTAL_TIMEOUT_MS = 30000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;

  // 自检页用：手动重建右键菜单（菜单丢了时的修复入口）
  if (msg.type === 'menu.ensure') {
    ensureContextMenu().then((r) => sendResponse({ ...r, menuId: MENU_IMAGE_ID }));
    return true;
  }

  // 侧边栏按钮：抓当前标签页里正在播的那一帧（面板已经开着，不再调 open）
  if (msg.type === 'video.capture') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) {
          sendResponse({ ok: false, message: '没有找到活动标签页' });
          return;
        }
        const payload = beginSearch(tab, { kind: 'video', openPanel: false });
        sendResponse(payload ? { ok: true, jobId: payload.id } : { ok: false, message: '这个标签页不可用' });
      })
      .catch((e) => sendResponse({ ok: false, message: e && e.message ? e.message : String(e) }));
    return true;
  }

  // 自检页用：跑一次 ascii2d 的表单提交实验（走的就是主链路，原样回报阶段）
  if (msg.type === 'ascii2d.formProbe') {
    searchAscii2d(msg.payload)
      .then((r) => {
        const out = { ...r };
        if (Array.isArray(out.items)) {
          out.itemCount = out.items.length;
          delete out.items;
        }
        sendResponse(out);
      })
      .catch((e) => sendResponse({ ok: false, phase: 'exception', message: String(e && e.message) }));
    return true;
  }

  // 侧边栏用：把图片上传到 Google 视觉搜索（走页面上下文，同源 POST）
  if (msg.type === 'google.lensUpload') {
    lensUploadViaTab(msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, phase: 'request', message: String(e && e.message) }));
    return true;
  }

  // 侧边栏用：把图「粘贴」进 yandex.com/images 页面，走网页版自己的上传入口
  if (msg.type === 'yandex.pasteUpload') {
    yandexUploadViaTab(msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: String(e && e.message) }));
    return true;
  }

  if (msg.type !== 'ascii2d.search') return undefined;
  searchAscii2d(msg.payload)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, message: 'ascii2d 通道异常：' + (e && e.message ? e.message : String(e)) }));
  return true; // 异步 sendResponse
});

async function searchAscii2d(payload) {
  if (!payload || !payload.b64) return { ok: false, message: 'ascii2d 需要图片字节' };

  const t0 = Date.now();
  let tabId = null;

  try {
    const tab = await chrome.tabs.create({ url: ASCII2D_ORIGIN, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId, 12000);

    // 等页面 JS 生成真正的 input[type=file]（静态 HTML 里没有）
    let ready = null;
    for (let i = 0; i < 20; i += 1) {
      try {
        const frames = await chrome.scripting.executeScript({ target: { tabId }, func: ascii2dProbeForms });
        ready = frames && frames[0] && frames[0].result;
      } catch {
        ready = null;
      }
      if (ready && ready.ready) break;
      await sleep(500);
    }

    const waitMs = Date.now() - t0;
    console.log('[ascii2d] ready', JSON.stringify({ waitMs, ready }));

    if (!ready || !ready.ready) {
      return {
        ok: false,
        phase: 'challenge',
        waitMs,
        message: '10 秒内页面没有出现 file input（可能还是校验页）',
        href: ready && ready.href,
        forms: ready && ready.forms,
        body: ready && ready.body,
        openUrl: ASCII2D_ORIGIN
      };
    }

    // 把文件塞进页面自己的 input，再点它自己的提交按钮
    let sub = null;
    try {
      const frames = await chrome.scripting.executeScript({
        target: { tabId },
        func: ascii2dSubmitFile,
        args: [{ b64: payload.b64, mime: payload.mime || 'image/png' }]
      });
      sub = frames && frames[0] && frames[0].result;
    } catch (e) {
      sub = { ok: false, message: '注入失败：' + (e && e.message) };
    }

    console.log('[ascii2d] submit', JSON.stringify({ waitMs, sub }));

    if (!sub || !sub.ok) {
      return {
        ok: false,
        phase: 'request',
        waitMs,
        message: (sub && sub.message) || '塞文件失败',
        sub,
        openUrl: ASCII2D_ORIGIN
      };
    }

    // 等结果页
    const deadline = Date.now() + 20000;
    let read = null;
    while (Date.now() < deadline) {
      await sleep(700);
      try {
        const frames = await chrome.scripting.executeScript({ target: { tabId }, func: ascii2dReadResults });
        read = frames && frames[0] && frames[0].result;
      } catch {
        continue;
      }
      if (read && read.ready && (read.hasBox || read.isResultPage || read.challenge)) break;
    }

    console.log(
      '[ascii2d] after submit',
      JSON.stringify({ href: read && read.href, hasBox: read && read.hasBox, isResultPage: read && read.isResultPage })
    );

    if (!read) {
      let diag = null;
      try {
        const fr = await chrome.scripting.executeScript({ target: { tabId }, func: ascii2dProbeForms });
        diag = fr && fr[0] && fr[0].result;
      } catch {
        diag = null;
      }
      return {
        ok: false,
        phase: 'timeout',
        waitMs,
        sub,
        message: '提交后 20 秒没有页面状态',
        href: diag && diag.href,
        forms: diag && diag.forms,
        body: diag && diag.body,
        openUrl: ASCII2D_ORIGIN
      };
    }

    const common = {
      waitMs,
      sub,
      filesSet: sub.filesSet,
      via: sub.via,
      action: sub.action,
      method: sub.method,
      location: read.href
    };

    if (read.challenge) return { ok: false, phase: 'challenge', ...read, ...common };

    if (read.hasBox) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['engines/ascii2d-parse.js'] });
      const parsed = await chrome.scripting.executeScript({ target: { tabId }, func: ascii2dCollectItems });
      const out = parsed && parsed[0] && parsed[0].result;
      if (out && Array.isArray(out.items) && out.items.length) {
        return { ok: true, items: out.items, openUrl: read.href, hasBox: true, ...common };
      }
      return { ok: false, phase: 'parse', ...read, ...common, message: '有结果块但没解析出来处' };
    }

    return {
      ok: false,
      phase: read.isResultPage ? 'empty' : 'submit',
      ...read,
      ...common,
      message: read.isResultPage ? '页面正常，没有匹配结果' : '提交后回到了首页'
    };
  } catch (e) {
    return {
      ok: false,
      phase: 'nav',
      message: '打开/操作 ascii2d 失败：' + (e && e.message ? e.message : String(e)),
      openUrl: ASCII2D_ORIGIN
    };
  } finally {
    if (tabId !== null && tabId !== undefined) chrome.tabs.remove(tabId).catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === 'complete') finish();
      })
      .catch(() => finish());
  });
}

/**
 * 注入：把文件塞进页面 JS 生成的那个 input[type=file]，再点它自己的提交按钮。
 * 不自己拼 FormData、不自己 POST —— 走网页版本来的逻辑。
 */
async function ascii2dSubmitFile(opt) {
  const input = document.querySelector('input[type="file"]');
  if (!input) return { ok: false, message: '页面里仍然没有 file input' };

  const form = input.form || input.closest('form');
  const info = {
    inputName: input.name || '',
    action: form ? form.getAttribute('action') || '' : '',
    method: form ? (form.getAttribute('method') || '').toLowerCase() : '',
    enctype: form ? form.getAttribute('enctype') || '' : ''
  };

  try {
    const bin = atob(opt.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const mime = opt.mime || 'image/png';
    const ext = /png/i.test(mime) ? 'png' : /gif/i.test(mime) ? 'gif' : 'jpg';
    const file = new File([new Blob([bytes], { type: mime })], 'image.' + ext, { type: mime });

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
  } catch (e) {
    return { ok: false, message: '设置 files 失败：' + (e && e.message), ...info };
  }

  const filesSet = input.files ? input.files.length : 0;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // 优先点页面自己的提交按钮（最接近人工操作）
  let via = '';
  let buttonText = '';
  try {
    const scope = form || document;
    const buttons = Array.from(scope.querySelectorAll('button, input[type="submit"]'));
    const btn = buttons.find((b) => /検索|search|アップロード/i.test((b.textContent || '') + (b.value || '')));
    if (btn) {
      buttonText = (btn.textContent || btn.value || '').trim().slice(0, 20);
      btn.click();
      via = 'click-button';
    } else if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      via = 'requestSubmit';
    } else if (form) {
      form.submit();
      via = 'form.submit';
    } else {
      via = 'no-form';
    }
  } catch (e) {
    via = 'error:' + (e && e.message);
  }

  return { ok: true, ...info, filesSet, via, buttonText };
}

function ascii2dProbeForms() {
  const forms = Array.from(document.querySelectorAll('form')).map((f) => ({
    action: f.getAttribute('action') || '',
    method: (f.getAttribute('method') || '').toLowerCase(),
    inputs: Array.from(f.querySelectorAll('input[name], select[name], textarea[name]')).map((i) => i.name),
    hasFile: Boolean(f.querySelector('input[type="file"]'))
  }));
  const hasFileInput = Boolean(document.querySelector('input[type="file"]'));
  return {
    ready: hasFileInput || forms.some((f) => f.hasFile),
    href: location.href,
    title: document.title || '',
    forms,
    body: String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 200)
  };
}

/** 注入：读 ascii2d 页面状态（不解析）。不能引用外部作用域 */
function ascii2dReadResults() {
  const title = document.title || '';
  const href = location.href || '';
  const html = document.documentElement ? document.documentElement.innerHTML : '';
  const head = String(html || '').slice(0, 4000);

  const challenge =
    /just a moment|attention required|cf-browser-verification|checking your browser/i.test(title) ||
    /cf-chl|challenge-platform|cf-mitigated/i.test(head);

  const text = document.body ? String(document.body.innerText || '') : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  console.log('[ascii2d] result page text:', flat.slice(0, 2000));

  return {
    ready: document.readyState === 'complete',
    href,
    isResultPage: /\/search\//.test(href),
    title,
    challenge,
    hasBox: Boolean(document.querySelector('.item-box')),
    noResult: /見つかりません|該当する|ありません|0 件/i.test(text),
    interval: /検索間隔|間隔が短|しばらく|時間をおいて|アクセスが集中|too many requests|rate.?limit/i.test(text),
    status: 200,
    htmlLength: html ? html.length : 0,
    body: flat.slice(0, 600)
  };
}

/** 注入：用已注入的解析器把当前结果页转成条目。不能引用外部作用域 */
function ascii2dCollectItems() {
  if (typeof globalThis.__parseAscii2d !== 'function') return { items: [] };
  return { items: globalThis.__parseAscii2d(document, 'https://ascii2d.net/') };
}

/* ==========================================================================
 * Google Lens：在 www.google.com 页面上下文里 POST searchbyimage/upload
 * ========================================================================== */

async function lensUploadViaTab(payload) {
  if (!payload || !payload.b64) return { ok: false, phase: 'request', message: '没有图片字节' };

  let createdByUs = false;
  let tabId = null;

  try {
    const existing = await chrome.tabs.query({ url: ['https://www.google.com/*'] });
    tabId = existing && existing[0] ? existing[0].id : null;

    if (!tabId) {
      const tab = await chrome.tabs.create({ url: 'https://www.google.com/', active: false });
      tabId = tab.id;
      createdByUs = true;
    }

    await waitForTabComplete(tabId, 15000);

    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      func: lensUploadInPage,
      args: [payload.b64, payload.mime || 'image/jpeg']
    });
    const res = frames && frames[0] && frames[0].result;

    console.log('[lens] upload result', JSON.stringify(res && { status: res.status, len: res.htmlLength }));
    if (!res) return { ok: false, phase: 'request', message: '注入没有返回结果' };
    return res;
  } catch (e) {
    return { ok: false, phase: 'nav', message: '打开/注入 Google 页面失败：' + (e && e.message ? e.message : String(e)) };
  } finally {
    if (createdByUs && tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

/** 注入到 www.google.com；只能用参数，不能引用扩展作用域 */
async function lensUploadInPage(imageB64, mime) {
  try {
    const bin = atob(imageB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

    const fd = new FormData();
    fd.append('encoded_image', new Blob([bytes], { type: mime || 'image/jpeg' }), 'image.jpg');
    fd.append('image_content', '');

    const r = await fetch('https://www.google.com/searchbyimage/upload', {
      method: 'POST',
      body: fd,
      credentials: 'include',
      redirect: 'follow'
    });

    const text = await r.text();
    const abuse = /sorry|captcha|unusual traffic|detected unusual/i.test(text);

    return {
      ok: r.ok,
      phase: r.ok ? 'ok' : abuse ? 'challenge' : 'http',
      status: r.status,
      finalUrl: r.url || '',
      htmlLength: text.length,
      html: r.ok ? text : '',
      body: r.ok ? '' : String(text).replace(/\s+/g, ' ').slice(0, 300)
    };
  } catch (e) {
    return { ok: false, phase: 'request', message: String((e && e.name) || '') + ': ' + String((e && e.message) || e) };
  }
}

/* ==========================================================================
 * Yandex：开 yandex.com/images 后台标签页，把图塞给页面自己的上传入口
 * ========================================================================== */

async function yandexUploadViaTab(payload) {
  if (!payload || !payload.b64) return { ok: false, reason: '没有图片字节' };

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: 'https://yandex.com/images/', active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId, 20000);

    // 等页面把上传入口渲染出来
    let ready = null;
    for (let i = 0; i < 20; i += 1) {
      try {
        const frames = await chrome.scripting.executeScript({ target: { tabId }, func: yandexProbeUploader });
        ready = frames && frames[0] && frames[0].result;
      } catch {
        ready = null;
      }
      if (ready && ready.ready) break;
      await sleep(500);
    }
    console.log('[yandex] ready', JSON.stringify(ready));

    let injected = null;
    try {
      const frames = await chrome.scripting.executeScript({
        target: { tabId },
        func: yandexPasteInPage,
        args: [payload.b64, payload.mime || 'image/png']
      });
      injected = frames && frames[0] && frames[0].result;
    } catch (e) {
      injected = { error: String((e && e.message) || e) };
    }
    console.log('[yandex] 注入结果', JSON.stringify(injected));

    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      const info = await chrome.tabs.get(tabId).catch(() => null);
      const url = (info && (info.url || info.pendingUrl)) || '';
      if (/cbir_id=/.test(url)) return { ok: true, finalUrl: url, injected, ready: ready && ready.ready };
    }

    const info2 = await chrome.tabs.get(tabId).catch(() => null);
    const finalUrl = (info2 && (info2.url || info2.pendingUrl)) || '';
    return {
      ok: false,
      reason: '页面没有跳到结果页（没找到上传入口或上传被拒）',
      tabUrl: finalUrl,
      injected,
      ready: ready && ready.ready
    };
  } catch (e) {
    return { ok: false, reason: '打开 yandex 页面失败：' + (e && e.message ? e.message : String(e)) };
  } finally {
    if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

/** 注入：看上传入口出没出来 */
function yandexProbeUploader() {
  const inputs = document.querySelectorAll('input[type="file"]').length;
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
    .map((b) => (b.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 12);
  return {
    ready: inputs > 0,
    href: location.href,
    fileInputs: inputs,
    buttons,
    body: String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 160)
  };
}

/** 注入：造 File，塞给页面自己的 input / drop / paste 入口 */
async function yandexPasteInPage(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

  const ext = /png/i.test(mime) ? 'png' : /gif/i.test(mime) ? 'gif' : 'jpg';
  const file = new File([new Blob([bytes], { type: mime })], 'image.' + ext, { type: mime });
  const dt = new DataTransfer();
  dt.items.add(file);

  const result = { tried: [], filesSet: 0, via: '', accepted: false };

  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  result.tried.push('file-input:' + inputs.length);
  for (const input of inputs) {
    try {
      input.files = dt.files;
      result.filesSet += input.files ? input.files.length : 0;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      result.tried.push('input-error:' + (e && e.message));
    }
  }

  try {
    const target = document.querySelector('[class*="upload"], [class*="search"], form') || document.body;
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    result.accepted = target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    result.tried.push('drop');
  } catch (e) {
    result.tried.push('drop-error:' + (e && e.message));
  }

  try {
    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    result.tried.push('paste');
  } catch (e) {
    result.tried.push('paste-error:' + (e && e.message));
  }

  const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) =>
    /поиск|search|загрузить/i.test(b.textContent || '')
  );
  if (btn && result.filesSet > 0) {
    btn.click();
    result.via = 'click-button';
  }

  console.log('[yandex] paste 尝试:', JSON.stringify(result));
  return result;
}
