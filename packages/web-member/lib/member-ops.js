// Member operations of the browser node (identity, certificate, profile,
// posts, follows, log and feed), the counterpart of @varanda/core
// lib/member.js over a ./node-storage.js storage and Hypercore 10. Same
// results, same pt-BR error messages, same rules; what differs is only where
// things live (the storage's key-value area instead of config.json and
// follows.json, storage cores instead of a corestore).
//
// ctx = { storage, association = null, keyPair = null, limits } (keyPair: the
// session's in-memory key pair, null while the identity is locked; reads
// work locked, writes need it, ./node-store.js openDiary; limits: test-only
// overrides of the diary limits, ./node-store.js appendRecord). Nothing here
// talks to the network.
const b4a = require('b4a')
const { certForKey } = require('@varanda/core/lib/cert')
const {
  decodeBlock,
  memberCertRecord,
  profileRecord,
  postRecord,
  validateRecord,
  formatRef
} = require('@varanda/core/lib/records')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { buildFeed } = require('@varanda/core/lib/feed')
const { UsageError } = require('@varanda/core/lib/errors')
const store = require('./node-store')

const HEX64 = /^[0-9a-fA-F]{64}$/
const GENESIS_REQUIRED = 'grave o certificado de membro antes de publicar'

function hex (key) {
  return b4a.toString(key, 'hex')
}

// Exact structural equality of JSON values (@varanda/core member.js).
function deepEqual (a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const arrA = Array.isArray(a)
  if (arrA !== Array.isArray(b)) return false
  if (arrA) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}

// The trust root is fixed by identity creation and read from 'config' only.
async function trustRoot (ctx) {
  const config = await store.readConfig(ctx.storage)
  if (config === null) throw new Error('identidade não encontrada')
  if (config.role !== 'member') throw new Error('diretório não é de um membro')
  if (ctx.association && ctx.association !== config.association) {
    throw new Error('associação diferente da configurada')
  }
  return config.association
}

function keyPairOf (ctx) {
  return ctx.keyPair === undefined ? null : ctx.keyPair
}

// Opens the own diary (unlocked when ctx holds the key pair), runs fn and
// always closes it.
async function withIdentity (ctx, fn) {
  const association = await trustRoot(ctx)
  if (!(await store.diaryExists(ctx.storage))) throw new Error('identidade não encontrada')
  const diary = await store.openDiary(ctx.storage, keyPairOf(ctx))
  try {
    return await fn({ diary, ownHex: hex(diary.key), association })
  } finally {
    await diary.close()
  }
}

// ---- id ----

// Creates the diary for the session key pair (the trust root first), or
// opens the existing one; creating needs the pair, opening does not.
async function idCreate (ctx) {
  let config = await store.readConfig(ctx.storage)
  if (config === null) {
    if (!ctx.association) throw new UsageError('informe a associação')
    config = { v: 1, role: 'member', association: ctx.association }
    await store.writeConfig(ctx.storage, config)
  }
  if (config.role !== 'member') throw new Error('diretório não é de um membro')
  if (ctx.association && ctx.association !== config.association) {
    throw new Error('associação diferente da configurada')
  }
  const keyPair = keyPairOf(ctx)
  const existed = await store.diaryExists(ctx.storage)
  if (keyPair === null && !existed) throw new UsageError(store.LOCKED)
  const diary = await store.openDiary(ctx.storage, keyPair)
  try {
    // created: the diary was made now, for this pair (so it is not legacy).
    return { publicKey: hex(diary.key), association: config.association, created: !existed }
  } finally {
    await diary.close()
  }
}

async function idShow (ctx) {
  if ((await store.readConfig(ctx.storage)) === null || !(await store.diaryExists(ctx.storage))) {
    throw new Error('identidade não encontrada')
  }
  return withIdentity(ctx, ({ ownHex, association }) => ({ publicKey: ownHex, association }))
}

// -> { publicKey, memberCert } without creating anything.
async function identityState (ctx) {
  if ((await store.readConfig(ctx.storage)) === null || !(await store.diaryExists(ctx.storage))) {
    return { publicKey: null, memberCert: false }
  }
  return withIdentity(ctx, async ({ diary, ownHex, association }) => {
    const block0 = await store.readBlock0(diary)
    const ok = block0 !== null && validateRecord(block0, 0) === null && certForKey(block0.cert, ownHex, association).ok
    return { publicKey: ownHex, memberCert: ok }
  })
}

// ---- cert ----

async function certAdd (ctx, cert) {
  return withIdentity(ctx, async ({ diary, ownHex, association }) => {
    const r = certForKey(cert, ownHex, association)
    if (!r.ok) throw new Error('certificado inválido (' + r.reason + ')')
    if (diary.length > 0) {
      const block0 = decodeBlock(await diary.get(0, { wait: false, raw: true }))
      if (!deepEqual(block0, { type: 'member-cert', cert })) {
        throw new Error('certificado já gravado')
      }
      return { seq: 0, appended: false }
    }
    await store.appendRecord(diary, memberCertRecord(cert), ctx.limits)
    return { seq: 0, appended: true }
  })
}

// ---- profile / post / reply ----

function buildRecord (make) {
  try {
    return make()
  } catch (err) {
    throw new Error('registro inválido: ' + err.message)
  }
}

