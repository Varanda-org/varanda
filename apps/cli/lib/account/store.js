'use strict'

// The account service's directory: which Google subject is linked to which
// member diary, under which @username, with the v2 certificate and the
// username records the issuer signed. Three kinds of file, parsed only here
// (mode 0o600, data dir 0o700):
//
// - <dataDir>/directory.json, the snapshot { v, seq, journal, links, bySub,
//   byUsername, usedNames } (a file without `seq` is seq 0; `journal` only
//   in v 2), only ever replaced whole through writeJsonAtomic
//   (packages/core/lib/store.js: O_EXCL temp, fsync, rename, dir fsync).
// - <dataDir>/directory.journal.<id>, a journal (named so that no `*.log`
//   rotation pattern matches it): <id> is a random 16-byte hex id, its first
//   line the header { journal: <id> } and every later line one change since
//   the snapshot, { seq, op: 'link' | 'email' | 'rename', member, ... }
//   (link: the link record; email: the new e-mail; rename: username,
//   usernameRecord, usernameChangedAt and the `previous` name). Written
//   through one O_APPEND|O_NOFOLLOW fd (fchmod 0o600 at every open): each
//   change is ONE write followed by fsync, so a sign-up costs the same
//   whatever the directory size. The fsynced append is the commit point; the
//   in-memory state is changed in place only after it.
// - <dataDir>/directory.hwm, the high-water mark { seq, journal, links,
//   names }: the highest committed seq with the link and usedNames counts
//   at that mark, written (writeJsonAtomic) after every compaction and at
//   close, outside the snapshot+journal pair (see "Restore").
//
// Journal binding: up to COMPACT_EVERY changes live only in the journal, so
// a v 2 snapshot names its journal's id and opening (rw and readOnly)
// refuses a v 2 snapshot whose journal is missing, empty, has no header or
// carries another id: a deleted, rotated or truncated journal fails closed
// instead of letting a name or a Google account be issued twice. A v 1
// snapshot (complete, after a clean close) names no journal. Journal files
// the snapshot does not name are orphans, left by a crash between two steps
// below (each with nothing past the snapshot's seq) and removed by the next
// rw open after the snapshot was read, never the named one; an orphan with
// a line past the snapshot's seq is an acknowledged change no snapshot
// names, so the directory fails closed ('diretório de contas inválido'),
// unless the named journal holds the identical line at the same seq (a
// crash after retire() folded the late lines and before its unlink).
// Orphan removal is conservative: an orphan whose mtime is younger than
// ORPHAN_GRACE_MS (the lock's staleness plus one heartbeat) is kept, since
// a writer that has not noticed it lost the lock may still hold it (its
// heartbeat fences it within that time, and a later open removes the
// file); right before each unlink directory.json is read again (an id it
// names is skipped) and the fence is checked (a snapshot that changed under
// this store marks it unavailable instead of sweeping).
//
// Opening reads the snapshot, applies the named journal's lines with seq >
// snapshot.seq in order (a torn trailing line, a write cut short by a
// crash, is ignored), checks the orphans and re-reads the snapshot: a
// different v, seq or journal id means a compaction raced the read, retried
// up to OPEN_RETRIES times. A line that would break an invariant below, a
// link record that is not whole, or a gap in seq is a damaged directory,
// never a partial one.
//
// A journal file is never truncated or rewritten once another process may
// hold it. Starting a journal and every compaction (after COMPACT_EVERY
// lines, past COMPACT_BYTES, and at every rw open, which also drops a torn
// trailing line before any append) go the same way: a NEW file with a NEW
// id is created O_EXCL and fsynced with its header, the data dir fsynced,
// the snapshot rewritten as v 2 naming the new id at the current seq
// (writeJsonAtomic), and only then the previous journal file unlinked. A
// crash at any step leaves a directory that opens with every acknowledged
// change: before the snapshot rename the old snapshot and its journal are
// intact beside a header-only orphan; after it the new snapshot names the
// new journal and the old file is an orphan whose lines are all at or
// below the snapshot's seq. A rw open holds the service lock
// (.account-lock), so it is the only writer; readOnly opens never write.
//
// Writer guard: a writer that lost the lock without noticing yet (a stalled
// process whose lock went stale and was taken over) must not write beside
// the new one, and a journal changed behind the writer's back must not be
// written to. So before every append and every snapshot write the fd and
// the path are compared (fstat/lstat): same dev and ino, nlink > 0, the
// size this store expects, and directory.json still the file (dev, ino)
// this store last read or wrote. Every rw open fences unconditionally: it
// starts a fresh journal and publishes a snapshot naming it (a new
// directory.json inode; the previous journal is retired and unlinked) even
// when the journal it found is header-only and nothing is orphaned, so a
// stalled writer never shares the snapshot inode and the journal with the
// new one and trips its guard before any write; once the old journal is
// unlinked its fd points at an inode with nlink 0. Any difference marks
// the store unavailable (every mutation then answers 'indisponivel')
// without writing. After each append's fsync the same guard runs again
// (fd still the file at the path, nlink > 0, the expected size, the
// snapshot intact) before the line is adopted and acknowledged: a line
// that landed in an inode unlinked between the guard and the write is
// never acknowledged by this store. Lines the old writer still landed in
// the previous journal between the new writer's read and its unlink (it
// passed its guard before the rename) are folded into the new journal
// (retire()), never lost. serve() also calls fail() when the lock is lost.
// Remaining window, inherent without OS file locks: the guard and the
// write are separate syscalls, so a write that lands in the previous
// journal after the new writer's last fold is kept by the file (nlink 0,
// never read again) and refused to its client by the re-guard; the window
// is microseconds wide and opens only after a stall of at least the lock's
// staleness.
//
// Downgrade safety: a build that knows only `v: 1` must never open a
// snapshot whose journal holds more links or names. So the snapshot is
// `v: 2` from the journal's start on (every compaction keeps `v: 2`), and
// close() compacts, writes a complete `v: 1` snapshot without an id and
// unlinks the journal, which a previous build reads as before.
//
// Restore: the hwm's seq and counts only ever grow (writeHwm() runs under
// the fence and refuses to lower a stored mark). A rw open whose
// snapshot+journal end below it is a pair restored from an older backup,
// which would reissue the names and the Google accounts linked since:
// refused with 'diretório de contas restaurado de uma cópia antiga;
// confira o backup' (code RESTAURADO). A readOnly open reports it
// (`restored`) and still reads. A snapshot with `seq` is judged by seq; a
// snapshot WITHOUT `seq` was written by an older build (the documented
// rollback), whose seq restarts, so it is judged by the counts only: below
// the mark when it holds fewer links or fewer usedNames entries. Such a
// snapshot that passes continues the numbering from the mark's seq, so the
// roll forward keeps the mark monotone without the operator deleting it.
// The hwm advances at compaction and close time only, so changes made
// after the last of those and lost to a crash are not covered. An operator
// who deliberately restores an older copy acknowledges it by deleting
// directory.hwm (README).
//
// Failures: an append or header whose fsync fails (or that may have put
// bytes in the file before failing) marks the store unavailable and the
// error propagates; its line is never adopted (reopening reads what is on
// disk). An error raised before any byte reached the journal (opening it,
// a write that failed with nothing written) or a failed snapshot write
// (which may have renamed before its dir fsync failed) reloads the state
// from disk (a torn line truncated away, under the guard) before the error
// propagates, so a later mutation never builds on a change that was not
// published. A snapshot rename whose dir fsync failed is fsynced again
// before the next change is acknowledged (`snapDirSynced`). A directory
// that cannot be reloaded marks the store unavailable.
//
// Invariants: one sub <-> one member; a member holds one current @username;
// a name ever held by a member (`usedNames`) is never given to ANOTHER member
// (the same member may take it back), so an old record copied around can
// never be mistaken for someone else. The snapshot's indexes (bySub,
// byUsername, usedNames) must agree with its links at open (see indexes());
// applyEntry() keeps them in agreement for every replayed or new line.
//
// Pending link rows (Google transaction secrets: state, PKCE verifier) live in
// memory only and are never written to disk: at most `maxPending` (default
// MAX_PENDING) live rows, at most MAX_UNPROVEN_PER_MEMBER unproven ones per
// member and at most MAX_PER_SUB rows per Google subject (see start(),
// unproven() and putGoogle()). Error objects carry only a token in `code`
// (and `nextChangeAt` for 'troca-bloqueada'): no sub, e-mail or secret.
//
// Member cap (`maxMembers`, null = no cap): the number of linked members is
// counted on demand from `links` (never from `usedNames`, which never
// shrinks). While it is reached, start() and the new-link branch of finish()
// answer 'lista-de-espera'; renames, status, lookup, export, the moderation
// desk and a linked member's e-mail update never consult the cap, and
// lowering it below the current count removes nobody. A member who lost a
// passkey and links a NEW key with ANOTHER Google account counts as a new member, so it is
// refused too while the cap is reached. Nothing about a refused attempt is
// stored: start() creates no row and finish() deletes the row it refuses.
// isFull() lets the server's Google callback refuse (and dropPending() the
// row) before the Google code is exchanged, so no Google data is collected
// for a link that would be refused.
//
// Sign-up invites (strict single use): a link finished with an invite keeps
// its id as `link.invite` (absent for a link made without one, so those
// records stay byte-identical). finish() refuses an invite another link
// already holds ('convite-invalido'); applyEntry never does, so a journal an
// earlier build accepted always replays. Older builds keep the field: their
// validLink checks only the fields they need and fromJson / applyEntry copy
// the record whole ({ ...link }), as rename and e-mail lines do here.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const {
  isHex,
  isUsername,
  refuseSymlinkDir,
  createIssuedCert,
  createUsernameRecord
} = require('@varanda/core/lib/cert')

