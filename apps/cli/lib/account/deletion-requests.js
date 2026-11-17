'use strict'

// The deletion requests filed by Excluir conta sem a passkey (a correct SMS
// code, ./delete-routes.js): for each member key, when its last request was
// filed. A request schedules nothing; the operator reads it with the owner's
// message to contato@varanda.app before running `varanda account delete`.
// ONE sidecar file, <dataDir>/deletion-requests.json (mode 0o600), always
// replaced whole through writeJsonAtomic (./guarded-write.js):
//
//   { v: 1, requests: { <member hex>: <ms> } }
//
// The file is the only state: every call reads it, so the operator's CLI in
// another process sees what the service wrote, and every write starts from
// what is on disk. Writes run in one in-process queue. A row older than
// MAX_AGE_MS is ignored on read and dropped on the next write; the deletion
// sweep calls prune() so a quiet file still loses it. At most `max` rows:
// a new one past that drops the oldest. A file this module would not have
// written is never rewritten: every call then throws { code: 'indisponivel' }
// until an operator repairs it. guard() false (the service lock) refuses the
// write the same way. Never a number, an @nome or a code here.

const fs = require('node:fs')
const path = require('node:path')
const { writeGuarded } = require('./guarded-write')
const { isLowerHex, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')

const FILE = 'deletion-requests.json'
const VERSION = 1
const MAX_AGE_MS = 30 * 24 * 3600 * 1000
const MAX_REQUESTS = 4096

function unavailable () {
  const err = new Error('indisponivel')
  err.code = 'indisponivel'
  return err
}

function validTime (ms) {
  return Number.isSafeInteger(ms) && ms > 0
}

function openDeletionRequests (dataDir, { now = Date.now, guard = () => true, log = () => {}, max = MAX_REQUESTS } = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir must be a path')
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('max must be a positive integer')
  const file = path.join(dataDir, FILE)

  // -> a Map member -> ms of the rows on disk, old ones included.
  function load () {
    let text
    try {
      refuseSymlinkDir(dataDir)
      if (fs.lstatSync(file).isSymbolicLink()) throw unavailable()
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return new Map()
      throw unavailable()
    }
    let obj
    try {
      obj = JSON.parse(text)
    } catch {
      throw unavailable()
    }
    if (!isPlainObject(obj) || Object.keys(obj).length !== 2 || obj.v !== VERSION || !isPlainObject(obj.requests)) throw unavailable()
    const rows = new Map()
    for (const [member, ms] of Object.entries(obj.requests)) {
      if (!isLowerHex(member, 32) || !validTime(ms)) throw unavailable()
      rows.set(member, ms)
    }
    return rows
  }

  function live (ms, t) {
    return t - ms < MAX_AGE_MS
  }

  function write (rows) {
    const requests = {}
    for (const [member, ms] of rows) requests[member] = ms
    try {
      writeGuarded(file, { v: VERSION, requests }, 0o600, guard)
    } catch {
      throw unavailable()
    }
  }

  // Drops the old rows; -> true when any went.
  function dropOld (rows, t) {
    let dropped = false
    for (const [member, ms] of rows) {
      if (!live(ms, t)) {
        rows.delete(member)
        dropped = true
      }
    }
    return dropped
  }

  let queue = Promise.resolve()
  function queued (fn) {
    const next = queue.then(fn)
    queue = next.catch(() => {})
    return next
  }

  function available () {
    try {
      load()
      return true
    } catch {
      return false
    }
  }

  // -> the time of the member's live request, or null.
  function requestedAt (member) {
    const ms = load().get(member)
    return ms !== undefined && live(ms, now()) ? ms : null
  }

  // Old rows included, so the deletion purge drops them too.
  function holds (member) {
    return load().has(member)
  }

  // Files (or refreshes) the member's request. -> its time.
  function record (member) {
    if (!isLowerHex(member, 32)) return Promise.reject(new TypeError('member must be a key'))
    return queued(() => {
      const rows = load()
      const t = now()
      dropOld(rows, t)
      rows.delete(member)
      while (rows.size >= max) {
        let oldest = null
        for (const [m, ms] of rows) if (oldest === null || ms < rows.get(oldest)) oldest = m
        rows.delete(oldest)
        log({ event: 'exclusao', reason: 'pedidos-cheio' })
      }
      rows.set(member, t)
      write(rows)
      return t
    })
  }

  function forget (member) {
    return queued(() => {
      const rows = load()
      if (!rows.delete(member)) return
      dropOld(rows, now())
      write(rows)
    })
  }

  function prune () {
    return queued(() => {
      const rows = load()
      if (dropOld(rows, now())) write(rows)
    })
  }

  return { available, requestedAt, holds, record, forget, prune }
}

module.exports = { openDeletionRequests, MAX_AGE_MS, MAX_REQUESTS, FILE }
