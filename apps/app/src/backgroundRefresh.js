// A Rua's snapshot (./feedSnapshot.js) refreshed while the app is in the
// background, so the next open paints recent rows. Pure: no React, no
// react-native, no Node built-ins; the node, the stores and the clock are
// injected by the platform task.
//
// Why it runs without the identity: the browser node's reads (node.info,
// block.list, follow.list, feed.read, profile.read) and a once sync answer
// from storage while no key pair is installed, so the run never touches the
// keychain, the session store or the passkey. The owner is learned from the
// stored diary (node.info) and must be the snapshot's owner: a device that
// changed hands, or was reset, never gets another person's rows written
// under the old binding.
//
// What it does not do: counts (originals, names and own hearts only carry
// over from the previous snapshot), DMs, notices, the
// Espiadinha and groups stay out (the run asks the node to skip group cores
// with groups: false). No request is retried: a failure ends the run and
// the old snapshot stays. Nothing is logged.

import rpc from '@varanda/rpc'
import { buildSnapshot, SNAPSHOT_VERSION } from './feedSnapshot.js'
import { loadKept as realLoadKept } from './media/keptLoad.js'
import { videoPair } from './media/plan.js'
import { cursorOf, resetWith } from './paging.js'

const { FEED_LIMIT_DEFAULT } = rpc

export const BG_MIN_GAP_MS = 6 * 60 * 60 * 1000
export const BG_DEADLINE_MS = 20000
export const BG_SYNC_TIMEOUT_MS = 12000
export const BG_MAX_KEPT = 12
export const BG_MAX_KEPT_BYTES = 8 * 1024 * 1024
// How long past the deadline a start still in flight is waited for, so its
// node can be stopped before the run resolves.
export const BG_STOP_GRACE_MS = 5000
// follow.list pages, as A Rua reads them (screens/ARua.js FOLLOW_PAGES_MAX).
const FOLLOW_PAGE = 500
const FOLLOW_PAGES_MAX = 50
const PROFILE_MAX = 100

const HEX64 = /^[0-9a-f]{64}$/
const isHex64 = (v) => typeof v === 'string' && HEX64.test(v)

function hostedConfig (config) {
  const c = config && typeof config === 'object' && config.config && typeof config.config === 'object' ? config.config : config
  if (!c || typeof c !== 'object' || c.kind !== 'hosted' || !isHex64(c.association)) return null
  return c
}

// The snapshot names the remembered installation: same association, and
// the same origin when the config carries one.
function boundTo (snapshot, config) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.v !== SNAPSHOT_VERSION) return false
  if (!isHex64(snapshot.owner) || !Array.isArray(snapshot.items) || snapshot.items.length === 0) return false
  if (snapshot.association !== config.association) return false
  if (typeof config.installationUrl === 'string' && snapshot.origin !== config.installationUrl) return false
  return true
}

// snapshot: the parsed snapshot (parseSnapshot) or null; config: the
// remembered hosted config ({ kind: 'hosted', ... } or { config }). A clock
// moved back (lastRunMs in the future) does not hold the refresh forever.
export function shouldRun ({ snapshot, config, nodeRunning, nowMs, lastRunMs } = {}) {
  try {
    const c = hostedConfig(config)
    if (c === null || !boundTo(snapshot, c)) return false
    if (nodeRunning !== false) return false
    if (!Number.isSafeInteger(nowMs)) return false
    if (lastRunMs === null || lastRunMs === undefined) return true
    if (!Number.isSafeInteger(lastRunMs)) return true
    const gap = nowMs - lastRunMs
    return gap < 0 || gap >= BG_MIN_GAP_MS
  } catch {
    return false
  }
}

class Stop extends Error {
  constructor (reason) {
    super(reason)
    this.reason = reason
  }
}

