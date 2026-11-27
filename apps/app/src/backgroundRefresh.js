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
// Strangers' originals: the posts the page's rows repost, quote or reply to
// by someone neither own, followed nor blocked are read with diary.peek, so
// the reopened rows show them instead of an unresolved card; the seeder's
// member index gives the profile hints their names are read from. diary.peek
// needs a live seeder link, and the once run drops its link when it ends,
// so a second run is started for the peeks and stopped right after them.
// That run is continuous (the node refuses groups: false outside a once
// run, and a once run ends as soon as it is caught up, under the peeks);
// the node stop at the end ends it on every path anyway.
//
// What it does not do: counts (names and own hearts only carry over from
// the previous snapshot), DMs, notices and the Espiadinha stay out, and the
// once run skips group cores (groups: false). No request is retried: a
// failure ends the run and the old snapshot stays, except a failed peek,
// which only leaves that author's originals to the previous snapshot.
// Nothing is logged.

import rpc from '@varanda/rpc'
import { buildSnapshot, SNAPSHOT_VERSION } from './feedSnapshot.js'
import * as localCaches from './localCaches.js'
import { loadKept as realLoadKept } from './media/keptLoad.js'
import { videoPair } from './media/plan.js'
import { cursorOf, resetWith } from './paging.js'
import { storedQuietLists } from './screenSnapshot.js'
import { lookupPost, PEEK_SEQS_MAX, target } from './thread.js'

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
// Strangers peeked per run, one diary.peek each.
export const BG_PEEK_AUTHORS = 6
// The peeks start only with this much of the deadline left.
export const BG_PEEK_MIN_LEFT_MS = 6000
// How long the sync.stop after the peeks is waited for; the node stop
// follows whatever it answers.
const PEEK_STOP_WAIT_MS = 1000
// The part of the deadline no peek may use: a peek still unanswered then is
// given up, so the copy is built and saved in time (diary.peek's own timeout
// is longer than what may be left).
export const BG_PEEK_SAVE_MARGIN_MS = 2500
// Of BG_MAX_KEPT, the slots held for the originals' photos.
export const BG_ORIGINAL_SLOTS = 4

const HEX64 = /^[0-9a-f]{64}$/
const isHex64 = (v) => typeof v === 'string' && HEX64.test(v)
const MEMBER = Object.freeze({ kind: 'me' })

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

// Nothing the task could ever refresh: no hosted config, or no snapshot of
// that installation. A run that finds this removes the task, so a failed
// unregisterTaskAsync (sign out, lock, wipe) never leaves it running every
// 6 hours until the next ready phase. A node running or a recent run is not
// this: the task stays for later.
export function nothingToRefresh ({ snapshot, config } = {}) {
  try {
    const c = hostedConfig(config)
    return c === null || !boundTo(snapshot, c)
  } catch {
    return true
  }
}

class Stop extends Error {
  constructor (reason) {
    super(reason)
    this.reason = reason
  }
}

