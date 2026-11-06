// The seen pass: reads the member's encrypted seen document from the account
// service, merges it in the browser node and writes it back when local marks
// are newer. Pure: the account calls (`http`), the node (`request`) and the
// clock and timers are injected, so it runs in the tests without a network.

export const SEEN_CHANGED_DEBOUNCE_MS = 30000
export const SEEN_PASS_MIN_MS = 60000
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
  const out = { avisos: null, pushed: false, dmChanged: false, groupChanged: false, caughtUp: [], error: null }

  const merge = async (params) => {
    const res = await request('seen.merge', params)
    if (!res || typeof res !== 'object') throw badReply('indisponivel')
    if (res.dmChanged === true) out.dmChanged = true
    if (res.groupChanged === true) out.groupChanged = true
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

// Takes snapshot() once, right before the first `method` call goes out: the
// group versions the app knew when the node began computing caughtUp. Later
// than the start of the pass, so a post that arrived during the HTTP round
// trips and that the downloaded mark covers is acknowledged too.
export function snapshotBefore (request, method, snapshot) {
  const snap = { taken: false, value: null }
  const wrapped = (m, params) => {
    if (m === method && !snap.taken) {
      snap.taken = true
      snap.value = snapshot()
    }
    return request(m, params)
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

// One pass in flight, at most one per SEEN_PASS_MIN_MS (an unlock skips the
// wait), and 'changed' bursts coalesced. 'online' (the connection came back)
// waits out the interval like 'changed'; an unlock during a pass runs right
// after it. A failed pass waits for the next trigger: there is no retry
// timer.
export function createSeenScheduler ({ run, canRun, now, setTimer, clearTimer }) {
  let last = null
  let inFlight = false
  let changedTimer = null
  let stopped = false
  let unlockQueued = false

  const arm = (ms) => {
    changedTimer = setTimer(() => {
      changedTimer = null
      fire('changed')
    }, ms)
  }

  function start (reason) {
    inFlight = true
    last = now()
    let p
    try { p = Promise.resolve(run(reason)) } catch { p = Promise.resolve() }
    return p.catch(() => {}).then(() => {
      inFlight = false
      // The unlock may have brought what the pass lacked (a connection, the
      // session keys).
      if (unlockQueued) {
        unlockQueued = false
        fire('unlock')
      }
    })
  }

  function fire (reason) {
    if (stopped) return false
    if (typeof canRun === 'function' && !canRun()) return false
    const owed = reason === 'changed' || reason === 'online'
    if (inFlight) {
      // The running pass may have signed before this change: keep it queued.
      if (owed && changedTimer === null) arm(SEEN_CHANGED_DEBOUNCE_MS)
      if (reason === 'unlock') unlockQueued = true
      return false
    }
    if (reason !== 'unlock' && last !== null) {
      const wait = last + SEEN_PASS_MIN_MS - now()
      if (wait > 0) {
        if (owed && changedTimer === null) arm(wait)
        return false
      }
    }
    start(reason)
    return true
  }

  function wake (reason) {
    if (stopped) return false
    if (reason === 'changed') {
      // Not reset by later changes, so a steady stream of marks still gets a
      // pass within the debounce.
      if (changedTimer === null) arm(SEEN_CHANGED_DEBOUNCE_MS)
      return false
    }
    return fire(reason)
  }

  function stop () {
    stopped = true
    unlockQueued = false
    if (changedTimer !== null) clearTimer(changedTimer)
    changedTimer = null
  }

  return { wake, stop, get running () { return inFlight } }
}
