/* global __DEV__ */
// Dev-only, local-only timing marks for the content-loading measurements
// (never stored, never sent). A release bundle has __DEV__ false, so no env
// value can turn them on. Pure ES module: imports nothing, so Node's import()
// tests it.

const RING = 256

export function perfEnabled (env, dev) {
  return dev === true && env !== null && typeof env === 'object' && env.EXPO_PUBLIC_VARANDA_PERF === '1'
}

// The lab driver's dev hook (src/node.js) acts as the signed-in member, so it
// passes only what the dataset setup needs (apps/cli/scripts/lab-dataset.js
// reader-setup.js): no deletes, messages, identity or recovery calls, even in
// a development build.
export const DEV_HOOK_METHODS = Object.freeze(['follow.add', 'community.join', 'post.create'])

export function devHookRequest (request) {
  return (method, params) => DEV_HOOK_METHODS.includes(method)
    ? request(method, params)
    : Promise.reject(new Error('método fora do gancho de medição: ' + String(method)))
}

const OFF = Object.freeze({ mark () {}, span () {}, adopt () {}, report: () => [], fresh: () => [] })

// One origin per run: every mark's ms counts from the first moment this clock
// is read, which is the js-entry mark when src/perfEntry.js loads first.
export function createClock (now = monotonicNow) {
  let origin = null
  return {
    now,
    since (t = now()) {
      if (origin === null) origin = t
      return t - origin
    }
  }
}

const runClock = createClock()

function line (e) {
  return 'perf: ' + e.name + ' ' + e.ms + (e.extra === undefined ? '' : ' ' + e.extra)
}

// report() gives every retained line (the lab hook reads it); fresh() gives
// only the lines not printed yet, so the shell prints each mark once.
// adopt() keeps a mark that was already printed (the boot marks).
export function createMarks ({ enabled, now, clock } = {}) {
  if (enabled !== true) return OFF
  const c = clock || (now ? createClock(now) : runClock)
  c.since()
  const ring = new Array(RING)
  let count = 0
  const push = (name, ms, extra, printed) => {
    ring[count % RING] = { name, ms, extra, printed }
    count += 1
  }
  const retained = () => {
    const out = []
    for (let i = Math.max(0, count - RING); i < count; i++) out.push(ring[i % RING])
    return out
  }
  return {
    mark (name, extra) { push(name, c.since(), extra, false) },
    span (name, startedAt, endedAt) { push(name, endedAt - startedAt, undefined, false) },
    adopt (name, ms, extra) { push(name, ms, extra, true) },
    report () { return retained().map(line) },
    fresh () {
      const out = []
      for (const e of retained()) {
        if (e.printed) continue
        e.printed = true
        out.push(line(e))
      }
      return out
    }
  }
}

// Frame gaps while a scroll runs (dev only, same local-only rule as the marks).
// raf and now are injected so a test drives a fake clock; nothing is scheduled
// until start(), and a stopped sampler lets its pending frame lapse.
export const FRAME_SLOW_MS = 32

