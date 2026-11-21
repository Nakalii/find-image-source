# 找图出处 · Find Image Source

**从零写的**，约 2300 行，没有基于任何现有扩展改，也没有复制第三方代码（详见文末「来源与许可」）。
许可：MIT（`LICENSE`）。

**Chrome 116+** 扩展（`chrome.sidePanel.open()` 需要 116）。Edge / Brave 同内核理论上可用，
但只在 Chrome 的 API 上写的，Edge 的侧边栏实现没实测。
在任意网页的图片上点右键 →「用这张图找出处」，侧边栏里并排显示

| 列 | 干什么 | 方式 |
| --- | --- | --- |
| **SauceNAO** | 动漫 / 插画 / 本子出处 | JSON API（有 Key）/ 匿名 HTML（无 Key），默认放开到 50% |
| **TraceMoe** | 动画截图是第几集第几秒 | 官方 API |
| **Google Lens** | 真实照片 / 商品 / 网页配图 | 上传图片后解析结果页（实验性） |
| **ascii2d** | 同人图 / 二创 | 后台标签页过 Cloudflare 后抓 HTML |
| **Yandex** | 照片 / 图库溯源 | 跳转 |

侧边栏太窄时把左边缘往左拖宽即可多列并排；也可以点右上角「宽屏」在标签页里打开。

## 装进浏览器

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）。
2. 右上角打开「开发者模式 / Developer mode」。
3. 点「加载已解压的扩展程序 / Load unpacked」，选择本目录：
   `image-source-finder`（就是包含 `manifest.json` 的那一层，**不要**选里面的子目录）。
4. 工具栏出现放大镜图标即装好了。图标点一下也能打开侧边栏。
   （Edge 会把解压加载的扩展排在列表**最下面**的「来自其他源 / 已解压缩」区域，
   别只看上半截就以为没装上。工具栏上的图标若没被固定，在地址栏右边的拼图菜单里。）

**选目录时认一下：** 被选中的那一层必须直接包含 `manifest.json`，同级还应该有
`background.js`、`sidepanel.html`、`engines/`、`icons/`、`lib/`。
本扩展**没有** `content-script.js`——如果你看到这个文件，说明选错目录了。

如果「加载已解压的扩展程序」点了没反应、列表里也没多出来（Edge 偶尔静默失败），
先跑这条检查：

```bash
node tools/test-manifest.mjs
```

它会查三件最常导致静默失败的事：manifest 是否带 UTF-8 BOM、JSON 能否解析、
manifest 引用的文件是否都存在。

想在**不启动浏览器**的情况下确认「到底装没装上」（比如界面里看不到卡片、但不确定是没装
还是 UI 没刷新）：

```bash
node tools/check-edge-install.mjs
```

它直接读 Chrome/Edge profile 里的 `Secure Preferences`，按扩展路径算出 ID 去查登记记录，
输出版本、权限、启用状态、首次安装/最后更新时间。注意 `developer_mode` 在
**Secure Preferences** 里，不在 `Preferences`——只看后者会误以为开发者模式没开。

首次右键时如果 Chrome 没弹菜单，刷新一下页面（有些页面在扩展装好前就加载完了）。

### 装完先跑自检（可选但推荐）

**最省事的入口（0.2.1 起）**：`edge://extensions` → 本扩展卡片 →「**扩展程序选项**」，
自检页直接在新标签页打开。

也可以手输地址，但**扩展 ID 必须抄对**：

```
chrome-extension://<扩展ID>/selftest.html
```

抄错的典型症状是页面报 `ERR_BLOCKED_BY_CLIENT`、地址栏还把 `chrome-` 前缀吞掉——
这是因为 Chromium 对**不存在的扩展 ID** 就返回这个错误，不是"扩展没激活"。
拿正确 ID 的两个办法：

```bash
node tools/check-edge-install.mjs        # 会打印「按该路径算出的扩展 ID」
```

或者打开 `edge://extensions/?id=<ID>`（能从卡片详情页的地址栏里看到）。

页面会：

