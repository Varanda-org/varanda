'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isLowerHex, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { endpointHash } = require('@varanda/core/lib/push-proof')
const { PUSH_MAX_PER_MEMBER, MAX_MEMBERS } = require('./push-store')
const { writeGuarded, held } = require('./guarded-write')

const FILE = 'push-caps.json'
const MAX_BYTES = 64 * 1024 * 1024

function validCaps (caps) {
  return Array.isArray(caps) && (caps.length === 0 || (caps.length === 1 && caps[0] === 'seen-sync'))
}

function unavailable () {
  return Object.assign(new Error('indisponivel'), { code: 'indisponivel' })
}

function empty () {
  return { v: 1, members: {} }
}

function validState (state) {
  if (!isPlainObject(state) || Object.keys(state).sort().join(',') !== 'members,v' || state.v !== 1 || !isPlainObject(state.members)) return false
  const members = Object.entries(state.members)
  return members.length <= MAX_MEMBERS && members.every(([member, rows]) => {
    if (!isLowerHex(member, 32) || !isPlainObject(rows)) return false
    const entries = Object.entries(rows)
    return entries.length > 0 && entries.length <= PUSH_MAX_PER_MEMBER &&
      entries.every(([hash, caps]) => isLowerHex(hash, 32) && validCaps(caps) && caps.length === 1)
  })
}

// Disk is authoritative: a stale process must not restore a removed capability.
function openPushCapsStore (dataDir, { readOnly = false, guard = () => true } = {}) {
  refuseSymlinkDir(dataDir)
  const file = path.join(dataDir, FILE)
  let failed = false
  let tail = Promise.resolve()

  function read () {
    if (failed) throw unavailable()
    try {
      let stat
      try { stat = fs.lstatSync(file) } catch (err) {
        if (err.code === 'ENOENT') return empty()
        throw err
      }
      if (!stat.isFile() || stat.size > MAX_BYTES) throw unavailable()
      const state = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!validState(state)) throw unavailable()
      return state
    } catch {
      failed = true
      throw unavailable()
    }
  }

  try { read() } catch {}

  function mutate (fn) {
    const work = tail.then(() => {
      if (readOnly || !held(guard)) throw unavailable()
      const state = read()
      const before = JSON.stringify(state)
      fn(state.members)
      if (!validState(state)) throw Object.assign(new Error('limite'), { code: 'limite' })
      if (JSON.stringify(state) === before) return { changed: false }
      try {
        writeGuarded(file, state, 0o600, guard)
        if (!held(guard)) throw unavailable()
      } catch {
        throw unavailable()
      }
      return { changed: true }
    })
    tail = work.catch(() => {})
    return work
  }

  function check (member, hash) {
    if (!isLowerHex(member, 32) || (hash !== undefined && !isLowerHex(hash, 32))) throw new TypeError('invalid capability key')
  }

  function put ({ member, hash, caps }) {
    check(member, hash)
    if (hash === undefined || !validCaps(caps)) throw new TypeError('invalid capabilities')
    const copy = caps.slice()
    return mutate((members) => {
      if (copy.length === 0) {
        if (members[member]) {
          delete members[member][hash]
          if (Object.keys(members[member]).length === 0) delete members[member]
        }
      } else {
        if (!members[member]) members[member] = {}
        members[member][hash] = copy
      }
    })
  }

  function get (member, hash) {
    check(member, hash)
    return (read().members[member]?.[hash] || []).slice()
  }

  function remove ({ member, hash }) {
    return put({ member, hash, caps: [] })
  }

  function removeAll (member) {
    check(member)
    return mutate((members) => { delete members[member] })
  }

  function prune (subscriptions) {
    const live = new Set(subscriptions.map((s) => s.member + ' ' + endpointHash(s.endpoint)))
    return mutate((members) => {
      for (const [member, rows] of Object.entries(members)) {
        for (const hash of Object.keys(rows)) if (!live.has(member + ' ' + hash)) delete rows[hash]
        if (Object.keys(rows).length === 0) delete members[member]
      }
    })
  }

  return {
    put,
    get,
    remove,
    removeAll,
    prune,
    holds (member) { check(member); return Object.hasOwn(read().members, member) },
    available () { try { read(); return true } catch { return false } },
    fail () { failed = true }
  }
}

module.exports = { openPushCapsStore, validCaps, FILE, MAX_BYTES }
