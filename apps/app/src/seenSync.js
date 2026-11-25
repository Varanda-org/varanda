// The seen pass: reads the member's encrypted seen document from the account
// service, merges it in the browser node and writes it back when local marks
// are newer. Pure: the account calls (`http`), the node (`request`) and the
// clock and timers are injected, so it runs in the tests without a network.

export const SEEN_CHANGED_DEBOUNCE_MS = 3000
export const SEEN_PASS_MIN_MS = 60000
export const SEEN_BURST_GAP_MS = 10000
export const SEEN_BURST_MAX = 4
export const SEEN_BURST_WINDOW_MS = 300000
export const SEEN_RETRY_MS = 15000
export const SEEN_LIMIT_WAIT_MS = 120000
// Write requests sent per 600 s, 409 and uncertain ones included. The spacing
// above allows at most 13 passes in 600 s (4 at the burst gap, then one per
// SEEN_PASS_MIN_MS), so steady marking keeps its 60 s cadence; conflicts,
// unlocks and retries are what the cap stops.
export const SEEN_WRITES_MAX = 13
export const SEEN_WRITES_WINDOW_MS = 600000
export const SEEN_OWN_MAX = 256
export const SEEN_PAGE_TOKENS_MAX = 32
export const SEEN_PAGES_MAX = 4
const CAUGHT_UP_MAX = 512

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const PAGE_NS = /^page:[0-9a-f]{64}$/

function tokens (list, max) {
  const out = []
  if (!Array.isArray(list)) return out
  for (const t of list) {
    if (out.length >= max) break
    if (typeof t === 'string' && HEX32.test(t) && !out.includes(t)) out.push(t)
  }
  return out
}

// Keeps the request inside the seen.merge limits whatever the screen handed
// over, so a long list never turns the whole pass into a USAGE error.
export function cleanAvisos (avisos) {
  const own = tokens(avisos && avisos.own, SEEN_OWN_MAX)
  const pages = {}
  const src = avisos && avisos.pages
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const ns of Object.keys(src)) {
      if (Object.keys(pages).length >= SEEN_PAGES_MAX) break
      if (PAGE_NS.test(ns)) pages[ns] = tokens(src[ns], SEEN_PAGE_TOKENS_MAX)
    }
  }
  return { own, pages }
}

// Each merge answers the node's whole merged view, newest first, so the
// latest one already holds every earlier token: it wins. Concatenating the
// earlier list first would cut the newest tokens at the cap.
function latestAvisos (b) {
  return cleanAvisos(b)
}

const EMPTY = Object.freeze({ own: Object.freeze([]), pages: Object.freeze({}) })

function badReply (code) {
  const err = new Error('resposta inválida')
  err.code = code
  return err
}