const FILE = 'directory.json'
const JOURNAL_PREFIX = 'directory.journal.'
const HWM = 'directory.hwm'
// v 1: a complete snapshot (no journal). v 2: the journal named by
// `journal` may hold more; a build that knows only v 1 refuses it.
const VERSION = 1
const VERSION_JOURNAL = 2
const JOURNAL_ID_BYTES = 16
const COMPACT_EVERY = 256
const COMPACT_BYTES = 1024 * 1024
const OPEN_RETRIES = 3
// How long an orphan journal is left alone after its last write: the
// service lock's staleness plus one heartbeat (LOCK_STALE_MS +
// LOCK_HEARTBEAT_MS in ./server.js, mirrored here so the store does not
// load the HTTP server; apps/cli/test/account-store.test.js checks they
// agree). A writer unaware that it lost the lock is fenced within it.
const ORPHAN_GRACE_MS = 30000 + 10000
const PENDING_TTL_MS = 600 * 1000
const MAX_PENDING = 1000
const MAX_UNPROVEN_PER_MEMBER = 3
const MAX_PER_SUB = 2
const COOLDOWN_MS = 7 * 24 * 3600 * 1000
// Names a member could use to pass for the association or its staff.
const RESERVED = new Set([
  'admin', 'associacao', 'association', 'ajuda', 'mod', 'moderacao',
  'root', 'seeder', 'semeador', 'suporte', 'support', 'varanda'
])

function fail (code, extra) {
  const err = new Error(code)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

function randomToken () {
  return crypto.randomBytes(32).toString('base64url')
}

function validName (username) {
  return isUsername(username) && !RESERVED.has(username)
}

function normalizeMember (member) {
  if (!isHex(member, 32)) throw new TypeError('member must be 64 hex characters')
  return member.toLowerCase()
}

// Null-prototype maps: a Google `sub` is arbitrary printable ASCII and could
// be '__proto__', which must stay an ordinary key.
function dict (src) {
  const out = Object.create(null)
  if (src !== null && typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) out[k] = v
  }
  return out
}

function invalid () {
  return new Error('diretório de contas inválido')
}

function restored () {
  const err = new Error('diretório de contas restaurado de uma cópia antiga; confira o backup')
  err.code = 'RESTAURADO'
  return err
}

function emptyState () {
  return { links: dict(), bySub: dict(), byUsername: dict(), usedNames: dict() }
}

function isJournalId (id) {
  return typeof id === 'string' && id.length === JOURNAL_ID_BYTES * 2 && /^[0-9a-f]+$/.test(id)
}

function journalPath (dataDir, id) {
  return path.join(dataDir, JOURNAL_PREFIX + id)
}

function isPlain (x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function isInvite (x) {
  return typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)
}

function isDate (x) {
  return typeof x === 'string' && Number.isFinite(Date.parse(x))
}

// linkStats' default bucket: the UTC day (YYYY-MM-DD) of an epoch ms.
function utcDay (ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

// A whole link record: status(), finish() and rename() read every one of
// these fields, so a record missing one is refused at open, not later.
function validLink (link) {
  return isPlain(link) && typeof link.sub === 'string' && isUsername(link.username) &&
    typeof link.email === 'string' && isDate(link.usernameChangedAt) && isDate(link.linkedAt) &&
    isPlain(link.cert) && isPlain(link.usernameRecord) &&
    (link.invite === undefined || isInvite(link.invite))
}

// Validates a snapshot (v 1 or v 2) -> the state; `seq` is read by snapshotSeq.
function fromJson (obj) {
  if (!isPlain(obj) || (obj.v !== VERSION && obj.v !== VERSION_JOURNAL)) throw invalid()
  if (obj.v === VERSION_JOURNAL && !isJournalId(obj.journal)) throw invalid()
  snapshotSeq(obj)
  if (obj.links !== undefined && !isPlain(obj.links)) throw invalid()
  const links = dict()
  for (const [member, link] of Object.entries(obj.links || {})) {
    if (!isLower(member) || !validLink(link)) throw invalid()
    links[member] = { ...link }
  }
  return { links, ...indexes(obj, links) }
}

// The derived indexes, checked against `links` (finish(), heldByOther() and
// applyEntry() rely on them for one sub <-> one member and for never giving
// a used name to another member): bySub maps exactly each link's sub to its
// member, byUsername exactly each link's current username to its member, and
// usedNames holds every current username -> member pair plus past names,
// each held by a linked member (links are never removed). Any disagreement
// (a damaged or hand-restored snapshot) fails closed; nothing is rebuilt.
function indexes (obj, links) {
  for (const key of ['bySub', 'byUsername', 'usedNames']) {
    if (obj[key] !== undefined && !isPlain(obj[key])) throw invalid()
  }
  const bySub = dict(obj.bySub)
  const byUsername = dict(obj.byUsername)
  const usedNames = dict(obj.usedNames)
  const members = Object.keys(links)
  if (Object.keys(bySub).length !== members.length || Object.keys(byUsername).length !== members.length) throw invalid()
  for (const member of members) {
    const { sub, username } = links[member]
    if (!has(bySub, sub) || bySub[sub] !== member) throw invalid()
    if (!has(byUsername, username) || byUsername[username] !== member) throw invalid()
    if (!has(usedNames, username) || usedNames[username] !== member) throw invalid()
  }
  for (const holder of Object.values(usedNames)) {
    if (typeof holder !== 'string' || !has(links, holder)) throw invalid()
  }
  return { bySub, byUsername, usedNames }
}

function snapshotSeq (obj) {
  if (obj.seq === undefined) return 0
  if (!Number.isSafeInteger(obj.seq) || obj.seq < 0) throw invalid()
  return obj.seq
}

function has (map, key) {
  return Object.prototype.hasOwnProperty.call(map, key)
}

// -> { state, seq, seqless, v, journal, stat } (v 0: no snapshot yet, an
// empty directory at seq 0; seqless: a file without `seq`, written by an
// older build; journal: the id a v 2 snapshot names, else null; stat: the
// file's { dev, ino }, null without a file).
function readSnapshot (file) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return { state: emptyState(), seq: 0, seqless: false, v: 0, journal: null, stat: null }
    throw err
  }
  if (!st.isFile()) throw invalid()
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
  const state = fromJson(obj)
  return {
    state,
    seq: snapshotSeq(obj),
    seqless: obj.seq === undefined,
    v: obj.v,
    journal: obj.v === VERSION_JOURNAL ? obj.journal : null,
    stat: { dev: st.dev, ino: st.ino }
  }
}

