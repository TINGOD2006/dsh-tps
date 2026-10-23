/**
 * dsh-tps 内核自测（node --test lib/tracker.test.js）。
 *
 * 锁住三件在真实会话日志上实测出来的行为，防止回归：
 *   1. 分片突发时窗口速度不得爆表（分母下限）；
 *   2. 流中静默超过 IDLE_MS 后实时速度必须归零，不得冻住残值；
 *   3. 「本步」在生成期间就要有数，而不是等到本步结束才跳出来。
 * 另外覆盖 block-end 兜底、缓存命中累计、登记表排序/过滤。
 *
 * 全部用例注入固定时间戳，不依赖真实时钟。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IDLE_MS,
  MIN_SPAN_MS,
  TRACKER_TTL_MS,
  WINDOW_MS,
  applyEvent,
  createRegistry,
  createTracker,
  dirName,
  estimateTokens,
  snapshot,
  windowTps,
} from './tracker.js'

/** 造一个已经 step/start 的追踪器。 */
function started(now = 0) {
  const tr = createTracker({ id: 'session-test', cwd: 'C:\\work\\dsh-tps', now })
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 1 }, time: now }, now)
  return tr
}

/** 灌一个 text-delta（`text` 为 ASCII，长度 8 = 2 token）。 */
function delta(tr, text, time) {
  applyEvent(tr, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text } }, time }, time)
}

test('IDLE_MS 不小于 WINDOW_MS —— 这是"不冻残值"的结构前提', () => {
  // 若 IDLE_MS < WINDOW_MS，就存在一段「仍判为生成中、但窗口内已无样本」的区间，
  // 那时窗口速度只能回退到陈旧值（旧版就是这么冻住 165.7 tok/s 的）。
  assert.ok(
    IDLE_MS >= WINDOW_MS,
    `IDLE_MS(${IDLE_MS}) 必须 >= WINDOW_MS(${WINDOW_MS})，否则会出现冻结残值区间`,
  )
  assert.equal(MIN_SPAN_MS, 1100)
})

test('estimateTokens：ASCII 4 字符 1 token，CJK 每字 0.6', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('中文'), 1.2)
  assert.equal(estimateTokens(null), 0)
})

test('dirName：取路径末级目录', () => {
  assert.equal(dirName('C:\\work\\dsh-tps'), 'dsh-tps')
  assert.equal(dirName('/home/u/proj'), 'proj')
  assert.equal(dirName(''), '')
})

test('窗口速度：同一毫秒的突发分片不得爆表（分母下限）', () => {
  const tr = started(0)
  // 20 个分片全部落在 t=0：真实速率无法定义，窗口必须用 MIN_SPAN_MS 当分母。
  for (let i = 0; i < 20; i += 1) delta(tr, 'aaaaaaaa', 0)
  const tps = windowTps(tr, 0)
  // 40 token / 1.1s ≈ 36.4。旧下限 300ms 会给出 133.3（约 3.7 倍虚高）。
  assert.ok(tps > 30 && tps < 50, `突发窗口速度应被下限压住，实测 ${tps}`)
  assert.ok(tps < 40 / (0.3), '不得回到 300ms 下限时的虚高值')
})

test('高密度分片：同毫秒超过样本上限时仍保留全部 token', () => {
  const tr = started(1000)
  for (let i = 0; i < 10000; i += 1) delta(tr, 'abcdefgh', 1100)
  assert.equal(tr.streamEstTokens, 20000)
  assert.equal(tr.samples.length, 1)
  assert.equal(windowTps(tr, 1100), 20000 / (MIN_SPAN_MS / 1000))
})

test('合并分片：窗口边界与逐分片参考计算一致，长期输出保持有界', () => {
  const tr = started(1000)
  const reference = { samples: [] }
  for (let time = 1100; time <= 7100; time += 1) {
    for (let i = 0; i < 3; i += 1) {
      delta(tr, 'abcdefgh', time)
      reference.samples.push({ t: time, n: 2 })
    }
    if ((time - 1100) % 500 === 0) {
      assert.equal(windowTps(tr, time), windowTps(reference, time))
    }
  }
  for (const time of [7100, 7101, 9099, 9100, 9101]) {
    assert.equal(windowTps(tr, time), windowTps(reference, time))
  }
  assert.ok(tr.samples.length <= WINDOW_MS * 2 + 1)
  assert.equal(tr.streamEstTokens, 6001 * 6)
})