export async function runSeenPass ({ member, request, http, avisos }) {
  const out = { avisos: null, pushed: false, writes: 0, dmChanged: false, groupChanged: false, blocksChanged: false, mutesChanged: false, testimonialsChanged: false, momentsChanged: false, caughtUp: [], error: null }

  const merge = async (params) => {
    const res = await request('seen.merge', params)
    if (!res || typeof res !== 'object') throw badReply('indisponivel')
    if (res.dmChanged === true) out.dmChanged = true
    if (res.groupChanged === true) out.groupChanged = true
    if (res.blocksChanged === true) out.blocksChanged = true
    if (res.mutesChanged === true) out.mutesChanged = true
    if (res.testimonialsChanged === true) out.testimonialsChanged = true
    if (res.momentsChanged === true) out.momentsChanged = true
    if (Array.isArray(res.caughtUp)) {
      for (const k of res.caughtUp) {
        if (out.caughtUp.length >= CAUGHT_UP_MAX) break
        if (typeof k === 'string' && HEX64.test(k) && !out.caughtUp.includes(k)) out.caughtUp.push(k)
      }
    }
    if (res.avisos && typeof res.avisos === 'object') out.avisos = latestAvisos(res.avisos)
    return res.pending === true
  }

  // Each call is a new request with a new nonce: it runs only after the
  // previous one was definitely refused, never as a resend of an unknown one.
  const write = async () => {
    const { nonce } = await http.seenStart({ member, action: 'write' })
    const signed = await request('seen.sign', { nonce, action: 'write' })
    if (!signed || typeof signed.blob !== 'string') throw badReply('indisponivel')
    // The service charges its write window for every finish it receives,
    // refused or lost ones included, so the scheduler's cap counts these.
    out.writes++
    await http.seenFinish({ member, nonce, action: 'write', signature: signed.signature, prevHash: signed.prevHash, blob: signed.blob })
    return signed.blob
  }

  try {
    const { nonce } = await http.seenStart({ member, action: 'read' })
    const signed = await request('seen.sign', { nonce, action: 'read' })
    if (!signed || typeof signed !== 'object') throw badReply('indisponivel')
    const read = await http.seenFinish({ member, nonce, action: 'read', signature: signed.signature, prevHash: signed.prevHash })
    const unchanged = !!read && read.unchanged === true
    const blob = !unchanged && read && typeof read.blob === 'string' ? read.blob : null
    let pending = await merge({ blob, unchanged, avisos: cleanAvisos(avisos) })

    let conflicts = 0
    while (pending) {
      let written
      try {
        written = await write()
      } catch (err) {
        // A conflict is a definite refusal carrying the newer server copy:
        // fold it in and try once more. An uncertain write is never repeated;
        // the next pass reads the server and reconciles.
        // Only seenFinish's validated 409 carries a hash: a 'conflito' from
        // anywhere else is no compare-and-swap answer and stops the pass.
        if (!err || err.code !== 'conflito' || err.uncertain || typeof err.hash !== 'string' || !HEX64.test(err.hash) || conflicts >= 1) throw err
        conflicts++
        pending = await merge({ blob: typeof err.blob === 'string' ? err.blob : null, unchanged: false, avisos: EMPTY })
        continue
      }
      out.pushed = true
      // Records the written hash as merged, so pending turns false unless new
      // marks arrived after the signature.
      await merge({ blob: written, unchanged: false, avisos: EMPTY })
      break
    }
  } catch (err) {
    out.error = err || badReply('indisponivel')
  }
  return out
}

function joinNewest (fresh, older, max) {
  const out = []
  for (const t of fresh.concat(older)) {
    if (out.length >= max) break
    if (!out.includes(t)) out.push(t)
  }
  return out
}

// What Avisos reported and the node has not merged yet ({ own, pages }). A
// report keeps only the tokens the last merge answer (`merged`, its avisos)
// does not hold, puts them first and joins what is still waiting, so a
// reload that settles only its first page never drops the marks of the
// pages before. `fresh` is true when a token is new to both: a local mark,
// which wakes the pass. Rows already merged, reported again after every
// pass, wake nothing. Only the newest tokens a merge can carry are
// considered, and a token already sent this session (`delivered`) is never
// offered again: the node stamps an offered token as new, so offering what
// the document cut would push out other marks, pass after pass.
export function reportAvisosSeen (pending, merged, namespace, list, ownKey, delivered) {
  const isPage = PAGE_NS.test(namespace)
  if (!isPage && (typeof ownKey !== 'string' || namespace !== ownKey)) return { pending, fresh: false }
  const max = isPage ? SEEN_PAGE_TOKENS_MAX : SEEN_OWN_MAX
  const before = isPage ? (pending.pages[namespace] || []) : pending.own
  const held = merged ? (isPage ? (merged.pages && merged.pages[namespace]) : merged.own) : null
  const known = new Set(Array.isArray(held) ? held : [])
  const sent = delivered instanceof Set ? delivered : new Set()
  const add = tokens(list, max).filter((t) => !known.has(t) && !sent.has(t))
  const fresh = add.some((t) => !before.includes(t))
  const joined = joinNewest(add, before, max)
  if (!isPage) return { pending: { own: joined, pages: pending.pages }, fresh }
  const pages = { ...pending.pages }
  delete pages[namespace]
  if (joined.length > 0) pages[namespace] = joined
  // The most recently reported pages fit the request.
  const keys = Object.keys(pages)
  for (const k of keys.slice(0, Math.max(0, keys.length - SEEN_PAGES_MAX))) delete pages[k]
  return { pending: { own: pending.own, pages }, fresh }
}

