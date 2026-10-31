'use strict'

// The moderation desk of the account service: the reports members send from
// the app, the moderators' decisions, the pending changes the operator still
// has to sign into the blocklist (packages/core/lib/blocklist.js) and a
// verified mirror of the last snapshot the operator published. ONE file,
// <dataDir>/moderation.json (mode 0o600, data dir 0o700), always replaced
// whole through writeJsonAtomic (packages/core/lib/store.js: O_EXCL temp,
// fsync, rename, dir fsync), so a crash before the rename leaves the previous
// file. The audit trail (`events`) lives inside the same file: a second file
// could never be written atomically with the first, and assoc.js exports no
// append helper. Every mutation runs in one in-process queue against a copy
// of the state; the copy replaces the in-memory state only after the write
// returned, and a write that throws reloads the file (as account/store.js).
//
// A missing file is created empty. A malformed one is never replaced: every
// method then throws { code: 'indisponivel' } until an operator repairs it.
//
// Pending changes are an ordered intent log (plan D6): each change is
// { id, op: 'block'|'unblock', member, by, at, reportIds, claimedAt }, kept in
// insertion order. A member's "net state" is its membership in the published
// snapshot after applying that member's pending changes in order. The
// operator's `mod apply` pulls (claims) them, signs a snapshot and acks the
// ids it applied; a claimed change is never deleted before its ack, so a
// decision cancelled after the operator pulled it is undone by appending the
// inverse change ('compensado').
//
// Appeals (issue #22): a blocked member's signed request for review
// (packages/core/lib/appeal.js), kept in their own collection beside the
// reports. Accepting one appends an 'unblock' change like the panel's
// "Desbloquear" (nothing leaves the list before the operator's `mod apply`
// confirms it); denying one only closes the case.
//
// Events never hold a signature, a reporter, an e-mail other than the
// moderator's own `by`, a note or a secret. Errors carry only a token in
// `code`.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isHex, isPlainObject, isCanonicalIso, refuseSymlinkDir, verifyModeratorCert } = require('@varanda/core/lib/cert')
const { verifySnapshot, acceptSnapshot, blockedSet, MAX_BLOCKED } = require('@varanda/core/lib/blocklist')
const { isUnsafe } = require('@varanda/core/lib/safe')
const { MAX_TEXT, MAX_LOG_BLOCKS } = require('@varanda/core/lib/records')

const FILE = 'moderation.json'
// v2 rows add `writer` and `group` (a report of a group message,
// packages/core/lib/report.js 'varanda-report-v2'); a v1 file is read with
// both null and rewritten as v2 by the next mutation. v3 adds `appeals`; a
// v1 or v2 file is read with none and rewritten as v3 the same way.
const VERSION = 3
// Open reports waiting for a moderator. Decided ones are kept (retention is
// issue #38) and do not count here, so deciding junk frees intake; they are
// bounded by MAX_STORED_REPORTS instead.
const MAX_REPORTS = 20000
const MAX_STORED_REPORTS = 100000
const MAX_PER_REPORTER_DAY = 20
const MAX_APPEALS = 2000
const MAX_STORED_APPEALS = 20000
const MAX_PENDING = 1000
const MAX_EVENTS = 10000
const NOTE_MAX = 280
const BY_MAX = 254
const LIST_DEFAULT = 100
// The `by` the AI triage worker decides with, and the two `actor` values the
// operator's pull projection carries instead of `by` (never an e-mail).
const AI_ACTOR = 'ia'
const HUMAN_ACTOR = 'pessoa'
const DAY_MS = 86400000
// One appeal per block, and a denied member waits this long for the next: an
// accepted or closed appeal ended its block, so a new block starts afresh. A
// retry of the open one answers the same row.
const APPEAL_WINDOW_MS = 30 * DAY_MS
// The report rules of packages/core/lib/report.js (T22): same constants and
// the same character rule, re-checked here because the store is the last
// line before evidence lands on disk.
const REASONS = ['spam', 'assedio', 'ilegal', 'outro']
const TEXT_MAX = 280
const QUOTE_MAX = MAX_TEXT
const SEQ_MAX = MAX_LOG_BLOCKS - 1
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const STATUSES = ['aberta', 'bloquear', 'descartar']
const DECISIONS = ['bloquear', 'descartar']
// 'encerrado': the key stopped being blocked while the appeal was open.
const APPEAL_STATUSES = ['aberta', 'aceito', 'negado', 'encerrado']
const APPEAL_DECISIONS = { aceitar: 'aceito', negar: 'negado' }
const APPEAL_TEXT_MAX = MAX_TEXT
// What a 'bloquear' decision blocks: the author's diary, or (group reports
// only) the group root key.
const BLOCK_TARGETS = ['diario', 'grupo']

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

// 16 random bytes, base64url without padding: 22 characters that are never
// mistaken for key material (packages/rpc/lib/errors.js:33-39 rejects 16+
// hex runs in wire messages).
function newId () {
  return crypto.randomBytes(16).toString('base64url')
}

function has (map, key) {
  return Object.prototype.hasOwnProperty.call(map, key)
}

function dict (src) {
  const out = Object.create(null)
  if (src !== null && typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) out[k] = v
  }
  return out
}

function codePoints (s) {
  return Array.from(s).length
}