function nearestRank (sorted, p) {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

export function frameSummary (gaps) {
  const sorted = gaps.slice().sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return { count: 0, p50: 0, p95: 0, max: 0, over: 0 }
  return {
    count: n,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted[n - 1],
    over: sorted.filter((g) => g > FRAME_SLOW_MS).length
  }
}

export function frameLine (s) {
  return 'n=' + s.count + ' p50=' + s.p50 + ' p95=' + s.p95 + ' max=' + s.max + ' over' + FRAME_SLOW_MS + '=' + s.over
}

// Each gap keeps the time its frame ended, so stop(until) leaves out the
// idle frames after the scroll (until = the last scroll event, plus a frame).
// A negative gap (a clock that stepped back) is never recorded.
export function createFrameStats ({ raf, now }) {
  let gaps = []
  let last = null
  let running = false
  let run = 0
  const loop = (id) => {
    const tick = () => {
      if (!running || id !== run) return
      const t = now()
      if (last !== null && t >= last) gaps.push({ gap: t - last, at: t })
      last = t
      raf(tick)
    }
    return tick
  }
  return {
    get running () { return running },
    start () {
      if (running) return
      running = true
      run += 1
      gaps = []
      last = now()
      raf(loop(run))
    },
    stop (until = Infinity) {
      if (!running) return null
      running = false
      return frameSummary(gaps.filter((g) => g.at <= until).map((g) => g.gap))
    }
  }
}

// A monotonic clock when the runtime has one: a wall clock step or a resume
// would otherwise land in the gaps.
export function monotonicNow () {
  const p = typeof performance !== 'undefined' ? performance : null
  return p && typeof p.now === 'function' ? p.now() : Date.now()
}

// One literal read of the flag (Expo inlines only process.env.NAME), kept in
// this module so index.js and App.js import the result and name no flag.
export const perfOn = perfEnabled({ EXPO_PUBLIC_VARANDA_PERF: process.env.EXPO_PUBLIC_VARANDA_PERF }, typeof __DEV__ !== 'undefined' && __DEV__)

function sortedNumbers (values) {
  return values.slice().sort((a, b) => a - b)
}

// median, p95 (nearest rank) and spread (max - min) of a list of numbers.
export function summary (values) {
  const sorted = sortedNumbers(values)
  const n = sorted.length
  if (n === 0) return { count: 0, median: 0, p95: 0, spread: 0 }
  return {
    count: n,
    median: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    spread: sorted[n - 1] - sorted[0]
  }
}

// Marks taken before the node's marks exist (module evaluation, the media
// sweep, the worklet start) wait here, as ms on the run clock. A name in
// `once` is kept the first time only.
export function createEarlyBuffer ({ now = monotonicNow, clock = createClock(now) } = {}) {
  let entries = []
  const seen = new Set()
  return {
    mark (name, extra) {
      const e = { name, ms: clock.since(), extra }
      entries.push(e)
      return e
    },
    markOnce (name, extra) {
      if (seen.has(name)) return null
      seen.add(name)
      return this.mark(name, extra)
    },
    // ms values of a span are its length, as marks.span records them.
    span (name, startedAt, endedAt) {
      clock.since()
      const e = { name, ms: endedAt - startedAt }
      entries.push(e)
      return e
    },
    drain () {
      const out = entries
      entries = []
      return out
    }
  }
}

export const earlyLine = line

const boot = createEarlyBuffer({ clock: runClock })

// Printed at once too: the logcat capture is what perf-summary reads.
export function bootMark (name, extra) {
  console.log(line(boot.mark(name, extra)))
}

export function bootMarkOnce (name, extra) {
  const e = boot.markOnce(name, extra)
  if (e !== null) console.log(line(e))
}

export function bootSpan (name, startedAt, endedAt) {
  console.log(line(boot.span(name, startedAt, endedAt)))
}

// Hands the buffered marks to the node's marks ring as already printed.
export function flushEarly (marks, buffer = boot) {
  for (const e of buffer.drain()) marks.adopt(e.name, e.ms, e.extra)
}

// React Profiler onRender totals per id. Outside a phase they print at most
// every `everyMs`; inside one (the scripted scroll) nothing prints until
// flush(), so the console stays quiet while frames are sampled and the
// phase's whole tail lands in its own lines. This is render time
// (actualDuration), not commit time.
export function createRenderStats ({ now = monotonicNow, everyMs = 5000 } = {}) {
  let ids = new Map()
  let lastPrint = null
  let phase = null
  const lines = () => {
    const out = []
    const tag = phase === null ? '' : ' phase=' + phase
    for (const [id, s] of ids) out.push('perf: render ' + id + ' ' + s.count + ' ' + Math.round(s.total * 10) / 10 + tag)
    ids = new Map()
    lastPrint = now()
    return out
  }
  return {
    record (id, actualDuration) {
      const t = now()
      if (lastPrint === null) lastPrint = t
      const s = ids.get(id) || { count: 0, total: 0 }
      s.count += 1
      s.total += actualDuration
      ids.set(id, s)
      if (phase !== null || t - lastPrint < everyMs) return null
      return lines()
    },
    // Prints what came before, then tags what follows.
    begin (name) {
      const out = lines()
      phase = name
      return out
    },
    // Prints and resets the totals; a phase goes on.
    flush () { return lines() },
    // Prints the phase's last totals and ends it.
    end () {
      const out = lines()
      phase = null
      return out
    }
  }
}

const renders = createRenderStats()

export function onRenderProfile (id, phase, actualDuration) {
  const lines = renders.record(id, actualDuration)
  if (lines !== null) for (const l of lines) console.log(l)
}

export function beginRenderPhase (name) {
  for (const l of renders.begin(name)) console.log(l)
}

// On demand: prints and resets the render totals.
export function flushRenders () {
  for (const l of renders.flush()) console.log(l)
}

export function endRenderPhase () {
  for (const l of renders.end()) console.log(l)
}

// Renders per row mount. Each mount is its own sample (a row that scrolls out
// and back is two), so a repost and its original, or one row mounted twice,
// never merge. stats() covers the window since the last call: the rows
// mounted in it or still mounted from before, then resets.
export function createRowCounter () {
  const live = new Map()
  let ended = []
  let keys = new Set()
  let mounts = 0
  let unmounts = 0
  let next = 0
  return {
    open (key) {
      next += 1
      live.set(next, 0)
      keys.add(key)
      mounts += 1
      return next
    },
    render (token) {
      if (live.has(token)) live.set(token, live.get(token) + 1)
    },
    close (token) {
      if (!live.has(token)) return
      ended.push(live.get(token))
      live.delete(token)
      unmounts += 1
    },
    stats () {
      const counts = ended.slice()
      for (const [token, n] of live) {
        if (n > 0) counts.push(n)
        live.set(token, 0)
      }
      const s = summary(counts)
      const out = { rows: keys.size, mounts, unmounts, median: s.median, p95: s.p95 }
      ended = []
      keys = new Set()
      mounts = 0
      unmounts = 0
      return out
    }
  }
}

export function rowLine (s) {
  return 'rows=' + s.rows + ' mounts=' + s.mounts + ' unmounts=' + s.unmounts + ' rendersPerMountMedian=' + s.median + ' rendersPerMountP95=' + s.p95
}

// One counter per list id ('-' for rows outside a measured list): each list
// drains its own rows, so one list's line never takes or erases another's.
const rowCounters = new Map()

function rowCounterOf (listId) {
  const id = typeof listId === 'string' && listId !== '' ? listId : '-'
  let c = rowCounters.get(id)
  if (c === undefined) {
    c = createRowCounter()
    rowCounters.set(id, c)
  }
  return c
}

export function openRow (key, listId) {
  const counter = rowCounterOf(listId)
  return { counter, token: counter.open(key) }
}
export function countRowRender (row) { row.counter.render(row.token) }
export function closeRow (row) { row.counter.close(row.token) }
export function rowStatsLine (listId) { return rowLine(rowCounterOf(listId).stats()) }