async function publish (ctx, record) {
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    try {
      const seq = await store.appendRecord(diary, record, ctx.limits)
      return { seq, ref: formatRef({ author: ownHex, seq }) }
    } catch (err) {
      if (err.code === 'INVALID_RECORD' && /genesis-required/.test(err.message)) throw new Error(GENESIS_REQUIRED)
      throw err
    }
  })
}

async function profileSet (ctx, { name, bio }) {
  const record = buildRecord(() => profileRecord({ name, bio: bio || '' }))
  const { seq } = await publish(ctx, record)
  return { seq }
}

async function postCreate (ctx, { text }) {
  return publish(ctx, buildRecord(() => postRecord({ text })))
}

// to is the parsed { author, seq } reference.
async function postReply (ctx, { to, text }) {
  if (!(to.seq >= 1)) throw new UsageError('referência inválida')
  return publish(ctx, buildRecord(() => postRecord({ text, replyTo: to })))
}

// ---- username ----

const USERNAME_RECORD_KEYS = ['type', 'username', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']

// Appends a plain copy of an issuer-signed username record (the caller,
// lib/session.js username.add, has verified it for the own key) -> { seq }.
async function usernameAdd (ctx, record) {
  const copy = {}
  for (const k of USERNAME_RECORD_KEYS) copy[k] = record[k]
  const { seq } = await publish(ctx, copy)
  return { seq }
}

// The own diary's entries ({ seq, record }), for the "already the latest
// username record" check of username.add.
async function ownEntries (ctx) {
  return withIdentity(ctx, async ({ diary, ownHex }) => ({ key: ownHex, entries: await store.readAll(diary) }))
}

// ---- follows ----

async function followChange (ctx, author, follow) {
  return withIdentity(ctx, async ({ ownHex }) => {
    if (author === ownHex) throw new Error('não é possível seguir a própria chave')
    const current = await store.readFollows(ctx.storage)
    const has = current.includes(author)
    if (follow === has) return { follows: current, changed: false }
    // The inventory (own diary + follows) must fit a hello (MAX_INVENTORY).
    if (follow && current.length >= MAX_INVENTORY - 1) throw new Error('limite de diários seguidos atingido')
    const next = follow ? [...current, author] : current.filter((k) => k !== author)
    await store.writeFollows(ctx.storage, next)
    return { follows: await store.readFollows(ctx.storage), changed: true }
  })
}

function followAdd (ctx, author) {
  return followChange(ctx, author, true)
}

function followRemove (ctx, author) {
  return followChange(ctx, author, false)
}

async function followList (ctx) {
  await trustRoot(ctx)
  return { follows: await store.readFollows(ctx.storage) }
}

// ---- log ----

// Reads a replica that has local data, or throws 'sem dados locais para este
// diário' without creating anything; an empty replica is purged (D).
async function readReplica (ctx, key) {
  if (!HEX64.test(key) || !(await store.replicaExists(ctx.storage, key))) {
    throw new Error('sem dados locais para este diário')
  }
  const replica = await store.openReplica(ctx.storage, key)
  let entries
  let empty
  try {
    entries = await store.readAll(replica)
    empty = replica.contiguousLength === 0
  } finally {
    await replica.close()
  }
  if (empty) await store.purgeReplica(ctx.storage, key)
  return entries
}

async function logRead (ctx, { author = null } = {}) {
  const own = await withIdentity(ctx, async ({ diary, ownHex }) => ({ key: ownHex, entries: author && author !== ownHex ? null : await store.readAll(diary) }))
  if (own.entries !== null) return own
  return { key: author, entries: await readReplica(ctx, author.toLowerCase()) }
}

// ---- feed ----

// Reason a followed log is not shown, or null when it is kept.
function skipReason (core, entries, key, association) {
  if (core.fork !== 0) return 'fork'
  if (entries.length === 0) return 'no-cert'
  const first = entries[0].record
  if (validateRecord(first, 0) !== null) return 'not-in-log'
  const r = certForKey(first.cert, key, association)
  return r.ok ? null : r.reason
}

async function feedRead (ctx, { limit = Infinity } = {}) {
  const association = await trustRoot(ctx)
  const own = await withIdentity(ctx, async ({ diary, ownHex }) => ({ key: ownHex, entries: await store.readAll(diary) }))
  const kept = [own]
  const skipped = []
  const seen = new Set([own.key])
  for (const raw of await store.readFollows(ctx.storage)) {
    if (typeof raw !== 'string' || !HEX64.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    // Never create a core for a key with no local data (R5.4 a).
    if (!(await store.replicaExists(ctx.storage, key))) {
      skipped.push({ key, reason: 'no-cert' })
      continue
    }
    const replica = await store.openReplica(ctx.storage, key)
    let entries
    let reason
    let empty
    try {
      entries = await store.readAll(replica)
      reason = skipReason(replica, entries, key, association)
      empty = replica.contiguousLength === 0
    } finally {
      await replica.close()
    }
    // An empty core must not linger in the storage.
    if (empty) await store.purgeReplica(ctx.storage, key)
    if (reason === null) kept.push({ key, entries })
    else skipped.push({ key, reason })
  }
  const built = buildFeed({ logs: kept, limit: limit || Infinity, association })
  return { items: built.items, skipped, future: built.future }
}

module.exports = {
  GENESIS_REQUIRED,
  deepEqual,
  trustRoot,
  withIdentity,
  idCreate,
  idShow,
  identityState,
  certAdd,
  profileSet,
  postCreate,
  postReply,
  usernameAdd,
  ownEntries,
  followAdd,
  followRemove,
  followList,
  logRead,
  feedRead,
  skipReason
}
