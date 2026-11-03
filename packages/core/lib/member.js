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
  groupJoinRecord,
  groupCutRecord,
  groupConfirmRecord,
  deleteRecord,
  validRecordCopy,
  validateRecord,
  formatRef,
  latestProfile,
  nowIso,
  MAX_LOG_BLOCKS,
  MAX_LOG_BYTES
} = require('./records')
const { followSet, latestMediaCores } = require('./media')
const { deletedSeqs, applyDeletes, liveMediaRefs, overlaps, presentState, clearDeleted, tombstoneAt } = require('./deletion')
const { MAX_INVENTORY } = require('./net')
// Called as storeLib.openStore so the store opening has a single seam.
const storeLib = require('./store')
const {
  storeExists,
  openDiary,
  openReplica,
  openGroupWriter,
  readGroups,
  writeGroups,
  replicaStored,
  purgeReplica,
  readAll,
  readRaw,
  readBlocks,
  appendRecord,
  appendRecords,
  readConfig,
  readFollows,
  writeFollows,
  readBlocklist
} = storeLib
const { buildFeed, shortKey } = require('./feed')
const { engagementState } = require('./engagement')
const { safe } = require('./safe')
const { UsageError } = require('./errors')
const groups = require('./group')
const groupCrypto = require('./group-crypto')
const { recordBoundRoot } = require('./sync')
const { COMMUNITY_LIST_MAX } = require('@varanda/rpc')

const HEX64 = /^[0-9a-fA-F]{64}$/
const GENESIS_REQUIRED = 'grave o certificado de membro antes de publicar'
const GROUP_FULL = 'limite do grupo atingido'
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

// Rollout kill switch: VARANDA_NO_CLEAR=1 keeps the bytes of deleted blocks
// (only the tombstone is written).
function clearingOff (ctx) {
  return ctx.noClear === true || (process.env || {}).VARANDA_NO_CLEAR === '1'
}

// Data dirs whose own diary was reconciled by this process.
const reconciled = new Set()

// Clears the own blocks the fold hides but this store still holds: a clear
// interrupted after its tombstone was appended, or a tombstone that arrived
// from elsewhere. Once per data dir and process; a failed clear is retried
// at the next open.
async function reconcileOwn (ctx, diary) {
  const dir = path.resolve(ctx.dataDir)
  if (reconciled.has(dir) || clearingOff(ctx)) return
  try {
    const { deleted } = await presentState(diary)
    if (await clearedAll(diary, deleted)) reconciled.add(dir)
  } catch {}
}

// clearDeleted skips a block it cannot read without throwing, so success is
// read back: true only when every deleted seq is gone, block 0 or a tombstone
// (both never cleared).
async function clearedAll (diary, deleted) {
  try {
    await clearDeleted(diary, deleted)
    for (const seq of deleted) {
      if (seq < 1 || seq >= diary.length || !(await diary.has(seq))) continue
      if (!(await tombstoneAt(diary, seq))) return false
    }
    return true
  } catch {
    return false
  }
}

// Opens the store and the diary, runs fn and always closes the store.
async function withIdentity (ctx, fn) {
  const association = trustRoot(ctx)
  const store = await openStore(ctx)
  try {
    const diary = await openDiary(store)
    await reconcileOwn(ctx, diary)
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

// ---- delete ----

const BAD_REF = 'referência inválida'
const NOT_A_POST = 'o registro não é uma publicação'
const NOT_A_PROFILE = 'o registro não é um perfil'
const NOT_DELETABLE = 'não é possível apagar este registro'

// The valid record of block `seq` as written, or null.
function recordAt (raw, seq) {
  const entry = raw[seq]
  if (!(seq >= 1) || entry === undefined || entry.record === null) return null
  return validRecordCopy(entry.record, seq)
}

// profileRecords writes a plain block followed by the same version with the
// avatar; only that order pairs, so two versions saved in the same
// millisecond never merge.
function isCompatPair (plain, withAvatar) {
  return plain !== null && withAvatar !== null &&
    plain.type === 'profile' && withAvatar.type === 'profile' &&
    plain.avatar === undefined && withAvatar.avatar !== undefined &&
    plain.name === withAvatar.name && plain.bio === withAvatar.bio && plain.at === withAvatar.at
}

// On the unfolded diary, so a half-deleted pair is still recognized as one
// version.
function targetedSeqs (raw, seq, copy) {
  if (copy.type !== 'profile') return [seq]
  if (copy.avatar === undefined) {
    if (isCompatPair(copy, recordAt(raw, seq + 1))) return [seq, seq + 1]
  } else if (isCompatPair(recordAt(raw, seq - 1), copy)) {
    return [seq - 1, seq]
  }
  return [seq]
}

// The version of a cleared profile block, read from its tombstones: the pair
// writer appends both tombstones in one append, in seq order and with one
// `at`, so only consecutive tombstones of seq n then n + 1 carrying the same
// `at` are taken as one pair. Two separate deletions of adjacent versions
// stay apart.
function clearedVersion (raw, deleted, seq) {
  const t = tombstoneOf(raw, deleted, [seq])
  if (t === null) return [seq]
  const tomb = (i) => {
    const copy = deleted.has(i) ? null : recordAt(raw, i)
    return copy !== null && copy.type === 'delete' ? copy : null
  }
  const own = tomb(t)
  const next = tomb(t + 1)
  if (next !== null && next.seq === seq + 1 && next.at === own.at) return [seq, seq + 1]
  const prev = tomb(t - 1)
  if (prev !== null && prev.seq === seq - 1 && prev.at === own.at) return [seq - 1, seq]
  return [seq]
}

// The highest effective tombstone that targets one of `seqs`, or null.
function tombstoneOf (raw, deleted, seqs) {
  for (let i = raw.length - 1; i >= 1; i--) {
    if (deleted.has(i)) continue
    const copy = recordAt(raw, i)
    if (copy !== null && copy.type === 'delete' && seqs.includes(copy.seq)) return i
  }
  return null
}

// Media ranges a tombstone of `copy` may carry: only in a core this diary
// declared, and only where no surviving own post or profile overlaps.
function freedRanges (copy, cores, live) {
  const descriptors = copy.type === 'post' ? (copy.media || []) : (copy.avatar === undefined ? [] : [copy.avatar])
  const out = []
  for (const d of descriptors) {
    const r = { core: d.core, start: d.start, blocks: d.blocks }
    if (cores.has(r.core) && !live.some((l) => overlaps(l, r))) out.push(r)
  }
  return out
}

// Deletes one own post (reply and quote included) or profile version ->
// { seq, ref, changed, deleted } (docs/rpc.md 5.33, 5.34), checking in the
// same order as the browser writer (@varanda/web-member member-ops.js).
// The target is judged as written, so a deleted block keeps its kind.
// Idempotent: a version already deleted writes nothing and reports its
// existing tombstone; half of a pair already deleted gets only the missing
// tombstone. `to` is the parsed { author, seq } reference.
async function recordDelete (ctx, { to, kind }) {
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    if (to.author !== ownHex || !Number.isSafeInteger(to.seq) || to.seq < 1 || to.seq >= diary.length) throw new UsageError(BAD_REF)
    const raw = await readRaw(diary)
    const deleted = deletedSeqs(raw)
    // A cleared target can no longer be judged; its tombstone answers.
    if (to.seq < raw.length && deleted.has(to.seq) && !(await diary.has(to.seq))) {
      const seqs = kind === 'profile' ? clearedVersion(raw, deleted, to.seq) : [to.seq]
      const seq = tombstoneOf(raw, deleted, seqs)
      return { seq, ref: seq === null ? null : formatRef({ author: ownHex, seq }), changed: false, deleted: seqs }
    }
    const copy = recordAt(raw, to.seq)
    if (copy === null) throw new UsageError(BAD_REF)
    if (copy.type !== kind) {
      if (copy.type === 'profile') throw new UsageError(NOT_A_POST)
      if (copy.type === 'post') throw new UsageError(NOT_A_PROFILE)
      throw new UsageError(NOT_DELETABLE)
    }
    const seqs = targetedSeqs(raw, to.seq, copy)
    const pending = seqs.filter((seq) => !deleted.has(seq))
    if (pending.length === 0) {
      const seq = tombstoneOf(raw, deleted, seqs)
      return { seq, ref: seq === null ? null : formatRef({ author: ownHex, seq }), changed: false, deleted: seqs }
    }
    const cores = new Set(latestMediaCores(applyDeletes(raw), ownHex, Number.MAX_SAFE_INTEGER).map((c) => c.key))
    const live = liveMediaRefs(raw, seqs)
    // One `at` for the whole append marks the tombstones of a pair as one.
    const at = nowIso()
    const records = pending.map((seq) => {
      const media = freedRanges(recordAt(raw, seq), cores, live)
      return buildRecord(() => deleteRecord(media.length > 0 ? { seq, at, media } : { seq, at }))
    })
    const seq = await appendRecords(diary, records)
    // The tombstones are written, so the delete succeeded whatever the clear
    // does; a clear that is skipped or fails is finished by the next open.
    const cleared = !clearingOff(ctx) && await clearedAll(diary, new Set(seqs))
    if (!cleared) reconciled.delete(path.resolve(ctx.dataDir))
    return { seq, ref: formatRef({ author: ownHex, seq }), changed: true, deleted: seqs }
  })
}

function postDelete (ctx, { to }) {
  return recordDelete(ctx, { to, kind: 'post' })
}

