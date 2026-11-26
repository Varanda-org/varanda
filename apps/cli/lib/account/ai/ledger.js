'use strict'

// The AI report triage's working ledger: per-report outcome marks (with the
// retry schedule of the worker's exponential backoff) and a cache of the
// VERIFIED post read captured when a report first arrived. TWO files in
// <dataDir> (mode 0o600, data dir 0o700), beside moderation.json, which is
// never read or touched here:
//   triage.json         the snapshot, always replaced whole through
//                       writeJsonAtomic (packages/core/lib/store.js)
//   triage-marks.jsonl  marks appended since that snapshot, one compact
//                       line each, fsynced
// A full snapshot is about 15 MB at the caps, too much to rewrite for every
// mark; reads change far less often and still rewrite the snapshot.
//
// Snapshot shape (exact keys everywhere):
//   { v: 2, log: <16 hex>,
//     reports: { [reportId]: { at, code, retryAt, attempts, exemplars,
//                              suggestion, nearest } },
//     reads: { [reportId]: { at, target, seq, contentHash, text, hasMedia,
//                            hasQuote, hasPoll, textCp, truncated,
//                            embedding, [edited, original] } } }
// Log: a first line { log: <16 hex> }, then { id, at, code, retryAt,
// attempts, exemplars, suggestion, nearest } per mark. Open replays the log
// over the snapshot, last line wins, then applies the cap once (sparing the
// last id). With a monotonic clock that keeps the same marks the live marks
// kept; only a clock stepped back can make it keep a different oldest one.
// Every snapshot write picks a new `log` token and then replaces the log with
// just its header (tried twice): a crash between the two leaves a log whose
// token does not match, ignored because the snapshot already holds it. A
// torn last line (crash mid-append) is dropped; a bad line elsewhere is
// corruption (below). The log is folded into the snapshot past
// 2 x MAX_REPORT_MARKS lines and on prune(). A mark that changes nothing but
// `at` writes nothing and keeps the old `at`.
// v1 (no `log`, no log file) is read and rewritten as v2 at open. A v1
// reader sees v !== 1 in a v2 file and treats it as corrupt: set aside and
// started empty, losing only derived data.
//
// `reports[id].at` is the time of the last mark; `code` a short token;
// `attempts` the consecutive failed reads; `retryAt` when to try again (or
// null); `exemplars` how many precedents the decision saw; `suggestion`
// bloquear | descartar | null; `nearest` the best cosine in [-1, 1] or null.
// `reads[id].at` is when the verified read was captured: the worker learns
// from a human decision only when read.at precedes the report's decidedAt
// (the text was visible to the moderator). The read is kept so a later
// human bloquear still has its example after the seeder purges the blocked
// diary (packages/core/lib/seeder.js _drop). `embedding` is null or exactly
// DIM integers in [-127, 127]. An edited post (packages/core/lib/post-edit.js)
// carries both `edited` (true) and `original`, its text as first written;
// a row without the pair is a post read unedited.
//
// There are no day counters and no "posts already decided" set here: both
// are derived by the worker from moderation.json rows (decidedBy === 'ia',
// or a `reopened` marker naming the AI decision a person undid), so a
// crash between a decision and a ledger write can never undercount a cap,
// and no capped set can evict an entry while 100,000 reports stay stored.
//
// Caps: MAX_REPORT_MARKS marks and MAX_READS reads, each dropping the oldest
// `at` (ties by id) in the same write. Reads beyond MAX_READS lose their
// cached text, so a human decision made after that many newer reports has
// no example to learn from: a known pilot-scale limit.
//
// Unlike exemplars.json (whose text is evidence a moderator acted on and so
// is never rewritten when malformed), these files are DERIVED data: losing it
// only means some reports are re-read or left to humans. A malformed
// triage.json or marks log is therefore renamed aside to <name>.corrupt-<ms>
// (or -<ms>-<n>, never replacing an earlier aside copy), both files go, and
// the ledger is recreated empty at open. Only if that recovery (or a later write) fails do
// the methods throw { code: 'indisponivel' }, which callers treat as "do not
// auto-decide".
//
// `strict` (Excluir conta while the triage is off, ./forget.js) never sets a
// file aside and never creates one: a missing or malformed triage.json or
// marks log makes the open throw { code: 'indisponivel', file } instead, no
// rewrite happens at open, and a later write resets the marks log only when
// it exists.
//
// Mutations are synchronous. Errors carry only a token
// in `code`: pedido-invalido, indisponivel.

