'use strict'

// The AI report triage's working ledger: per-report outcome marks (with the
// retry schedule of the worker's exponential backoff) and a cache of the
// VERIFIED post read captured when a report first arrived. ONE file,
// <dataDir>/triage.json (mode 0o600, data dir 0o700), beside moderation.json
// and always replaced whole through writeJsonAtomic
// (packages/core/lib/store.js). moderation.json is never read or touched here.
//
// File shape (exact keys everywhere):
//   { v: 1,
//     reports: { [reportId]: { at, code, retryAt, attempts, exemplars,
//                              suggestion, nearest } },
//     reads: { [reportId]: { at, target, seq, contentHash, text, hasMedia,
//                            hasQuote, textCp, truncated, embedding } } }
// `reports[id].at` is the time of the last mark; `code` a short token;
// `attempts` the consecutive failed reads; `retryAt` when to try again (or
// null); `exemplars` how many precedents the decision saw; `suggestion`
// bloquear | descartar | null; `nearest` the best cosine in [-1, 1] or null.
// `reads[id].at` is when the verified read was captured: the worker learns
// from a human decision only when read.at precedes the report's decidedAt
// (the text was visible to the moderator). The read is kept so a later
// human bloquear still has its example after the seeder purges the blocked
// diary (packages/core/lib/seeder.js _drop). `embedding` is null or exactly
// DIM integers in [-127, 127].
//
// There are no day counters and no "posts already decided" set here: both
// are derived by the worker from moderation.json rows (decidedBy === 'ia'),
// so a crash between a decision and a ledger write can never undercount a
// cap, and no capped set can evict an entry while 100,000 reports stay
// stored.
//
// Caps: MAX_REPORT_MARKS marks and MAX_READS reads, each dropping the oldest
// `at` (ties by id) in the same write. Reads beyond MAX_READS lose their
// cached text, so a human decision made after that many newer reports has
// no example to learn from: a known pilot-scale limit.
//
// Unlike exemplars.json (whose text is evidence a moderator acted on and so
// is never rewritten when malformed), this file is DERIVED data: losing it
// only means some reports are re-read or left to humans. A malformed
// triage.json is therefore renamed aside to triage.json.corrupt-<ms> (or
// -<ms>-<n>, never replacing an earlier aside copy) and
// recreated empty at open. Only if that recovery (or a later write) fails do
// the methods throw { code: 'indisponivel' }, which callers treat as "do not
// auto-decide".
//
// Mutations are synchronous (writeJsonAtomic is). Errors carry only a token
// in `code`: pedido-invalido, indisponivel.

const fs = require('node:fs')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isPlainObject, isCanonicalIso, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { MAX_TEXT, MAX_LOG_BLOCKS } = require('@varanda/core/lib/records')
const { isCleanText } = require('../moderation-store')

