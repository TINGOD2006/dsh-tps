/** 在轻量 DOM 与虚拟时钟中运行完整注入脚本，验证轮询恢复，无网络或真实等待。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('./widget.js', import.meta.url), 'utf8')
const STATE = '/dsh-tps/state.json'

function element() {
  const children = new Map()
  const classes = new Set()
  return {
    style: {}, dataset: {}, textContent: '', parentNode: null,
    offsetWidth: 186, offsetHeight: 166,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name) },
    },
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, element())
      return children.get(selector)
    },
    querySelectorAll: () => [],
    addEventListener() {},
    appendChild(child) { child.parentNode = this },
    hasAttribute: () => false,
    getContext: () => ({ clearRect() {}, fillRect() {} }),
  }
}

async function drain() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

async function harness(fetcher) {
  let now = 0
  let timerId = 0
  let root
  const timers = new Map()
  const listeners = new Map()
  const calls = []
  const document = {
    hidden: false, body: element(), head: element(),
    querySelector: () => null,
    createElement(tag) { const node = element(); if (tag === 'div') root = node; return node },
    addEventListener(name, callback) { listeners.set(name, callback) },
  }
  function timer(callback, delay, interval = false) {
    timers.set(++timerId, { callback, due: now + delay, delay, interval })
    return timerId
  }
  const setTimeout = (callback, delay) => timer(callback, delay)
  runInNewContext(source, {
    document,
    window: { innerWidth: 1024, innerHeight: 768, addEventListener() {}, setTimeout },
    localStorage: { getItem: () => null, setItem() {} },
    AbortController,
    setTimeout, clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => timer(callback, delay, true),
    fetch(url, options) {
      const call = { url, options, time: now }
      calls.push(call)
      return fetcher(call)
    },
  })
  await drain()
  return {
    calls, document, root,
    stateCalls: () => calls.filter((call) => call.url === STATE),
    visibility(hidden) { document.hidden = hidden; listeners.get('visibilitychange')() },
    async advance(ms) {
      const until = now + ms
      while (true) {
        const next = [...timers].filter(([, task]) => task.due <= until)
          .sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        const [id, task] = next
        now = task.due
        if (task.interval) task.due += task.delay
        else timers.delete(id)
        task.callback()
        await drain()
      }
      now = until
      await drain()
    },
  }
}

function pending(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

function response() {
  return {
    ok: true,
    json: async () => ({ sessions: [{
      id: 'session', title: 'Test', phase: 'done', running: false, active: false,
      tps: 42, stepTokens: 8, totalTokens: 100, ttftMs: 250, stepMs: 1000,
    }] }),
    text: async () => "var BUILD = 'new-build'",
  }
}

for (const stage of ['响应头', '响应正文']) {
  test(`轮询：${stage}卡住后取消请求，并恢复显示`, async () => {
    let count = 0
    const h = await harness(({ options }) => {
      if (++count > 1) return Promise.resolve(response())
      const stalled = pending(options.signal)
      return stage === '响应头' ? stalled : Promise.resolve({ ok: true, json: () => stalled })
    })
    await h.advance(4999)
    assert.equal(h.calls[0].options.signal.aborted, false)
    await h.advance(1)
    assert.equal(h.calls[0].options.signal.aborted, true)
    await h.advance(400)
    assert.equal(h.stateCalls().length, 2)
    assert.equal(h.root.querySelector('.t-num').textContent, '42.0')
    await h.advance(400)
    assert.equal(h.stateCalls().length, 3)
    await h.advance(5000)
    assert.equal(h.calls[1].options.signal.aborted, false, '完成请求后应清除其超时计时器')
  })
}

test('轮询：连续失败三次清空旧读数并退避，成功后恢复正常频率', async () => {
  let count = 0
  const h = await harness(() => {
    count += 1
    return Promise.resolve(count >= 2 && count <= 4 ? { ok: false, status: 503 } : response())
  })
  assert.equal(h.root.querySelector('.t-num').textContent, '42.0')
  await h.advance(800)
  assert.equal(h.root.querySelector('.t-num').textContent, '42.0')
  await h.advance(400)
  assert.equal(h.root.querySelector('.t-num').textContent, '0.0')
  await h.advance(4999)
  assert.equal(h.stateCalls().length, 4)
  await h.advance(1)
  assert.equal(h.root.querySelector('.t-num').textContent, '42.0')
  await h.advance(400)
  assert.equal(h.stateCalls().length, 6)
})

test('轮询：切回页面不并发请求，后台降低频率，前台立即刷新', async () => {
  let finish
  let count = 0
  const h = await harness(() => ++count === 1
    ? new Promise((resolve) => { finish = resolve })
    : Promise.resolve(response()))
  for (let i = 0; i < 5; i += 1) { h.visibility(true); h.visibility(false) }
  await h.advance(400)
  assert.equal(h.stateCalls().length, 1)
  h.visibility(true)
  finish(response())
  await drain()
  await h.advance(1999)
  assert.equal(h.stateCalls().length, 1)
  await h.advance(1)
  assert.equal(h.stateCalls().length, 2)
  h.visibility(false)
  await drain()
  assert.equal(h.stateCalls().length, 3)
  await h.advance(400)
  assert.equal(h.stateCalls().length, 4)
})

test('版本检查：卡住时取消，下次检查可恢复且不影响读数轮询', async () => {
  let checks = 0
  const h = await harness(({ url, options }) => {
    if (url !== STATE && ++checks === 1) return pending(options.signal)
    return Promise.resolve(response())
  })
  await h.advance(15000)
  const first = h.calls.find((call) => call.url !== STATE)
  assert.ok(first)
  await h.advance(5000)
  assert.equal(first.options.signal.aborted, true)
  assert.equal(h.root.querySelector('.t-num').textContent, '42.0')
  await h.advance(40000)
  assert.equal(checks, 2)
  assert.equal(h.root.querySelector('[data-act="reload"]').style.display, '')
})