// Records what a merge received, oldest out past `max`.
export function rememberSent (delivered, sent, max = 4096) {
  const all = sent.own.concat(...Object.keys(sent.pages).map((k) => sent.pages[k]))
  for (const t of all) {
    delivered.delete(t)
    delivered.add(t)
  }
  for (const t of delivered) {
    if (delivered.size <= max) break
    delivered.delete(t)
  }
  return delivered
}

// After a merge answered, the node's document holds what was sent: only
// what was reported since stays pending.
export function dropSent (pending, sent) {
  const own = pending.own.filter((t) => !sent.own.includes(t))
  const pages = {}
  for (const k of Object.keys(pending.pages)) {
    const gone = sent.pages[k] || []
    const left = pending.pages[k].filter((t) => !gone.includes(t))
    if (left.length > 0) pages[k] = left
  }
  return { own, pages }
}

// Not used by the app since the Conversas dot follows community.info unread
// counts instead of group versions; kept with its tests.
// Takes snapshot() when a `method` answer carries caughtUp keys, and keeps
// each key's version at the latest answer that listed it ({ epoch, versions }).
// The node reads caughtUp as its last step before it answers, and a post that
// lands after that read reaches the app as groups.changed only after the
// answer, so the versions held when the answer arrives are covered: a post
// that arrived during the merge and that the other device read loses its dot
// as soon as the merge settles. Versions restart per epoch, so an answer in
// another epoch drops the keys taken before it.
export function snapshotOnAnswer (request, method, snapshot) {
  const snap = { epoch: null, versions: null }
  const wrapped = async (m, params) => {
    const res = await request(m, params)
    if (m === method && res && Array.isArray(res.caughtUp) && res.caughtUp.length > 0) {
      const now = snapshot()
      if (now && now.versions) {
        if (snap.versions === null || snap.epoch !== now.epoch) {
          snap.epoch = now.epoch
          snap.versions = {}
        }
        for (const k of res.caughtUp) {
          if (typeof k === 'string' && Object.hasOwn(now.versions, k)) snap.versions[k] = now.versions[k]
        }
      }
    }
    return res
  }
  return { request: wrapped, snap }
}

// The Comunidades dot state ({ epoch, map }) with the caughtUp groups
// acknowledged at the versions of the snapshot; versions restart per node
// epoch, so a snapshot of another epoch changes nothing. Within an epoch a
// version only grows, and an acknowledgement only moves forward: a group
// opened here during the pass keeps its newer one.
export function ackCaughtUp (cur, caughtUp, snap) {
  if (!snap || !snap.versions || cur.epoch !== snap.epoch) return cur
  const versions = snap.versions
  let map = cur.map
  for (const k of caughtUp) {
    if (!Object.hasOwn(versions, k) || typeof versions[k] !== 'number') continue
    if (typeof map[k] === 'number' && map[k] >= versions[k]) continue
    if (map === cur.map) map = { ...cur.map }
    map[k] = versions[k]
  }
  return map === cur.map ? cur : { epoch: cur.epoch, map }
}