// The posts' photos, then the avatars, of the first rows: at most
// BG_MAX_KEPT, at most BG_MAX_KEPT_BYTES in all. Only allowed authors.
export function keepPlan (snapshot, max = BG_MAX_KEPT, maxBytes = BG_MAX_KEPT_BYTES) {
  const out = []
  let bytes = 0
  const seen = new Set()
  const add = (kind, author, d) => {
    if (out.length >= max || !d || typeof d !== 'object' || !Number.isSafeInteger(d.bytes) || d.bytes <= 0) return
    const id = kind + '|' + author + '|' + d.core + '|' + d.start
    if (seen.has(id) || bytes + d.bytes > maxBytes) return
    seen.add(id)
    bytes += d.bytes
    out.push({ kind, author, d })
  }
  for (const row of snapshot.items) {
    const name = snapshot.names[row.author]
    if (name && name.avatar) add('avatars', row.author, name.avatar)
    if (row.kind === 'post' && Array.isArray(row.media)) {
      // A video is never kept (fetchVideo is always transient): its poster only.
      const pair = videoPair(row.media)
      for (const d of pair === null ? row.media : [pair.poster]) add('posts', row.author, d)
    }
  }
  return out
}

// deps:
// - snapshot: the parsed snapshot shouldRun accepted; config: the remembered
//   hosted config.
// - start(config, { onEvent }) -> client ({ request(method, params) }) or
//   { client }; stop() -> promise. stop runs at the end whatever happened.
// - saveSnapshot(text); cacheGeneration() -> number.
// - kept: { keptUrl, keep, fetchBytes, validateAvatar? } for loadKept;
//   loadKept defaults to ./media/keptLoad.js.
// - signal: an AbortSignal (the app came to the foreground).
// - now(), setTimer(fn, ms), clearTimer(id), deadlineMs, stopGraceMs: for
//   tests.
// -> { ok, reason, saved, kept, stopped, settle }. Never throws. It resolves
// after the node it started is stopped; stopped false only when the start
// never settled within the deadline plus stopGraceMs, and then settle is a
// promise that resolves once that node is up and stopped.
// The originals of `rows`' reposts only, from the previous snapshot's map.
function repostOriginals (originals, rows) {
  const out = {}
  if (!originals || typeof originals !== 'object') return out
  for (const row of rows) {
    if (!row || row.kind !== 'repost' || !row.to) continue
    const ref = row.to.author + ':' + row.to.seq
    if (Object.prototype.hasOwnProperty.call(originals, ref)) out[ref] = originals[ref]
  }
  return out
}