- 逐项打 OK/FAIL：权限、storage 读写、四个引擎模块能否加载；
- 探测各家能不能连上（只请求首页，**不消耗搜索额度**）。ascii2d 显示 403 是正常的，
  那是 Cloudflare 挑战，说明网络通、但必须走后台标签页；
- 一个「用示例图跑一次真实搜索」按钮：抓一张公开图片、连字节一起写进搜索任务，
  点工具栏图标打开侧边栏就能看到五列真实结果（Lens 会真的走上传）。适合装完第一次
  确认整条链路通不通（会消耗 1 次 SauceNAO 额度）。
- 一个「重建右键菜单」按钮：右键菜单项丢了的时候点它，后台会先删后建，并把失败原因
  （`chrome.runtime.lastError` 原文）显示出来。

## 用法

- 网页图片右键 →「用这张图找出处」。
- 网页**视频**右键 →「用当前这一帧找出处」：把 `<video>` 当前画面画到 canvas 取字节，
  暂停在哪就搜哪；抓不到帧会明说原因（见下面「视频帧」一节），不会静默失败。
- **播放器自己接管了右键时**（B 站、YouTube 这类会 `preventDefault` 掉 contextmenu，
  原生菜单根本不出现），有三条不依赖页面右键的入口：
  1. 快捷键 **Ctrl+Shift+Y**
  2. **右键工具栏上的扩展图标** →「抓这一页视频的当前帧」（最稳，不依赖任何键位）
  3. 侧边栏右上角「**抓帧**」按钮

  抓到的是当前标签页里正在播的那一帧；多个 video 时优先挑正在播的，其次画幅最大的。
  键位可以在 `edge://extensions/shortcuts` 里改。

  **键位有三条禁令（都是踩出来的）：**
  - 不要用 `Ctrl+L` / `Ctrl+T` / `Ctrl+W` 这类浏览器自带键，浏览器先吃掉；
  - 不要用 `Alt+Shift`，Windows 上它是输入法/键盘布局切换；
  - **不要用 `Ctrl+Alt`**——Windows 把它当 AltGr，而且写进 `suggested_key.chromeos` 会让
    Chromium 判定 manifest 非法、**整个扩展加载失败**（只在点「重新加载」时弹一个框）。
- 没有网页可右键时：点右上角「本地图」选文件，或把图片**拖进侧边栏**，或
  <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴（Win+Shift+S 截图直接粘）。大图会自动压到 1600px 内。
- 每家各占一列，谁先返回谁先显示，互不阻塞。每列右上角显示条数和耗时。
- **相似度门槛默认放开了**：SauceNAO 的 `minsim` 默认是 80%，会把裁剪过的本子图（常常
  只有 50～79%）在服务端直接吃掉，所以现在显式传 50。低分候选照常列出来，只是标灰。
  只想看高分的，去底部「相似度门槛」勾上「只看 ≥80%」，勾完会立刻重搜当前这张。
- 相似度 ≥85% 绿色、≥60% 橙色，其余灰色。ascii2d 不给数值，只给「候选 #n」。
- 结果里的**标题**就是链接，点标题直达第一个出处；下面最多列 3 个来源链接，都是**完整 URL**
  （含路径，不是站点首页），文字是「站点名 · 路径尾巴」，悬停有 `title` 显示全地址。
  打不开的来源会给一句中性提示（只给了首页 / 需要登录），不让按钮看着像坏了。
- **Google Lens 列会真的上传你的图**（带 cookie），所以热门站点、防盗链的图也能搜；
  解析不出来源时它会退化成一个「在 Lens 里看这次的结果」按钮，不给你假链接。
- 最后一列 Yandex 是跳转：它没有公开上传 API，只把公开图片地址交过去，
  点开在新标签页出结果。**找真实照片、网页配图的出处时，Lens / Yandex 比三个动漫引擎有用。**
- 「重搜」用同一张图再查一遍；某一家失败时，那一列里有「只重试这一家」。
- 底部「**复制本次结果摘要**」：把版本、相似度门槛、每家条数与相似度、前三条出处压成一段文本，
  粘出来就能对比，不用截图。

### 怎么做一次可控的命中率测试