// A short debounce coalesces local marks, and a burst budget lets changes,
// one-time notices and remote wakes sync sooner than routine reads. One
// pending pass covers wakes during a gap or while a pass is in flight.
// A transient failure gets one fresh pass, which reads before writing even
// after an uncertain outcome. Wakes it covers stay available if it fails.
// A 429 and the rolling write cap defer work to protect the server budget.
// Unlock can bring a new connection or session keys, so it bypasses those
// waits as soon as the current pass settles.
export function createSeenScheduler ({ run, canRun, now, setTimer, clearTimer }) {
  const starts = []
  const writes = []
  let last = -Infinity
  let limitUntil = -Infinity
  let inFlight = false
  let pending = null
  let pendingRetry = null
  let timer = null
  let timerDue = 0
  let stopped = false
  let unlockQueued = false

  function expire (times, cutoff) {
    while (times.length > 0 && times[0] <= cutoff) times.shift()
  }

  function gapDue (work) {
    const burst = work.reason === 'changed' || work.reason === 'once' || work.reason === 'remote'
    const gap = burst && starts.length < SEEN_BURST_MAX ? SEEN_BURST_GAP_MS : SEEN_PASS_MIN_MS
    return Math.min(Math.max(work.readyAt, last + gap), work.dueBy ?? Infinity)
  }

  function queue (work) {
    const coversOnce = pending?.coversOnce || work.coversOnce
    if (pending === null || gapDue(work) < gapDue(pending)) pending = work
    if (coversOnce) pending.coversOnce = true
  }

  function cancelTimer () {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  async function start (reason, retry, held = null) {
    inFlight = true
    last = now()
    starts.push(last)
    let result
    let rejected = false
    try { result = await run(reason) } catch (error) {
      result = { error }
      rejected = true
    }
    inFlight = false
    if (stopped) return

    const time = now()
    expire(starts, time - SEEN_BURST_WINDOW_MS)
    expire(writes, time - SEEN_WRITES_WINDOW_MS)
    const sent = Number.isSafeInteger(result?.writes) ? result.writes : (result?.pushed === true ? 1 : 0)
    for (let i = 0; i < sent; i++) writes.push(time)
    const failed = rejected || Boolean(result?.error)
    if (!failed) {
      pendingRetry = null
    } else if (result.error?.status === 429) {
      limitUntil = time + SEEN_LIMIT_WAIT_MS
      // Also after a retry: its marks would otherwise wait for an unrelated wake.
      queue({ reason: reason === 'unlock' ? 'poll' : reason, readyAt: limitUntil })
    } else if (!retry) {
      pendingRetry ??= { reason, readyAt: time + SEEN_RETRY_MS }
    }
    if (failed && held !== null) queue(held)
    fire()
  }

  function fire () {
    if (stopped || inFlight) return false
    if (unlockQueued) {
      unlockQueued = false
      if (typeof canRun !== 'function' || canRun()) {
        cancelTimer()
        if (pending !== null) delete pending.dueBy
        start('unlock', false)
        return true
      }
    }
    if (pending === null && pendingRetry === null) return false
    const time = now()
    expire(starts, time - SEEN_BURST_WINDOW_MS)
    expire(writes, time - SEEN_WRITES_WINDOW_MS)
    const writeDue = writes.length < SEEN_WRITES_MAX ? -Infinity : writes[writes.length - SEEN_WRITES_MAX] + SEEN_WRITES_WINDOW_MS
    const ordinaryDue = pending === null ? Infinity : gapDue(pending)
    const retryDue = pendingRetry?.readyAt ?? Infinity
    const retry = retryDue < ordinaryDue
    const due = Math.max(Math.min(ordinaryDue, retryDue), limitUntil, writeDue)
    if (due > time) {
      if (timer === null || timerDue !== due) {
        cancelTimer()
        timerDue = due
        timer = setTimer(() => {
          timer = null
          fire()
        }, due - time)
      }
      return false
    }

    cancelTimer()
    const { reason } = retry ? pendingRetry : pending
    if (retry) pendingRetry = null
    else pending = null
    if (typeof canRun === 'function' && !canRun()) return fire()
    const held = retry ? pending : null
    if (held !== null) {
      // A retry can cover a one-time notice without moving its deadline if it fails.
      if (held.coversOnce) held.dueBy = ordinaryDue
      pending = null
    }
    start(reason, retry, held)
    return true
  }

  function wake (reason) {
    if (stopped) return false
    if (reason === 'unlock') unlockQueued = true
    else {
      const time = now()
      expire(starts, time - SEEN_BURST_WINDOW_MS)
      const readyAt = time + (reason === 'changed' ? SEEN_CHANGED_DEBOUNCE_MS : 0)
      queue({ reason, readyAt, coversOnce: reason === 'once' })
    }
    return fire()
  }

  function stop () {
    stopped = true
    unlockQueued = false
    pending = null
    pendingRetry = null
    cancelTimer()
  }

  return { wake, stop, get running () { return inFlight } }
}
