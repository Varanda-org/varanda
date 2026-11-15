// Scripted scroll for the perf measurements (dev only, never in a release).
// The plan is pure; the driver takes its clock, frame callback and scroll
// function, so a test runs it on a fake clock.

// The list id to drive, read as a literal so Expo inlines it.
export const SCROLL_TARGET = process.env.EXPO_PUBLIC_VARANDA_PERF_SCROLL

export const TOTAL_MS = 60000
export const REVERSALS = 4
// px per ms: about 1200 px/s, a quick flick-length scroll.
export const SPEED = 1.2

export function scrollWanted (perfId, on, target = SCROLL_TARGET) {
  return on === true && typeof perfId === 'string' && perfId !== '' && target === perfId
}

// REVERSALS + 1 equal segments, alternating down and up from the top.
export function scrollPlan ({ totalMs = TOTAL_MS, reversals = REVERSALS } = {}) {
  const n = reversals + 1
  const each = totalMs / n
  const out = []
  for (let i = 0; i < n; i++) out.push({ start: i * each, end: (i + 1) * each, dir: i % 2 === 0 ? 1 : -1 })
  return out
}

// The list waits this long after its first rows before the scroll starts, so
// the splash and the first loads are over.
export const SETTLE_MS = 3000

// One scripted scroll per list id per run, whatever remounts.
const claimed = new Set()
export function claimScroll (perfId, seen = claimed) {
  if (seen.has(perfId)) return false
  seen.add(perfId)
  return true
}

// Moves y through the plan from `from` to `to` ms, segment by segment, inside
// [0, max]. Incremental: content that grows later never moves what was
// already scrolled.
export function advance (plan, y, from, to, speed = SPEED, max = Infinity) {
  let out = y
  for (const seg of plan) {
    const dt = Math.min(to, seg.end) - Math.max(from, seg.start)
    if (dt > 0) out = Math.min(max, Math.max(0, out + seg.dir * speed * dt))
  }
  return out
}

// Offset after t ms with a fixed `max`.
export function offsetAt (plan, t, speed = SPEED, max = Infinity) {
  return advance(plan, 0, 0, t, speed, max)
}

export function createScrollDriver ({ now, raf, cancel, scrollTo, notify, max = () => Infinity, onSegment, onDone, plan = scrollPlan(), speed = SPEED }) {
  let running = false
  let origin = 0
  let segment = -1
  let handle = null
  let y = 0
  let last = 0
  const tick = () => {
    handle = null
    if (!running) return
    const total = plan[plan.length - 1].end
    const t = Math.min(now() - origin, total)
    const i = plan.findIndex((s) => t < s.end)
    const idx = i === -1 ? plan.length - 1 : i
    if (idx !== segment && t < total) {
      segment = idx
      notify()
      if (typeof onSegment === 'function') onSegment(idx, plan[idx])
    }
    y = advance(plan, y, last, t, speed, max())
    last = t
    scrollTo(y)
    if (t >= total) {
      running = false
      if (typeof onDone === 'function') onDone()
      return
    }
    handle = raf(tick)
  }
  return {
    get running () { return running },
    start () {
      if (running) return
      running = true
      segment = -1
      y = 0
      last = 0
      origin = now()
      handle = raf(tick)
    },
    stop () {
      running = false
      if (handle !== null && typeof cancel === 'function') cancel(handle)
      handle = null
    }
  }
}
