'use strict'

// The human precedents of the AI report triage: every post report a
// moderator decided by hand (bloquear or descartar), kept with the verified
// post text it was decided on and that text's quantized MiniLM embedding, so
// the triage can compare a new report against what humans already did. ONE
// file, <dataDir>/exemplars.json (mode 0o600, data dir 0o700), beside
// moderation.json and always replaced whole through writeJsonAtomic
// (packages/core/lib/store.js), as account/moderation-store.js does.
// moderation.json is never read or touched here.
//
// File shape (exact keys, on the file and on every item):
//   { v: 1, model, items: [{ id, at, reportId, target, seq, reason, decision,
//     contentHash, text, hasMedia, embedding }] }
// `model` names the embedding model the vectors came from; a file written by
// another model is refused with { code: 'modelo' } (add, list, remove,
// removeTarget) and never rewritten, so the caller can re-embed from `text`
// (which is why the text is kept) instead of mixing two vector spaces.
//
// `reason` is spam, assedio or outro: 'ilegal' is refused, because that text
// is evidence of a possible crime and must never be copied into a second
// corpus. `embedding` is exactly DIM integers in [-127, 127] (int8 scale).
//
// At most MAX_EXEMPLARS items: an add over the cap drops the oldest by
// (at, id) in the same write. A duplicate reportId returns the existing row
// without a write. remove/removeTarget let a human cancel or unblock withdraw
// a precedent; each writes once, and only when something was removed.
//
// A missing file is created empty. A malformed one (one bad row is enough)
// is never replaced: every method then throws { code: 'indisponivel' } until
// an operator repairs it, the moderation-store rule, because the text in it
// is evidence a moderator acted on. (The triage ledger, ledger.js, is
// different: it is a cache and may be set aside and recreated.)
//
// Mutations are synchronous (writeJsonAtomic is), so no two of them can
// interleave inside one process. Errors carry only a token in `code`:
// pedido-invalido, indisponivel, modelo.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isPlainObject, isCanonicalIso, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { MAX_TEXT, MAX_LOG_BLOCKS } = require('@varanda/core/lib/records')
const { isCleanText } = require('../moderation-store')

const FILE = 'exemplars.json'
const VERSION = 1
const MAX_EXEMPLARS = 4000
const DIM = 384
const MODEL_MAX = 200
const REASONS = ['spam', 'assedio', 'outro']
const DECISIONS = ['bloquear', 'descartar']
const ID_RE = /^[A-Za-z0-9_-]{22}$/
const FILE_KEYS = ['v', 'model', 'items']
const ITEM_KEYS = ['id', 'at', 'reportId', 'target', 'seq', 'reason', 'decision', 'contentHash', 'text', 'hasMedia', 'embedding']
const FIELD_KEYS = ['reportId', 'target', 'seq', 'reason', 'decision', 'contentHash', 'text', 'hasMedia', 'embedding']

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

// Same id shape as moderation-store newId: 16 random bytes, base64url.
function newId () {
  return crypto.randomBytes(16).toString('base64url')
}