// No code point that safe.js would escape, except LF when allowLf (the rule
// of records.js isForbiddenChar and report.js isCleanText). Lone surrogates
// are refused (plan D5): they encode to the same UTF-8 bytes as U+FFFD.
function isCleanText (s, allowLf) {
  if (typeof s !== 'string' || !s.isWellFormed()) return false
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp === 0x0a && allowLf) continue
    if (isUnsafe(cp)) return false
  }
  return true
}

function boundedText (s, max, allowLf) {
  return typeof s === 'string' && isCleanText(s, allowLf) && codePoints(s) <= max
}

function validBy (by) {
  return typeof by === 'string' && by.length >= 1 && by.length <= BY_MAX && isCleanText(by, false)
}

function copyReport (r) {
  return { ...r }
}

function copyChange (c) {
  return { ...c, reportIds: [...c.reportIds] }
}

function copySnapshot (s) {
  if (s === null) return null
  return { ...s, blocked: [...s.blocked], revokedIssuers: [...s.revokedIssuers] }
}

function emptyState () {
  return {
    v: VERSION,
    reports: dict(),
    appeals: dict(),
    pending: [],
    published: { snapshot: null, at: null, moderatorDate: '' },
    events: []
  }
}

const ID_RE = /^[A-Za-z0-9_-]{22}$/
const EVENT_ACTIONS = ['bloquear', 'descartar', 'pedido', 'compensado', 'cancelado', 'ja-bloqueada', 'ja-desbloqueada', 'enviado', 'aplicado', 'recurso-aceito', 'recurso-negado', 'recurso-encerrado']
const EVENT_KEYS = ['at', 'by', 'action', 'member', 'reportId', 'appealId', 'changeId', 'seq']
const APPEAL_KEYS = ['id', 'at', 'member', 'text', 'nonce', 'signature', 'status', 'decidedBy', 'decidedAt', 'note']
const REPORT_KEYS_V1 = ['id', 'at', 'kind', 'target', 'seq', 'quote', 'reporter', 'reason', 'text', 'nonce', 'signature', 'status', 'decidedBy', 'decidedAt', 'note']
const REPORT_KEYS_V2_EARLY = [...REPORT_KEYS_V1, 'writer', 'group']
// `blocked`: which key a 'bloquear' decision blocked ('diario' | 'grupo'),
// null otherwise and for rows written before the field existed (those only
// ever blocked the diary).
const REPORT_KEYS = [...REPORT_KEYS_V2_EARLY, 'blocked']
const CHANGE_KEYS = ['id', 'op', 'member', 'by', 'at', 'reportIds', 'claimedAt']

function exactKeys (obj, keys) {
  return Object.keys(obj).length === keys.length && keys.every((k) => has(obj, k))
}

function validId (id) {
  return typeof id === 'string' && ID_RE.test(id)
}

// Every field add() and decide() write, with the shapes they enforce: a row
// missing any piece of evidence (signature, nonce, seq, reason...) is not a
// row this module wrote and must never be carried into a rewrite.
function validReportRow (id, r) {
  if (!isPlainObject(r) || !exactKeys(r, REPORT_KEYS)) return false
  if (r.writer === null) {
    if (r.group !== null) return false
  } else if (!isLowerHex(r.writer, 32) || !isLowerHex(r.group, 32) || r.seq === null) {
    return false
  }
  if (r.id !== id || !validId(id) || !isCanonicalIso(r.at)) return false
  if (!isLowerHex(r.target, 32) || !isLowerHex(r.reporter, 32) || r.reporter === r.target) return false
  if (r.seq === null) {
    if (r.kind !== 'account' || r.quote !== '') return false
  } else if (r.kind !== 'post' || !Number.isInteger(r.seq) || r.seq < 1 || r.seq > SEQ_MAX) {
    return false
  }
  if (r.blocked !== null) {
    if (r.status !== 'bloquear' || !BLOCK_TARGETS.includes(r.blocked)) return false
    if (r.blocked === 'grupo' && r.group === null) return false
  }
  if (!REASONS.includes(r.reason)) return false
  if (!boundedText(r.text, TEXT_MAX, false) || !boundedText(r.quote, QUOTE_MAX, true)) return false
  if (!isLowerHex(r.signature, 64) || typeof r.nonce !== 'string' || !NONCE_RE.test(r.nonce)) return false
  if (!STATUSES.includes(r.status)) return false
  if (r.status === 'aberta') return r.decidedBy === null && r.decidedAt === null && r.note === ''
  return validBy(r.decidedBy) && isCanonicalIso(r.decidedAt) && boundedText(r.note, NOTE_MAX, true)
}

function validAppealRow (id, a) {
  if (!isPlainObject(a) || !exactKeys(a, APPEAL_KEYS)) return false
  if (a.id !== id || !validId(id) || !isCanonicalIso(a.at) || !isLowerHex(a.member, 32)) return false
  if (!boundedText(a.text, APPEAL_TEXT_MAX, true)) return false
  if (!isLowerHex(a.signature, 64) || typeof a.nonce !== 'string' || !NONCE_RE.test(a.nonce)) return false
  if (!APPEAL_STATUSES.includes(a.status)) return false
  if (a.status === 'aberta') return a.decidedBy === null && a.decidedAt === null && a.note === ''
  return validBy(a.decidedBy) && isCanonicalIso(a.decidedAt) && boundedText(a.note, NOTE_MAX, true)
}