const FILE = 'triage.json'
const VERSION = 1
const DIM = 384
const MAX_REPORT_MARKS = 20000
const MAX_READS = 2000
const MAX_ASIDE_TRIES = 100
const ID_RE = /^[A-Za-z0-9_-]{22}$/
const CODE_RE = /^[a-z0-9-]{1,32}$/
const SUGGESTIONS = ['bloquear', 'descartar']
const FILE_KEYS = ['v', 'reports', 'reads']
const MARK_KEYS = ['at', 'code', 'retryAt', 'attempts', 'exemplars', 'suggestion', 'nearest']
const READ_KEYS = ['at', 'target', 'seq', 'contentHash', 'text', 'hasMedia', 'hasQuote', 'textCp', 'truncated', 'embedding']

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function has (obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function dict (src) {
  const out = Object.create(null)
  if (src) for (const [k, v] of Object.entries(src)) out[k] = v
  return out
}

function exactKeys (obj, keys) {
  return Object.keys(obj).length === keys.length && keys.every((k) => has(obj, k))
}

function validId (id) {
  return typeof id === 'string' && ID_RE.test(id)
}

function validEmbedding (e) {
  if (e === null) return true
  if (!Array.isArray(e) && !(e instanceof Int8Array)) return false
  if (e.length !== DIM) return false
  for (let i = 0; i < DIM; i++) {
    const x = e[i]
    if (!Number.isInteger(x) || x < -127 || x > 127) return false
  }
  return true
}

function validMark (m) {
  return isPlainObject(m) &&
    exactKeys(m, MARK_KEYS) &&
    isCanonicalIso(m.at) &&
    typeof m.code === 'string' && CODE_RE.test(m.code) &&
    (m.retryAt === null || isCanonicalIso(m.retryAt)) &&
    Number.isInteger(m.attempts) && m.attempts >= 0 &&
    Number.isInteger(m.exemplars) && m.exemplars >= 0 &&
    (m.suggestion === null || SUGGESTIONS.includes(m.suggestion)) &&
    (m.nearest === null || (Number.isFinite(m.nearest) && m.nearest >= -1 && m.nearest <= 1))
}

function validRead (r) {
  return isPlainObject(r) &&
    exactKeys(r, READ_KEYS) &&
    isCanonicalIso(r.at) &&
    isLowerHex(r.target, 32) &&
    Number.isInteger(r.seq) && r.seq >= 1 && r.seq < MAX_LOG_BLOCKS &&
    isLowerHex(r.contentHash, 32) &&
    typeof r.text === 'string' && isCleanText(r.text, true) && Array.from(r.text).length <= MAX_TEXT &&
    typeof r.hasMedia === 'boolean' &&
    typeof r.hasQuote === 'boolean' &&
    Number.isInteger(r.textCp) && r.textCp >= 0 &&
    typeof r.truncated === 'boolean' &&
    validEmbedding(r.embedding)
}

function copyRead (r) {
  return { ...r, embedding: r.embedding === null ? null : Array.from(r.embedding) }
}

function fromJson (obj) {
  const bad = () => new Error('registro inválido')
  if (!isPlainObject(obj) || !exactKeys(obj, FILE_KEYS) || obj.v !== VERSION) throw bad()
  if (!isPlainObject(obj.reports) || !isPlainObject(obj.reads)) throw bad()
  const reports = dict()
  const reads = dict()
  const markIds = Object.keys(obj.reports)
  const readIds = Object.keys(obj.reads)
  if (markIds.length > MAX_REPORT_MARKS || readIds.length > MAX_READS) throw bad()
  for (const id of markIds) {
    if (!validId(id) || !validMark(obj.reports[id])) throw bad()
    reports[id] = { ...obj.reports[id] }
  }
  for (const id of readIds) {
    if (!validId(id) || !validRead(obj.reads[id])) throw bad()
    reads[id] = copyRead(obj.reads[id])
  }
  return { v: VERSION, reports, reads }
}

function readState (file) {
  const st = fs.lstatSync(file)
  if (!st.isFile()) throw new Error('registro inválido')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function emptyState () {
  return { v: VERSION, reports: dict(), reads: dict() }
}

// Drops the oldest entries (by at, then id) beyond `max`; returns the count.
// `keep` (the id being written) is never evicted, even when it sorts oldest
// (a clock stepped back, or an earlier capture time): older OTHER ids go.
function capMap (map, max, keep) {
  const all = Object.keys(map)
  if (all.length <= max) return 0
  const ids = all.filter((id) => id !== keep)
  ids.sort((a, b) => {
    if (map[a].at !== map[b].at) return map[a].at < map[b].at ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  })
  const n = all.length - max
  for (let i = 0; i < n; i++) delete map[ids[i]]
  return n
}

function exists (p) {
  try {
    fs.lstatSync(p)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

// A not-yet-existing aside name, so an earlier corrupt copy (same
// millisecond, or a clock stepped back) is never replaced: <file>.corrupt-<ms>,
// then -<ms>-1 ... -<ms>-<MAX_ASIDE_TRIES - 1>; none free throws.
function asideName (file, ms) {
  const base = file + '.corrupt-' + ms
  for (let i = 0; i < MAX_ASIDE_TRIES; i++) {
    const name = i === 0 ? base : base + '-' + i
    if (!exists(name)) return name
  }
  throw new Error('sem nome livre')
}

function openLedger (dataDir, { now = Date.now } = {}) {
  refuseSymlinkDir(dataDir)
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dataDir, 0o700)
  const file = path.join(dataDir, FILE)
  let state = null
  let failed = false
  let fresh = false
  try {
    state = readState(file)
  } catch (err) {
    fresh = true
    if (err.code !== 'ENOENT') {
      // Derived data: set the bad file aside (kept for the operator) and
      // start over. A symlink or directory is renamed too, never followed.
      try {
        fs.renameSync(file, asideName(file, now()))
      } catch {
        failed = true
      }
    }
  }
  if (fresh && !failed) {
    state = emptyState()
    try {
      writeJsonAtomic(file, state, 0o600)
    } catch {
      failed = true
    }
  }

  function usable () {
    if (failed) throw fail('indisponivel')
  }

  function iso (ms) {
    return new Date(ms).toISOString()
  }

  function persist (next) {
    try {
      writeJsonAtomic(file, next, 0o600)
    } catch (err) {
      try {
        state = readState(file)
      } catch {
        failed = true
      }
      throw err
    }
    state = next
  }

  function get (id) {
    usable()
    if (!validId(id)) throw fail('pedido-invalido')
    return has(state.reports, id) ? { ...state.reports[id] } : null
  }

  // Merges `fields` (any of code, retryAt, attempts, exemplars, suggestion,
  // nearest) over the existing mark, or over the defaults for a first mark
  // (which must name a code), and stamps `at` with the clock.
  function mark (id, fields) {
    usable()
    if (!validId(id) || !isPlainObject(fields)) throw fail('pedido-invalido')
    if (!Object.keys(fields).every((k) => k !== 'at' && MARK_KEYS.includes(k))) throw fail('pedido-invalido')
    const prev = has(state.reports, id)
      ? state.reports[id]
      : { code: '', retryAt: null, attempts: 0, exemplars: 0, suggestion: null, nearest: null }
    const row = { ...prev, ...fields, at: iso(now()) }
    const entry = {}
    for (const k of MARK_KEYS) entry[k] = row[k]
    if (!validMark(entry)) throw fail('pedido-invalido')
    const next = { v: VERSION, reports: dict(state.reports), reads: state.reads }
    next.reports[id] = entry
    capMap(next.reports, MAX_REPORT_MARKS, id)
    persist(next)
    return { ...entry }
  }

  function read (id) {
    usable()
    if (!validId(id)) throw fail('pedido-invalido')
    return has(state.reads, id) ? copyRead(state.reads[id]) : null
  }

  // Replaces the cached read of `id`. `at` defaults to the clock; a caller
  // that captured the read earlier passes that canonical time.
  function putRead (id, fields) {
    usable()
    if (!validId(id) || !isPlainObject(fields)) throw fail('pedido-invalido')
    if (!Object.keys(fields).every((k) => READ_KEYS.includes(k))) throw fail('pedido-invalido')
    const row = { at: iso(now()), ...fields }
    if (!exactKeys(row, READ_KEYS) || !validRead(row)) throw fail('pedido-invalido')
    const entry = copyRead(row)
    const next = { v: VERSION, reports: state.reports, reads: dict(state.reads) }
    next.reads[id] = entry
    capMap(next.reads, MAX_READS, id)
    persist(next)
    return copyRead(entry)
  }

  function dropRead (id) {
    usable()
    if (!validId(id)) throw fail('pedido-invalido')
    if (!has(state.reads, id)) return false
    const next = { v: VERSION, reports: state.reports, reads: dict(state.reads) }
    delete next.reads[id]
    persist(next)
    return true
  }

  function readIds () {
    usable()
    return Object.keys(state.reads)
  }

  // Re-applies the caps (they already hold after every write); writes only
  // when something was dropped. Returns the number of entries dropped.
  function prune () {
    usable()
    const next = { v: VERSION, reports: dict(state.reports), reads: dict(state.reads) }
    const n = capMap(next.reports, MAX_REPORT_MARKS) + capMap(next.reads, MAX_READS)
    if (n > 0) persist(next)
    return n
  }

  return { get, mark, read, putRead, dropRead, readIds, prune }
}

module.exports = {
  FILE,
  DIM,
  MAX_REPORT_MARKS,
  MAX_READS,
  openLedger
}
