/**
 * dsh-tps 实时 tok/s 读数（注入脚本）。
 *
 * 宿主插件把本文件作为 GET /dsh-tps/widget.js 提供，并经
 * `webserver/index-inject` 注入到页面 <head>。读数自己轮询
 * /dsh-tps/state.json，因此不依赖客户端模块系统。
 *
 * 停靠位置
 * --------
 * 位置有两种形态，由**卡片右上角的「左侧 / 悬浮」切换器**显式选择并记住
 * （localStorage `dsh-tps-meter:dock`）：
 *
 *   - `left`（默认）：钉在左侧栏底部；只有**找不到侧栏座位**时才临时以浮窗
 *     显示，座位一出现自动停靠回去。
 *   - `float`：永远是右下角浮窗（可拖动，位置记忆），巡检不再往侧栏搬。
 *
 * 默认**停靠在左侧栏底部、通话记录（session 列表）下面**：
 * 挂进 sidebar 的 `sidebar.footer.action` 座位容器（或结构性推导出的
 * footerActions 容器）。这样它是一个普通 flex 子项，和同样占用该座位的
 * 插件（dsh-cost-meter 的 `.footer-stack`）按各自 100% 宽的行堆叠共存，
 * 不会像 position:fixed 浮层那样压在别的插件窗口上 —— 这就是
 * 「与其他插件窗口兼容」的实现方式。
 *
 * 只有**找不到侧栏座位**时才退回原来的右下角浮窗（带拖动/位置记忆），
 * 保证任何布局变化下读数都不会彻底消失。悬浮态整张卡都能拖：标题行、
 * 数字、波形都行，只有按钮 / 分段切换 / 会话行不当拖动手柄。
 */
