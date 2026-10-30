/* global URL */

// A small LRU of blob: URLs for verified media, pure (no React, no fetch).
// Post keys are 'core:start:blocks:sha256'; profile photos use avatarKey
// (author plus the descriptor fields). A key has at most one load in flight
// (callers share its promise), at most `concurrency` loads run at once (the
// rest wait in order), and the least recently used URL is revoked when the
// cache grows past `max`. A failed load is not cached: the next get retries.
// revoke(ranges) drops every entry whose core and block interval overlap a
// freed range, in either key format. A load already running for that key is
// not stored, and a later get does not fetch it again: the blob was revoked
// and the seeder will not serve the range. One entry per content key serves
// both persisting and transient (persist: false, authors the device does not
// follow) loads: both produce the same verified bytes and only the network
// fetch mode differs (the caller's load passes persist to fetchMedia). This
// in-memory LRU is not persistent storage: its blob: URLs die with the page
// and are revoked on eviction.

import { avatarKeyRange } from './avatar.js'

const noopRevoke = (url) => {
  try { URL.revokeObjectURL(url) } catch {}
}

// Automatic retries of a failed load while its tile is shown: a post's
// blocks can reach the seeder a moment after the post itself, so a 404 or a
// network error is retried after 2 s, 5 s and 15 s, then the tile waits for
// a tap. A mismatch (length, SHA-256) is never retried automatically.
export const RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000])

// The delay before automatic retry number `done` + 1, or null to stop.
export function retryDelay (err, done, delays = RETRY_DELAYS_MS) {
  if (!err || err.retryable !== true) return null
  if (!Number.isInteger(done) || done < 0 || done >= delays.length) return null
  return delays[done]
}

export function mediaKey (d) {
  return d.core + ':' + d.start + ':' + d.blocks + ':' + d.sha256
}

const HEX64 = /^[0-9a-f]{64}$/

// log.read's largest page (docs/rpc.md LOG_LIMIT_MAX). Callers pass the
// constant; the default keeps this module off the rpc package.
const LOG_PAGE = 36

// How many newest pages to walk looking for an older tombstone. The one a
// delete just wrote is on the first page; past this the photo stays cached
// until the page is left, rather than reading a whole diary.
const REVOKE_READ_PAGES = 8

