/**
 * dsh-tps —— 会话实时输出吞吐（t/s）读数。
 *
 * 本插件是 `dsh-tps-desktop-boot` 与 `dsh-tps-meter@0.1.1` 的合并体：两者做的是
 * 同一件事（把会话实时 tok/s 读数喂给页面里的一块 UI），但各自只覆盖一半场景。
 * 合并后一条数据链路同时服务两种部署形态，不再需要二选一。
 *
 * 两半各自缺什么
 * --------------
 * `dsh-tps-meter`（上游 npm 版）在桌面版外殼上有两个不成立的前提：
 *
 * 1) **注入**：它用 `ctx.webServer.tapIndex()` 把 `<script src=…>` 塞进 index.html。
 *    `tapIndex` 只在「Host 自己渲染 index.html」时生效
 *    （`dsh-host-webserver/lib/index.js:533-535`：taps 只在 `renderIndex()` 里跑）。
 *    桌面版走 Electron 直接读磁盘（`lib/main.js` 的 `serveWebDocument`），
 *    Host 提供的只是**结构化注入行**
 *    （`ctx.webServer.collectIndexInjections()` → `renderIndexInjections()`），
 *    由页面侧解释器消费。
 *
 * 2) **数据源**：它的 tracker 监听 `assistant/chunk`，该事件名在 0.2.x 里不存在
 *    （见 `dsh-session/lib/types/known-event-types.js`）。串流分片实际通过
 *    `agent/assistant-stream` 发布（`dsh-agent-loop/lib/index.js`
 *    `this.dispatch.emit("agent/assistant-stream", { frame })`），
 *    首方消费者一律写 `ctx.on("agent/assistant-stream", ({ agent, frame }) => …)`。
 *    拿不到 chunk → 滑动窗口永远没样本 → 浮窗恒为 0。
 *
 * 反过来，只保留 desktop-boot 那一半也不行：它没有 `tapIndex`，在 `dsh web`
 * 这类由 Host 自己渲染 index.html 的部署里就少一条兜底注入路径。
 *
 * 因此本插件的 `apply()` 是两者的并集：两条订阅都挂，两条注入路径都用。
 *
 * 为什么用 `kind: "script"` 内联加载器，而不是 `kind: "script-src"`
 * -----------------------------------------------------------------
 * `script-src` 渲染成 `<script src>` 且**不带 defer**（`renderRow` 的
 * `script-src` 分支），而 head rows 插在 `<head>` 开头的紧后位置，
 * 会在 body 之前同步执行 —— 那时浮窗要挂的 DOM 还不存在。
 * 内联 `script` 行永远不会加载失败，它自己再 async 挂 `<script src>` 并吞掉
 * `onerror`：最坏情况只是浮窗不出现。
 *
 * 与 `tapIndex` 的关系：两者都可能在同一次页面渲染里生效（浏览器部署会先渲染
 * 注入行、再跑 taps）。`tapIndex` 里的 `html.indexOf(SCRIPT_PATH)` 判断正是为此
 * 存在的去重闸门；即便两道都漏过，widget.js 自身的 `window.__dshTpsMeter`
 * 守卫也保证重复注入无副作用。
 *
 * 只读观测：不注册投影、不写会话日志、不改模型请求，卸载即净。
 *
 * @module dsh-tps
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRegistry } from './tracker.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET_FILE = path.join(HERE, 'widget.js')

/** 路由命名空间。exact 路由重复注册会抛错（`register()` 的 duplicate 分支）。 */
const BASE = '/dsh-tps'
const SCRIPT_PATH = `${BASE}/widget.js`
const STATE_PATH = `${BASE}/state.json`

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}
const JS_HEADERS = {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** Cordis 插件名（同时是 loader 条目 id 与 profile insert 行的 name）。 */
export const name = 'dsh-tps'

/** 需要能挂 HTTP 路由的 webServer。 */
export const inject = ['webServer']

/**
 * 内联引导脚本：挂上浮窗脚本，加载失败只吞掉错误。
 * 只用 ES5 语法，避免任何解析期问题。
 */
const LOADER = [
  '(function(){try{',
  'var s=document.createElement("script");',
  's.src=' + JSON.stringify(SCRIPT_PATH) + ';',
  's.async=true;',
  's.onerror=function(){};',
  'document.head.appendChild(s)',
  '}catch(e){}})()',
].join('')

/**
 * 挂载插件：接实时事件流 → registry → 状态端点 + 浮窗脚本 + 注入。
 * @param {object} ctx - 宿主 cordis 上下文。
 */
export function apply(ctx) {
  const registry = createRegistry()

  /** 观察者绝不能把失败带进会话提交路径（firehose 是 fire-and-forget）。 */
  const warn = (what, err) => {
    try {
      ctx.logger?.warn?.(`${name}: ${what}: %s`, String((err && err.message) || err))
    } catch (ignored) {}
  }

  // ── 1) 真正的实时来源：assistant 串流分片 ────────────────────────────────
  // frame 形状：{ type: 'start' | 'chunk' | 'end', attemptId, revision, index, time, chunk? }
  // chunk 形状与 tracker 期望的 `assistant/chunk` 载荷完全一致，故直接转译喂进去。
  ctx.on(
    'agent/assistant-stream',
    (payload) => {
      try {
        const frame = payload?.frame
        if (frame === null || typeof frame !== 'object' || frame.type !== 'chunk') return
        const session = payload?.agent?.session
        if (session === null || typeof session !== 'object') return
        const time = typeof frame.time === 'number' && frame.time > 0 ? frame.time : Date.now()
        registry.onEvent(session, { type: 'assistant/chunk', data: { chunk: frame.chunk }, time }, time)
      } catch (err) {
        warn('assistant-stream 处理失败', err)
      }
    },
    { global: true },
  )

  // ── 2) 落盘会话事件：标题、turn/step 边界、精确 usage ────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      registry.onEvent(session, event, Date.now())
    } catch (err) {
      warn('session/event 处理失败', err)
    }
  })

  const disposers = []

  // ── 3) 浮窗读的实时读数 ─────────────────────────────────────────────────
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        const now = Date.now()
        let sessions = []
        try {
          sessions = registry.readings(now)
        } catch (err) {}
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, now, sessions }))
      },
    }),
  )

  // 浮窗脚本本体（每次读磁盘：改完刷新页面即生效，无需重启）。
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: SCRIPT_PATH,
      handler: (req, res) => {
        try {
          const source = fs.readFileSync(WIDGET_FILE, 'utf8')
          res.writeHead(200, JS_HEADERS)
          res.end(source)
        } catch (err) {
          res.writeHead(500, { ...JS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`${name}: widget.js unreadable: ` + String((err && err.message) || err))
        }
      },
    }),
  )

  // ── 4) 结构化注入行：桌面版外殼唯一受支持的注入方式 ──────────────────────
  // Host 把这一表交给两种渲染器：自己渲染 index.html 时渲染成 markup，
  // 静态 worker/Electron 部署时随 boot 载荷下发，由页面侧解释器消费。
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    table.push({ kind: 'script', placement: 'head', text: LOADER })
  })

  // ── 5) 兜底：Host 自己渲染 index.html 时直接改 HTML ─────────────────────
  // 只认 harness 自己的 index，避免污染其它 HTML。
  // 注入行已生效时下面的 indexOf 判断会拦下重复标签；即便如此，
  // widget.js 的 `window.__dshTpsMeter` 守卫也让重复注入无副作用。
  disposers.push(
    ctx.webServer.tapIndex((html) => {
      if (typeof html !== 'string') return html
      if (html.indexOf('__DSH_BOOT__') === -1) return html
      if (html.indexOf(SCRIPT_PATH) !== -1) return html
      const tag = `<script defer src="${SCRIPT_PATH}"></script>`
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', `${tag}</body>`)
      return html + tag
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (err) {}
    }
  })
}