// The avatars and posts' photos of the first rows (own and followed, persist
// true), then those of the originals they show (persist 'copy': a stranger's
// go to the copy kinds): at most BG_MAX_KEPT, at most BG_MAX_KEPT_BYTES in
// all, with up to `reserve` of the slots left for the strangers' originals,
// so a busy page never leaves their reposted and quoted cards blank.
export function keepPlan (snapshot, max = BG_MAX_KEPT, maxBytes = BG_MAX_KEPT_BYTES, reserve = BG_ORIGINAL_SLOTS) {
  const taker = () => {
    const out = []
    let bytes = 0
    const seen = new Set()
    const add = (limit, persist, kind, author, d) => {
      if (out.length >= limit || !d || typeof d !== 'object' || !Number.isSafeInteger(d.bytes) || d.bytes <= 0) return
      const id = kind + '|' + author + '|' + d.core + '|' + d.start
      if (seen.has(id) || bytes + d.bytes > maxBytes) return
      seen.add(id)
      bytes += d.bytes
      out.push({ kind, author, d, persist })
    }
    return { out, add }
  }
  const { out, add } = taker()
  const photosOf = (item) => {
    const list = []
    const name = snapshot.names && snapshot.names[item.author]
    if (name && name.avatar) list.push(['avatars', item.author, name.avatar])
    if (item.kind === 'post' && Array.isArray(item.media)) {
      // A video is never kept (fetchVideo is always transient): its poster only.
      const pair = videoPair(item.media)
      for (const d of pair === null ? item.media : [pair.poster]) list.push(['posts', item.author, d])
    }
    return list
  }
  const originals = snapshot.originals && typeof snapshot.originals === 'object' ? Object.values(snapshot.originals) : []
  // A stranger (neither the owner nor a row author) never shares a photo id
  // with a row, so what the slots are held for is known before the rows:
  // their photos `add` takes on its own. An original of the owner or of a
  // row author holds none, and only fills what is left after them.
  const onPage = new Set(snapshot.items.map((i) => i && i.author))
  const fromStrangers = []
  const fromOthers = []
  for (const item of originals) {
    if (!item || typeof item !== 'object') continue
    if (item.author !== snapshot.owner && !onPage.has(item.author)) fromStrangers.push(...photosOf(item))
    else fromOthers.push(...photosOf(item))
  }
  const trial = taker()
  const cap = Math.min(Math.max(0, reserve), max)
  for (const [kind, author, d] of fromStrangers) trial.add(cap, 'copy', kind, author, d)
  const held = trial.out.length
  for (const row of snapshot.items) {
    for (const [kind, author, d] of photosOf(row)) add(max - held, true, kind, author, d)
  }
  for (const [kind, author, d] of fromStrangers.concat(fromOthers)) add(max, 'copy', kind, author, d)
  return out
}

// The diary.peek plan of a page: the targets of its reposts, quotes and
// replies by authors neither own, followed (`known`) nor blocked, grouped by
// author in first-seen order (newest rows first), at most BG_PEEK_AUTHORS
// authors and PEEK_SEQS_MAX seqs each, seqs ascending.
export function peekTargets (rows, { own, known, blocked } = {}) {
  const has = (set, k) => set instanceof Set && set.has(k)
  const byAuthor = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    for (const t of row.kind === 'repost' ? [row.to] : [row.quote, row.replyTo]) {
      const r = target(t)
      if (r === null || r.seq < 1 || r.author === own || has(known, r.author) || has(blocked, r.author)) continue
      let seqs = byAuthor.get(r.author)
      if (seqs === undefined) {
        if (byAuthor.size >= BG_PEEK_AUTHORS) continue
        seqs = new Set()
        byAuthor.set(r.author, seqs)
      }
      if (seqs.size < PEEK_SEQS_MAX) seqs.add(r.seq)
    }
  }
  return [...byAuthor].map(([author, seqs]) => ({ author, seqs: [...seqs].sort((a, b) => a - b) }))
}

// A peeked post's name entry for the snapshot's names: only what the peek
// verified; no avatar key when the peek had no profile (unknown, not "no
// photo").
function peekNameOf (item) {
  if (typeof item.name === 'string') return { name: item.name, username: item.username, avatar: item.avatar }
  if (typeof item.username === 'string') return { name: null, username: item.username }
  return null
}

// A block learned here is missing from the stored 'bloqueios' copy: the next
// open would adopt that copy as known and draw the newly blocked author's
// stored rows until block.list answers. Both stored lists go, so that open
// has no seed and its first live list purges every blocked author. Writing
// these keys to the copy instead would leave that open nothing newly blocked
// to purge. A missing or unreadable copy changes nothing, and no failure
// here ends the run. -> whether the copies were removed.
export function dropStaleQuietLists (store, snapshot, blocked) {
  try {
    if (!store || typeof store.load !== 'function' || typeof store.clear !== 'function') return false
    const stored = store.load('bloqueios', { origin: snapshot.origin, association: snapshot.association, owner: snapshot.owner, acting: MEMBER })
    if (!stored || !stored.body || !Array.isArray(stored.body.keys)) return false
    const held = new Set(stored.body.keys)
    let fresh = false
    for (const k of blocked) if (isHex64(k) && !held.has(k)) fresh = true
    if (!fresh) return false
    try { store.clear('bloqueios') } catch {}
    try { store.clear('silenciados') } catch {}
    return true
  } catch {
    return false
  }
}

