'use strict'

// The local direct message store (docs/protocol.md section 11 "Local
// storage"): a local-only core, 'dm-local' (./node-store.js openDmLocal),
// whose every block is { v: 1, nonce: hex48, box: base64 }, the
// crypto_secretbox (@varanda/core lib/group-crypto.js sealRecord) of one
// compact JSON row under the key derived from the passkey PRF
// (passkey.js dmLocalKeyFromPrf). A row is a message
// { t: 'msg', id, peer, from, text, replyTo, at, mine, filedAt } or an op
// { t: 'ctl', id, op, peer, at, filedAt } (id: the ctl envelope's, so a
// device that pulls its own ctl back does not file it twice). Before sealing,
// a row gets a `pad` of spaces so its JSON is a multiple of ROW_BUCKET bytes:
// the block length says neither the text length (within a bucket) nor msg
// from ctl. The core's own signing pair derives
// from the same key, so nothing in the storage can append or read without
// the passkey. While locked nothing is readable: unlock() decrypts every
// block into memory once, lock() drops it and zeroes the key.
//
// Delete is an op row plus the fold rule (@varanda/core lib/dm-fold.js drops
// what was filed at or before it): the ciphertext of deleted messages stays
// in the core until a later compaction, which is not done here.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const gc = require('@varanda/core/lib/group-crypto')
const { DM_OPS } = require('@varanda/core/lib/dm')
const store = require('./node-store')

const CORE_SEED_DOMAIN = b4a.from('varanda/member-dm-local/core/v1\n', 'utf8')
const SEEN_DOMAIN = b4a.from('varanda/member-dm-local/seen/v1\n', 'utf8')
const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const LOCKED = 'identidade bloqueada: entre com a passkey'
const ROW_BUCKET = 1024

function validRow (r) {
  if (r === null || typeof r !== 'object' || !HEX64.test(r.peer) || typeof r.at !== 'string') return false
  if (!Number.isFinite(r.filedAt)) return false
  if (r.t === 'ctl') return DM_OPS.includes(r.op) && HEX32.test(r.id)
  if (r.t !== 'msg') return false
  return HEX32.test(r.id) && HEX64.test(r.from) && typeof r.text === 'string' &&
    (r.replyTo === null || HEX32.test(r.replyTo)) && typeof r.mine === 'boolean'
}

function plainRow (r) {
  if (r.t === 'ctl') return { t: 'ctl', id: r.id, op: r.op, peer: r.peer, at: r.at, filedAt: r.filedAt }
  return { t: 'msg', id: r.id, peer: r.peer, from: r.from, text: r.text, replyTo: r.replyTo, at: r.at, mine: r.mine, filedAt: r.filedAt }
}

// The row with `pad` last, its JSON rounded up to a ROW_BUCKET multiple.
function padded (row) {
  const base = b4a.byteLength(JSON.stringify({ ...row, pad: '' }))
  const size = Math.ceil(base / ROW_BUCKET) * ROW_BUCKET
  return { ...row, pad: ' '.repeat(size - base) }
}

