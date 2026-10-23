/**
 * dsh-tps-meter 纯逻辑内核：把会话事件折成"实时输出吞吐"读数。
 *
 * 数据来源是宿主 `session/event` firehose 里的流式事件：
 *   - `step/start`        一个模型调用开始（计时起点）
 *   - `assistant/chunk`   原始流式分片（text / reasoning / tool-call delta，以及 usage）
 *   - `assistant/message` 一步组装完成（带提供方精确 usage，用来校正估算）
 *   - `turn/end`          一轮结束（回到空闲）
 *
 * 速度用滑动窗口算：窗口内估算 token 数 ÷ 窗口真实跨度，避免"整步平均"把
 * 首 token 等待时间也算进速度里。估算用固定启发式（ASCII 4 字符 ≈ 1 token，
 * 非 ASCII 字符 ≈ 0.6 token），再用每个已完成步骤的提供方 usage 做指数校正，
 * 因此显示值会随会话进行逐步贴近真实值。
 */

/** 滑动窗口长度（毫秒）：越小越"瞬时"，越大越平滑。 */
export const WINDOW_MS = 2000
/**
 * 窗口真实跨度的下限（毫秒）。
 *
 * 分片不是均匀到达的，而是「同一毫秒成簇到达、随后静默数秒」：实测本仓 40364 个
 * 分片间隔，p50 = 0ms、p90 = 0ms、p99 = 1ms，而 p99.9 = 3433ms。
 * 用「最旧样本 → now」这种极短跨度当分母，会把一簇分片外推成爆表数字。
 *
 * 用 54 个真实步骤重放对比（分母下限 / p95 倍真实值 / 中位倍真实值）：
 *   300ms（旧值）→ 4.09 / 1.27   1100ms → 1.20 / 0.98   1300ms → 1.13 / 0.87
 * 取 1100ms 是「不再系统性高估」与「不过度滞后」的交点。
 * 对照被否决的方案：EWMA(τ=1200) 中位只有 0.41（长期偏低），
 * 单分片限幅 cap=6 时 p95 仍 1.73。
 */
export const MIN_SPAN_MS = 1100
/**
 * 距最后一次流式分片超过该时长即视为"已停止输出"（毫秒）。
 *
 * 取值必须 ≥ WINDOW_MS：两者相等时，「仍在生成」蕴含窗口内必然还有样本，
 * 于是窗口速度不可能返回陈旧残值（旧版取 1500 < 2000，会在流中静默 1.5–2s 时
 * 把上一次的 lastTps 冻在屏幕上）。
 * 实测本仓分片间隔 ≥2000ms 的只占 0.473%，所以对齐窗口长度不会引入可见抖动。
 */
export const IDLE_MS = 2000
/** 无事件超过该时长的会话从登记表中回收（毫秒）。 */
export const TRACKER_TTL_MS = 30 * 60 * 1000
/** 单会话保留的时间样本上限；同毫秒分片合并，避免突发输出挤掉有效 token。 */
const MAX_SAMPLES = 4000
/** 事件流最多每分钟扫描一次登记表，避免每个分片都遍历所有会话。 */
const SWEEP_INTERVAL_MS = 60 * 1000

/** ASCII 字符每 token 字符数（英文粗略 4 字符 ≈ 1 token）。 */
const ASCII_PER_TOKEN = 4
/** 非 ASCII 字符（CJK 等）每字符 token 数。 */
const WIDE_PER_CHAR = 0.6

/**
 * 估算一段流式文本的 token 数。
 * @param {string} text - 增量文本。
 * @returns {number} 估算 token 数（非负）。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) < 0x80) ascii += 1
    else wide += 1
  }
  return ascii / ASCII_PER_TOKEN + wide * WIDE_PER_CHAR
}

/**
 * 取 cwd 的末级目录名做显示名。
 * @param {string|undefined} cwd - 会话工作目录。
 * @returns {string} 显示用短名。
 */
export function dirName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0)
  return parts.length === 0 ? cwd : parts[parts.length - 1]
}

/**
 * 新建一个会话追踪器。
 * @param {{ id: string, cwd?: string, sub?: boolean, title?: string, now: number }} meta - 会话标识与初始时间。
 * @returns {object} 追踪器状态。
 */
