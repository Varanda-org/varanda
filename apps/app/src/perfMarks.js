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

const OFF = Object.freeze({ mark () {}, span () {}, report: () => [] })

export function createMarks ({ enabled, now = Date.now } = {}) {
  if (enabled !== true) return OFF
  const origin = now()
  const ring = new Array(RING)
  let count = 0
  const push = (name, ms, extra) => {
    ring[count % RING] = { name, ms, extra }
    count += 1
  }
  return {
    mark (name, extra) { push(name, now() - origin, extra) },
    span (name, startedAt, endedAt) { push(name, endedAt - startedAt) },
    report () {
      const out = []
      const first = Math.max(0, count - RING)
      for (let i = first; i < count; i++) {
        const e = ring[i % RING]
        out.push('perf: ' + e.name + ' ' + e.ms + (e.extra === undefined ? '' : ' ' + e.extra))
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
