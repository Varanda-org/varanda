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
  deleteRecord,
  validRecordCopy,
  validateRecord,
  formatRef,
  latestProfile,
  nowIso
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
const { recordBoundRoot } = require('./sync')

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

async function loadGroup (ctx, identity, group) {
  const { store, diary, ownHex, association } = identity
  const { blocked, revokedIssuers } = enforcedBlocklist(ctx.dataDir, association)
  if (typeof group !== 'string' || !HEX64.test(group)) throw groupNotFound()
  // Enforcing a group block: a snapshot naming the root key makes the group
  // unknown to every operation, and its local cores stay where they are.
  if (blocked.has(group.toLowerCase())) throw groupNotFound()
  if (!(await replicaStored(store, group))) throw pendingGroup(ctx, group)
  const rootCore = store.get({ key: b4a.from(group, 'hex'), writable: false, active: false })
  await rootCore.ready()
  if (rootCore.contiguousLength === 0) throw pendingGroup(ctx, group)
  const rootEntries = await readAll(rootCore)
  const header = rootEntries[0] && rootEntries[0].record
  if (rootCore.fork !== 0 || groups.validateGroupHeader(header) !== null || header.kind !== 'group' || header.visibility !== 'public') {
    // A stored root this node never folds (a private or community header,
    // a fork): leave and the groups.json room logic drop its entry.
    const err = groupNotFound()
    err.unfoldable = true
    throw err
  }
  // signed: the length the core's signature covers, blocks not downloaded
  // included (an admission or grant cut must lie above them).
  const logs = [{ key: group, diary: header.diary, entries: rootEntries, length: rootCore.contiguousLength, signed: rootCore.length }]
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
      if (groups.validateWriterHeader(h) !== null || h.group !== group) continue
      logs.push({ key: hex(core.key), diary: h.diary, entries: await readAll(core), length: core.contiguousLength, signed: core.length })
    } finally {
      await core.close()
    }
  }
  const profiles = new Map()
  const joins = new Map()
  const diaryEntries = new Map()
  for (const key of new Set([...localDiaries, ...logs.map((l) => l.diary)])) {
    if (blocked.has(key) || !(await replicaStored(store, key))) continue
    const core = key === ownHex ? diary : await openReplica(store, key)
    const entries = await readAll(core)
    if (key !== ownHex && skipReason(core, entries, key, association, blocked, revokedIssuers) !== null) continue
    diaryEntries.set(key, entries)
    joins.set(key, groups.groupJoinHistory(entries, group))
    const profile = latestProfile(entries)
    profiles.set(key, {
      name: profile === null ? null : profile.name,
      username: latestUsername(entries, key, association, { revokedIssuers })
    })
  }
  const accepted = logs.filter((l) => diaryEntries.has(l.diary))
  const root = { key: group, entries: diaryEntries.has(header.diary) ? rootEntries : rootEntries.slice(0, 1) }
  const writers = accepted.filter((l) => l.key !== group)
  // Every community root this group's root ever named (on or off), those
  // held here, each with its creator diary's joins: a root counts only when
  // that diary bound it, and acts taken while it was linked stay valid after
  // an unlink. At most MAX_COMMUNITY_ROOTS keys, in order of first
  // appearance: a key past the cap is not passed, so the fold reads as
  // incomplete.
  const communities = []
  for (const key of linkedKeys(root.entries, 'community-link', 'community').slice(0, MAX_COMMUNITY_ROOTS)) {
    const held = await readCommunityRoot(identity, key, { blocked, revokedIssuers })
    if (held !== null && held !== PENDING) communities.push({ key, entries: held.entries, joins: held.joins })
  }
  const input = { root, writers, joins, communities }
  const view = groups.buildGroup(input)
  // The fold counts the root only when its creator's diary bound it: the
  // sync keeps that record for when the creator's replica is gone.
  if (view.writers.has(group) && !blocked.has(header.diary)) {
    try {
      recordBoundRoot(ctx.dataDir, group)
    } catch {}
  }
  // Keep only two-way bindings for observed lengths and record references.
  const bound = accepted.filter((l) => (joins.get(l.diary) || []).some((j) => j.writer === l.key && j.on))
  return { group, input, view, logs: bound, profiles, diaryEntries, local: localGroups(ctx.dataDir).find((g) => g.group === group) }
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