export function createTracker({ id, cwd, sub = false, title = '', now }) {
  return {
    id,
    cwd: cwd ?? '',
    dir: dirName(cwd),
    /** 会话标题（来自 dsh-session-title 的 `session/title` 事件）。 */
    title,
    /** 是否是 subagent 子会话（浮窗排序时让位于主会话）。 */
    sub,
    /** 是否有一轮正在进行（turn/start 已发生、turn/end 未发生）：思考与跑工具期间也为真。 */
    turnOpen: false,
    /** 尚未返回结果的工具调用 id（用来把状态行区分为"工具执行中"）。 */
    toolCalls: new Set(),
    createdAt: now,
    turn: 0,
    step: 0,
    /** idle | waiting（已发请求未见首 token）| streaming | done（本步已结束） */
    phase: 'idle',
    stepStartMs: 0,
    firstTokenMs: 0,
    /** 当前窗口样本：{ t, n }，相邻同毫秒分片合并。 */
    samples: [],
    /** 当前步骤的估算输出 token 累计。 */
    streamEstTokens: 0,
    /** 当前步骤最后显示的 token 数（精确值优先，流中用估算兜底）。 */
    stepTokens: 0,
    /**
     * 本步已经收到过 delta 的块序号集合。
     * `block-end` 携带整段聚合文本，只在某个块「一个 delta 都没收到」时才拿它兜底，
     * 否则会把同一段文本计两遍（delta 一遍、块结束一遍）。
     */
    deltaBlocks: new Set(),
    /** 提供方上报的当前步骤输出 token（有则优先）。 */
    exactStepTokens: null,
    /** 会话累计输出 token（精确值优先，缺则用估算校正值）。 */
    totalTokens: 0,
    /** 会话累计「缓存命中读取」token（提供方部分步骤才上报，缺则不加）。 */
    cacheReadTokens: 0,
    /** 最近一次上报的缓存命中量（用于展示"这一步省了多少"）。 */
    lastCacheReadTokens: null,
    /** 最近一步的首 token 延迟（毫秒），null 表示尚无。 */
    ttftMs: null,
    /** 最近一步的解码时长（毫秒）与平均速度。 */
    lastStepMs: null,
    lastStepTps: null,
    /** 估算→精确 的校正系数（EMA），完成后由精确 usage 收敛。 */
    calibration: 1,
    lastEventMs: now,
  }
}

/** 把样本裁剪到窗口的两倍长度以内。 */
function pruneSamples(tr, now) {
  const keepFrom = now - WINDOW_MS * 2
  let cut = 0
  while (cut < tr.samples.length && tr.samples[cut].t < keepFrom) cut += 1
  if (cut > 0) tr.samples.splice(0, cut)
  if (tr.samples.length > MAX_SAMPLES) tr.samples.splice(0, tr.samples.length - MAX_SAMPLES)
}

/**
 * 计算窗口内实时速度。
 * @param {object} tr - 追踪器。
 * @param {number} now - 当前时间戳。
 * @param {number} [windowMs] - 窗口长度。
 * @returns {number} tok/s（无样本时为 0）。
 */
export function windowTps(tr, now, windowMs = WINDOW_MS) {
  const from = now - windowMs
  let sum = 0
  let oldest = null
  let newest = 0
  for (const s of tr.samples) {
    if (s.t < from) continue
    sum += s.n
    if (oldest === null) oldest = s.t
    newest = s.t
  }
  if (sum <= 0 || oldest === null) return 0
  // 用样本真实跨度（而非整个窗口）当分母：窗口还没铺满时才算得准。
  const span = Math.max(Math.max(newest, now) - oldest, MIN_SPAN_MS)
  return sum / (span / 1000)
}

/** 记一次 token 增量：入窗口 + 更新步骤估算。 */
function pushTokens(tr, tokens, now) {
  if (tokens <= 0) return
  const last = tr.samples[tr.samples.length - 1]
  if (last !== undefined && last.t === now) {
    last.n += tokens
  } else {
    tr.samples.push({ t: now, n: tokens })
    pruneSamples(tr, now)
  }
  tr.streamEstTokens += tokens
  tr.lastEventMs = now
  if (tr.firstTokenMs === 0) tr.firstTokenMs = now
  tr.phase = 'streaming'
  // 「本步」在生成期间就要有数：旧版只在 assistant/message 落盘时才写 stepTokens，
  // 于是整个生成过程浮窗那一行恒为 0，直到本步结束才跳到精确值。
  // 提供方已上报精确 usage 时仍以精确值为准。
  tr.stepTokens = tr.exactStepTokens !== null ? tr.exactStepTokens : tr.streamEstTokens
}