test('实时速度：流中静默超过 IDLE_MS 后归零，不冻住残值', () => {
  const tr = started(1000)
  delta(tr, 'abcdefgh', 1100) // 2 token
  const live = snapshot(tr, 1200)
  assert.ok(live.tps > 0, '刚产出时应给出非零实时速度')
  assert.equal(live.running, true)

  // 静默 1500ms：仍在 IDLE_MS 之内 → 仍算生成中。
  const stillOn = snapshot(tr, 1100 + IDLE_MS - 1)
  assert.equal(stillOn.running, true)
  assert.ok(stillOn.tps > 0, '窗口内还有样本时不应归零')

  // 静默超过 IDLE_MS：phase 仍是 streaming，但速度必须是 0（旧版在这里返回陈旧值）。
  const frozen = snapshot(tr, 1100 + IDLE_MS + 1)
  assert.equal(frozen.phase, 'streaming')
  assert.equal(frozen.running, false)
  assert.equal(frozen.tps, 0, '静默超时后必须归零，不得冻住残值')

  // 再往后也保持 0（不得复活）。
  assert.equal(snapshot(tr, 1100 + IDLE_MS + 5000).tps, 0)
})

test('「本步」在生成期间就有数（旧版恒 0 直到本步结束）', () => {
  const tr = started(0)
  delta(tr, 'abcdefgh', 100) // 2 token
  assert.equal(snapshot(tr, 100).stepTokens, 2)
  delta(tr, 'abcdefgh', 200)
  assert.equal(snapshot(tr, 200).stepTokens, 4)

  // 提供方上报精确 usage 后，以精确值为准。
  applyEvent(
    tr,
    { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { outputTokens: 309 } } }, time: 300 },
    300,
  )
  assert.equal(snapshot(tr, 300).stepTokens, 309)
})

test('block-end 兜底：该块没收到过 delta 时才计入', () => {
  const tr = started(0)
  // 块 0 一个 delta 都没来，块结束带整段文本 → 兜底计入（8 ASCII = 2 token）。
  applyEvent(
    tr,
    { type: 'assistant/chunk', data: { chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'abcdefgh' } } }, time: 100 },
    100,
  )
  assert.equal(snapshot(tr, 100).stepTokens, 2)

  // 块 1 已经有 delta（'abcdefgh' = 2 token），块结束不得把同一段再算一遍。
  delta(tr, 'abcdefgh', 200)
  const before = snapshot(tr, 200).stepTokens
  applyEvent(
    tr,
    { type: 'assistant/chunk', data: { chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'abcdefgh' } } }, time: 210 },
    210,
  )
  assert.equal(snapshot(tr, 210).stepTokens, before, '有 delta 的块不得被 block-end 重复计入')
})

test('block-end 兜底：tool-call 块的 arguments 也能兜底', () => {
  const tr = started(0)
  applyEvent(
    tr,
    {
      type: 'assistant/chunk',
      data: { chunk: { type: 'block-end', index: 3, block: { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: 'abcdefgh' } } },
      time: 100,
    },
    100,
  )
  assert.equal(snapshot(tr, 100).stepTokens, 2)
})

test('缓存命中 token 累计，并在每步 step/start 时不清零', () => {
  const tr = started(0)
  const usage = (n, cache) =>
    applyEvent(
      tr,
      { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: cache === undefined ? { outputTokens: n } : { outputTokens: n, cacheReadTokens: cache } } }, time: 100 },
      100,
    )
  usage(10, 32000)
  assert.equal(snapshot(tr, 100).cacheReadTokens, 32000)
  assert.equal(snapshot(tr, 100).lastCacheReadTokens, 32000)

  // 下一步：带 256 命中
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 2 }, time: 200 }, 200)
  usage(20, 256)
  const s = snapshot(tr, 200)
  assert.equal(s.cacheReadTokens, 32256, '缓存命中应跨步骤累计')
  assert.equal(s.lastCacheReadTokens, 256)

  // 没上报命中的步骤：累计不变，last 保留上次值（不误清零）。
  applyEvent(tr, { type: 'step/start', data: { turn: 1, step: 3 }, time: 300 }, 300)
  usage(30)
  assert.equal(snapshot(tr, 300).cacheReadTokens, 32256)
})

test('turn/end 回到空闲：不再报 running', () => {
  const tr = started(0)
  delta(tr, 'abcdefgh', 100)
  applyEvent(tr, { type: 'turn/end', data: undefined, time: 200 }, 200)
  const s = snapshot(tr, 200)
  assert.equal(s.phase, 'idle')
  assert.equal(s.running, false)
  assert.equal(s.tps, 0)
  assert.equal(s.active, false)
})