function profileDelete (ctx, { to }) {
  return recordDelete(ctx, { to, kind: 'profile' })
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
      // them. readAll ends at the first hole no tombstone covers, so a
      // cleared deleted block is not one (contiguousLength would count it).
      if (reason === null && replica.length > entries.length) incomplete.push(key)
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

// ---- groups ----

function groupNotFound () {
  const err = new Error('grupo não encontrado')
  err.code = 'NOT_FOUND'
  return err
}

function groupPermission () {
  return new UsageError('sem permissão no grupo')
}

function localGroups (dataDir) {
  return readGroups(dataDir).filter((g) => g && HEX64.test(g.group) && HEX64.test(g.writer) &&
    typeof g.nonce === 'string' && /^[0-9a-f]{32}$/.test(g.nonce))
}

function groupRole (view, ownHex) {
  const state = view.members.get(ownHex) || 'left'
  if (state !== 'member') return state
  return ownHex === view.creator ? 'creator' : view.admins.has(ownHex) ? 'admin' : 'member'
}

function groupSummary (group, view, ownHex) {
  return {
    group,
    name: view.name,
    join: view.join,
    role: groupRole(view, ownHex),
    members: [...view.members.values()].filter((s) => s === 'member').length
  }
}

const PENDING = 'pending'
const UNFOLDABLE = 'unfoldable'
const BLOCKED = 'blocked'

// The stored cores of the root `key` whose header is of `kind`: the root,
// every writer whose block 0 names it, and the diaries that bind them (join
// history for `key`, profiles). BLOCKED for a blocklisted key, PENDING while
// the root is not held, UNFOLDABLE for a fork or another header.
async function readCoreParts (identity, key, { blocked, revokedIssuers }, kind) {
  const { store, diary, ownHex, association } = identity
  if (blocked.has(key)) return BLOCKED
  if (!(await replicaStored(store, key))) return PENDING
  const rootCore = store.get({ key: b4a.from(key, 'hex'), writable: false, active: false })
  await rootCore.ready()
  if (rootCore.contiguousLength === 0) return PENDING
  const rootEntries = await readBlocks(rootCore)
  const header = rootEntries[0] && rootEntries[0].record
  if (rootCore.fork !== 0 || groups.validateGroupHeader(header) !== null || header.kind !== kind) return UNFOLDABLE
  // signed: the length the core's signature covers, blocks not downloaded
  // included (an admission or grant cut must lie above them).
  const logs = [{ key, diary: header.diary, entries: rootEntries, length: rootCore.contiguousLength, signed: rootCore.length }]
  const localDiaries = new Set([ownHex])
  // Discovery-key opens only inspect existing cores, including writers kept
  // after a leave or no longer present in this device's writer list.
  for await (const dk of store.list()) {
    if (b4a.equals(dk, rootCore.discoveryKey) || b4a.equals(dk, diary.discoveryKey)) continue
    const core = store.get({ discoveryKey: dk, writable: false, active: false })
    try {
      await core.ready()
      if (core.fork !== 0 || core.contiguousLength === 0) continue
      const h = decodeBlock(await core.get(0, { wait: false, raw: true }))
      if (validateRecord(h, 0) === null) localDiaries.add(hex(core.key))
      if (groups.validateWriterHeader(h) !== null || h.group !== key) continue
      logs.push({ key: hex(core.key), diary: h.diary, entries: await readBlocks(core), length: core.contiguousLength, signed: core.length })
    } finally {
      await core.close()
    }
  }
  const profiles = new Map()
  const joins = new Map()
  // The diaries' group-cut marks for this group (the creator's end its
  // root's authority).
  const marks = new Map()
  // The diaries' group-confirm records: only a leave its diary confirmed
  // ends a device's powers by diary-backed evidence.
  const confirms = new Map()
  const diaryEntries = new Map()
  for (const d of new Set([...localDiaries, ...logs.map((l) => l.diary)])) {
    if (blocked.has(d) || !(await replicaStored(store, d))) continue
    const core = d === ownHex ? diary : await openReplica(store, d)
    const entries = await readAll(core)
    if (d !== ownHex && skipReason(core, entries, d, association, blocked, revokedIssuers) !== null) continue
    diaryEntries.set(d, entries)
    joins.set(d, groups.groupJoinHistory(entries, key))
    marks.set(d, groups.groupCutHistory(entries, key))
    confirms.set(d, groups.groupConfirmHistory(entries, key))
    const profile = latestProfile(entries)
    profiles.set(d, {
      name: profile === null ? null : profile.name,
      username: latestUsername(entries, d, association, { revokedIssuers })
    })
  }
  const accepted = logs.filter((l) => diaryEntries.has(l.diary))
  const root = { key, entries: diaryEntries.has(header.diary) ? rootEntries : rootEntries.slice(0, 1) }
  const writers = accepted.filter((l) => l.key !== key)
  // Keep only two-way bindings for observed lengths and record references.
  const bound = accepted.filter((l) => (joins.get(l.diary) || []).some((j) => j.writer === l.key && j.on))
  return { header, input: { root, writers, joins, marks, confirms }, bound, profiles, diaryEntries }
}

// The local entry of this device in community `key` (its CW, or the root it
// created).
function communityEntry (dataDir, key) {
  return localGroups(dataDir).find((g) => g.kind === 'community' && g.group === key)
}

// This device's community writer when the fold takes a new record on it
// (C's liveWriters): { writer, nonce, length } or null.
function liveCw (cview, logs, local) {
  if (!cview || !local || !(cview.liveWriters instanceof Set) || !cview.liveWriters.has(local.writer)) return null
  const log = logs.find((l) => l.key === local.writer)
  return log ? { writer: local.writer, nonce: local.nonce, length: log.length } : null
}

// `secrets`: keep the device box key pair and the epoch keys this node
// opens on the result (loaded.secrets) for an operation that seals or
// distributes; the caller wipes them (wipeSecrets). Otherwise the box key
// is only used for the fold and wiped before returning.
async function loadGroup (ctx, identity, group, { secrets = false } = {}) {
  const { ownHex, association } = identity
  const block = enforcedBlocklist(ctx.dataDir, association)
  const { blocked } = block
  if (typeof group !== 'string' || !HEX64.test(group)) throw groupNotFound()
  // Enforcing a group block: a snapshot naming the root key makes the group
  // unknown to every operation, and its local cores stay where they are.
  const parts = await readCoreParts(identity, group.toLowerCase(), block, 'group')
  if (parts === BLOCKED) throw groupNotFound()
  if (parts === PENDING) throw pendingGroup(ctx, group)
  if (parts === UNFOLDABLE) {
    // A stored root this node never folds (a community header, a v1 header,
    // a fork): leave and the groups.json room logic drop its entry.
    const err = groupNotFound()
    err.unfoldable = true
    throw err
  }
  const { header, profiles, diaryEntries } = parts
  const { root, writers, joins, marks, confirms } = parts.input
  // The parent community named by the header, with its CWs and their
  // binding diaries; null while it is not held (or blocked, or no
  // community root): the fold then reads the group as incomplete.
  const cparts = await readCoreParts(identity, header.community, block, 'community')
  const parent = typeof cparts === 'string' ? null : cparts
  const input = { root, writers, joins, marks, confirms, community: parent === null ? null : parent.input }
  const priv = header.visibility === 'private'
  let box = null
  let view
  let opened = null
  try {
    if (priv) {
      box = storeLib.ensureBoxKeyPair(ctx.dataDir)
      const mine = ownBoxWriters(header, group, writers, ownHex, box)
      const keys = { writers: mine, unseal: foldUnseal(box) }
      // The epochs the fold accepted (its read-side distributor rule), each
      // a copy this node owns: only these are sealed under or handed on.
      const held = new Map()
      const recipients = new Map()
      if (secrets) {
        keys.onKey = (kid, key, list) => {
          const id = refId(kid)
          if (held.has(id)) return groupCrypto.wipe(key)
          held.set(id, { kid: { writer: kid.writer, seq: kid.seq }, key })
          recipients.set(id, new Set(list))
        }
      }
      try {
        view = groups.buildGroup({ ...input, keys })
        if (secrets) opened = { box, mine, held, recipients }
      } finally {
        if (opened === null) for (const { key } of held.values()) groupCrypto.wipe(key)
      }
    } else {
      view = groups.buildGroup(input)
    }
  } finally {
    if (box !== null && opened === null) groupCrypto.wipe(box.secretKey)
  }
  // The fold counts the root only when its creator's diary bound it: the
  // sync keeps that record for when the creator's replica is gone.
  if (view.writers.has(group) && !blocked.has(header.diary)) {
    try {
      recordBoundRoot(ctx.dataDir, group)
    } catch {}
  }
  const cw = view.community === null ? null : liveCw(view.community, parent.bound, communityEntry(ctx.dataDir, header.community))
  return {
    group,
    input,
    view,
    logs: parts.bound,
    profiles,
    diaryEntries,
    private: priv,
    header,
    secrets: opened,
    local: localGroups(ctx.dataDir).find((g) => g.group === group && g.kind !== 'community'),
    limits: logLimits(ctx),
    cw,
    // Key blocks written through community authority cite the CW length
    // (protocol, "Distributors").
    auth: cw !== null && view.community.authorityWriters.has(cw.writer) ? { writer: cw.writer, seq: cw.length } : null
  }
}

// A community for an operation: null while its root is not held,
// NOT_FOUND when the key is malformed, blocked or not a community root.
// The result has the shape of a loaded group, so the writer helpers
// (liveOwnWriter, countedCuts, ownGroupWriter) serve both.
async function loadCommunity (ctx, identity, community) {
  if (typeof community !== 'string' || !HEX64.test(community)) throw communityNotFound()
  const key = community.toLowerCase()
  const parts = await readCoreParts(identity, key, enforcedBlocklist(ctx.dataDir, identity.association), 'community')
  if (parts === PENDING) return null
  if (typeof parts === 'string') {
    const err = communityNotFound()
    // A stored root that never folds as a community (forked, v1, another
    // kind): the groups.json room logic may give its entry up.
    if (parts === UNFOLDABLE) err.unfoldable = true
    throw err
  }
  const view = groups.buildCommunity(parts.input)
  const local = communityEntry(ctx.dataDir, key)
  return {
    group: key,
    community: true,
    input: parts.input,
    view,
    logs: parts.bound,
    profiles: parts.profiles,
    diaryEntries: parts.diaryEntries,
    private: false,
    header: parts.header,
    local,
    limits: logLimits(ctx),
    cw: liveCw(view, parts.bound, local)
  }
}

// ---- private groups (docs/protocol.md, "Private groups") ----

const REKEY_PENDING = 'aguardando nova chave'
const refId = (r) => r.writer + ':' + r.seq

// The fold's unseal: the raw crypto_box_seal_open plaintext (key || tag),
// whose tag the fold checks against G and kid and then wipes.
function foldUnseal (box) {
  return (sealed) => groupCrypto.openFrom(b4a.from(sealed, 'base64'), box)
}

// This device's writers in the group: the ones whose header publishes this
// device's box key (the root too when this device created it). Retired
// writers of the device share the key, so they are listed as well.
function ownBoxWriters (header, group, writers, ownHex, box) {
  const pk = hex(box.publicKey)
  const mine = new Set()
  if (header.diary === ownHex && header.box === pk) mine.add(group)
  for (const l of writers) {
    const h = l.entries[0] && l.entries[0].record
    if (l.diary === ownHex && h && h.box === pk) mine.add(l.key)
  }
  return mine
}

// This device's box public key (hex); the secret is wiped at once.
function ownBoxPublic (ctx) {
  const box = storeLib.ensureBoxKeyPair(ctx.dataDir)
  groupCrypto.wipe(box.secretKey)
  return hex(box.publicKey)
}

function wipeSecrets (loaded) {
  if (!loaded || !loaded.secrets) return
  groupCrypto.wipe(loaded.secrets.box.secretKey)
  for (const { key } of loaded.secrets.held.values()) groupCrypto.wipe(key)
  loaded.secrets = null
}

async function withLoaded (ctx, identity, group, fn) {
  const loaded = await loadGroup(ctx, identity, group, { secrets: true })
  try {
    return await fn(loaded)
  } finally {
    wipeSecrets(loaded)
  }
}

// The fold input of a private group read as a public approval group with
// the same plaintext records: the probes (which writers the fold counts,
// which may post now) use plaintext posts, which a private fold skips.
// Membership, moderation and authority are plaintext in both.
function plainInput (loaded) {
  if (!loaded.private) return loaded.input
  const strip = (entries, root) => entries.map((e) => {
    if (!e || e.seq !== 0 || !e.record || typeof e.record !== 'object') return e
    return { ...e, record: root ? { ...e.record, visibility: 'public', name: null, box: null } : { ...e.record, box: null } }
  })
  return {
    ...loaded.input,
    root: { ...loaded.input.root, entries: strip(loaded.input.root.entries, true) },
    writers: loaded.input.writers.map((w) => ({ ...w, entries: strip(w.entries, false) }))
  }
}

// The probe posts of a fold in which every held log gets one more post.
function probePosts (loaded) {
  const input = plainInput(loaded)
  const probes = new Map(loaded.logs.map((l) => [l.key, l.length]))
  const record = groups.groupPost({ text: '.' })
  const add = (log) => probes.has(log.key)
    ? { ...log, entries: [...log.entries, { seq: probes.get(log.key), record }] }
    : log
  const view = groups.buildGroup({ ...input, root: add(input.root), writers: input.writers.map(add) })
  return view.posts.filter((p) => probes.get(p.writer) === p.seq)
}

// "Entitled writers": a counted writer of a member diary that may post now
// (the creator's bound writers, admin or community power, or admitted, ban
// layer off). A pending writer of a member diary is never entitled.
function entitledWriters (loaded) {
  if (Array.isArray(loaded.view.entitled)) return new Set(loaded.view.entitled)
  const out = new Set()
  for (const p of probePosts(loaded)) {
    if (!p.hidden && loaded.view.writers.has(p.writer) && loaded.view.members.get(p.diary) === 'member') out.add(p.writer)
  }
  return out
}

function writerBox (loaded, writer) {
  let h = null
  if (writer === loaded.group) h = loaded.header
  else {
    // Two-way bound logs first; this device's own writer may not be bound
    // yet (a crash between its creation and the diary join), so its header
    // comes from the accepted logs: it is rebound, never replaced.
    const log = loaded.logs.find((l) => l.key === writer) ||
      (loaded.local && loaded.local.writer === writer ? loaded.input.writers.find((l) => l.key === writer) : undefined)
    h = log && log.entries[0] ? log.entries[0].record : null
  }
  return h && typeof h.box === 'string' && HEX64.test(h.box) ? h.box : null
}

// One sealed entry per recipient. A box sodium refuses (a low-order point)
// skips that writer only, like a writer with no held header.
function sealedEntries (loaded, key, kid, writers) {
  const out = []
  for (const w of [...writers].sort()) {
    const box = writerBox(loaded, w)
    if (box === null) continue
    let sealed
    try {
      sealed = groupCrypto.sealEpochKey(key, loaded.group, kid, b4a.from(box, 'hex'))
    } catch {
      continue
    }
    out.push({ writer: w, sealed: b4a.toString(sealed, 'base64') })
  }
  return out
}

function chunks (list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// A first block (kid null) or continuations of `kid`, at most
// MAX_KEY_RECIPIENTS entries per block. Returns the epoch's kid. `commit`
// (hex) goes on a first block only.
async function appendKeyBlocks (core, group, kid, basis, entries, commit = null) {
  const writerHex = hex(core.key)
  const parts = chunks(entries, groupCrypto.MAX_KEY_RECIPIENTS)
  for (let i = 0; i < parts.length; i++) {
    const first = kid === null
    const expected = core.length
    const seq = await appendGroupRecord(core, group, groups.groupKey({ kid, basis: first ? basis : [], keys: parts[i], ...(first ? { commit } : {}) }), true)
    // The seq is part of the sealed tag: a block landing elsewhere is unreadable.
    if (seq !== expected) throw new Error('bloco de chave fora de ordem')
    if (first) kid = { writer: writerHex, seq }
  }
  return kid
}

// ctx.limits lowers the log budget in tests, as on the browser node.
function logLimits (ctx) {
  return { maxLogBlocks: MAX_LOG_BLOCKS, maxLogBytes: MAX_LOG_BYTES, ...ctx.limits }
}

// Key blocks are written whole or not at all: refused before the first one
// when they would not fit the writer's remaining log budget.
function checkLogRoom (loaded, core, blocks) {
  const { maxLogBlocks, maxLogBytes } = loaded.limits || logLimits({})
  let bytes = 0
  for (const b of blocks) bytes += b4a.byteLength(JSON.stringify(b))
  if (core.length + blocks.length > maxLogBlocks || core.byteLength + bytes > maxLogBytes) {
    throw new UsageError('rotação grande demais para o espaço do diário')
  }
}

async function appendKeyPlan (core, group, blocks) {
  for (const block of blocks) {
    const expected = core.length
    const at = await appendGroupRecord(core, group, block, true)
    // The seq is part of the sealed tag: a block landing elsewhere is unreadable.
    if (at !== expected) throw new Error('bloco de chave fora de ordem')
  }
}

// A rotation ("Rotation"): fresh epochs on `core` sealed to exactly the
// writers entitled now, each first block covering up to MAX_KEY_BASIS
// uncovered removals. Only the last epoch is sent under, so the earlier ones
// are sealed to the distributor's own writer alone. The whole rotation is
// planned and measured first: one that would not fit the writer's log is
// refused with nothing written.
async function rotateEpoch (loaded, core) {
  const recipients = entitledWriters(loaded)
  const writerHex = hex(core.key)
  const removals = basisRefs(loaded, writerHex)
  const bases = removals.length === 0 ? [[]] : chunks(removals, groups.MAX_KEY_BASIS)
  const keys = []
  try {
    const blocks = []
    let seq = core.length
    let kid = null
    for (let b = 0; b < bases.length; b++) {
      const basis = bases[b]
      const key = groupCrypto.newEpochKey()
      keys.push(key)
      kid = { writer: writerHex, seq }
      // Nobody sends under an earlier epoch: only the distributor keeps it.
      const entries = sealedEntries(loaded, key, kid, b === bases.length - 1 ? recipients : [writerHex])
      if (entries.length === 0) throw groupPermission()
      const parts = chunks(entries, groupCrypto.MAX_KEY_RECIPIENTS)
      // The commitment binds the first block to this one key, so a reader
      // never keeps another key that a forged entry opens to.
      const commit = hex(groupCrypto.keyCommit(key, loaded.group, kid))
      for (let i = 0; i < parts.length; i++) {
        blocks.push(groups.groupKey(i === 0 ? { kid: null, basis, keys: parts[i], auth: keyAuth(loaded, core), commit } : { kid, basis: [], keys: parts[i], auth: keyAuth(loaded, core) }))
      }
      seq += parts.length
    }
    checkLogRoom(loaded, core, blocks)
    await appendKeyPlan(core, loaded.group, blocks)
    return kid
  } finally {
    for (const key of keys) groupCrypto.wipe(key)
  }
}

// A rotation's basis: the fold's own requirement set (`removals`, the
// latest counted removal per writer core plus counted community removals),
// never a raw scan of peer records. Refs on the distributor's own writer,
// or in the basis of its earlier first blocks, are ancestors already. A
// community ref is never left out: the fold covers it only through first
// blocks it counted, and an earlier block written while this writer's
// authority was being cut is not counted.
function basisRefs (loaded, writerHex) {
  const ofGroup = new Set([loaded.group, ...loaded.input.writers.map((l) => l.key)])
  const covered = new Set()
  const own = writerHex === loaded.group ? loaded.input.root : loaded.input.writers.find((l) => l.key === writerHex)
  for (const e of (own && own.entries) || []) {
    const r = e && e.record
    if (!e || !Number.isSafeInteger(e.seq) || e.seq < 1 || !r) continue
    covered.add(refId({ writer: writerHex, seq: e.seq }))
    if (r.type === 'group-key' && r.kid === null &&
      groups.validateGroupRecord(r, e.seq, { root: writerHex === loaded.group, private: true }) === null) {
      for (const b of r.basis) if (ofGroup.has(b.writer)) covered.add(refId(b))
    }
  }
  const list = Array.isArray(loaded.view.removals) ? loaded.view.removals : []
  return list.filter((r) => r && !covered.has(refId(r))).map((r) => ({ writer: r.writer, seq: r.seq }))
}

// History on admit: every epoch key the fold accepted for this node, to
// every entitled writer its recipients do not list yet. This also recovers
// an earlier delivery that failed. Planned whole first: a hand-off that
// would not fit the log (a rogue distributor opening thousands of epochs)
// writes nothing.
async function handHistory (loaded, core) {
  if (!loaded.private || loaded.secrets === null) return
  const entitled = [...entitledWriters(loaded)]
  const blocks = []
  for (const [id, { kid, key }] of loaded.secrets.held) {
    const has = loaded.secrets.recipients.get(id) || new Set()
    const entries = sealedEntries(loaded, key, kid, entitled.filter((w) => !has.has(w)))
    for (const keys of chunks(entries, groupCrypto.MAX_KEY_RECIPIENTS)) blocks.push(groups.groupKey({ kid, basis: [], keys, auth: keyAuth(loaded, core) }))
  }
  if (blocks.length === 0) return
  checkLogRoom(loaded, core, blocks)
  await appendKeyPlan(core, loaded.group, blocks)
}

// The community citation of a key block: none on the root (the creator's
// authority), the own live CW's length for a community creator or admin.
function keyAuth (loaded, core) {
  return hex(core.key) === loaded.group || !loaded.auth ? null : { writer: loaded.auth.writer, seq: loaded.auth.seq }
}

// The core a distributor writes key blocks on: its own live writer, else
// the root it created; null when it may not distribute.
async function distributorCore (loaded, identity) {
  const { ownHex } = identity
  if (!loaded.private || loaded.view.members.get(ownHex) !== 'member' || !loaded.view.admins.has(ownHex)) return null
  const live = liveOwnWriter(loaded, ownHex)
  if (live && loaded.view.writers.has(live.writer)) {
    try {
      return await ownGroupWriter(loaded, identity)
    } catch {}
  }
  if (loaded.view.creator === ownHex && loaded.view.writers.has(loaded.group) && rootHasAuthority(loaded)) {
    try {
      return await ownGroupWriter(loaded, identity, { root: true })
    } catch {}
  }
  return null
}

// A plaintext group-post, group-hide or group-meta of `writerHex` sealed
// under the fold's epoch; refused while rekey-pending.
function sealGroupRecord (loaded, writerHex, record) {
  const { view } = loaded
  const held = view.epoch === null || loaded.secrets === null ? undefined : loaded.secrets.held.get(refId(view.epoch))
  if (view.rekeyPending || held === undefined) throw new UsageError(REKEY_PENDING)
  const inner = groups.sealedInner(record, { writer: writerHex, group: loaded.group, kid: view.epoch })
  let sealed
  try {
    sealed = groupCrypto.sealRecord(inner, held.key)
  } catch {
    throw new UsageError('texto muito longo')
  }
  return groups.groupSealed({ kid: view.epoch, nonce: sealed.nonce, box: sealed.box, at: record.at })
}

// A record for this node's own writer: sealed in a private group.
function groupRecordFor (loaded, core, record) {
  return loaded.private ? sealGroupRecord(loaded, hex(core.key), record) : record
}

// Key blocks after a record that is already written: never fail the call.
async function keySideEffect (fn) {
  try {
    await fn()
  } catch {}
}

function readState (view) {
  return {
    sealed: view.sealed || 0,
    epoch: view.epoch ? { writer: view.epoch.writer, seq: view.epoch.seq } : null,
    state: view.rekeyPending ? 'rekey-pending' : 'ok'
  }
}

// A join by key records the group before any sync fetched its root. Until
// the root arrives the group is pending: NOT_FOUND to every operation that
// needs the fold, with the local entry (or null) for the few that do not.
function pendingGroup (ctx, group) {
  const err = groupNotFound()
  const key = group.toLowerCase()
  err.pending = { group: key, local: localGroups(ctx.dataDir).find((g) => g.group === key) || null }
  return err
}

function withGroup (ctx, group, fn, { secrets = false } = {}) {
  return withIdentity(ctx, async (identity) => {
    const loaded = await loadGroup(ctx, identity, group, { secrets })
    try {
      return await fn(loaded, identity)
    } finally {
      wipeSecrets(loaded)
    }
  })
}

// withGroup, with `pending` answering for a pending group instead, and
// `unfoldable` (when given) for a stored root this node never folds.
function withGroupOrPending (ctx, group, fn, pending, unfoldable = null) {
  return withIdentity(ctx, async (identity) => {
    let loaded
    try {
      loaded = await loadGroup(ctx, identity, group)
    } catch (err) {
      if (unfoldable !== null && err.unfoldable === true) return unfoldable(identity)
      if (err.pending === undefined) throw err
      return pending(err.pending, identity)
    }
    return fn(loaded, identity)
  })
}

function requirePendingLocal ({ local }) {
  if (local === null) throw groupNotFound()
  return local
}

// This device's writer of a pending group -> { core, leave } or null when
// it was never written (a crash between its creation and its header).
async function pendingWriter (store, local) {
  const core = await openGroupWriter(store, local.nonce)
  if (hex(core.key) !== local.writer || core.length === 0) return null
  return { core, leave: (await readBlocks(core)).some(recordIsLeave) }
}

const PENDING_INFO = { name: null, join: null, role: 'pending', members: 0 }

function recordIsLeave (entry) {
  return entry.seq >= 1 && entry.record !== null && typeof entry.record === 'object' && entry.record.type === 'group-leave'
}

// This device's writer while the fold takes a new record on it (its
// liveWriters: not retired by any leave of the diary, from any device, and
// in a group not gated off by the community). Two cases the fold does not
// list still stand, so the caller answers them: a writer of a pending
// request in a community (counted, with no leave since it was written) and
// a member's writer beyond the writer cap (requireCounted refuses it).
function liveOwnWriter (loaded, ownHex) {
  const local = loaded.local
  if (!local || markedRoot(loaded, local.writer)) return null
  const log = loaded.logs.find((l) => l.key === local.writer && l.diary === ownHex)
  if (!log) return null
  const live = loaded.view.liveWriters instanceof Set ? loaded.view.liveWriters : new Set()
  if (live.has(local.writer)) return local
  if (log.entries.some(recordIsLeave)) return null
  const status = loaded.view.members.get(ownHex)
  if (status === 'member' && !loaded.view.writers.has(local.writer)) return local
  if (status === 'requested' && loaded.view.writers.has(local.writer)) {
    const last = loaded.view.lastLeave instanceof Map ? loaded.view.lastLeave.get(ownHex) : undefined
    const h = log.entries[0] && log.entries[0].record
    const r = h && h.rejoin
    // A rejoin may name the counted leave of any own device (`leaveOf`,
    // community folds), not only the diary's latest.
    const own = r && loaded.view.leaveOf instanceof Map && [...loaded.view.leaveOf.values()].some((x) => x.writer === r.writer && x.seq === r.seq) &&
      loaded.logs.some((l) => l.key === r.writer && l.diary === ownHex)
    if (!last || own || (r && r.writer === last.writer && r.seq === last.seq)) return local
  }
  return null
}

// The writer a leave goes through: a live one, or a counted one that a ban
// layer still covers (an unban missed it), so a member is never locked in.
// A group root its creator's diary marked is never this device's writer
// again: whatever it appends carries no authority and gets no keys, so a
// returning creator joins through a new writer.
function markedRoot (loaded, writer) {
  return writer === loaded.group && loaded.view.rootCut !== null && loaded.view.rootCut !== undefined
}

function leavingWriter (loaded, ownHex) {
  const live = liveOwnWriter(loaded, ownHex)
  if (live || !loaded.local || markedRoot(loaded, loaded.local.writer) || !loaded.view.writers.has(loaded.local.writer)) return live
  const log = loaded.logs.find((l) => l.key === loaded.local.writer && l.diary === ownHex)
  return log && !log.entries.some(recordIsLeave) ? loaded.local : null
}

// A writer the fold did not count (beyond the writer cap) still looks live
// when another writer keeps the diary a member, but anything it writes is
// discarded by the fold.
function requireCounted (loaded, writer) {
  if (!loaded.view.writers.has(writer)) throw new UsageError(GROUP_FULL)
}

async function localWriterHasLeave (store, local) {
  let core
  try {
    core = await openGroupWriter(store, local.nonce)
  } catch {
    return true
  }
  try {
    if (hex(core.key) !== local.writer || core.length === 0) return true
    const entries = await readBlocks(core)
    return entries.some(recordIsLeave)
  } finally {
    await core.close()
  }
}

async function writerStillWrites (store, entry) {
  let core
  try {
    core = await openGroupWriter(store, entry.nonce)
  } catch {
    return false
  }
  try {
    if (hex(core.key) !== entry.writer || core.length === 0) return false
    const entries = await readBlocks(core)
    return !entries.some(recordIsLeave)
  } finally {
    await core.close()
  }
}

// The root's secret lives in this store. A replica of someone else's root
// is not writable, so that group was only joined.
async function rootOwnedHere (store, group) {
  if (!(await replicaStored(store, group))) return false
  const core = store.get({ key: b4a.from(group, 'hex') })
  try {
    await core.ready()
    return core.writable === true
  } finally {
    await core.close()
  }
}

// The fold reports the own diary as left, a leave from another device of
// the diary included. A group that does not load is not known to be left.
async function foldSaysLeft (ctx, identity, entry) {
  try {
    if (entry.kind === 'community') {
      const c = await loadCommunity(ctx, identity, entry.group)
      return c !== null && c.view.members.get(identity.ownHex) === 'left'
    }
    return (await loadGroup(ctx, identity, entry.group)).view.members.get(identity.ownHex) === 'left'
  } catch (err) {
    // Protecting the groups.json slots from a root that is never folded: it
    // counts as left, so a full list can give its entry up.
    if (err.unfoldable === true) return true
    if (err.code === 'NOT_FOUND') return false
    throw err
  }
}

// Room in groups.json for one new group. At most MAX_GROUPS_PER_DIARY
// writers still write. A full list gives up its oldest left entry of a group
// this device merely joined. A created group's entry is never dropped: it is
// the only copy of the nonce that opens the root. An entry is left when its
// writer holds a leave or the fold says the diary left; folds are only read
// for a full list.
// `need`: the slots asked for at once (two for a community and its Geral).
async function makeGroupRoom (ctx, identity, group, need = 1) {
  const { store } = identity
  const entries = localGroups(ctx.dataDir)
  if (group !== null && entries.some((e) => e.group === group)) return
  if (entries.length + need <= groups.MAX_GROUPS_PER_DIARY) return
  const left = []
  let writing = 0
  for (const entry of entries) {
    if (await writerStillWrites(store, entry) && !(await foldSaysLeft(ctx, identity, entry))) writing++
    else left.push(entry)
  }
  if (writing + need > groups.MAX_GROUPS_PER_DIARY) throw new UsageError('limite de grupos atingido')
  const victims = new Set()
  const wanted = entries.length + need - groups.MAX_GROUPS_PER_DIARY
  for (const entry of left) {
    if (victims.size >= wanted) break
    if (entry.writer === entry.group) continue
    if (await rootOwnedHere(store, entry.group)) continue
    victims.add(entry.group)
  }
  if (victims.size < wanted) throw new UsageError('limite de grupos atingido')
  writeGroups(ctx.dataDir, entries.filter((e) => !victims.has(e.group)))
}

// buildGroup does not list the writers it counted. A probe post asks the
// same fold (rejoin binding and the writer cap) so a cut names only those.
function groupCuts (loaded, member, { signed = false } = {}) {
  const accepted = new Set(probePosts(loaded).map((p) => p.writer))
  return loaded.logs.filter((l) => accepted.has(l.key) && l.diary === member)
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, groups.MAX_GROUP_CUTS)
    .map((l) => ({ writer: l.key, seq: cutLength(l, signed) }))
}

// A positive admission or grant covers only records written after it: the
// cut sits at the signed length, so records signed but not downloaded here
// gain nothing. The same holds for an unban, whose restrictive side is the
// higher cut: records the member signed during the ban that this device has
// not downloaded stay banned once they arrive. A withdrawal, ban or leave
// keeps the contiguous length, the restrictive side for those.
function cutLength (log, signed) {
  return signed ? Math.max(log.length, log.signed || 0) : log.length
}

// Every writer of `diary` the fold counts, at its local length. A leave or a
// grant must list them all: the fold withdraws an unlisted writer's records
// from seq 0 on a leave and gives it no authority on a grant.
function countedCuts (loaded, diary, { signed = false } = {}) {
  return loaded.logs.filter((l) => l.diary === diary && loaded.view.writers.has(l.key))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((l) => ({ writer: l.key, seq: cutLength(l, signed) }))
}

// The writers `diary` binds in this group that the fold would count (its
// MAX_GROUP_WRITERS_PER_DIARY earliest on:true joins, a bound root of the
// creator always among them, as group.js capPerDiary) and that this node
// does not hold. Null when the diary itself is not held.
function unheldCountedWriters (loaded, diary) {
  const joins = loaded.input.joins.get(diary)
  if (!joins) return null
  const first = new Map()
  for (const j of joins) {
    if (j.on && (!first.has(j.writer) || j.seq < first.get(j.writer))) first.set(j.writer, j.seq)
  }
  const rootBound = diary === loaded.view.creator && first.has(loaded.group)
  const others = [...first.keys()].filter((w) => !(rootBound && w === loaded.group))
    .sort((a, b) => (first.get(a) - first.get(b)) || a.localeCompare(b))
  const counted = rootBound
    ? [loaded.group, ...others.slice(0, groups.MAX_GROUP_WRITERS_PER_DIARY - 1)]
    : others.slice(0, groups.MAX_GROUP_WRITERS_PER_DIARY)
  const held = new Set(loaded.logs.map((l) => l.key))
  // A private group: a writer the diary unbound (a boxless writer replaced
  // by group.join) is refused by seeders and sync, so it is never held and
  // must not block the admit. Public groups keep the rule for every writer.
  const unbound = new Set()
  if (loaded.private) {
    const last = new Map()
    for (const j of joins) if (!last.has(j.writer) || j.seq > last.get(j.writer).seq) last.set(j.writer, j)
    for (const [w, j] of last) if (!j.on) unbound.add(w)
  }
  return counted.filter((w) => !held.has(w) && !unbound.has(w))
}

function boundWriterCount (loaded, diary) {
  return loaded.logs.filter((l) => l.diary === diary).length
}

async function ownGroupWriter (loaded, identity, { root = false } = {}) {
  const { local } = loaded
  if (root) {
    const writer = identity.store.get({ key: b4a.from(loaded.group, 'hex'), valueEncoding: 'json' })
    await writer.ready()
    if (!writer.writable || loaded.view.creator !== identity.ownHex) throw groupPermission()
    return writer
  }
  if (!local) throw groupPermission()
  const writer = await openGroupWriter(identity.store, local.nonce)
  if (hex(writer.key) !== local.writer || !loaded.logs.some((l) => l.key === local.writer && l.diary === identity.ownHex)) throw groupPermission()
  return writer
}

// `community`: the core is a community core (its root or a CW).
function appendGroupRecord (core, group, record, priv = false, community = false) {
  return appendRecord(core, record, { validator: (r, seq) => groups.validateGroupRecord(r, seq, { root: hex(core.key) === group, private: priv, community }) })
}

// The parent checks every group write makes first (rpc.md 5.39).
function requireParent (loaded) {
  if (loaded.view.orphan) throw new UsageError('grupo sem comunidade')
  if (loaded.view.community === null) throw new UsageError('aguarde a sincronização da comunidade')
}

// This device's live CW core in the group's community, or null.
async function openOwnCw (identity, cw) {
  if (cw === null) return null
  const core = await openGroupWriter(identity.store, cw.nonce)
  return hex(core.key) === cw.writer ? core : null
}

// Authority of this device inside G itself: the fold's authorityWriters
// lists its writer (the creator's live root, or a G grant on at the
// writer's next position). Community admins also show in `admins` but act
// only through their CW (protocol, "Community-authority actions"). An
// admin's writer beyond the writer cap passes here so requireCounted
// refuses it for the cap.
function holdsGroupAuthority (loaded, ownHex) {
  const { view, local } = loaded
  if (!local) return false
  if (view.authorityWriters instanceof Set && view.authorityWriters.has(local.writer)) return true
  return view.members.get(ownHex) === 'member' && view.admins.has(ownHex) && !view.writers.has(local.writer)
}

// This device acts by community authority in G: its live CW is in the
// parent's authorityWriters.
function communityActs (loaded) {
  const cview = loaded.view.community
  return loaded.cw !== null && cview !== null && cview.authorityWriters instanceof Set && cview.authorityWriters.has(loaded.cw.writer)
}

// A writer beyond the writer cap is not counted, so the fold may hold no
// state for the diary at all: that is never reported as 'member'.
function groupJoinState (view, ownHex, writer) {
  const state = view.members.get(ownHex)
  if (state === 'requested' || state === 'left') return { state }
  if (!view.writers.has(writer)) throw new UsageError(GROUP_FULL)
  return { state: 'member' }
}

// The cap keeps MAX_GROUP_WRITERS - 1 writers besides the root.
function groupWritersFull (view, group) {
  let n = 0
  for (const key of view.writers) if (key !== group) n++
  return n >= groups.MAX_GROUP_WRITERS - 1
}

// rpc.md 5.36: a group always lives in a community, and only the
// community's creator makes one, on the device that holds C's root (owner
// decision; admins moderate). The header names C and the root as its CW,
// and the group-create in C's root lists it in the catalogue. A crash
// between the group root and the create leaves an orphan root nobody lists.
async function groupCreate (ctx, { name, join, visibility = 'public', community }) {
  return withIdentity(ctx, async (identity) => {
    const { store, diary, ownHex } = identity
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    if (visibility !== 'public' && visibility !== 'private') throw new UsageError('visibilidade inválida')
    const c = await loadCommunity(ctx, identity, community)
    if (c === null) throw new UsageError('aguarde a sincronização da comunidade')
    const C = c.group
    if (c.view.creator !== ownHex) throw new UsageError('só quem criou a comunidade cria grupos')
    requireRootAuthority(c)
    if (!c.local || c.local.writer !== C) throw new UsageError('crie pelo aparelho que criou a comunidade')
    // The root must still act (the creator left C: no live root).
    requireCommunityAdmin(c)
    if (c.view.created.size >= groups.MAX_GROUPS_PER_COMMUNITY) throw new UsageError('a comunidade chegou ao limite de grupos')
    const priv = visibility === 'private'
    let box = null
    let key = null
    try {
      let record
      let meta = null
      if (priv) {
        box = storeLib.ensureBoxKeyPair(ctx.dataDir)
        record = buildRecord(() => groups.groupHeader({ diary: ownHex, community: C, member: c.cw.writer, visibility, join: 'approval', name: null, box: hex(box.publicKey) }))
        // The name is validated before anything is written.
        meta = buildRecord(() => groups.groupMeta({ name, join: 'approval' }))
      } else {
        record = buildRecord(() => groups.groupHeader({ diary: ownHex, community: C, member: c.cw.writer, name, join }))
      }
      await makeGroupRoom(ctx, identity, null)
      const nonce = hex(randomBytes(16))
      const writer = await openGroupWriter(store, nonce)
      const group = hex(writer.key)
      await appendGroupRecord(writer, group, record)
      if (priv) {
        // Epoch 1 to the root box, then the title sealed under it.
        key = groupCrypto.newEpochKey()
        const kid = { writer: group, seq: writer.length }
        const sealed = b4a.toString(groupCrypto.sealEpochKey(key, group, kid, box.publicKey), 'base64')
        await appendKeyBlocks(writer, group, null, [], [{ writer: group, sealed }], hex(groupCrypto.keyCommit(key, group, kid)))
        const inner = groups.sealedInner(meta, { writer: group, group, kid })
        const env = groupCrypto.sealRecord(inner, key)
        await appendGroupRecord(writer, group, groups.groupSealed({ kid, nonce: env.nonce, box: env.box, at: meta.at }), true)
      }
      // The nonce is the only way back to this root. Record it before the
      // diary join so a crash cannot bind a root this device cannot write.
      writeGroups(ctx.dataDir, [...localGroups(ctx.dataDir), { group, writer: group, nonce }])
      await appendRecord(diary, groupJoinRecord({ group, writer: group, on: true }))
      // c.cw is C's root here (checked above).
      const root = await openOwnCw(identity, c.cw)
      if (root === null) throw communityPermission()
      await appendGroupRecord(root, C, groups.groupCreateRecord({ group, seen: c.view.last }), false, true)
      return { group }
    } finally {
      if (key !== null) groupCrypto.wipe(key)
      if (box !== null) groupCrypto.wipe(box.secretKey)
    }
  })
}

// The checks that need the fold (ban, membership, rejoin) wait for the
// root: the next sync fetches it and the fold then decides the state.
// `member`: the own CW the writer header names (null for a CW itself);
// `kind`: the local entry's kind ('community' for a CW).
async function pendingJoin (ctx, { group, local }, identity, member = null, kind = undefined) {
  const { diary, store, ownHex } = identity
  if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
  const own = local === null ? null : await pendingWriter(store, local)
  if (own !== null && own.leave) throw new UsageError('o grupo ainda não chegou: entre de novo depois da sincronização')
  let writerKey = own === null ? null : local.writer
  // A reused CW's first on-join signs its header's rejoin, as ensureJoin
  // does: without it the fold takes the CW as generation 0.
  const rejoin = writerKey !== null && kind === 'community' ? await localHeaderRejoin(store, local) : null
  if (writerKey === null) {
    await makeGroupRoom(ctx, identity, group)
    const nonce = hex(randomBytes(16))
    const writer = await openGroupWriter(store, nonce)
    writerKey = hex(writer.key)
    await appendGroupRecord(writer, group, buildRecord(() => groups.writerHeader({ group, diary: ownHex, member, rejoin: null })))
    writeGroups(ctx.dataDir, [...localGroups(ctx.dataDir).filter((g) => g.group !== group), { group, writer: writerKey, nonce, kind }])
  }
  const joins = groups.groupJoinHistory(await readAll(diary), group)
  if (!joins.some((j) => j.writer === writerKey && j.on)) await appendRecord(diary, groupJoinRecord({ group, writer: writerKey, on: true, ...(rejoin ? { rejoin } : {}) }))
  return { state: 'pending' }
}

// The leave a new writer names: the fold's causally latest counted leave of
// the diary (another device's included), or null.
function foldRejoin (view, ownHex) {
  const r = view.lastLeave instanceof Map ? view.lastLeave.get(ownHex) : undefined
  return r ? { writer: r.writer, seq: r.seq } : null
}

// The leave a new CW of a rejoin names (owner decision, cycle 10): a device
// that comes back names the leave of a device of its own, so a leave a
// stolen sibling appends never becomes the boundary of this device's
// history. Its local CW's counted leave (`leaveOf`); else, when that CW is
// bound, counted and holds no leave, one it writes (and the diary confirms)
// there first; else the first leave the diary confirmed (cycle 13); else the
// diary's latest leave. A failure after the extra leave surfaces like any
// other write of the join.
async function ownRejoinLeave (ctx, identity, c, C) {
  const { ownHex, store } = identity
  const leaveOfIn = (view) => view.leaveOf instanceof Map ? view.leaveOf : new Map()
  // Only a leave of the diary's latest set: an older one would make the new
  // CW a past generation.
  const current = (view, w) => {
    const sets = view.leaveSetOf instanceof Map ? view.leaveSetOf : new Map()
    const last = view.lastLeave instanceof Map ? view.lastLeave.get(ownHex) : undefined
    return last !== undefined && sets.has(w) && sets.get(w) === sets.get(last.writer)
  }
  const local = c.local
  const ref = (r) => ({ writer: r.writer, seq: r.seq })
  if (local && leaveOfIn(c.view).has(local.writer) && current(c.view, local.writer)) return { c, rejoin: ref(leaveOfIn(c.view).get(local.writer)) }
  const bound = !!local && local.writer !== C && c.logs.some((l) => l.key === local.writer && l.diary === ownHex)
  if (bound && c.view.writers.has(local.writer) && !(await localWriterHasLeave(store, local))) {
    const writer = await ownGroupWriter(c, identity)
    const seen = foldRejoin(c.view, ownHex)
    // Every counted own CW held here, as any leave of the diary: the fold
    // withdraws an unlisted one from seq 0. Never C's root: a creator back
    // after a forged leave keeps its powers (cycle 14).
    const cuts = countedCuts(c, ownHex).filter((x) => x.writer !== C)
    const record = buildRecord(() => groups.groupLeave({ seen, cuts }))
    const seq = await appendCommunityRecord(writer, C, record)
    // The diary confirms it, as for any honest leave.
    await confirmLeave(identity, C, hex(writer.key), seq, record)
    await appendRecord(identity.diary, groupJoinRecord({ group: C, writer: local.writer, on: false }))
    c = await loadCommunity(ctx, identity, C)
    const mine = leaveOfIn(c.view).get(local.writer)
    if (mine && current(c.view, local.writer)) return { c, rejoin: ref(mine) }
  }
  // A new device: the first leave of the latest set this diary confirmed
  // (turned its writer off), never a later one a stolen device forged.
  const confirmed = c.view.confirmedLeaveOf instanceof Map ? c.view.confirmedLeaveOf.get(ownHex) : undefined
  if (confirmed) return { c, rejoin: ref(confirmed) }
  return { c, rejoin: foldRejoin(c.view, ownHex) }
}

// The local writer exists but no diary join binds it yet.
function unboundLocal (loaded) {
  return !!loaded.local && loaded.local.writer !== loaded.group && !loaded.logs.some((l) => l.key === loaded.local.writer)
}

// A join of a loaded group through the own CW `cw` (its key).
async function joinLoaded (ctx, identity, loaded, cw) {
  const { diary, store, ownHex } = identity
  const group = loaded.group
  if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
  // bans, not members: a diary banned before it had a writer is not listed.
  if (loaded.view.bans.has(ownHex)) throw groupPermission()
  // A blocked own diary binds none of its writers in the fold.
  if (!loaded.diaryEntries.has(ownHex)) throw groupPermission()
  // A writer made before the private root arrived (a join by key) has no
  // box, so the fold never counts it, and one whose box is not this
  // device's key can open nothing: its binding goes and a new writer with
  // this device's box takes its place.
  const boxStale = loaded.private && !!loaded.local && loaded.local.writer !== group && writerBox(loaded, loaded.local.writer) !== ownBoxPublic(ctx)
  if (boxStale && (groups.groupJoinHistory(await readAll(diary), group).filter((j) => j.writer === loaded.local.writer).pop() || {}).on) {
    await appendRecord(diary, groupJoinRecord({ group, writer: loaded.local.writer, on: false }))
  }
  // A writer the fold no longer takes (retired by a leave of any device, or
  // naming a CW the gate retired) is replaced by a new one naming the live
  // CW; the old one stays bound, so its earlier posts stay readable.
  const stale = boxStale
  const live = stale ? null : liveOwnWriter(loaded, ownHex)
  if (live) {
    await ownGroupWriter(loaded, identity)
    return groupJoinState(loaded.view, ownHex, live.writer)
  }
  const left = loaded.view.members.get(ownHex) === 'left'
  let writerKey = null
  // Only a writer never bound (a crash before its diary join) is reused: a
  // bound one the fold does not take as live is retired for good.
  if (!stale && !left && unboundLocal(loaded) && !(await localWriterHasLeave(store, loaded.local))) writerKey = loaded.local.writer
  if (writerKey === null) {
    if (groupWritersFull(loaded.view, group)) throw new UsageError(GROUP_FULL)
    // The fold counts only the first writers a diary binds: a new one past
    // that cap would never count.
    if (boundWriterCount(loaded, ownHex) - (boxStale ? 1 : 0) >= groups.MAX_GROUP_WRITERS_PER_DIARY) throw new UsageError(GROUP_FULL)
    await makeGroupRoom(ctx, identity, group)
    const rejoin = foldRejoin(loaded.view, ownHex)
    const box = loaded.private ? ownBoxPublic(ctx) : null
    const nonce = hex(randomBytes(16))
    const writer = await openGroupWriter(store, nonce)
    writerKey = hex(writer.key)
    await appendGroupRecord(writer, group, buildRecord(() => groups.writerHeader({ group, diary: ownHex, member: cw, rejoin, box })))
    writeGroups(ctx.dataDir, [...localGroups(ctx.dataDir).filter((g) => g.group !== group), { group, writer: writerKey, nonce }])
  }
  await appendRecord(diary, groupJoinRecord({ group, writer: writerKey, on: true }))
  const next = await loadGroup(ctx, identity, group)
  return groupJoinState(next.view, ownHex, writerKey)
}

// rpc.md 5.37: joining needs a live CW in the group's community; `community`
// names it for a root not held yet.
async function groupJoin (ctx, { group, community }) {
  const hint = typeof community === 'string' ? community.toLowerCase() : null
  return withGroupOrPending(ctx, group, async (loaded, identity) => {
    if (identity.diary.length === 0) throw new Error(GENESIS_REQUIRED)
    if (hint !== null && hint !== loaded.header.community) throw new UsageError('o grupo não é dessa comunidade')
    requireParent(loaded)
    if (loaded.cw === null) throw new UsageError('entre na comunidade primeiro')
    return joinLoaded(ctx, identity, loaded, loaded.cw.writer)
  }, async (pending, identity) => {
    if (identity.diary.length === 0) throw new Error(GENESIS_REQUIRED)
    if (hint === null) throw new UsageError('informe a comunidade do grupo')
    const c = await loadCommunity(ctx, identity, hint)
    if (c === null) throw new UsageError('aguarde a sincronização da comunidade')
    if (c.cw === null) throw new UsageError('entre na comunidade primeiro')
    return pendingJoin(ctx, pending, identity, c.cw.writer)
  })
}

async function groupLeave (ctx, { group }) {
  return withGroupOrPending(ctx, group, async (loaded, identity) => {
    // A ban outlives any leave in the fold (status 'banned' wins over
    // 'left'), so a banned leave would report a state that never takes
    // effect. The fold applies a leave whatever the ban layer says of the
    // writers, so a ban that lingers for a writer an unban missed must not
    // lock the member in.
    if (loaded.view.members.get(identity.ownHex) === 'banned') throw groupPermission()
    // Already left in the fold, through any device: nothing to write.
    if (loaded.view.members.get(identity.ownHex) === 'left') return { state: 'left' }
    const own = leavingWriter(loaded, identity.ownHex)
    if (!own) throw new UsageError('nada a alterar')
    requireCounted(loaded, own.writer)
    // The creator's bound root keeps the cut rule: a leave that does not list
    // it would withdraw every root record from seq 0, so the creator leaves
    // only from a device whose cuts list the root.
    const cuts = countedCuts(loaded, identity.ownHex)
    const rootBound = (loaded.input.joins.get(identity.ownHex) || []).some((j) => j.on && j.writer === group)
    if (loaded.view.creator === identity.ownHex && rootBound && !cuts.some((c) => c.writer === group)) {
      throw new UsageError('saia pelo aparelho que criou o grupo')
    }
    const writer = await ownGroupWriter(loaded, identity)
    // seen orders the leave after everything this device folded, a rejoin of
    // another device of the diary included.
    await appendGroupRecord(writer, group, buildRecord(() => groups.groupLeave({ seen: loaded.view.last, cuts })))
    await appendRecord(identity.diary, groupJoinRecord({ group, writer: hex(writer.key), on: false }))
    return { state: 'left' }
  }, async (pending, identity) => {
    const local = requirePendingLocal(pending)
    const own = await pendingWriter(identity.store, local)
    if (own === null || own.leave) throw new UsageError('nada a alterar')
    // Without the root the fold is unknown, and a leave withdraws every
    // writer it does not list from seq 0: protecting the posts of the own
    // diary's other writers (another device, the creator's root), a pending
    // leave only goes when this device's writer is the only one bound.
    const joins = groups.groupJoinHistory(await readAll(identity.diary), pending.group)
    if (joins.some((j) => j.on && j.writer !== local.writer)) throw new UsageError('aguarde a sincronização do grupo para sair')
    await appendGroupRecord(own.core, pending.group, buildRecord(() => groups.groupLeave({ seen: null, cuts: [{ writer: local.writer, seq: own.core.length }] })))
    await appendRecord(identity.diary, groupJoinRecord({ group: pending.group, writer: local.writer, on: false }))
    return { state: 'left' }
  }, async (identity) => {
    // A root this node never folds keeps no slot: its entry goes. A created
    // group's entry is the only copy of the root nonce and stays.
    const key = group.toLowerCase()
    const entries = localGroups(ctx.dataDir)
    const entry = entries.find((g) => g.group === key)
    if (!entry || entry.writer === entry.group || entry.kind === 'community') throw groupNotFound()
    // Seeders stop counting the writer against the diary only after a leave
    // and a diary group-join off.
    let core = null
    try {
      core = await openGroupWriter(identity.store, entry.nonce)
      if (hex(core.key) === entry.writer && core.length > 0 && !(await readBlocks(core)).some(recordIsLeave)) {
        await appendGroupRecord(core, key, buildRecord(() => groups.groupLeave({ seen: null, cuts: [{ writer: entry.writer, seq: core.length }] })))
      }
    } finally {
      if (core !== null) await core.close()
    }
    const joins = groups.groupJoinHistory(await readAll(identity.diary), key).filter((j) => j.writer === entry.writer)
    if (joins.length > 0 && joins[joins.length - 1].on) await appendRecord(identity.diary, groupJoinRecord({ group: key, writer: entry.writer, on: false }))
    writeGroups(ctx.dataDir, entries.filter((g) => g.group !== key))
    return { state: 'left' }
  })
}

async function groupPost (ctx, { group, text, replyTo = null }) {
  return withGroup(ctx, group, async (loaded, identity) => {
    requireParent(loaded)
    const own = liveOwnWriter(loaded, identity.ownHex)
    if (!own || loaded.view.members.get(identity.ownHex) !== 'member') throw groupPermission()
    requireCounted(loaded, own.writer)
    const writer = await ownGroupWriter(loaded, identity)
    const record = buildRecord(() => groups.groupPost({ text, replyTo, seen: loaded.view.last }))
    return { seq: await appendGroupRecord(writer, group, groupRecordFor(loaded, writer, record), loaded.private) }
  }, { secrets: true })
}

function requireGroupAdmin (loaded, ownHex, root = false) {
  if (loaded.view.members.get(ownHex) !== 'member' || !loaded.view.admins.has(ownHex) || (root && loaded.view.creator !== ownHex)) throw groupPermission()
  // A root whose authority ended (its creator's diary marked it) writes
  // nothing the fold would count: refused rather than a silent success.
  if (root && !rootHasAuthority(loaded)) throw groupPermission()
}

// Whether the fold takes a `group: G` demotion through this creator's CW
// now: only from C's creator, once its diary marked G's root (a root void
// for a gap in that history alone gives none).
function gDemoteCounts (loaded, ownHex) {
  const C = loaded.view.community
  const marks = loaded.input.marks instanceof Map ? loaded.input.marks.get(ownHex) || [] : []
  return C !== null && C !== undefined && C.creator === ownHex &&
    marks.some((m) => m !== null && typeof m === 'object' && m.writer === loaded.group && Number.isSafeInteger(m.cut))
}

// A root its creator's diary marked (`group-cut`, written when it left C):
// whatever it appends now carries no authority.
function rootHasAuthority (loaded) {
  return loaded.view.rootCut === null || loaded.view.rootCut === undefined
}

// After a removal or an entitling record in a private group: a removal
// rotates, the rest hands the held epochs on (history on admit). The record
// stands on its own: a failure leaves the group rekey-pending (group.rekey
// retries) or a writer without history (the next admit, grant or
// group.rekey hands it).
function privateSideEffect (ctx, identity, group, removal, core = null) {
  return keySideEffect(() => withLoaded(ctx, identity, group, async (next) => {
    const writer = core !== null ? core : await distributorCore(next, identity)
    if (writer === null) return
    if (removal) await rotateEpoch(next, writer)
    else await handHistory(next, writer)
  }))
}

function groupModerate (ctx, type, { group, member, on }) {
  return withGroup(ctx, group, async (loaded, identity) => {
    requireParent(loaded)
    const { ownHex } = identity
    // Charter records go through the root. Admit and ban need a writer that
    // still writes; a leave, including another device's, ends it. Without
    // authority in G, a creator or admin of the community admits and bans
    // through its CW (rpc.md 5.45).
    const viaGroup = type === 'groupAdmin' || (liveOwnWriter(loaded, ownHex) !== null && holdsGroupAuthority(loaded, ownHex))
    // A creator whose G root lost authority (back after leaving C) can only
    // demote, through its live CW (owner decision, cycle 16).
    const rootGone = type === 'groupAdmin' && !rootHasAuthority(loaded)
    if (rootGone && (on || loaded.view.creator !== ownHex || loaded.cw === null)) throw groupPermission()
    if (rootGone && !gDemoteCounts(loaded, ownHex)) throw new UsageError(DEMOTE_PENDING)
    if (viaGroup) {
      if (type !== 'groupAdmin' && !liveOwnWriter(loaded, ownHex)) throw groupPermission()
      requireGroupAdmin(loaded, ownHex, type === 'groupAdmin' && !rootGone)
    } else if (!communityActs(loaded)) {
      throw groupPermission()
    }
    if (member === loaded.view.creator || (type !== 'groupAdmin' && loaded.view.admins.has(member))) throw groupPermission()
    if (viaGroup && type !== 'groupAdmin') requireCounted(loaded, loaded.local.writer)
    // Protecting the member from an admit that misses a counted writer not
    // held here: the fold admits only the writers an admit lists, so that
    // writer would stay hidden behind an admission that looks complete. An
    // admit again is allowed: it lists the writers the last one missed.
    if (type === 'groupAdmit' && on === true) {
      const unheld = unheldCountedWriters(loaded, member)
      if (unheld === null || unheld.length > 0) throw new UsageError('aguarde a sincronização do grupo para admitir')
    }
    // A grant names the promoted diary's writers at their local lengths, so
    // only records written after it gain authority.
    const cuts = type === 'groupAdmin' && on
      ? countedCuts(loaded, member, { signed: true })
      : groupCuts(loaded, member, { signed: (type === 'groupAdmit' && on === true) || (type === 'groupBan' && !on) })
    if (cuts.length > groups.MAX_GROUP_CUTS) throw new UsageError(GROUP_FULL)
    let lifts = null
    if (type === 'groupBan' && !on) {
      // bans, not members: a diary banned before it joined, whose writer is
      // not held here, or with a counted writer an earlier unban did not
      // list, is still banned and liftable through the same latest ban.
      lifts = loaded.view.bans.get(member) || null
      if (lifts === null) throw new UsageError('nada a alterar')
    }
    let writer = null
    if (rootGone) {
      const cw = await openOwnCw(identity, loaded.cw)
      if (cw === null) throw groupPermission()
      await appendGroupRecord(cw, loaded.header.community, buildRecord(() => groups.communityDemote({ group, member, cuts, seen: loaded.view.last })), false, true)
    } else if (viaGroup) {
      writer = await ownGroupWriter(loaded, identity, { root: type === 'groupAdmin' })
      await appendGroupRecord(writer, group, buildRecord(() => groups[type]({ member, on, cuts, lifts, seen: loaded.view.last })))
    } else {
      const cw = await openOwnCw(identity, loaded.cw)
      if (cw === null) throw groupPermission()
      const make = type === 'groupAdmit' ? groups.communityAdmit : groups.communityBan
      await appendGroupRecord(cw, loaded.header.community, buildRecord(() => make({ group, member, on, cuts, lifts, seen: loaded.view.last })), false, true)
    }
    if (loaded.private) await privateSideEffect(ctx, identity, group, type === 'groupBan' ? on : !on, writer)
    return { ok: true }
  })
}

// rpc.md 5.61: a new epoch from an authorized distributor, after handing
// the held epochs to entitled writers that miss them.
async function groupRekey (ctx, { group }) {
  return withGroup(ctx, group, async (loaded, identity) => {
    requireParent(loaded)
    if (!loaded.private) throw new UsageError('grupo público não usa chave')
    const core = await distributorCore(loaded, identity)
    if (core === null) throw groupPermission()
    await keySideEffect(() => handHistory(loaded, core))
    const epoch = await rotateEpoch(loaded, core)
    return { group: loaded.group, epoch: { writer: epoch.writer, seq: epoch.seq } }
  }, { secrets: true })
}

function groupAdmit (ctx, params) {
  return groupModerate(ctx, 'groupAdmit', params)
}

function groupBan (ctx, params) {
  return groupModerate(ctx, 'groupBan', params)
}

function groupAdmin (ctx, params) {
  return groupModerate(ctx, 'groupAdmin', params)
}

// The author keeps the right to hide their own posts after leaving: the
// fold takes an author hide from any bound writer of the author's diary, so
// it goes to this device's bound writer even when that writer has left.
// Hiding anyone else's post needs an acting admin and a live writer.
async function groupHide (ctx, { group, target, on }) {
  return withGroup(ctx, group, async (loaded, identity) => {
    const { ownHex } = identity
    requireParent(loaded)
    if (target === null || typeof target !== 'object') throw groupPermission()
    const writerHex = target.writer === undefined || target.writer === null ? '' : String(target.writer).toLowerCase()
    const log = loaded.logs.find((l) => l.key === writerHex)
    let allowed
    if (log !== undefined && log.diary === ownHex) {
      allowed = liveOwnWriter(loaded, ownHex) !== null ||
        (!!loaded.local && loaded.logs.some((l) => l.key === loaded.local.writer && l.diary === ownHex))
    } else {
      allowed = liveOwnWriter(loaded, ownHex) !== null && holdsGroupAuthority(loaded, ownHex)
      // Without authority in G, a community creator or admin hides through
      // its CW; the hide names the post only, so it travels in the clear.
      if (!allowed && communityActs(loaded)) {
        const cw = await openOwnCw(identity, loaded.cw)
        if (cw === null) throw groupPermission()
        await appendGroupRecord(cw, loaded.header.community, buildRecord(() => groups.communityHide({ group, target, on, seen: loaded.view.last })), false, true)
        return { ok: true }
      }
    }
    if (!allowed) throw groupPermission()
    requireCounted(loaded, loaded.local.writer)
    const writer = await ownGroupWriter(loaded, identity)
    const record = buildRecord(() => groups.groupHide({ target, on, seen: loaded.view.last }))
    await appendGroupRecord(writer, group, groupRecordFor(loaded, writer, record), loaded.private)
    return { ok: true }
  }, { secrets: true })
}

async function groupMeta (ctx, { group, name, join }) {
  return withGroup(ctx, group, async (loaded, identity) => {
    requireParent(loaded)
    requireGroupAdmin(loaded, identity.ownHex, true)
    if (name === undefined && join === undefined) throw new UsageError('nada a alterar')
    // A private group is always approval: a sealed meta with another join
    // is skipped by every reader.
    if (loaded.private && join !== undefined && join !== 'approval') throw new UsageError('grupo privado exige aprovação')
    const writer = await ownGroupWriter(loaded, identity, { root: true })
    const record = buildRecord(() => groups.groupMeta({ name: name === undefined ? loaded.view.name : name, join: join === undefined ? loaded.view.join : join, seen: loaded.view.last }))
    await appendGroupRecord(writer, group, groupRecordFor(loaded, writer, record), loaded.private)
    return { ok: true }
  }, { secrets: true })
}

// The posts older than `before`, in causal order. With the cursor post still
// in the fold, every post before it in the causal order, even if `at`
// differs. Without it (its diary was blocked between pages), each post whose
// order key (at, writer, seq) is below the cursor's, checked one by one in
// causal order: causal and key order can differ, so a count of such posts
// would not be a position in the causal array.
function groupOlder (posts, before) {
  if (before === null || before === undefined) return posts
  const i = posts.findIndex((p) => p.writer === before.writer && p.seq === before.seq)
  if (i >= 0) return posts.slice(0, i)
  const k = groups.orderKey(before.at, before.writer, before.seq)
  return posts.filter((p) => groups.compareOrder(groups.orderKey(p.at, p.writer, p.seq), k) < 0)
}

async function groupRead (ctx, { group, limit = 30, before = null }) {
  return withGroupOrPending(ctx, group, async (loaded) => {
    const posts = groupOlder(loaded.view.posts.filter((p) => loaded.profiles.has(p.diary)), before)
    const start = Math.max(0, posts.length - limit)
    const items = posts.slice(start).reverse().map((p) => ({
      ...p,
      text: p.hidden ? '' : p.text,
      ...loaded.profiles.get(p.diary)
    }))
    const last = items[items.length - 1]
    return {
      items,
      next: start > 0 && last ? { at: last.at, writer: last.writer, seq: last.seq } : null,
      hidden: items.filter((p) => p.hidden).length,
      incomplete: loaded.view.incomplete,
      ...readState(loaded.view)
    }
  }, (pending) => {
    requirePendingLocal(pending)
    return { items: [], next: null, hidden: 0, incomplete: true, sealed: 0, epoch: null, state: 'ok' }
  })
}

async function groupList (ctx, { offset = 0, limit = 30 } = {}) {
  return withIdentity(ctx, async (identity) => {
    // A blocked group (enforcing a group block) loads as NOT_FOUND, so it is
    // left out of the list and of `total`.
    const list = []
    for (const group of new Set(localGroups(ctx.dataDir).filter((g) => g.kind !== 'community').map((g) => g.group))) {
      try {
        const loaded = await loadGroup(ctx, identity, group)
        // An orphan (its community does not list it) is left out.
        if (loaded.view.orphan) continue
        list.push({ ...groupSummary(group, loaded.view, identity.ownHex), community: loaded.header.community })
      } catch (err) {
        if (err.code !== 'NOT_FOUND') throw err
        if (err.pending && err.pending.local !== null) list.push({ group, ...PENDING_INFO, community: null })
      }
    }
    return { groups: list.slice(offset, offset + limit), total: list.length }
  })
}

async function groupInfo (ctx, { group }) {
  return withGroupOrPending(ctx, group, async ({ view, header }, { ownHex }) => ({
    ...groupSummary(group, view, ownHex),
    creator: view.creator,
    state: view.members.get(ownHex) || 'left',
    community: header.community,
    orphan: view.orphan === true,
    visibility: view.visibility === 'private' ? 'private' : 'public'
  }), (pending) => {
    requirePendingLocal(pending)
    return { group: pending.group, ...PENDING_INFO, creator: null, state: 'pending', community: null, orphan: false, visibility: 'public' }
  })
}

// Header times of the diary's bound writers, oldest first.
function writerHeaderTimes (loaded, member) {
  const times = []
  for (const log of loaded.logs) {
    if (log.diary !== member) continue
    const header = log.entries[0] && log.entries[0].record
    if (header && typeof header.at === 'string') times.push(header.at)
  }
  times.sort()
  return times
}

async function groupMembers (ctx, { group, offset = 0, limit = 100 }) {
  return withGroup(ctx, group, async (loaded) => {
    const members = [...loaded.view.members].filter(([key, state]) => loaded.profiles.has(key) && (state === 'member' || state === 'banned'))
    return {
      members: members.slice(offset, offset + limit).map(([member, state]) => ({
        member,
        ...loaded.profiles.get(member),
        admin: loaded.view.admins.has(member),
        banned: state === 'banned',
        joinedAt: writerHeaderTimes(loaded, member)[0] || null
      })),
      total: members.length
    }
  })
}

async function groupRequests (ctx, { group, offset = 0, limit = 100 }) {
  return withGroup(ctx, group, async (loaded, { ownHex }) => {
    requireGroupAdmin(loaded, ownHex)
    return {
      requests: loaded.view.requests.slice(offset, offset + limit).map((member) => {
        const times = writerHeaderTimes(loaded, member)
        return {
          member,
          ...loaded.profiles.get(member),
          // Newest header: a rejoin is a new request.
          at: times.length > 0 ? times[times.length - 1] : null
        }
      }),
      total: loaded.view.requests.length
    }
  })
}

// ---- communities (docs/protocol.md, "Communities contain groups") ----

const COMMUNITY_FULL = 'limite da comunidade atingido'
// A creator back in C whose demotion through its CW the fold would ignore
// (its leave is not confirmed yet): refused rather than a silent success.
const DEMOTE_PENDING = 'sem permissão: a saída anterior ainda não foi confirmada'
const GERAL_STAYS = 'o grupo Geral só sai com a comunidade'
const CREATE_FILE = 'community-create.json'
const LEAVE_FILE = 'community-leave.json'
const PENDING_COMMUNITY = { name: null, join: null, creator: null, role: 'pending', state: 'pending', members: 0, admins: 0, groups: [], general: null, incomplete: true, leavePending: false, repair: false, dropped: [] }

function communityNotFound () {
  const err = new Error('comunidade não encontrada')
  err.code = 'NOT_FOUND'
  return err
}

function communityPermission () {
  return new UsageError('sem permissão na comunidade')
}

// withGroup for a community: `pending` (when given) answers while the root
// is not held, else the call waits for the sync.
function withCommunity (ctx, community, fn, pending = null) {
  return withIdentity(ctx, async (identity) => {
    const c = await loadCommunity(ctx, identity, community)
    if (c === null) {
      if (pending !== null) return pending(community.toLowerCase(), identity)
      throw new UsageError('aguarde a sincronização da comunidade')
    }
    return fn(c, identity)
  })
}

function appendCommunityRecord (core, community, record) {
  return appendGroupRecord(core, community, record, false, true)
}

// The groups of community `key` in this device's local list (their headers
// name it); `affected` (a Set or null) receives them with the community.
async function localGroupsOf (ctx, identity, key) {
  const out = []
  for (const g of new Set(localGroups(ctx.dataDir).filter((e) => e.kind !== 'community').map((e) => e.group))) {
    try {
      const loaded = await loadGroup(ctx, identity, g)
      if (loaded.header.community === key) out.push(loaded)
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err
    }
  }
  return out
}

function noteAffected (affected, keys) {
  if (affected === null) return
  for (const k of keys) affected.add(k)
}

// A community write that ends or grants key power: every held private group
// of C in which this node distributes rotates (`removal`) or hands its held
// epochs on, best effort after the community write.
async function communityKeyEffects (ctx, identity, held, removal) {
  for (const loaded of held) {
    if (loaded.private) await privateSideEffect(ctx, identity, loaded.group, removal)
  }
}

// ---- community.create (rpc.md 5.57) ----
//
// Two cores, the community root and Geral, written in steps a crash can
// interrupt. The keys are fixed before anything is written and kept in
// data/community-create.json, so the next community.create or
// community.info finishes the same community instead of making another.

function createFile (dataDir) {
  return path.join(dataDir, CREATE_FILE)
}

function readCreateResume (dataDir) {
  let data
  try {
    data = storeLib.readJson(createFile(dataDir), null)
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || data.v !== 1) return null
  for (const k of ['community', 'group']) if (typeof data[k] !== 'string' || !/^[0-9a-f]{64}$/.test(data[k])) return null
  for (const k of ['communityNonce', 'groupNonce']) if (typeof data[k] !== 'string' || !/^[0-9a-f]{32}$/.test(data[k])) return null
  return data
}

function removeCreateResume (dataDir) {
  fs.rmSync(createFile(dataDir), { force: true })
}

// ---- the creator's own leave note ----
//
// When C's creator appends its C leave, data/community-leave.json keeps
// which block it wrote ({ community, writer, seq, hash } per community)
// until the diary confirms it. A later community.leave confirms only that
// block: a leave that reached the own CW by replication (anyone holding a
// copy of the CW key) is never confirmed by this device.

function leaveFile (dataDir) {
  return path.join(dataDir, LEAVE_FILE)
}

function readLeaveNotes (dataDir) {
  let data
  try {
    data = storeLib.readJson(leaveFile(dataDir), null)
  } catch {
    return []
  }
  if (data === null || typeof data !== 'object' || data.v !== 2 || !Array.isArray(data.notes)) return []
  return data.notes.filter(validLeaveNote)
}

// { community, writer, seq, digest, roots: [{ group, cut }] }: the C leave
// this creator device appends at `seq` on its CW `writer` (its leaveDigest),
// and the length of each group root of C it held at leave time.
function validLeaveNote (n) {
  return n !== null && typeof n === 'object' && HEX64.test(n.community) && HEX64.test(n.writer) &&
    typeof n.digest === 'string' && HEX64.test(n.digest) && Number.isSafeInteger(n.seq) && n.seq >= 1 &&
    Array.isArray(n.roots) && n.roots.every((r) => r !== null && typeof r === 'object' && HEX64.test(r.group) && Number.isSafeInteger(r.cut) && r.cut >= 1)
}

function writeLeaveNotes (dataDir, notes) {
  if (notes.length === 0) fs.rmSync(leaveFile(dataDir), { force: true })
  else storeLib.writeJsonAtomic(leaveFile(dataDir), { v: 2, notes }, 0o600)
}

function leaveNote (dataDir, C) {
  return readLeaveNotes(dataDir).find((n) => n.community === C) || null
}

function setLeaveNote (dataDir, note) {
  writeLeaveNotes(dataDir, [...readLeaveNotes(dataDir).filter((n) => n.community !== note.community), note])
}

function clearLeaveNote (dataDir, C) {
  const notes = readLeaveNotes(dataDir)
  if (notes.some((n) => n.community === C)) writeLeaveNotes(dataDir, notes.filter((n) => n.community !== C))
}

// Whether the block at `seq` of `core` is the group-leave of `digest`.
// The block itself, not the contiguous prefix: a forced leave of the
// creator lands past a held-back tail of its own root.
async function leaveAtMatches (core, seq, digest) {
  if (core.fork !== 0 || seq >= core.length || !(await core.has(seq))) return false
  let entry = null
  try {
    entry = { seq, record: decodeBlock(await core.get(seq, { wait: false, raw: true })) }
  } catch {}
  return entry !== null && recordIsLeave(entry) && groups.leaveDigest(entry.record) === digest
}

// Whether the own CW still holds, at the note's seq, the exact group-leave
// this device wrote. A forked CW never matches (the fold drops it too).
async function noteMatches (store, local, note) {
  if (note === null || note.writer !== local.writer) return false
  let core
  try {
    core = await openGroupWriter(store, local.nonce)
  } catch {
    return false
  }
  try {
    if (hex(core.key) !== local.writer) return false
    return await leaveAtMatches(core, note.seq, note.digest)
  } catch {
    return false
  } finally {
    await core.close()
  }
}

// The diary's group-confirm naming the community leave this call appended:
// the fold trusts a leave only through it, never through an off join.
function confirmLeave (identity, C, writer, seq, record) {
  const digest = groups.leaveDigest(record)
  if (digest === null) throw new Error('registro inválido: group-leave')
  return appendRecord(identity.diary, buildRecord(() => groupConfirmRecord({ group: C, writer, seq, digest })))
}

// Whether the diary already confirms the leave at `seq` on `writer`.
async function leaveConfirmed (identity, C, writer, seq, digest) {
  return groups.groupConfirmHistory(await readAll(identity.diary), C).some((e) => e.writer === writer && e.seq === seq && e.digest === digest)
}

function addLocalEntry (dataDir, entry) {
  const entries = localGroups(dataDir)
  if (!entries.some((e) => e.group === entry.group)) writeGroups(dataDir, [...entries, entry])
}

async function ensureJoin (diary, group, writer, rejoin = null) {
  const joins = groups.groupJoinHistory(await readAll(diary), group).filter((j) => j.writer === writer)
  if (joins.length === 0 || !joins[joins.length - 1].on) await appendRecord(diary, groupJoinRecord({ group, writer, on: true, ...(rejoin ? { rejoin } : {}) }))
}

// The rejoin the header of the own CW `local` names, or null.
async function localHeaderRejoin (store, local) {
  const core = await openGroupWriter(store, local.nonce)
  try {
    if (hex(core.key) !== local.writer || core.length === 0) return null
    const first = (await readBlocks(core))[0]
    const r = first && first.record !== null && typeof first.record === 'object' ? first.record.rejoin : null
    return r !== null && typeof r === 'object' ? { writer: r.writer, seq: r.seq } : null
  } finally {
    await core.close()
  }
}

// Steps 4 to 9 of community.create, each skipped when already done.
async function finishCommunityCreate (ctx, identity, rec) {
  const { store, diary, ownHex } = identity
  const C = rec.community
  const G = rec.group
  const root = await openGroupWriter(store, rec.communityNonce)
  const geral = await openGroupWriter(store, rec.groupNonce)
  if (hex(root.key) !== C || hex(geral.key) !== G) throw new Error('registro de criação de comunidade inválido')
  if (root.length === 0) {
    await appendCommunityRecord(root, C, buildRecord(() => groups.groupHeader({ kind: 'community', diary: ownHex, join: rec.join, name: rec.name, at: rec.at })))
  }
  // The nonce is the only way back to the root: recorded before the diary
  // binds it, as for a group.
  addLocalEntry(ctx.dataDir, { group: C, writer: C, nonce: rec.communityNonce, kind: 'community' })
  await ensureJoin(diary, C, C)
  if (geral.length === 0) {
    await appendGroupRecord(geral, G, buildRecord(() => groups.groupHeader({ kind: 'group', diary: ownHex, community: C, member: C, join: 'open', name: 'Geral', at: rec.at })))
  }
  addLocalEntry(ctx.dataDir, { group: G, writer: G, nonce: rec.groupNonce })
  await ensureJoin(diary, G, G)
  const entries = await readBlocks(root)
  if (!entries.some((e) => e.seq >= 1 && e.record && e.record.type === 'group-create' && e.record.group === G)) {
    await appendCommunityRecord(root, C, groups.groupCreateRecord({ group: G, seen: null }))
  }
  removeCreateResume(ctx.dataDir)
  return { community: C, group: G }
}

async function communityCreate (ctx, { name, join }, { affected = null } = {}) {
  return withIdentity(ctx, async (identity) => {
    const { store, diary, ownHex } = identity
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const pending = readCreateResume(ctx.dataDir)
    if (pending !== null) {
      // Started (the root has its header) or asked again the same way: the
      // same community. Otherwise the record of a create that wrote nothing
      // gives way.
      const root = await openGroupWriter(store, pending.communityNonce)
      if (root.length > 0 || (pending.name === name && pending.join === join)) {
        const done = await finishCommunityCreate(ctx, identity, pending)
        noteAffected(affected, [done.community, done.group])
        return done
      }
      removeCreateResume(ctx.dataDir)
    }
    buildRecord(() => groups.groupHeader({ kind: 'community', diary: ownHex, join, name }))
    await makeGroupRoom(ctx, identity, null, 2)
    const communityNonce = hex(randomBytes(16))
    const groupNonce = hex(randomBytes(16))
    const root = await openGroupWriter(store, communityNonce)
    const geral = await openGroupWriter(store, groupNonce)
    const rec = { v: 1, community: hex(root.key), communityNonce, group: hex(geral.key), groupNonce, name, join, at: nowIso() }
    storeLib.writeJsonAtomic(createFile(ctx.dataDir), rec, 0o600)
    const done = await finishCommunityCreate(ctx, identity, rec)
    noteAffected(affected, [done.community, done.group])
    return done
  })
}

// ---- membership ----

// The Geral step of community.join: a writer in Geral through the own CW
// when the caller has none that still writes. Geral full, or refusing the
// caller, leaves `group: null`; the community join stands.
async function joinGeral (ctx, identity, c) {
  const G = c.view.general
  const own = liveOwnWriter(c, identity.ownHex)
  if (G === null || own === null) return null
  try {
    let loaded
    try {
      loaded = await loadGroup(ctx, identity, G)
    } catch (err) {
      if (err.pending === undefined) throw err
      await pendingJoin(ctx, err.pending, identity, own.writer)
      return G
    }
    // A writer that still writes answers without a new one (joinLoaded).
    await joinLoaded(ctx, identity, loaded, own.writer)
    return G
  } catch (err) {
    if (err.code === 'USAGE' || err.code === 'NOT_FOUND') return null
    throw err
  }
}

// rpc.md 5.63.
async function communityJoin (ctx, { community }, { affected = null } = {}) {
  return withIdentity(ctx, async (identity) => {
    const { diary, store, ownHex } = identity
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    let c = await loadCommunity(ctx, identity, community)
    const C = community.toLowerCase()
    if (c === null) {
      await pendingJoin(ctx, { group: C, local: communityEntry(ctx.dataDir, C) || null }, identity, null, 'community')
      noteAffected(affected, [C])
      return { state: 'pending', group: null }
    }
    // bans, not members: a diary banned before it had a writer is not listed.
    if (c.view.bans.has(ownHex)) throw communityPermission()
    if (!c.diaryEntries.has(ownHex)) throw communityPermission()
    // The creator's own leave this device noted but did not finish is
    // finished first: once the entry moves to a new CW it never can be,
    // and the root would keep its authority. A failure joins nothing.
    if (await leavePending(ctx, identity, c)) {
      await finishCreatorLeave(ctx, identity, c)
      c = await loadCommunity(ctx, identity, C)
      if (c === null) throw new UsageError('aguarde a sincronização da comunidade')
    }
    let writerKey = null
    const live = liveOwnWriter(c, ownHex)
    if (live) {
      writerKey = live.writer
    } else {
      const left = c.view.members.get(ownHex) === 'left'
      // Only a CW never bound (a crash before its diary join) is reused: a
      // bound CW the fold does not take as live (a leave of this or another
      // device of the diary ended it) is retired for good.
      let rejoin = null
      if (!left && unboundLocal(c) && !(await localWriterHasLeave(store, c.local))) {
        writerKey = c.local.writer
        rejoin = await localHeaderRejoin(store, c.local)
      }
      if (writerKey === null) {
        if (groupWritersFull(c.view, C)) throw new UsageError(COMMUNITY_FULL)
        if (boundWriterCount(c, ownHex) >= groups.MAX_GROUP_WRITERS_PER_DIARY) throw new UsageError(COMMUNITY_FULL)
        const general = c.view.general
        const need = 1 + (general !== null && !localGroups(ctx.dataDir).some((e) => e.group === general) ? 1 : 0)
        await makeGroupRoom(ctx, identity, null, need)
        const named = await ownRejoinLeave(ctx, identity, c, C)
        c = named.c
        rejoin = named.rejoin
        const nonce = hex(randomBytes(16))
        const writer = await openGroupWriter(store, nonce)
        writerKey = hex(writer.key)
        await appendCommunityRecord(writer, C, buildRecord(() => groups.writerHeader({ group: C, diary: ownHex, member: null, rejoin })))
        writeGroups(ctx.dataDir, [...localGroups(ctx.dataDir).filter((g) => g.group !== C), { group: C, writer: writerKey, nonce, kind: 'community' }])
      }
      // The first on-join signs the header's rejoin: without it the fold
      // takes the CW as generation 0, retired by any earlier leave.
      await ensureJoin(diary, C, writerKey, rejoin)
      c = await loadCommunity(ctx, identity, C)
    }
    // A root this node cannot bind (its creator's diary not held or not
    // admitted here) holds nobody yet: the next sync decides.
    if (c.view.creator === null) return { state: 'pending', group: null }
    const status = c.view.members.get(ownHex)
    if (status !== 'requested' && status !== 'left' && !c.view.writers.has(writerKey)) throw new UsageError(COMMUNITY_FULL)
    const state = status === 'requested' || status === 'left' ? status : 'member'
    const group = state === 'left' ? null : await joinGeral(ctx, identity, c)
    noteAffected(affected, group === null ? [C] : [C, group])
    return { state, group }
  })
}

// The group roots of C's catalogue the own diary bound (an on join with the
// root as writer: a copy of the C root key can name any group in the
// catalogue, never forge that), each held here at its length now: the cuts
// the creator's leave note records. A bound root held forked, or whose
// header is not a group of C created by this diary (a C root key copy can
// list a group of another community), is skipped; a bound root not held
// (or holding nothing) is `missing`: the creator waits for the sync, or
// leaves it unmarked with `force`. Once the fold bounds C's root by a
// confirmed creator leave (a finite `creatorConfirmSeq`), a root left
// unmarked stays unmarked: the fold ignores any later mark. A confirm that
// bounds nothing (a leave on another CW) never stops the marks.
async function catalogueRoots (identity, c) {
  const { store, ownHex } = identity
  const keys = c.view.created instanceof Map ? [...c.view.created.keys()] : c.view.groups
  const entries = await readAll(identity.diary)
  const confirmedBefore = Number.isFinite(c.view.creatorConfirmSeq)
  const roots = []
  let missing = 0
  for (const group of keys) {
    if (!groups.groupJoinHistory(entries, group).some((j) => j.on && j.writer === group)) continue
    if (confirmedBefore && !groups.groupCutHistory(entries, group).some((m) => m.writer === group)) continue
    if (!(await replicaStored(store, group))) {
      missing++
      continue
    }
    const core = store.get({ key: b4a.from(group, 'hex'), writable: false, active: false })
    try {
      await core.ready()
      if (core.fork !== 0) continue
      if (core.contiguousLength === 0) {
        missing++
        continue
      }
      let h = null
      try {
        h = decodeBlock(await core.get(0, { wait: false, raw: true }))
      } catch {}
      if (groups.validateGroupHeader(h) !== null || h.kind !== 'group' || h.community !== c.group || h.diary !== ownHex) continue
      roots.push({ group, cut: core.contiguousLength })
    } finally {
      await core.close()
    }
  }
  return { roots, missing }
}

// The creator's diary marks how far each group root of C went, at the cuts
// its leave note recorded (never at a length the root reached later):
// `missingOnly` skips a root this diary already marked. Every root is tried
// and the first failure is thrown after the rest. `ctx.onMark(group)`, when
// given, runs before each append (a test seam to simulate a failure).
async function markRoots (ctx, identity, roots, missingOnly) {
  const entries = missingOnly ? await readAll(identity.diary) : null
  let failed = null
  for (const { group, cut } of roots) {
    if (missingOnly && groups.groupCutHistory(entries, group).some((m) => m.writer === group)) continue
    try {
      if (typeof ctx.onMark === 'function') await ctx.onMark(group)
      await appendRecord(identity.diary, groupCutRecord({ group, writer: group, cut }))
    } catch (err) {
      if (failed === null) failed = err
    }
  }
  if (failed !== null) throw failed
}

// Whether the diary still has the own CW `local` turned on in C.
async function cwStillOn (identity, C, local) {
  const joins = groups.groupJoinHistory(await readAll(identity.diary), C).filter((j) => j.writer === local.writer)
  return joins.length > 0 && joins[joins.length - 1].on
}

// A creator out of C whose own CW holds the C leave this device noted
// while its diary has not finished it yet: writes the missing root marks
// at the noted cuts, the group-confirm of exactly that leave unless
// present, then the off join. -> whether it wrote anything.
async function finishCreatorLeave (ctx, identity, c) {
  const { ownHex, store } = identity
  const local = c.local
  if (c.view.creator !== ownHex || !local) return false
  if (!(await cwStillOn(identity, c.group, local))) return false
  const note = leaveNote(ctx.dataDir, c.group)
  if (!(await noteMatches(store, local, note))) return false
  await markRoots(ctx, identity, note.roots, true)
  if (!(await leaveConfirmed(identity, c.group, note.writer, note.seq, note.digest))) {
    await appendRecord(identity.diary, buildRecord(() => groupConfirmRecord({ group: c.group, writer: note.writer, seq: note.seq, digest: note.digest })))
  }
  await appendRecord(identity.diary, groupJoinRecord({ group: c.group, writer: local.writer, on: false }))
  clearLeaveNote(ctx.dataDir, c.group)
  return true
}

// group.leave's write on a group loaded before the community leave: a
// group-leave on the own live writer with cuts over the own counted
// writers (the root's own when this device created the group). Returns
// { group, writer, seq } of the leave, or null when there is no live
// writer or the creator's root would be left out of the cuts. The caller
// turns the diary join off after the community leave.
async function leaveHeldGroup (loaded, identity) {
  const { ownHex } = identity
  const group = loaded.group
  const own = liveOwnWriter(loaded, ownHex)
  if (!own || !loaded.view.writers.has(own.writer)) return null
  const cuts = countedCuts(loaded, ownHex)
  const rootBound = (loaded.input.joins.get(ownHex) || []).some((j) => j.on && j.writer === group)
  if (loaded.view.creator === ownHex && rootBound && !cuts.some((c) => c.writer === group)) return null
  const writer = await ownGroupWriter(loaded, identity)
  const seq = await appendGroupRecord(writer, group, buildRecord(() => groups.groupLeave({ seen: loaded.view.last, cuts })))
  return { group, writer: hex(writer.key), seq }
}

const DEVICES_WAIT = 'aguarde a sincronização dos seus aparelhos nesta comunidade para sair'

// Whether a counted CW of `diary` in C other than the root is not held here
// or is held below its signed length.
function ownCwsBehind (c, diary) {
  const C = c.group
  if ((unheldCountedWriters(c, diary) || []).some((w) => w !== C)) return true
  return c.logs.some((l) => l.diary === diary && l.key !== C && c.view.writers.has(l.key) && l.length < (l.signed || 0))
}

// rpc.md 5.64: group-leave in the own CW (or the root for the creator's
// device) listing every counted CW of the diary. Nothing is written in the
// groups: the gate makes the diary leave them all.
async function communityLeave (ctx, { community, force = false }, { affected = null } = {}) {
  return withIdentity(ctx, async (identity) => {
    const { ownHex } = identity
    let c
    try {
      c = await loadCommunity(ctx, identity, community)
    } catch (err) {
      if (err.unfoldable !== true) throw err
      // A joined root that never folds keeps no slot: the CW ends where it
      // can and the entry goes. A created root's entry holds its only nonce.
      const C = community.toLowerCase()
      const entries = localGroups(ctx.dataDir)
      const local = entries.find((g) => g.group === C && g.kind === 'community')
      if (!local || local.writer === C) throw err
      const own = await pendingWriter(identity.store, local).catch(() => null)
      let ended = null
      if (own !== null && !own.leave) {
        try {
          const record = buildRecord(() => groups.groupLeave({ seen: null, cuts: [{ writer: local.writer, seq: own.core.length }] }))
          ended = { record, seq: await appendCommunityRecord(own.core, C, record) }
        } catch {}
      }
      // The diary confirms a leave on that CW (it bounds the diary's other
      // devices) only for a leave this call appended: a leave already there
      // may be one a cloned key wrote.
      if (ended !== null) await confirmLeave(identity, C, local.writer, ended.seq, ended.record)
      const joins = groups.groupJoinHistory(await readAll(identity.diary), C).filter((j) => j.writer === local.writer)
      if (ended !== null && joins.length > 0 && joins[joins.length - 1].on) await appendRecord(identity.diary, groupJoinRecord({ group: C, writer: local.writer, on: false }))
      writeGroups(ctx.dataDir, entries.filter((g) => g !== local))
      noteAffected(affected, [C])
      return { state: 'left' }
    }
    if (c === null) {
      const C = community.toLowerCase()
      const local = communityEntry(ctx.dataDir, C)
      if (!local) throw new UsageError('nada a alterar')
      const own = await pendingWriter(identity.store, local)
      if (own === null || own.leave) throw new UsageError('nada a alterar')
      const joins = groups.groupJoinHistory(await readAll(identity.diary), C)
      if (joins.some((j) => j.on && j.writer !== local.writer)) throw new UsageError('aguarde a sincronização da comunidade para sair')
      const record = buildRecord(() => groups.groupLeave({ seen: null, cuts: [{ writer: local.writer, seq: own.core.length }] }))
      const seq = await appendCommunityRecord(own.core, C, record)
      await confirmLeave(identity, C, local.writer, seq, record)
      await appendRecord(identity.diary, groupJoinRecord({ group: C, writer: local.writer, on: false }))
      noteAffected(affected, [C])
      return { state: 'left' }
    }
    const C = c.group
    const status = c.view.members.get(ownHex)
    if (status === 'banned') throw communityPermission()
    // C's creator whose leave is written but not confirmed (a mark failed, or
    // a crash after the note): the missing marks, then the off join, whatever
    // the diary's status now (a return from another device keeps the diary a
    // member, and this leave would otherwise stay unconfirmed for good).
    if (await leavePending(ctx, identity, c)) {
      await finishCreatorLeave(ctx, identity, c)
      noteAffected(affected, [C])
      return { state: 'left' }
    }
    if (status === 'left') return { state: 'left' }
    // A member leaves through its live CW, or through a bound, counted CW
    // holding no leave that C's ban layer still covers (an unban missed it):
    // a member is never locked in C.
    const own = liveOwnWriter(c, ownHex) || (status === 'member' ? leavingWriter(c, ownHex) : null)
    if (!own) throw new UsageError('nada a alterar')
    if (!c.view.writers.has(own.writer)) throw new UsageError(COMMUNITY_FULL)
    const cuts = countedCuts(c, ownHex)
    const rootBound = (c.input.joins.get(ownHex) || []).some((j) => j.on && j.writer === C)
    if (c.view.creator === ownHex && rootBound && !cuts.some((x) => x.writer === C)) {
      throw new UsageError('saia pelo aparelho que criou a comunidade')
    }
    const creator = c.view.creator === ownHex
    // `force`: true skips every wait, a list only the waits it names.
    const skip = (name) => force === true || (Array.isArray(force) && force.includes(name))
    // The creator's leave lists C's root at the contiguous length held here:
    // a copy behind the root's signed length cuts it short, so the creator
    // waits for the sync unless it chose to leave anyway (a held-back tail
    // then never counts, the side that grants the root less).
    if (creator && rootBound && !skip('root')) {
      const rootLog = c.logs.find((l) => l.key === C)
      if (!rootLog || rootLog.length < (rootLog.signed || 0)) throw new UsageError('este aparelho ainda não baixou tudo da comunidade: aguarde para sair')
    }
    // A bound root not here yet would stay unmarked: the creator waits for
    // the sync unless it chose to leave anyway (the fold then voids what the
    // root did before, as for any unmarked root).
    // The same for its other counted CWs of C: one not held or held short
    // would be listed short, or not at all (the fold then withdraws it from
    // seq 0).
    if (creator && !skip('devices') && ownCwsBehind(c, ownHex)) {
      throw new UsageError(DEVICES_WAIT)
    }
    if (creator && !skip('groups') && (await catalogueRoots(identity, c)).missing > 0) {
      throw new UsageError('aguarde a sincronização dos grupos da comunidade para sair')
    }
    const held = await localGroupsOf(ctx, identity, C)
    const writer = await ownGroupWriter(c, identity)
    // The own live writer in each group of C ends there first: the G leave
    // cuts this device's later posts by seq. A departed device keeps no
    // authority in the groups whatever is written (the fold voids it), so
    // a group whose leave fails changes nothing but its posts' bound.
    const ended = []
    for (const loaded of held) {
      try {
        const ref = await leaveHeldGroup(loaded, identity)
        if (ref !== null) ended.push(ref)
      } catch {}
    }
    const record = buildRecord(() => groups.groupLeave({ seen: c.view.last, cuts }))
    const writerHex = hex(writer.key)
    // The creator's note goes before the append, so a crash right after it
    // still lets a later community.leave finish exactly this leave, with the
    // roots' lengths of now (read again after the group leaves, so a root's
    // own group leave lies below its cut).
    const note = creator ? { community: C, writer: writerHex, seq: writer.length, digest: groups.leaveDigest(record), roots: (await catalogueRoots(identity, c)).roots } : null
    if (note !== null) setLeaveNote(ctx.dataDir, note)
    if (typeof ctx.onLeaveNote === 'function') await ctx.onLeaveNote(C)
    const leaveSeq = await appendCommunityRecord(writer, C, record)
    if (note !== null && (leaveSeq !== note.seq || !(await leaveAtMatches(writer, leaveSeq, note.digest)))) {
      throw new Error('a saída gravada não confere; tente sair de novo')
    }
    // The creator's diary marks how far each group root it holds went: from
    // there on the root has no authority, even after a return (a stolen
    // creating device could otherwise act through it once the creator is
    // back). The marks go before the group-confirm, so a crash in between
    // never leaves a confirmed leave with roots unmarked; each root is
    // tried, and the first failure is reported after the rest. A failed
    // mark leaves the leave unconfirmed: a later community.leave writes the
    // missing marks, the group-confirm, then the off join.
    if (note !== null) await markRoots(ctx, identity, note.roots, false)
    await confirmLeave(identity, C, writerHex, leaveSeq, record)
    await appendRecord(identity.diary, groupJoinRecord({ group: C, writer: writerHex, on: false }))
    if (creator) clearLeaveNote(ctx.dataDir, C)
    for (const { group, writer: w } of ended) {
      try {
        await appendRecord(identity.diary, groupJoinRecord({ group, writer: w, on: false }))
      } catch {}
    }
    noteAffected(affected, [C, ...held.map((g) => g.group)])
    return { state: 'left' }
  })
}

// ---- moderation ----

function requireCommunityAdmin (c) {
  if (c.cw === null || !c.view.authorityWriters.has(c.cw.writer)) throw communityPermission()
}

// rpc.md 5.64: a confirmed leave of the creator ends the root's powers for
// good, so whatever the root appends after it the fold voids; refusing here
// keeps a returning creator from writing records that silently never count.
function requireRootAuthority (c) {
  if (c.view.rootAuthority !== true) throw communityPermission()
}

// rpc.md 5.67 / 5.68: admit and ban with `group: null` through the own live
// CW, cuts over the member's CWs.
function communityModerate (ctx, type, { community, member, on }, { affected = null } = {}) {
  return withCommunity(ctx, community, async (c, identity) => {
    const C = c.group
    requireCommunityAdmin(c)
    if (member === c.view.creator || c.view.admins.has(member)) throw communityPermission()
    if (type === 'admit' && on === true) {
      // Only a request (or a member a former admit missed) is admitted: a
      // diary that left, or never asked, has nothing to admit.
      const status = c.view.members.get(member)
      if (status !== 'requested' && status !== 'member') throw new UsageError('nada a alterar')
      const unheld = unheldCountedWriters(c, member)
      if (unheld === null || unheld.length > 0) throw new UsageError('aguarde a sincronização da comunidade para admitir')
    }
    const signed = (type === 'admit' && on === true) || (type === 'ban' && !on)
    const cuts = countedCuts(c, member, { signed }).slice(0, groups.MAX_GROUP_CUTS)
    let lifts = null
    if (type === 'ban' && !on) {
      lifts = c.view.bans.get(member) || null
      if (lifts === null) throw new UsageError('nada a alterar')
    }
    const record = type === 'admit'
      ? buildRecord(() => groups.communityAdmit({ group: null, member, on, cuts, seen: c.view.last }))
      : buildRecord(() => groups.communityBan({ group: null, member, on, cuts, lifts, seen: c.view.last }))
    const cw = await openOwnCw(identity, c.cw)
    if (cw === null) throw communityPermission()
    await appendCommunityRecord(cw, C, record)
    const held = await localGroupsOf(ctx, identity, C)
    const removal = type === 'ban' ? on : !on
    if (removal) await communityKeyEffects(ctx, identity, held, true)
    noteAffected(affected, [C, ...held.map((g) => g.group)])
    return { ok: true }
  })
}

function communityAdmit (ctx, params, opts) {
  return communityModerate(ctx, 'admit', params, opts)
}

function communityBan (ctx, params, opts) {
  return communityModerate(ctx, 'ban', params, opts)
}

// Whether C's creator, back after its root's powers ended, repairs C
// through its live CW (owner decision, cycle 24): the fold counts such a
// meta or drop only while `cwDemote` holds.
function cwRepair (c, ownHex) {
  return c.view.creator === ownHex && c.view.rootAuthority !== true && c.view.cwDemote === true
}

// rpc.md 5.69: the creator's root, or its live CW once the root's powers
// ended (cwRepair).
async function communityMeta (ctx, { community, name, join }, { affected = null } = {}) {
  return withCommunity(ctx, community, async (c, identity) => {
    if (c.view.creator !== identity.ownHex || c.view.members.get(identity.ownHex) !== 'member') throw communityPermission()
    if (name === undefined && join === undefined) throw new UsageError('nada a alterar')
    const fields = { name: name === undefined ? c.view.name : name, join: join === undefined ? c.view.join : join, seen: c.view.last }
    if (cwRepair(c, identity.ownHex)) {
      if (c.cw === null) throw communityPermission()
      const cw = await ownGroupWriter(c, identity).catch(() => { throw communityPermission() })
      await appendCommunityRecord(cw, c.group, buildRecord(() => groups.communityMetaCw(fields)))
    } else {
      requireRootAuthority(c)
      const writer = await ownGroupWriter(c, identity, { root: true }).catch(() => { throw communityPermission() })
      await appendCommunityRecord(writer, c.group, buildRecord(() => groups.groupMeta(fields)))
    }
    noteAffected(affected, [c.group])
    return { ok: true }
  })
}

// rpc.md 5.70: C's creator, back after its root's powers ended, takes group
// `group` off C's catalogue through its live CW, or with `undo` puts a
// group it dropped back; the root itself keeps creating and listing while
// it has authority, so this is refused then.
async function communityRemoveGroup (ctx, { community, group, undo = false }, { affected = null } = {}) {
  return withCommunity(ctx, community, async (c, identity) => {
    if (c.view.creator !== identity.ownHex || c.view.members.get(identity.ownHex) !== 'member') throw communityPermission()
    if (!cwRepair(c, identity.ownHex) || c.cw === null) throw communityPermission()
    const G = typeof group === 'string' && HEX64.test(group) ? group.toLowerCase() : null
    if (G === null) throw new UsageError('nada a alterar')
    if (G === c.view.general) throw new UsageError(GERAL_STAYS)
    const on = undo !== true
    if (on ? !c.view.groups.includes(G) : !c.view.dropped.includes(G)) throw new UsageError('nada a alterar')
    const cw = await ownGroupWriter(c, identity).catch(() => { throw communityPermission() })
    await appendCommunityRecord(cw, c.group, buildRecord(() => groups.communityDrop({ group: G, on, seen: c.view.last })))
    noteAffected(affected, [c.group, G])
    return { ok: true }
  })
}

// Whether C's root holds an `on: true` group-admin for `member`.
function everGranted (c, member) {
  return c.input.root.entries.some((e) => e && e.seq >= 1 && e.record && e.record.type === 'group-admin' && e.record.member === member && e.record.on === true)
}

// rpc.md 5.60: a root group-admin of the creator, cuts over the member's
// counted CWs (a diary binds at most MAX_GROUP_WRITERS_PER_DIARY).
async function communitySetAdmin (ctx, { community, member, on }, { affected = null } = {}) {
  return withCommunity(ctx, community, async (c, identity) => {
    const { ownHex } = identity
    const C = c.group
    if (c.view.creator !== ownHex || c.view.members.get(ownHex) !== 'member') throw communityPermission()
    // A creator whose root lost authority (back after leaving C) can only
    // demote, through its live CW (owner decision, cycle 16).
    const rootGone = c.view.rootAuthority !== true
    if (rootGone && (on || c.cw === null)) throw communityPermission()
    if (rootGone && c.view.cwDemote !== true) throw new UsageError(DEMOTE_PENDING)
    if (member === c.view.creator) throw new UsageError('o criador da comunidade já administra')
    // A grant needs a member; a revocation works whatever the diary's state
    // (member, left or requested), so a departed admin's outstanding grant
    // never shields it from a ban or lets it rejoin as admin.
    if (on && c.view.members.get(member) !== 'member') throw new UsageError('a pessoa precisa ser membro da comunidade')
    if (!on && !everGranted(c, member)) throw new UsageError('nada a alterar')
    let cuts = countedCuts(c, member, { signed: on })
    // A demotion is never refused for its size: the first writers by key
    // keep their length and the rest are cut at 0, the safe side.
    if (cuts.length > groups.MAX_GROUP_CUTS) {
      if (on) throw new UsageError(COMMUNITY_FULL)
      cuts = cuts.slice(0, groups.MAX_GROUP_CUTS)
    }
    if (rootGone) {
      const cw = await ownGroupWriter(c, identity).catch(() => { throw communityPermission() })
      await appendCommunityRecord(cw, C, buildRecord(() => groups.communityDemote({ member, cuts, seen: c.view.last })))
    } else {
      const writer = await ownGroupWriter(c, identity, { root: true }).catch(() => { throw communityPermission() })
      await appendCommunityRecord(writer, C, buildRecord(() => groups.groupAdmin({ member, on, cuts, seen: c.view.last })))
    }
    const held = await localGroupsOf(ctx, identity, C)
    await communityKeyEffects(ctx, identity, held, !on)
    noteAffected(affected, [C, ...held.map((g) => g.group)])
    return { community: C, member, on }
  })
}

// ---- reads ----

async function communityMembers (ctx, { community, offset = 0, limit = 100 }) {
  return withCommunity(ctx, community, async (c) => {
    const members = [...c.view.members].filter(([key, state]) => c.profiles.has(key) && (state === 'member' || state === 'banned'))
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    return {
      members: members.slice(offset, offset + limit).map(([member, state]) => ({
        member,
        ...c.profiles.get(member),
        admin: c.view.admins.has(member),
        banned: state === 'banned',
        joinedAt: writerHeaderTimes(c, member)[0] || null
      })),
      total: members.length
    }
  })
}

async function communityRequests (ctx, { community, offset = 0, limit = 100 }) {
  return withCommunity(ctx, community, async (c, { ownHex }) => {
    if (c.view.members.get(ownHex) !== 'member' || (c.view.creator !== ownHex && !c.view.admins.has(ownHex))) throw communityPermission()
    return {
      requests: c.view.requests.slice(offset, offset + limit).map((member) => {
        const times = writerHeaderTimes(c, member)
        return { member, ...c.profiles.get(member), at: times.length > 0 ? times[times.length - 1] : null }
      }),
      total: c.view.requests.length
    }
  })
}

function countMembers (view) {
  return [...view.members.values()].filter((s) => s === 'member').length
}

// rpc.md 5.59.
async function communityInfo (ctx, { community }) {
  return withIdentity(ctx, async (identity) => {
    if (typeof community !== 'string' || !HEX64.test(community)) throw communityNotFound()
    const key = community.toLowerCase()
    const pending = readCreateResume(ctx.dataDir)
    // A read never writes: a create interrupted on this device stays pending
    // until community.create finishes it.
    if (pending !== null && pending.community === key) return { community: key, ...PENDING_COMMUNITY }
    const c = await loadCommunity(ctx, identity, key)
    if (c === null) return { community: key, ...PENDING_COMMUNITY }
    const { view } = c
    const rows = []
    for (const g of view.groups) {
      const row = { group: g, name: null, visibility: null, join: null, role: null, general: g === view.general }
      try {
        const loaded = await loadGroup(ctx, identity, g)
        row.name = loaded.view.name
        row.visibility = loaded.view.visibility === 'private' ? 'private' : 'public'
        row.join = loaded.view.join
        row.role = groupRole(loaded.view, identity.ownHex)
      } catch (err) {
        if (err.code !== 'NOT_FOUND') throw err
      }
      rows.push(row)
    }
    return {
      community: key,
      name: view.name,
      join: view.join,
      creator: view.creator,
      role: groupRole(view, identity.ownHex),
      state: 'ready',
      members: countMembers(view),
      admins: view.admins.size,
      groups: rows,
      general: view.general,
      incomplete: view.incomplete,
      leavePending: await leavePending(ctx, identity, c),
      repair: cwRepair(c, identity.ownHex) && c.cw !== null,
      dropped: [...view.dropped]
    }
  })
}

// community.info's leavePending: exactly what finishCreatorLeave would
// finish, so the app offers community.leave only when it writes something.
async function leavePending (ctx, identity, c) {
  const note = leaveNote(ctx.dataDir, c.group)
  if (note === null || !c.local || c.view.creator !== identity.ownHex) return false
  return (await cwStillOn(identity, c.group, c.local)) && noteMatches(identity.store, c.local, note)
}

const ROLE_ORDER = ['creator', 'admin', 'member']

function compareCommunities (a, b) {
  const ra = ROLE_ORDER.includes(a.role) ? ROLE_ORDER.indexOf(a.role) : ROLE_ORDER.length
  const rb = ROLE_ORDER.includes(b.role) ? ROLE_ORDER.indexOf(b.role) : ROLE_ORDER.length
  if (ra !== rb) return ra - rb
  if (a.name !== b.name) {
    if (a.name === null) return 1
    if (b.name === null) return -1
    return a.name < b.name ? -1 : 1
  }
  return a.community < b.community ? -1 : a.community > b.community ? 1 : 0
}

// rpc.md 5.62: every community of the local list (created or joined).
async function communityList (ctx) {
  return withIdentity(ctx, async (identity) => {
    const list = []
    for (const key of new Set(localGroups(ctx.dataDir).filter((g) => g.kind === 'community').map((g) => g.group))) {
      let c
      try {
        c = await loadCommunity(ctx, identity, key)
      } catch (err) {
        if (err.code !== 'NOT_FOUND') throw err
        continue
      }
      if (c === null) {
        list.push({ community: key, name: null, join: null, state: 'pending', role: 'pending', general: null })
        continue
      }
      list.push({
        community: key,
        name: typeof c.view.name === 'string' ? c.view.name : null,
        join: c.view.join,
        state: 'ready',
        role: groupRole(c.view, identity.ownHex),
        general: c.view.general
      })
    }
    return { communities: list.sort(compareCommunities).slice(0, COMMUNITY_LIST_MAX) }
  })
}

// The groups of the local list whose root header names `community` (the
// groups.changed fan-out of a community write); [] when none or on any error.
async function communityGroups (ctx, { community }) {
  try {
    if (typeof community !== 'string' || !HEX64.test(community)) return []
    return await withIdentity(ctx, async (identity) => (await localGroupsOf(ctx, identity, community.toLowerCase())).map((l) => l.group))
  } catch {
    return []
  }
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
  postDelete,
  profileDelete,
  likeSet,
  repostSet,
  engagementRead,
  usernameAdd,
  followAdd,
  followRemove,
  followList,
  logRead,
  feedRead,
  profileRead,
  groupCreate,
  groupJoin,
  groupLeave,
  groupPost,
  groupRead,
  groupList,
  groupInfo,
  groupMembers,
  groupRequests,
  groupAdmit,
  groupBan,
  groupAdmin,
  groupHide,
  groupMeta,
  groupRekey,
  communityCreate,
  communityJoin,
  communityLeave,
  communityAdmit,
  communityBan,
  communityMeta,
  communityRemoveGroup,
  communitySetAdmin,
  communityMembers,
  communityRequests,
  communityInfo,
  communityList,
  communityGroups
}