function canonicalInt (s) {
  if (typeof s !== 'string' || !/^[0-9]+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

function mediaKeyRange (key) {
  if (typeof key !== 'string') return null
  const parts = key.split(':')
  if (parts.length !== 4 || !HEX64.test(parts[0]) || !HEX64.test(parts[3])) return null
  const start = canonicalInt(parts[1])
  const blocks = canonicalInt(parts[2])
  if (start === null || start < 0 || blocks === null || blocks < 1) return null
  return { core: parts[0], start, blocks }
}

function rangeOfKey (key) {
  const avatar = avatarKeyRange(key)
  if (avatar !== null) return avatar
  return mediaKeyRange(key)
}

function asRange (m) {
  if (!m || typeof m !== 'object') return null
  if (typeof m.core !== 'string' || !HEX64.test(m.core)) return null
  if (!Number.isSafeInteger(m.start) || !Number.isSafeInteger(m.blocks)) return null
  if (m.start < 0 || m.blocks < 1) return null
  return { core: m.core, start: m.start, blocks: m.blocks }
}

function overlaps (a, b) {
  return a.core === b.core && a.start < b.start + b.blocks && b.start < a.start + a.blocks
}

function overlapsAny (key, ranges) {
  const part = rangeOfKey(key)
  if (part === null) return false
  for (const r of ranges) if (overlaps(part, r)) return true
  return false
}

function goneError () {
  return new Error('apagada')
}

// Every live cache, so a screen can drop a photo it does not hold the
// instance for (post tiles and avatars keep their own).
const caches = new Set()

export function createMediaCache ({ max = 64, concurrency = 4, revoke = noopRevoke } = {}) {
  const release = revoke
  const entries = new Map()
  const inflight = new Map()
  const waiting = []
  const dropped = []
  let active = 0
  // Bumped when ranges are freed. A load samples it at schedule time so a
  // key revoked while it is still queued is never fetched.
  let generation = 0

  const pump = () => {
    while (active < concurrency && waiting.length > 0) {
      const job = waiting.shift()
      active++
      Promise.resolve()
        .then(job.load)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--
          pump()
        })
    }
  }

  const schedule = (load) => new Promise((resolve, reject) => {
    waiting.push({ load, resolve, reject })
    pump()
  })

  const store = (key, url) => {
    const old = entries.get(key)
    if (old !== undefined) {
      entries.delete(key)
      if (old !== url) release(old)
    }
    entries.set(key, url)
    while (entries.size > max) {
      const [oldest, oldUrl] = entries.entries().next().value
      entries.delete(oldest)
      release(oldUrl)
    }
  }

  // The cached URL (marked as recently used), or null.
  const peek = (key) => {
    if (!entries.has(key)) return null
    const url = entries.get(key)
    entries.delete(key)
    entries.set(key, url)
    return url
  }

  const blocked = (key) => overlapsAny(key, dropped)

  const get = (key, load) => {
    if (blocked(key)) return Promise.reject(goneError())
    const hit = peek(key)
    if (hit !== null) return Promise.resolve(hit)
    const running = inflight.get(key)
    if (running) return running
    const gen = generation
    const p = schedule(() => {
      // Still queued when the range was freed: do not start the fetch.
      if (generation !== gen && blocked(key)) throw goneError()
      return load()
    }).then((url) => {
      // The fetch finished after the range was freed: do not store it.
      if (blocked(key)) {
        if (typeof url === 'string') release(url)
        throw goneError()
      }
      store(key, url)
      return url
    }).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
    inflight.set(key, p)
    return p
  }

  const clear = () => {
    for (const url of entries.values()) release(url)
    entries.clear()
  }

  // `ranges`: { core, start, blocks } (a descriptor's fields are enough).
  // A key is dropped when its interval overlaps, not when the strings match,
  // so an avatar key and a post key for the same bytes both go.
  const drop = (ranges) => {
    const list = []
    if (Array.isArray(ranges)) {
      for (const r of ranges) {
        const range = asRange(r)
        if (range !== null) list.push(range)
      }
    }
    if (list.length === 0) return
    dropped.push(...list)
    generation++
    for (const key of [...entries.keys()]) {
      if (!overlapsAny(key, list)) continue
      const url = entries.get(key)
      entries.delete(key)
      release(url)
    }
  }

  const api = {
    get,
    peek,
    clear,
    revoke: drop,
    get size () { return entries.size },
    get active () { return active },
    get waiting () { return waiting.length }
  }
  caches.add(api)
  return api
}

// Drops overlapping entries in every cache createMediaCache has returned.
export function revokeMedia (ranges) {
  for (const cache of caches) cache.revoke(ranges)
}

function descriptorRanges (record) {
  if (!record || typeof record !== 'object') return []
  if (record.type === 'post' && Array.isArray(record.media)) return record.media
  if (record.type === 'profile' && record.avatar !== null && typeof record.avatar === 'object') return [record.avatar]
  return []
}