// The id directory.json names right now (null: v 1 or no file), read
// again before an orphan is unlinked. A file that cannot be read or parsed
// (never seen at open) throws.
function namedJournal (file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const obj = JSON.parse(text)
  if (!isPlain(obj)) throw invalid()
  return obj.v === VERSION_JOURNAL && isJournalId(obj.journal) ? obj.journal : null
}

// True when two snapshot reads are the same snapshot (a compaction or a
// clean close in between changes the seq, the v or the journal id).
function sameSnapshot (a, b) {
  return a.v === b.v && a.seq === b.seq && a.journal === b.journal
}

function noJournal () {
  return { exists: false, id: null, header: 0, lines: [], valid: 0, size: 0 }
}

// -> { exists, id, header, lines, valid, size }: the header's id and byte
// length (null and 0 without a complete header line), the change lines
// after it, the byte length the complete lines cover and the file size
// (larger than `valid` when the last line is torn).
function readJournal (journalFile) {
  let st
  try {
    st = fs.lstatSync(journalFile)
  } catch (err) {
    if (err.code === 'ENOENT') return noJournal()
    throw err
  }
  if (!st.isFile()) throw invalid()
  const buf = fs.readFileSync(journalFile)
  const valid = buf.lastIndexOf(0x0a) + 1
  let id = null
  let header = 0
  const lines = []
  if (valid > 0) {
    const texts = buf.toString('utf8', 0, valid - 1).split('\n')
    for (let i = 0; i < texts.length; i++) {
      let line
      try {
        line = JSON.parse(texts[i])
      } catch {
        throw invalid()
      }
      if (i === 0) {
        if (!isPlain(line) || Object.keys(line).length !== 1 || !isJournalId(line.journal)) throw invalid()
        id = line.journal
        header = Buffer.byteLength(texts[i]) + 1
        continue
      }
      if (!isPlain(line) || !Number.isSafeInteger(line.seq) || line.seq < 1) throw invalid()
      lines.push(line)
    }
  }
  return { exists: true, id, header, lines, valid, size: buf.length }
}