// deps:
// - snapshot: the parsed snapshot shouldRun accepted; config: the remembered
//   hosted config.
// - start(config, { onEvent }) -> client ({ request(method, params) }) or
//   { client }; stop() -> promise. stop runs at the end whatever happened.
// - saveSnapshot(text); cacheGeneration() -> number.
// - kept: { keptUrl, keep, fetchBytes, validateAvatar? } for loadKept;
//   loadKept defaults to ./media/keptLoad.js. Each call carries the plan's
//   persist (true, or 'copy' for an original).
// - caches: { wipeEpoch, setAllowedAuthors, denyAuthors, noteBlocksKnown },
//   defaults to ./localCaches.js.
// - quietLists: { load(kind, binding), clear(kind) } over the stored block
//   and mute lists, defaults to the platform store (storedQuietLists).
// - fetchMembers(authors) -> [{ ok, value: { profileSeq, usernameSeq } }],
//   one per author in order (./indexClient.js): the peeks' profile hints.
//   Without it, or when it fails, a stranger is peeked without hints and
//   stored without a name.
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

// The peeked originals over the carried ones. A peek without a profile only
// says the name is unknown, so a carried original's name, username and
// avatar stay on the fresh post.
function withCarriedNames (carried, peeked) {
  const out = { ...carried }
  for (const [ref, item] of Object.entries(peeked)) {
    const old = Object.prototype.hasOwnProperty.call(carried, ref) ? carried[ref] : null
    if (item.name !== null || item.username !== null || !old || (old.name === null && old.username === null)) {
      out[ref] = item
      continue
    }
    const merged = { ...item, name: old.name, username: old.username }
    if (Object.prototype.hasOwnProperty.call(old, 'avatar')) merged.avatar = old.avatar
    else delete merged.avatar
    out[ref] = merged
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
    caches = localCaches,
    quietLists = null,
    fetchMembers = null,
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

    // The process never ran the providers that set the keep rules: they are
    // set from this run's lists, before any photo is kept.
    const epoch = caches.wipeEpoch()
    const blockList = await request('block.list')
    if (!blockList || !Array.isArray(blockList.keys)) throw new Stop('falha')
    const blocked = new Set(blockList.keys.filter((k) => typeof k === 'string').map((k) => k.toLowerCase()))
    dropStaleQuietLists(quietLists !== null ? quietLists : storedQuietLists(), snapshot, blocked)

    const follows = await readFollows(request, () => followsVersion)
    if (!follows.complete) throw new Stop('seguidos incompletos')
    const known = new Set(follows.keys.filter((k) => !blocked.has(k)))
    caches.setAllowedAuthors([own, ...follows.keys])
    caches.denyAuthors(blocked)
    caches.noteBlocksKnown(epoch)

    const page = await request('feed.read', { limit: FEED_LIMIT_DEFAULT, thumbs: true, alt: true })
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

    const peeked = { originals: {}, names: new Map() }
    const targets = peekTargets(rows, { own, known, blocked })
    // A once run that met no seeder in time: a peek would only wait for a
    // link and spend the time the photo keeps need.
    if (end.reason === 'done' && targets.length > 0 && deadlineMs - (now() - startedAt) >= BG_PEEK_MIN_LEFT_MS) {
      const leftMs = () => deadlineMs - (now() - startedAt) - BG_PEEK_SAVE_MARGIN_MS
      await peekOriginals(client, targets, peeked, { check, bounded, setTimer, clearTimer, leftMs, fetchMembers })
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
      // The peeked originals and names win. The previous snapshot's names
      // and own hearts carry over for refs still on this page, and so do
      // the originals of reposts still on it: feed.read drops a repost whose
      // target was deleted, so those are known to stand. A quoted or
      // replied-to post may have been deleted since and its quoting row
      // stays, so an old one is left out (shown unresolved until the live
      // page) unless this run peeked it. buildSnapshot keeps rows of own or
      // followed authors only, and originals and names of anyone not
      // blocked; counts are left out as stale.
      profileOf: (a) => withPageHint(byAuthor.get(a) || peeked.names.get(a), oldName(snapshot, a)),
      originals: withCarriedNames(repostOriginals(snapshot.originals, rows), peeked.originals),
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
      for (const { kind, author, d, persist } of keepPlan(next)) {
        check()
        if (cacheGeneration() !== gen) break
        try {
          await bounded(loadKept({
            kind,
            author,
            d,
            persist,
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

// One diary.peek per target author, in order, on a run started for them and
// stopped in the finally whatever happened. A failed peek skips its author
// (never retried); a failed start skips them all. A peek unanswered when
// only BG_PEEK_SAVE_MARGIN_MS of the deadline is left ends the round (its
// late answer is ignored), so the copy is still saved. Only the deadline or
// the abort (Stop) ends the refresh, and then the run is stopped without
// waiting for its answer.
const LATE = Symbol('late')

async function peekOriginals (client, targets, out, { check, bounded, setTimer, clearTimer, leftMs, fetchMembers }) {
  let sent = false
  let stopping = false
  try {
    check()
    // The member index answers over HTTP, beside the link coming up: diary.peek
    // reads a name only from the blocks these hints point at.
    const members = typeof fetchMembers === 'function'
      ? Promise.resolve().then(() => fetchMembers(targets.map((x) => x.author))).catch(() => null)
      : Promise.resolve(null)
    sent = true
    try {
      await bounded(client.request('sync.start', { once: false }))
    } catch (err) {
      if (err instanceof Stop) throw err
      return
    }
    const hints = await memberHints(members, targets, { bounded, setTimer, clearTimer, left: leftMs() })
    for (const { author, seqs } of targets) {
      check()
      const left = leftMs()
      if (left <= 0) break
      let answer
      let late = null
      try {
        answer = await bounded(Promise.race([
          client.request('diary.peek', { author, seqs, ...hints.get(author), thumbs: true, alt: true }),
          new Promise((resolve) => { late = setTimer(() => resolve(LATE), left) })
        ]))
      } catch (err) {
        if (err instanceof Stop) throw err
        continue
      } finally {
        clearTimer(late)
      }
      if (answer === LATE) break
      const map = new Map([[author, answer]])
      for (const seq of seqs) {
        const item = lookupPost(map, author + ':' + seq)
        if (item === null) continue
        out.originals[author + ':' + seq] = item
        const name = peekNameOf(item)
        if (name !== null && !out.names.has(author)) out.names.set(author, name)
      }
    }
  } catch (err) {
    if (err instanceof Stop) stopping = true
    throw err
  } finally {
    if (sent && stopping) {
      // The refresh is ending and the node stop follows at once: nothing
      // waits on this answer.
      try { Promise.resolve(client.request('sync.stop')).catch(() => {}) } catch {}
    } else if (sent) {
      let timer = null
      try {
        await Promise.race([
          Promise.resolve().then(() => client.request('sync.stop')),
          new Promise((resolve) => { timer = setTimer(resolve, PEEK_STOP_WAIT_MS) })
        ])
      } catch {}
      clearTimer(timer)
    }
  }
}

// author -> the diary.peek hints the member index gave ({ profileSeq?,
// usernameSeq? }, each only a seq >= 1). A failed, malformed or late answer
// (`left` ms, the peeks' own budget) gives none: those authors are peeked
// without a name. Only the deadline or the abort (Stop) throws.
async function memberHints (members, targets, { bounded, setTimer, clearTimer, left }) {
  const out = new Map()
  if (left <= 0) return out
  let late = null
  let answer
  try {
    answer = await bounded(Promise.race([
      members,
      new Promise((resolve) => { late = setTimer(() => resolve(LATE), left) })
    ]))
  } finally {
    clearTimer(late)
  }
  if (!Array.isArray(answer)) return out
  const isHint = (v) => Number.isSafeInteger(v) && v >= 1
  targets.forEach(({ author }, i) => {
    const m = answer[i]
    const v = m && typeof m === 'object' && m.ok === true && m.value && typeof m.value === 'object' ? m.value : null
    if (v === null) return
    const hint = {}
    if (isHint(v.profileSeq)) hint.profileSeq = v.profileSeq
    if (isHint(v.usernameSeq)) hint.usernameSeq = v.usernameSeq
    out.set(author, hint)
  })
  return out
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