function has (obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function exactKeys (obj, keys) {
  return Object.keys(obj).length === keys.length && keys.every((k) => has(obj, k))
}

function validId (id) {
  return typeof id === 'string' && ID_RE.test(id)
}

function validModel (m) {
  return typeof m === 'string' && m.length >= 1 && m.length <= MODEL_MAX
}

function validText (s) {
  return typeof s === 'string' && isCleanText(s, true) && Array.from(s).length <= MAX_TEXT
}

function validSeq (seq) {
  return Number.isInteger(seq) && seq >= 1 && seq < MAX_LOG_BLOCKS
}

// Exactly DIM integers in [-127, 127]; a plain array or an Int8Array.
function validEmbedding (e) {
  if (!Array.isArray(e) && !(e instanceof Int8Array)) return false
  if (e.length !== DIM) return false
  for (let i = 0; i < DIM; i++) {
    const x = e[i]
    if (!Number.isInteger(x) || x < -127 || x > 127) return false
  }
  return true
}

// The fields every row carries besides id and at (shared by add and load).
function validBody (r) {
  return validId(r.reportId) &&
    isLowerHex(r.target, 32) &&
    validSeq(r.seq) &&
    REASONS.includes(r.reason) &&
    DECISIONS.includes(r.decision) &&
    isLowerHex(r.contentHash, 32) &&
    validText(r.text) &&
    typeof r.hasMedia === 'boolean' &&
    validEmbedding(r.embedding)
}

function validItem (r) {
  return isPlainObject(r) && exactKeys(r, ITEM_KEYS) && validId(r.id) && isCanonicalIso(r.at) && validBody(r)
}

function copyItem (r) {
  return { ...r, embedding: Array.from(r.embedding) }
}

// Total validation, never filtering: one bad item throws.
function fromJson (obj) {
  const bad = () => new Error('exemplares inválidos')
  if (!isPlainObject(obj) || !exactKeys(obj, FILE_KEYS) || obj.v !== VERSION) throw bad()
  if (!validModel(obj.model) || !Array.isArray(obj.items) || obj.items.length > MAX_EXEMPLARS) throw bad()
  const ids = new Set()
  const reportIds = new Set()
  for (const r of obj.items) {
    if (!validItem(r) || ids.has(r.id) || reportIds.has(r.reportId)) throw bad()
    ids.add(r.id)
    reportIds.add(r.reportId)
  }
  return { v: VERSION, model: obj.model, items: obj.items.map(copyItem) }
}

function readState (file) {
  const st = fs.lstatSync(file)
  if (!st.isFile()) throw new Error('exemplares inválidos')
  return fromJson(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function older (a, b) {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function openExemplarStore (dataDir, { now = Date.now, model } = {}) {
  if (!validModel(model)) throw new TypeError('model must be a non-empty string of at most 200 characters')
  refuseSymlinkDir(dataDir)
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dataDir, 0o700)
  const file = path.join(dataDir, FILE)
  let state = null
  let failed = false
  let missing = false
  try {
    state = readState(file)
  } catch (err) {
    if (err.code === 'ENOENT') missing = true
    else failed = true
  }
  if (missing) {
    state = { v: VERSION, model, items: [] }
    writeJsonAtomic(file, state, 0o600)
  }

  function usable () {
    if (failed) throw fail('indisponivel')
  }

  // Every method that reads or writes vectors needs the same vector space.
  function sameModel () {
    usable()
    if (state.model !== model) throw fail('modelo')
  }

  // After a failed write the file holds the previous state or `next`:
  // reload it; an unreadable file marks the store unavailable.
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

  function add (fields) {
    sameModel()
    if (!isPlainObject(fields) || !Object.keys(fields).every((k) => FIELD_KEYS.includes(k))) throw fail('pedido-invalido')
    if (!exactKeys(fields, FIELD_KEYS) || !validBody(fields)) throw fail('pedido-invalido')
    const existing = state.items.find((r) => r.reportId === fields.reportId)
    if (existing) return { exemplar: copyItem(existing), duplicate: true }
    const row = {
      id: newId(),
      at: new Date(now()).toISOString(),
      reportId: fields.reportId,
      target: fields.target,
      seq: fields.seq,
      reason: fields.reason,
      decision: fields.decision,
      contentHash: fields.contentHash,
      text: fields.text,
      hasMedia: fields.hasMedia,
      embedding: Array.from(fields.embedding)
    }
    let items = [...state.items, row]
    // The new row is never evicted, even when it sorts oldest (a clock
    // stepped back): the oldest OTHER rows go instead.
    if (items.length > MAX_EXEMPLARS) {
      const drop = new Set(state.items.slice().sort(older).slice(0, items.length - MAX_EXEMPLARS))
      items = items.filter((r) => !drop.has(r))
    }
    persist({ v: VERSION, model: state.model, items })
    return { exemplar: copyItem(row), duplicate: false }
  }

  function remove (reportId) {
    sameModel()
    if (!validId(reportId)) throw fail('pedido-invalido')
    const items = state.items.filter((r) => r.reportId !== reportId)
    if (items.length === state.items.length) return false
    persist({ v: VERSION, model: state.model, items })
    return true
  }

  function removeTarget (target, decision) {
    sameModel()
    if (!isLowerHex(target, 32)) throw fail('pedido-invalido')
    if (decision !== undefined && !DECISIONS.includes(decision)) throw fail('pedido-invalido')
    const items = state.items.filter((r) => !(r.target === target && (decision === undefined || r.decision === decision)))
    const count = state.items.length - items.length
    if (count > 0) persist({ v: VERSION, model: state.model, items })
    return count
  }

  function list ({ reason } = {}) {
    sameModel()
    if (reason !== undefined && !REASONS.includes(reason)) throw fail('pedido-invalido')
    return state.items.filter((r) => reason === undefined || r.reason === reason).map(copyItem)
  }

  function size () {
    usable()
    return state.items.length
  }

  return { add, remove, removeTarget, list, size }
}

module.exports = {
  FILE,
  MAX_EXEMPLARS,
  DIM,
  openExemplarStore
}
