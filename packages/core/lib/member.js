'use strict'

// Member operations (identity, certificate, profile, posts, follows, log,
// feed and profile reads) over a member data directory. Each operation takes a context
// ctx = { dataDir, association = null, storeOptions } and returns the result
// object; nothing here writes to stdout or stderr (feedRead reports its
// warnings through onWarn).

const fs = require('#fs')
const path = require('#path')
const process = require('#process')
const b4a = require('b4a')
const { discoveryKey, randomBytes } = require('hypercore-crypto')
const { certForKey, verifyUsernameRecord } = require('./cert')
const { linkNew } = require('./link-new')
const { latestUsernameRecord, latestUsername } = require('./username')
const { verifySnapshot, blockedSet, revokedIssuerSet } = require('./blocklist')
const {
  decodeBlock,
  memberCertRecord,
  profileRecord,
  postRecord,
  followRecord,
  likeRecord,
  repostRecord,
  validRecordCopy,
  validateRecord,
  formatRef,
  latestProfile
} = require('./records')
const { followSet } = require('./media')
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
  writeFollows,
  readBlocklist
} = storeLib
const { buildFeed, shortKey } = require('./feed')
const { engagementState } = require('./engagement')
const { safe } = require('./safe')
const { UsageError } = require('./errors')

const HEX64 = /^[0-9a-fA-F]{64}$/
const GENESIS_REQUIRED = 'grave o certificado de membro antes de publicar'
const MEDIA_WEB_ONLY = 'mídia disponível só na versão web'
const PROFILE_PHOTO_WEB_ONLY = 'perfil com foto: mude o nome e a bio na versão web ou tire a foto'
const BAD_USERNAME_RECORD = 'registro de nome inválido'
const OLD_USERNAME_RECORD = 'registro de nome antigo'
const USERNAME_RECORD_KEYS = ['type', 'username', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']
const NO_LOCAL_DATA = 'sem dados locais para este diário'
const BLOCKED_AUTHOR = 'autor bloqueado'

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

// The moderation snapshot this node enforces (blocklist.json, written by
// sync.js after createBlocklistState adopted it): { blocked, revokedIssuers }
// as Sets, both empty when there is none. A stored snapshot that no longer
// verifies for the trust root is ignored, as runSync ignores it. A read
// failure other than a torn file throws (fail closed: never show a diary
// because the list could not be read).
function enforcedBlocklist (dataDir, association) {
  const stored = readBlocklist(dataDir)
  const snapshot = stored !== null && verifySnapshot(stored.snapshot, association).ok ? stored.snapshot : null
  return { blocked: blockedSet(snapshot), revokedIssuers: revokedIssuerSet(snapshot) }
}

// ---- id ----

// Publishes config.json only when it does not exist yet: a unique temp file
// linked into place (link-new.js), so a concurrent writer can never be clobbered.
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
      linkNew(tmp, file)
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
    // Block 0 can never be replaced: a certificate from an issuer the
    // association revoked (B2, R4) would leave the diary unusable forever.
    const { revokedIssuers } = enforcedBlocklist(ctx.dataDir, association)
    const r = certForKey(cert, ownHex, association, { revokedIssuers })
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

async function publish (ctx, record, check = null) {
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    if (check !== null) await check({ diary, ownHex })
    try {
      const seq = await appendRecord(diary, record)
      return { seq, ref: formatRef({ author: ownHex, seq }) }
    } catch (err) {
      if (err.code === 'INVALID_RECORD' && /genesis-required/.test(err.message)) throw new Error(GENESIS_REQUIRED)
      throw err
    }
  })
}