// The ids of every journal file in the data dir (names that are not
// `directory.journal.<id>` are not ours and are left alone).
function listJournals (dataDir) {
  let names
  try {
    names = fs.readdirSync(dataDir)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const ids = []
  for (const name of names) {
    if (!name.startsWith(JOURNAL_PREFIX)) continue
    const id = name.slice(JOURNAL_PREFIX.length)
    if (isJournalId(id)) ids.push(id)
  }
  return ids.sort()
}

// -> { seq, journal, links, names } or null without a file (a mark written
// without counts reads as 0 and 0). Anything else fails closed.
function readHwm (hwmFile) {
  let st
  try {
    st = fs.lstatSync(hwmFile)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (!st.isFile()) throw invalid()
  let obj
  try {
    obj = JSON.parse(fs.readFileSync(hwmFile, 'utf8'))
  } catch {
    throw invalid()
  }
  if (!isPlain(obj) || !isCount(obj.seq)) throw invalid()
  if (obj.journal !== null && !isJournalId(obj.journal)) throw invalid()
  for (const key of ['links', 'names']) {
    if (obj[key] !== undefined && !isCount(obj[key])) throw invalid()
  }
  return { seq: obj.seq, journal: obj.journal, links: obj.links || 0, names: obj.names || 0 }
}

function isCount (n) {
  return Number.isSafeInteger(n) && n >= 0
}

// True when the directory read ends below its high-water mark: by seq
// for a snapshot with `seq`; by the link and usedNames counts alone for a
// snapshot without it (an older build's, whose seq restarted).
function belowMark (loaded) {
  const { hwm } = loaded
  if (hwm === null) return false
  if (loaded.seqless) return loaded.links < hwm.links || loaded.names < hwm.names
  return loaded.seq < hwm.seq
}

// A v 2 snapshot needs its own journal (present, with a header carrying its
// id); a v 1 snapshot names none.
function checkBinding (snap, journal) {
  if (snap.v === VERSION_JOURNAL && (journal.id === null || journal.id !== snap.journal)) throw invalid()
}

function isLower (member) {
  return isHex(member, 32) && member === member.toLowerCase()
}

// True when `username` is held now, or was ever held, by another member.
function heldByOther (s, username, member) {
  return (has(s.byUsername, username) && s.byUsername[username] !== member) ||
    (has(s.usedNames, username) && s.usedNames[username] !== member)
}

// Applies one journal entry to `s` in place, or with `dry` only checks it.
// An entry that would link a sub or member twice, give a name held by
// another member, rename from a name the member does not hold, or carry a
// record that is not whole is refused before anything changes (usedNames
// only ever grows).
function applyEntry (s, e, dry = false) {
  if (!isPlain(e) || !isLower(e.member)) throw invalid()
  const member = e.member
  if (e.op === 'link') {
    const link = e.link
    if (!validLink(link)) throw invalid()
    if (has(s.links, member) || has(s.bySub, link.sub) || heldByOther(s, link.username, member)) throw invalid()
    if (dry) return
    s.links[member] = { ...link }
    s.bySub[link.sub] = member
    s.byUsername[link.username] = member
    s.usedNames[link.username] = member
  } else if (e.op === 'email') {
    if (!has(s.links, member) || typeof e.email !== 'string') throw invalid()
    if (dry) return
    s.links[member] = { ...s.links[member], email: e.email }
  } else if (e.op === 'rename') {
    if (!has(s.links, member)) throw invalid()
    const link = s.links[member]
    if (link.username !== e.previous || !isUsername(e.username) || !isDate(e.usernameChangedAt) ||
      !isPlain(e.usernameRecord) || heldByOther(s, e.username, member)) {
      throw invalid()
    }
    if (dry) return
    // The old name leaves byUsername but stays in usedNames for this member.
    if (s.byUsername[link.username] === member) delete s.byUsername[link.username]
    s.byUsername[e.username] = member
    s.usedNames[e.username] = member
    s.links[member] = { ...link, username: e.username, usernameRecord: e.usernameRecord, usernameChangedAt: e.usernameChangedAt }
  } else {
    throw invalid()
  }
}

// Snapshot plus the lines of the journal it names, and the orphans checked.
// A snapshot that changed while the journals were read (a compaction or a
// clean close ran in between), or a gap in the journal's seq, is read
// again; still inconsistent after OPEN_RETRIES retries: a damaged directory.
// -> { state, seq, seqless, links, names (the counts after the replay), v,
// id, header, lines (change lines on disk), exists, valid, size, snapStat,
// orphans (ids the snapshot does not name), hwm }
function readDirectory (dataDir) {
  const file = path.join(dataDir, FILE)
  for (let attempt = 0; attempt <= OPEN_RETRIES; attempt++) {
    const snap = readSnapshot(file)
    let journal
    let seq = snap.seq
    let gap = false
    const orphans = []
    try {
      journal = snap.journal === null ? noJournal() : readJournal(journalPath(dataDir, snap.journal))
      checkBinding(snap, journal)
      // The named journal's lines in canonical form, by seq, for the
      // orphan check below.
      const named = new Map()
      for (const line of journal.lines) {
        named.set(line.seq, JSON.stringify(line))
        if (line.seq <= snap.seq) continue
        if (line.seq !== seq + 1) {
          gap = true
          break
        }
        applyEntry(snap.state, line)
        seq = line.seq
      }
      // An orphan holds nothing past the snapshot's seq (a crash between
      // two steps of a journal start, a compaction or a close), except
      // lines the named journal holds identically at the same seq (a crash
      // after retire() folded them and before its unlink); any other line
      // past it was acknowledged by a writer no snapshot names: damaged.
      for (const id of listJournals(dataDir)) {
        if (id === snap.journal) continue
        const other = readJournal(journalPath(dataDir, id))
        if (!other.exists) continue
        for (const line of other.lines) {
          if (line.seq > snap.seq && named.get(line.seq) !== JSON.stringify(line)) throw invalid()
        }
        orphans.push(id)
      }
    } catch (err) {
      // A compaction that moved the journal (or a close that removed it)
      // during the read can hand back mixed files: read again when the
      // snapshot moved. A journal that fails under a stable snapshot is
      // damaged.
      if (!sameSnapshot(readSnapshot(file), snap) && attempt < OPEN_RETRIES) continue
      throw err
    }
    if (!gap && sameSnapshot(readSnapshot(file), snap)) {
      return {
        state: snap.state,
        seq,
        seqless: snap.seqless,
        links: Object.keys(snap.state.links).length,
        names: Object.keys(snap.state.usedNames).length,
        v: snap.v,
        id: journal.id,
        header: journal.header,
        lines: journal.lines.length,
        exists: journal.exists,
        valid: journal.valid,
        size: journal.size,
        snapStat: snap.stat,
        orphans,
        hwm: readHwm(path.join(dataDir, HWM))
      }
    }
  }
  throw invalid()
}

// Makes a just-created directory entry durable (as packages/core/lib/store.js
// does). Platforms that cannot fsync a directory fail with EISDIR, EPERM or
// EINVAL: only those are ignored.
const FSYNC_DIR_IGNORED = new Set(['EISDIR', 'EPERM', 'EINVAL'])

function fsyncDir (dir) {
  let fd
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch (err) {
    if (!FSYNC_DIR_IGNORED.has(err.code)) throw err
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

// readOnly: for `account status` / `account export` / `account reports`,
// also while the service runs — reads the snapshot and the journal but
// never writes, truncates, mkdirs or chmods (works on a read-only volume
// and never changes permissions); every disk mutation answers
// 'indisponivel'. A rw store holds the service lock and must be the only one.
// maxMembers: null (no cap) or the number of linked members past which new
// links answer 'lista-de-espera'. maxPending: the live pending-row ceiling.
// onUnavailable: called once, synchronously, the first time a rw store marks
// itself unavailable after it opened (a writer guard trip, a failed fsync or
// a failed reload), so serve() can stop and let the restart re-read the
// disk; never for fail() (the caller already knows) nor for a readOnly store.
// The store's `restored` is true when the directory ends below its hwm (a
// rw open throws RESTAURADO instead).
function openAccountStore (dataDir, { now = Date.now, readOnly = false, maxMembers = null, maxPending = MAX_PENDING, onUnavailable = null } = {}) {
  refuseSymlinkDir(dataDir)
  if (!readOnly) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dataDir, 0o700)
  }
  const file = path.join(dataDir, FILE)
  const hwmFile = path.join(dataDir, HWM)
  const pending = new Map()
  const subMacKey = crypto.randomBytes(32)
  let failed = readOnly
  let closed = false
  // onUnavailable fires only once the open finished (the open's own
  // compaction may fail and retry, or throw to the caller) and at most once.
  let opened = false
  let notified = false
  let tail = Promise.resolve()
  let fd = null
  // False between a snapshot rename and the data dir fsync that made it
  // durable: no change is acknowledged while it is false.
  let snapDirSynced = true
  // journalId: the id the snapshot names (null: none); headerBytes: its
  // header's length; journalBytes: the size the journal must have (null: no
  // journal); journalLines: the change lines after the header; snapStat:
  // directory.json's { dev, ino } as last read or written (null: no file);
  // orphans: journal ids the snapshot does not name, as read at open.
  let state, seq, snapV, journalId, headerBytes, journalBytes, journalLines, snapStat, orphans
  // The invites state.links holds, rebuilt on demand: null after any change
  // to state (adopt() and every applyEntry that writes).
  let invites = null
  const loaded = readDirectory(dataDir)
  adopt(loaded)
  const isRestored = belowMark(loaded)
  if (isRestored && !readOnly) throw restored()
  if (!readOnly) {
    try {
      openCompact()
    } catch (err) {
      dropFd()
      throw err
    }
  }
  opened = true

  // One in-process queue for every disk mutation, so two finishes (or a
  // finish and a rename) never read the same state and both write.
  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function iso (ms) {
    return new Date(ms).toISOString()
  }

  function nextChangeAt (link) {
    return iso(Date.parse(link.usernameChangedAt) + COOLDOWN_MS)
  }

  function sweep () {
    const t = now()
    for (const [id, row] of pending) {
      if (row.expiresAt <= t) pending.delete(id)
    }
  }

  function liveRow (id) {
    if (typeof id !== 'string') return null
    const row = pending.get(id)
    if (row === undefined) return null
    if (row.expiresAt <= now()) {
      pending.delete(id)
      return null
    }
    return row
  }

  // True when `username` is taken for `member`: currently held or ever used
  // by another member, or held by another member's live Google-claimed row.
  // A row holds its name only once Google answered (it has `sub`): a key
  // proof alone costs nothing (keys are free), so a key-proven row holds
  // nothing and finish() re-checks the name anyway. Two claimed rows may
  // name the same username (both started before either reached Google):
  // the FIRST to claim holds it (putGoogle moves the row to the end of the
  // table, so claimed rows sit in claim order), the other's finish answers
  // 'nome-em-uso', and neither blocks the other.
  function nameTaken (s, username, member) {
    if (heldByOther(s, username, member)) return true
    sweep()
    for (const row of pending.values()) {
      if (!claimed(row) || row.username !== username) continue
      return row.member !== member
    }
    return false
  }

  // An fd for a journal the disk no longer names is dropped (the file is
  // retired or gone); journalFd() reopens the named one by its path. A
  // snapshot without `seq` (an older build's) continues the numbering from
  // the mark, so the mark never has to go backwards after a roll forward.
  function adopt (loaded) {
    if (fd !== null && loaded.id !== journalId) dropFd()
    state = loaded.state
    invites = null
    seq = loaded.seqless && loaded.hwm !== null ? Math.max(loaded.seq, loaded.hwm.seq) : loaded.seq
    snapV = loaded.v
    journalId = loaded.id
    headerBytes = loaded.header
    journalBytes = loaded.exists ? loaded.size : null
    journalLines = loaded.lines
    snapStat = loaded.snapStat
    orphans = loaded.orphans
  }

  function dropFd () {
    if (fd === null) return
    try { fs.closeSync(fd) } catch {}
    fd = null
  }

  // Every rw open fences: with a journal on disk it compacts (the change
  // lines, and a torn trailing line, folded into the snapshot through a
  // new journal file, so every append starts on a line boundary), and
  // without one (v 1 or no snapshot) it starts the journal; either way a
  // fresh journal is created and a snapshot naming it published, so a
  // stalled writer that still holds the previous files (also a header-only
  // journal under an unchanged snapshot) trips its guard before any write.
  // Then the orphans are removed. A guard trip (the files changed since the
  // read: a stalled writer that has not noticed it lost the lock) reads the
  // directory again, up to OPEN_RETRIES times.
  function openCompact () {
    for (let attempt = 0; ; attempt++) {
      try {
        if (journalBytes !== null) compact()
        else beginJournal()
        sweepOrphans()
        return
      } catch (err) {
        if (err.code !== 'indisponivel' || attempt >= OPEN_RETRIES) throw err
        failed = false
        dropFd()
        adopt(readDirectory(dataDir))
      }
    }
  }

  // Removes the orphans read at open (never the named journal), only after
  // this store's own snapshot write, so a stalled writer that created one
  // of them trips its guard before naming it. Conservative: an orphan
  // written within ORPHAN_GRACE_MS is left for a later open (a writer that
  // has not noticed it lost the lock may still hold it), and right before
  // each unlink directory.json is read again (an id it names is skipped)
  // and the fence checked (a snapshot that changed under this store marks
  // it unavailable and stops the sweep; the open then reads again).
  function sweepOrphans () {
    const cutoff = Date.now() - ORPHAN_GRACE_MS
    for (const id of orphans) {
      if (id === journalId) continue
      const p = journalPath(dataDir, id)
      let st
      try {
        st = fs.lstatSync(p)
      } catch {
        continue
      }
      if (!st.isFile() || st.mtimeMs > cutoff) continue
      fence()
      let named
      try {
        named = namedJournal(file)
      } catch {
        unavailable()
        throw fail('indisponivel')
      }
      if (named === id) continue
      try { fs.unlinkSync(p) } catch {}
    }
    orphans = []
  }

  // The named journal's O_APPEND fd, opened on first use; only a rw store
  // gets here. Every open fchmods it to 0o600, also a journal that already
  // existed. Its directory entry is durable (the snapshot naming it was
  // published after it), so no dir fsync is owed here.
  function journalFd () {
    if (fd !== null) return fd
    if (journalId === null) throw invalid()
    const { O_WRONLY, O_APPEND, O_NOFOLLOW } = fs.constants
    const next = fs.openSync(journalPath(dataDir, journalId), O_WRONLY | O_APPEND | O_NOFOLLOW)
    try {
      if (!fs.fstatSync(next).isFile()) throw invalid()
      fs.fchmodSync(next, 0o600)
    } catch (err) {
      try { fs.closeSync(next) } catch {}
      throw err
    }
    fd = next
    return fd
  }

  // A new journal file nothing names yet: a fresh random id, created
  // O_EXCL|O_NOFOLLOW 0o600, its header written and fsynced, the data dir
  // fsynced. -> { id, fd, header }. On any failure the file is removed.
  function createJournal () {
    const id = crypto.randomBytes(JOURNAL_ID_BYTES).toString('hex')
    const p = journalPath(dataDir, id)
    const buf = Buffer.from(JSON.stringify({ journal: id }) + '\n')
    const { O_WRONLY, O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
    const f = fs.openSync(p, O_WRONLY | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    try {
      fs.fchmodSync(f, 0o600)
      let off = 0
      while (off < buf.length) off += fs.writeSync(f, buf, off, buf.length - off)
      fs.fsyncSync(f)
      fsyncDir(dataDir)
    } catch (err) {
      discard(f, p)
      throw err
    }
    return { id, fd: f, header: buf.length }
  }

  function discard (f, p) {
    try { fs.closeSync(f) } catch {}
    try { fs.unlinkSync(p) } catch {}
  }

  // After a snapshot write naming `next` failed (resync() ran): when the
  // rename landed the disk names `next`, which is kept as the journal;
  // otherwise the file nothing names is removed (kept, unlinked by the next
  // rw open, when the reload failed and the disk is unknown).
  function keepOrDiscard (next) {
    if (journalId === next.id) {
      dropFd()
      fd = next.fd
      return
    }
    try { fs.closeSync(next.fd) } catch {}
    if (!failed) {
      try { fs.unlinkSync(journalPath(dataDir, next.id)) } catch {}
    }
  }

  // `next` becomes the journal: the previous fd is closed.
  function install (next) {
    dropFd()
    fd = next.fd
    journalId = next.id
    headerBytes = next.header
    journalBytes = next.header
    journalLines = 0
  }

  // True when `f` is still the file at the named journal's path (same dev
  // and ino, not unlinked).
  function sameFile (f) {
    if (journalId === null) return false
    try {
      const a = fs.fstatSync(f)
      const b = fs.lstatSync(journalPath(dataDir, journalId))
      return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.nlink > 0
    } catch {
      return false
    }
  }

  // True when directory.json is still the file this store last read or
  // wrote (none both times, or the same dev and ino): another writer's
  // first snapshot rename is what fences this one.
  function snapshotIntact () {
    try {
      const st = fs.lstatSync(file)
      return snapStat !== null && st.isFile() && st.dev === snapStat.dev && st.ino === snapStat.ino
    } catch (err) {
      return err.code === 'ENOENT' && snapStat === null
    }
  }

  function fence () {
    if (snapshotIntact()) return
    unavailable()
    throw fail('indisponivel')
  }

  // The writer guard, before every journal write: the fd, still the file at
  // the path, with exactly the size this store expects, under the snapshot
  // this store knows. Anything else (the journal deleted, replaced,
  // truncated or appended to by someone else, or a snapshot another writer
  // published) marks the store unavailable and nothing is written. An error
  // opening the fd (nothing written yet) reloads the files first.
  function writable () {
    let f
    try {
      f = journalFd()
    } catch (err) {
      resync()
      throw err
    }
    if (!intact(f, journalBytes)) {
      unavailable()
      throw fail('indisponivel')
    }
    return f
  }

  // True when `f` is still the file at the path, both have `size` bytes
  // and the snapshot is unchanged.
  function intact (f, size) {
    try {
      return sameFile(f) && fs.fstatSync(f).size === size &&
        fs.lstatSync(journalPath(dataDir, journalId)).size === size && snapshotIntact()
    } catch {
      return false
    }
  }

  // Appends `buf` and fsyncs it. A write that failed with nothing written
  // reloads the files; once bytes may be in the file, or when the fsync
  // fails, the store is unavailable and the line is never adopted. After
  // the fsync the guard runs again: a line that landed in a file unlinked
  // or replaced between the guard and the write, or under a snapshot
  // another writer published meanwhile, is not acknowledged either.
  function append (buf) {
    const f = writable()
    let off = 0
    try {
      while (off < buf.length) off += fs.writeSync(f, buf, off, buf.length - off)
    } catch (err) {
      if (off === 0) resync()
      else unavailable()
      throw err
    }
    try {
      fs.fsyncSync(f)
    } catch (err) {
      unavailable()
      throw err
    }
    if (!intact(f, journalBytes + buf.length)) {
      unavailable()
      throw fail('indisponivel')
    }
    journalBytes += buf.length
  }

  function snapshot (v, id) {
    const out = { v, seq }
    if (v === VERSION_JOURNAL) out.journal = id
    return Object.assign(out, { links: state.links, bySub: state.bySub, byUsername: state.byUsername, usedNames: state.usedNames })
  }

  // Replaces the snapshot (v 2 naming `id`, or v 1) under the fence. A
  // failed write may have renamed before its dir fsync failed: the files
  // are reloaded (its content is the in-memory state either way) and
  // `snapDirSynced` stays false until the dir is fsynced again.
  function writeSnapshot (v, id) {
    fence()
    snapDirSynced = false
    try {
      writeJsonAtomic(file, snapshot(v, id), 0o600)
    } catch (err) {
      resync()
      throw err
    }
    snapDirSynced = true
    snapV = v
    let st
    try {
      st = fs.lstatSync(file)
    } catch (err) {
      unavailable()
      throw err
    }
    snapStat = { dev: st.dev, ino: st.ino }
  }

  // The dir fsync after the last snapshot rename failed: done again before
  // the next change is acknowledged, so a crash cannot lose the rename.
  function settleSnapshot () {
    if (snapDirSynced) return
    try {
      fsyncDir(dataDir)
    } catch (err) {
      resync()
      throw err
    }
    snapDirSynced = true
  }

  // The mark, under the fence and monotone: a stored mark above the new
  // one (in seq or in either count) is never lowered; the store is marked
  // unavailable instead (a stale writer, or files changed behind it).
  function writeHwm () {
    fence()
    const mark = { seq, journal: journalId, links: linkCount(), names: Object.keys(state.usedNames).length }
    let current
    try {
      current = readHwm(hwmFile)
    } catch (err) {
      unavailable()
      throw err
    }
    if (current !== null && (mark.seq < current.seq || mark.links < current.links || mark.names < current.names)) {
      unavailable()
      throw fail('indisponivel')
    }
    writeJsonAtomic(hwmFile, mark, 0o600)
  }

  // At a rw open on a v 1 snapshot (or none), and before a change line
  // when the disk went back to v 1 under a reload: a new journal (header
  // fsynced), then the snapshot rewritten as v 2 naming it.
  function beginJournal () {
    const next = createJournal()
    try {
      writeSnapshot(VERSION_JOURNAL, next.id)
    } catch (err) {
      keepOrDiscard(next)
      throw err
    }
    install(next)
  }

  // Folds the journal into the snapshot: a new journal (header fsynced),
  // the snapshot rewritten (v 2, naming it, at the current seq), the
  // previous journal retired, the hwm advanced. The guard runs first, so a
  // journal or snapshot changed behind this store is never folded.
  function compact () {
    writable()
    const prev = { id: journalId, size: journalBytes }
    const next = createJournal()
    try {
      writeSnapshot(VERSION_JOURNAL, next.id)
    } catch (err) {
      keepOrDiscard(next)
      throw err
    }
    install(next)
    retire(prev)
    writeHwm()
  }

  // Unlinks the previous journal once the snapshot names the new one. Lines
  // a stalled writer appended to it since this store read it (its guard
  // passed before the snapshot moved) are folded into the new journal
  // before the unlink and, through the read fd kept open across it, right
  // after (nothing can land there once its nlink is 0 and its guard fails).
  // A line that cannot be folded marks the store unavailable.
  function retire (prev) {
    const p = journalPath(dataDir, prev.id)
    const { O_RDONLY, O_NOFOLLOW } = fs.constants
    let r
    try {
      r = fs.openSync(p, O_RDONLY | O_NOFOLLOW)
    } catch (err) {
      unavailable()
      throw err
    }
    try {
      const folded = fold(r, prev.size)
      fs.unlinkSync(p)
      fold(r, folded)
    } catch (err) {
      unavailable()
      throw err
    } finally {
      try { fs.closeSync(r) } catch {}
    }
  }

  // Appends every complete line of the retired journal past `from` to the
  // new journal as the next change, validated like a replayed line (seq
  // must follow); a torn tail (a write cut short) is ignored. -> the offset
  // folded up to.
  function fold (r, from) {
    const size = fs.fstatSync(r).size
    if (size <= from) return from
    const buf = Buffer.alloc(size - from)
    let off = 0
    while (off < buf.length) {
      const n = fs.readSync(r, buf, off, buf.length - off, from + off)
      if (n === 0) break
      off += n
    }
    const valid = off === 0 ? 0 : buf.lastIndexOf(0x0a, off - 1) + 1
    if (valid === 0) return from
    for (const text of buf.toString('utf8', 0, valid - 1).split('\n')) {
      let line
      try {
        line = JSON.parse(text)
      } catch {
        throw invalid()
      }
      if (!isPlain(line) || line.seq !== seq + 1) throw invalid()
      applyEntry(state, line, true)
      append(Buffer.from(JSON.stringify(line) + '\n'))
      applyEntry(state, line)
      invites = null
      seq = line.seq
      journalLines++
    }
    return from + valid
  }

  // The one disk write of a change: one appended line, fsynced; `state` is
  // changed in place only after it. A compaction that is due (or the
  // journal's start) runs first, so its failure fails this change before it
  // is committed.
  function commit (entry) {
    applyEntry(state, entry, true)
    if (snapV !== VERSION_JOURNAL) beginJournal()
    else if (journalLines >= COMPACT_EVERY || journalBytes > COMPACT_BYTES) compact()
    settleSnapshot()
    const line = { seq: seq + 1, ...entry }
    append(Buffer.from(JSON.stringify(line) + '\n'))
    applyEntry(state, line)
    invites = null
    seq = line.seq
    journalLines++
  }

  function usedInvites () {
    if (invites === null) {
      invites = new Set()
      for (const link of Object.values(state.links)) {
        if (link.invite !== undefined) invites.add(link.invite)
      }
    }
    return invites
  }

  // After an error raised before any byte reached the journal, or a failed
  // snapshot write (renamed or not): reload the files with the open-time
  // validation and drop a torn trailing line (this store's own cut-short
  // write, under the guard), so the next append starts on a line boundary.
  // A journal fd that is no longer the file at the path, or an unreadable
  // or malformed directory, keeps the old copy and marks the store
  // unavailable, so no later mutation builds on contents that are unknown.
  function resync () {
    try {
      const loaded = readDirectory(dataDir)
      if (fd !== null && loaded.id === journalId && !sameFile(fd)) throw invalid()
      adopt(loaded)
      if (loaded.valid < loaded.size) {
        const f = journalFd()
        if (!intact(f, loaded.size)) throw invalid()
        fs.ftruncateSync(f, loaded.valid)
        fs.fsyncSync(f)
        journalBytes = loaded.valid
      }
    } catch {
      unavailable()
    }
  }

  // Marks the store unavailable after a failure of its own and tells
  // onUnavailable the first time (a callback that throws changes nothing:
  // the failure that got here is what propagates).
  function unavailable () {
    if (failed) return
    failed = true
    if (!opened || notified || typeof onUnavailable !== 'function') return
    notified = true
    try { onUnavailable() } catch {}
  }

  // Marks the store unavailable at once (serve() calls it when the service
  // lock is lost): every later mutation answers 'indisponivel'. onUnavailable
  // is not called: the caller is already stopping.
  function markFailed () {
    failed = true
  }

  function mutable () {
    if (failed || closed) throw fail('indisponivel')
  }

  function linkCount () {
    return Object.keys(state.links).length
  }

  function full () {
    return maxMembers !== null && linkCount() >= maxMembers
  }

  // A row is unproven until putGoogle() (Google answered: it has `sub`). A
  // member signature (reserve()) does not count: member keys are free to
  // generate, so a key-proven row is as cheap for an attacker as a bare
  // start, while a Google answer costs an account that putGoogle() caps at
  // MAX_PER_SUB rows. Only unproven rows are ever evicted for room (oldest
  // first): a Google-claimed row lives out its TTL, and a table full of
  // claimed rows refuses with 'lotado'. An app row Google answered
  // (markAnswered) is not unproven either: its sub waits in the server for R,
  // but the answer cost a Google account all the same.
  function unproven (row) {
    return !claimed(row) && !Object.hasOwn(row, 'answeredBy')
  }

  function claimed (row) {
    return Object.hasOwn(row, 'sub')
  }

  // A bare row only went through start(): no key proof yet. Member keys are
  // public, so the per-member cap (which anyone can trigger by naming a key)
  // only ever evicts bare rows: a row the member signed (reserve) survives
  // until Google answers or its TTL ends, unless a flood fills the table.
  function bare (row) {
    return row.phase === 'reserve' && unproven(row)
  }

  // Drops the oldest pending row for which `match(row)` is true.
  function evictOldest (match) {
    for (const [id, row] of pending) {
      if (match(row)) {
        pending.delete(id)
        return true
      }
    }
    return false
  }

  function start ({ member, username, invite = null } = {}) {
    member = normalizeMember(member)
    if (invite !== null && !isInvite(invite)) throw new TypeError('invite must be 64 lowercase hex characters')
    if (!validName(username)) throw fail('nome-invalido')
    if (has(state.links, member)) throw fail('conta-vinculada')
    // Sweep before the cap check: while the cap is full this is the only
    // call that keeps expiring rows abandoned before it filled.
    sweep()
    if (full()) throw fail('lista-de-espera')
    if (nameTaken(state, username, member)) throw fail('nome-em-uso')
    let own = 0
    for (const row of pending.values()) {
      if (row.member === member && bare(row)) own++
    }
    if (own >= MAX_UNPROVEN_PER_MEMBER) evictOldest((row) => row.member === member && bare(row))
    // Table full (only a flood gets here): the oldest row without a Google
    // answer goes, bare or signed, so new logins outlive abandoned ones;
    // claimed rows are never evicted.
    if (pending.size >= maxPending && !evictOldest(unproven)) throw fail('lotado')
    const row = {
      id: randomToken(),
      member,
      username,
      nonce: randomToken(),
      state: randomToken(),
      verifier: randomToken(),
      phase: 'reserve',
      // Memory only, like the row: the account server (server.js) holds the
      // reservation and consumes the invite in invites-store.js; finish()
      // keeps it on the link (strict single use, see the header).
      invite,
      expiresAt: now() + PENDING_TTL_MS
    }
    pending.set(row.id, row)
    return { ...row }
  }

  // The member proved its key: the next signature it gives is the 'finish'
  // one. The name is checked again here but not held yet (see nameTaken).
  function reserve (id) {
    const row = liveRow(id)
    if (row === null) throw fail('expirado')
    if (nameTaken(state, row.username, row.member)) throw fail('nome-em-uso')
    row.reserved = true
    row.phase = 'finish'
    return { ...row }
  }

  // Google answered: from here the row holds its name (if no earlier claim
  // does) and is never evicted for room. One Google account may claim at
  // most MAX_PER_SUB live rows (a double click, two tabs); a further claim
  // replaces its oldest row. The row moves to the end of the table so that
  // claimed rows are ordered by claim (see nameTaken).
  function putGoogle (id, { sub, email } = {}) {
    const row = liveRow(id)
    if (row === null) throw fail('expirado')
    sweep()
    capSub(id, sub)
    pending.delete(id)
    delete row.answeredBy
    row.sub = sub
    row.email = email
    pending.set(id, row)
    return { ...row }
  }

  // The row's own subject, kept only as a keyed hash so an answered row
  // never carries the sub itself; the key lives and dies with the process,
  // like the pending table.
  function subKey (sub) {
    return crypto.createHmac('sha256', subMacKey).update(String(sub)).digest('base64url')
  }

  // Answered and claimed rows of one Google subject share the MAX_PER_SUB
  // cap: drops the oldest others until a slot is free. -> the dropped ids.
  function capSub (id, sub) {
    const key = subKey(sub)
    const same = []
    for (const [otherId, other] of pending) {
      if (otherId !== id && (other.sub === sub || other.answeredBy === key)) same.push(otherId)
    }
    const dropped = []
    while (same.length >= MAX_PER_SUB) {
      const otherId = same.shift()
      pending.delete(otherId)
      dropped.push(otherId)
    }
    return dropped
  }

  // An app row Google answered before R is redeemed: it no longer counts as
  // unproven for eviction and holds no name. It carries only a keyed hash of
  // the sub (the server binds the sub with putGoogle once R is redeemed,
  // which drops the hash), and counts toward that subject's MAX_PER_SUB.
  // -> the ids it evicted for the cap, or null when the row is gone.
  function markAnswered (id, sub) {
    if (typeof sub !== 'string' || sub.length === 0) throw new TypeError('sub must be a non-empty string')
    const row = liveRow(id)
    if (row === null) return null
    sweep()
    const dropped = capSub(id, sub)
    row.answeredBy = subKey(sub)
    return dropped
  }

  function get (id) {
    const row = liveRow(id)
    return row === null ? null : { ...row }
  }

  // Read-only: true while the member cap is reached (false without a cap).
  function isFull () {
    return full()
  }

  // Read-only: true when a link already holds this invite.
  function inviteUsed (id) {
    if (!isInvite(id)) throw new TypeError('invite must be 64 lowercase hex characters')
    return usedInvites().has(id)
  }

  // Deletes a pending row (a callback refused while the cap is full).
  function dropPending (id) {
    pending.delete(id)
    sweep()
  }

  function linkResult (link) {
    return { cert: link.cert, usernameRecord: link.usernameRecord, nextChangeAt: nextChangeAt(link) }
  }

  // -> { cert, usernameRecord, nextChangeAt }, resolved only after the
  // directory is on disk. The row is deleted after success, so a repeated
  // finish answers 'expirado' (the client recovers through status()).
  function finish (id, { signature } = {}, issuerKeyPair, issuerCert, association) {
    return enqueue(() => {
      mutable()
      const row = liveRow(id)
      if (row === null || typeof row.sub !== 'string') throw fail('expirado')
      if (issuerCert === null || typeof issuerCert !== 'object' || issuerCert.association !== association) {
        throw new TypeError('issuer certificate is for another association')
      }
      const { member, username, sub, email } = row

      if (has(state.bySub, sub) && state.bySub[sub] === member) {
        const link = state.links[member]
        if (link.email !== email) commit({ op: 'email', member, email })
        pending.delete(id)
        return linkResult(state.links[member])
      }
      if (has(state.bySub, sub) || has(state.links, member)) throw fail('conta-vinculada')
      // The cap filled while this row was at Google: drop the row (it holds
      // the sub, the e-mail and claims the name) and sign nothing.
      if (full()) {
        pending.delete(id)
        sweep()
        throw fail('lista-de-espera')
      }
      // Another link took this invite while the row was at Google: dropped
      // the same way.
      if (row.invite !== null && usedInvites().has(row.invite)) {
        pending.delete(id)
        sweep()
        throw fail('convite-invalido')
      }
      if (!validName(username)) throw fail('nome-invalido')
      if (nameTaken(state, username, member)) throw fail('nome-em-uso')

      const date = iso(now())
      const cert = createIssuedCert({ member, date }, issuerKeyPair, issuerCert)
      const usernameRecord = createUsernameRecord({ member, username, date }, issuerKeyPair, issuerCert)
      const link = {
        sub,
        email,
        username,
        usernameRecord,
        usernameChangedAt: date,
        linkedAt: date,
        nonce: row.nonce,
        signature,
        cert
      }
      if (row.invite !== null) link.invite = row.invite
      commit({ op: 'link', member, link })
      pending.delete(id)
      return linkResult(state.links[member])
    })
  }

  // -> { record, nextChangeAt }. Same name: the current record, unchanged.
  function rename (member, username, issuerKeyPair, issuerCert) {
    return enqueue(() => {
      mutable()
      member = normalizeMember(member)
      if (!has(state.links, member)) throw fail('nao-encontrado')
      if (!validName(username)) throw fail('nome-invalido')
      const link = state.links[member]
      if (link.username === username) return { record: link.usernameRecord, nextChangeAt: nextChangeAt(link) }
      const t = now()
      if (t < Date.parse(link.usernameChangedAt) + COOLDOWN_MS) {
        throw fail('troca-bloqueada', { nextChangeAt: nextChangeAt(link) })
      }
      if (nameTaken(state, username, member)) throw fail('nome-em-uso')

      const date = iso(t)
      const record = createUsernameRecord({ member, username, date }, issuerKeyPair, issuerCert)
      // The old name leaves byUsername but stays in usedNames (applyEntry).
      commit({ op: 'rename', member, username, usernameRecord: record, usernameChangedAt: date, previous: link.username })
      return { record, nextChangeAt: nextChangeAt(state.links[member]) }
    })
  }

  function status (member) {
    if (!isHex(member, 32)) return { linked: false }
    const link = state.links[member.toLowerCase()]
    if (link === undefined) return { linked: false }
    return {
      linked: true,
      username: link.username,
      cert: link.cert,
      usernameRecord: link.usernameRecord,
      nextChangeAt: nextChangeAt(link)
    }
  }

  // Current holder only: a released name answers null.
  function lookup (username) {
    if (typeof username !== 'string' || !has(state.byUsername, username)) return null
    const member = state.byUsername[username]
    return { member, usernameRecord: state.links[member].usernameRecord }
  }

  // For the operator (LGPD access requests): no signature, cert or secret.
  function exportLinks () {
    return Object.keys(state.links).map((member) => {
      const { sub, email, username, linkedAt } = state.links[member]
      return { member, sub, email, username, linkedAt }
    })
  }

  // For the moderation panel's stats tab (apps/cli/lib/account/usage-stats.js):
  // counts only -> { members, maxMembers, byDay }. members is exact because a
  // link is never removed (applyEntry knows only link, email and rename);
  // maxMembers is the cap or null. byDay is [day, count] pairs, ascending, with
  // day = dayOf(ms of linkedAt) (UTC by default; the caller passes its own,
  // e.g. the Brasília day). linkedAt is the `date` finish() puts in the
  // member's public certificate, so a day count discloses nothing a peer
  // cannot read in block 0. No key, sub, e-mail, username, cert or finer time
  // leaves here, and exportLinks is not called. In-memory state only, O(N),
  // so a readOnly or failed store answers too.
  function linkStats (dayOf = utcDay) {
    const counts = new Map()
    for (const member of Object.keys(state.links)) {
      const ms = Date.parse(state.links[member].linkedAt)
      // validLink refuses such a record at open and in applyEntry; skipped
      // rather than thrown so a stats read never takes the panel down.
      if (!Number.isFinite(ms)) continue
      const day = dayOf(ms)
      counts.set(day, (counts.get(day) || 0) + 1)
    }
    const byDay = [...counts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return { members: linkCount(), maxMembers, byDay }
  }

  // For the moderation desk (apps/cli/lib/account/mod-routes.js and
  // `account reports`): the contact of a linked member, or null. Never part
  // of a public answer (status() and lookup() stay without e-mail and sub);
  // the panel shows only the username.
  function contact (member) {
    if (!isHex(member, 32)) return null
    const key = member.toLowerCase()
    if (!has(state.links, key)) return null
    const { email, sub, username } = state.links[key]
    return { email, sub, username }
  }

  // The member a Google subject is linked to, or null (a moderator never
  // sees the reports about their own linked diary).
  function memberForSub (sub) {
    if (typeof sub !== 'string' || !has(state.bySub, sub)) return null
    return state.bySub[sub]
  }

  // Clean close (after the last change, in the queue): when this run wrote
  // a v 2 snapshot, the journal is compacted (v 2, a header-only journal),
  // the hwm advanced, the snapshot rewritten complete as v 1 (no journal
  // id) and the journal then unlinked, so a previous build can open it. A
  // crash before the v 1 write leaves a complete v 2 snapshot beside its
  // header-only journal, one after it a v 1 snapshot beside a header-only
  // orphan: this build opens both. The store counts as closed only once the
  // v 1 snapshot is written (and its rename durable): a close that failed
  // rejects (the caller reports it) and may be retried, and a store that is
  // unavailable while a v 2 snapshot is on disk rejects with 'indisponivel'.
  // Once closed, every mutation answers 'indisponivel'; the read API keeps
  // working.
  function close () {
    return enqueue(() => {
      if (closed) return
      if (readOnly) {
        closed = true
        return
      }
      if (snapV !== VERSION_JOURNAL) {
        if (!failed) settleSnapshot()
        closed = true
        dropFd()
        return
      }
      if (failed) throw fail('indisponivel')
      // The guard first: a journal another writer appended to is never
      // folded into a v 1 snapshot that lacks its lines.
      writable()
      if (journalBytes > headerBytes) compact()
      else writeHwm()
      const id = journalId
      writeSnapshot(VERSION, null)
      closed = true
      dropFd()
      journalId = null
      headerBytes = 0
      journalBytes = null
      journalLines = 0
      // A header-only orphan beside v 1 also opens, so a failed unlink
      // leaves a directory that does.
      try { fs.unlinkSync(journalPath(dataDir, id)) } catch {}
    })
  }

  return { start, reserve, putGoogle, markAnswered, get, isFull, inviteUsed, dropPending, finish, rename, status, lookup, exportLinks, linkStats, contact, memberForSub, close, fail: markFailed, restored: isRestored }
}

module.exports = {
  FILE,
  JOURNAL_PREFIX,
  HWM,
  journalPath,
  COMPACT_EVERY,
  COMPACT_BYTES,
  ORPHAN_GRACE_MS,
  COOLDOWN_MS,
  PENDING_TTL_MS,
  MAX_PENDING,
  MAX_UNPROVEN_PER_MEMBER,
  MAX_PER_SUB,
  RESERVED,
  openAccountStore
}