别凭感觉，按这个流程留证据：

1. 同一张图准备两个版本：**完整页** vs 你实际会截的**局部**（带对白框/边框，别只抠脸）
3. 再搜局部图，同样记录
4. 各点一次「复制本次结果摘要」，两段文本贴在一起对比
5. 再勾上「只看 ≥80%」重搜一次，看消失的是不是正好 50～79% 那批

判据：

| 现象 | 说明 |
| --- | --- |
| 局部图在 SauceNAO 出现 50～79% 的条目 | `minsim=50` 生效（以前这些会被服务端吃掉） |
| 两家都空 | 更可能是库里没有这张图，不是参数问题——换一张或补 ascii2d 特征搜索 |

### SauceNAO：JSON API 要 Key，但匿名 HTML 模式能用

2026 年的实际情况（实测 + 公开资料）：

- `output_type=2` 的 **JSON API 只对带 Key 的账号开放**。匿名调用返回
  `{"header":{"status":-1,"message":"The anonymous account type does not permit API usage."}}` + HTTP 403。
- 但**网页版匿名搜索是通的**（官网不登录就能搜），所以没 Key 时本扩展改抓 HTML 结果页
  （`engines/saucenao-html-parse.js`），填了 Key 才切回 JSON。

所以 **Key 是可选项（推荐）**：不填也能搜（额度低），填了走 JSON，字段更全、少一层解析风险、额度更高。

**Key 在哪：** <https://saucenao.com/user.php?page=search-api>
注意**不是**「账号」页——账号页只显示 `api access: enabled` 那一行，看不到 Key，这一页很容易被误认成
「要升级才有 Key」。免费账号就有 Key（带 Key 约 5 次/30 秒、200 次/天，官方会调整）。
要注册就去 <https://saucenao.com/user.php?page=register>（邮箱 + 验证码），激活后回到 API 页复制。

保存后会**立刻用当前这张图重搜一次**。Key 存在 `chrome.storage.local`，**不走 `storage.sync`**，
不会跟着浏览器账号云同步——底部那行会显示「已保存 abcd…wxyz（只存在本机，不云同步）→ 走 JSON API」。

**这个输入框在面板的哪：三个入口都通到同一份设置**

1. **面板右上角「⚙ 设置」** —— 点一下会展开底部设置区并聚焦输入框（最直接）
2. **面板底部**折叠区「🔑 SauceNAO API Key（点这里填写）」
3. **「读剪贴板」按钮** —— 先把 Key 复制到剪贴板，点这一个按钮就行，**不用点输入框、不用打字**
   （需要 `clipboardRead` 权限；装/重载时会多一条「读取你复制的内容」的提示）
4. **扩展详情 →「扩展程序选项」** —— 打开的是「设置与自检」页，里面同样有输入框和「读剪贴板」
   （0.7.3 之前那页只有诊断信息，点了会以为「没反应」）

> **保存按钮不会「清空」**：输入框为空时点「保存」只是提示「Key 没有改动」。
> 要清掉 Key 必须点旁边的「**清除**」。（以前空输入会直接把 Key 写空，教训。）

卡片底部的额度写成 **「30 秒窗口 3/4 · 今日 87/100」**：前者是 SauceNAO 的 `short_remaining`
（30 秒滑动窗口内还能请求几次），不是当天总量；后者是 `long_remaining`/`long_limit`。
之前只写「额度剩余 1」容易让人以为是今天的额度，其实是窗口余量。

## 工作原理

- `background.js`：注册右键菜单；点击时**同步**调用 `chrome.sidePanel.open()`
  （晚一步用户手势就失效），然后在页面上下文里取图片字节。
- 取图顺序：`<img>` → canvas 重编码（缩到 1600px 内）→ 页面内 `fetch`
  （带 cookie / referer，绕防盗链）→ 都不行就只把 URL 交给引擎。
- 图片字节写进 `chrome.storage.session`，侧边栏监听变化后开始搜索；抓图超过 12 秒
  就自动降级成链接模式，不会一直转圈。