function createDmStore ({ storage } = {}) {
  if (storage === null || typeof storage !== 'object') throw new TypeError('storage required')
  let key = null
  let corePair = null
  let rows = null
  let lastFiled = 0
  let generation = 0
  let queue = Promise.resolve()

  function serial (fn) {
    const p = queue.then(fn)
    queue = p.catch(() => {})
    return p
  }

  function wipe () {
    if (key !== null) key.fill(0)
    if (corePair !== null) {
      corePair.secretKey.fill(0)
      corePair.publicKey.fill(0)
    }
    key = null
    corePair = null
    rows = null
    lastFiled = 0
  }

  async function withCore (fn) {
    const core = await store.openDmLocal(storage, corePair)
    if (core === null) return null
    try {
      return await fn(core)
    } finally {
      await core.close()
    }
  }

  // localKey: 32 bytes, copied. A stored core of another key (another
  // identity, or a reset elsewhere) cannot be read with this key and is
  // replaced by an empty one.
  function unlock (localKey) {
    if (!(localKey instanceof Uint8Array) || localKey.byteLength !== 32) throw new TypeError('chave inválida')
    const copy = new Uint8Array(32)
    copy.set(localKey)
    const gen = ++generation
    return serial(async () => {
      wipe()
      if (gen !== generation) {
        copy.fill(0)
        return
      }
      const seed = crypto.hash([CORE_SEED_DOMAIN, copy])
      const pair = crypto.keyPair(seed)
      seed.fill(0)
      key = copy
      corePair = pair
      try {
        await load(gen)
      } catch (err) {
        if (key === copy) wipe()
        throw err
      }
      // A superseded unlock leaves nothing of its own behind.
      if (gen !== generation && key === copy) wipe()
    })
  }

  async function load (gen) {
    let loaded = await withCore(async (core) => {
      const out = []
      for (let i = 0; i < core.length; i++) {
        const block = await core.get(i, { wait: false })
        if (block === null || typeof block !== 'object' || block.v !== 1) continue
        const row = gc.openRecord({ nonce: block.nonce, box: block.box }, key)
        if (row !== null && validRow(row)) out.push(plainRow(row))
      }
      return out
    })
    // Only the current unlock may replace a core of another key.
    if (gen !== generation) return
    if (loaded === null) {
      await store.deleteDmLocal(storage)
      loaded = []
    }
    if (gen !== generation) return
    rows = loaded
    for (const r of rows) if (r.filedAt > lastFiled) lastFiled = r.filedAt
  }

  function lock () {
    generation++
    wipe()
  }

  function unlocked () {
    return rows !== null
  }

  // A monotonic local filing time in ms.
  function nextFiled (now = Date.now()) {
    lastFiled = Math.max(Math.floor(now), lastFiled + 1)
    return lastFiled
  }

  // Seals and appends the rows (one block each), then adds them to memory.
  function append (list) {
    const gen = generation
    return serial(async () => {
      if (rows === null || gen !== generation) throw new Error(LOCKED)
      const clean = list.map(plainRow)
      if (!clean.every(validRow)) throw new TypeError('linha inválida')
      const blocks = clean.map((r) => ({ v: 1, ...gc.sealRecord(padded(r), key) }))
      const ok = await withCore(async (core) => {
        await core.append(blocks)
        return true
      })
      if (ok === null) throw new Error('armazenamento de mensagens inválido')
      if (gen !== generation || rows === null) return
      for (const r of clean) rows.push(r)
    })
  }

  // -> { messages, ops } as copies; throws while locked.
  function snapshot () {
    if (rows === null) throw new Error(LOCKED)
    return {
      messages: rows.filter((r) => r.t === 'msg').map(plainRow),
      ops: rows.filter((r) => r.t === 'ctl').map(plainRow)
    }
  }

  function hasMessage (from, id) {
    if (rows === null) return false
    return rows.some((r) => r.t === 'msg' && r.from === from && r.id === id)
  }

  function hasOp (id) {
    if (rows === null) return false
    return rows.some((r) => r.t === 'ctl' && r.id === id)
  }

  // The kv dmSeen token of a seen key: keyed by the local store key, so a
  // reader of kv without the passkey learns no sender.
  function seenToken (keyString) {
    if (key === null) throw new Error(LOCKED)
    return b4a.toString(crypto.hash([SEEN_DOMAIN, key, b4a.from(keyString, 'utf8')]), 'hex').slice(0, 32)
  }

  // A small kv value (the stamp wallet, the ctl queue) sealed under the same
  // local key -> { nonce, box }; throws while locked.
  function seal (value) {
    if (key === null) throw new Error(LOCKED)
    return gc.sealRecord(value, key)
  }

  // -> the value or null (wrong key, tampered); throws while locked.
  function open (sealed) {
    if (key === null) throw new Error(LOCKED)
    return gc.openRecord(sealed, key)
  }

  function idle () {
    return queue
  }

  function close () {
    lock()
    return queue
  }

  return { unlock, lock, unlocked, nextFiled, append, snapshot, hasMessage, hasOp, seenToken, seal, open, idle, close }
}

module.exports = { createDmStore }