/**
 * 应用一条会话事件。
 * @param {object} tr - 追踪器（原地更新）。
 * @param {{ type: string, data?: any, time?: number }} event - 会话事件。
 * @param {number} now - 当前时间戳。
 * @returns {object} 同一个追踪器。
 */
export function applyEvent(tr, event, now) {
  if (event === null || typeof event !== 'object') return tr
  const data = event.data ?? {}
  const stamp = typeof event.time === 'number' && event.time > 0 ? event.time : now
  tr.lastEventMs = Math.max(tr.lastEventMs, stamp)

  switch (event.type) {
    case 'session/title': {
      // 会话标题是仅写日志的 session/title 事件（dsh-session-title 产出），
      // 最新一条即当前标题；它不参与吞吐统计，只用于浮窗显示。
      const title = data.title
      if (typeof title === 'string' && title.trim().length > 0) tr.title = title.trim()
      return tr
    }
    case 'turn/start': {
      tr.turn = typeof data.turn === 'number' ? data.turn : tr.turn
      // 一轮开始 → 直到 turn/end 之前都算"在干活"（思考、跑工具、等工具结果
      // 这些空档里没有 chunk，只看流式活动会误判成"已完成"）。
      tr.turnOpen = true
      if (tr.phase === 'idle' || tr.phase === 'done') tr.phase = 'waiting'
      return tr
    }
    case 'step/start': {
      tr.turn = typeof data.turn === 'number' ? data.turn : tr.turn
      tr.step = typeof data.step === 'number' ? data.step : tr.step
      tr.phase = 'waiting'
      tr.stepStartMs = stamp
      tr.firstTokenMs = 0
      tr.samples = []
      tr.streamEstTokens = 0
      tr.stepTokens = 0
      tr.exactStepTokens = null
      tr.deltaBlocks.clear()
      return tr
    }
    case 'assistant/chunk': {
      const chunk = data.chunk
      if (chunk === null || typeof chunk !== 'object') return tr
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        if (typeof chunk.index === 'number') tr.deltaBlocks.add(chunk.index)
        pushTokens(tr, estimateTokens(chunk.text) * tr.calibration, stamp)
        return tr
      }
      if (chunk.type === 'tool-call-delta') {
        if (typeof chunk.index === 'number') tr.deltaBlocks.add(chunk.index)
        pushTokens(tr, estimateTokens(chunk.argumentsDelta) * tr.calibration, stamp)
        return tr
      }
      if (chunk.type === 'block-end') {
        // 兜底：正常路径每个块都有 delta，但宿主重连 / 分片丢失时某个块可能一个
        // delta 都没到，此时块结束携带的整段聚合文本是唯一的增量来源。
        // 只有在该块确实没收到过 delta 时才计入，否则同一段文本会被算两遍。
        const block = chunk.block
        const index = chunk.index
        if (block !== null && typeof block === 'object' && typeof index === 'number' && !tr.deltaBlocks.has(index)) {
          const text = typeof block.text === 'string' ? block.text : typeof block.arguments === 'string' ? block.arguments : ''
          if (text.length > 0) pushTokens(tr, estimateTokens(text) * tr.calibration, stamp)
        }
        return tr
      }
      if (chunk.type === 'usage') {
        const usage = chunk.usage
        const out = usage?.outputTokens
        if (typeof out === 'number' && Number.isFinite(out) && out >= 0) {
          tr.exactStepTokens = out
          tr.stepTokens = out
        }
        // 缓存命中量：提供方只在部分步骤上报，但它是判断"这次请求贵不贵"的关键读数，
        // 旧版直接丢弃了。累计的是本次会话所有步骤的命中总量。
        const cached = usage?.cacheReadTokens
        if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) {
          tr.lastCacheReadTokens = cached
          tr.cacheReadTokens += cached
        }
        return tr
      }
      return tr
    }
    case 'assistant/message': {
      const exact = data.usage?.outputTokens
      const est = tr.streamEstTokens
      if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0) {
        // 用精确值校正估算系数（限幅，避免单步异常把系数带飞）。
        if (est > 0.5) {
          const ratio = Math.min(3, Math.max(0.3, exact / est))
          tr.calibration = tr.calibration * 0.7 + ratio * 0.3
        }
        tr.stepTokens = exact
        tr.totalTokens += exact
      } else {
        // 估算值在入账时已按当时的校正系数计入，这里直接采用。
        tr.stepTokens = est
        tr.totalTokens += est
      }
      const decodeMs = tr.firstTokenMs > 0 ? Math.max(0, stamp - tr.firstTokenMs) : 0
      tr.ttftMs = tr.firstTokenMs > 0 ? Math.max(0, tr.firstTokenMs - tr.stepStartMs) : tr.ttftMs
      tr.lastStepMs = decodeMs
      tr.lastStepTps = decodeMs >= 200 ? tr.stepTokens / (decodeMs / 1000) : null
      tr.samples = []
      tr.streamEstTokens = 0
      tr.deltaBlocks.clear()
      tr.phase = 'done'
      return tr
    }
    case 'tool/call': {
      const callId = data.callId
      if (typeof callId === 'string') tr.toolCalls.add(callId)
      return tr
    }
    case 'tool/result': {
      const callId = data.message?.source?.callId
      if (typeof callId === 'string') tr.toolCalls.delete(callId)
      return tr
    }
    case 'turn/end': {
      tr.turnOpen = false
      tr.toolCalls.clear()
      tr.phase = 'idle'
      tr.samples = []
      tr.deltaBlocks.clear()
      return tr
    }
    default:
      return tr
  }
}