function validChangeRow (c, reports) {
  return isPlainObject(c) &&
    exactKeys(c, CHANGE_KEYS) &&
    validId(c.id) &&
    (c.op === 'block' || c.op === 'unblock') &&
    isLowerHex(c.member, 32) &&
    validBy(c.by) &&
    isCanonicalIso(c.at) &&
    Array.isArray(c.reportIds) &&
    c.reportIds.every((id) => validId(id) && has(reports, id)) &&
    new Set(c.reportIds).size === c.reportIds.length &&
    (c.claimedAt === null || isCanonicalIso(c.claimedAt))
}

function validEvent (e) {
  if (!isPlainObject(e) || !Object.keys(e).every((k) => EVENT_KEYS.includes(k))) return false
  if (!isCanonicalIso(e.at) || !validBy(e.by) || !EVENT_ACTIONS.includes(e.action)) return false
  if (has(e, 'member') && !isLowerHex(e.member, 32)) return false
  if (has(e, 'reportId') && !validId(e.reportId)) return false
  if (has(e, 'appealId') && !validId(e.appealId)) return false
  if (has(e, 'changeId') && !validId(e.changeId)) return false
  if (has(e, 'seq') && !(Number.isInteger(e.seq) && e.seq >= 0)) return false
  return true
}

// Throws on anything that is not a file this module wrote; the published
// snapshot must still verify for the association. Validation is total and
// never filters: one malformed row, change or event makes the whole store
// 'indisponivel', so no later mutation can rewrite the file without it.
function fromJson (obj, association) {
  const bad = () => new Error('moderação inválida')
  if (!isPlainObject(obj) || (obj.v !== 1 && obj.v !== 2 && obj.v !== VERSION)) throw bad()
  if (!exactKeys(obj, obj.v === VERSION ? ['v', 'reports', 'appeals', 'pending', 'published', 'events'] : ['v', 'reports', 'pending', 'published', 'events'])) throw bad()
  if (!isPlainObject(obj.reports) || !Array.isArray(obj.pending) || !Array.isArray(obj.events)) throw bad()
  if (obj.v === VERSION && !isPlainObject(obj.appeals)) throw bad()
  if (obj.pending.length > MAX_PENDING || obj.events.length > MAX_EVENTS) throw bad()
  const p = obj.published
  if (!isPlainObject(p) || !exactKeys(p, ['snapshot', 'at', 'moderatorDate'])) throw bad()
  if (p.snapshot === null) {
    if (p.at !== null || p.moderatorDate !== '') throw bad()
  } else {
    if (!verifySnapshot(p.snapshot, association).ok) throw bad()
    if (!isCanonicalIso(p.at) || p.moderatorDate !== p.snapshot.moderatorDate) throw bad()
  }
  const reports = dict()
  for (const [id, r] of Object.entries(obj.reports)) {
    let row = r
    if (obj.v === 1) {
      if (!isPlainObject(r) || !exactKeys(r, REPORT_KEYS_V1)) throw bad()
      row = { ...r, writer: null, group: null, blocked: null }
    } else if (isPlainObject(r) && exactKeys(r, REPORT_KEYS_V2_EARLY)) {
      row = { ...r, blocked: null }
    }
    if (!validReportRow(id, row)) throw bad()
    reports[id] = { ...row }
  }
  const appeals = dict()
  if (obj.v === VERSION) {
    for (const [id, a] of Object.entries(obj.appeals)) {
      if (!validAppealRow(id, a)) throw bad()
      appeals[id] = { ...a }
    }
  }
  const ids = new Set()
  for (const c of obj.pending) {
    if (!validChangeRow(c, reports) || ids.has(c.id)) throw bad()
    ids.add(c.id)
  }
  for (const e of obj.events) {
    if (!validEvent(e)) throw bad()
  }
  return {
    v: VERSION,
    reports,
    appeals,
    pending: obj.pending.map(copyChange),
    published: { snapshot: copySnapshot(p.snapshot), at: p.at, moderatorDate: p.moderatorDate },
    events: obj.events.map((e) => ({ ...e }))
  }
}

function readState (file, association) {
  const st = fs.lstatSync(file)
  if (!st.isFile()) throw new Error('moderação inválida')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')), association)
}

// Shallow copy for a mutation: rows and changes are replaced, never edited
// in place, so the current state stays intact until the write returned.
function cloneState (s) {
  return {
    v: VERSION,
    reports: dict(s.reports),
    appeals: dict(s.appeals),
    pending: [...s.pending],
    published: s.published,
    events: [...s.events]
  }
}

// Membership after applying `member`'s changes of `changes` in order.
function netState (published, changes, member) {
  let blocked = blockedSet(published.snapshot).has(member)
  for (const c of changes) {
    if (c.member === member) blocked = c.op === 'block'
  }
  return blocked
}

function netSet (s) {
  const set = blockedSet(s.published.snapshot)
  for (const c of s.pending) {
    if (c.op === 'block') set.add(c.member)
    else set.delete(c.member)
  }
  return set
}

function netBlockedCount (s) {
  return netSet(s).size
}

// The key a 'bloquear' row blocked.
function blockedKey (r) {
  return r.blocked === 'grupo' ? r.group : r.target
}

function lastIndexFor (changes, member) {
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i].member === member) return i
  }
  return -1
}

