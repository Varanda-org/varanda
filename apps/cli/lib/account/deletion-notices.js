'use strict'

// The push notices `account delete --yes` (../commands/account.js) owes. The
// command writes a hold while the service is stopped, so nobody can push the
// "exclusão agendada" notice the app's path sends; it queues the member here
// instead, and the service pushes it at its next start (serve(), through
// ./server.js notifyScheduledDeletion), then removes the file. Without the
// notice, a person who did not ask (whoever wrote from their mailbox did)
// could lose the account without any device telling them.
//
// ONE sidecar file, <dataDir>/deletion-notices.json (mode 0o600), exactly
// { v: 1, members: [<hex64>, ...] } with no repeated key, written through
// ./guarded-write.js under the service lock's guard. Never an e-mail or a
// name. A missing file is an empty queue.

const fs = require('node:fs')
const path = require('node:path')
const { writeGuarded, held } = require('./guarded-write')
const { isPlainObject } = require('@varanda/core/lib/cert')

const FILE = 'deletion-notices.json'
const HEX64_RE = /^[0-9a-f]{64}$/
// Far above any directory this service can hold, so a hostile or broken
// file cannot make the start loop for long.
const MAX_MEMBERS = 100000

function invalid () {
  const err = new Error('deletion-notices.json inválido')
  err.invalid = true
  return err
}

// -> the queued member keys, [] without a file; throws { invalid: true } for
// a file this module would not have written.
function readNotices (dataDir) {
  let text
  try {
    text = fs.readFileSync(path.join(dataDir, FILE), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    throw invalid()
  }
  if (!isPlainObject(doc) || Object.keys(doc).sort().join(',') !== 'members,v' || doc.v !== 1 || !Array.isArray(doc.members) || doc.members.length > MAX_MEMBERS) throw invalid()
  if (!doc.members.every((m) => typeof m === 'string' && HEX64_RE.test(m)) || new Set(doc.members).size !== doc.members.length) throw invalid()
  return doc.members
}

// -> true when the member was added (false: already queued).
function queueNotice (dataDir, member, guard) {
  const members = readNotices(dataDir)
  if (members.includes(member)) return false
  writeGuarded(path.join(dataDir, FILE), { v: 1, members: [...members, member] }, 0o600, guard)
  return true
}

// -> true when the member was removed.
function dropNotice (dataDir, member, guard) {
  const members = readNotices(dataDir)
  if (!members.includes(member)) return false
  const rest = members.filter((m) => m !== member)
  if (rest.length === 0) clearNotices(dataDir, guard)
  else writeGuarded(path.join(dataDir, FILE), { v: 1, members: rest }, 0o600, guard)
  return true
}

function clearNotices (dataDir, guard) {
  if (!held(guard)) throw new Error('indisponivel')
  try {
    fs.unlinkSync(path.join(dataDir, FILE))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

// At the service's start: `notify(member)` for each queued member, 'sent'
// (it still had a hold and was pushed), 'skip' (no hold, or deleted: its
// notice is moot) or 'keep' (the stores could not tell; a throw counts as
// that). Kept members stay in the file for the next start, one pass per
// start and never a loop here; the rest leave it. An invalid file is logged
// once and removed rather than left: kept, it would be read and refused
// again at every start, and its notices are unreadable anyway. A failed
// rewrite only means the notices may go out again next start.
// Never throws. -> { sent, skipped, kept }
function drainNotices (dataDir, { notify, guard, log = () => {} }) {
  let members
  try {
    members = readNotices(dataDir)
  } catch (err) {
    log({ event: 'exclusao', reason: err.invalid === true ? 'avisos-invalidos' : 'avisos-leitura-falhou' })
    if (err.invalid !== true) return { sent: 0, skipped: 0, kept: 0 }
    members = []
  }
  let sent = 0
  let skipped = 0
  const kept = []
  for (const member of members) {
    let out = 'keep'
    try {
      out = notify(member)
    } catch {}
    if (out === 'sent') sent++
    else if (out === 'skip') skipped++
    else kept.push(member)
  }
  try {
    if (kept.length === 0) clearNotices(dataDir, guard)
    else if (kept.length < members.length) writeGuarded(path.join(dataDir, FILE), { v: 1, members: kept }, 0o600, guard)
  } catch {
    log({ event: 'exclusao', reason: 'avisos-remocao-falhou' })
  }
  if (members.length > 0) log({ event: 'exclusao', reason: 'avisos-operador', sent, skipped, kept: kept.length })
  return { sent, skipped, kept: kept.length }
}

module.exports = { FILE, readNotices, queueNotice, dropNotice, clearNotices, drainNotices }