- SauceNAO / TraceMoe / Google Lens 的请求从侧边栏直接发出，靠 `host_permissions` 绕过 CORS。
- ascii2d 因为 Cloudflare，只能由后台开标签页代跑（见下一节）。

### 视频帧怎么抓的

右键菜单在 `contexts: ['image', 'video']` 上各注册一项。视频那项走的是另一条注入路径：
在页面里找到 `<video>`（按 `src` / `currentSrc` / `<source>` 匹配，页面只有一个视频时兜底），
`drawImage` 画到 canvas，`toDataURL('image/jpeg')` 取字节，尺寸同样压到 1600px 内。

失败一律**明说**，不会悄悄退化成「拿视频地址去搜」：

| 情况 | 卡片里显示 |
| --- | --- |
| 视频是跨域加载的（blob / m3u8 常见） | 「这一帧拿不到：canvas 被跨域安全策略挡住」，并给本地图入口 |
| 还没解码出画面 | 「先让它播一下再右键」 |
| 页面里找不到 `<video>` | 「可能在跨域 iframe 里，或已被页面换掉」 |
| 帧太大（>4MB） | 「换个更小的视频或直接截图」 |

跨域视频这条路是浏览器安全策略挡的，绕不过去——正确做法就是拿截图/本地图进来。

### 每个引擎都有独立超时（悬挂不会一直转圈）

面板给每一列单独一个 `AbortController` + 超时：默认 **20 秒**，ascii2d 60 秒
（这两家本来就慢）。超时会中断该列的请求、把状态改成**超时**并说明原因，
不会让整列永远停在「搜索中」。其它列不受影响。

| 状态 | 含义 |
| --- | --- |
| 需要代理 | 直连被拒 / 网络路径不通 |
| 人机校验 | 被当成自动化请求（换节点，或先在浏览器里过一次校验） |
| 被拒绝 | 请求到了、通了，但对方不认这次请求 |
| 超时 | 到点没响应，已中断 |

### 失败分类（不让「403」和「被墙」混成一句「失败」）

| 现象 | 判定 | 卡片上写 |
| --- | --- | --- |
| `fetch` 抛 `TypeError` / `Failed to fetch` / 超时 | 网络路径不通 | **需要代理**（网络不通或被拦截） |
| HTTP 403 / 451，且不是人机校验页 | 直连被拒绝 | **需要代理**（直连被拒绝） |
| 响应头有 `Cf-Mitigated`，或页面是 `Just a moment...` 这类 | 人机校验 | **人机校验**（先在浏览器里打开一次这个站点） |
| 其它 | 真失败 | 失败 + HTTP 状态码 |

两家以上同时「需要代理」时，面板顶部合并成一行，不再每张卡片各自红一片：

```
这几列需要代理才能用，当前是直连：Google Lens、ascii2d
```

阈值取 2 而不是 3：跳转类的列不发请求，永远凑不满三家；两个互不相干的站点同时网络失败，
基本就说明是整条网络路径的问题。

### Google Lens 怎么接的

打的是经典上传入口（`POST https://www.google.com/searchbyimage/upload`，
multipart 字段 `encoded_image`、`sbisrc`、`image_content`），Google 会 302 到 Lens 的结果页，
`fetch` 跟随后 `resp.url` 就是这次搜索的结果地址。之所以在浏览器里做而不是服务端：

- 请求**带着用户的 cookie 和真实 TLS 指纹**，跟人手动上传没区别，不容易撞人机校验；
- 图片字节是我们自己读出来的，所以登录可见 / 防盗链的图也能传上去（Yandex 那种
  「只交 URL」的做法就做不到）。

拿到结果页后由 `engines/google-parse.js` 抽来源（还原 Google 的 `/url?q=` 包装链接、
过滤自家域名、去重）。这一列**故意做成不会废**：

| 情况 | 表现 |
| --- | --- |
| 抽到来源 | 列出站点 + 链接，点开就是出处 |
| 抽不到（改版 / 人机校验 / 空结果） | 退化成「在 Lens 里看这次的结果」按钮 |
| 被转到 Cookie 同意页 | 提示先去 google.com 同意一次 |
| 没有图片字节 | 用 `lens.google.com/uploadbyurl` 跳转 |

