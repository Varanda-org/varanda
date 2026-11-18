import { mergeRows } from './conversas.js'
import { groupsUnread } from './conversasDot.js'

const HEX64 = /^[0-9a-f]{64}$/
const MEMBER_ROLES = new Set(['creator', 'admin', 'member'])

export async function readGroupsUnread (request, { atOnce = 4, alive = () => true, onUnread } = {}) {
  if (!alive()) return null
  let list
  try {
    list = await request('community.list', {})
  } catch {
    return null
  }
  if (!alive() || !list) return null
  const communities = Array.isArray(list.communities) ? list.communities : []
  const wanted = communities.filter((c) => c && typeof c.community === 'string' && HEX64.test(c.community) &&
    c.state === 'ready' && MEMBER_ROLES.has(c.role))
  const groups = []
  let partial = false
  let next = 0
  let stopped = false
  let finish
  const early = new Promise((resolve) => { finish = resolve })

  async function readNext () {
    while (!stopped && next < wanted.length) {
      if (!alive()) {
        stopped = true
        finish(null)
        return
      }
      const { community } = wanted[next++]
      let info
      try {
        info = await request('community.info', { community })
      } catch {}
      if (stopped) return
      if (!alive()) {
        stopped = true
        finish(null)
        return
      }
      if (!info) partial = true
      for (const g of (info && Array.isArray(info.groups) ? info.groups : [])) {
        if (!g || typeof g.group !== 'string' || g.group === '' || !MEMBER_ROLES.has(g.role)) continue
        if (Number.isInteger(g.unread) && g.unread > 0) {
          stopped = true
          finish(true)
          return
        }
        groups.push({ ...g, community })
      }
    }
  }

  const workers = Array.from({ length: Math.min(atOnce, wanted.length) }, readNext)
  const complete = Promise.all(workers).then(() => alive() ? groupsUnread(mergeRows({ groups }), { complete: !partial }) : null)
  const result = await Promise.race([early, complete])
  if (result === true && onUnread) {
    onUnread()
    // Other workers may still hold requests from this cycle.
    await complete
  }
  return result
}

// The deadline sits past the RPC client's own 30 s request timeout, so it ends
// only a sweep stuck behind a request that never settles, not a slow one.
export function createGroupsDotScheduler ({
  read, apply, now, setTimer, clearTimer, canRead = () => true,
  gapMs = 3000, deadlineMs = 60000, retryMs = 15000
}) {
  let active = null
  let lastStart = -Infinity
  let wake = null
  let queued = false
  let stopped = false

  function arm (delay, retry) {
    wake = setTimer(() => {
      wake = null
      schedule(retry)
    }, delay)
  }

  function schedule (retry = false) {
    if (!canRead()) return
    const delay = lastStart + gapMs - now()
    if (delay > 0) arm(delay, retry)
    else start(retry)
  }

  async function start (retry) {
    const cycle = { deadline: null }
    active = cycle
    lastStart = now()
    let reportedUnread = false
    const alive = () => active === cycle
    const finish = (result) => {
      if (!alive()) return
      clearTimer(cycle.deadline)
      active = null
      if (!reportedUnread || result === null) apply(result)
      if (queued) {
        queued = false
        schedule()
      } else if (result === null && !retry && canRead()) {
        arm(retryMs, true)
      }
    }
    cycle.deadline = setTimer(() => finish(null), deadlineMs)
    let result
    try {
      result = await read(alive, () => {
        if (!alive()) return
        reportedUnread = true
        apply(true)
      })
    } catch {
      result = null
    }
    finish(result)
  }

  function trigger () {
    if (stopped || !canRead()) return
    if (active !== null) {
      queued = true
      return
    }
    clearWake()
    schedule()
  }

  function clearWake () {
    if (wake !== null) clearTimer(wake)
    wake = null
  }

  function reset () {
    clearWake()
    if (active !== null) clearTimer(active.deadline)
    active = null
    queued = false
    lastStart = -Infinity
  }

  function stop () {
    stopped = true
    reset()
  }

  return { trigger, reset, stop }
}