function openModerationStore (dataDir, { now = Date.now, association } = {}) {
  if (!isHex(association, 32)) throw new TypeError('association must be 64 hex characters')
  association = association.toLowerCase()
  refuseSymlinkDir(dataDir)
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dataDir, 0o700)
  const file = path.join(dataDir, FILE)
  let state = null
  let failed = false
  let missing = false
  try {
    state = readState(file, association)
  } catch (err) {
    if (err.code === 'ENOENT') missing = true
    else failed = true
  }
  if (missing) {
    state = emptyState()
    writeJsonAtomic(file, state, 0o600)
  }
  let tail = Promise.resolve()

  // One in-process queue for every disk mutation, so two decisions never
  // read the same state and both write.
  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function iso (ms) {
    return new Date(ms).toISOString()
  }

  function usable () {
    if (failed) throw fail('indisponivel')
  }

  function persist (next) {
    try {
      writeJsonAtomic(file, next, 0o600)
    } catch (err) {
      resync()
      throw err
    }
    state = next
  }

  // After a failed write the file holds the previous state or `next`: reload
  // it; an unreadable file marks the store unavailable.
  function resync () {
    try {
      state = readState(file, association)
    } catch {
      failed = true
    }
  }

  function event (next, fields) {
    next.events.push({ at: iso(now()), ...fields })
    if (next.events.length > MAX_EVENTS) next.events.splice(0, next.events.length - MAX_EVENTS)
  }

  // One snapshot holds at most MAX_BLOCKED keys. Every mutation that can
  // raise the NET blocked count (appending a block, deleting an unclaimed
  // unblock, compensating a claimed unblock) runs this on `next` before
  // persist, so a refusal changes nothing and the operator is never handed a
  // list it cannot sign. A count already above the cap (the operator's own
  // `mod block` edits) does not refuse mutations that do not raise it.
  function checkCapacity (before, next) {
    const after = netBlockedCount(next)
    if (after > MAX_BLOCKED && after > before) throw fail('lotado')
  }

  // Moves `member` towards `blocked` in `next.pending` (plan D6). Equal to the
  // net state: nothing to do. Otherwise, when the member's last change is
  // unclaimed and dropping it reaches the wanted state, it is deleted (net
  // zero); else a change is appended. -> { change, kind } where kind is
  // 'igual', 'cancelado' or 'novo'.
  function setIntent (next, member, blocked, by, reportIds, appendedAction) {
    const op = blocked ? 'block' : 'unblock'
    if (netState(next.published, next.pending, member) === blocked) {
      event(next, { by, action: blocked ? 'ja-bloqueada' : 'ja-desbloqueada', member })
      return { change: null, kind: 'igual' }
    }
    const i = lastIndexFor(next.pending, member)
    if (i !== -1 && next.pending[i].claimedAt === null && next.pending[i].op !== op) {
      const without = next.pending.slice(0, i).concat(next.pending.slice(i + 1))
      if (netState(next.published, without, member) === blocked) {
        const dropped = next.pending[i]
        next.pending = without
        event(next, { by, action: 'cancelado', member, changeId: dropped.id })
        return { change: null, kind: 'cancelado' }
      }
    }
    if (next.pending.length >= MAX_PENDING) throw fail('lotado')
    const change = { id: newId(), op, member, by, at: iso(now()), reportIds: [...reportIds], claimedAt: null }
    next.pending.push(change)
    event(next, { by, action: appendedAction, member, changeId: change.id })
    return { change, kind: 'novo' }
  }

  function add ({ reporter, target, seq = null, writer = null, group = null, reason, text = '', quote = '', signature, nonce } = {}) {
    return enqueue(() => {
      usable()
      if (!isLowerHex(reporter, 32) || !isLowerHex(target, 32) || reporter === target) throw fail('pedido-invalido')
      if (seq !== null && !(Number.isInteger(seq) && seq >= 1 && seq <= SEQ_MAX)) throw fail('pedido-invalido')
      if (writer === null) {
        if (group !== null) throw fail('pedido-invalido')
      } else if (!isLowerHex(writer, 32) || !isLowerHex(group, 32) || seq === null) {
        throw fail('pedido-invalido')
      }
      if (!REASONS.includes(reason)) throw fail('pedido-invalido')
      if (!boundedText(text, TEXT_MAX, false)) throw fail('pedido-invalido')
      if (!boundedText(quote, QUOTE_MAX, true)) throw fail('pedido-invalido')
      if (seq === null && quote !== '') throw fail('pedido-invalido')
      if (!isLowerHex(signature, 64)) throw fail('pedido-invalido')
      if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw fail('pedido-invalido')

      // A retry of an add that already landed answers the same row, even
      // when the store is full or the reporter is at its daily cap. The
      // writer is part of the key: a diary post and a group message share
      // seq numbers, and so do two writer cores.
      const rows = Object.values(state.reports)
      for (const r of rows) {
        if (r.status === 'aberta' && r.reporter === reporter && r.target === target && r.writer === writer && r.seq === seq) {
          return { report: copyReport(r), duplicate: true }
        }
      }
      // Evidence is never evicted: retention belongs to issue #38.
      let open = 0
      for (const r of rows) if (r.status === 'aberta') open++
      if (open >= MAX_REPORTS || rows.length >= MAX_STORED_REPORTS) throw fail('limite')
      const t = now()
      let today = 0
      for (const r of rows) {
        if (r.reporter === reporter && Date.parse(r.at) >= t - DAY_MS) today++
      }
      if (today >= MAX_PER_REPORTER_DAY) throw fail('limite-denuncias')

      const report = {
        id: newId(),
        at: iso(t),
        kind: seq === null ? 'account' : 'post',
        target,
        seq,
        quote,
        reporter,
        reason,
        text,
        nonce,
        signature,
        status: 'aberta',
        decidedBy: null,
        decidedAt: null,
        note: '',
        writer,
        group,
        blocked: null
      }
      const next = cloneState(state)
      next.reports[report.id] = report
      persist(next)
      return { report: copyReport(report), duplicate: false }
    })
  }

  // 'aberta': oldest first (legal deadlines run from the oldest report,
  // docs/design.md "Moderação e obrigações legais"); 'decidida': newest
  // decision first. `exclude` (a member key) leaves out the cases about that
  // member or filed from it BEFORE the cut at
  // `limit`, so `truncated` counts only what the caller may see.
  function list ({ status = 'aberta', limit = LIST_DEFAULT, exclude = null } = {}) {
    usable()
    if (status !== 'aberta' && status !== 'decidida') throw fail('pedido-invalido')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORTS) throw fail('pedido-invalido')
    if (exclude !== null && typeof exclude !== 'string') throw fail('pedido-invalido')
    const rows = Object.values(state.reports).filter((r) => exclude === null || (r.target !== exclude && r.reporter !== exclude))
    let out
    if (status === 'aberta') {
      out = rows.filter((r) => r.status === 'aberta')
      out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    } else {
      out = rows.filter((r) => r.status !== 'aberta')
      out.sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt))
    }
    return { reports: out.slice(0, limit).map(copyReport), truncated: out.length > limit }
  }

  function get (id) {
    usable()
    if (typeof id !== 'string' || !has(state.reports, id)) return null
    return copyReport(state.reports[id])
  }

  // The e-mails (`decidedBy`) of the humans who decided a 'bloquear' report
  // that blocked `member`'s diary or group root. A moderator in this set does
  // not review the member's appeal. The AI is not a person and is left out.
  function blockerMap () {
    const out = new Map()
    for (const r of Object.values(state.reports)) {
      if (r.status !== 'bloquear' || r.decidedBy === AI_ACTOR) continue
      const key = blockedKey(r)
      if (!out.has(key)) out.set(key, new Set())
      out.get(key).add(r.decidedBy)
    }
    return out
  }

  // An appeal still open for a key that is no longer blocked (unblocked,
  // cancelled, or dropped by the operator's list) has nothing left to
  // decide: closed, so a new block starts without it.
  function closeEnded (next, by) {
    let blocked = null
    for (const a of Object.values(next.appeals)) {
      if (a.status !== 'aberta') continue
      if (blocked === null) blocked = netSet(next)
      if (blocked.has(a.member)) continue
      next.appeals[a.id] = { ...a, status: 'encerrado', decidedBy: by, decidedAt: iso(now()), note: '' }
      event(next, { by, action: 'recurso-encerrado', member: a.member, appealId: a.id })
    }
  }

  // A member's appeal. Only a blocked member (published, or with a pending
  // block) may appeal, once per block and not again within APPEAL_WINDOW_MS
  // of a denial. A retry of the open one answers the same row ('duplicate'),
  // even when the desk is full.
  function addAppeal ({ member, text = '', signature, nonce } = {}) {
    return enqueue(() => {
      usable()
      if (!isLowerHex(member, 32) || !boundedText(text, APPEAL_TEXT_MAX, true)) throw fail('pedido-invalido')
      if (!isLowerHex(signature, 64)) throw fail('pedido-invalido')
      if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw fail('pedido-invalido')
      const rows = Object.values(state.appeals)
      const mine = rows.filter((a) => a.member === member)
      if (!netState(state.published, state.pending, member)) throw fail('nao-bloqueado')
      const open = mine.find((a) => a.status === 'aberta')
      if (open) return { appeal: { ...open }, duplicate: true }
      const t = now()
      if (mine.some((a) => a.status === 'negado' && Date.parse(a.at) >= t - APPEAL_WINDOW_MS)) throw fail('limite-recursos')
      let waiting = 0
      for (const a of rows) if (a.status === 'aberta') waiting++
      if (waiting >= MAX_APPEALS || rows.length >= MAX_STORED_APPEALS) throw fail('limite')
      const appeal = {
        id: newId(),
        at: iso(t),
        member,
        text,
        nonce,
        signature,
        status: 'aberta',
        decidedBy: null,
        decidedAt: null,
        note: ''
      }
      const next = cloneState(state)
      next.appeals[appeal.id] = appeal
      persist(next)
      return { appeal: { ...appeal }, duplicate: false }
    })
  }

  // Same order as list(): open ones oldest first, decided ones newest first.
  // `exclude` (a member key) hides the appeal of that member; `excludeBy` (a
  // moderator's e-mail) hides the appeals of members that moderator blocked.
  // Both cut BEFORE `limit`, so `truncated` counts only what the caller may
  // see.
  function listAppeals ({ status = 'aberta', limit = LIST_DEFAULT, exclude = null, excludeBy = null } = {}) {
    usable()
    if (status !== 'aberta' && status !== 'decidida') throw fail('pedido-invalido')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_APPEALS) throw fail('pedido-invalido')
    if (exclude !== null && typeof exclude !== 'string') throw fail('pedido-invalido')
    if (excludeBy !== null && typeof excludeBy !== 'string') throw fail('pedido-invalido')
    let out = Object.values(state.appeals).filter((a) => (status === 'aberta') === (a.status === 'aberta') && (exclude === null || a.member !== exclude))
    if (excludeBy !== null) {
      const by = blockerMap()
      out = out.filter((a) => !(by.has(a.member) && by.get(a.member).has(excludeBy)))
    }
    if (status === 'aberta') out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    else out.sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt))
    return { appeals: out.slice(0, limit).map((a) => ({ ...a })), truncated: out.length > limit }
  }

  function getAppeal (id) {
    usable()
    if (typeof id !== 'string' || !has(state.appeals, id)) return null
    return { ...state.appeals[id] }
  }

  // The deciding moderators of the member's block, for the panel's rule.
  function blockedBy (member) {
    usable()
    return [...(blockerMap().get(member) || [])]
  }

  // -> { appeal, change | null }. 'aceitar' appends an 'unblock' change as
  // the panel's "Desbloquear" does (or reports the member as already
  // unblocked); 'negar' touches no pending change.
  function decideAppeal (id, { decision, by, note = '' } = {}) {
    return enqueue(() => {
      usable()
      if (typeof id !== 'string' || !has(state.appeals, id) || state.appeals[id].status !== 'aberta') throw fail('nao-encontrado')
      if (!has(APPEAL_DECISIONS, decision) || !validBy(by)) throw fail('pedido-invalido')
      if (!boundedText(note, NOTE_MAX, true)) throw fail('pedido-invalido')
      const current = state.appeals[id]
      const before = netBlockedCount(state)
      const next = cloneState(state)
      const appeal = { ...current, status: APPEAL_DECISIONS[decision], decidedBy: by, decidedAt: iso(now()), note }
      next.appeals[id] = appeal
      event(next, { by, action: decision === 'aceitar' ? 'recurso-aceito' : 'recurso-negado', member: current.member, appealId: id })
      let change = null
      if (decision === 'aceitar') change = setIntent(next, current.member, false, by, [], 'pedido').change
      checkCapacity(before, next)
      persist(next)
      return { appeal: { ...appeal }, change: change === null ? null : copyChange(change) }
    })
  }

  // -> { report, change | null }. 'descartar' never touches pending changes.
  // `block` 'grupo' (a group report only) blocks the group root key instead
  // of the author's diary.
  function decide (id, { decision, by, note = '', block = 'diario' } = {}) {
    return enqueue(() => {
      usable()
      if (typeof id !== 'string' || !has(state.reports, id) || state.reports[id].status !== 'aberta') {
        throw fail('nao-encontrado')
      }
      if (!DECISIONS.includes(decision) || !validBy(by)) throw fail('pedido-invalido')
      if (!boundedText(note, NOTE_MAX, true)) throw fail('pedido-invalido')
      if (!BLOCK_TARGETS.includes(block)) throw fail('pedido-invalido')
      if (block === 'grupo' && state.reports[id].group === null) throw fail('pedido-invalido')
      const blockKey = block === 'grupo' ? state.reports[id].group : state.reports[id].target
      const before = netBlockedCount(state)
      const next = cloneState(state)
      const report = { ...state.reports[id], status: decision, decidedBy: by, decidedAt: iso(now()), note, blocked: decision === 'bloquear' ? block : null }
      next.reports[id] = report
      event(next, { by, action: decision, reportId: id })
      let change = null
      if (decision === 'bloquear') {
        const r = setIntent(next, blockKey, true, by, [id], 'pedido')
        change = r.change
        if (r.kind === 'igual') {
          // Already blocked (or about to be): the report still joins the
          // member's last block change while the operator has not pulled it.
          const i = lastIndexFor(next.pending, blockKey)
          if (i !== -1 && next.pending[i].op === 'block' && next.pending[i].claimedAt === null) {
            const c = next.pending[i]
            next.pending[i] = { ...c, reportIds: [...c.reportIds, id] }
            change = next.pending[i]
          }
        }
      }
      checkCapacity(before, next)
      persist(next)
      return { report: copyReport(report), change: change === null ? null : copyChange(change) }
    })
  }

  // The panel's "Desbloquear". The member must be in the published list or
  // have a pending change. -> { change | null }.
  function unblock (member, { by } = {}) {
    return enqueue(() => {
      usable()
      if (!validBy(by)) throw fail('pedido-invalido')
      if (!isLowerHex(member, 32)) throw fail('nao-encontrado')
      const listed = blockedSet(state.published.snapshot).has(member)
      if (!listed && lastIndexFor(state.pending, member) === -1) throw fail('nao-encontrado')
      const before = netBlockedCount(state)
      const next = cloneState(state)
      const { change } = setIntent(next, member, false, by, [], 'pedido')
      closeEnded(next, by)
      checkCapacity(before, next)
      persist(next)
      return { change: change === null ? null : copyChange(change) }
    })
  }

  // An unclaimed change is deleted. A claimed one is never deleted (the
  // operator may already have signed it): the change that brings the member
  // back to the state it would have without this one is appended instead
  // ('compensado'), and the next apply undoes the decision.
  function cancel (changeId, { by } = {}) {
    return enqueue(() => {
      usable()
      if (!validBy(by)) throw fail('pedido-invalido')
      const i = typeof changeId === 'string' ? state.pending.findIndex((c) => c.id === changeId) : -1
      if (i === -1) throw fail('nao-encontrado')
      const c = state.pending[i]
      const before = netBlockedCount(state)
      const next = cloneState(state)
      let change = null
      if (c.claimedAt === null) {
        next.pending.splice(i, 1)
        event(next, { by, action: 'cancelado', member: c.member, changeId: c.id })
      } else {
        const without = state.pending.slice(0, i).concat(state.pending.slice(i + 1))
        const wanted = netState(state.published, without, c.member)
        // A later change already reverses this one: "cancelling" it would
        // record nothing, and a later cancel of that change would bring this
        // cancelled decision back. Refused instead of a silent success.
        if (netState(state.published, state.pending, c.member) === wanted) throw fail('ja-revertido')
        change = setIntent(next, c.member, wanted, by, [], 'compensado').change
      }
      closeEnded(next, by)
      checkCapacity(before, next)
      persist(next)
      return { change: change === null ? null : copyChange(change) }
    })
  }

  // For the panel: every change in insertion order, claimed or not.
  function pending () {
    usable()
    return {
      changes: state.pending.map(copyChange),
      published: { snapshot: copySnapshot(state.published.snapshot), at: state.published.at }
    }
  }

  // For the operator's `mod apply` (plan D1): every pending change (at most
  // MAX_PENDING, oldest first) projected to { id, op, member, at, actor },
  // each marked claimed (persisted) so a later cancel compensates instead of
  // deleting. A claimed change that is never acked is returned again.
  // `actor` is AI_ACTOR ('ia') when the triage worker created the change and
  // 'pessoa' otherwise; the moderator's `by` (an e-mail) never leaves the
  // store. A human report that later joins an AI-created block change (see
  // decide()) keeps by 'ia', so the operator still reads it as an AI block
  // (conservative: they look twice); the reverse keeps 'pessoa'.
  function pull () {
    return enqueue(() => {
      usable()
      const changes = state.pending.slice(0, MAX_PENDING)
      if (changes.length > 0) {
        const t = iso(now())
        const next = cloneState(state)
        next.pending = state.pending.map((c, i) => i < MAX_PENDING ? { ...c, claimedAt: t } : c)
        event(next, { by: 'operador', action: 'enviado' })
        persist(next)
      }
      return {
        changes: changes.map(({ id, op, member, at, by }) => ({ id, op, member, at, actor: by === AI_ACTOR ? AI_ACTOR : HUMAN_ACTOR })),
        published: { snapshot: copySnapshot(state.published.snapshot) }
      }
    })
  }

  // The operator applied `changeIds` in `snapshot` and published it. Rules
  // (the operator's list is authoritative, it may also hold blocks made with
  // `mod block` outside the panel):
  //   - the snapshot verifies for the association, its moderator is the
  //     certificate's, and it is not older than the mirror ('defasado');
  //   - every id is pending and, per member, the listed ids are the oldest of
  //     that member's changes (a prefix), so no later intent is skipped;
  //   - per member, the state after its LAST listed change matches the
  //     snapshot (a claimed block followed by its compensation means "not
  //     blocked");
  //   - keys the snapshot adds or drops that are in no listed change are the
  //     operator's own edits and are accepted as they are.
  // Nothing is written unless every check passes.
  function ack ({ changeIds, snapshot, moderatorCert } = {}) {
    return enqueue(() => {
      usable()
      if (!verifySnapshot(snapshot, association).ok) throw fail('assinatura-invalida')
      if (!verifyModeratorCert(moderatorCert, association).ok) throw fail('assinatura-invalida')
      if (snapshot.moderator !== moderatorCert.moderator) throw fail('pedido-invalido')
      const verdict = acceptSnapshot(state.published.snapshot, snapshot, association)
      const same = !verdict.ok && verdict.reason === 'same'
      if (!verdict.ok && !same) {
        if (verdict.reason === 'stale') throw fail('defasado')
        throw fail('assinatura-invalida')
      }
      if (!Array.isArray(changeIds) || changeIds.length > MAX_PENDING) throw fail('pedido-invalido')
      const listed = new Set()
      for (const id of changeIds) {
        if (typeof id !== 'string' || listed.has(id)) throw fail('pedido-invalido')
        listed.add(id)
      }
      const final = new Map()
      const skipped = new Set()
      for (const c of state.pending) {
        if (listed.has(c.id)) {
          if (skipped.has(c.member)) throw fail('pedido-invalido')
          final.set(c.member, c.op === 'block')
          listed.delete(c.id)
        } else {
          skipped.add(c.member)
        }
      }
      if (listed.size > 0) throw fail('pedido-invalido')
      const inList = blockedSet(snapshot)
      for (const [member, blocked] of final) {
        if (inList.has(member) !== blocked) throw fail('pedido-invalido')
      }
      if (same && changeIds.length === 0) return { ok: true, seq: snapshot.seq }
      const ids = new Set(changeIds)
      const next = cloneState(state)
      next.pending = state.pending.filter((c) => !ids.has(c.id))
      const copy = copySnapshot(snapshot)
      next.published = { snapshot: copy, at: iso(now()), moderatorDate: copy.moderatorDate }
      event(next, { by: 'operador', action: 'aplicado', seq: copy.seq })
      closeEnded(next, 'operador')
      persist(next)
      return { ok: true, seq: copy.seq }
    })
  }

  // The moderatorDate of the last acked snapshot ('' when none): T26 refuses
  // a moderator certificate older than this (plan D3).
  function newestModeratorDate () {
    usable()
    return state.published.moderatorDate
  }

  // Every key a 'bloquear' row blocked as a group root, over all stored
  // rows (not a listing window), so the panel labels an old group block
  // 'grupo' too.
  function groupKeys () {
    usable()
    const groups = new Set()
    for (const r of Object.values(state.reports)) {
      if (r.status === 'bloquear' && r.blocked === 'grupo') groups.add(r.group)
    }
    return groups
  }

  // The published list, sorted, each member with its 'bloquear' report ids
  // and `kind`: 'grupo' when a report blocked it as a group root, else
  // 'conta' (a key blocked outside the panel included).
  function blocked () {
    usable()
    const byMember = new Map()
    for (const r of Object.values(state.reports)) {
      if (r.status !== 'bloquear') continue
      const member = blockedKey(r)
      if (!byMember.has(member)) byMember.set(member, [])
      byMember.get(member).push(r.id)
    }
    const groups = groupKeys()
    return [...blockedSet(state.published.snapshot)].sort().map((member) => ({
      member,
      reportIds: byMember.get(member) || [],
      kind: groups.has(member) ? 'grupo' : 'conta'
    }))
  }

  function stats () {
    usable()
    let open = 0
    for (const r of Object.values(state.reports)) if (r.status === 'aberta') open++
    let appeals = 0
    for (const a of Object.values(state.appeals)) if (a.status === 'aberta') appeals++
    const s = state.published.snapshot
    return {
      open,
      appeals,
      pending: state.pending.length,
      blocked: blockedSet(s).size,
      publishedSeq: s === null ? null : s.seq
    }
  }

  // For the operator (LGPD access requests, legal orders): report rows with
  // their decision fields, optionally only those about `member`.
  function exportRows ({ member } = {}) {
    usable()
    const rows = Object.values(state.reports)
    return (member === undefined ? rows : rows.filter((r) => r.target === member)).map(copyReport)
  }

  // Read-only: has a human already reversed a block of `member`? The triage
  // worker asks this before blocking, so the AI never re-blocks a person a
  // human has already cleared or whose block a human cancelled. True when
  //   (a) a retained event records a human (by !== 'ia') 'cancelado' or
  //       'compensado' for the member;
  //   (b) the member has a pending unblock (a human asked for it: the AI
  //       never unblocks);
  //   (c) a report about the member was decided 'bloquear', yet the member
  //       is neither in the published list nor has a pending block: that
  //       block was decided and later undone. Report rows are kept, so this
  //       survives the truncation of `events` at MAX_EVENTS.
  //   (d) a retained event records a human unblock request: a 'pedido' that
  //       decide() did not write (decide always writes its 'bloquear' event
  //       right before its 'pedido'; unblock() writes the 'pedido' alone), or
  //       a human 'ja-desbloqueada'. This covers a member blocked outside the
  //       panel (`mod block`, no report) whose panel unblock was already
  //       acked, when (b) and (c) no longer see anything. A 'pedido' whose
  //       preceding event was truncated away counts too (conservative).
  // Known limits, both accepted for the pilot: (1) events are capped at
  // MAX_EVENTS, so a panel unblock of a key blocked outside the panel (no
  // report, rule (c) cannot see it) is forgotten once its 'pedido' ages out;
  // (2) events carry no op, so a human cancel of an UNBLOCK (or a re-block
  // that drops a pending unblock) also reads as a reversal. (2) only makes
  // the AI abstain and leave the case to a human, the safe direction.
  // An invalid member is false.
  function humanReversed (member) {
    usable()
    if (!isLowerHex(member, 32)) return false
    const events = state.events
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (e.member !== member || e.by === AI_ACTOR) continue
      if (e.action === 'cancelado' || e.action === 'compensado' || e.action === 'ja-desbloqueada') return true
      if (e.action === 'pedido') {
        const prev = i > 0 ? events[i - 1] : null
        if (!(prev && prev.action === 'bloquear' && prev.by === e.by)) return true
      }
    }
    let pendingBlock = false
    for (const c of state.pending) {
      if (c.member !== member) continue
      if (c.op === 'unblock') return true
      pendingBlock = true
    }
    if (pendingBlock || blockedSet(state.published.snapshot).has(member)) return false
    for (const r of Object.values(state.reports)) {
      if (r.status === 'bloquear' && blockedKey(r) === member) return true
    }
    return false
  }

  return { add, list, get, addAppeal, listAppeals, getAppeal, blockedBy, decideAppeal, decide, unblock, cancel, pending, pull, ack, newestModeratorDate, blocked, groupKeys, stats, exportRows, humanReversed }
}

module.exports = {
  FILE,
  MAX_REPORTS,
  MAX_PER_REPORTER_DAY,
  MAX_PENDING,
  MAX_APPEALS,
  APPEAL_WINDOW_MS,
  MAX_EVENTS,
  MAX_BLOCKED,
  NOTE_MAX,
  AI_ACTOR,
  isCleanText,
  openModerationStore
}