test('校准：用精确 usage 收敛估算系数，且限幅', () => {
  const tr = started(0)
  delta(tr, 'abcdefgh', 100) // 估算 2 token
  applyEvent(
    tr,
    { type: 'assistant/message', data: { usage: { outputTokens: 100 } }, time: 200 },
    200,
  )
  // ratio = 100/2 = 50，被限幅到 3 → calibration = 1*0.7 + 3*0.3 = 1.6
  assert.equal(snapshot(tr, 200).calibration, 1.6)
  assert.equal(snapshot(tr, 200).totalTokens, 100)
  assert.equal(snapshot(tr, 200).phase, 'done')
})

test('登记表：无产出的会话不占位；有整轮在跑的会话必须显示', () => {
  const reg = createRegistry()
  const mk = (id) => ({ id, header: { cwd: 'C:\\work\\' + id } })

  // 只有 turn/start（还在思考，没吐 token）→ 必须显示，否则用户以为浮窗坏了。
  reg.onEvent(mk('a'), { type: 'turn/start', data: { turn: 1 } }, 0)
  assert.equal(reg.readings(0).length, 1)

  // 完全没有任何事件的会话不显示。
  reg.onEvent(mk('b'), { type: 'assistant/message', data: { usage: { outputTokens: 5 } } }, 0)
  assert.equal(reg.readings(0).length, 2)
  const ids = reg.readings(0).map((r) => r.id)
  assert.ok(ids.includes('a') && ids.includes('b'))
})

test('登记表：子代理会话判据（header.origin / delegationDepth）', () => {
  const reg = createRegistry()
  reg.onEvent(
    { id: 'main', header: { cwd: 'C:\\w', origin: undefined, delegationDepth: 0 } },
    { type: 'turn/start', data: { turn: 1 } },
    0,
  )
  reg.onEvent(
    { id: 'kid', header: { cwd: 'C:\\w', origin: 'subagent', delegationDepth: 1, parentSession: 'main' } },
    { type: 'turn/start', data: { turn: 1 } },
    0,
  )
  const byId = Object.fromEntries(reg.readings(0).map((r) => [r.id, r]))
  assert.equal(byId.main.sub, false)
  assert.equal(byId.kid.sub, true)
  // 排序：两个都在 running，子代理靠后。
  assert.equal(reg.readings(0)[0].id, 'main')
})

test('登记表：会话标题来自 session/title，且取最新一条', () => {
  const reg = createRegistry()
  const s = { id: 'x', header: { cwd: 'C:\\w' } }
  reg.onEvent(s, { type: 'session/title', data: { title: '  旧标题  ' } }, 0)
  reg.onEvent(s, { type: 'session/title', data: { title: '新标题' } }, 1)
  reg.onEvent(s, { type: 'turn/start', data: { turn: 1 } }, 1)
  assert.equal(reg.readings(1)[0].title, '新标题')
})

test('登记表：没有状态请求时，事件流也会回收过期会话', () => {
  const reg = createRegistry()
  reg.onEvent({ id: 'expired' }, { type: 'turn/end' }, 1000)
  const now = 1000 + TRACKER_TTL_MS + 1
  reg.onEvent({ id: 'current' }, { type: 'turn/start' }, now)
  assert.equal(reg.count(), 1)
  assert.equal(reg.readings(now)[0].id, 'current')
})

test('登记表：恢复活动的旧会话先更新再回收，累计用量不丢失', () => {
  const reg = createRegistry()
  const session = { id: 'returning' }
  reg.onEvent(session, { type: 'assistant/message', data: { usage: { outputTokens: 50 } } }, 1000)
  const now = 1000 + TRACKER_TTL_MS + 1
  reg.onEvent(session, { type: 'turn/start' }, now)
  assert.equal(reg.readings(now)[0].totalTokens, 50)
})

test('登记表：事件流按分钟回收，保留 TTL 边界与最近活动会话', () => {
  const reg = createRegistry()
  reg.onEvent({ id: 'old' }, { type: 'turn/end' }, 1000)
  const boundary = 1000 + TRACKER_TTL_MS
  reg.onEvent({ id: 'current' }, { type: 'turn/start' }, boundary)
  assert.equal(reg.count(), 2, 'TTL 边界上的会话还未过期')
  reg.onEvent({ id: 'current' }, { type: 'step/start' }, boundary + 1)
  assert.equal(reg.count(), 2, '连续分片不应触发逐条全表扫描')
  reg.onEvent({ id: 'current' }, { type: 'step/start' }, boundary + 60000)
  assert.equal(reg.count(), 1)
  assert.equal(reg.readings(boundary + 60000)[0].id, 'current')
})
