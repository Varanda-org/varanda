// The browser node's counterpart of @varanda/core lib/store.js: opening the
// own diary and the replicas on Hypercore 10 over a ./node-storage.js
// storage, reading every block, appending a record within the diary limits,
// and the config / follows records (kept as JSON in the storage's key-value
// area instead of config.json / follows.json).
//
// Core names: 'diary' for the own diary, 'replica/<hex>' for a followed one.
// The own diary uses ./diary-options.js (compat mode: core.key is the signing
// public key, the key a member certificate names) and valueEncoding 'json'
// (stores exactly the JSON.stringify bytes, ./member.js); replicas are
// opened by key alone (no secret key, so never writable) and read raw.
const Hypercore = require('hypercore')
const b4a = require('b4a')
const { decodeBlock, validateRecord, MAX_BLOCK_BYTES, MAX_LOG_BLOCKS, MAX_LOG_BYTES } = require('@varanda/core/lib/records')
const { DIARY_OPTIONS } = require('./diary-options')

const DIARY = 'diary'
const HEX64 = /^[0-9a-fA-F]{64}$/

function replicaName (hex) {
  return 'replica/' + hex.toLowerCase()
}

// Opens (and on first use creates) the own diary: hypercore 10.38.2 generates
// and stores the key pair on an empty storage (lib/core.js:100,108).
async function openDiary (storage) {
  const core = new Hypercore(storage.core(DIARY), { ...DIARY_OPTIONS, valueEncoding: 'json' })
  await core.ready()
  if (!core.writable) {
    await core.close()
    throw new Error('diário sem par de chaves gravado')
  }
  return core
}

function diaryExists (storage) {
  return storage.hasCore(DIARY)
}

// Replicas are read-only: opened by key, so the storage never holds a secret.
async function openReplica (storage, hex) {
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new Error('chave inválida')
  const core = new Hypercore(storage.core(replicaName(hex)), b4a.from(hex.toLowerCase(), 'hex'), { valueEncoding: 'binary' })
  await core.ready()
  if (core.writable) {
    await core.close()
    throw new Error('chave do próprio diário')
  }
  return core
}

function replicaExists (storage, hex) {
  return storage.hasCore(replicaName(hex))
}

// Every file of the replica goes (the core must already be closed).
function purgeReplica (storage, hex) {
  return storage.deleteCore(replicaName(hex))
}

// As @varanda/core readAll: a decode failure is { seq, record: null }; a
// closed core is an error, never an empty log.
async function readAll (core) {
  if (core.closing) {
    const err = new Error('SESSION_CLOSED: cannot read from a closed session')
    err.code = 'SESSION_CLOSED'
    throw err
  }
  const entries = []
  for (let i = 0; i < core.contiguousLength; i++) {
    const block = await core.get(i, { wait: false, raw: true })
    entries.push({ seq: i, record: decodeBlock(block) })
  }
  return entries
}

// Block 0 as the Hypercore 11 side decodes it, or null.
async function readBlock0 (core) {
  if (core.contiguousLength < 1) return null
  return decodeBlock(await core.get(0, { wait: false, raw: true }))
}

function invalidRecord (reason) {
  const err = new Error('registro inválido: ' + reason)
  err.code = 'INVALID_RECORD'
  return err
}

const DEFAULT_LIMITS = Object.freeze({
  maxBlockBytes: MAX_BLOCK_BYTES,
  maxLogBlocks: MAX_LOG_BLOCKS,
  maxLogBytes: MAX_LOG_BYTES
})

// Per-core append queue: validation and append of one call complete before
// the next call computes its seq.
const appendQueues = new WeakMap()

function appendRecord (core, record, limits) {
  const prev = appendQueues.get(core) || Promise.resolve()
  const run = () => appendNow(core, record, { ...DEFAULT_LIMITS, ...limits })
  const next = prev.then(run, run)
  appendQueues.set(core, next.catch(() => {}))
  return next
}

// The storage limits of the own diary (protocol S3), exactly as
// @varanda/core appendNow: a seeder rejects and purges a diary over them.
async function appendNow (core, record, limits) {
  await core.ready()
  let plain = null
  try {
    plain = decodeBlock(b4a.from(JSON.stringify(record)))
  } catch {}
  if (plain === null) throw invalidRecord('malformed')
  const reason = validateRecord(plain, core.length)
  if (reason) throw invalidRecord(reason)
  const blockBytes = b4a.byteLength(JSON.stringify(plain))
  if (blockBytes > limits.maxBlockBytes ||
      core.length >= limits.maxLogBlocks ||
      core.byteLength + blockBytes > limits.maxLogBytes) {
    throw new Error('limite do diário atingido')
  }
  await core.append(plain)
  return core.length - 1
}

function readConfig (storage) {
  return storage.readJson('config')
}

function writeConfig (storage, config) {
  return storage.writeJson('config', config)
}

async function readFollows (storage) {
  const data = await storage.readJson('follows')
  return data && Array.isArray(data.follows) ? data.follows : []
}

function writeFollows (storage, list) {
  const follows = [...new Set(list.map((k) => k.toLowerCase()))].sort()
  return storage.writeJson('follows', { v: 1, follows })
}

module.exports = {
  DIARY,
  replicaName,
  openDiary,
  diaryExists,
  openReplica,
  replicaExists,
  purgeReplica,
  readAll,
  readBlock0,
  appendRecord,
  readConfig,
  writeConfig,
  readFollows,
  writeFollows
}