export async function runRefresh (deps = {}) {
  const {
    snapshot,
    config,
    start,
    stop,
    saveSnapshot,
    cacheGeneration,
    kept = null,
    loadKept = realLoadKept,
    signal = null,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    deadlineMs = BG_DEADLINE_MS,
    stopGraceMs = BG_STOP_GRACE_MS
  } = deps
  const result = { ok: false, reason: '', saved: false, kept: 0, stopped: true, settle: null }
  const c = hostedConfig(config)
  if (c === null || !boundTo(snapshot, c) || typeof start !== 'function' || typeof stop !== 'function' ||
    typeof saveSnapshot !== 'function' || typeof cacheGeneration !== 'function') {
    result.reason = 'sem snapshot'
    return result
  }

  const gen = cacheGeneration()
  const startedAt = now()
  let expired = false
  let wake = null
  const poke = () => { if (wake !== null) wake() }
  const timer = setTimer(() => { expired = true; poke() }, deadlineMs)
  const onAbort = () => poke()
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort)
  const check = () => {
    if (signal && signal.aborted) throw new Stop('interrompido')
    if (expired || now() - startedAt >= deadlineMs) throw new Stop('prazo')
  }
  // A step that waits races the deadline and the abort; whatever it was
  // waiting for is left behind, and the node stop below ends it.
  const bounded = (p) => new Promise((resolve, reject) => {
    let done = false
    const finish = (fn, v) => {
      if (done) return
      done = true
      wake = null
      fn(v)
    }
    wake = () => {
      try { check() } catch (err) { finish(reject, err) }
    }
    Promise.resolve(p).then((v) => finish(resolve, v), (err) => finish(reject, err))
    wake()
  })

  const stopped = []
  let runId = null
  let syncDone = null
  let followsVersion = 0
  const onEvent = (name, data) => {
    if (name === 'follows.changed') followsVersion++
    if (name !== 'sync.stopped' || !data || typeof data !== 'object') return
    stopped.push(data)
    if (syncDone !== null && runId !== null && data.runId === runId) syncDone(data)
  }

  let startPromise = null
  let startSettled = false
  try {
    check()
    startPromise = Promise.resolve().then(() => start(c, { onEvent }))
    startPromise.then(() => { startSettled = true }, () => { startSettled = true })
    const started = await bounded(startPromise)
    const client = started && typeof started.request === 'function' ? started : started && started.client
    if (!client || typeof client.request !== 'function') throw new Stop('falha')
    const request = (method, params) => {
      check()
      return bounded(client.request(method, params))
    }

    const info = await request('node.info')
    const own = info && typeof info.publicKey === 'string' ? info.publicKey.toLowerCase() : null
    if (own !== snapshot.owner) throw new Stop('outra identidade')

    const sync = await request('sync.start', { once: true, timeoutMs: BG_SYNC_TIMEOUT_MS, groups: false })
    runId = sync && sync.runId !== undefined ? sync.runId : null
    const end = await bounded(new Promise((resolve) => {
      const hit = stopped.find((e) => e.runId === runId)
      if (hit) resolve(hit)
      else syncDone = resolve
    }))
    syncDone = null
    // 'timeout' is a once run that met no seeder in time: the local rows
    // are still the newest this device holds.
    if (end.reason !== 'done' && end.reason !== 'timeout') throw new Stop('sincronização')

    const again = await request('node.info')
    const ownAgain = again && typeof again.publicKey === 'string' ? again.publicKey.toLowerCase() : null
    if (ownAgain !== snapshot.owner) throw new Stop('outra identidade')

    const blockList = await request('block.list')
    if (!blockList || !Array.isArray(blockList.keys)) throw new Stop('falha')
    const blocked = new Set(blockList.keys.filter((k) => typeof k === 'string').map((k) => k.toLowerCase()))

    const follows = await readFollows(request, () => followsVersion)
    if (!follows.complete) throw new Stop('seguidos incompletos')
    const known = new Set(follows.keys.filter((k) => !blocked.has(k)))

    const page = await request('feed.read', { limit: FEED_LIMIT_DEFAULT })
    if (!page || !Array.isArray(page.items)) throw new Stop('falha')
    const allowed = (a) => typeof a === 'string' && !blocked.has(a) && (a === own || known.has(a))
    // feed.read answers oldest first; A Rua (and the snapshot) hold the
    // page newest first, with the page's oldest row as its cursor.
    const all = resetWith(page.items.filter((i) => i && typeof i === 'object')).slice(0, FEED_LIMIT_DEFAULT)
    const rows = all.filter((i) => allowed(i.author))

    const authors = []
    for (const a of [own, ...rows.map((r) => r.author)]) {
      if (!authors.includes(a) && authors.length < PROFILE_MAX) authors.push(a)
    }
    const profiles = await request('profile.read', { authors })
    const byAuthor = new Map()
    if (profiles && Array.isArray(profiles.profiles)) {
      for (const p of profiles.profiles) {
        if (p && typeof p.author === 'string') byAuthor.set(p.author.toLowerCase(), { name: p.name, username: p.username, avatar: p.avatar === undefined ? null : p.avatar })
      }
    }

    check()
    const next = buildSnapshot({
      origin: snapshot.origin,
      association: snapshot.association,
      owner: snapshot.owner,
      items: rows,
      // Rows left out make the page's own bound wrong: the last kept row
      // bounds it then.
      cursor: rows.length === all.length && all.length === page.items.length ? cursorOf(page.items) : null,
      // The previous snapshot's names and own hearts carry over for refs
      // still on this page, and so do the originals of reposts still on it:
      // feed.read drops a repost whose target was deleted, so those are
      // known to stand. A quoted or replied-to post may have been deleted
      // since and its quoting row stays, so those originals are left out
      // (shown unresolved until the live page). buildSnapshot keeps only
      // own or followed, unblocked authors; counts are left out as stale.
      profileOf: (a) => withPageHint(byAuthor.get(a), oldName(snapshot, a)),
      originals: repostOriginals(snapshot.originals, rows),
      liked: snapshot.liked,
      reposted: snapshot.reposted,
      isKnown: (a) => known.has(a),
      blocked,
      now: now()
    })
    if (next === null) throw new Stop('vazio')
    // A wipe, block or unfollow since the run began: its rows may be stale.
    if (cacheGeneration() !== gen) throw new Stop('limpeza')
    saveSnapshot(JSON.stringify(next))
    result.saved = true

    if (kept !== null && typeof loadKept === 'function') {
      for (const { kind, author, d } of keepPlan(next)) {
        check()
        if (cacheGeneration() !== gen) break
        try {
          await bounded(loadKept({
            kind,
            author,
            d,
            persist: true,
            keptUrl: kept.keptUrl,
            keep: kept.keep,
            fetchBytes: kept.fetchBytes,
            urlFromBytes: () => 'memória',
            generation: cacheGeneration,
            requestedGeneration: gen,
            validate: kind === 'avatars' ? kept.validateAvatar : undefined
          }))
          result.kept++
        } catch (err) {
          if (err instanceof Stop) throw err
        }
      }
    }
    result.ok = true
    result.reason = 'ok'
  } catch (err) {
    result.reason = err instanceof Stop ? err.reason : 'falha'
    // A photo step that hit the deadline still leaves the saved snapshot.
    if (result.saved && (result.reason === 'prazo' || result.reason === 'interrompido')) result.ok = true
  } finally {
    clearTimer(timer)
    wake = null
    syncDone = null
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    // A stop sent while the start is in flight could miss the node it then
    // brings up, and two sessions on one storage corrupt it: the start is
    // waited for first, and only then stopped.
    let settled = startPromise === null || startSettled
    if (!settled) {
      const grace = Math.max(0, deadlineMs - (now() - startedAt)) + stopGraceMs
      let graceTimer = null
      settled = await Promise.race([
        startPromise.then(() => true, () => true),
        new Promise((resolve) => { graceTimer = setTimer(() => resolve(false), grace) })
      ])
      clearTimer(graceTimer)
    }
    if (startPromise !== null && settled) {
      try { await stop() } catch {}
    } else if (startPromise !== null) {
      // The start never settled: not stopped. `settle` resolves once it does
      // and its node is stopped; nothing may start a node before then.
      result.ok = false
      result.stopped = false
      result.settle = startPromise.then(() => {}, () => {}).then(() => stop()).then(() => {}, () => {})
    }
  }
  return result
}