/**
 * 生成对外读数（HTTP 路由与浮窗消费的形状）。
 * @param {object} tr - 追踪器。
 * @param {number} now - 当前时间戳。
 * @returns {object} 读数快照。
 */
export function snapshot(tr, now) {
  const quiet = now - tr.lastEventMs
  const streaming = tr.phase === 'streaming' && quiet < IDLE_MS
  const waiting = tr.phase === 'waiting' && quiet < IDLE_MS
  // 只有"确实还在生成 / 还在等首 token"才给实时速度，否则一律 0。
  // 旧版在这里多写了一个 `: tr.phase === 'streaming' ? tr.lastTps : 0` 兜底，
  // 于是流中静默超过 IDLE_MS 后，屏幕上会冻住上一次的 lastTps（实测冻在 165.7，
  // 持续 1.5–2.8 秒）——数字不归零，看起来像还在按那个速度产出。
  // 现在 IDLE_MS === WINDOW_MS，`streaming` 为真即蕴含窗口内必有样本，
  // 不再需要（也不允许）回退到陈旧值。
  const tps = streaming || waiting ? windowTps(tr, now) : 0

  // 均速：生成中实时算「本步至今」的平均速度，结束后定格为最近一步的平均速度。
  let avgTps = tr.lastStepTps
  let avgMs = tr.lastStepMs
  if (streaming && tr.firstTokenMs > 0) {
    const decodeMs = Math.max(0, now - tr.firstTokenMs)
    const tokens = tr.exactStepTokens !== null ? tr.exactStepTokens : tr.streamEstTokens
    avgMs = decodeMs
    avgTps = decodeMs >= 200 ? tokens / (decodeMs / 1000) : null
  }

  return {
    id: tr.id,
    dir: tr.dir,
    cwd: tr.cwd,
    /** 会话标题（可能为空串：标题还没生成，或旧宿主没带）。 */
    title: tr.title,
    /** true = subagent 子会话。 */
    sub: tr.sub,
    /** waiting | streaming | done | idle */
    phase: waiting ? 'waiting' : tr.phase,
    running: streaming || waiting,
    /** 整轮是否还没结束（含思考 / 跑工具的空档）：浮窗据此判断"在干活"。 */
    active: tr.turnOpen,
    /** 是否有工具调用正在执行（结果还没回来）。 */
    toolActive: tr.toolCalls.size > 0,
    /** 实时窗口速度（只有生成中才有意义）。 */
    tps: Number.isFinite(tps) ? Math.round(tps * 10) / 10 : 0,
    /** 本步（或最近一步）平均速度。 */
    avgTps: avgTps === null || !Number.isFinite(avgTps) ? null : Math.round(avgTps * 10) / 10,
    /** 均速对应的解码时长（毫秒）。 */
    avgMs: avgMs === null || !Number.isFinite(avgMs) ? null : Math.round(avgMs),
    stepTokens: Math.round(tr.stepTokens * 10) / 10,
    totalTokens: Math.round(tr.totalTokens),
    /** 会话累计缓存命中读取 token（提供方部分步骤才上报，缺则不加）。 */
    cacheReadTokens: Math.round(tr.cacheReadTokens),
    /** 最近一步上报的缓存命中量；null = 该步没上报。 */
    lastCacheReadTokens: tr.lastCacheReadTokens === null ? null : Math.round(tr.lastCacheReadTokens),
    ttftMs: tr.ttftMs === null ? null : Math.round(tr.ttftMs),
    lastStepTps: tr.lastStepTps === null ? null : Math.round(tr.lastStepTps * 10) / 10,
    turn: tr.turn,
    step: tr.step,
    stepMs: tr.stepStartMs > 0 ? Math.max(0, now - tr.stepStartMs) : 0,
    quietMs: Math.max(0, Math.round(quiet)),
    lastEventMs: Math.round(tr.lastEventMs),
    calibration: Math.round(tr.calibration * 1000) / 1000,
  }
}