function withGroup (ctx, group, fn) {
  return withIdentity(ctx, async (identity) => fn(await loadGroup(ctx, identity, group), identity))
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
  return { core, leave: (await readAll(core)).some(recordIsLeave) }
}

const PENDING_INFO = { name: null, join: null, role: 'pending', members: 0 }

function recordIsLeave (entry) {
  return entry.seq >= 1 && entry.record !== null && typeof entry.record === 'object' && entry.record.type === 'group-leave'
}

// This device's writer still writes only while the diary has not left and
// the writer itself holds no group-leave. A leave from another device of the
// same diary ends it too.
function liveOwnWriter (loaded, ownHex) {
  const local = loaded.local
  if (!local || loaded.view.members.get(ownHex) === 'left') return null
  const log = loaded.logs.find((l) => l.key === local.writer && l.diary === ownHex)
  if (!log || log.entries.some(recordIsLeave)) return null
  return local
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
    const entries = await readAll(core)
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
    const entries = await readAll(core)
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
async function foldSaysLeft (ctx, identity, group) {
  try {
    return (await loadGroup(ctx, identity, group)).view.members.get(identity.ownHex) === 'left'
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
async function makeGroupRoom (ctx, identity, group) {
  const { store } = identity
  const entries = localGroups(ctx.dataDir)
  if (group !== null && entries.some((e) => e.group === group)) return
  if (entries.length < groups.MAX_GROUPS_PER_DIARY) return
  const left = []
  let writing = 0
  for (const entry of entries) {
    if (await writerStillWrites(store, entry) && !(await foldSaysLeft(ctx, identity, entry.group))) writing++
    else left.push(entry)
  }
  if (writing >= groups.MAX_GROUPS_PER_DIARY) throw new UsageError('limite de grupos atingido')
  let victim = null
  for (const entry of left) {
    if (entry.writer === entry.group) continue
    if (await rootOwnedHere(store, entry.group)) continue
    victim = entry
    break
  }
  if (victim === null) throw new UsageError('limite de grupos atingido')
  writeGroups(ctx.dataDir, entries.filter((e) => e.group !== victim.group))
}

// buildGroup does not list the writers it counted. A probe post asks the
// same fold (rejoin binding and the writer cap) so a cut names only those.
function groupCuts (loaded, member, { signed = false } = {}) {
  const probes = new Map(loaded.logs.map((l) => [l.key, l.length]))
  const record = groups.groupPost({ text: '.' })
  const add = (log) => probes.has(log.key)
    ? { ...log, entries: [...log.entries, { seq: probes.get(log.key), record }] }
    : log
  const view = groups.buildGroup({ ...loaded.input, root: add(loaded.input.root), writers: loaded.input.writers.map(add) })
  const accepted = new Set(view.posts.filter((p) => probes.get(p.writer) === p.seq).map((p) => p.writer))
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
  return counted.filter((w) => !held.has(w))
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

function appendGroupRecord (core, group, record) {
  return appendRecord(core, record, { validator: (r, seq) => groups.validateGroupRecord(r, seq, { root: hex(core.key) === group }) })
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

async function groupCreate (ctx, { name, join }) {
  return withIdentity(ctx, async (identity) => {
    const { store, diary, ownHex } = identity
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const record = buildRecord(() => groups.groupHeader({ diary: ownHex, name, join }))
    await makeGroupRoom(ctx, identity, null)
    const nonce = hex(randomBytes(16))
    const writer = await openGroupWriter(store, nonce)
    const group = hex(writer.key)
    await appendGroupRecord(writer, group, record)
    // The nonce is the only way back to this root. Record it before the
    // diary join so a crash cannot bind a root this device cannot write.
    writeGroups(ctx.dataDir, [...localGroups(ctx.dataDir), { group, writer: group, nonce }])
    await appendRecord(diary, groupJoinRecord({ group, writer: group, on: true }))
    return { group }
  })
}

// The checks that need the fold (ban, membership, rejoin) wait for the
// root: the next sync fetches it and the fold then decides the state.
async function pendingJoin (ctx, { group, local }, identity) {
  const { diary, store, ownHex } = identity
  if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
  const own = local === null ? null : await pendingWriter(store, local)
  if (own !== null && own.leave) throw new UsageError('o grupo ainda não chegou: entre de novo depois da sincronização')
  let writerKey = own === null ? null : local.writer
  if (writerKey === null) {
    await makeGroupRoom(ctx, identity, group)
    const nonce = hex(randomBytes(16))
    const writer = await openGroupWriter(store, nonce)
    writerKey = hex(writer.key)
    await appendGroupRecord(writer, group, buildRecord(() => groups.writerHeader({ group, diary: ownHex, rejoin: null })))
    writeGroups(ctx.dataDir, [...localGroups(ctx.dataDir).filter((g) => g.group !== group), { group, writer: writerKey, nonce }])
  }
  const joins = groups.groupJoinHistory(await readAll(diary), group)
  if (!joins.some((j) => j.writer === writerKey && j.on)) await appendRecord(diary, groupJoinRecord({ group, writer: writerKey, on: true }))
  return { state: 'pending' }
}

async function groupJoin (ctx, { group }) {
  return withGroupOrPending(ctx, group, async (loaded, identity) => {
    const { diary, store, ownHex } = identity
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    // bans, not members: a diary banned before it had a writer is not listed.
    if (loaded.view.bans.has(ownHex)) throw groupPermission()
    // A blocked own diary binds none of its writers in the fold.
    if (!loaded.diaryEntries.has(ownHex)) throw groupPermission()
    const live = liveOwnWriter(loaded, ownHex)
    if (live) {
      await ownGroupWriter(loaded, identity)
      return groupJoinState(loaded.view, ownHex, live.writer)
    }
    const left = loaded.view.members.get(ownHex) === 'left'
    let writerKey = null
    if (!left && loaded.local && !(await localWriterHasLeave(store, loaded.local))) writerKey = loaded.local.writer
    if (writerKey === null) {
      if (groupWritersFull(loaded.view, group)) throw new UsageError(GROUP_FULL)
      // The fold counts only the first writers a diary binds: a new one past
      // that cap would never count.
      if (boundWriterCount(loaded, ownHex) >= groups.MAX_GROUP_WRITERS_PER_DIARY) throw new UsageError(GROUP_FULL)
      await makeGroupRoom(ctx, identity, group)
      // Only a diary that is left rejoins, and it names the causal latest
      // leave, including one written by another device of the same diary.
      const rejoin = left ? (loaded.view.leaves.get(ownHex) || null) : null
      const nonce = hex(randomBytes(16))
      const writer = await openGroupWriter(store, nonce)
      writerKey = hex(writer.key)
      await appendGroupRecord(writer, group, buildRecord(() => groups.writerHeader({ group, diary: ownHex, rejoin })))
      writeGroups(ctx.dataDir, [...localGroups(ctx.dataDir).filter((g) => g.group !== group), { group, writer: writerKey, nonce }])
    }
    await appendRecord(diary, groupJoinRecord({ group, writer: writerKey, on: true }))
    const next = await loadGroup(ctx, identity, group)
    return groupJoinState(next.view, ownHex, writerKey)
  }, (pending, identity) => pendingJoin(ctx, pending, identity))
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
    const own = liveOwnWriter(loaded, identity.ownHex)
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
    if (!entry || entry.writer === entry.group) throw groupNotFound()
    // Seeders stop counting the writer against the diary only after a leave
    // and a diary group-join off.
    let core = null
    try {
      core = await openGroupWriter(identity.store, entry.nonce)
      if (hex(core.key) === entry.writer && core.length > 0 && !(await readAll(core)).some(recordIsLeave)) {
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
    const own = liveOwnWriter(loaded, identity.ownHex)
    if (!own || loaded.view.members.get(identity.ownHex) !== 'member') throw groupPermission()
    requireCounted(loaded, own.writer)
    const writer = await ownGroupWriter(loaded, identity)
    const record = buildRecord(() => groups.groupPost({ text, replyTo, seen: loaded.view.last }))
    return { seq: await appendGroupRecord(writer, group, record) }
  })
}

function requireGroupAdmin (loaded, ownHex, root = false) {
  if (loaded.view.members.get(ownHex) !== 'member' || !loaded.view.admins.has(ownHex) || (root && loaded.view.creator !== ownHex)) throw groupPermission()
}

function groupModerate (ctx, type, { group, member, on }) {
  return withGroup(ctx, group, async (loaded, identity) => {
    // Charter records go through the root. Admit and ban need a writer that
    // still writes; a leave, including another device's, ends it.
    if (type !== 'groupAdmin' && !liveOwnWriter(loaded, identity.ownHex)) throw groupPermission()
    requireGroupAdmin(loaded, identity.ownHex, type === 'groupAdmin')
    if (member === loaded.view.creator || (type !== 'groupAdmin' && loaded.view.admins.has(member))) throw groupPermission()
    if (type !== 'groupAdmin') requireCounted(loaded, loaded.local.writer)
    // Protecting the member from an admit that misses a counted writer not
    // held here: the fold admits only the writers an admit lists, so that
    // writer would stay hidden behind an admission that looks complete. An
    // admit again is allowed: it lists the writers the last one missed.
    if (type === 'groupAdmit' && on === true) {
      const unheld = unheldCountedWriters(loaded, member)
      if (unheld === null || unheld.length > 0) throw new UsageError('aguarde a sincronização do grupo para admitir')
    }
    const writer = await ownGroupWriter(loaded, identity, { root: type === 'groupAdmin' })
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
    const record = buildRecord(() => groups[type]({ member, on, cuts, lifts, seen: loaded.view.last }))
    await appendGroupRecord(writer, group, record)
    return { ok: true }
  })
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
    if (target === null || typeof target !== 'object') throw groupPermission()
    const writerHex = target.writer === undefined || target.writer === null ? '' : String(target.writer).toLowerCase()
    const log = loaded.logs.find((l) => l.key === writerHex)
    let allowed
    if (log !== undefined && log.diary === ownHex) {
      allowed = liveOwnWriter(loaded, ownHex) !== null ||
        (!!loaded.local && loaded.logs.some((l) => l.key === loaded.local.writer && l.diary === ownHex))
    } else {
      const admin = loaded.view.members.get(ownHex) === 'member' && loaded.view.admins.has(ownHex)
      allowed = admin && liveOwnWriter(loaded, ownHex) !== null
    }
    if (!allowed) throw groupPermission()
    requireCounted(loaded, loaded.local.writer)
    const writer = await ownGroupWriter(loaded, identity)
    await appendGroupRecord(writer, group, buildRecord(() => groups.groupHide({ target, on, seen: loaded.view.last })))
    return { ok: true }
  })
}

async function groupMeta (ctx, { group, name, join }) {
  return withGroup(ctx, group, async (loaded, identity) => {
    requireGroupAdmin(loaded, identity.ownHex, true)
    if (name === undefined && join === undefined) throw new UsageError('nada a alterar')
    const writer = await ownGroupWriter(loaded, identity, { root: true })
    const record = buildRecord(() => groups.groupMeta({ name: name === undefined ? loaded.view.name : name, join: join === undefined ? loaded.view.join : join, seen: loaded.view.last }))
    await appendGroupRecord(writer, group, record)
    return { ok: true }
  })
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
      incomplete: loaded.view.incomplete
    }
  }, (pending) => {
    requirePendingLocal(pending)
    return { items: [], next: null, hidden: 0, incomplete: true }
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
        list.push(groupSummary(group, loaded.view, identity.ownHex))
      } catch (err) {
        if (err.code !== 'NOT_FOUND') throw err
        if (err.pending && err.pending.local !== null) list.push({ group, ...PENDING_INFO })
      }
    }
    return { groups: list.slice(offset, offset + limit), total: list.length }
  })
}