// profile.read never says the page hint (names.js carries it the same
// way): page, closed and moved come from the previous entry.
function withPageHint (entry, old) {
  if (!entry) return old
  if (old && old.page === true) return { ...entry, page: true, closed: old.closed === true, moved: old.moved === true }
  return entry
}

function oldName (snapshot, author) {
  const names = snapshot.names
  return names && Object.prototype.hasOwnProperty.call(names, author) ? names[author] : null
}

// Every follow.list page -> { keys, complete }, as A Rua's readAllFollows:
// complete only when the pages hold exactly the total, the total did not
// move and no follows.changed arrived while paging.
async function readFollows (request, version) {
  const before = version()
  const keys = []
  let total = null
  let offset = 0
  for (let n = 0; n < FOLLOW_PAGES_MAX; n++) {
    const r = await request('follow.list', { offset, limit: FOLLOW_PAGE })
    const list = r && Array.isArray(r.follows) ? r.follows : null
    if (list === null || !Number.isSafeInteger(r.total)) return { keys, complete: false }
    if (total === null) total = r.total
    else if (r.total !== total) return { keys, complete: false }
    for (const k of list) if (typeof k === 'string') keys.push(k.toLowerCase())
    offset += list.length
    if (offset >= total) return { keys, complete: offset === total && keys.length === total && version() === before }
    if (list.length === 0) return { keys, complete: false }
  }
  return { keys, complete: false }
}