// Only the browser node writes media cores, so here a photo can only be
// removed (avatar null). Keeping it requires re-sending its descriptor, which
// the profile.set caller does not hold: a plain name/bio change would drop
// the photo, so it is refused instead.
async function profileSet (ctx, { name, bio, avatar }) {
  if (avatar !== undefined && avatar !== null) throw new UsageError(MEDIA_WEB_ONLY)
  const record = buildRecord(() => profileRecord({ name, bio: bio || '' }))
  const check = avatar === null
    ? null
    : async ({ diary }) => {
      if ((latestProfile(await readAll(diary)) || {}).avatar != null) throw new UsageError(PROFILE_PHOTO_WEB_ONLY)
    }
  const { seq } = await publish(ctx, record, check)
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

// to is the parsed { author, seq } reference of the quoted post (text only:
// the caller refuses media before anything opens).
async function postQuote (ctx, { to, text }) {
  if (!(to.seq >= 1)) throw new UsageError('referência inválida')
  return publish(ctx, buildRecord(() => postRecord({ text, quote: to })))
}

// ---- likes / reposts ----

// The seq and `on` of the last valid `type` record about `ref` (replayed in
// seq order, as engagementState does), or null when there never was one.
function lastEngagement (entries, type, ref) {
  let last = null
  for (const { seq, record } of entries) {
    if (record === null || typeof seq !== 'number' || seq < 1) continue
    const copy = validRecordCopy(record, seq)
    if (copy === null || copy.type !== type || formatRef(copy.to) !== ref) continue
    if (last === null || seq > last.seq) last = { seq, on: copy.on }
  }
  return last
}

// Idempotent toggle of one engagement -> { seq, on, changed }: when the own
// diary is already in the requested state nothing is written and seq is that
// of the existing effective record (null if none ever). Self-engagement is
// allowed. `to` is the parsed { author, seq } reference.
async function engagementSet (ctx, type, make, { to, on }) {
  if (!(to.seq >= 1)) throw new UsageError('referência inválida')
  return withIdentity(ctx, async ({ diary }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const last = lastEngagement(await readAll(diary), type, formatRef(to))
    if ((last !== null && last.on) === on) return { seq: last === null ? null : last.seq, on, changed: false }
    const record = buildRecord(() => make({ to, on }))
    try {
      return { seq: await appendRecord(diary, record), on, changed: true }
    } catch (err) {
      if (err.code === 'INVALID_RECORD' && /genesis-required/.test(err.message)) throw new Error(GENESIS_REQUIRED)
      throw err
    }
  })
}

function likeSet (ctx, params) {
  return engagementSet(ctx, 'like', likeRecord, params)
}

function repostSet (ctx, params) {
  return engagementSet(ctx, 'repost', repostRecord, params)
}

// Which of `refs` the own diary currently likes / reposts -> { liked,
// reposted }, each a subset of refs in request order.
async function engagementRead (ctx, { refs }) {
  return withIdentity(ctx, async ({ diary }) => {
    const state = engagementState(await readAll(diary))
    return {
      liked: refs.filter((ref) => state.liked.has(ref.toLowerCase())),
      reposted: refs.filter((ref) => state.reposted.has(ref.toLowerCase()))
    }
  })
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
    // A record from a revoked issuer (B2, R4) is invalid for every reader.
    const opts = { revokedIssuers: enforcedBlocklist(ctx.dataDir, association).revokedIssuers }
    if (!verifyUsernameRecord(record, ownHex, association, opts).ok) throw new Error(BAD_USERNAME_RECORD)
    const latest = latestUsernameRecord(await readAll(diary), ownHex, association, opts)
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
  return withIdentity(ctx, async ({ diary, ownHex, association }) => {
    if (author === ownHex) throw new Error('não é possível seguir a própria chave')
    // A blocked author cannot be followed (B2); unfollowing one stays possible.
    // An existing follow of an author blocked later is kept in follows.json,
    // so an unblock needs no new follow (sync.js skips it while blocked).
    if (follow && typeof author === 'string' && enforcedBlocklist(ctx.dataDir, association).blocked.has(author.toLowerCase())) {
      throw new UsageError(BLOCKED_AUTHOR)
    }
    const current = readFollows(ctx.dataDir)
    const listAgrees = follow === current.includes(author)
    // Block 0 exists: the diary must agree too. A retry after a failed
    // append finds follows.json already right and still writes the record.
    const diaryAgrees = diary.length === 0 || follow === followSet(await readAll(diary), ownHex).includes(author)
    if (listAgrees && diaryAgrees) return { follows: current, changed: false }
    // The inventory (own diary + follows) must fit a hello (MAX_INVENTORY).
    if (!listAgrees && follow && current.length >= MAX_INVENTORY - 1) throw new Error('limite de diários seguidos atingido')
    // Append first, then follows.json: a failed append leaves the local state
    // untouched, so a retry writes the record exactly once.
    if (!diaryAgrees) await appendRecord(diary, followRecord({ key: author, on: follow }))
    if (!listAgrees) writeFollows(ctx.dataDir, follow ? [...current, author] : current.filter((k) => k !== author))
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
    const association = trustRoot(ctx)
    const store = await openStore(ctx)
    try {
      const diary = await openDiary(store)
      key = author
      if (key === hex(diary.key)) {
        // The own diary is readable even when the association blocked it.
        entries = await readAll(diary)
      } else {
        // A blocked author answers exactly like a diary with no local data,
        // checked before anything is opened: a replica stored before the
        // block (sync.js purges it, but a run may not have happened yet) is
        // never read through this path.
        const { blocked, revokedIssuers } = enforcedBlocklist(ctx.dataDir, association)
        if (!HEX64.test(key) || blocked.has(key.toLowerCase())) throw new Error(NO_LOCAL_DATA)
        // Never create a core for a key with no local data (D).
        if (!(await store.storage.hasCore(discoveryKey(b4a.from(key.toLowerCase(), 'hex'))))) {
          throw new Error(NO_LOCAL_DATA)
        }
        const replica = await openReplica(store, key)
        entries = await readAll(replica)
        // An empty core must not linger in the main store.
        if (replica.contiguousLength === 0) await purgeReplica(store, key)
        // A diary certified by a revoked issuer is treated like a blocked
        // author (B2, R4). Other block-0 problems keep the raw read
        // (log.read is the diagnostic view of a stored log).
        if (revokedIssuers.size > 0 && revokedIssuerReason(entries, key.toLowerCase(), association, revokedIssuers)) {
          throw new Error(NO_LOCAL_DATA)
        }
      }
    } finally {
      await store.close()
    }
  }
  return { key, entries }
}

// ---- feed ----

// Whether block 0 of `entries` is a member certificate that fails ONLY
// because its issuer is revoked.
function revokedIssuerReason (entries, key, association, revokedIssuers) {
  const first = entries.length > 0 && entries[0].seq === 0 ? entries[0].record : null
  if (first === null || validateRecord(first, 0) !== null) return false
  return certForKey(first.cert, key, association, { revokedIssuers }).reason === 'revoked-issuer'
}

// Reason a followed log is not shown, or null when it is kept. A blocked key
// (B2) is reported 'blocked' before anything else; `revokedIssuers` makes a
// v2 certificate from a revoked issuer 'revoked-issuer' (cert.js).
function skipReason (core, entries, key, association, blocked = null, revokedIssuers = null) {
  if (blocked !== null && blocked.has(key)) return 'blocked'
  if (core.fork !== 0) return 'fork'
  if (entries.length === 0) return 'no-cert'
  const first = entries[0].record
  if (validateRecord(first, 0) !== null) return 'not-in-log'
  const r = certForKey(first.cert, key, association, { revokedIssuers })
  return r.ok ? null : r.reason
}

async function feedRead (ctx, { limit = Infinity, before = null, onWarn = () => {} } = {}) {
  const skipLog = (skippedLogs, key, reason) => {
    skippedLogs.push({ key, reason })
    onWarn('aviso: diário ' + shortKey(key) + ' ignorado (' + safe(reason) + ')')
  }
  return withIdentity(ctx, async ({ store, diary, ownHex, association }) => {
    const { blocked, revokedIssuers } = enforcedBlocklist(ctx.dataDir, association)
    // The own diary is always shown, even when the association blocked it.
    const kept = [{ key: ownHex, entries: await readAll(diary) }]
    const skippedLogs = []
    const incomplete = []
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
      // A blocked author is skipped before anything is opened (B2).
      if (blocked.has(key)) {
        skipLog(skippedLogs, key, 'blocked')
        continue
      }
      // Never create a core for a key with no local data (R5.4 a).
      if (!(await store.storage.hasCore(discoveryKey(b4a.from(key, 'hex'))))) {
        skipLog(skippedLogs, key, 'no-cert')
        continue
      }
      const replica = await openReplica(store, key)
      const entries = await readAll(replica)
      // The reason (fork check included) is computed BEFORE an empty core is
      // purged, so an empty forked replica is still reported 'fork'.
      const reason = skipReason(replica, entries, key, association, blocked, revokedIssuers)
      // Shown diaries with holes are reported so the app can keep syncing
      // them; read while the core is open (a closed one reports 0).
      if (reason === null && replica.length > replica.contiguousLength) incomplete.push(key)
      // An empty core must not linger in the main store.
      if (replica.contiguousLength === 0) await purgeReplica(store, key)
      if (reason === null) {
        kept.push({ key, entries })
      } else {
        skipLog(skippedLogs, key, reason)
      }
    }
    const built = buildFeed({ logs: kept, limit: limit || Infinity, association, revokedIssuers, before })
    for (const ref of built.future) onWarn('aviso: publicação ' + ref + ' ignorada (future)')
    return { items: built.items, skipped: skippedLogs, future: built.future, incomplete }
  })
}

// ---- profiles ----

// Profiles of `authors` (docs/rpc.md 5.21) -> { profiles, missing }, one entry
// per distinct lowercase key in first-occurrence order. An author is readable
// exactly when feedRead would show its diary: the own key always (even when
// blocked); any other key only with local data that passes skipReason (not
// blocked, no fork, a valid block-0 certificate, issuer not revoked). The
// admission is feedRead's, NOT logRead's: logRead keeps raw reads of forked or
// uncertified diaries as a diagnostic view, which must never become a source
// of names. `missing` never says why. One store open and one lock for the
// whole batch; a key with no local data never gets a core (R5.4 a).
async function profileRead (ctx, { authors }) {
  return withIdentity(ctx, async ({ store, diary, ownHex, association }) => {
    const { blocked, revokedIssuers } = enforcedBlocklist(ctx.dataDir, association)
    const keys = []
    const seen = new Set()
    for (const raw of authors) {
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
    const profiles = []
    const missing = []
    for (const key of keys) {
      let entries
      if (key === ownHex) {
        entries = await readAll(diary)
      } else {
        if (blocked.has(key) || !(await store.storage.hasCore(discoveryKey(b4a.from(key, 'hex'))))) {
          missing.push(key)
          continue
        }
        const replica = await openReplica(store, key)
        entries = await readAll(replica)
        // The reason (fork check included) is computed BEFORE an empty core
        // is purged, as feedRead does.
        const reason = skipReason(replica, entries, key, association, blocked, revokedIssuers)
        // An empty core must not linger in the main store.
        if (replica.contiguousLength === 0) await purgeReplica(store, key)
        if (reason !== null) {
          missing.push(key)
          continue
        }
      }
      const profile = latestProfile(entries)
      profiles.push({
        author: key,
        name: profile === null ? null : profile.name,
        bio: profile === null ? null : profile.bio,
        avatar: profile === null ? null : profile.avatar,
        username: latestUsername(entries, key, association, { revokedIssuers })
      })
    }
    return { profiles, missing }
  })
}

module.exports = {
  PROFILE_PHOTO_WEB_ONLY,
  GENESIS_REQUIRED,
  BAD_USERNAME_RECORD,
  BLOCKED_AUTHOR,
  enforcedBlocklist,
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
  postQuote,
  likeSet,
  repostSet,
  engagementRead,
  usernameAdd,
  followAdd,
  followRemove,
  followList,
  logRead,
  feedRead,
  profileRead
}