const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isPlainObject, isCanonicalIso, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { MAX_TEXT, MAX_LOG_BLOCKS } = require('@varanda/core/lib/records')
const { isCleanText } = require('../moderation-store')

const FILE = 'triage.json'
const LOG_FILE = 'triage-marks.jsonl'
const VERSION = 2
const DIM = 384
const MAX_REPORT_MARKS = 20000
const MAX_READS = 2000
const MAX_LOG_LINES = 2 * MAX_REPORT_MARKS
const MAX_ASIDE_TRIES = 100
const ID_RE = /^[A-Za-z0-9_-]{22}$/
const CODE_RE = /^[a-z0-9-]{1,32}$/
const SUGGESTIONS = ['bloquear', 'descartar']
const FILE_KEYS_V1 = ['v', 'reports', 'reads']
const FILE_KEYS = ['v', 'log', 'reports', 'reads']
const MARK_KEYS = ['at', 'code', 'retryAt', 'attempts', 'exemplars', 'suggestion', 'nearest']
const LINE_KEYS = ['id', ...MARK_KEYS]
const READ_KEYS = ['at', 'target', 'seq', 'contentHash', 'text', 'hasMedia', 'hasQuote', 'hasPoll', 'textCp', 'truncated', 'embedding']
const EDITED_READ_KEYS = [...READ_KEYS, 'edited', 'original']
// A row stored before `hasPoll` existed has every READ_KEYS key but that one.
const LEGACY_READ_KEYS = READ_KEYS.filter((k) => k !== 'hasPoll')

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
  if (!isPlainObject(r)) return false
  const edited = has(r, 'edited')
  return exactKeys(r, edited ? EDITED_READ_KEYS : READ_KEYS) &&
    (!edited || (r.edited === true && typeof r.original === 'string' && isCleanText(r.original, true) && Array.from(r.original).length <= MAX_TEXT)) &&
    isCanonicalIso(r.at) &&
    isLowerHex(r.target, 32) &&
    Number.isInteger(r.seq) && r.seq >= 1 && r.seq < MAX_LOG_BLOCKS &&
    isLowerHex(r.contentHash, 32) &&
    typeof r.text === 'string' && isCleanText(r.text, true) && Array.from(r.text).length <= MAX_TEXT &&
    typeof r.hasMedia === 'boolean' &&
    typeof r.hasQuote === 'boolean' &&
    typeof r.hasPoll === 'boolean' &&
    Number.isInteger(r.textCp) && r.textCp >= 0 &&
    typeof r.truncated === 'boolean' &&
    validEmbedding(r.embedding)
}

// A row written before `hasPoll` existed is read as hasPoll:false. That never
// loosens a gate: an older worker's records.js knew no poll key set, so it
// refused a poll post as no post at all (nao-e-publicacao) and stored no row
// for it; no legacy row is a poll. Only a row of exactly the old shape is
// upgraded; anything else stays invalid.
function upgradeRead (r) {
  if (isPlainObject(r) && !has(r, 'hasPoll') && exactKeys(r, LEGACY_READ_KEYS)) return { ...r, hasPoll: false }
  return r
}

function copyRead (r) {
  return { ...r, embedding: r.embedding === null ? null : Array.from(r.embedding) }
}

function pickMark (row) {
  const entry = {}
  for (const k of MARK_KEYS) entry[k] = row[k]
  return entry
}

// Returns { reports, reads, log }; `log` is null for a v1 file (migrated by
// the caller into a v2 snapshot).
function fromJson (obj) {
  const bad = () => new Error('registro inválido')
  if (!isPlainObject(obj)) throw bad()
  const v1 = obj.v === 1 && exactKeys(obj, FILE_KEYS_V1)
  if (!v1 && !(obj.v === VERSION && exactKeys(obj, FILE_KEYS) && isLowerHex(obj.log, 8))) throw bad()
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
    const row = upgradeRead(obj.reads[id])
    if (!validId(id) || !validRead(row)) throw bad()
    reads[id] = copyRead(row)
  }
  return { reports, reads, log: v1 ? null : obj.log }
}

function readState (file) {
  const st = fs.lstatSync(file)
  if (!st.isFile()) throw new Error('registro inválido')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function parseLine (text, i) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (i === 0) return isPlainObject(obj) && exactKeys(obj, ['log']) && isLowerHex(obj.log, 8) ? obj : null
  if (!isPlainObject(obj) || !exactKeys(obj, LINE_KEYS) || !validId(obj.id)) return null
  const entry = pickMark(obj)
  return validMark(entry) ? { id: obj.id, entry } : null
}