### ascii2d 为什么要走「后台标签页」

ascii2d 前面挂着 Cloudflare managed challenge，而且是**在路由之前**就拦：
直接 `fetch` 不管补 UA / Referer / CSRF 都只会拿到 `403 Cf-Mitigated: challenge`，
它在 HTTP 层之下靠 TLS/HTTP2 指纹判定（这是实测结论，不是猜的）。它也没有官方 API。

所以 ascii2d 这一列是这样跑的：

1. 后台开一个后台标签（`active:false`，不抢焦点）打开 `ascii2d.net` —— 真实浏览器导航，Cloudflare 按正常用户放行；
2. 往这个页面注入 `engines/ascii2d-parse.js` 和一段搜索脚本，用**同源** `fetch` 提交图片
   （文件走 `POST /search/file`；只有 URL 时先取首页的 `authenticity_token` 再 `POST /search/uri`）；
3. 结果就地解析成条目，回给侧边栏，**标签页自动关闭**。

代价是这一列比另外两家慢（约 5–15 秒，含 Cloudflare 校验时间），
搜索时会短暂出现一个后台标签页（不是当前窗口的前台标签）。

## 已知限制（都是真会遇到的）

| 情况 | 表现 | 原因 / 处理 |
| --- | --- | --- |
| 图片在原图站有防盗链 | SauceNAO / TraceMoe 搜不到，顶部出现黄条提示 | 已改用页面内 `fetch` 带 cookie；Lens 因为是上传字节，这种情况反而能搜 |
| Yandex 抓不到图 | 跳过去是「找不到图片」 | 它只接受公开地址，登录后可见的图拿不到 |
| Lens 被 Google 拦/改版 | 那一列变成「在 Lens 里看这次的结果」按钮 | 解析是启发式的，抽不到就给你直达链接，不会给假结果 |
| Lens 转到 Cookie 同意页 | 提示先去 google.com 同意一次 | 同意过就不再出现 |
| 访问不了 Google | Lens 列直接报网络错误 | 需要能直连 / 走代理访问 Google（扩展的 fetch 跟着系统代理） |
| ascii2d 因 Cloudflare 校验失败 | 卡片里报错并给「在浏览器里打开结果页」 | 它必须走真实浏览器通道；极少数情况下校验不过，点按钮手动搜 |
| ascii2d 页面结构变了 | 卡片里报「结构可能变了」 | 它没有 API，是抓 HTML，只能跟着改 `engines/ascii2d-parse.js` |
| 搜索时多出一个后台标签页 | 每次 ascii2d 搜索短暂出现 | 这是过 Cloudflare 的代价，搜完自动关闭，不影响当前标签页 |
| 右键菜单里没有「用这张图找出处」 | 只在图片上右键才出现 | ① 自检页点「重建右键菜单」；② 有覆盖层的站点（Bing 图片结果、Instagram、Pinterest）右键可能命不中 `<img>`，换张普通图片或直接打开图片地址试 |
| 视频右键「用当前这一帧找出处」不出现 | 只在 `<video>` 元素上出现 | 播放器盖了自绘 UI 或自己接管了右键（B 站/YouTube 常见）时会拿不到；改用 **Ctrl+Shift+Y**、图标右键、或「抓帧」按钮 |
| 快捷键按了没反应，或弹出别的东西 | 命令没收到 | ① `Ctrl+L`、`Ctrl+T`、`Ctrl+W` 这类浏览器自带键会被浏览器先吃掉，扩展永远收不到；② `Alt+Shift` 是 Windows 输入法切换；③ **别用 `Ctrl+Alt`**（Windows 上是 AltGr，写进 manifest 还会让扩展加载失败）；④ 去 `edge://extensions/shortcuts` 清掉旧键位重设；⑤ 直接用「图标右键」或「抓帧」按钮，它们不依赖键位 |
| 改了 manifest 后扩展「消失」/加载没反应 | Edge 只在点「重新加载」时弹一个框，别处看不到 | 先跑 `node tools/test-manifest.mjs`（校验 BOM / JSON / 引用文件 / **commands 键位合法性**），通过再重新加载 |
| 面板顶部出现「抓帧失败：…」 | 有明确原因 | 这是抓帧任务的状态行（`videoTask`），说明命令收到了、注入执行了但没拿到帧。按那行文字判断：跨域污染 / 没有 video / 还没出画面 / 注入被拒 |
| SauceNAO 显示「需要 Key」 | 卡片里给注册/Key 页链接 + 「填写 API Key」按钮 | 只有**匿名 HTML 也被拦**时才会这样；先去 `user.php?page=search-api` 拿 Key（免费账号就有） |
| 某一家显示「失败 429」 | 同上 | 限流，等 30 秒 |
| 跨域视频抓不到帧 | 卡片里明说「canvas 被跨域安全策略挡住」 | 浏览器安全策略，绕不过；用 Win+Shift+S 截图再 Ctrl+V |
| 视频还没出画面就右键 | 「先让它播一下再右键」 | `readyState < 2`，解码器还没出帧 |
| 私密窗口 | 右键菜单不出现 | 去 `chrome://extensions` 本扩展详情里打开「在无痕模式下启用」 |
| `chrome://`、扩展商店页面 | 搜不了 | 浏览器禁止扩展访问这些页面 |
| 图片大于 4MB | 退回链接模式 | 防止 `storage.session` 超配额 |
| TraceMoe 额度 | 429 | 免费约 1000 次/天 |
| 低分候选太多显得乱 | 50～79% 的一堆灰条 | 底部「相似度门槛」勾「只看 ≥80%」，勾完自动重搜 |

