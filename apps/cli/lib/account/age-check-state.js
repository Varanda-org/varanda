'use strict'

// Whether the hosted age check was on at the last start, and since when:
// <dataDir>/age-check.json (mode 0o600) = { v: 1, on, enabledAt }, replaced
// whole through writeJsonAtomic (packages/core/lib/store.js). The age-since
// route (./age-routes.js) never serves a since earlier than enabledAt, so a
// VARANDA_AGE_SINCE reused after the check was turned off and on again cannot
// vouch for the certificates issued, without a band, while it was off.
//
// settleAgeCheck runs once per start, with the service lock held:
//
//   - on now, file missing: { on: true, enabledAt: since ?? now }. A first
//     start, or a file lost or never written by an older build: the
//     configured since is kept, and directoryFloor below still keeps the
//     route from vouching for links made while the check was off
//   - on now, file says off: { on: true, enabledAt: now }
//   - on now, file says on: kept as is
//   - off now: { on: false, enabledAt: null }, even over an invalid file,
//     since recording an off period can only raise the floor later
//
// An on start over a file this module would not have written leaves it
// untouched and answers { ok: false }, as does any failed write while on: the
// since route then answers 503 'indisponivel' until an operator repairs the
// file or restores its latest copy. Nothing here throws on a bad file;
// startAgeCheck throws when an off start could not record the off period.
//
// age-check.json alone is not enough: a deleted, restored or downgraded file
// brings back an older enabledAt. directoryFloor takes a second floor from
// the data itself: the latest member certificate (its date is the link's
// linkedAt) of a linked member with no band on record, plus 1 ms. While the
// check is on every new link has a band, so an unbanded link can only
// predate the check or fall in an off period, and links are never deleted.

const fs = require('node:fs')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isCanonicalIso, isPlainObject } = require('@varanda/core/lib/cert')

const FILE = 'age-check.json'
const VERSION = 1

function valid (obj) {
  if (!isPlainObject(obj)) return false
  const keys = Object.keys(obj)
  if (keys.length !== 3 || obj.v !== VERSION || typeof obj.on !== 'boolean') return false
  if (!keys.includes('enabledAt')) return false
  return obj.on ? isCanonicalIso(obj.enabledAt) : obj.enabledAt === null
}

// { state } (null when the file is missing) or { error }.
function readAgeCheck (dataDir) {
  let text
  try {
    text = fs.readFileSync(path.join(dataDir, FILE), 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: null }
    return { error: 'indisponivel' }
  }
  let obj
  try { obj = JSON.parse(text) } catch { return { error: 'indisponivel' } }
  return valid(obj) ? { state: obj } : { error: 'indisponivel' }
}

// { ok: true, on, enabledAt } or { ok: false }. `guard` is checked before
// the write (the service lock).
function settleAgeCheck (dataDir, { on, since = null, now = Date.now, guard = () => true }) {
  if (since !== null && !isCanonicalIso(since)) throw new TypeError('since must be a canonical ISO timestamp')
  const read = readAgeCheck(dataDir)
  let next
  if (!on) {
    next = { v: VERSION, on: false, enabledAt: null }
  } else if (read.error) {
    return { ok: false }
  } else if (read.state !== null && read.state.on) {
    return { ok: true, on: true, enabledAt: read.state.enabledAt }
  } else {
    const at = new Date(now()).toISOString()
    next = { v: VERSION, on: true, enabledAt: read.state === null && since !== null ? since : at }
  }
  if (read.state && read.state.on === next.on && read.state.enabledAt === next.enabledAt) return { ok: true, on: next.on, enabledAt: next.enabledAt }
  try {
    if (!guard()) return { ok: false }
    writeJsonAtomic(path.join(dataDir, FILE), next, 0o600)
  } catch {
    return { ok: false }
  }
  return { ok: true, on: next.on, enabledAt: next.enabledAt }
}

// settleAgeCheck for the service start. An off start that could not record
// { on: false } would leave an older "on" record behind, whose enabledAt a
// later on start keeps: the start fails instead.
function startAgeCheck (dataDir, opts) {
  const settled = settleAgeCheck(dataDir, opts)
  if (!opts.on && !settled.ok) throw new Error('não foi possível gravar ' + FILE + ' com a verificação de idade desligada')
  return settled
}

// { ok: true, floor } (null when every linked member has a band) or
// { ok: false } when the directory or the age store cannot answer. Computed
// once per start: a band recorded later never lowers it during the run.
function directoryFloor (store, ages) {
  let latest = null
  try {
    for (const { member, linkedAt } of store.exportLinks()) {
      if (!isCanonicalIso(linkedAt)) return { ok: false }
      if (ages.get(member) !== null) continue
      if (latest === null || linkedAt > latest) latest = linkedAt
    }
  } catch {
    return { ok: false }
  }
  return { ok: true, floor: latest === null ? null : new Date(Date.parse(latest) + 1).toISOString() }
}

module.exports = {
  settleAgeCheck,
  startAgeCheck,
  directoryFloor,
  readAgeCheck,
  FILE
}