;(function () {
  if (typeof window === 'undefined' || window.__dshTpsMeter === true) return
  window.__dshTpsMeter = true

  var ENDPOINT = '/dsh-tps/state.json'
  var SELF_ENDPOINT = '/dsh-tps/widget.js'
  // 本文件版本号：脚本会定期拉一次自身源码比对，不一致就在头部显示「⟳ 更新」按钮
  // （只提示、不自动刷新，避免打断正在输入的内容）。
  var BUILD = '2026-10-21d'
  // localStorage 键保持 `dsh-tps-meter:*` 前缀不变：合并前的浮窗位置、折叠状态、
  // 已关闭会话清单都存在这些键下，改名会让用户既有偏好凭空消失。
  var POS_KEY = 'dsh-tps-meter:pos'
  var COLLAPSE_KEY = 'dsh-tps-meter:collapsed'
  var MODE_KEY = 'dsh-tps-meter:mode'
  // 摆放形态偏好：'left' = 固定左侧栏底部；'float' = 可拖动悬浮窗。
  var DOCK_KEY = 'dsh-tps-meter:dock'
  var SEL_KEY = 'dsh-tps-meter:selected'
  var CLOSED_KEY = 'dsh-tps-meter:closed'
  var POLL_MS = 400
  var POLL_HIDDEN_MS = 2000
  var HISTORY_LEN = 40
  // 找不到侧栏座位时，最多等这么久（按 400ms 一次）再退回浮窗。
  // 找不到座位（侧栏尚未渲染）就立刻以浮窗呈现：可见性优先。
  // 座位一出现，巡检会自动把它挪进侧栏。
  var DOCK_GIVE_UP_TRIES = 1
  // 座位找到了、但实测不可见（侧栏折叠 / 被 React 摘掉 / 被同排插件挤成 0 宽）时，
  // 连续这么多次巡检都不可见就退回浮窗，保证一定看得见。
  var DOCK_HIDDEN_TRIES = 3
  var DOCK_POLL_MS = 400
  var DOCK_OK_MS = 1500
  var FLOAT_W = 186
  var FLOAT_W_COLLAPSED = 118

  var STYLE = [
    // 基础外观（两种形态共用）。默认处在左侧栏根部的 flex「纵列」里：
    // 横向铺满整行，且不参与纵向伸缩 —— 这里不能写 flex:1 1 100%，
    // 纵列里 flex-basis 的百分比是「高度」，语义会跑偏。
    '#dshtps{box-sizing:border-box;min-width:0;width:100%;flex:0 0 auto;',
    'font-family:var(--ds-font-family-text,ui-sans-serif,system-ui,"Segoe UI",sans-serif);',
    'font-size:12px;line-height:1.35;color:var(--dsw-alias-label-primary,#e8e8ea);',
    'background:var(--dsw-alias-surface-2,rgba(32,33,38,.92));',
    'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:12px;',
    // 竖向留白压到最小：侧栏底部是稀缺空间，卡片越高越挤掉会话区。
    'padding:6px 9px 7px;user-select:none;opacity:1}',
    // 与同样占用 sidebar.footer.action 的插件同排共存：
    // 让 footerActions 允许换行，于是两条 100% 宽的项各占一行，互不挤压。
    // （dsh-cost-meter 也用同形状的 :has() 规则做同样的事。）
    ':has(> [data-slot="sidebar.footer.action"] > #dshtps){flex-wrap:wrap}',
    ':has(> #dshtps):not(body){flex-wrap:wrap}',
    // —— 停靠态：左侧栏底部，随侧栏宽度自适应 ——
    '#dshtps.is-docked{margin:2px 0 6px;border-radius:10px;box-shadow:none;',
    'background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-surface-2,rgba(32,33,38,.72)))}',
    '#dshtps.is-docked .t-head{cursor:default}',
    // —— 兜底浮窗态：只有找不到侧栏座位时才启用 ——
    '#dshtps.is-floating{position:fixed;z-index:2147483000;width:' + FLOAT_W + 'px;flex:none;cursor:grab;',
    'box-shadow:0 6px 22px rgba(0,0,0,.28);backdrop-filter:blur(10px)}',
    '#dshtps.is-floating.is-collapsed{width:' + FLOAT_W_COLLAPSED + 'px;padding:6px 9px}',
    // 悬浮态整张卡都能拖（按钮 / 分段切换 / 会话行自带 pointer 光标，会盖掉这里的 grab）。
    '#dshtps.is-floating .t-head{cursor:grab}',
    '#dshtps.is-floating.is-dragging,#dshtps.is-floating.is-dragging .t-head{cursor:grabbing}',
    // —— 内容 ——
    '#dshtps .t-head{display:flex;align-items:center;gap:6px;margin-bottom:3px}',
    '#dshtps .t-dot{width:7px;height:7px;border-radius:50%;background:#7a7a85;flex:none}',
    '#dshtps .t-dot.live{background:#39d98a;box-shadow:0 0 8px rgba(57,217,138,.75);animation:t-pulse 1.1s ease-in-out infinite}',
    '#dshtps .t-dot.wait{background:#e8b64c;animation:t-pulse 1.6s ease-in-out infinite}',
    '#dshtps .t-dot.done{background:#5b9bff}',
    '@keyframes t-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '#dshtps .t-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'color:var(--dsw-alias-label-secondary,#a9a9b3);font-size:10.5px;letter-spacing:.4px}',
    '#dshtps .t-tools{display:flex;gap:3px;align-items:center;flex:none}',
    '#dshtps .t-btn{border:0;background:transparent;color:inherit;opacity:.55;cursor:pointer;',
    'padding:1px 3px;border-radius:4px;font-size:11px;line-height:1}',
    '#dshtps .t-btn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}',
    '#dshtps .t-btn.t-reload{opacity:1;color:#39d98a}',
    // 实时 / 均速 分段切换器
    '#dshtps .t-seg{display:flex;flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));',
    'border-radius:6px;overflow:hidden}',
    '#dshtps .t-seg button{border:0;background:transparent;color:inherit;cursor:pointer;opacity:.5;',
    'font-size:9.5px;line-height:1;padding:2px 5px;font-family:inherit}',
    '#dshtps .t-seg button:hover{opacity:.85;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
    '#dshtps .t-seg button.on{opacity:1;background:rgba(57,217,138,.18);color:#39d98a;font-weight:600}',
    '#dshtps.is-avg .t-seg button.on{background:rgba(91,155,255,.2);color:#5b9bff}',
    // 摆放形态切换器（左侧 / 悬浮）：形状同上，但高亮用中性灰 ——
    // 绿/蓝已经代表「实时/均速」的数值口径，这里不该再抢同一种语义。
    '#dshtps .t-seg.t-dock button{padding:2px 4px}',
    '#dshtps .t-seg.t-dock button.on{background:rgba(127,127,127,.34);color:var(--dsw-alias-label-primary,#e8e8ea);font-weight:600}',
    '#dshtps .t-main{display:flex;align-items:baseline;gap:5px}',
    // 数字配色只跟口径走：实时=绿、均速=蓝（完全没有会话数据时才是中性灰）
    '#dshtps .t-num{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);',
    'font-size:22px;line-height:1.1;font-weight:600;letter-spacing:-.5px;font-variant-numeric:tabular-nums;color:#39d98a}',
    '#dshtps.is-avg .t-num{color:#5b9bff}',
    '#dshtps.is-idle-num .t-num{color:var(--dsw-alias-label-tertiary,#8b8b95)}',
    '#dshtps .t-unit{font-size:11px;color:var(--dsw-alias-label-secondary,#a9a9b3)}',
    '#dshtps .t-spark{display:block;width:100%;height:22px;margin:2px 0 1px}',
    // 会话列表：最多 3 行 + 省略行；当前会话绿色、其余白色，点击切换
    '#dshtps .t-sessions{display:flex;flex-direction:column;gap:1px;margin:0 0 4px}',
    '#dshtps .t-sess{display:flex;align-items:center;gap:5px;width:100%;box-sizing:border-box;border:0;',
    'background:transparent;cursor:pointer;font-family:inherit;font-size:11px;line-height:15px;padding:0 2px;',
    'text-align:left;border-radius:4px;color:var(--dsw-alias-label-primary,#e8e8ea);flex:none}',
    '#dshtps .t-sess .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    // 任务名右侧的「(工作区)」：名字先让位截断，工作区尽量完整露出来。
    '#dshtps .t-sess .ws{flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'color:var(--dsw-alias-label-tertiary,#8b8b95);font-weight:400;font-size:10.5px}',
    '#dshtps .t-sess.on .ws{color:rgba(57,217,138,.72)}',
    // 右侧状态标：工作中 = Windows 式转圈，已完成 = 短横
    '#dshtps .t-sess .st{flex:none;width:12px;height:12px;box-sizing:border-box;display:flex;align-items:center;',
    'justify-content:center;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary,#8b8b95)}',
    '#dshtps .t-sess .st.spin{border-radius:50%;border:1.5px solid rgba(57,217,138,.28);border-top-color:#39d98a;',
    'animation:t-spin .8s linear infinite}',
    '@keyframes t-spin{to{transform:rotate(360deg)}}',
    '#dshtps .t-sess:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
    '#dshtps .t-sess.on{color:#39d98a;font-weight:600}',
    '#dshtps .t-sess.more{color:var(--dsw-alias-label-tertiary,#8b8b95);cursor:default;font-size:10.5px;line-height:14px}',
    '#dshtps .t-sess.more:hover{background:transparent}',
    '#dshtps .t-row{display:flex;justify-content:space-between;gap:6px;font-size:10.5px;',
    'color:var(--dsw-alias-label-secondary,#a9a9b3);font-variant-numeric:tabular-nums}',
    '#dshtps .t-row b{font-weight:600;color:var(--dsw-alias-label-primary,#e8e8ea)}',
    '#dshtps.is-collapsed .t-spark,#dshtps.is-collapsed .t-rows,#dshtps.is-collapsed .t-sessions{display:none}',
    '#dshtps .t-state{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b8b95);margin-top:2px;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  ].join('')

  function injectStyle() {
    if (document.querySelector('style[data-plugin-css="dsh-tps-meter"]') !== null) return
    var tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-tps-meter'
    tag.dataset.pluginCss = 'dsh-tps-meter'
    tag.textContent = STYLE
    document.head.appendChild(tag)
  }

  function fmtCount(n) {
    if (!isFinite(n) || n <= 0) return '0'
    if (n < 1000) return String(Math.round(n))
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 2 : 1) + 'k'
    return (n / 1000000).toFixed(2) + 'M'
  }

  function fmtSeconds(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '—'
    return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's'
  }

  function fmtDuration(ms) {
    if (!isFinite(ms) || ms < 0) return '0.0s'
    return (ms / 1000).toFixed(1) + 's'
  }

  var PHASE_TEXT = {
    waiting: '等待首 token…',
    streaming: '生成中',
    done: '本步完成',
    idle: '空闲',
  }

  function loadPos() {
    try {
      var raw = localStorage.getItem(POS_KEY)
      if (raw === null) return null
      var pos = JSON.parse(raw)
      if (typeof pos.left === 'number' && typeof pos.top === 'number') return pos
    } catch (err) {}
    return null
  }

  function savePos(pos) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos))
    } catch (err) {}
  }

  function loadCollapsed() {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch (err) {
      return false
    }
  }

  function saveCollapsed(value) {
    try {
      localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
    } catch (err) {}
  }

  function loadMode() {
    try {
      return localStorage.getItem(MODE_KEY) === 'avg' ? 'avg' : 'live'
    } catch (err) {
      return 'live'
    }
  }

  function saveMode(value) {
    try {
      localStorage.setItem(MODE_KEY, value)
    } catch (err) {}
  }

  /** 摆放形态偏好：只有明确存过 'float' 才浮窗，其它一律按默认的左侧停靠走。 */
  function loadDockPref() {
    try {
      return localStorage.getItem(DOCK_KEY) === 'float' ? 'float' : 'left'
    } catch (err) {
      return 'left'
    }
  }

  function saveDockPref(value) {
    try {
      localStorage.setItem(DOCK_KEY, value)
    } catch (err) {}
  }

  function loadSelected() {
    try {
      return localStorage.getItem(SEL_KEY) || null
    } catch (err) {
      return null
    }
  }

  function saveSelected(id) {
    try {
      localStorage.setItem(SEL_KEY, id)
    } catch (err) {}
  }

  /** 被用户双击关闭（不再显示）的会话 id 列表。 */
  function loadClosed() {
    try {
      var raw = localStorage.getItem(CLOSED_KEY)
      var list = raw === null ? [] : JSON.parse(raw)
      return Array.isArray(list) ? list.filter(function (v) { return typeof v === 'string' }) : []
    } catch (err) {
      return []
    }
  }

  function saveClosed(list) {
    try {
      localStorage.setItem(CLOSED_KEY, JSON.stringify(list))
    } catch (err) {}
  }

  function build() {
    injectStyle()
    var root = document.createElement('div')
    root.id = 'dshtps'
    root.innerHTML = [
      '<div class="t-head">',
      '<span class="t-dot"></span>',
      '<span class="t-label">TOK/S</span>',
      '<span class="t-tools">',
      '<button class="t-btn t-reload" data-act="reload" title="浮窗脚本已更新，点击刷新页面（Ctrl+R）" style="display:none">⟳</button>',
      '<span class="t-seg t-mode" title="切换显示：实时窗口速度 / 本步平均速度">',
      '<button data-mode="live">实时</button>',
      '<button data-mode="avg">均速</button>',
      '</span>',
      '<span class="t-seg t-dock" title="卡片摆放：固定左侧栏底部 / 悬浮窗（选择会记住）">',
      '<button data-dock="left" title="固定左侧：钉在左侧栏底部，随侧栏宽度自适应">左侧</button>',
      '<button data-dock="float" title="悬浮：可自由拖动的浮窗（位置会记住）">悬浮</button>',
      '</span>',
      '<button class="t-btn" data-act="collapse" title="折叠 / 展开">–</button>',
      '</span>',
      '</div>',
      '<div class="t-sessions"></div>',
      '<div class="t-main"><span class="t-num">0.0</span><span class="t-unit">tok/s</span></div>',
      '<canvas class="t-spark" width="332" height="60"></canvas>',
      '<div class="t-rows">',
      '<div class="t-row"><span>本步</span><b data-f="step">0</b></div>',
      '<div class="t-row"><span>累计</span><b data-f="total">0</b></div>',
      '<div class="t-row"><span>TTFT</span><b data-f="ttft">—</b></div>',
      '<div class="t-row t-cache" style="display:none"><span>缓存命中</span><b data-f="cache">0</b></div>',
      '</div>',
      '<div class="t-state"></div>',
    ].join('')

    var num = root.querySelector('.t-num')
    var dot = root.querySelector('.t-dot')
    var state = root.querySelector('.t-state')
    var canvas = root.querySelector('.t-spark')
    var sessionsEl = root.querySelector('.t-sessions')
    var fields = {
      step: root.querySelector('[data-f="step"]'),
      total: root.querySelector('[data-f="total"]'),
      ttft: root.querySelector('[data-f="ttft"]'),
      cache: root.querySelector('[data-f="cache"]'),
      cacheRow: root.querySelector('.t-cache'),
    }

    // ---- 兜底浮窗的位置记忆 ----
    var pos = loadPos()
    if (pos === null) {
      // 默认落在右下角，但让开最右侧约 268px（给桌面宠物 / 挂件类插件留位）。
      pos = {
        left: Math.max(8, window.innerWidth - FLOAT_W - 268),
        top: Math.max(8, window.innerHeight - 166),
      }
    }
    function place() {
      if (!root.classList.contains('is-floating')) return
      var maxLeft = Math.max(4, window.innerWidth - root.offsetWidth - 4)
      var maxTop = Math.max(4, window.innerHeight - root.offsetHeight - 4)
      pos.left = Math.min(Math.max(4, pos.left), maxLeft)
      pos.top = Math.min(Math.max(4, pos.top), maxTop)
      root.style.left = pos.left + 'px'
      root.style.top = pos.top + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }
    window.addEventListener('resize', place)

    // ---- 停靠 / 兜底浮窗 ----
    // 目标：钉在左侧栏「通话记录列表的正下方」。
    // footArea 是左侧栏根部里的一个 flex 纵列（regionArea 之下，内部装着 footerActions
    // 与 settingsArea）。直接挂进这个纵列，顺序天然就是
    //   通话记录列表 → 本插件 → 其他插件那一行 → 设置
    // 这样做的好处：
    //   1) 不依赖 :has()，也不依赖任何 CSS module 哈希类名；
    //   2) 处在纵列里、宽度 100%，不会被同排插件的区块挤成 0 宽（这是之前「无显示」的主因）；
    //   3) 仍然与其它插件共存：它只是占内容的行高，不覆盖、不移除别人的节点。
    // 拿不到 footArea 就退到 footerActions / 座位容器，再不行还有浮窗兜底。
    // 每次巡检都实测「真的可见吗」（尺寸 > 0 且没有任何祖辈 display:none）：
    // 不可见就先退回浮窗，等侧栏重新可见再自动停靠回去。
    var dockMode = 'search' // search | docked | floating
    // 用户偏好（右上角切换）：'left' 才允许巡检往侧栏搬；'float' 时巡检只保证它浮着。
    var dockPref = loadDockPref()
    var seatMisses = 0
    var hiddenTries = 0
    var remounted = false

    /** 只接受真正的元素容器；body / html 不算座位。 */
    function isRail(node) {
      return node !== null && node !== undefined && node.nodeType === 1 &&
        node !== document.body && node !== document.documentElement
    }

    /** 节点是否真的占了可见的方块（含全部祖辈的 display / visibility 检查）。 */
    function visibleNode(node) {
      if (node === null || node === undefined || node.parentNode === null) return false
      if (typeof node.getBoundingClientRect !== 'function') return true
      var rect = node.getBoundingClientRect()
      if (rect !== null && rect !== undefined && (rect.width < 24 || rect.height < 8)) return false
      var walk = node
      while (walk !== null && walk !== undefined && walk.nodeType === 1) {
        var cs = window.getComputedStyle ? window.getComputedStyle(walk) : null
        if (cs !== null && cs !== undefined && (cs.display === 'none' || cs.visibility === 'hidden')) return false
        walk = walk.parentElement
      }
      return true
    }

    /** 候选座位，从最外层（footArea 纵列）到最内层依次挑第一个可见的。 */
    function dockTarget() {
      var slot = document.querySelector('[data-slot="sidebar.footer.action"]')
      var actions = slot !== null ? slot.parentElement : null
      var settings = document.querySelector('[data-slot="sidebar.settings"]')
      var settingsArea = settings !== null ? settings.parentElement : null
      var foot = actions !== null ? actions.parentElement : (settingsArea !== null ? settingsArea.parentElement : null)
      var chain = []
      if (isRail(foot)) chain.push(foot)
      if (isRail(actions)) chain.push(actions)
      if (isRail(slot)) chain.push(slot)
      if (chain.length === 0) return null
      for (var i = 0; i < chain.length; i += 1) {
        if (visibleNode(chain[i])) return chain[i]
      }
      return chain[0]
    }

    function mountInto(target) {
      if (root.parentNode !== target || target.firstChild !== root) {
        if (typeof target.insertBefore === 'function') target.insertBefore(root, target.firstChild)
        else target.appendChild(root)
      }
      // 注意：不要改别人容器的 inline 样式。若真落到 footerActions 那种横向行，
      // 由下面的 :has() 规则负责换行；万一还是被压缩，可见性看门狗会退回浮窗。
      root.classList.add('is-docked')
      root.classList.remove('is-floating')
      root.style.display = ''
      root.style.left = ''
      root.style.top = ''
      root.style.right = ''
      root.style.bottom = ''
      dockMode = 'docked'
      hiddenTries = 0
      remounted = true
    }

    function floatNow() {
      if (dockMode === 'floating') return
      dockMode = 'floating'
      hiddenTries = 0
      // 兜底浮窗必须自己挂到 body 上：停靠态是挂进侧栏容器的，
      // 没有座位时这个节点还没有父节点，不 append 就等于隐身。
      if (root.parentNode !== document.body) document.body.appendChild(root)
      root.classList.remove('is-docked')
      root.classList.add('is-floating')
      root.style.display = ''
      place()
    }

    /** 一次巡检：找座位 → 实挂 → 实测可见性；失败就切换到可见的那种形态。 */
    function tickDock() {
      // 用户选了「悬浮」：位置交给他，巡检只负责保证它是挂在 body 上的浮窗。
      if (dockPref === 'float') {
        if (dockMode !== 'floating') floatNow()
        return
      }
      var target = dockTarget()
      if (target === null) {
        seatMisses += 1
        if (dockMode === 'docked') {
          dockMode = 'search'
          root.style.display = 'none'
        }
        if (seatMisses >= DOCK_GIVE_UP_TRIES) floatNow()
        return
      }
      seatMisses = 0
      if (dockMode !== 'docked') {
        // 还浮着（或还在等）：先确认座位本身可见，再搬进去。
        if (!visibleNode(target)) {
          hiddenTries += 1
          // 首次停靠时座位不可见就立刻退回浮窗（可见性优先）；
          // 已停靠过再变不可见则多等两次，免得 React 重渲染造成闪烁。
          var limit = dockMode === 'search' ? 1 : DOCK_HIDDEN_TRIES
          if (dockMode !== 'floating' && hiddenTries >= limit) floatNow()
          return
        }
        mountInto(target)
        return
      }
      if (root.parentNode !== target) { mountInto(target); return }
      if (!visibleNode(root)) {
        hiddenTries += 1
        if (hiddenTries >= DOCK_HIDDEN_TRIES) floatNow()
        return
      }
      hiddenTries = 0
    }

    function keepDocked() {
      remounted = false
      tickDock()
      var delay = dockMode === 'docked' && !remounted ? DOCK_OK_MS : DOCK_POLL_MS
      // 选了悬浮后没有再找座位的必要，巡检放慢即可（只为兜住节点被摘掉的情况）。
      if (dockPref === 'float') delay = DOCK_OK_MS
      window.setTimeout(keepDocked, delay)
    }
    keepDocked()

    // ---- 摆放形态切换（卡片右上角）：固定左侧 / 悬浮 ----
    // 这个选择是「人说了算」的：只有 left 才允许巡检往侧栏搬，float 时巡检不抢位置。
    var dockButtons = root.querySelectorAll('.t-dock button')
    function applyDockPrefUI() {
      for (var i = 0; i < dockButtons.length; i += 1) {
        dockButtons[i].className = dockButtons[i].getAttribute('data-dock') === dockPref ? 'on' : ''
      }
    }
    function setDockPref(next) {
      var value = next === 'float' ? 'float' : 'left'
      if (value === dockPref) return
      dockPref = value
      saveDockPref(dockPref)
      applyDockPrefUI()
      if (dockPref === 'float') {
        // 从侧栏拔出来，落到记忆位置（没记忆过就是默认的右下角）。
        floatNow()
        return
      }
      // 交回巡检：座位还在就立刻停靠回去，不在就先浮着等它出现。
      dockMode = 'search'
      seatMisses = 0
      hiddenTries = 0
      tickDock()
    }
    for (var di = 0; di < dockButtons.length; di += 1) {
      dockButtons[di].addEventListener('click', function (ev) {
        setDockPref(ev.currentTarget.getAttribute('data-dock'))
      })
    }
    applyDockPrefUI()

    // ---- 拖动（只有悬浮态才生效） ----
    // 两种形态的分工：停靠态跟着侧栏走，悬浮态由人拖着走。
    //
    // 旧写法（监听 `.t-head` + setPointerCapture + 用内存里的 pos 算偏移）有三个坑：
    //   1) 指针一离开卡片，capture 在部分外壳里会丢事件，拖到一半就"卡住"；
    //   2) 只有那条十几像素高的标题行能抓，用户自然会去抓卡片主体 —— 抓了没反应；
    //   3) 起点依赖内存 pos 与实际渲染位置一致，一旦不同步（钳位、跨模式切换），
    //      第一下就会瞬移甚至甩出屏幕。
    // 现在改成：document 级 move/up 监听 + 用实际矩形反推偏移 + 3px 阈值。
    var drag = null
    var dragBlockClickUntil = 0
    function cardRect() {
      if (typeof root.getBoundingClientRect === 'function') {
        var rect = root.getBoundingClientRect()
        if (rect !== null && rect !== undefined && isFinite(rect.left) && isFinite(rect.top)) return rect
      }
      return { left: isFinite(pos.left) ? pos.left : 0, top: isFinite(pos.top) ? pos.top : 0 }
    }
    function onDragDown(ev) {
      if (!root.classList.contains('is-floating')) return
      if (typeof ev.button === 'number' && ev.button !== 0) return
      var target = ev.target
      // 交互控件不当拖动手柄：按钮 / 分段切换 / 会话行；其余区域（标题、数字、波形）都能拖。
      if (target !== null && target !== undefined && typeof target.closest === 'function' &&
          target.closest('.t-btn, .t-seg, .t-sess') !== null) return
      var rect = cardRect()
      pos.left = rect.left
      pos.top = rect.top
      drag = {
        id: ev.pointerId,
        dx: ev.clientX - rect.left,
        dy: ev.clientY - rect.top,
        x: ev.clientX,
        y: ev.clientY,
        moved: false,
      }
    }
    function onDragMove(ev) {
      if (drag === null) return
      if (drag.id !== undefined && ev.pointerId !== undefined && ev.pointerId !== drag.id) return
      if (!drag.moved) {
        // 阈值：手抖 1~2px 不算拖动，否则会话行的单击会被吃掉。
        if (Math.abs(ev.clientX - drag.x) < 3 && Math.abs(ev.clientY - drag.y) < 3) return
        drag.moved = true
        root.classList.add('is-dragging')
      }
      pos.left = ev.clientX - drag.dx
      pos.top = ev.clientY - drag.dy
      place()
      if (typeof ev.preventDefault === 'function') ev.preventDefault()
    }
    function onDragUp() {
      if (drag === null) return
      var moved = drag.moved
      drag = null
      root.classList.remove('is-dragging')
      if (moved) {
        savePos(pos)
        // 拖完紧接着的那一次 click 不能被当成"点了某个会话"。
        dragBlockClickUntil = Date.now() + 400
      }
    }
    root.addEventListener('pointerdown', onDragDown)
    document.addEventListener('pointermove', onDragMove)
    document.addEventListener('pointerup', onDragUp)
    document.addEventListener('pointercancel', onDragUp)
    root.addEventListener('click', function (ev) {
      if (Date.now() < dragBlockClickUntil) {
        dragBlockClickUntil = 0
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation()
        if (typeof ev.preventDefault === 'function') ev.preventDefault()
      }
    }, true)

    // ---- 折叠 ----
    var collapsed = loadCollapsed()
    if (collapsed) root.classList.add('is-collapsed')
    root.querySelector('[data-act="collapse"]').addEventListener('click', function () {
      collapsed = !collapsed
      root.classList.toggle('is-collapsed', collapsed)
      saveCollapsed(collapsed)
      place()
    })

    // ---- 会话选择：单击切换显示，双击关闭（仅限已停止工作的会话） ----
    var selectedId = loadSelected()
    sessionsEl.addEventListener('click', function (ev) {
      var row = ev.target.closest('.t-sess')
      if (row === null) return
      // 「…N 个已关闭（点此恢复）」
      if (row.getAttribute('data-act') === 'restore') {
        closedIds.length = 0
        saveClosed(closedIds)
        lastListKey = ''
        refresh()
        return
      }
      if (row.classList.contains('more')) return
      var id = row.getAttribute('data-id')
      if (id === null) return
      selectedId = id
      saveSelected(id)
      shown = -1
      refresh()
    })
    sessionsEl.addEventListener('dblclick', function (ev) {
      var row = ev.target.closest('.t-sess')
      if (row === null || row.classList.contains('more')) return
      var id = row.getAttribute('data-id')
      if (id === null) return
      var one = null
      for (var i = 0; i < rawReadings.length; i += 1) {
        if (rawReadings[i].id === id) one = rawReadings[i]
      }
      // 前置条件：整轮还没结束就不许关（思考 / 跑工具期间也算没结束）
      if (one !== null && isWorking(one)) return
      if (closedIds.indexOf(id) < 0) {
        closedIds.push(id)
        saveClosed(closedIds)
      }
      if (selectedId === id) {
        selectedId = null
        saveSelected('')
      }
      lastListKey = ''
      refresh()
    })

    // ---- 显示模式：实时窗口速度 / 本步均速（右上角按钮手动切换，不再自动跳） ----
    var mode = loadMode()
    // 注意：必须限定 `.t-mode`。右上的左侧/悬浮切换器同样是 `.t-seg`，
    // 用泛化的 `.t-seg button` 会把它的按钮也算进口径切换器里，互相清高亮。
    var segButtons = root.querySelectorAll('.t-seg.t-mode button')
    function applyMode() {
      for (var i = 0; i < segButtons.length; i += 1) {
        var on = segButtons[i].getAttribute('data-mode') === mode
        segButtons[i].className = on ? 'on' : ''
      }
      root.classList.toggle('is-avg', mode === 'avg')
    }
    function setMode(next) {
      if (next === mode) return
      mode = next
      saveMode(mode)
      applyMode()
      shown = -1 // 强制下一帧直接跳到新数值，避免跨模式插值
      refresh()
    }
    for (var bi = 0; bi < segButtons.length; bi += 1) {
      segButtons[bi].addEventListener('click', function (ev) {
        setMode(ev.currentTarget.getAttribute('data-mode'))
      })
    }
    applyMode()

    // ---- 迷你曲线 ----
    var history = []
    var ctx = canvas.getContext('2d')
    function drawSpark() {
      var w = canvas.width
      var h = canvas.height
      ctx.clearRect(0, 0, w, h)
      var dark = document.body.hasAttribute('data-ds-dark-theme')
      var step = w / HISTORY_LEN
      var barW = Math.max(2, step - 2)
      var accent = mode === 'avg' ? '#5b9bff' : '#39d98a'
      var max = 0
      for (var i = 0; i < history.length; i += 1) max = Math.max(max, history[i])
      if (max <= 0) {
        // 还没有任何输出：画一条基线，别留一块空白。
        ctx.fillStyle = dark ? 'rgba(140,150,170,.28)' : 'rgba(90,100,120,.24)'
        ctx.fillRect(0, h - 2, w, 2)
        return
      }
      // 空槽留在左侧，柱子随时间从左向右推进（最新的在最右）。
      var offset = HISTORY_LEN - history.length
      for (var j = 0; j < history.length; j += 1) {
        var value = history[j]
        var bh = Math.max(2, (value / max) * (h - 4))
        var x = (offset + j) * step
        var live = j === history.length - 1
        ctx.fillStyle = live ? accent : dark ? 'rgba(160,170,190,.55)' : 'rgba(70,80,100,.45)'
        ctx.fillRect(Math.round(x), h - bh, Math.round(barW), bh)
      }
    }

    // ---- 渲染 ----
    var shown = 0
    var rawReadings = []
    var closedIds = loadClosed()
    var lastListKey = ''
    var MAX_ROWS = 3

    /**
     * "在干活"的判定：优先看整轮是否结束（`active`，思考 / 跑工具都算），
     * 宿主没给该字段时（旧版）退回"最近有流式输出"（`running`）。
     * 只看 running 会在思考空档里误判成"已完成"。
     */
    function isWorking(r) {
      if (typeof r.active === 'boolean') return r.active === true
      return r.running === true
    }

    /**
     * 过滤掉被双击关闭的会话；若某个被关掉的会话又开始干活，自动恢复显示
     * （关闭的语义是"这个闲着的会话先别占地方"，不是永久拉黑）。
     */
    function visibleReadings() {
      var out = []
      var changed = false
      for (var i = 0; i < rawReadings.length; i += 1) {
        var r = rawReadings[i]
        var at = closedIds.indexOf(r.id)
        if (at >= 0) {
          if (isWorking(r)) {
            closedIds.splice(at, 1)
            changed = true
          } else {
            continue
          }
        }
        out.push(r)
      }
      if (changed) saveClosed(closedIds)
      return out
    }

    function refresh() {
      render(visibleReadings())
    }

    function esc(text) {
      return String(text).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      })
    }

    /**
     * 列表里显示的会话名：优先真实标题；宿主还没提供标题时，退回 "#短id"
     * 把同名目录下的不同会话区分开（工作区名由右侧的 (工作区) 单独显示，不再塞进名字）。
     */
    function displayName(r) {
      if (typeof r.title === 'string' && r.title.length > 0) return r.title
      var short = String(r.id).replace(/^session-/, '').slice(0, 4)
      var base = r.dir || r.id
      return short.length > 0 ? '#' + short : base
    }

    /** 任务所在工作区：会话 cwd 的末级目录（宿主给的 dir 已经是它，缺失时从 cwd 现算）。 */
    function workspaceName(r) {
      if (typeof r.dir === 'string' && r.dir.length > 0) return r.dir
      var cwd = typeof r.cwd === 'string' ? r.cwd : ''
      var parts = cwd.split(/[\\/]+/).filter(function (p) { return p.length > 0 })
      return parts.length > 0 ? parts[parts.length - 1] : ''
    }

    /** 会话列表（最多 3 行 + 省略行）；只在内容变化时重建，避免每 400ms 抖动。 */
    function renderSessions(readings, selected) {
      var names = readings.map(displayName)
      var areas = readings.map(workspaceName)
      var key = readings.map(function (r, i) {
        return r.id + '\u0001' + names[i] + '\u0001' + areas[i] + (r === selected ? '*' : '') + (isWorking(r) ? '+' : '-')
      }).join('\u0002') + '\u0003' + closedIds.join(',')
      if (key === lastListKey) return
      lastListKey = key

      var html = ''
      var rows = readings.slice(0, MAX_ROWS)
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i]
        var busy = isWorking(r)
        var tip = [
          r.title,
          names[i],
          r.sub ? '子代理' : '',
          busy ? '正在工作（思考 / 输出 / 跑工具）' : '已完成（双击关闭显示）',
          r.cwd || r.dir,
        ].filter(Boolean).join(' · ')
        // 右侧状态标：工作中 = 转圈，已完成 = 短横
        var mark = busy
          ? '<span class="st spin" aria-label="工作中"></span>'
          : '<span class="st" aria-label="已完成">–</span>'
        // 任务名右边用括号补上所属工作区，一眼分清同名会话。
        var ws = areas[i] === '' ? '' : '<span class="ws">(' + esc(areas[i]) + ')</span>'
        html += '<button class="t-sess' + (r === selected ? ' on' : '') + '" data-id="' + esc(r.id) + '" title="' + esc(tip) + '">' +
          '<span class="nm">' + esc(names[i]) + '</span>' + ws + mark + '</button>'
      }
      if (readings.length > MAX_ROWS) {
        var rest = names.slice(MAX_ROWS)
        html += '<div class="t-sess more" title="' + esc(rest.join('\n')) + '">…还有 ' + rest.length + ' 个</div>'
      }
      // 被双击关掉、当前还看不到的会话：给一个一键找回的入口（可逆才敢用）。
      if (closedIds.length > 0) {
        html += '<div class="t-sess more" data-act="restore" title="点击恢复显示">…' + closedIds.length + ' 个已关闭（点此恢复）</div>'
      }
      if (html === '') html = '<div class="t-sess more">暂无会话输出</div>'
      sessionsEl.innerHTML = html
    }

    function pickReading(readings) {
      if (readings.length === 0) return null
      for (var i = 0; i < readings.length; i += 1) {
        if (readings[i].id === selectedId) return readings[i]
      }
      return readings[0]
    }

    function render(readings) {
      var one = pickReading(readings)
      var phase = one === null ? 'idle' : one.phase
      // live = 本步仍在推进（生成中，或已 step/start 在等首 token）：状态行与波形用它。
      // 实测（本会话 4.6 万个 50ms 帧）：running 帧中 streaming 帧的 tps 恒 > 0，
      // waiting 帧的 tps 恒为 0 —— 所以 running 只代表"本步没结束"，不代表"有速率"。
      // 因此插值另用 hasRate：否则等首 token 的那几秒里，数字会从上一轮的旧值
      // 慢慢滑向 0，看起来像在减速，而其实一个 token 都还没产出。
      // 不用 active（整轮未结束）：工具执行空档里 active 仍为真，会把已经停下的速率当活的。
      var live = one !== null && one.running
      var hasRate = live && phase === 'streaming'
      var avgMode = mode === 'avg'
      // 均速优先取本步实时均速（新宿主），缺失时回退到最后一步均速（兼容旧宿主）。
      var avg = null
      if (one !== null) {
        if (one.avgTps !== undefined && one.avgTps !== null) avg = one.avgTps
        else if (one.lastStepTps !== undefined && one.lastStepTps !== null) avg = one.lastStepTps
      }

      // 数值完全由模式决定，绝不自动来回跳：实时=窗口速度，均速=本步/最近一步平均。
      var target = one === null ? 0 : avgMode ? avg === null ? 0 : avg : one.tps
      if (shown < 0) shown = target
      else if (hasRate) {
        // 只有真有速率时才平滑追值；等首 token / 停下时直接落到目标值（0 或均速）。
        shown = shown + (target - shown) * 0.45
        if (Math.abs(shown - target) < 0.05) shown = target
      } else shown = target
      num.textContent = shown.toFixed(1)

      root.classList.toggle('is-idle-num', one === null)
      dot.className = 't-dot' + (phase === 'streaming' ? ' live' : phase === 'waiting' ? ' wait' : phase === 'done' ? ' done' : '')

      renderSessions(readings, one)

      if (one === null) {
        fields.step.textContent = '0'
        fields.total.textContent = '0'
        fields.ttft.textContent = '—'
        fields.cacheRow.style.display = 'none'
      } else {
        fields.step.textContent = fmtCount(one.stepTokens)
        fields.total.textContent = fmtCount(one.totalTokens)
        fields.ttft.textContent = fmtSeconds(one.ttftMs)
        // 缓存命中只有提供方在部分步骤上报，没数据就整行收起，不占版面。
        var cached = typeof one.cacheReadTokens === 'number' ? one.cacheReadTokens : 0
        if (cached > 0) {
          var last = typeof one.lastCacheReadTokens === 'number' ? one.lastCacheReadTokens : null
          fields.cacheRow.style.display = ''
          fields.cache.textContent = fmtCount(cached) + (last === null ? '' : ' (+' + fmtCount(last) + ')')
        } else {
          fields.cacheRow.style.display = 'none'
        }
      }

      // 状态行：只要整轮还没结束就露一行简讯（思考 / 跑工具期间数字会掉到 0，
      // 靠这行说明"其实还在干活"）；闲下来就整行收起，把地方让给会话列表。
      var busy = one !== null && isWorking(one)
      if (busy) {
        var statusText
        if (live) statusText = (PHASE_TEXT[phase] || phase) + ' · ' + fmtDuration(one.stepMs)
        else if (one.toolActive === true) statusText = '工具执行中…'
        else statusText = '思考中…'
        state.style.display = ''
        state.textContent = (one.sub ? '子代理 · ' : '') + statusText
      } else {
        state.style.display = 'none'
        state.textContent = ''
      }
      // 完整信息挂到 tooltip 上，不占版面。
      root.title = one === null
        ? ''
        : [
            one.title || one.dir || one.id,
            (avgMode ? '均速 ' : '实时 ') + shown.toFixed(1) + ' tok/s',
            '实时 ' + one.tps.toFixed(1),
            avg === null ? null : '均速 ' + avg.toFixed(1) + ' tok/s',
            'T' + one.turn + '/S' + one.step,
            '本步 ' + Math.round(one.stepMs / 1000) + 's',
            typeof one.cacheReadTokens === 'number' && one.cacheReadTokens > 0
              ? '缓存命中 ' + fmtCount(one.cacheReadTokens)
              : null,
            one.cwd || one.dir,
          ].filter(function (v) { return v !== null && v !== undefined && v !== '' }).join(' · ')

      // 波形只在实时口径显示（均速口径不需要它，省掉这块高度）。
      if (live) {
        history.push(one.tps)
        while (history.length > HISTORY_LEN) history.shift()
      }
      if (avgMode) {
        canvas.style.display = 'none'
      } else {
        canvas.style.display = ''
        if (!collapsed) drawSpark()
      }
    }

    var emptyHistory = []
    for (var k = 0; k < HISTORY_LEN; k += 1) emptyHistory.push(0)
    history = emptyHistory.slice()
    render([])

    /** 收到一轮后端读数：存原始列表 → 过滤关闭项 → 渲染。 */
    function update(sessions) {
      rawReadings = Array.isArray(sessions) ? sessions : []
      refresh()
    }

    return { update: update, refresh: refresh, root: root }
  }

  function start() {
    if (document.body === null) {
      document.addEventListener('DOMContentLoaded', start, { once: true })
      return
    }
    var ui = build()
    var failures = 0
    var timer = null
    var inflight = false

    function tick() {
      if (inflight) return schedule()
      inflight = true
      fetch(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        })
        .then(function (payload) {
          failures = 0
          ui.update(payload.sessions)
        })
        .catch(function () {
          failures += 1
          if (failures === 3) ui.update([])
        })
        .finally(function () {
          inflight = false
          schedule()
        })
    }

    function schedule() {
      if (timer !== null) clearTimeout(timer)
      var delay = failures > 2 ? 5000 : document.hidden ? POLL_HIDDEN_MS : POLL_MS
      timer = setTimeout(tick, delay)
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        if (timer !== null) clearTimeout(timer)
        tick()
      }
    })

    // ---- 自更新提示：脚本文件换了（宿主每次请求读磁盘）就在头部亮出「⟳」 ----
    var reloadBtn = ui.root.querySelector('[data-act="reload"]')
    reloadBtn.addEventListener('click', function () {
      window.location.reload()
    })
    function checkBuild() {
      fetch(SELF_ENDPOINT, { cache: 'no-store' })
        .then(function (res) {
          return res.ok ? res.text() : ''
        })
        .then(function (source) {
          var found = /var BUILD = '([^']+)'/.exec(source)
          if (found !== null && found[1] !== BUILD) reloadBtn.style.display = ''
        })
        .catch(function () {})
    }
    setTimeout(checkBuild, 15_000)
    setInterval(checkBuild, 60_000)

    tick()
  }

  start()
})()