## 权限说明

- `contextMenus` / `sidePanel` / `storage` / `scripting`：右键菜单、侧边栏、存 key、注入取图脚本。
- `clipboardRead`：只给「读剪贴板」按钮用（从剪贴板取 API Key）。不用这个按钮的话它不会被触发。
- `host_permissions: <all_urls>`：**这是唯一看起来吓人的一条**。用途只有三个：
  ① 在任意站点注入脚本把图片字节读出来（`scripting` 必须有对应 host 权限）；
  ② 直连 SauceNAO / TraceMoe / Google Lens 绕开 CORS；
  ③ 往 ascii2d 的后台标签页注入脚本并读它的结果。
  它**不**代表会读取你的浏览内容上传——扩展没有远程后台，也没有任何上报代码，
  网络请求只发往 `saucenao.com` / `api.trace.moe` / `google.com` / `lens.google.com` / `ascii2d.net`。

## 目录

```
image-source-finder/
├── manifest.json          MV3 清单
├── background.js          右键菜单 / 开侧边栏 / 页面内取图
├── sidepanel.html|.css|.js  侧边栏界面与调度
├── engines/
│   ├── saucenao.js        官方 JSON API（有 Key）/ 匿名 HTML（无 Key）
│   ├── saucenao-html-parse.js  匿名 HTML 结果页抽取（纯函数，可单测）
│   ├── tracemoe.js        官方 JSON API
│   ├── google.js          Lens：上传图片 + 解析结果页
│   ├── google-parse.js    结果页抽取（纯函数，可单测）
│   ├── ascii2d.js         传输层：让后台走标签页通道
│   ├── ascii2d-parse.js   注入页面执行的 HTML 解析器（经典脚本，无 import）
│   └── yandex.js          跳转（只拼 URL，不解析）
├── lib/net.js             fetch 超时 / base64 / 格式化 / 链接消毒
├── selftest.html|.js      浏览器内自检页
├── icons/                 图标
├── package.json           只为跑 Node 测试（Chrome 不读它）
└── tools/                 图标生成、扩展 ID 计算、离线体检与测试脚本
```

## 开发 / 测试