// Media ranges named by effective tombstones of `seqs`. A tombstone whose
// own block is deleted has no effect. A range overlapped by a post or
// profile that is still in the fold is omitted: that photo stays on screen.
// `entries` is any order of { seq, record } (log.read entries). Never throws.
export function tombstoneRanges (entries, seqs) {
  const want = new Set()
  if (Array.isArray(seqs)) {
    for (const s of seqs) if (Number.isSafeInteger(s)) want.add(s)
  }
  const tombs = []
  const rest = []
  const seen = new Set()
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue
      const seq = e.seq
      const record = e.record
      if (!Number.isSafeInteger(seq) || seen.has(seq) || !record || typeof record !== 'object') continue
      seen.add(seq)
      if (record.type === 'delete' && Number.isSafeInteger(record.seq)) {
        tombs.push({ seq, target: record.seq, media: record.media })
      } else {
        rest.push({ seq, record })
      }
    }
  }
  tombs.sort((a, b) => b.seq - a.seq)
  const deleted = new Set()
  const effective = []
  for (const t of tombs) {
    if (deleted.has(t.seq)) continue
    deleted.add(t.target)
    effective.push(t)
  }
  const live = []
  for (const entry of rest) {
    if (deleted.has(entry.seq)) continue
    for (const d of descriptorRanges(entry.record)) {
      const range = asRange(d)
      if (range !== null) live.push(range)
    }
  }
  const out = []
  const have = new Set()
  for (const t of effective) {
    if (!want.has(t.target) || !Array.isArray(t.media)) continue
    for (const m of t.media) {
      const range = asRange(m)
      if (range === null || live.some((l) => overlaps(l, range))) continue
      const id = range.core + ':' + range.start + ':' + range.blocks
      if (have.has(id)) continue
      have.add(id)
      out.push(range)
    }
  }
  return out
}

// True when every wanted seq has a tombstone that the fold still applies.
// A newer tombstone of that tombstone does not count: the older one may.
function foundEffective (entries, want) {
  const tombs = []
  for (const e of entries) {
    const record = e && e.record
    if (!record || record.type !== 'delete' || !Number.isSafeInteger(e.seq)) continue
    if (!Number.isSafeInteger(record.seq)) continue
    tombs.push({ seq: e.seq, target: record.seq })
  }
  tombs.sort((a, b) => b.seq - a.seq)
  const deleted = new Set()
  const hit = new Set()
  for (const t of tombs) {
    if (deleted.has(t.seq)) continue
    deleted.add(t.target)
    if (want.has(t.target)) hit.add(t.target)
  }
  for (const s of want) if (!hit.has(s)) return false
  return true
}

function pageSeqs (log) {
  const seqs = []
  const entries = log && Array.isArray(log.entries) ? log.entries : []
  const invalid = log && Array.isArray(log.invalid) ? log.invalid : []
  for (const e of entries) if (e && Number.isSafeInteger(e.seq)) seqs.push(e.seq)
  for (const e of invalid) if (e && Number.isSafeInteger(e.seq)) seqs.push(e.seq)
  return { entries, seqs }
}

// Reads the own diary from the head until the tombstones of `seqs` are in
// hand (they are newer than their targets), then revokes those effective
// ranges in every live cache. Never throws: the delete already succeeded.
export async function revokeDeletedMedia (request, seqs, limit = LOG_PAGE) {
  try {
    const want = []
    if (Array.isArray(seqs)) {
      for (const s of seqs) if (Number.isSafeInteger(s) && s >= 1) want.push(s)
    }
    if (want.length === 0 || typeof request !== 'function') return
    const wantSet = new Set(want)
    const min = Math.min(...want)
    const page = Number.isSafeInteger(limit) && limit >= 1 ? limit : LOG_PAGE
    let before
    const entries = []
    for (let i = 0; i < REVOKE_READ_PAGES; i++) {
      const params = { limit: page }
      if (before !== undefined) params.before = before
      const log = await request('log.read', params)
      const got = pageSeqs(log)
      entries.push(...got.entries)
      // Newer blocks are already in hand, so the fold can judge these.
      if (foundEffective(entries, wantSet)) break
      if (got.seqs.length === 0 || !log || log.entriesTruncated === 0) break
      const oldest = Math.min(...got.seqs)
      if (oldest <= min) break
      before = oldest
    }
    const ranges = tombstoneRanges(entries, want)
    if (ranges.length > 0) revokeMedia(ranges)
  } catch {}
}