async function groupInfo (ctx, { group }) {
  return withGroupOrPending(ctx, group, async ({ view }, { ownHex }) => ({
    ...groupSummary(group, view, ownHex),
    creator: view.creator,
    state: view.members.get(ownHex) || 'left',
    communities: view.community === null ? [] : [view.community]
  }), (pending) => {
    requirePendingLocal(pending)
    return { group: pending.group, ...PENDING_INFO, creator: null, state: 'pending', communities: [] }
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

// ---- communities ----

const COMMUNITY_FULL = 'limite da comunidade atingido'
// The community roots a group fold reads, bounding the store reads one
// group root can cause.
const MAX_COMMUNITY_ROOTS = 32
const PENDING = 'pending'
const PENDING_COMMUNITY = { name: null, creator: null, groups: [], admins: 0, state: 'pending', incomplete: true }

function communityNotFound () {
  const err = new Error('comunidade não encontrada')
  err.code = 'NOT_FOUND'
  return err
}

function communityPermission () {
  return new UsageError('sem permissão na comunidade')
}

// The distinct keys named by `type` records (field `field`) of a root, in
// record order. Bounded by the root's own size.
function linkedKeys (entries, type, field) {
  const out = new Set()
  for (const e of entries) {
    const r = e && e.record
    if (e.seq >= 1 && r !== null && typeof r === 'object' && r.type === type && typeof r[field] === 'string' && HEX64.test(r[field])) out.add(r[field].toLowerCase())
  }
  return [...out]
}

// A held community root with its creator diary's joins for it; PENDING when
// the root is not stored (or empty) yet, null when it is blocked, forked or
// not a community header.
async function readCommunityRoot (identity, key, { blocked, revokedIssuers }) {
  const { store, diary, ownHex, association } = identity
  if (blocked.has(key)) return null
  if (!(await replicaStored(store, key))) return PENDING
  const core = store.get({ key: b4a.from(key, 'hex'), writable: false, active: false })
  await core.ready()
  if (core.contiguousLength === 0) return PENDING
  const entries = await readAll(core)
  const header = entries[0] && entries[0].record
  if (core.fork !== 0 || groups.validateGroupHeader(header) !== null || header.kind !== 'community') return null
  const joins = new Map()
  const creator = header.diary
  if (!blocked.has(creator) && (creator === ownHex || await replicaStored(store, creator))) {
    const dcore = creator === ownHex ? diary : await openReplica(store, creator)
    const dentries = await readAll(dcore)
    if (creator === ownHex || skipReason(dcore, dentries, creator, association, blocked, revokedIssuers) === null) {
      joins.set(creator, groups.groupJoinHistory(dentries, key))
    }
  }
  return { key, header, entries, joins }
}

// Whether `key` is a root held here, not blocked, whose header is a group.
async function heldGroupRoot (ctx, identity, key) {
  const k = key.toLowerCase()
  if (enforcedBlocklist(ctx.dataDir, identity.association).blocked.has(k)) return false
  if (!(await replicaStored(identity.store, k))) return false
  const core = identity.store.get({ key: b4a.from(k, 'hex'), writable: false, active: false })
  await core.ready()
  if (core.fork !== 0 || core.contiguousLength === 0) return false
  const entries = await readAll(core)
  const header = entries[0] && entries[0].record
  return groups.validateGroupHeader(header) === null && header.kind === 'group'
}

// A community for an operation: null while pending, NOT_FOUND when the key
// is malformed, blocked or not a community root.
async function loadCommunity (ctx, identity, community) {
  if (typeof community !== 'string' || !HEX64.test(community)) throw communityNotFound()
  const held = await readCommunityRoot(identity, community.toLowerCase(), enforcedBlocklist(ctx.dataDir, identity.association))
  if (held === null) throw communityNotFound()
  return held === PENDING ? null : held
}

function communityRoot (held) {
  return { key: held.key, entries: held.entries, joins: held.joins }
}

// The writable core of a root this store created, or null.
async function ownedRoot (store, key) {
  const core = store.get({ key: b4a.from(key, 'hex'), valueEncoding: 'json' })
  await core.ready()
  return core.writable ? core : null
}

function appendCommunityRecord (core, record) {
  return appendRecord(core, record, { validator: (r, seq) => groups.validateGroupRecord(r, seq, { root: true, community: true }) })
}

// The groups a community root links on its side that load here, each as
// buildCommunity takes it plus the loaded group.
async function heldLinkedGroups (ctx, identity, held) {
  const out = []
  // Only the groups the community side has on under the fold's cap, so one
  // foreign root naming many keys loads at most MAX_GROUPS_PER_COMMUNITY
  // groups, each once (the keys are distinct). The browser node bounds it
  // the same way.
  for (const key of [...sideLinks(held.entries, 'group-link', 'group', null).linked].sort()) {
    try {
      const loaded = await loadGroup(ctx, identity, key)
      out.push({ key, entries: loaded.input.root.entries, writers: loaded.input.writers, joins: loaded.input.joins, loaded })
    } catch (err) {
      if (err.code !== 'NOT_FOUND') throw err
    }
  }
  return out
}

function foldHeldCommunity (held, linked) {
  return groups.buildCommunity({ root: communityRoot(held), groups: linked.map(({ loaded, ...g }) => g) })
}

// Every writer of `diary` this node holds in the group, at its contiguous
// length: an `on: false` record cuts an unlisted writer at 0.
function knownCuts (loaded, diary) {
  return loaded.logs.filter((l) => l.diary === diary)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((l) => ({ writer: l.key, seq: l.length }))
}

function diaryCuts (loaded, diaries, on) {
  const cuts = []
  for (const d of diaries) cuts.push(...(on ? countedCuts(loaded, d, { signed: true }) : knownCuts(loaded, d)))
  return cuts.sort((a, b) => a.writer.localeCompare(b.writer))
}

// A side's link records for one pair, in record order, as the fold reads
// them: the group side holds one community at a time (a link to another one
// while one is on is ignored), the community side holds at most
// MAX_GROUPS_PER_COMMUNITY groups on (a link over it is ignored, and so is
// an unlink of a group that is not on).
function sideLinks (entries, type, field, value) {
  const out = []
  let current = null
  const linked = new Set()
  for (const e of entries) {
    const r = e && e.record
    if (!(e.seq >= 1 && r !== null && typeof r === 'object' && r.type === type)) continue
    if (type === 'group-link') {
      if (r.on) {
        if (!linked.has(r.group) && linked.size >= groups.MAX_GROUPS_PER_COMMUNITY) continue
        linked.add(r.group)
      } else if (linked.has(r.group)) {
        linked.delete(r.group)
      } else {
        continue
      }
    }
    if (type === 'community-link') {
      if (r.on) {
        if (current !== null && current !== r.community) continue
        current = r.community
      } else if (current === r.community) {
        current = null
      } else {
        continue
      }
    }
    if (r[field] === value) out.push(r)
  }
  return { records: out, current, linked }
}

// Whether a link record changes the side: an unlink only while the side is
// on, a link while it is off or when its cuts list a writer the current one
// does not (a new device needs a new link).
function linkChanges (records, on, cuts) {
  const last = records[records.length - 1]
  const isOn = last !== undefined && last.on
  if (!on) return isOn
  if (!isOn) return true
  const listed = new Set(last.cuts.map((c) => c.writer))
  return cuts.some((c) => !listed.has(c.writer))
}

async function communityCreate (ctx, { name }) {
  return withIdentity(ctx, async (identity) => {
    const { store, diary, ownHex } = identity
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const record = buildRecord(() => groups.groupHeader({ kind: 'community', diary: ownHex, name }))
    // Communities take a slot of the same per-diary list as groups.
    await makeGroupRoom(ctx, identity, null)
    const nonce = hex(randomBytes(16))
    const root = await openGroupWriter(store, nonce)
    const community = hex(root.key)
    await appendCommunityRecord(root, record)
    // The nonce is the only way back to this root: recorded before the
    // diary binds it, as for a group.
    writeGroups(ctx.dataDir, [...localGroups(ctx.dataDir), { group: community, writer: community, nonce, kind: 'community' }])
    await appendRecord(diary, groupJoinRecord({ group: community, writer: community, on: true }))
    return { community }
  })
}

// `affected` (a Set), when given, receives the keys whose folds changed.
async function communityLink (ctx, { community, group, on }, { affected = null } = {}) {
  return withIdentity(ctx, async (identity) => {
    const { store, ownHex } = identity
    let held
    try {
      held = await loadCommunity(ctx, identity, community)
    } catch (err) {
      // An ordinary group never takes the one community slot of a group.
      if (err.code === 'NOT_FOUND' && await heldGroupRoot(ctx, identity, community)) throw communityPermission()
      throw err
    }
    if (typeof group !== 'string' || !HEX64.test(group)) throw groupNotFound()
    const C = community.toLowerCase()
    const G = group.toLowerCase()
    let loaded = null
    try {
      loaded = await loadGroup(ctx, identity, G)
    } catch (err) {
      if (err.unfoldable === true) {
        const other = await readCommunityRoot(identity, G, enforcedBlocklist(ctx.dataDir, identity.association))
        if (other !== null && other !== PENDING) throw communityPermission()
      }
      if (err.pending === undefined) throw err
    }
    const cview = held === null ? null : groups.buildCommunity({ root: communityRoot(held) })
    const communityCore = cview !== null && cview.creator === ownHex ? await ownedRoot(store, C) : null
    let groupCore = null
    if (loaded !== null && loaded.view.creator === ownHex && loaded.view.members.get(ownHex) === 'member') {
      groupCore = await ownedRoot(store, G)
    }
    if (communityCore === null && groupCore === null) throw communityPermission()
    // The creator and admins of the community, at the writers this node
    // folded in the group; nothing known without both roots.
    let cuts = loaded === null || cview === null ? [] : diaryCuts(loaded, [...cview.admins], on)
    // An unlink is never refused for its size: the first MAX_GROUP_CUTS
    // writers by key keep their known length and the rest are cut at 0,
    // the safe side for a revocation. Only a link is refused.
    if (cuts.length > groups.MAX_GROUP_CUTS) {
      if (on) throw new UsageError(COMMUNITY_FULL)
      cuts = cuts.slice(0, groups.MAX_GROUP_CUTS)
    }
    // A 33rd group on would append a link the fold ignores: refuse before
    // writing either side. A caller without the community root cannot see it.
    if (communityCore !== null && on) {
      const { linked } = sideLinks(held.entries, 'group-link', 'group', G)
      if (!linked.has(G) && linked.size >= groups.MAX_GROUPS_PER_COMMUNITY) throw new UsageError(COMMUNITY_FULL)
    }
    const groupSide = groupCore === null ? null : sideLinks(loaded.input.root.entries, 'community-link', 'community', C)
    if (groupSide !== null && on && groupSide.current !== null && groupSide.current !== C) {
      throw new UsageError('o grupo já está em outra comunidade')
    }
    const sides = []
    if (communityCore !== null) {
      sides.push('community')
      if (linkChanges(sideLinks(held.entries, 'group-link', 'group', G).records, on, cuts)) {
        await appendCommunityRecord(communityCore, buildRecord(() => groups.groupLink({ group: G, on, cuts })))
      }
    }
    if (groupCore !== null) {
      sides.push('group')
      if (linkChanges(groupSide.records, on, cuts)) {
        await appendGroupRecord(groupCore, G, buildRecord(() => groups.communityLink({ community: C, on, cuts })))
      }
    }
    if (affected !== null) {
      affected.add(C)
      affected.add(G)
    }
    return { community: C, group: G, on, sides }
  })
}

async function communityAdmin (ctx, { community, member, on }, { affected = null } = {}) {
  return withIdentity(ctx, async (identity) => {
    const held = await loadCommunity(ctx, identity, community)
    if (held === null) throw communityPermission()
    const linked = await heldLinkedGroups(ctx, identity, held)
    const view = foldHeldCommunity(held, linked)
    if (view.creator !== identity.ownHex) throw communityPermission()
    const core = await ownedRoot(identity.store, held.key)
    if (core === null) throw communityPermission()
    if (member === view.creator) throw new UsageError('o criador da comunidade já administra')
    // A grant names the member's writers in every group linked two-way, so
    // only records written after it gain authority there.
    let cuts = []
    for (const g of linked) {
      if (view.groups.includes(g.key)) cuts.push(...diaryCuts(g.loaded, [member], on))
    }
    // A demotion is never refused for its size: the first
    // MAX_COMMUNITY_CUTS writers by key are listed and the rest cut at 0.
    if (cuts.length > groups.MAX_COMMUNITY_CUTS) {
      if (on) throw new UsageError(COMMUNITY_FULL)
      cuts = cuts.sort((a, b) => a.writer.localeCompare(b.writer)).slice(0, groups.MAX_COMMUNITY_CUTS)
    }
    await appendCommunityRecord(core, buildRecord(() => groups.communityAdmin({ member, on, cuts })))
    if (affected !== null) {
      affected.add(held.key)
      for (const g of view.groups) affected.add(g)
    }
    return { community: held.key, member, on }
  })
}

async function communityInfo (ctx, { community }) {
  return withIdentity(ctx, async (identity) => {
    const held = await loadCommunity(ctx, identity, community)
    if (held === null) return { community: community.toLowerCase(), ...PENDING_COMMUNITY }
    const linked = await heldLinkedGroups(ctx, identity, held)
    const view = foldHeldCommunity(held, linked)
    const names = new Map(linked.map((g) => [g.key, g.loaded.view.name]))
    return {
      community: held.key,
      name: view.name,
      creator: view.creator,
      groups: view.groups.map((g) => ({ group: g, name: names.has(g) ? names.get(g) : null })),
      admins: view.admins.size,
      state: 'ready',
      incomplete: view.incomplete
    }
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
  communityCreate,
  communityLink,
  communityAdmin,
  communityInfo
}