/**
 * 从会话日志里折叠最新标题：插件挂载前就生成过标题的会话也能显示出来。
 * @param {object} session - 会话对象（读 events）。
 * @returns {string} 标题，未找到时为空串。
 */
export function titleOf(session) {
  const events = session?.events
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'session/title') continue
    const title = event.data?.title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  }
  return ''
}

/**
 * 会话登记表：按会话 id 维护追踪器，并把快照按"活跃优先、最近优先"排序。
 * @returns {{ onEvent: Function, readings: Function, count: Function }}
 */
export function createRegistry() {
  /** @type {Map<string, object>} */
  const trackers = new Map()
  let nextSweepMs = 0

  function trackerFor(session, now) {
    const id = String(session?.id ?? 'unknown')
    let tr = trackers.get(id)
    if (tr === undefined) {
      const cwd = session?.header?.cwd
      const depth = session?.header?.delegationDepth
      const sub = session?.header?.origin === 'subagent' || (typeof depth === 'number' && depth > 0)
      tr = createTracker({ id, cwd: typeof cwd === 'string' ? cwd : '', sub, title: titleOf(session), now })
      trackers.set(id, tr)
    }
    return tr
  }

  function sweep(now) {
    for (const [id, tr] of trackers) {
      if (now - tr.lastEventMs > TRACKER_TTL_MS) trackers.delete(id)
    }
    nextSweepMs = now + SWEEP_INTERVAL_MS
  }

  return {
    /**
     * 喂入一条宿主会话事件。
     * @param {object} session - 会话对象（读 id / header.cwd）。
     * @param {object} event - 会话事件。
     * @param {number} [now] - 当前时间戳（测试可注入）。
     */
    onEvent(session, event, now = Date.now()) {
      applyEvent(trackerFor(session, now), event, now)
      // 先应用事件，避免刚恢复活动的会话在扫描时丢失历史累计。
      if (now >= nextSweepMs) sweep(now)
    },
    /**
     * 取全部会话读数（活跃在前，其余按最近活动倒序）。
     * @param {number} [now] - 当前时间戳。
     * @param {number} [limit] - 最多返回条数。
     * @returns {object[]} 读数数组。
     */
    readings(now = Date.now(), limit = 12) {
      sweep(now)
      const all = []
      for (const tr of trackers.values()) {
        // 没有任何产出、整轮也没在进行的会话不占浮窗；反过来，正在思考（整轮开着、
        // 还没吐第一个 token）的会话必须显示出来，否则用户会以为浮窗坏了。
        if (tr.totalTokens <= 0 && tr.stepTokens <= 0 && tr.streamEstTokens <= 0 && !tr.turnOpen) continue
        all.push(snapshot(tr, now))
      }
      all.sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1
        if (a.sub !== b.sub) return a.sub ? 1 : -1
        return b.lastEventMs - a.lastEventMs
      })
      return all.slice(0, limit)
    },
    /** 已登记的会话数（诊断用）。 */
    count() {
      return trackers.size
    },
  }
}