// The marks appended since the snapshot named `token`. Returns null when the
// log is missing or belongs to an older snapshot (a crash after the snapshot
// was written but before the log was reset: its lines are already in the
// snapshot). `torn` says the last line was cut short by a crash mid-append
// and must be dropped from disk before the next append. A bad line anywhere
// else throws, like a malformed triage.json.
function readLog (logFile, token) {
  let st
  try {
    st = fs.lstatSync(logFile)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (!st.isFile()) throw new Error('registro inválido')
  const parts = fs.readFileSync(logFile, 'utf8').split('\n')
  const tail = parts.pop()
  let torn = tail !== ''
  const marks = []
  for (let i = 0; i < parts.length; i++) {
    const got = parseLine(parts[i], i)
    if (got === null) {
      if (i === parts.length - 1 && i > 0 && !torn) {
        torn = true
        break
      }
      throw new Error('registro inválido')
    }
    if (i === 0) {
      if (got.log !== token) return null
    } else {
      marks.push(got)
    }
  }
  if (parts.length === 0) throw new Error('registro inválido')
  return { marks, torn }
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

function fsyncDir (dir) {
  let fd
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch (err) {
    if (!['EISDIR', 'EPERM', 'EINVAL'].includes(err.code)) throw err
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

// Same publish discipline as writeJsonAtomic, for the log's header line.
function writeTextAtomic (file, text) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp')
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  let published = false
  try {
    try {
      fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    published = true
  } finally {
    if (!published) {
      try { fs.unlinkSync(tmp) } catch {}
    }
  }
  fsyncDir(dir)
}

function appendLine (file, text) {
  const { O_WRONLY, O_APPEND, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_NOFOLLOW)
  try {
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function openLedger (dataDir, { now = Date.now, strict = false } = {}) {
  refuseSymlinkDir(dataDir)
  if (!strict) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dataDir, 0o700)
  }
  const file = path.join(dataDir, FILE)
  const logFile = path.join(dataDir, LOG_FILE)
  let state = null
  let logLines = 0
  let failed = false

  // Every snapshot write is a compaction under a NEW token: snapshot first,
  // then a fresh log naming that token. A crash between the two leaves the
  // old log, whose token no longer matches, so it is ignored at open instead
  // of being replayed over marks the snapshot already holds.
  function snapshot (next) {
    const token = crypto.randomBytes(8).toString('hex')
    writeJsonAtomic(file, { v: VERSION, log: token, reports: next.reports, reads: next.reads }, 0o600)
    // A missing log already reads as "nothing since the snapshot".
    if (strict && !exists(logFile)) return
    const header = JSON.stringify({ log: token }) + '\n'
    try {
      writeTextAtomic(logFile, header)
    } catch {
      // The snapshot already names the new token, so the old log can never
      // be appended to again: one more try before persist() gives up and the
      // ledger stops auto-deciding for the life of the process.
      writeTextAtomic(logFile, header)
    }
  }

  function load () {
    const snap = readState(file)
    let log
    try {
      log = snap.log === null ? null : readLog(logFile, snap.log)
    } catch (err) {
      err.file = LOG_FILE
      throw err
    }
    const reports = snap.reports
    if (log) {
      // One cap pass, not one per line: a sort of 20000 marks per line would
      // take minutes on a full log.
      for (const { id, entry } of log.marks) reports[id] = entry
      const last = log.marks.length ? log.marks[log.marks.length - 1].id : undefined
      capMap(reports, MAX_REPORT_MARKS, last)
    }
    return { state: { reports, reads: snap.reads }, lines: log ? log.marks.length : 0, rewrite: !log || log.torn }
  }

  let rewrite = false
  try {
    const got = load()
    state = got.state
    logLines = got.lines
    rewrite = got.rewrite
  } catch (err) {
    if (strict) throw Object.assign(fail('indisponivel'), { file: err.file || FILE })
    rewrite = true
    state = { reports: dict(), reads: dict() }
    if (err.code !== 'ENOENT') {
      // Derived data: set the bad files aside (kept for the operator) and
      // start over. A symlink or directory is renamed too, never followed.
      try {
        const ms = now()
        fs.renameSync(file, asideName(file, ms))
        if (exists(logFile)) fs.renameSync(logFile, asideName(logFile, ms))
      } catch {
        failed = true
      }
    }
  }
  if (rewrite && !failed && !strict) {
    try {
      snapshot(state)
      logLines = 0
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
      snapshot(next)
    } catch (err) {
      try {
        const got = load()
        if (got.rewrite) throw new Error('registro inválido')
        state = got.state
        logLines = got.lines
      } catch {
        failed = true
      }
      throw err
    }
    state = next
    logLines = 0
  }

  function get (id) {
    usable()
    if (!validId(id)) throw fail('pedido-invalido')
    return has(state.reports, id) ? { ...state.reports[id] } : null
  }

  // Merges `fields` (any of code, retryAt, attempts, exemplars, suggestion,
  // nearest) over the existing mark, or over the defaults for a first mark
  // (which must name a code), and stamps `at` with the clock. A mark that
  // changes nothing but `at` returns the stored row and writes nothing.
  function mark (id, fields) {
    usable()
    if (!validId(id) || !isPlainObject(fields)) throw fail('pedido-invalido')
    if (!Object.keys(fields).every((k) => k !== 'at' && MARK_KEYS.includes(k))) throw fail('pedido-invalido')
    const known = has(state.reports, id)
    const prev = known
      ? state.reports[id]
      : { code: '', retryAt: null, attempts: 0, exemplars: 0, suggestion: null, nearest: null }
    const entry = pickMark({ ...prev, ...fields, at: iso(now()) })
    if (!validMark(entry)) throw fail('pedido-invalido')
    if (known && MARK_KEYS.every((k) => k === 'at' || entry[k] === prev[k])) return { ...prev }
    try {
      appendLine(logFile, JSON.stringify({ id, ...entry }) + '\n')
    } catch (err) {
      // A partial line may sit at the end of the log: a snapshot of the
      // unchanged state replaces it, or the ledger stops auto-deciding.
      try {
        snapshot(state)
        logLines = 0
      } catch {
        failed = true
      }
      throw err
    }
    state.reports[id] = entry
    capMap(state.reports, MAX_REPORT_MARKS, id)
    logLines++
    if (logLines > MAX_LOG_LINES) {
      try {
        persist({ reports: dict(state.reports), reads: state.reads })
      } catch {}
    }
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
    if (!Object.keys(fields).every((k) => EDITED_READ_KEYS.includes(k))) throw fail('pedido-invalido')
    const row = { at: iso(now()), ...fields }
    if (!validRead(row)) throw fail('pedido-invalido')
    const entry = copyRead(row)
    const next = { reports: state.reports, reads: dict(state.reads) }
    next.reads[id] = entry
    capMap(next.reads, MAX_READS, id)
    persist(next)
    return copyRead(entry)
  }

  function dropRead (id) {
    usable()
    if (!validId(id)) throw fail('pedido-invalido')
    if (!has(state.reads, id)) return false
    const next = { reports: state.reports, reads: dict(state.reads) }
    delete next.reads[id]
    persist(next)
    return true
  }

  function readIds () {
    usable()
    return Object.keys(state.reads)
  }

  // Excluir conta: the reads of `target` (a deleted member's diary) and the
  // marks and reads of `ids` (the reports about it).
  function heldFor (target, ids) {
    if (!isLowerHex(target, 32) || !Array.isArray(ids)) throw fail('pedido-invalido')
    const set = new Set(ids.filter(validId))
    return {
      reports: Object.keys(state.reports).filter((id) => set.has(id)),
      reads: Object.keys(state.reads).filter((id) => set.has(id) || state.reads[id].target === target)
    }
  }

  function holdsTarget (target, ids) {
    usable()
    const h = heldFor(target, ids)
    return h.reports.length + h.reads.length > 0
  }

  // A snapshot write, which also starts a new marks log: a dropped mark
  // never comes back from triage-marks.jsonl. -> the number of rows dropped.
  function forgetTarget (target, ids) {
    usable()
    const h = heldFor(target, ids)
    const n = h.reports.length + h.reads.length
    if (n === 0) return 0
    const next = { reports: dict(state.reports), reads: dict(state.reads) }
    for (const id of h.reports) delete next.reports[id]
    for (const id of h.reads) delete next.reads[id]
    persist(next)
    return n
  }

  // Re-applies the caps (they already hold after every write) and folds the
  // marks log into the snapshot; writes only when something was dropped or
  // logged. Returns the number of entries dropped.
  function prune () {
    usable()
    const next = { reports: dict(state.reports), reads: dict(state.reads) }
    const n = capMap(next.reports, MAX_REPORT_MARKS) + capMap(next.reads, MAX_READS)
    if (n > 0 || logLines > 0) persist(next)
    return n
  }

  return { get, mark, read, putRead, dropRead, readIds, holdsTarget, forgetTarget, prune }
}

module.exports = {
  FILE,
  LOG_FILE,
  DIM,
  MAX_REPORT_MARKS,
  MAX_READS,
  openLedger
}
