'use strict'

// Member operations (identity, certificate, profile, posts, follows, log and
// feed) over a member data directory. Each operation takes a context
// ctx = { dataDir, association = null, storeOptions } and returns the result
// object; nothing here writes to stdout or stderr (feedRead reports its
// warnings through onWarn).

const fs = require('#fs')
const path = require('#path')
const process = require('#process')
const b4a = require('b4a')
const { discoveryKey, randomBytes } = require('hypercore-crypto')
const { certForKey, verifyUsernameRecord } = require('./cert')
const { latestUsernameRecord } = require('./username')
const {
  decodeBlock,
  memberCertRecord,
  profileRecord,
  postRecord,
  validateRecord,
  formatRef
} = require('./records')
const { MAX_INVENTORY } = require('./net')
// Called as storeLib.openStore so the store opening has a single seam.
const storeLib = require('./store')
const {
  storeExists,
  openDiary,
  openReplica,
  purgeReplica,
  readAll,
  appendRecord,
  readConfig,
  readFollows,
  writeFollows
} = storeLib
const { buildFeed, shortKey } = require('./feed')
const { safe } = require('./safe')
const { UsageError } = require('./errors')

const HEX64 = /^[0-9a-fA-F]{64}$/
const GENESIS_REQUIRED = 'grave o certificado de membro antes de publicar'
const BAD_USERNAME_RECORD = 'registro de nome inválido'
const OLD_USERNAME_RECORD = 'registro de nome antigo'
const USERNAME_RECORD_KEYS = ['type', 'username', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']

function hex (key) {
  return b4a.toString(key, 'hex')
}

function openStore (ctx) {
  return storeLib.openStore(ctx.dataDir, ctx.storeOptions)
}

// Exact structural equality of JSON values: objects compared by their own
// enumerable keys in any order (a '__proto__' key is plain data), arrays in
// order, primitives with ===.
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

// The trust root is fixed by `id create` and read from config.json only.
function trustRoot (ctx) {
  const config = readConfig(ctx.dataDir)
  if (config === null) throw new Error('identidade não encontrada')
  if (config.role !== 'member') throw new Error('diretório não é de um membro')
  if (ctx.association && ctx.association !== config.association) {
    throw new Error('associação diferente da configurada')
  }
  return config.association
}

// Opens the store and the diary, runs fn and always closes the store.
async function withIdentity (ctx, fn) {
  const association = trustRoot(ctx)
  const store = await openStore(ctx)
  try {
    const diary = await openDiary(store)
    return await fn({ store, diary, ownHex: hex(diary.key), association })
  } finally {
    await store.close()
  }
}

// ---- id ----

// Publishes config.json only when it does not exist yet: a unique temp file
// hard-linked into place, so a concurrent writer can never be clobbered.
// Returns false when another process published first (EEXIST).
function publishConfig (dataDir, config) {
  const file = path.join(dataDir, 'config.json')
  const tmp = file + '.' + process.pid + '.' + b4a.toString(randomBytes(6), 'hex') + '.tmp'
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.linkSync(tmp, file)
    } catch (err) {
      if (err.code === 'EEXIST') return false
      throw err
    }
    fsyncDir(path.dirname(file))
    return true
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

// Makes the new directory entry durable; only the errors of platforms that
// cannot open or fsync a directory are ignored (as lib/store.js does).
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

// Called with the store lock held: reads or fixes the trust root once.
function ensureMemberConfig (ctx) {
  let config = readConfig(ctx.dataDir)
  if (config === null) {
    if (!ctx.association) throw new UsageError('informe --association ou VARANDA_ASSOCIATION')
    const fresh = { v: 1, role: 'member', association: ctx.association }
    if (publishConfig(ctx.dataDir, fresh)) return fresh
    config = readConfig(ctx.dataDir)
  }
  if (config.role !== 'member') throw new Error('diretório não é de um membro')
  if (ctx.association && ctx.association !== config.association) {
    throw new Error('associação diferente da configurada')
  }
  return config
}

async function idCreate (ctx) {
  // Fail fast on usage before touching the data dir; re-checked under the lock.
  if (!ctx.association && readConfig(ctx.dataDir) === null) {
    throw new UsageError('informe --association ou VARANDA_ASSOCIATION')
  }
  // The store's RocksDB lock is taken FIRST, so config.json is only ever
  // read and written by the single process that holds the data dir.
  const store = await openStore(ctx)
  try {
    const config = ensureMemberConfig(ctx)
    const diary = await openDiary(store)
    return { publicKey: hex(diary.key), association: config.association }
  } finally {
    await store.close()
  }
}

async function idShow (ctx) {
  if (readConfig(ctx.dataDir) === null || !storeExists(ctx.dataDir)) {
    throw new Error('identidade não encontrada')
  }
  return withIdentity(ctx, ({ ownHex, association }) => ({ publicKey: ownHex, association }))
}

// ---- cert ----

// cert is the parsed JSON value of the certificate file.
async function certAdd (ctx, cert) {
  return withIdentity(ctx, async ({ diary, ownHex, association }) => {
    const r = certForKey(cert, ownHex, association)
    if (!r.ok) throw new Error('certificado inválido (' + r.reason + ')')
    if (diary.length > 0) {
      const block0 = decodeBlock(await diary.get(0, { wait: false, raw: true }))
      if (!deepEqual(block0, { type: 'member-cert', cert })) {
        throw new Error('certificado já gravado')
      }
      return { seq: 0 }
    }
    await appendRecord(diary, memberCertRecord(cert))
    return { seq: 0 }
  })
}

// ---- profile / post / reply ----

// Builds the record before opening anything; record validation errors are
// user-facing failures, not crashes.
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
      const seq = await appendRecord(diary, record)
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

// Appends an issuer-signed username record (docs/rpc.md 5.19) after
// verifying it for the own diary key and the trust root -> { changed, seq }.
// A record that already is the diary's latest verified one is not written
// again ({ changed: false }); one not newer (by `date`) than it is refused
// (OLD_USERNAME_RECORD): the newest record by seq is the displayed name, so
// an earlier name would revert a rename, and two records of the same instant
// cannot be ordered. A Hypercore 11 diary key is not the signing key, so the
// issuing service normally has no record for it.
async function usernameAdd (ctx, record) {
  return withIdentity(ctx, async ({ diary, ownHex, association }) => {
    if (!verifyUsernameRecord(record, ownHex, association).ok) throw new Error(BAD_USERNAME_RECORD)
    const latest = latestUsernameRecord(await readAll(diary), ownHex, association)
    if (latest !== null && deepEqual(latest, record)) return { changed: false, seq: null }
    if (latest !== null && record.date <= latest.date) throw new Error(OLD_USERNAME_RECORD)
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const copy = {}
    for (const k of USERNAME_RECORD_KEYS) copy[k] = record[k]
    try {
      return { changed: true, seq: await appendRecord(diary, copy) }
    } catch (err) {
      if (err.code === 'INVALID_RECORD' && /genesis-required/.test(err.message)) throw new Error(GENESIS_REQUIRED)
      throw err
    }
  })
}

// ---- follows ----

async function followChange (ctx, author, follow) {
  return withIdentity(ctx, ({ ownHex }) => {
    if (author === ownHex) throw new Error('não é possível seguir a própria chave')
    const current = readFollows(ctx.dataDir)
    const has = current.includes(author)
    if (follow === has) return { follows: current, changed: false }
    // The inventory (own diary + follows) must fit a hello (MAX_INVENTORY).
    if (follow && current.length >= MAX_INVENTORY - 1) throw new Error('limite de diários seguidos atingido')
    const next = follow ? [...current, author] : current.filter((k) => k !== author)
    writeFollows(ctx.dataDir, next)
    return { follows: readFollows(ctx.dataDir), changed: true }
  })
}

function followAdd (ctx, author) {
  return followChange(ctx, author, true)
}

function followRemove (ctx, author) {
  return followChange(ctx, author, false)
}

async function followList (ctx) {
  trustRoot(ctx)
  return { follows: readFollows(ctx.dataDir) }
}

// ---- log ----

async function logRead (ctx, { author = null } = {}) {
  let key
  let entries
  if (!author) {
    ;({ key, entries } = await withIdentity(ctx, async ({ diary, ownHex }) => ({
      key: ownHex,
      entries: await readAll(diary)
    })))
  } else {
    trustRoot(ctx)
    const store = await openStore(ctx)
    try {
      const diary = await openDiary(store)
      key = author
      if (key === hex(diary.key)) {
        entries = await readAll(diary)
      } else {
        // Never create a core for a key with no local data (D).
        if (!HEX64.test(key) || !(await store.storage.hasCore(discoveryKey(b4a.from(key.toLowerCase(), 'hex'))))) {
          throw new Error('sem dados locais para este diário')
        }
        const replica = await openReplica(store, key)
        entries = await readAll(replica)
        // An empty core must not linger in the main store.
        if (replica.contiguousLength === 0) await purgeReplica(store, key)
      }
    } finally {
      await store.close()
    }
  }
  return { key, entries }
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

async function feedRead (ctx, { limit = Infinity, onWarn = () => {} } = {}) {
  const skipLog = (skippedLogs, key, reason) => {
    skippedLogs.push({ key, reason })
    onWarn('aviso: diário ' + shortKey(key) + ' ignorado (' + safe(reason) + ')')
  }
  return withIdentity(ctx, async ({ store, diary, ownHex, association }) => {
    const kept = [{ key: ownHex, entries: await readAll(diary) }]
    const skippedLogs = []
    const seen = new Set([ownHex])
    for (const raw of readFollows(ctx.dataDir)) {
      // Entries are hand-editable: skip the own key, bad entries and duplicates.
      if (typeof raw !== 'string' || !HEX64.test(raw)) {
        onWarn('aviso: entrada inválida em follows.json ignorada (' + safe(String(raw).slice(0, 80)) + ')')
        continue
      }
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      // Never create a core for a key with no local data (R5.4 a).
      if (!(await store.storage.hasCore(discoveryKey(b4a.from(key, 'hex'))))) {
        skipLog(skippedLogs, key, 'no-cert')
        continue
      }
      const replica = await openReplica(store, key)
      const entries = await readAll(replica)
      // The reason (fork check included) is computed BEFORE an empty core is
      // purged, so an empty forked replica is still reported 'fork'.
      const reason = skipReason(replica, entries, key, association)
      // An empty core must not linger in the main store.
      if (replica.contiguousLength === 0) await purgeReplica(store, key)
      if (reason === null) {
        kept.push({ key, entries })
      } else {
        skipLog(skippedLogs, key, reason)
      }
    }
    const built = buildFeed({ logs: kept, limit: limit || Infinity, association })
    for (const ref of built.future) onWarn('aviso: publicação ' + ref + ' ignorada (future)')
    return { items: built.items, skipped: skippedLogs, future: built.future }
  })
}

module.exports = {
  GENESIS_REQUIRED,
  BAD_USERNAME_RECORD,
  trustRoot,
  withIdentity,
  ensureMemberConfig,
  publishConfig,
  fsyncDir,
  deepEqual,
  idCreate,
  idShow,
  certAdd,
  profileSet,
  postCreate,
  postReply,
  usernameAdd,
  followAdd,
  followRemove,
  followList,
  logRead,
  feedRead
}