```bash
npm i jsdom                 # 只有 test-google-parse / test-ascii2d-parse / test-sidepanel 需要
node tools/test-manifest.mjs       # manifest：无 BOM、可解析、引用文件都在（无需依赖）
node tools/test-core.mjs           # 纯函数（无需依赖）
node tools/test-capture.mjs        # 页面内取图的降级链（无需依赖）
node tools/test-video-frame.mjs    # <video> 抓帧：成功/跨域污染/无画面（无需依赖）
node tools/test-engines-smoke.mjs  # 真调用路径：6 引擎 × 10 种响应形态 × 有/无 Key（无需依赖）
node tools/test-saucenao-html-parse.mjs  # SauceNAO 匿名 HTML 结果页抽取（jsdom）
node tools/test-google-parse.mjs   # Lens 结果页抽取（jsdom）
node tools/test-ascii2d-parse.mjs  # ascii2d HTML 解析（jsdom）
node tools/test-sidepanel.mjs      # 侧边栏完整流程（jsdom + 假 chrome + 假 fetch）
```

`tools/test-capture.mjs` 直接从 `background.js` 里抠出 `grabImageInPage` 的真实源码来跑，
不复制逻辑，覆盖面是那条最容易出事的路：canvas 成功 / canvas 被 CORS 污染回退 fetch /
图片不在 DOM 里 / 超过 4MB / 404 / 网络异常 / 空响应体。

`tools/test-engines-smoke.mjs` 是**真调用路径**的烟雾测试：它不像 HTML 断言那样只看文本，
而是把每个引擎的 `search()` 真的调一遍，喂 10 种响应形态（200 JSON / 200 HTML / 403 /
403+cf-mitigated / 451 / 429 / 500 / 网络抛错 / 超时）× 有 Key / 无 Key，
断言「要么正常返回，要么抛 EngineError」。**任何 ReferenceError / TypeError 直接判失败**——
这条就是为了拦住「改了个函数名、单测全绿、运行时 undefined」这种事。

`tools/test-sidepanel.mjs` 用 jsdom 喂一个假的 `chrome.*` 和五个引擎的假响应，
把「storage 变更 → 五列渲染 → 片段预览 → 限流报错 → 重搜」整条链路跑一遍。
改了 `sidepanel.js` 后建议先跑它。

`tools/test-google-parse.mjs` 盯的是最脆的一环：Google 结果页抽取。fixture 覆盖
`/url?q=` 包装链接、站内链接过滤、重复项、`script` 里的转义 JSON。

## 还没做（下一步）

- **在面板里直接解析 Yandex 的结果**：要逆向他家的 multipart 上传端点，隔几个月失效一次；
  现在是跳转（Lens 已经用「真上传 + 解析」的方式做完了）。
- **TinEye**：没有公开 API，而且它现在主要卖商业授权，性价比低。
- 搜索历史（IndexedDB）、结果去重、批量搜本地文件夹（那更适合做成 CLI）。

## 来源与许可

**这份代码是原创的**，不是 fork，也没有抄别人。用到的外部信息只有「接口长什么样」这类事实：

| 来源 | 用到了什么 | 有没有复制代码 |
| --- | --- | --- |
| SauceNAO 官方 API 文档 | 端点、`db` / `output_type` / `numres` 等参数、响应结构 | 没有，代码自己写 |
| TraceMoe 官方 API 文档 | `/search` 的 GET/POST 形态、`anilistInfo`、返回字段 | 没有 |
| Google `searchbyimage/upload` | multipart 字段名 `encoded_image` / `sbisrc` / `image_content`（来自公开问答与脚本片段） | 只用了字段名，请求与解析代码自己写 |
| ascii2d | 它没有 API；`.item-box` / `.detail-box` 这类选择器和 `/search/file`、`/search/uri` 端点，来自对多个第三方客户端的调研结论 | 只用了事实（端点、选择器），解析器自己写 |
| dessant/search-by-image | 只看过它的**公开仓库信息**：GPL-3.0、30+ 引擎、已迁 MV3。拉它源码的那次请求直接失败了，一行都没读到 | 没有 |

所以 **GPL-3.0 不传染到这份代码**：GPL 约束的是代码的复制与演绎，接口地址、字段名、CSS 选择器属于事实性信息。
如果以后改成 fork 它的仓库，那是另一条路——那种情况整个仓库必须 GPL-3.0，和现在这版无关。

许可选择：MIT（最宽松，改成 GPL / 私有都行，改 `LICENSE` 即可）。
