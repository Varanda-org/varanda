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
// overrides of the diary limits, ./node-store.js appendRecord;
// mediaKeyPair: this device's media key pair, null while locked). Nothing
// here talks to the network.
//
// Media: mediaPrepare readies this device's media core (header, kv mediaCores,
// whether the diary declares it), mediaCommit stores an item there and returns
// its descriptor; a post may carry descriptors only into an own media core
// the own diary declared (`media-core` records), with every block local and
// the bytes matching (verifyMedia). Follows are local-first: followChange
// (unlocked only) updates kv follows at once and queues the change, signed
// by the identity key, in kv followsPending (one op per key); drainFollows
// appends the verified pending changes as `follow` records (one per key,
// the newest, and only when the diary holds no follow record for that key
// after the op's time or an identical one at the same instant, so a copied
// or re-inserted signed op is a no-op) and drops the rest; foldFollows
// derives kv follows back from the
// own diary; the follows
// kept from before `follow` records existed are published only through
// legacyFollows / confirmLegacyFollows (the person confirms the list).
//
// Moderation: reads consult the blocklist snapshot ./sync.js stored (kept
// only if it still verifies for the trust root), so a blocked followed
// diary is hidden at once, even before a sync run purges its replica.
//
// Engagement (likes, reposts, quotes): likeSet / repostSet are idempotent
// toggles of one `like` / `repost` record about a target ref, decided from
// the own diary's current state (@varanda/core lib/engagement.js: the last
// operation per target wins) so a repeated request writes nothing; a
// self-target is allowed. postQuote is a `post` with a `quote` target (media
// verified as for a reply); engagementRead answers which of the given refs
// the own diary currently likes / reposts.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { certForKey } = require('@varanda/core/lib/cert')
const {
  decodeBlock,
  memberCertRecord,
  profileRecords,
  postRecord,
  mediaCoreRecord,
  followRecord,
  groupJoinRecord,
  groupCutRecord,
  groupConfirmRecord,
  likeRecord,
  repostRecord,
  deleteRecord,
  validAvatar,
  validateRecord,
  validRecordCopy,
  formatRef,
  latestProfile,
  nowIso,
  isHex64,
  MEDIA_BLOCK_BYTES,
  MAX_MEDIA_PER_POST,
  MAX_MEDIA_ITEM_BLOCKS,
  AUDIO_MIME,
  validAudioDescriptor
} = require('@varanda/core/lib/records')
const { validateDescriptor, validateMediaHeader, latestMediaCores, followSet, hasFollowRecords } = require('@varanda/core/lib/media')
const { latestUsername, heldUsernames } = require('@varanda/core/lib/username')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { buildFeed } = require('@varanda/core/lib/feed')
const { applyDeletes, deletedSeqs, shownMedia, liveMediaRefs, overlaps, clearDeleted, presentLength } = require('@varanda/core/lib/deletion')
const { engagementState, isLiked, isReposted } = require('@varanda/core/lib/engagement')
const { verifySnapshot, blockedSet, revokedIssuerSet } = require('@varanda/core/lib/blocklist')
const { UsageError } = require('@varanda/core/lib/errors')
const { copyLinkCard } = require('@varanda/core/lib/link-card')
const grp = require('@varanda/core/lib/group')
const gc = require('@varanda/core/lib/group-crypto')
const { validPrivateItem, copyGroupMedia, PRIVATE_ITEM_KEYS } = require('@varanda/core/lib/group-media')
const { GROUP_LIMIT_DEFAULT, GROUP_MEMBERS_LIMIT_MAX, COMMUNITY_LIST_MAX } = require('@varanda/rpc')
const { stillImageSize } = require('@varanda/core/lib/still-image')
const store = require('./node-store')

const {
  buildGroup, groupJoinHistory, diaryGroupKeys, groupCutHistory, groupConfirmHistory, validateGroupHeader, validateWriterHeader,
  orderKey, compareOrder, MAX_GROUPS_PER_DIARY, MAX_GROUP_CUTS, MAX_GROUP_WRITERS_PER_DIARY, MAX_GROUPS_PER_COMMUNITY
} = grp

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

// Borrowed path (reads only): ctx.cores = { diary, replica(key), group(key) }
// are the cores the live sync run holds (./sync.js reader). A second
// Hypercore on the same files would corrupt them, and closing or purging one
// would pull it from under the run, so they are read in place and never
// closed or purged (the run sweeps empty replicas). Whenever this path
// cannot give exactly the exclusive path's answer (a stored replica or group
// core the run does not lend, a core closed, forked or failing under the
// read) it throws NEEDS_EXCLUSIVE and the session reruns the request
// exclusively.
function needsExclusive () {
  const e = new Error('leitura exclusiva necessária')
  e.code = 'NEEDS_EXCLUSIVE'
  return e
}

function isNeedsExclusive (err) {
  return !!err && err.code === 'NEEDS_EXCLUSIVE'
}

function borrowedCores (ctx) {
  return ctx.cores === undefined || ctx.cores === null ? null : ctx.cores
}

// read(core) on a borrowed core: any failure, or the core closing under
// the read (a read may then come back short), is NEEDS_EXCLUSIVE.
async function readBorrowed (core, read) {
  let value
  try {
    value = await read(core)
  } catch {
    throw needsExclusive()
  }
  if (core.closing) throw needsExclusive()
  return value
}

// read(core) on the stored replica of `key` (hex64, lowercase) -> its result,
// or null when there is no local data (nothing is created). The result
// carries `entries` (and `borrowed`, the core, on the borrowed path); an
// empty replica is purged on the exclusive path only.
async function withReplica (ctx, key, read) {
  const cores = borrowedCores(ctx)
  if (cores !== null) {
    // A core the run holds always has bytes stored: the storage is only
    // asked about the others.
    const core = cores.replica(key)
    if (core !== null) return { ...(await readBorrowed(core, read)), borrowed: core }
    if (!(await store.replicaExists(ctx.storage, key))) return null
    throw needsExclusive()
  }
  if (!(await store.replicaExists(ctx.storage, key))) return null
  const replica = await store.openReplica(ctx.storage, key)
  let value
  try {
    value = await read(replica)
  } finally {
    await replica.close()
  }
  // An empty core must not linger in the storage.
  if (value.entries.length === 0) await store.purgeReplica(ctx.storage, key)
  return value
}

// Opens the own diary (unlocked when ctx holds the key pair), runs fn and
// always closes it; with ctx.cores, runs fn on the borrowed diary instead.
// Right before answering, as diary.peek in ./sync.js: the run may have
// closed or forked a borrowed core since it was read. A closed one ->
// NEEDS_EXCLUSIVE; a fork seen since is judged as a fork (-> the fork to
// judge). The exclusive path closes its cores after the read by design.
function forkNow (read) {
  if (read.borrowed === undefined) return read.fork
  if (read.borrowed.closing) throw needsExclusive()
  return read.fork !== 0 ? read.fork : read.borrowed.fork
}

function checkOwnDiary (ctx) {
  const cores = borrowedCores(ctx)
  if (cores !== null && cores.diary.closing) throw needsExclusive()
}

async function withIdentity (ctx, fn) {
  const association = await trustRoot(ctx)
  if (!(await store.diaryExists(ctx.storage))) throw new Error('identidade não encontrada')
  const cores = borrowedCores(ctx)
  if (cores !== null) {
    // The run opened the diary without a key pair, so it never ran
    // openDiary's passkey check: a pair of another key (or any pair on a
    // legacy store) takes the exclusive path, which refuses it as before.
    const keyPair = keyPairOf(ctx)
    if (keyPair !== null && (store.isLegacy(ctx.storage) || !b4a.equals(cores.diary.key, keyPair.publicKey))) {
      throw needsExclusive()
    }
    return readBorrowed(cores.diary, (diary) => fn({ diary, ownHex: hex(diary.key), association }))
  }
  const diary = await store.openDiary(ctx.storage, keyPairOf(ctx))
  try {
    return await fn({ diary, ownHex: hex(diary.key), association })
  } finally {
    await diary.close()
  }
}

// The stored snapshot's sets -> { blocked, revokedIssuers } (both empty when
// none is stored or it does not verify; a storage failure throws).
async function moderation (storage, association) {
  const data = await store.readBlocklist(storage)
  const snapshot = data === null ? null : data.snapshot
  if (snapshot === null || !verifySnapshot(snapshot, association).ok) {
    return { blocked: new Set(), revokedIssuers: new Set() }
  }
  return { blocked: blockedSet(snapshot), revokedIssuers: revokedIssuerSet(snapshot) }
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

// -> { publicKey, memberCert, memberCertDate } without creating anything.
// The date comes only from the certificate certForKey just verified (it is
// covered by the issuer's signature), so the app can trust it for the age
// policy.
async function identityState (ctx) {
  if ((await store.readConfig(ctx.storage)) === null || !(await store.diaryExists(ctx.storage))) {
    return { publicKey: null, memberCert: false, memberCertDate: null, memberCertIssuer: null }
  }
  return withIdentity(ctx, async ({ diary, ownHex, association }) => {
    const block0 = await store.readBlock0(diary)
    const ok = block0 !== null && validateRecord(block0, 0) === null && certForKey(block0.cert, ownHex, association).ok
    // memberCertIssuer: the v2 certificate's issuer (null for v1), so the
    // session can withhold the date once that issuer is revoked.
    const issuer = ok && typeof block0.cert.issuer === 'string' ? block0.cert.issuer : null
    return { publicKey: ownHex, memberCert: ok, memberCertDate: ok ? block0.cert.date : null, memberCertIssuer: issuer }
  })
}

// ---- cert ----

async function certAdd (ctx, cert) {
  return withIdentity(ctx, async ({ diary, ownHex, association }) => {
    // Block 0 is never replaced: a certificate whose issuer the stored
    // snapshot revoked (B2, R4) would leave the diary unusable for good.
    const { revokedIssuers } = await moderation(ctx.storage, association)
    const r = certForKey(cert, ownHex, association, { revokedIssuers })
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

// Appends to the open own diary -> seq (the genesis rule as a usage error).
async function appendOwn (ctx, diary, record) {
  try {
    return await store.appendRecord(diary, record, ctx.limits)
  } catch (err) {
    if (err.code === 'INVALID_RECORD' && /genesis-required/.test(err.message)) throw new Error(GENESIS_REQUIRED)
    throw err
  }
}

// check(ownHex), optional: a rule on the own key, run before the append.
async function publish (ctx, record, check = null) {
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    if (check !== null) check(ownHex)
    const seq = await appendOwn(ctx, diary, record)
    return { seq, ref: formatRef({ author: ownHex, seq }) }
  })
}

function currentAvatar (entries) {
  return (latestProfile(entries) || {}).avatar || null
}

// A still image of exactly the declared size: the reader checks only the
// descriptor, so the bytes are checked here, at write time.
function stillAvatar (descriptor, bytes) {
  const s = stillImageSize(bytes, descriptor.mime)
  return s !== null && s.width === descriptor.width && s.height === descriptor.height
}

// avatar: undefined keeps the current one, null removes it. A descriptor
// equal to the current one is kept unverified: it may live in another
// device's media core (docs/protocol.md). With an avatar the compat pair
// (plain block, then the same profile with avatar) is one append.
async function profileSet (ctx, { name, bio, avatar }) {
  if (avatar !== undefined && avatar !== null) {
    const current = await withIdentity(ctx, async ({ diary }) => currentAvatar(await store.readAll(diary)))
    if (!deepEqual(avatar, current)) {
      if (!validAvatar(avatar)) throw badMedia()
      await verifyMedia(ctx, [avatar], stillAvatar)
    }
  }
  return withIdentity(ctx, async ({ diary }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const current = currentAvatar(await store.readAll(diary))
    const next = avatar === undefined ? current : avatar
    const records = buildRecord(() => profileRecords({ name, bio: bio || '', avatar: next }))
    if (records.length === 1) return { seq: await appendOwn(ctx, diary, records[0]) }
    try {
      return { seq: await store.appendRecords(diary, records, ctx.limits) }
    } catch (err) {
      if (err.code === 'INVALID_RECORD' && /genesis-required/.test(err.message)) throw new Error(GENESIS_REQUIRED)
      throw err
    }
  })
}

function hasMedia (media) {
  return media !== undefined && media !== null
}

async function postCreate (ctx, { text, media, preview }) {
  if (hasMedia(media)) await verifyMedia(ctx, media)
  if (preview && preview.image !== null) await verifyMedia(ctx, [preview.image])
  return publish(ctx, buildRecord(() => postRecord(hasMedia(media) ? { text, media, preview } : { text, preview })))
}

// to is the parsed { author, seq } reference.
async function postReply (ctx, { to, text, media, preview }) {
  if (!(to.seq >= 1)) throw new UsageError('referência inválida')
  if (hasMedia(media)) await verifyMedia(ctx, media)
  if (preview && preview.image !== null) await verifyMedia(ctx, [preview.image])
  return publish(ctx, buildRecord(() => postRecord(hasMedia(media) ? { text, replyTo: to, media, preview } : { text, replyTo: to, preview })))
}

// to is the parsed { author, seq } reference of the quoted post; media as
// for a reply.
async function postQuote (ctx, { to, text, media, preview }) {
  if (!(to.seq >= 1)) throw new UsageError('referência inválida')
  if (hasMedia(media)) await verifyMedia(ctx, media)
  if (preview && preview.image !== null) await verifyMedia(ctx, [preview.image])
  return publish(ctx, buildRecord(() => postRecord(hasMedia(media) ? { text, quote: to, media, preview } : { text, quote: to, preview })))
}

// ---- delete ----

const NOT_DELETABLE = 'não é possível apagar este registro'
const DELETE_KINDS = {
  post: { other: 'profile', wrong: 'o registro não é uma publicação' },
  profile: { other: 'post', wrong: 'o registro não é um perfil' }
}

// The compat pair profileRecords writes: a plain profile immediately
// followed by the same profile with an avatar (never the other order).
function compatPair (plain, withAvatar) {
  return plain !== null && withAvatar !== null &&
    plain.type === 'profile' && withAvatar.type === 'profile' &&
    plain.avatar === undefined && withAvatar.avatar !== undefined &&
    plain.name === withAvatar.name && plain.bio === withAvatar.bio && plain.at === withAvatar.at
}

function recordAt (raw, seq) {
  return seq >= 1 && seq < raw.length ? validRecordCopy(raw[seq].record, seq) : null
}

function descriptorsOf (record) {
  return shownMedia(record)
}

// The seq of the highest effective tombstone whose target is in targets.
function existingTombstone (raw, deleted, targets) {
  let last = null
  for (const { seq, record } of raw) {
    if (deleted.has(seq)) continue
    const copy = validRecordCopy(record, seq)
    if (copy !== null && copy.type === 'delete' && targets.includes(copy.seq) && (last === null || seq > last)) last = seq
  }
  return last
}

// The tombstone that deleted `seq` and, for a profile, the other half of a
// compat pair, when the target block itself is already cleared and cannot be
// read. The pair writer appends both tombstones in one append, in seq order
// and with one `at`, so only consecutive tombstones of seq n then n + 1
// carrying the same `at` are taken as one pair; two separate deletions of
// adjacent versions stay apart (same rule as @varanda/core member.js).
function clearedTargets (raw, deleted, seq, kind) {
  const own = existingTombstone(raw, deleted, [seq])
  if (kind !== 'profile' || own === null) return [seq]
  const tomb = (i) => {
    const copy = deleted.has(i) ? null : recordAt(raw, i)
    return copy !== null && copy.type === 'delete' ? copy : null
  }
  const ownCopy = tomb(own)
  const next = tomb(own + 1)
  if (next !== null && next.seq === seq + 1 && next.at === ownCopy.at) return [seq, seq + 1]
  const prev = tomb(own - 1)
  if (prev !== null && prev.seq === seq - 1 && prev.at === ownCopy.at) return [seq - 1, seq]
  return [seq]
}

// Clears what a deletion hides on this device: the targeted diary blocks
// and the tombstones' media ranges on every stored own media core (this
// device's and other devices' replicated read-only) whose header names the
// diary. No media key is needed to clear. Best effort: the tombstone is
// already appended, and the next sync clears again.
async function clearAfterDelete (ctx, diary, ownHex, targets, records) {
  if (ctx.noClear === true) return
  try {
    await clearDeleted(diary, targets)
  } catch {}
  const byCore = new Map()
  for (const r of records) {
    for (const m of Array.isArray(r.media) ? r.media : []) {
      if (!byCore.has(m.core)) byCore.set(m.core, [])
      byCore.get(m.core).push({ start: m.start, blocks: m.blocks })
    }
  }
  if (byCore.size === 0) return
  let stored = []
  try {
    stored = await store.readMediaCores(ctx.storage)
  } catch {}
  for (const key of stored) {
    if (!byCore.has(key)) continue
    let core = null
    try {
      core = await store.openMediaCoreReadOnly(ctx.storage, key)
      if (core === null || core.length < 1 || !(await core.has(0))) continue
      const header = decodeBlock(await core.get(0, { wait: false }))
      if (header === null || validateMediaHeader(header) !== null || header.diary !== ownHex) continue
      await store.clearMediaRanges(core, byCore.get(key))
    } catch {} finally {
      if (core !== null) await core.close().catch(() => {})
    }
  }
}

// Tombstones for the caller's own post or profile block `to` -> { seq, ref,
// changed, deleted } (docs/rpc.md 5.33, 5.34). A compat pair is one version:
// both tombstones go in one append. A target already deleted writes nothing,
// even once its block was cleared. Media ranges are only the target's
// descriptors in a core the diary declared that no surviving own post or
// profile overlaps; after the append the targets and those ranges are
// cleared on this device (clearAfterDelete).
async function recordDelete (ctx, kind, { to }) {
  const rules = DELETE_KINDS[kind]
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    if (to.author !== ownHex || !(to.seq >= 1) || to.seq >= diary.length) throw new UsageError('referência inválida')
    const raw = await store.readRaw(diary)
    if (to.seq < raw.length && raw[to.seq].record === null) {
      const gone = deletedSeqs(raw)
      if (gone.has(to.seq)) {
        const targets = clearedTargets(raw, gone, to.seq, kind)
        const seq = existingTombstone(raw, gone, targets)
        return { seq, ref: seq === null ? null : formatRef({ author: ownHex, seq }), changed: false, deleted: targets }
      }
    }
    const target = recordAt(raw, to.seq)
    if (target === null) throw new UsageError('referência inválida')
    if (target.type === rules.other) throw new UsageError(rules.wrong)
    if (target.type !== kind) throw new UsageError(NOT_DELETABLE)
    let targets = [to.seq]
    if (kind === 'profile') {
      if (target.avatar === undefined && compatPair(target, recordAt(raw, to.seq + 1))) targets = [to.seq, to.seq + 1]
      else if (target.avatar !== undefined && compatPair(recordAt(raw, to.seq - 1), target)) targets = [to.seq - 1, to.seq]
    }
    const deleted = deletedSeqs(raw)
    const pending = targets.filter((seq) => !deleted.has(seq))
    if (pending.length === 0) {
      const seq = existingTombstone(raw, deleted, targets)
      return { seq, ref: seq === null ? null : formatRef({ author: ownHex, seq }), changed: false, deleted: targets }
    }
    const declared = new Set(latestMediaCores(applyDeletes(raw), ownHex, Number.MAX_SAFE_INTEGER).map((c) => c.key))
    const live = liveMediaRefs(raw, targets)
    // One `at` for the whole append marks the tombstones of a pair as one.
    const at = nowIso()
    const records = pending.map((seq) => {
      const media = descriptorsOf(recordAt(raw, seq))
        .filter((d) => declared.has(d.core) && !live.some((l) => overlaps(l, d)))
        .map((d) => ({ core: d.core, start: d.start, blocks: d.blocks }))
      return buildRecord(() => deleteRecord(media.length > 0 ? { seq, at, media } : { seq, at }))
    })
    const seq = records.length === 1
      ? await appendOwn(ctx, diary, records[0])
      : await store.appendRecords(diary, records, ctx.limits)
    await clearAfterDelete(ctx, diary, ownHex, pending, records)
    return { seq, ref: formatRef({ author: ownHex, seq }), changed: true, deleted: targets }
  })
}

function postDelete (ctx, params) {
  return recordDelete(ctx, 'post', params)
}

function profileDelete (ctx, params) {
  return recordDelete(ctx, 'profile', params)
}

// ---- likes / reposts ----

// The seq of the effective `type` record about `ref` (the last valid one,
// as engagementState replays them), or null when there never was one.
function lastEngagementSeq (entries, type, ref) {
  let last = null
  for (const { seq, record } of entries) {
    if (!(seq >= 1)) continue
    const copy = validRecordCopy(record, seq)
    if (copy !== null && copy.type === type && formatRef(copy.to) === ref && (last === null || seq > last)) last = seq
  }
  return last
}

// Idempotent toggle of one engagement -> { seq, on, changed }: when the own
// diary is already in the requested state nothing is written and seq is that
// of the existing effective record (null if none ever). A self-target is
// allowed. `to` is the parsed { author, seq } reference.
async function engagementSet (ctx, type, make, { to, on }) {
  if (!(to.seq >= 1)) throw new UsageError('referência inválida')
  return withIdentity(ctx, async ({ diary }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const entries = await store.readAll(diary)
    const ref = formatRef(to)
    const state = engagementState(entries)
    const current = type === 'like' ? isLiked(state, ref) : isReposted(state, ref)
    if (current === on) return { seq: lastEngagementSeq(entries, type, ref), on, changed: false }
    const record = buildRecord(() => make({ to, on }))
    return { seq: await appendOwn(ctx, diary, record), on, changed: true }
  })
}

function likeSet (ctx, params) {
  return engagementSet(ctx, 'like', likeRecord, params)
}

function repostSet (ctx, params) {
  return engagementSet(ctx, 'repost', repostRecord, params)
}

// Which of `refs` the own diary currently likes / reposts -> { liked,
// reposted }, each a subset of refs in request order. Works locked.
async function engagementRead (ctx, { refs }) {
  return withIdentity(ctx, async ({ diary }) => {
    const state = engagementState(await store.readAll(diary))
    return {
      liked: refs.filter((ref) => state.liked.has(ref.toLowerCase())),
      reposted: refs.filter((ref) => state.reposted.has(ref.toLowerCase()))
    }
  })
}

// ---- media ----

function badMedia () {
  return new UsageError(store.MEDIA_INVALID)
}

// SHA-256 (WebCrypto) of the concatenated chunks, lowercase hex.
async function sha256Hex (chunks) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle
  if (!subtle) throw new Error('WebCrypto indisponível')
  const digest = await subtle.digest('SHA-256', b4a.concat(chunks))
  return hex(new Uint8Array(digest))
}

function mediaKeyPairOf (ctx) {
  return ctx.mediaKeyPair === undefined ? null : ctx.mediaKeyPair
}

// This device's media core, open and unlocked for `fn`: created with the
// header naming the own diary when new, checked to name it when not, and
// recorded in kv mediaCores. Never the diary key.
async function withOwnMediaCore (ctx, fn) {
  const mediaKeyPair = mediaKeyPairOf(ctx)
  if (keyPairOf(ctx) === null || mediaKeyPair === null) throw new UsageError(store.LOCKED)
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    const core = await store.openMediaCore(ctx.storage, mediaKeyPair)
    try {
      const coreHex = hex(core.key)
      if (coreHex === ownHex) throw badMedia()
      if (core.length === 0) {
        await store.writeMediaHeader(core, ownHex)
      } else {
        const header = decodeBlock(await core.get(0, { wait: false }))
        if (header === null || validateMediaHeader(header) !== null || header.diary !== ownHex) {
          throw new Error('núcleo de mídia de outro diário')
        }
      }
      await store.addMediaCore(ctx.storage, coreHex)
      return await fn({ core, coreHex, diary, ownHex })
    } finally {
      await core.close()
    }
  })
}

// Readies this device's media core for an upload (header, kv mediaCores)
// without storing any item -> { core: hex, declared }: declared is false
// when the own diary does not list the core among its latest `media-core`
// records yet, so the caller declares it (declareMediaCore, through the
// write gate) BEFORE mediaCommit appends the bytes: a declaration that
// fails (seeder unreachable) leaves the core without the item, and a retry
// appends it once.
async function mediaPrepare (ctx) {
  return withOwnMediaCore(ctx, async ({ coreHex, diary, ownHex }) => {
    const declared = latestMediaCores(await store.readAll(diary), ownHex)
    return { core: coreHex, declared: declared.some((c) => c.key === coreHex) }
  })
}

// Stores one item (its blocks: MEDIA_BLOCK_BYTES each, the last 1..) in
// this device's media core (readied by mediaPrepare; the header is written
// here too when missing) -> the descriptor.
async function mediaCommit (ctx, { blocks, mime, width, height, sha256 } = {}) {
  if (keyPairOf(ctx) === null || mediaKeyPairOf(ctx) === null) throw new UsageError(store.LOCKED)
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > MAX_MEDIA_ITEM_BLOCKS) throw badMedia()
  let bytes = 0
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!(block instanceof Uint8Array)) throw badMedia()
    const n = block.byteLength
    if (i < blocks.length - 1 ? n !== MEDIA_BLOCK_BYTES : (n < 1 || n > MEDIA_BLOCK_BYTES)) throw badMedia()
    bytes += n
  }
  if (typeof sha256 !== 'string' || !isHex64(sha256) || (await sha256Hex(blocks)) !== sha256) throw badMedia()
  // The shape is checked before anything is stored (start is provisional).
  const shape = { core: '0'.repeat(64), mime, start: 1, blocks: blocks.length, bytes, sha256, width, height }
  if (validateDescriptor(shape) !== null) throw badMedia()
  return withOwnMediaCore(ctx, async ({ core, coreHex }) => {
    const start = await store.appendMediaBlocks(core, blocks)
    const descriptor = { core: coreHex, mime, start, blocks: blocks.length, bytes, sha256, width, height }
    if (validateDescriptor(descriptor) !== null) throw badMedia()
    return descriptor
  })
}

// The voice note counterpart of mediaCommit (public groups only): the same
// blocks, stored as an audio descriptor (no picture size, its duration). The
// caller (session mediaUpload) has checked the bytes with audioBounds.
async function mediaCommitAudio (ctx, { blocks, sha256, ms } = {}) {
  if (keyPairOf(ctx) === null || mediaKeyPairOf(ctx) === null) throw new UsageError(store.LOCKED)
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > MAX_MEDIA_ITEM_BLOCKS) throw badMedia()
  let bytes = 0
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!(block instanceof Uint8Array)) throw badMedia()
    const n = block.byteLength
    if (i < blocks.length - 1 ? n !== MEDIA_BLOCK_BYTES : (n < 1 || n > MEDIA_BLOCK_BYTES)) throw badMedia()
    bytes += n
  }
  if (typeof sha256 !== 'string' || !isHex64(sha256) || (await sha256Hex(blocks)) !== sha256) throw badMedia()
  const shape = { core: '0'.repeat(64), mime: AUDIO_MIME, start: 1, blocks: blocks.length, bytes, sha256, width: 0, height: 0, ms }
  if (!validAudioDescriptor(shape)) throw badMedia()
  return withOwnMediaCore(ctx, async ({ core, coreHex }) => {
    const start = await store.appendMediaBlocks(core, blocks)
    const descriptor = { core: coreHex, mime: AUDIO_MIME, start, blocks: blocks.length, bytes, sha256, width: 0, height: 0, ms }
    if (!validAudioDescriptor(descriptor)) throw badMedia()
    return descriptor
  })
}

// The sealed counterpart of mediaCommit (private groups): appends the
// ciphertext of sealMedia (whole blocks only) -> the private item, the only
// place its key appears.
async function mediaCommitSealed (ctx, { cipher, item } = {}) {
  if (keyPairOf(ctx) === null || mediaKeyPairOf(ctx) === null) throw new UsageError(store.LOCKED)
  if (!(cipher instanceof Uint8Array) || cipher.byteLength < MEDIA_BLOCK_BYTES || cipher.byteLength % MEDIA_BLOCK_BYTES !== 0) throw badMedia()
  const blocks = []
  for (let i = 0; i < cipher.byteLength; i += MEDIA_BLOCK_BYTES) blocks.push(cipher.subarray(i, i + MEDIA_BLOCK_BYTES))
  const shape = { ...item, core: '0'.repeat(64), start: 1 }
  if (!validPrivateItem(shape) || shape.blocks !== blocks.length || (await sha256Hex(blocks)) !== item.sha256) throw badMedia()
  return withOwnMediaCore(ctx, async ({ core, coreHex }) => {
    const start = await store.appendMediaBlocks(core, blocks)
    const out = {}
    for (const k of PRIVATE_ITEM_KEYS) out[k] = k === 'core' ? coreHex : k === 'start' ? start : item[k]
    if (!validPrivateItem(out)) throw badMedia()
    return out
  })
}

// Appends the `media-core` record declaring coreHex (publish rules: block 0
// first) -> { seq }. The own diary key is never a media core.
async function declareMediaCore (ctx, coreHex) {
  if (!isHex64(coreHex)) throw new UsageError('chave inválida')
  const record = buildRecord(() => mediaCoreRecord({ key: coreHex }))
  const { seq } = await publish(ctx, record, (ownHex) => {
    if (coreHex === ownHex) throw new UsageError('chave inválida')
  })
  return { seq }
}

// Every descriptor must point into an own media core (kv mediaCores) that
// the own diary declares among its latest `media-core` records, with every
// block local and the bytes matching; else 'mídia inválida'. inspect, when
// given, is called with (descriptor, bytes) and a falsy result refuses it.
async function verifyMedia (ctx, media, inspect = null, valid = (d) => validateDescriptor(d) === null) {
  if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_PER_POST) throw badMedia()
  const own = new Set(await store.readMediaCores(ctx.storage))
  const { ownHex, declared } = await withIdentity(ctx, async ({ diary, ownHex }) => ({
    ownHex,
    declared: new Set(latestMediaCores(await store.readAll(diary), ownHex).map((c) => c.key))
  }))
  for (const descriptor of media) {
    if (!valid(descriptor)) throw badMedia()
    const { core: coreHex, start, blocks, bytes, sha256 } = descriptor
    if (coreHex === ownHex || !own.has(coreHex) || !declared.has(coreHex)) throw badMedia()
    const core = await store.openMediaCoreReadOnly(ctx.storage, coreHex)
    if (core === null) throw badMedia()
    try {
      if (start + blocks > core.length) throw badMedia()
      const chunks = []
      let total = 0
      for (let i = start; i < start + blocks; i++) {
        const block = await core.get(i, { wait: false })
        if (block === null) throw badMedia()
        chunks.push(block)
        total += block.byteLength
      }
      if (total !== bytes || (await sha256Hex(chunks)) !== sha256) throw badMedia()
      if (typeof inspect === 'function' && !inspect(descriptor, b4a.concat(chunks))) throw badMedia()
    } finally {
      await core.close()
    }
  }
}

// ---- username ----

const USERNAME_RECORD_KEYS = ['type', 'username', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']

// Appends a plain copy of an issuer-signed username record (the caller,
// lib/session.js username.add, has verified it for the own key) -> { seq }.
async function usernameAdd (ctx, record) {
  // A record from a revoked issuer (B2, R4) is invalid for every reader.
  const { revokedIssuers } = await moderation(ctx.storage, await trustRoot(ctx))
  if (typeof record.issuer === 'string' && revokedIssuers.has(record.issuer.toLowerCase())) {
    throw new UsageError('registro de nome inválido')
  }
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

// What the notices read checks a post against (./notices.js): the usernames
// the own diary verifiably held (username -> issuer, NOT filtered by the
// revoked issuers, which the reader applies on every read so a cached
// context never outlives a revocation) and the seqs of its post blocks.
// -> { key, present, length, deleted, names, posts }. `cache` (a previous
// result or null) is returned as is while the own key, the length and the
// present length (walked with the cached deleted set) are unchanged:
// readAll reads up to the present length only.
async function ownNoticeContext (ctx, cache = null) {
  return withIdentity(ctx, async ({ diary, ownHex, association }) => {
    if (cache !== null && cache.key === ownHex && cache.length === diary.length &&
        cache.present === await presentLength(diary, cache.deleted)) return cache
    const length = diary.length
    const entries = await store.readAll(diary)
    const posts = new Set()
    const deleted = new Set()
    for (const { seq, record, deleted: gone } of entries) {
      if (gone === true) deleted.add(seq)
      const copy = validRecordCopy(record, seq)
      if (copy !== null && copy.type === 'post') posts.add(seq)
    }
    return { key: ownHex, present: entries.length, length, deleted, names: heldUsernames(entries, ownHex, association), posts }
  })
}

// ---- follows ----

// Every pending follow op is signed by the identity key over a
// domain-separated statement of its fields and the own key, so an op
// written straight into the storage (IndexedDB) or left by an older build
// is never signed into the public diary: drainFollows verifies each op and
// drops what does not verify.
const FOLLOW_OP_PREFIX = 'varanda-follow-op-v1\n'
const HEX128 = /^[0-9a-f]{128}$/

function followOpPayload ({ key, on, at }, ownHex) {
  return b4a.from(FOLLOW_OP_PREFIX + key + '\n' + (on ? '1' : '0') + '\n' + at + '\n' + ownHex)
}

// -> the op with its `sig` (hex128) for the own key.
function signFollowOp (op, ownHex, keyPair) {
  return { ...op, sig: hex(crypto.sign(followOpPayload(op, ownHex), keyPair.secretKey)) }
}

// Shape and signature of a pending op for the own key; never throws.
function verifyFollowOp (op, ownHex) {
  if (op === null || typeof op !== 'object' || !isHex64(op.key) || typeof op.on !== 'boolean' ||
      typeof op.at !== 'string' || typeof op.sig !== 'string' || !HEX128.test(op.sig)) return false
  try {
    return crypto.verify(followOpPayload(op, ownHex), b4a.from(op.sig, 'hex'), b4a.from(ownHex, 'hex'))
  } catch {
    return false
  }
}

// Local-first: kv follows changes at once and the change is queued, signed,
// in kv followsPending (drainFollows appends it); needs the identity key (a
// change planted while signed out would otherwise be signed into the diary
// at the next sign-in). The queue keeps one op per key (the newest replaces
// an older one, at the end) and at most MAX_INVENTORY - 1 ops.
async function followChange (ctx, author, follow) {
  const keyPair = keyPairOf(ctx)
  if (keyPair === null) throw new UsageError(store.LOCKED)
  return withIdentity(ctx, async ({ ownHex, association }) => {
    if (author === ownHex) throw new Error('não é possível seguir a própria chave')
    if (follow && (await moderation(ctx.storage, association)).blocked.has(String(author).toLowerCase())) {
      throw new UsageError('autor bloqueado')
    }
    return queueFollowChange(ctx.storage, ownHex, keyPair, author, follow)
  })
}

// The kv part of followChange for an identity already checked: kv follows
// and the signed op in kv followsPending, without opening the diary, so a
// running sync can call it (./sync.js followPage, a page key move).
function queueFollowChange (storage, ownHex, keyPair, author, follow) {
  return store.withFollowsLock(storage, async () => {
    const current = await store.readFollows(storage)
    const has = current.includes(author)
    if (follow === has) return { follows: current, changed: false }
    // The inventory (own diary + follows) must fit a hello (MAX_INVENTORY).
    if (follow && current.length >= MAX_INVENTORY - 1) throw new Error('limite de diários seguidos atingido')
    const next = follow ? [...current, author] : current.filter((k) => k !== author)
    // The op is queued BEFORE kv follows changes: kv follows only ever
    // reaches the target state once the op is queued, so a retry that
    // finds it there (changed: false) never hides an op that was never
    // queued. A failed pending write changes nothing and propagates; a
    // failed follows write after it leaves the op queued (the retry
    // queues it again, harmless: the last op per key wins).
    const key = String(author).toLowerCase()
    if (isHex64(key) && key !== ownHex) {
      const pending = (await store.readFollowsPending(storage)).filter((op) => op.key !== key)
      pending.push(signFollowOp({ key, on: follow, at: nowIso() }, ownHex, keyPair))
      await store.writeFollowsPending(storage, pending.slice(-(MAX_INVENTORY - 1)))
    }
    await store.writeFollows(storage, next)
    return { follows: await store.readFollows(storage), changed: true }
  })
}

// Appends the VERIFIED pending follow changes (verifyFollowOp for the own
// key; the rest is dropped from the queue, never appended) as `follow`
// records, in order -> { appended, seq } (seq: that of the last record
// appended, null when none), at most one per key (the newest `at`) and
// none the diary already decided after the op's `at` or at the same
// instant with the same `on` (replayed or copied ops are no-ops). Needs
// the key pair and block 0, else does
// nothing. Nothing else is ever appended here: the follows this device
// kept from before `follow` records existed reach the diary only through
// confirmLegacyFollows (the person confirms the exact list once). The
// pending ops appended are removed only once every append succeeded; ops
// queued meanwhile stay.
async function drainFollows (ctx) {
  if (keyPairOf(ctx) === null) return { appended: 0, seq: null }
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (diary.length === 0) return { appended: 0, seq: null }
    let seq = null
    let appended = 0
    // Every op read now leaves the queue at the end, appended or not (the
    // read is capped at MAX_INVENTORY - 1 ops, ./node-store.js).
    const read = await store.readFollowsPending(ctx.storage)
    const verified = read.filter((op) => op.key !== ownHex && verifyFollowOp(op, ownHex))
    // Replay protection. Signed ops can be copied or re-inserted by anyone
    // with the profile, so: one op per key, the newest `at` (canonical ISO,
    // so strings compare as instants; equal copies collapse to one), and
    // nothing the caught-up diary already decided: a key whose latest valid
    // follow record is AFTER the op's `at`, or at the same instant with the
    // same `on` (the drain writes records with the op's own `at`, so a
    // consumed op matches its record exactly), is skipped; an older op can
    // never override a newer record, while a same-millisecond op with the
    // other `on` is a real change and goes through.
    const newest = new Map()
    for (const op of verified) {
      const current = newest.get(op.key)
      if (current === undefined || op.at > current.at) newest.set(op.key, op)
    }
    const decided = new Map()
    for (const { seq: s, record } of await store.readAll(diary)) {
      if (record === null || record.type !== 'follow' || validateRecord(record, s) !== null) continue
      const latest = decided.get(record.key)
      if (latest === undefined || record.at >= latest.at) decided.set(record.key, { at: record.at, on: record.on })
    }
    const consumed = (op) => {
      const latest = decided.get(op.key)
      return latest !== undefined && (latest.at > op.at || (latest.at === op.at && latest.on === op.on))
    }
    const kept = new Set(newest.values())
    const pending = verified.filter((op) => kept.has(op) && !consumed(op))
    for (const op of pending) {
      seq = await store.appendRecord(diary, followRecord({ key: op.key, on: op.on, at: op.at }), ctx.limits)
      appended++
    }
    if (read.length > 0) {
      const id = (op) => op.key + ':' + op.at + ':' + op.sig
      const done = new Set(read.map(id))
      await store.withFollowsLock(ctx.storage, async () => {
        const now = await store.readFollowsPending(ctx.storage)
        await store.writeFollowsPending(ctx.storage, now.filter((op) => !done.has(id(op))))
      })
    }
    return { appended, seq }
  })
}

// ---- legacy follows (from before `follow` records existed) ----
//
// kv follows is unauthenticated (anyone with the browser profile can write
// it) and the per-device marker kv followsMigrated can be deleted, so the
// follows a device kept before `follow` records existed are NEVER published
// automatically: legacyFollows lists them and confirmLegacyFollows publishes
// exactly the keys the person confirmed (as signed pending ops, appended by
// the drain), drops the rest from kv follows and sets the marker. While the
// marker is unset and kv follows is non-empty the sync's fold leaves kv
// follows alone (./node-store.js writeFoldedFollows): the device keeps its
// old list locally until the person decides.

// The kv follows that no valid diary `follow` record mentions and no
// verified pending op covers: valid hex64, not the own key, sorted, at most
// MAX_INVENTORY - 1.
async function legacySet (ctx, diary, ownHex) {
  const mentioned = new Set()
  for (const { seq, record } of await store.readAll(diary)) {
    if (record !== null && record.type === 'follow' && validateRecord(record, seq) === null) mentioned.add(record.key)
  }
  for (const op of await store.readFollowsPending(ctx.storage)) {
    if (verifyFollowOp(op, ownHex)) mentioned.add(op.key)
  }
  const keys = new Set()
  for (const raw of await store.readFollows(ctx.storage)) {
    const key = String(raw).toLowerCase()
    if (isHex64(key) && key !== ownHex && !mentioned.has(key)) keys.add(key)
  }
  return [...keys].sort().slice(0, MAX_INVENTORY - 1)
}

// Needs the key pair (USAGE LOCKED) and block 0 (GENESIS_REQUIRED).
async function withLegacy (ctx, fn) {
  if (keyPairOf(ctx) === null) throw new UsageError(store.LOCKED)
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    return fn({ diary, ownHex })
  })
}

// -> { keys }: the legacy follows awaiting the person's decision; [] once
// this device's marker is set. An EMPTY set with the marker unset (every
// local follow is already the diary's or pending) leaves nothing to decide:
// the marker is set right here, so the fold is not blocked for good on a
// device the person never sees a card for (nothing is published).
async function legacyFollows (ctx) {
  return withLegacy(ctx, async ({ diary, ownHex }) => {
    return store.withFollowsLock(ctx.storage, async () => {
      if (await store.readFollowsMigrated(ctx.storage)) return { keys: [] }
      const keys = await legacySet(ctx, diary, ownHex)
      if (keys.length === 0) await store.writeFollowsMigrated(ctx.storage)
      return { keys }
    })
  })
}

// Publishes the legacy follows the person confirmed -> { published }: for
// each key in BOTH `keys` and the (recomputed) legacy set a signed `on:
// true` pending op is queued (the drain appends it); every legacy key not
// confirmed leaves kv follows; then the marker is set. Keys outside the set
// are ignored.
async function confirmLegacyFollows (ctx, keys) {
  const keyPair = keyPairOf(ctx)
  return withLegacy(ctx, async ({ diary, ownHex }) => {
    const wanted = new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string').map((k) => k.toLowerCase()))
    return store.withFollowsLock(ctx.storage, async () => {
      const set = (await store.readFollowsMigrated(ctx.storage)) ? [] : await legacySet(ctx, diary, ownHex)
      const confirmed = set.filter((key) => wanted.has(key))
      const dropped = new Set(set.filter((key) => !wanted.has(key)))
      if (confirmed.length > 0) {
        const pending = (await store.readFollowsPending(ctx.storage)).filter((op) => !confirmed.includes(op.key))
        const at = nowIso()
        for (const key of confirmed) pending.push(signFollowOp({ key, on: true, at }, ownHex, keyPair))
        await store.writeFollowsPending(ctx.storage, pending.slice(-(MAX_INVENTORY - 1)))
      }
      if (dropped.size > 0) {
        const follows = (await store.readFollows(ctx.storage)).filter((k) => !dropped.has(String(k).toLowerCase()))
        await store.writeFollows(ctx.storage, follows)
      }
      await store.writeFollowsMigrated(ctx.storage)
      return { published: confirmed.length }
    })
  })
}

// kv follows derived from the own diary's `follow` records with the pending
// ops on top (./node-store.js writeFoldedFollows) -> { follows, changed };
// a diary with no `follow` record leaves kv follows as it is.
async function foldFollows (ctx) {
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    const entries = await store.readAll(diary)
    if (!hasFollowRecords(entries)) return { follows: await store.readFollows(ctx.storage), changed: false }
    return store.writeFoldedFollows(ctx.storage, followSet(entries, ownHex), ownHex)
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
// diário' without creating anything; an empty replica is purged (D). The
// entries are feedRead's (store.readVisible): the prefix and the newest
// run, in seq order, a hole the run passed absent. raw: every stored block
// with the core's length (store.readHeld).
async function readReplica (ctx, key, raw = false) {
  const readCore = raw
    ? async (core) => ({ ...(await store.readHeld(core)), fork: core.fork })
    : async (core) => ({ entries: (await store.readVisible(core)).entries, fork: core.fork })
  const read = HEX64.test(key) ? await withReplica(ctx, key, readCore) : null
  if (read === null) throw new Error('sem dados locais para este diário')
  return read
}

// raw: the blocks as decoded, tombstones not applied, for the page folds of
// @varanda/core lib/page.js, where a delete of a page-* record has no
// effect; a replica answers every block it stores (holes skipped) and
// `length`, the core's, so the caller can tell a whole chain from a part.
async function logRead (ctx, { author = null, raw = false } = {}) {
  const readOwn = raw ? store.readRaw : store.readAll
  const own = await withIdentity(ctx, async ({ diary, ownHex, association }) => ({ key: ownHex, association, length: diary.length, entries: author && author !== ownHex ? null : await readOwn(diary) }))
  if (own.entries !== null) return raw ? { key: own.key, entries: own.entries, length: own.length } : { key: own.key, entries: own.entries }
  // The rule of skipReason: a blocked diary, or one whose block-0
  // certificate comes from a revoked issuer, reads as absent (the same
  // error, never why), even before a sync run purges it and whatever its
  // follow state.
  const key = String(author).toLowerCase()
  const mod = await moderation(ctx.storage, own.association)
  if (mod.blocked.has(key)) throw new Error('sem dados locais para este diário')
  const read = await readReplica(ctx, key, raw)
  const entries = read.entries
  // A snapshot adopted during the read (the run is live) decides the answer.
  const final = await moderation(ctx.storage, own.association)
  // A fork is not refused here (nor on the exclusive path); a closed core is.
  forkNow(read)
  if (final.blocked.has(key)) throw new Error('sem dados locais para este diário')
  if (final.revokedIssuers.size > 0 && revokedIssuerOf(entries, key, own.association, final.revokedIssuers)) {
    throw new Error('sem dados locais para este diário')
  }
  return raw ? { key: author, entries, length: read.length } : { key: author, entries }
}

function logReadRaw (ctx, { author = null } = {}) {
  return logRead(ctx, { author, raw: true })
}

// Whether the log's block-0 certificate fails only because its issuer is
// revoked.
function revokedIssuerOf (entries, key, association, revokedIssuers) {
  const first = entries.length > 0 && entries[0].seq === 0 ? entries[0].record : null
  if (first === null || validateRecord(first, 0) !== null) return false
  return certForKey(first.cert, key, association, { revokedIssuers }).reason === 'revoked-issuer'
}

// ---- feed ----

// Reason a followed log is not shown, or null when it is kept. mod: the
// stored snapshot's { blocked, revokedIssuers } (optional).
function skipReason (core, entries, key, association, mod = {}) {
  if (mod.blocked && mod.blocked.has(key)) return 'blocked'
  if (core.fork !== 0) return 'fork'
  if (entries.length === 0) return 'no-cert'
  const first = entries[0].record
  if (validateRecord(first, 0) !== null) return 'not-in-log'
  const r = certForKey(first.cert, key, association, { revokedIssuers: mod.revokedIssuers })
  return r.ok ? null : r.reason
}

async function feedRead (ctx, { limit = Infinity, before = null } = {}) {
  const association = await trustRoot(ctx)
  const mod = await moderation(ctx.storage, association)
  const own = await withIdentity(ctx, async ({ diary, ownHex }) => ({ key: ownHex, entries: await store.readAll(diary) }))
  // One slot per followed key, in follow order: a fixed reason, or what was
  // read, judged only once every read is done.
  const slots = []
  const seen = new Set([own.key])
  for (const raw of await store.readFollows(ctx.storage)) {
    if (typeof raw !== 'string' || !HEX64.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    // Hidden before any read, whether or not its purge already ran.
    if (mod.blocked.has(key)) {
      slots.push({ key, reason: 'blocked' })
      continue
    }
    // Never create a core for a key with no local data (R5.4 a).
    // The prefix plus the newest run (store.readVisible): a diary that
    // downloads newest-first shows its latest posts before its history.
    const read = await withReplica(ctx, key, async (core) => {
      const { entries, raw, present } = await store.readVisible(core)
      return { entries, raw, fork: core.fork, behind: core.length > present }
    })
    slots.push(read === null ? { key, reason: 'no-cert' } : { key, read })
  }
  // A snapshot adopted during the reads (the run is live) decides the answer.
  const final = await moderation(ctx.storage, association)
  checkOwnDiary(ctx)
  const kept = [own]
  const skipped = []
  const incomplete = []
  for (const { key, reason: fixed, read } of slots) {
    // A key blocked in the first snapshot stays skipped 'blocked' even when
    // the final one unblocks it (fail-safe, no second read pass).
    const reason = read === undefined
      ? (final.blocked.has(key) ? 'blocked' : fixed)
      : skipReason({ fork: forkNow(read) }, read.entries, key, association, final)
    if (reason === null && read.behind) incomplete.push(key)
    if (reason === null) kept.push({ key, entries: read.entries, raw: read.raw })
    else skipped.push({ key, reason })
  }
  const built = buildFeed({ logs: kept, limit: limit || Infinity, association, revokedIssuers: final.revokedIssuers, before })
  return { items: built.items, skipped, future: built.future, incomplete }
}

// ---- profile.read ----

// What a non-own diary's admission needs ({ entries, fork }), or null when
// feedRead would skip it before any read (blocked, no local data). Never
// creates a replica; an empty one is purged (exclusive path only). The
// entries are feedRead's (store.readVisible), so a name never reads older
// here than in the feed.
async function replicaRead (ctx, key, mod) {
  if (mod.blocked.has(key)) return null
  return withReplica(ctx, key, async (core) => ({ entries: (await store.readVisible(core)).entries, fork: core.fork }))
}

// The entries when feedRead would show the diary, else null: the admission
// rules of feedRead (blocked, no local data, skipReason), not those of
// logRead.
function admittedEntries (read, key, association, mod) {
  if (read === null) return null
  return skipReason({ fork: forkNow(read) }, read.entries, key, association, mod) === null ? read.entries : null
}

// Names of the given authors from local data only (docs/rpc.md 5.21) ->
// { profiles: [{ author, name, bio, username }], missing: [hex64] }, one entry
// per distinct (lowercased) author in first-occurrence order. Works locked.
async function profileRead (ctx, { authors }) {
  const association = await trustRoot(ctx)
  const mod = await moderation(ctx.storage, association)
  const keys = []
  const seen = new Set()
  for (const raw of authors) {
    const key = String(raw).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  const own = await withIdentity(ctx, async ({ diary, ownHex }) => ({
    key: ownHex,
    entries: seen.has(ownHex) ? await store.readAll(diary) : null
  }))
  const reads = new Map()
  for (const key of keys) {
    if (key !== own.key && HEX64.test(key)) reads.set(key, await replicaRead(ctx, key, mod))
  }
  // A snapshot adopted during the reads (the run is live) decides the answer.
  const final = await moderation(ctx.storage, association)
  if (own.entries !== null) checkOwnDiary(ctx)
  const profiles = []
  const missing = []
  for (const key of keys) {
    const entries = key === own.key ? own.entries : (reads.has(key) ? admittedEntries(reads.get(key), key, association, final) : null)
    if (entries === null) {
      missing.push(key)
      continue
    }
    const profile = latestProfile(entries)
    profiles.push({
      author: key,
      name: profile === null ? null : profile.name,
      bio: profile === null ? null : profile.bio,
      avatar: profile === null ? null : profile.avatar,
      username: latestUsername(entries, key, association, { revokedIssuers: final.revokedIssuers })
    })
  }
  return { profiles, missing }
}

// ---- groups ----
//
// The rules of @varanda/core lib/member.js group operations over the browser
// store: the fold is always @varanda/core lib/group.js buildGroup over the
// root, every local writer core of the group and the join evidence held
// locally (the own diary and the admitted replicas of the writers' authors;
// a blocked or skipped author binds nothing, so its writers leave the fold).
// This device's group cores (kv groupWriters) are keyed by a nonce: their
// key pairs come from ctx.groupKeyPair(nonce) (the session derives them from
// the passkey PRF, ./passkey.js groupKeyPairFromPrf; absent while locked).

const GROUP_NOT_FOUND = 'grupo não encontrado'
const GROUP_FORBIDDEN = 'sem permissão no grupo'
const GROUP_UNCHANGED = 'nada a alterar'
const GROUP_SEALED_MEDIA_PUBLIC = 'mídia cifrada só em grupo privado'
const GROUP_PRIVATE_MEDIA_SEALED = 'grupo privado exige mídia cifrada'
const GROUP_LEAVE_WAIT = 'aguarde a sincronização do grupo para sair'
const GROUP_LEAVE_CREATOR = 'saia pelo aparelho que criou o grupo'
const GROUP_ADMIT_WAIT = 'aguarde a sincronização do grupo para admitir'
const GROUP_NONCE_BYTES = 32

function groupKeyPairOf (ctx) {
  return typeof ctx.groupKeyPair === 'function' ? ctx.groupKeyPair : null
}

function needGroupKeys (ctx) {
  if (keyPairOf(ctx) === null || groupKeyPairOf(ctx) === null) throw new UsageError(store.LOCKED)
}

function groupKeyOf (group) {
  const key = String(group).toLowerCase()
  if (!HEX64.test(key)) throw new UsageError('chave inválida')
  return key
}

// A new own group core: a fresh random nonce and the key pair derived from it.
async function newOwnGroupCore (ctx) {
  const nonce = new Uint8Array(GROUP_NONCE_BYTES)
  globalThis.crypto.getRandomValues(nonce)
  const nonceHex = hex(nonce)
  const kp = await ctx.groupKeyPair(nonce)
  const core = await store.openGroupWriter(ctx.storage, kp)
  return { core, key: hex(kp.publicKey), nonce: nonceHex }
}

// The own core of a kv groupWriters entry, unlocked; the derived key must be
// the listed one.
async function openOwnGroupCore (ctx, entry) {
  const kp = await ctx.groupKeyPair(new Uint8Array(b4a.from(entry.nonce, 'hex')))
  if (!kp || !(kp.publicKey instanceof Uint8Array) || hex(kp.publicKey) !== entry.key) {
    throw new Error('núcleo de grupo de outra chave')
  }
  return store.openGroupWriter(ctx.storage, kp)
}

// Whether this device derives the key pair of a kv groupWriters entry from
// its nonce, as openOwnGroupCore requires. The kv store is local state that
// nothing signs, so a listed writer is reused for a signed join only when
// this check holds.
async function ownWriterDerived (ctx, entry) {
  if (entry === null || entry === undefined || typeof entry.nonce !== 'string' || typeof entry.key !== 'string') return false
  if (groupKeyPairOf(ctx) === null) return false
  try {
    const kp = await ctx.groupKeyPair(new Uint8Array(b4a.from(entry.nonce, 'hex')))
    return !!kp && kp.publicKey instanceof Uint8Array && hex(kp.publicKey) === entry.key
  } catch {
    return false
  }
}

async function appendToOwnGroupCore (ctx, entry, record, priv = false) {
  const core = await openOwnGroupCore(ctx, entry)
  try {
    return await store.appendGroupRecord(core, record, { root: entry.key === entry.group, community: entry.kind === 'community', private: priv, limits: ctx.limits })
  } finally {
    await core.close()
  }
}

// read(core) on the stored group core `key` -> its result, or null when none
// is stored (nothing is created). Borrowed path (ctx.cores.group, as
// withReplica): the run's own instance is read in place and never closed. A
// stored core the run does not lend (not opened by it, at rest, still
// gating) is NEEDS_EXCLUSIVE, and so is a fork during the read.
async function withGroupCore (ctx, key, read) {
  const cores = borrowedCores(ctx)
  if (cores !== null) {
    const core = typeof cores.group === 'function' ? cores.group(key) : null
    if (core !== null) {
      const fork = core.fork
      const value = await readBorrowed(core, read)
      if (core.fork !== fork) throw needsExclusive()
      return value
    }
    if (typeof key !== 'string' || !HEX64.test(key) || !(await store.groupCoreExists(ctx.storage, key))) return null
    throw needsExclusive()
  }
  const core = await store.openGroupCoreReadOnly(ctx.storage, key)
  if (core === null) return null
  try {
    return await read(core)
  } finally {
    await core.close()
  }
}

// The lengths are taken before the blocks: a borrowed core may grow during
// the read, and the entries never go past the contiguous length reported.
async function groupCoreState (core) {
  const length = core.contiguousLength
  const signed = core.length
  const fork = core.fork
  return { entries: (await store.readBlocks(core)).slice(0, length), length, signed, fork }
}

// A stored group core's entries (store.readBlocks: no diary deletion fold),
// read-only -> { entries, length, fork } or null.
async function readGroupCore (ctx, key) {
  return withGroupCore(ctx, key, groupCoreState)
}

// A stored writer core of `group` -> { entries, length, fork, header } or
// null. Block 0 is decoded first so the cores of other groups are never read
// in full: every operation on one group would otherwise decode every group
// core this device holds.
async function readWriterCoreOf (ctx, key, group) {
  return withGroupCore(ctx, key, async (core) => {
    if (core.contiguousLength === 0 || core.fork !== 0) return null
    let h = null
    try {
      h = decodeBlock(await core.get(0, { wait: false, raw: true }))
    } catch {}
    if (validateWriterHeader(h) !== null || h.group !== group) return null
    return groupCoreState(core)
  })
}

// Public and private groups fold; a community root never does as a group.
function foldableHeader (h) {
  return validateGroupHeader(h) === null && h.kind === 'group' && (h.visibility === 'public' || h.visibility === 'private')
}

// A stored root that will never fold (its block 0 is no public group
// header): its kv groupWriters entry may give up its slot.
async function rootUnfoldable (ctx, group) {
  const root = await readGroupCore(ctx, group)
  if (root === null || root.length === 0) return false
  return root.fork !== 0 || !foldableHeader(root.entries[0].record)
}

// The writers the fold counts for diary d from its join history alone: the
// MAX_GROUP_WRITERS_PER_DIARY earliest bound by an on:true join (the bound
// root is one of its creator's), as @varanda/core lib/group.js capPerDiary.
function joinedCounted (history, d, rootDiary, group) {
  const first = new Map()
  for (const j of history || []) {
    if (j.on !== true || typeof j.writer !== 'string') continue
    const seq = Number.isSafeInteger(j.seq) ? j.seq : Infinity
    if (!first.has(j.writer) || seq < first.get(j.writer)) first.set(j.writer, seq)
  }
  const rootBound = d === rootDiary && first.has(group)
  const rest = [...first].filter(([w]) => w !== group)
    .sort((x, y) => (x[1] - y[1]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .slice(0, MAX_GROUP_WRITERS_PER_DIARY - (rootBound ? 1 : 0))
    .map(([w]) => w)
  return rootBound ? [group, ...rest] : rest
}

// Whether diary d binds a writer the fold would count that is not HELD
// here (any stored core of d, counted by the fold or not, as the core node):
// only a sync can bring it. A held writer the fold drops (over the group
// cap, an unresolved rejoin) never makes an admit wait for ever.
function missingWriters (g, d, history) {
  const held = new Set()
  for (const [key, c] of g.cores) if (c.diary === d) held.add(key)
  // In a private group a writer whose latest join is off was unbound by its
  // device (a boxless writer replaced on rejoin): seeders refuse it, so it
  // can never be held, and the fold never counts it without a box.
  const off = new Set()
  if (g.private) {
    const latest = new Map()
    for (const j of history || []) latest.set(j.writer, j.on === true)
    for (const [w, on] of latest) if (!on) off.add(w)
  }
  return joinedCounted(history, d, g.cores.get(g.group).diary, g.group).some((w) => !held.has(w) && !off.has(w))
}

function hasLeave (entries) {
  return entries.some(({ seq, record }) => seq >= 1 && record !== null && typeof record === 'object' && record.type === 'group-leave')
}

// An own writer still writes for the device until it holds a group-leave.
async function ownCoreLeft (ctx, key) {
  const core = await readGroupCore(ctx, key)
  return core === null || core.length === 0 || hasLeave(core.entries)
}

// The fold reports the own diary as left, a leave from another device of
// the diary included. A group that does not load is not known to be left.
async function foldSaysLeft (ctx, base, group) {
  const g = await loadGroup(ctx, base, group)
  return g !== null && statusOf(g, base.ownHex) === 'left'
}

// Room in kv groupWriters for `group` and every key of `more` not listed
// yet (null: a new core): at most MAX_GROUPS_PER_DIARY entries that still
// write ('limite de grupos atingido'); a full list gives up its oldest left
// entries, whose cores stay readable as replicas. An entry is left when its
// own core holds a leave or the fold says the diary left; folds are only
// read for a full list.
async function makeGroupRoom (ctx, base, group, more = []) {
  const entries = await store.readGroupWriters(ctx.storage)
  const need = [group, ...more].filter((key) => key === null || !entries.some((e) => e.group === key)).length
  if (entries.length + need <= MAX_GROUPS_PER_DIARY) return
  const left = []
  for (const e of entries) {
    if (e.kind === 'community') {
      if (await ownCoreLeft(ctx, e.key) || await communityUnfoldable(ctx, e.group) || await communitySaysLeft(ctx, base, e.group)) left.push(e)
      continue
    }
    if (await ownCoreLeft(ctx, e.key) || await rootUnfoldable(ctx, e.group) || await foldSaysLeft(ctx, base, e.group)) left.push(e)
  }
  // A group or community this device created is never evicted: its entry
  // holds the only copy of the root nonce, and the root cannot be written
  // without it.
  const victims = left.filter((e) => e.rootNonce === null)
  const over = entries.length + need - MAX_GROUPS_PER_DIARY
  if (victims.length < over) throw new UsageError(store.GROUPS_FULL)
  for (const victim of victims.slice(0, over)) {
    await store.addGroupReplica(ctx.storage, victim.key)
    await store.removeGroupWriter(ctx.storage, victim.group)
  }
}

// The fold of `group` from local data, or null when its root is not held.
async function loadGroup (ctx, base, group) {
  const { ownHex, ownEntries, association, mod } = base
  // A group block in the stored snapshot names the root key: the group reads
  // as unknown to every operation, its local cores stay where they are.
  if (mod.blocked.has(group)) return null
  const root = await readGroupCore(ctx, group)
  if (root === null || root.length === 0 || root.fork !== 0) return null
  const rootHeader = root.entries[0].record
  if (!foldableHeader(rootHeader)) return null
  const own = (await store.readGroupWriters(ctx.storage)).find((e) => e.group === group) || null
  const keys = new Set(await store.readGroupReplicas(ctx.storage))
  if (own !== null) keys.add(own.key)
  keys.delete(group)
  const writers = []
  const cores = new Map([[group, { diary: rootHeader.diary, at: rootHeader.at, length: root.length, signed: root.signed, entries: root.entries }]])
  for (const key of [...keys].sort()) {
    const core = await readWriterCoreOf(ctx, key, group)
    if (core === null) continue
    const h = core.entries[0].record
    if (validateWriterHeader(h) !== null || h.group !== group) continue
    writers.push({ key, entries: core.entries, diary: h.diary })
    cores.set(key, { diary: h.diary, at: h.at, length: core.length, signed: core.signed, entries: core.entries })
  }
  const diaries = new Map()
  const joins = new Map()
  // The diaries' group-cut marks for this group (the creator's end its
  // root's authority).
  const marks = new Map()
  // The diaries' group-confirm records: only a leave its diary confirmed
  // ends a device's powers by diary-backed evidence.
  const confirms = new Map()
  // Only the diaries that can bind a core of this group: the own diary, the
  // creator's and the authors of the writers held (followed or stored for
  // the group, kv groupDiaries). Reading every follow would decode diaries
  // that bind nothing here on each group operation.
  for (const d of new Set([ownHex, rootHeader.diary, ...writers.map((w) => w.diary)])) {
    // A blocked own diary binds none of its writers, as in the core node (the
    // feed keeps its own rule for the own diary).
    const entries = d === ownHex ? (mod.blocked.has(ownHex) ? null : ownEntries) : admittedEntries(await replicaRead(ctx, d, mod), d, association, mod)
    diaries.set(d, entries)
    if (entries !== null) {
      joins.set(d, groupJoinHistory(entries, group))
      marks.set(d, groupCutHistory(entries, group))
      confirms.set(d, groupConfirmHistory(entries, group))
    }
  }
  // The parent community named by the immutable header, as buildCommunity
  // takes it (a blocked or unheld parent is null: the fold reads incomplete).
  const community = rootHeader.community
  const c = isHex64(community) ? await loadCommunity(ctx, base, community) : null
  const input = { root: { key: group, entries: root.entries }, writers, joins, marks, confirms, community: c === null ? null : c.input }
  const priv = rootHeader.visibility === 'private'
  const mine = priv ? mineOf(group, rootHeader, writers, ownHex, boxHexOf(ctx)) : new Set()
  const epochs = []
  const built = foldWithKeys(ctx, input, mine, null, epochs)
  return { group, own, built, cores, diaries, joins, input, mine, private: priv, epochs, community, c }
}

// The writer cores the fold counts for diary `d`: its own header names d and
// d ever joined it on (a later join off is an index hint, buildGroup keeps
// the writer's records). Cuts must cover all of them: an unlisted writer is
// cut from seq 0, which would undo its earlier moderation.
function boundWriters (g, d) {
  const history = g.joins.get(d) || []
  const out = []
  for (const [key, c] of g.cores) {
    if (c.diary === d && history.some((j) => j.writer === key && j.on === true)) out.push(key)
  }
  return out.sort()
}

// The acting admin's view of the target's writers: at most MAX_GROUP_CUTS,
// lowest keys first, each at its local contiguous length.
// Only writers the fold counted: a rejected one listed first would push a
// counted writer out of the 16 cuts, which then reads as cut from seq 0.
// grant = true (an on:true admit or admin, or an unban, whose restrictive
// side is the higher cut): records the writer already
// signed but this device has not downloaded exist before the event, so they
// must stay below the cut; protecting the group from a member whose earlier,
// unseen records would otherwise gain admission or authority. Every other
// event keeps the contiguous length.
function cutSeq (c, grant) {
  return grant ? Math.max(c.length, c.signed || 0) : c.length
}

function cutsFor (g, d, grant = false) {
  return boundWriters(g, d).filter((writer) => g.built.writers.has(writer)).slice(0, MAX_GROUP_CUTS)
    .map((writer) => ({ writer, seq: cutSeq(g.cores.get(writer), grant) }))
}

// The writers of diary d the fold counts (the creator's bound root
// included), each at its local length: a leave or a grant listing them
// covers exactly what this device saw of them.
function countedCuts (g, d, grant = false) {
  const out = []
  for (const writer of g.built.writers) {
    const c = g.cores.get(writer)
    if (c !== undefined && c.diary === d) out.push(writer)
  }
  return out.sort().map((writer) => ({ writer, seq: cutSeq(g.cores.get(writer), grant) }))
}

function statusOf (g, d) {
  const st = g.built.members.get(d)
  return st === undefined ? null : st
}

// A diary the fold does not list (never joined, or every writer dropped)
// answers 'left', as in the core node: never a null role or state.
function stateOf (g, d) {
  const st = statusOf(g, d)
  return st === null ? 'left' : st
}

function roleOf (g, d) {
  const st = stateOf(g, d)
  if (st !== 'member') return st
  if (d === g.built.creator) return 'creator'
  return g.built.admins.has(d) ? 'admin' : 'member'
}

// A diary-bound root this device holds no writer for, while the fold still
// says the diary is absent or left: the account's writer cores are not
// stored yet. 'banned' and 'requested' are real answers and stay. Answering
// 'left' would offer a newcomer join.
// A leave the fold has seen (lastLeave) is a real leave, written on some
// device of the diary: it stays 'left'. A diary blocked by moderation is not
// arriving either.
function writersStillArriving (fold, ownHex, mod) {
  if (fold.own !== null) return false
  if (mod.blocked.has(ownHex)) return false
  const st = statusOf(fold, ownHex)
  if (st === 'left' && fold.built.lastLeave instanceof Map && fold.built.lastLeave.has(ownHex)) return false
  return st === null || st === 'left'
}

// `keys`: diaryGroupKeys(base.ownEntries) when the caller already has it
// (it reads the whole own diary, once per call rather than once per row).
function roleHere (fold, ownHex, base, keys = null) {
  if (!writersStillArriving(fold, ownHex, base.mod)) return roleOf(fold, ownHex)
  if (!(keys === null ? diaryGroupKeys(base.ownEntries) : keys).includes(fold.group)) return roleOf(fold, ownHex)
  return 'pending'
}

// How many writers the own diary ever bound in this root (on:true joins):
// the seeder never releases those slots, a later leave included.
function diaryBound (fold, ownHex) {
  const history = fold.joins.get(ownHex) || []
  return new Set(history.filter((j) => j.on === true).map((j) => j.writer)).size
}

function isActingAdmin (g, d) {
  return statusOf(g, d) === 'member' && g.built.admins.has(d)
}

// The leave a new writer of diary d names in its `rejoin`: the causally
// latest counted leave of d in fold g (`lastLeave`, kept after a rejoin by
// another device), or null when d never left. A writer bound after a leave
// without naming it is cut by that leave.
function latestLeaveOf (g, d) {
  const map = g.built.lastLeave
  const ref = map instanceof Map ? map.get(d) : undefined
  return ref ? { writer: ref.writer, seq: ref.seq } : null
}

// The leave a new CW of a rejoin names: this device's own counted leave
// (`leaveOf`); else, when its CW is bound, counted and holds no leave, one
// it writes (and the diary confirms) there first; else the first leave the
// diary confirmed; else the diary's latest leave. A device that comes
// back so never takes a leave a stolen sibling appended as the boundary of
// its history. A failure after the extra leave surfaces like any other
// write of the join.
async function ownRejoinLeave (ctx, base, diary, c, ownHex) {
  const leaveOfIn = (g) => g.built.leaveOf instanceof Map ? g.built.leaveOf : new Map()
  // Only a leave of the diary's latest set: an older one would make the new
  // CW a past generation.
  const current = (g, w) => {
    const sets = g.built.leaveSetOf instanceof Map ? g.built.leaveSetOf : new Map()
    const last = latestLeaveOf(g, ownHex)
    return last !== null && sets.has(w) && sets.get(w) === sets.get(last.writer)
  }
  const own = c.own
  const ref = (r) => ({ writer: r.writer, seq: r.seq })
  if (own !== null && leaveOfIn(c).has(own.key) && current(c, own.key)) return { c, rejoin: ref(leaveOfIn(c).get(own.key)) }
  const core = own === null || own.key === c.key ? undefined : c.cores.get(own.key)
  if (core !== undefined && !hasLeave(core.entries) && boundWriters(c, ownHex).includes(own.key) && c.built.writers.has(own.key)) {
    // Every counted own CW held here, as any leave of the diary: the fold
    // withdraws an unlisted one from seq 0. Never C's root: a creator back
    // after a forged leave keeps its powers (cycle 14).
    const cuts = countedCuts(c, ownHex).filter((x) => x.writer !== c.key)
    const record = buildRecord(() => grp.groupLeave({ seen: latestLeaveOf(c, ownHex), cuts }))
    const seq = await appendToOwnGroupCore(ctx, own, record)
    // The diary confirms it, as for any honest leave.
    await confirmLeave(ctx, diary, c.key, own.key, seq, record)
    await appendOwn(ctx, diary, groupJoinRecord({ group: c.key, writer: own.key, on: false }))
    base = { ...base, ownEntries: await store.readAll(diary) }
    c = await loadCommunity(ctx, base, c.key)
    const mine = leaveOfIn(c).get(own.key)
    if (mine && current(c, own.key)) return { c, rejoin: ref(mine) }
  }
  // A new device: the first leave of the latest set this diary confirmed
  // (turned its writer off), never a later one a stolen device forged.
  const confirmed = c.built.confirmedLeaveOf instanceof Map ? c.built.confirmedLeaveOf.get(ownHex) : undefined
  if (confirmed) return { c, rejoin: ref(confirmed) }
  return { c, rejoin: latestLeaveOf(c, ownHex) }
}

// Whether this device's writer in g, bound and holding no leave of its own,
// may be kept for a diary the fold does not count as a member yet (a join
// cut short, or a request): a writer the fold retired while the diary is a
// member never is.
function ownPending (g, ownHex) {
  if (g.own === null) return false
  const c = g.cores.get(g.own.key)
  if (c === undefined || hasLeave(c.entries)) return false
  return !boundWriters(g, ownHex).includes(g.own.key) || statusOf(g, ownHex) === 'requested'
}

// The own writer of this device when the fold says a new record on it
// would count (`liveWriters`: counted, not retired by any leave of the
// diary, the diary a member and, in a group, not banned and its community
// writer live in the parent), else null.
function liveOwnWriter (g, ownHex) {
  if (g.own === null || !(g.built.liveWriters instanceof Set)) return null
  // A group root its creator's diary marked is never this device's writer
  // again: a returning creator joins through a new writer.
  if (g.own.key === g.group && g.built.rootCut !== null && g.built.rootCut !== undefined) return null
  if (g.built.liveWriters.has(g.own.key)) return g.own
  // A bound member writer the fold does not count (beyond the writer cap)
  // is returned, so requireCounted names the cap instead of a permission.
  const c = g.cores.get(g.own.key)
  if (c !== undefined && !g.built.writers.has(g.own.key) && !hasLeave(c.entries) && statusOf(g, ownHex) === 'member' &&
      boundWriters(g, ownHex).includes(g.own.key)) return g.own
  return null
}

// A writer the fold did not count (beyond the writer cap) still looks live
// when another writer keeps the diary a member, but anything it writes is
// discarded by the fold.
function requireCounted (g, key) {
  if (!g.built.writers.has(key)) throw new UsageError(store.GROUP_FULL)
}

// A record from this device counts only for a member whose live writer the
// fold counted. liveOwnWriter also returns a bound writer past the cap, so
// the write can name the cap; requireCounted then refuses it, and so does this.
function countedLive (fold, ownHex) {
  if (statusOf(fold, ownHex) !== 'member') return false
  const own = liveOwnWriter(fold, ownHex)
  return own !== null && fold.built.writers.has(own.key)
}

// sealForGroup's 'aguardando nova chave', without calling it. The lock
// refusal is a different error. A public group never seals.
function rekeyBlocksWrite (ctx, g) {
  if (!g.private || boxHexOf(ctx) === null) return false
  if (g.built.rekeyPending || g.built.epoch === null) return true
  const h = holderOf(ctx)
  const epoch = g.built.epoch
  const opened = h !== null && g.epochs.some((e) => e.kid.writer === epoch.writer && e.kid.seq === epoch.seq)
  return !opened || h.has(epoch) !== true
}

function groupCanWrite (ctx, g, ownHex) {
  // Mirrors requireParent: a post fails while the parent community root is not
  // held or folded here.
  return countedLive(g, ownHex) && g.built.orphan !== true && g.built.community !== null && g.c !== null && !rekeyBlocksWrite(ctx, g)
}

function authorOf (g, d, association, mod) {
  const entries = g.diaries.get(d)
  if (!entries) return { name: null, username: null }
  const profile = latestProfile(entries)
  return {
    name: profile === null ? null : profile.name,
    username: latestUsername(entries, d, association, { revokedIssuers: mod.revokedIssuers })
  }
}

// A join by key records the group before any sync fetched its root. Until
// the root arrives the group is pending -> { group, own } (own: the kv
// groupWriters entry, or null), or null when the root is held or the group
// is blocked.
async function pendingOf (ctx, mod, group) {
  if (mod.blocked.has(group)) return null
  const root = await readGroupCore(ctx, group)
  if (root !== null && root.length > 0) return null
  return { group, own: (await store.readGroupWriters(ctx.storage)).find((e) => e.group === group) || null }
}

function requirePendingOwn ({ own }) {
  if (own === null) throw new Error(GROUP_NOT_FOUND)
  return own
}

const PENDING_INFO = { name: null, join: null, role: 'pending', members: 0 }

// Writes in a group need its parent folded and holding it: an orphan
// (the header names a community whose catalogue does not hold the group)
// refuses for ever, a parent not held yet until a sync brings it.
function requireParent (g) {
  if (g.built.orphan) throw new UsageError(GROUP_ORPHAN)
  if (g.built.community === null || g.c === null) throw new UsageError(COMMUNITY_WAIT)
}

// Opens the own diary and folds `group`: write = true needs the unlocked
// identity, the group key derivation and block 0, and (`guard`) the parent
// community (requireParent). A pending group goes to `pending` when given,
// and is NOT_FOUND otherwise.
async function withGroup (ctx, group, write, fn, pending = null, guard = write) {
  if (write) needGroupKeys(ctx)
  const key = groupKeyOf(group)
  const association = await trustRoot(ctx)
  const mod = await moderation(ctx.storage, association)
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (write && diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const base = { ownHex, ownEntries: await store.readAll(diary), association, mod }
    const g = await loadGroup(ctx, base, key)
    if (g === null) {
      const p = pending === null ? null : await pendingOf(ctx, mod, key)
      if (p === null) throw new Error(GROUP_NOT_FOUND)
      return pending(p, { diary, ownHex, base })
    }
    if (guard) requireParent(g)
    return fn({ diary, ownHex, base, g })
  })
}

async function refold (ctx, diary, base, group) {
  return loadGroup(ctx, { ...base, ownEntries: await store.readAll(diary) }, group)
}

// A writer beyond the writer cap is not counted, so the fold may hold no
// state for the diary at all: that is never reported as 'member'.
function joinState (g, ownHex, writer) {
  const st = statusOf(g, ownHex)
  if (st === 'requested' || st === 'left') return st
  if (!g.built.writers.has(writer)) throw new UsageError(store.GROUP_FULL)
  return 'member'
}

// The cap keeps MAX_GROUP_WRITERS - 1 writers besides the root.
function groupWritersFull (g) {
  let n = 0
  for (const key of g.built.writers) if (key !== g.group) n++
  return n >= grp.MAX_GROUP_WRITERS - 1
}

// -> { group }: a new group inside `community` whose root is a new own
// core; the own diary binds it at once (writer === group), then the own
// community writer records the group-create that puts it in the catalogue
// (a failure in between leaves an orphan root nobody lists). A private root
// holds the header (name null, this device's box), the first epoch sealed to
// that box and the name in a sealed group-meta; the epoch key stays in the
// holder only.
async function groupCreate (ctx, { name, join, visibility = 'public', community }) {
  needGroupKeys(ctx)
  const priv = visibility === 'private'
  const boxHex = priv ? needBox(ctx) : null
  const h = priv ? holderOf(ctx) : null
  const tok = priv ? h.token() : null
  const C = communityKeyOf(community)
  const association = await trustRoot(ctx)
  const mod = await moderation(ctx.storage, association)
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const base = { ownHex, ownEntries: await store.readAll(diary), association, mod }
    const { c, root, member } = await communityForCreate(ctx, base, C)
    const header = buildRecord(() => grp.groupHeader({
      kind: 'group',
      diary: ownHex,
      community: C,
      member,
      visibility: priv ? 'private' : 'public',
      join: priv ? 'approval' : join,
      name: priv ? null : name,
      box: boxHex
    }))
    // Checked before anything is written: a bad name must not leave a root.
    if (priv) buildRecord(() => grp.groupMeta({ name, join: 'approval', seen: null }))
    await makeGroupRoom(ctx, base, null)
    const { core, key, nonce } = await newOwnGroupCore(ctx)
    const epochKey = priv ? gc.newEpochKey() : null
    try {
      await store.appendGroupRecord(core, header, { root: true, private: priv, limits: ctx.limits })
      if (priv) {
        const kid = { writer: key, seq: core.length }
        const sealed = b4a.toString(gc.sealEpochKey(epochKey, key, kid, b4a.from(boxHex, 'hex')), 'base64')
        await store.appendGroupRecord(core, buildRecord(() => grp.groupKey({ kid: null, basis: [], keys: [{ writer: key, sealed }], commit: hex(gc.keyCommit(epochKey, key, kid)) })), { root: true, private: true, limits: ctx.limits })
        const meta = buildRecord(() => grp.groupMeta({ name, join: 'approval', seen: kid }))
        const { nonce: n, box } = gc.sealRecord(grp.sealedInner(meta, { writer: key, group: key, kid }), epochKey)
        await store.appendGroupRecord(core, buildRecord(() => grp.groupSealed({ kid, nonce: n, box, at: meta.at })), { root: true, private: true, limits: ctx.limits })
        h.put(tok, kid, epochKey)
      }
    } finally {
      if (epochKey !== null) gc.wipe(epochKey)
      await core.close()
    }
    await store.putGroupWriter(ctx.storage, { group: key, key, nonce, rootNonce: nonce })
    await appendOwn(ctx, diary, groupJoinRecord({ group: key, writer: key, on: true }))
    await appendToOwnGroupCore(ctx, root, buildRecord(() => grp.groupCreateRecord({ group: key, seen: c.built.last })))
    return { group: key }
  })
}

// The checks that need the fold (ban, membership, rejoin) wait for the
// root: kv groupReplicas makes the next sync fetch it, and the fold then
// decides the state.
// `member`: the own live community writer a group writer names; a
// community writer (`community: true`) names none.
async function pendingJoin (ctx, { group, own }, { diary, ownHex, base }, { member = null, community = false } = {}) {
  const core = own === null ? null : await readGroupCore(ctx, own.key)
  // A listed writer the diary has not bound yet is reused (and named by a
  // new join below) only when this device derives it.
  const ownBound = core !== null && groupJoinHistory(base.ownEntries, group).some((j) => j.on && j.writer === own.key)
  const written = core !== null && core.length > 0 && (ownBound || await ownWriterDerived(ctx, own))
  if (written && hasLeave(core.entries)) throw new UsageError('o grupo ainda não chegou: entre de novo depois da sincronização')
  let writer = written ? own.key : null
  // A reused CW's first on-join signs its header's rejoin, as communityJoin
  // does: without it the fold takes the CW as generation 0.
  const rejoin = written && community ? headerRejoin(core) : null
  if (writer === null) {
    const bound = new Set(groupJoinHistory(base.ownEntries, group).filter((j) => j.on).map((j) => j.writer))
    if (bound.size >= MAX_GROUP_WRITERS_PER_DIARY) throw new UsageError(store.GROUP_FULL)
    await makeGroupRoom(ctx, base, group)
    const record = buildRecord(() => grp.writerHeader({ group, diary: ownHex, member, rejoin: null }))
    const created = await newOwnGroupCore(ctx)
    try {
      await store.appendGroupRecord(created.core, record, { root: false, community, limits: ctx.limits })
    } finally {
      await created.core.close()
    }
    await store.putGroupWriter(ctx.storage, { group, key: created.key, nonce: created.nonce, rootNonce: null, ...(community ? { kind: 'community' } : {}) })
    writer = created.key
  }
  await store.addGroupReplica(ctx.storage, group)
  const joins = groupJoinHistory(base.ownEntries, group)
  if (!joins.some((j) => j.writer === writer && j.on)) await appendOwn(ctx, diary, groupJoinRecord({ group, writer, on: true, ...(rejoin ? { rejoin } : {}) }))
  return { state: 'pending' }
}

// -> { state: 'member' | 'requested' | 'left' | 'pending' }. The caller
// needs a live writer in the group's community (status 'member' there);
// `community` is the hint a pending root needs. Idempotent while this
// device's writer still writes; a writer that left is followed by a new one
// naming the diary's latest leave (rejoin).
async function groupJoin (ctx, { group, community = null }) {
  const hint = community === null || community === undefined ? null : communityKeyOf(community)
  return withGroup(ctx, group, true, async (ids) => {
    const { ownHex, g } = ids
    if (hint !== null && hint !== g.community) throw new UsageError(GROUP_OTHER_COMMUNITY)
    requireParent(g)
    const cw = liveOwnWriter(g.c, ownHex)
    if (cw === null || statusOf(g.c, ownHex) !== 'member') throw new UsageError(COMMUNITY_FIRST)
    return joinLoaded(ctx, ids, cw.key)
  }, async (p, ids) => {
    const core = p.own === null ? null : await readGroupCore(ctx, p.own.key)
    // A writer already written answers again without a new one.
    if (core !== null && core.length > 0) return pendingJoin(ctx, p, ids)
    if (hint === null) throw new UsageError(GROUP_COMMUNITY_NEEDED)
    if (ids.base.mod.blocked.has(hint)) throw new Error(COMMUNITY_NOT_FOUND)
    const c = await loadCommunity(ctx, ids.base, hint)
    if (c === null) throw new UsageError(COMMUNITY_WAIT)
    const cw = liveOwnWriter(c, ids.ownHex)
    if (cw === null || statusOf(c, ids.ownHex) !== 'member') throw new UsageError(COMMUNITY_FIRST)
    return pendingJoin(ctx, p, ids, { member: cw.key })
  }, false)
}

// The join of a loaded group through a new or listed own writer whose
// header names `member` (the own community writer).
async function joinLoaded (ctx, { diary, ownHex, base, g }, member) {
  // bans, not members: a diary banned before it had a writer is not listed.
  if (g.built.bans.has(ownHex)) throw new UsageError(GROUP_FORBIDDEN)
  // A blocked own diary binds none of its writers in the fold.
  if (g.diaries.get(ownHex) === null) throw new UsageError(GROUP_FORBIDDEN)
  // In a private group a writer whose header box is not this device's
  // (null from a join before the root arrived, or another key) never
  // counts: it stays retired and a boxed writer takes its place.
  const box = g.private ? needBox(ctx) : null
  const usable = (key) => !g.private || boxOfWriter(g, key) === box
  const live = liveOwnWriter(g, ownHex)
  if (live !== null && usable(live.key)) return { state: joinState(g, ownHex, live.key) }
  // As the core node: the unusable own writer's binding goes first, so
  // nobody waits for a core that seeders refuse.
  let unbound = null
  if (g.private && g.own !== null && g.own.key !== g.group && !usable(g.own.key)) {
    const last = groupJoinHistory(base.ownEntries, g.group).filter((j) => j.writer === g.own.key).pop()
    if (last !== undefined && last.on) await appendOwn(ctx, diary, groupJoinRecord({ group: g.group, writer: g.own.key, on: false }))
    unbound = g.own.key
  }
  // Listed and still writing but not bound (a join cut short): bind it.
  const current = g.own === null ? undefined : g.cores.get(g.own.key)
  const left = statusOf(g, ownHex) === 'left'
  // A listed writer naming another community writer than the live one
  // would not count: a new writer takes its place.
  const sameMember = current !== undefined && (g.own.key === g.group || current.entries[0].record.member === member)
  let writer = !left && sameMember && ownPending(g, ownHex) && usable(g.own.key) && await ownWriterDerived(ctx, g.own) ? g.own.key : null
  if (writer === null) {
    if (groupWritersFull(g)) throw new UsageError(store.GROUP_FULL)
    // The fold counts at most MAX_GROUP_WRITERS_PER_DIARY writers per diary
    // (the earliest bound): a new one would never count.
    if (boundWriters(g, ownHex).filter((w) => w !== unbound).length >= MAX_GROUP_WRITERS_PER_DIARY) {
      throw new UsageError(live !== null ? GROUP_BOXLESS_FULL : store.GROUP_FULL)
    }
    await makeGroupRoom(ctx, base, g.group)
    // The causal latest leave, never the newest timestamp.
    const rejoin = latestLeaveOf(g, ownHex)
    const record = buildRecord(() => grp.writerHeader({ group: g.group, diary: ownHex, member, rejoin, box }))
    const { core, key, nonce } = await newOwnGroupCore(ctx)
    try {
      await store.appendGroupRecord(core, record, { root: false, limits: ctx.limits })
    } finally {
      await core.close()
    }
    if (g.own !== null) await store.addGroupReplica(ctx.storage, g.own.key)
    await store.putGroupWriter(ctx.storage, { group: g.group, key, nonce, rootNonce: g.own === null ? null : g.own.rootNonce })
    writer = key
  }
  await appendOwn(ctx, diary, groupJoinRecord({ group: g.group, writer, on: true }))
  return { state: joinState(await refold(ctx, diary, base, g.group), ownHex, writer) }
}

// -> { state: 'left' }: a group-leave in this device's writer, then the
// diary's join off (an index hint only). No local core is deleted.
async function groupLeave (ctx, { group }) {
  return withGroup(ctx, group, true, async ({ diary, ownHex, g }) => {
    // A ban outlives any leave in the fold (status 'banned' wins over
    // 'left'), so a banned leave would report a state that never takes
    // effect. The fold applies a leave whatever the ban layer says of the
    // writers, so a ban that lingers for a writer an unban missed must not
    // lock the member in.
    if (statusOf(g, ownHex) === 'banned') throw new UsageError(GROUP_FORBIDDEN)
    // Already left in the fold, through any device: nothing to write.
    if (statusOf(g, ownHex) === 'left') return { state: 'left' }
    // The fold applies a leave whatever the writer ban layer says, so a
    // counted, bound own writer without a leave that a lingering ban keeps
    // out of liveWriters leaves too.
    let own = liveOwnWriter(g, ownHex)
    if (own === null && g.own !== null && g.built.writers.has(g.own.key) && !hasLeave(g.cores.get(g.own.key).entries) &&
        boundWriters(g, ownHex).includes(g.own.key)) own = g.own
    if (own === null) throw new UsageError(GROUP_UNCHANGED)
    requireCounted(g, own.key)
    // seen orders the leave after everything this device folded, a rejoin of
    // another device of the diary included.
    // Every counted writer of the own diary is listed (retired ones and the
    // creator's root included): the fold withdraws an unlisted one from seq 0.
    const cuts = countedCuts(g, ownHex)
    // The fold withdraws the leaving diary's records on its other writers
    // anyway, so anyone leaves at once. The creator's bound root keeps the
    // cut rule: the leave must list it, or the group's charter would be
    // withdrawn from seq 0. Any device holding the root lists it (its key is
    // not needed), so a creator whose first device was lost still leaves.
    const root = g.cores.get(g.group)
    if (root.diary === ownHex && g.built.writers.has(g.group) && !cuts.some((c) => c.writer === g.group)) {
      throw new UsageError(GROUP_LEAVE_CREATOR)
    }
    await appendToOwnGroupCore(ctx, own, buildRecord(() => grp.groupLeave({ seen: g.built.last, cuts })), g.private)
    await appendOwn(ctx, diary, groupJoinRecord({ group: g.group, writer: own.key, on: false }))
    return { state: 'left' }
  }, async (p, { diary, base }) => {
    const own = requirePendingOwn(p)
    const core = await readGroupCore(ctx, own.key)
    if (core === null || core.length === 0 || hasLeave(core.entries)) throw new UsageError(GROUP_UNCHANGED)
    // No fold yet, so the leave can list only this device's writer: any
    // other writer the own diary binds (another device, the creator's root)
    // would be withdrawn from seq 0 with its posts and moderation.
    const others = groupJoinHistory(base.ownEntries, p.group).some((j) => j.on && j.writer !== own.key)
    if (others) throw new UsageError(GROUP_LEAVE_WAIT)
    const cuts = [{ writer: own.key, seq: core.length }]
    await appendToOwnGroupCore(ctx, own, buildRecord(() => grp.groupLeave({ seen: null, cuts })))
    await appendOwn(ctx, diary, groupJoinRecord({ group: p.group, writer: own.key, on: false }))
    return { state: 'left' }
  }, false)
}

// -> { seq }. `seen` is the newest record of the local causal order.
// `media` (optional) points into this device's declared media cores, as
// post.create's descriptors: private items (sealed, mediaUpload with
// sealed: true) in a private group, public descriptors in a public one. The
// upload is a separate earlier call, so a post that fails here leaves its
// blocks orphaned in the media core; nothing is retried.
async function groupPost (ctx, { group, text, replyTo = null, media = null, card = null, fwd = 0, sealed = false }) {
  const withMedia = media !== null && media !== undefined
  // Checked before withGroup, which holds the diary open.
  if (withMedia) {
    // A voice note is the only item of its post, never next to photos.
    if (Array.isArray(media) && media.length !== 1 && media.some(isVoiceItem)) throw badMedia()
    await verifyMedia(ctx, media, null, sealed === true ? validPrivateItem : (d) => validateDescriptor(d) === null || validAudioDescriptor(d))
  }
  if (card && card.image !== null) await verifyMedia(ctx, [card.image], null, sealed === true ? validPrivateItem : (d) => validateDescriptor(d) === null)
  return withGroup(ctx, group, true, async ({ ownHex, g }) => {
    if (sealed === true && !g.private) throw new UsageError(GROUP_SEALED_MEDIA_PUBLIC)
    if ((withMedia || (card && card.image !== null)) && sealed !== true && g.private) throw new UsageError(GROUP_PRIVATE_MEDIA_SEALED)
    const own = liveOwnWriter(g, ownHex)
    if (own === null || statusOf(g, ownHex) !== 'member') throw new UsageError(GROUP_FORBIDDEN)
    requireCounted(g, own.key)
    let record = buildRecord(() => grp.groupPost({ text, replyTo, fwd, card, media: withMedia ? media : null, seen: g.built.last, sealed: g.private }))
    if (g.private) record = sealForGroup(ctx, g, own.key, record)
    return { seq: await appendToOwnGroupCore(ctx, own, record, g.private) }
  })
}

// The own live community writer when a record at its next position would
// act with authority in community fold c (`authorityWriters`: C's creator on
// the bound root, or the admin layer on there with the ban off), else null.
function communityAuthority (c, ownHex) {
  if (c === null) return null
  const cw = liveOwnWriter(c, ownHex)
  return cw !== null && c.built.authorityWriters instanceof Set && c.built.authorityWriters.has(cw.key) ? cw : null
}

// The same in the community holding group g, while the gate is on.
function communityPower (g, ownHex) {
  return g.built.community === null || g.c === null ? null : communityAuthority(g.c, ownHex)
}

// Where this device writes a moderation of g: { own } when the fold gives
// its live G writer authority at the next position (`authorityWriters`: the
// group's creator or its root admin layer), else { cw } (its community
// writer, records naming G) when the parent gives that CW authority; null
// otherwise.
function moderatorOf (g, ownHex) {
  const own = liveOwnWriter(g, ownHex)
  // An uncounted own writer goes on to requireCounted (the cap's message).
  if (own !== null && !g.built.writers.has(own.key)) return { own }
  if (own !== null && g.built.authorityWriters instanceof Set && g.built.authorityWriters.has(own.key)) return { own }
  const cw = communityPower(g, ownHex)
  return cw !== null ? { cw } : null
}

// A moderation record, checked against the local fold first, in this
// device's writer or community writer (moderatorOf); make(g, ownHex,
// viaCommunity) builds it.
async function groupModerate (ctx, group, make, keyChange = null) {
  return withGroup(ctx, group, true, async ({ ownHex, base, g }) => {
    const by = moderatorOf(g, ownHex)
    if (by === null) throw new UsageError(GROUP_FORBIDDEN)
    if (g.private) needBox(ctx)
    const record = make(g, ownHex, by.cw !== undefined)
    if (by.cw !== undefined) {
      await appendToOwnGroupCore(ctx, by.cw, record)
    } else {
      requireCounted(g, by.own.key)
      await appendToOwnGroupCore(ctx, by.own, record, g.private)
    }
    if (g.private && keyChange !== null) await afterKeyChange(ctx, base, g.group, ownHex, keyChange(record))
    return { ok: true }
  })
}

// History on admit after an on: true grant, a rotation after a withdrawal.
function grantKeyChange (record) {
  return record.on === true ? { history: true } : { rotate: true }
}

// The author keeps the right to hide their own posts after leaving: the
// fold takes an author hide from any bound writer of the author's diary, so
// it goes to this device's bound writer even when that writer has left.
// Hiding anyone else's post needs an acting admin and a live writer.
async function groupHide (ctx, { group, target, on }) {
  return withGroup(ctx, group, true, async ({ ownHex, g }) => {
    const c = g.cores.get(target && typeof target === 'object' ? String(target.writer).toLowerCase() : '')
    let writer = null
    if (c !== undefined && c.diary === ownHex) {
      writer = liveOwnWriter(g, ownHex)
      if (writer === null && g.own !== null && boundWriters(g, ownHex).includes(g.own.key)) writer = g.own
    } else {
      const by = moderatorOf(g, ownHex)
      if (by !== null && by.cw !== undefined) {
        await appendToOwnGroupCore(ctx, by.cw, buildRecord(() => grp.communityHide({ group: g.group, target, on, seen: g.built.last })))
        return { ok: true }
      }
      if (by !== null) writer = by.own
    }
    if (writer === null) throw new UsageError(GROUP_FORBIDDEN)
    requireCounted(g, writer.key)
    let record = buildRecord(() => grp.groupHide({ target, on, seen: g.built.last }))
    if (g.private) record = sealForGroup(ctx, g, writer.key, record)
    await appendToOwnGroupCore(ctx, writer, record, g.private)
    return { ok: true }
  })
}

// The creator and current admins (community admins included) are never
// targets of an admit or a ban; the caller's authority is moderatorOf's.
function checkTarget (g, ownHex, member) {
  const d = String(member).toLowerCase()
  if (d === g.built.creator || g.built.admins.has(d)) throw new UsageError(GROUP_FORBIDDEN)
  return d
}

function groupAdmit (ctx, { group, member, on }) {
  return groupModerate(ctx, group, (g, ownHex, viaCommunity) => {
    const d = checkTarget(g, ownHex, member)
    const cuts = cutsFor(g, d, on === true)
    if (on === true) {
      // The fold admits only the writers an admit lists: a counted writer
      // not held here would stay hidden behind an admission that looks
      // complete. The member's diary must be stored and every writer it
      // binds that the fold counts must be held. An admit again lists the
      // writers the last one missed.
      const history = g.joins.get(d)
      if (history === undefined || missingWriters(g, d, history)) throw new UsageError(GROUP_ADMIT_WAIT)
    }
    const fields = { member: d, on, cuts, seen: g.built.last }
    return buildRecord(() => viaCommunity ? grp.communityAdmit({ group: g.group, ...fields }) : grp.groupAdmit(fields))
  }, grantKeyChange)
}

// An unban lifts the ban the local fold holds in force for the member, the
// same latest ban again while a counted writer an earlier unban did not list
// stays banned.
function groupBan (ctx, { group, member, on }) {
  return groupModerate(ctx, group, (g, ownHex, viaCommunity) => {
    const d = checkTarget(g, ownHex, member)
    let lifts = null
    if (!on) {
      lifts = g.built.bans.get(d) || null
      if (lifts === null) throw new UsageError(GROUP_UNCHANGED)
    }
    const fields = { member: d, on, cuts: cutsFor(g, d, !on), lifts, seen: g.built.last }
    return buildRecord(() => viaCommunity ? grp.communityBan({ group: g.group, ...fields }) : grp.groupBan(fields))
  }, (record) => record.on === true ? { rotate: true } : { history: true })
}

// A creator back in C whose demotion through its CW the fold would ignore
// (its leave is not confirmed yet): refused rather than a silent success.
const DEMOTE_PENDING = 'sem permissão: a saída anterior ainda não foi confirmada'
const GERAL_STAYS = 'o grupo Geral só sai com a comunidade'

// Whether the fold takes a `group: G` demotion through this creator's CW
// now: only from C's creator, once its diary marked G's root (a root void
// for a gap in that history alone gives none).
function gDemoteCounts (g, ownHex) {
  const C = g.built.community
  const marks = g.input.marks instanceof Map ? g.input.marks.get(ownHex) || [] : []
  return C !== null && C !== undefined && C.creator === ownHex &&
    marks.some((m) => m !== null && typeof m === 'object' && m.writer === g.group && Number.isSafeInteger(m.cut))
}

// Root-only records: the creator, through the root this device created
// (its nonce kept in the entry even after a leave and rejoin).
async function groupCharter (ctx, group, make, keyChange = null, demote = null) {
  return withGroup(ctx, group, true, async ({ ownHex, base, g }) => {
    if (g.built.creator !== ownHex || statusOf(g, ownHex) !== 'member' || g.own === null || g.own.rootNonce === null) {
      throw new UsageError(GROUP_FORBIDDEN)
    }
    // A root whose authority ended (its creator's diary marked it) writes
    // nothing the fold would count: refused, except a demotion, which a
    // creator back in C writes on its live community writer (cycle 16).
    if (g.built.rootCut !== null && g.built.rootCut !== undefined) {
      const cw = demote === null || g.c === null ? null : liveOwnWriter(g.c, ownHex)
      if (cw === null) throw new UsageError(GROUP_FORBIDDEN)
      if (!gDemoteCounts(g, ownHex)) throw new UsageError(DEMOTE_PENDING)
      await appendToOwnGroupCore(ctx, cw, demote(g))
      if (g.private && keyChange !== null) await afterKeyChange(ctx, base, g.group, ownHex, { rotate: true })
      return { ok: true }
    }
    if (g.private) needBox(ctx)
    const record = make(g)
    await appendToOwnGroupCore(ctx, { group: g.group, key: g.group, nonce: g.own.rootNonce }, record, g.private)
    if (g.private && keyChange !== null) await afterKeyChange(ctx, base, g.group, ownHex, keyChange(record))
    return { ok: true }
  })
}

function groupAdmin (ctx, { group, member, on }) {
  return groupCharter(ctx, group, (g) => {
    const d = String(member).toLowerCase()
    if (d === g.built.creator) throw new UsageError(GROUP_FORBIDDEN)
    if (!on) return buildRecord(() => grp.groupAdmin({ member: d, on, cuts: cutsFor(g, d), seen: g.built.last }))
    // A grant covers only the listed writers from their local length on, so
    // records the member wrote before the promotion never gain authority.
    const cuts = countedCuts(g, d, true)
    if (cuts.length > MAX_GROUP_CUTS) throw new UsageError(store.GROUP_FULL)
    return buildRecord(() => grp.groupAdmin({ member: d, on, cuts, seen: g.built.last }))
  }, grantKeyChange, on ? null : demoteThroughCw(member))
}

// The demotion a creator back in C writes on its CW for group g.
function demoteThroughCw (member) {
  return (g) => {
    const d = String(member).toLowerCase()
    if (d === g.built.creator) throw new UsageError(GROUP_FORBIDDEN)
    return buildRecord(() => grp.communityDemote({ group: g.group, member: d, cuts: cutsFor(g, d), seen: g.built.last }))
  }
}

function groupMeta (ctx, { group, name, join }) {
  if (name === undefined && join === undefined) throw new UsageError(GROUP_UNCHANGED)
  return groupCharter(ctx, group, (g) => {
    if (g.private && join !== undefined && join !== 'approval') throw new UsageError(GROUP_PRIVATE_APPROVAL)
    // A private group is always 'approval'; its name travels sealed.
    const record = buildRecord(() => grp.groupMeta({
      name: name === undefined ? g.built.name : name,
      join: g.private ? 'approval' : (join === undefined ? g.built.join : join),
      seen: g.built.last
    }))
    return g.private ? sealForGroup(ctx, g, g.group, record) : record
  })
}

// rpc.md 5.71: the group's creator or an admin on its own writer, or a
// community creator or admin through its CW naming G (moderatorOf, the
// same authority the fold checks). Always plaintext, private group too: the
// setting says nothing about the group's content.
function groupInvitePolicy (ctx, { group, members }) {
  return withGroup(ctx, group, true, async ({ ownHex, g }) => {
    if (g.built.memberInvite === members) throw new UsageError(GROUP_UNCHANGED)
    const by = moderatorOf(g, ownHex)
    if (by === null) throw new UsageError(GROUP_FORBIDDEN)
    if (by.cw !== undefined) {
      await appendToOwnGroupCore(ctx, by.cw, buildRecord(() => grp.communityInvites({ group: g.group, on: members, seen: g.built.last })))
    } else {
      requireCounted(g, by.own.key)
      await appendToOwnGroupCore(ctx, by.own, buildRecord(() => grp.groupInvites({ on: members, seen: g.built.last })), g.private)
    }
    return { ok: true }
  })
}

// One page backwards over the causal order, newest first (feed.read's
// shape); a hidden post keeps its place with an empty text.
async function groupRead (ctx, { group, limit = GROUP_LIMIT_DEFAULT, before = null } = {}) {
  return withGroup(ctx, group, false, async ({ base, g }) => {
    const all = g.built.posts.filter((p) => g.diaries.get(p.diary))
    // Older than the cursor: with the cursor post still in the fold, every
    // post before it in the causal order; without it (gone after a sync), each
    // post whose order key (at, writer, seq) is below the cursor's, checked one
    // by one in causal order. Causal and key order can differ, so a count of
    // such posts would not be a position in the causal array.
    let posts = all
    if (before !== null && before !== undefined) {
      const i = all.findIndex((p) => p.writer === before.writer && p.seq === before.seq)
      if (i >= 0) {
        posts = all.slice(0, i)
      } else {
        const k = orderKey(before.at, before.writer, before.seq)
        posts = all.filter((p) => compareOrder(orderKey(p.at, p.writer, p.seq), k) < 0)
      }
    }
    const start = Math.max(0, posts.length - (limit || GROUP_LIMIT_DEFAULT))
    const page = posts.slice(start).reverse()
    const items = page.map((p) => ({
      writer: p.writer,
      diary: p.diary,
      seq: p.seq,
      at: p.at,
      text: p.hidden ? '' : p.text,
      replyTo: p.replyTo,
      fwd: p.fwd,
      media: p.hidden || !Array.isArray(p.media) ? null : copyGroupMedia(p.media, typeof p.media[0].key === 'string'),
      card: p.hidden || !p.card ? null : copyLinkCard(p.card, (d) => ({ ...d })),
      hidden: p.hidden,
      ...authorOf(g, p.diary, base.association, base.mod)
    }))
    const oldest = items.length > 0 ? items[items.length - 1] : null
    return {
      items,
      next: start > 0 && oldest !== null ? { at: oldest.at, writer: oldest.writer, seq: oldest.seq } : null,
      hidden: items.filter((p) => p.hidden).length,
      incomplete: g.built.incomplete,
      sealed: g.built.sealed,
      epoch: g.built.epoch === null ? null : { writer: g.built.epoch.writer, seq: g.built.epoch.seq },
      state: keyState(ctx, g)
    }
  }, (p) => {
    requirePendingOwn(p)
    return { items: [], next: null, hidden: 0, incomplete: true, sealed: 0, epoch: null, state: 'ok' }
  })
}

// rpc.md 5.82: marks the newest listed post seen here, moving only forward
// and writing only on change. A cut-off bounds the mark to that listed post;
// its at is never stored.
async function groupSeen (ctx, { group, upTo = null } = {}) {
  return withGroup(ctx, group, false, async ({ g }) => {
    const posts = readablePosts(g)
    if (posts.length === 0) return { ok: true }
    const target = upTo === null ? posts.length - 1 : posts.findIndex((q) => q.writer === upTo.writer && q.seq === upTo.seq)
    if (target < 0) return { ok: true }
    const p = posts[target]
    const marks = await store.readGroupSeen(ctx.storage)
    const mark = marks.find((m) => m.group === g.group) || null
    if (mark !== null) {
      const i = posts.findIndex((q) => q.writer === mark.writer && q.seq === mark.seq)
      const ahead = i >= 0
        ? i < target
        : compareOrder(orderKey(p.at, p.writer, p.seq), orderKey(mark.at, mark.writer, mark.seq)) > 0
      if (!ahead) return { ok: true }
    }
    await store.writeGroupSeen(ctx.storage, [...marks.filter((m) => m.group !== g.group), { group: g.group, at: p.at, writer: p.writer, seq: p.seq }])
    return { ok: true }
  }, (p) => {
    requirePendingOwn(p)
    return { ok: true }
  })
}

function memberCount (g) {
  let n = 0
  for (const st of g.built.members.values()) if (st === 'member') n++
  return n
}

// This device's groups (kv groupWriters), oldest first.
async function groupList (ctx, { offset = 0, limit = GROUP_LIMIT_DEFAULT } = {}) {
  const association = await trustRoot(ctx)
  const mod = await moderation(ctx.storage, association)
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    const base = { ownHex, ownEntries: await store.readAll(diary), association, mod }
    const groups = []
    for (const e of await store.readGroupWriters(ctx.storage)) {
      if (e.kind === 'community') continue
      const g = await loadGroup(ctx, base, e.group)
      if (g === null) {
        if (await pendingOf(ctx, mod, e.group) !== null) groups.push({ group: e.group, ...PENDING_INFO, community: null })
        continue
      }
      // An orphan is left out of the list and of the total.
      if (g.built.orphan) continue
      groups.push({ group: e.group, name: g.built.name, join: g.built.join, role: roleOf(g, ownHex), members: memberCount(g), community: g.community })
    }
    // Roots the own diary binds (another device of the account wrote there)
    // and this device holds: listed without a groupWriters entry.
    const listed = new Set(groups.map((r) => r.group))
    for (const e of await store.readGroupWriters(ctx.storage)) listed.add(e.group)
    for (const key of diaryGroupKeys(base.ownEntries)) {
      if (listed.has(key)) continue
      const g = await loadGroup(ctx, base, key)
      if (g === null || g.built.orphan) continue
      groups.push({ group: key, name: g.built.name, join: g.built.join, role: writersStillArriving(g, ownHex, base.mod) ? 'pending' : roleOf(g, ownHex), members: memberCount(g), community: g.community })
    }
    return { groups: groups.slice(offset, offset + limit), total: groups.length }
  })
}

async function groupInfo (ctx, { group }) {
  return withGroup(ctx, group, false, ({ ownHex, base, g }) => ({
    group: g.group,
    name: g.built.name,
    join: g.built.join,
    creator: g.built.creator,
    role: roleHere(g, ownHex, base),
    members: memberCount(g),
    state: stateOf(g, ownHex),
    community: g.community,
    orphan: g.built.orphan === true,
    visibility: g.private ? 'private' : 'public',
    memberInvite: g.built.memberInvite === true,
    writerHere: g.own !== null,
    canWrite: groupCanWrite(ctx, g, ownHex),
    writersBound: diaryBound(g, ownHex)
  }), (p) => {
    requirePendingOwn(p)
    return { group: p.group, ...PENDING_INFO, creator: null, state: 'pending', community: null, orphan: false, visibility: 'public', memberInvite: false, writerHere: true, canWrite: false, writersBound: 0 }
  })
}

// The header times of the diary's writers in the fold, oldest first.
function writerTimes (g, d) {
  return boundWriters(g, d).map((k) => g.cores.get(k).at).sort()
}

async function groupMembers (ctx, { group, offset = 0, limit = GROUP_MEMBERS_LIMIT_MAX } = {}) {
  return withGroup(ctx, group, false, ({ base, g }) => {
    const list = [...g.built.members].filter(([, st]) => st === 'member' || st === 'banned')
    const members = list.slice(offset, offset + limit).map(([d, st]) => {
      const times = writerTimes(g, d)
      return {
        member: d,
        ...authorOf(g, d, base.association, base.mod),
        admin: g.built.admins.has(d),
        banned: st === 'banned',
        joinedAt: times.length > 0 ? times[0] : null
      }
    })
    return { members, total: list.length }
  })
}

async function groupRequests (ctx, { group, offset = 0, limit = GROUP_MEMBERS_LIMIT_MAX } = {}) {
  return withGroup(ctx, group, false, ({ ownHex, base, g }) => {
    if (!isActingAdmin(g, ownHex)) throw new UsageError(GROUP_FORBIDDEN)
    const list = g.built.requests
    const requests = list.slice(offset, offset + limit).map((d) => {
      const times = writerTimes(g, d)
      return { member: d, ...authorOf(g, d, base.association, base.mod), at: times.length > 0 ? times[times.length - 1] : null }
    })
    return { requests, total: list.length }
  })
}

// ---- private groups (docs/protocol.md "Private groups") ----
//
// This device's box key pair and the epoch keys it opened live in
// ctx.groupKeys (./group-keys.js), in memory only: storage keeps the sealed
// blocks and nothing else. Every fold of a private group hands buildGroup an
// unseal that opens with the held pair and installs each key it opens in
// the holder (under the holder's token), so sealing and the history handed
// on admit read the key from there; no result ever carries a key.

const GROUP_REKEY_PENDING = 'aguardando nova chave'
const GROUP_PRIVATE_APPROVAL = 'grupo privado exige aprovação'
const ROTATION_TOO_BIG = 'rotação grande demais para o espaço do diário'
const { MAX_LOG_BLOCKS, MAX_LOG_BYTES } = require('@varanda/core/lib/records')
const GROUP_BOXLESS_FULL = 'limite de aparelhos no grupo atingido: os aparelhos que entraram antes de receber o grupo privado não leem nele'
const GROUP_PUBLIC_NO_KEY = 'grupo público não usa chave'
const ROTATION_UNCONFIRMED = 'a nova chave do grupo não se confirmou'
const DUMMY_SEALED = b4a.toString(b4a.alloc(gc.SEALED_EPOCH_KEY_BYTES), 'base64')

function holderOf (ctx) {
  const h = ctx.groupKeys
  return h !== null && typeof h === 'object' && typeof h.get === 'function' ? h : null
}

// The held box public key as hex, or null while locked.
function boxHexOf (ctx) {
  const h = holderOf(ctx)
  const pk = h === null ? null : h.boxPublicKey()
  if (pk === null) return null
  const out = hex(pk)
  pk.fill(0)
  return out
}

function needBox (ctx) {
  const box = boxHexOf(ctx)
  if (box === null) throw new UsageError(store.LOCKED)
  return box
}

// buildGroup over `input` with this device's keys. unseal hands the fold the
// raw crypto_box_seal_open plaintext (key || tag); the fold checks the tag
// against G and the kid and wipes it. `probe` ({ pair }) replaces the
// device pair with a throwaway one a planned rotation sealed to, so the
// real fold says whether that epoch would be eligible before anything is
// written. `epochs` receives { kid, recipients } of every epoch the fold
// accepted and opened (onKey, the only source of the keys sealed with or
// handed on); each key goes to the holder under its token, nowhere else.
function foldWithKeys (ctx, input, mine, probe = null, epochs = null) {
  const h = holderOf(ctx)
  const opened = []
  let keys = null
  if (mine.size > 0 && (probe !== null || (h !== null && h.unlocked))) {
    const tok = h === null ? null : h.token()
    keys = {
      onKey (kid, key, recipients) {
        try {
          if (probe === null && epochs !== null && h.put(tok, kid, key)) {
            epochs.push({ kid: { writer: kid.writer, seq: kid.seq }, recipients: new Set(recipients) })
          }
        } finally {
          gc.wipe(key)
        }
      },
      writers: mine,
      unseal (sealed) {
        const pair = probe !== null ? probe.pair : h.boxKeyPair()
        if (pair === null) return null
        const out = gc.openFrom(b4a.from(sealed, 'base64'), pair)
        if (out !== null) opened.push(out)
        return out
      }
    }
  }
  try {
    return buildGroup({ ...input, keys, now: Date.now() })
  } finally {
    for (const k of opened) gc.wipe(k)
  }
}

// The writers of this device in the group: the cores of the own diary whose
// header carries the held box key (G for the creator's device).
function mineOf (group, rootHeader, writers, ownHex, boxHex) {
  const mine = new Set()
  if (boxHex === null) return mine
  if (rootHeader.diary === ownHex && rootHeader.box === boxHex) mine.add(group)
  for (const w of writers) if (w.diary === ownHex && w.entries[0].record.box === boxHex) mine.add(w.key)
  return mine
}

// Whether an epoch key may be sealed to `boxHex`: not a weak point, and the
// seal itself works (tried on zeros, nothing secret involved).
function canSealTo (boxHex) {
  if (boxHex === null || grp.isWeakBoxKey(boxHex)) return false
  try {
    const pk = b4a.from(boxHex, 'hex')
    gc.sealTo(b4a.alloc(gc.KEY_BYTES + gc.KEY_TAG_BYTES), pk)
    return true
  } catch {
    return false
  }
}

function boxOfWriter (g, w) {
  const c = g.cores.get(w)
  if (c === undefined || c.entries.length === 0) return null
  const box = c.entries[0].record.box
  return typeof box === 'string' && HEX64.test(box) ? box.toLowerCase() : null
}

// The read state of rpc.md group.read.
function keyState (ctx, g) {
  if (!g.private) return 'ok'
  if (boxHexOf(ctx) === null) return 'locked'
  return g.built.rekeyPending ? 'rekey-pending' : 'ok'
}

// The writer this device distributes keys from, or null: its live writer
// while its diary is the creator or an acting admin (community authority
// included, as the fold's `admins` reads them; its key blocks then carry
// authOf).
function distributorOf (g, ownHex) {
  if (!g.private || statusOf(g, ownHex) !== 'member') return null
  if (g.built.creator !== ownHex && !g.built.admins.has(ownHex)) return null
  const own = liveOwnWriter(g, ownHex)
  if (own === null || !g.built.writers.has(own.key) || !g.mine.has(own.key)) return null
  // A root whose authority ended distributes nothing the fold would count.
  if (own.key === g.group && g.built.rootCut !== null && g.built.rootCut !== undefined) return null
  return own
}

// The `auth` of this device's key blocks: the own community writer at its
// length when it distributes through community authority (the fold ignores
// it for the group's creator or a group admin), else null.
function authOf (g, ownHex) {
  if (ownHex === g.built.creator) return null
  const cw = communityPower(g, ownHex)
  const core = cw === null ? undefined : g.c.cores.get(cw.key)
  return core === undefined ? null : { writer: cw.key, seq: core.length }
}

// The epochs whose first block sits in a counted core, with every writer a
// group-key block hands them to -> Map 'writer:seq' -> { kid, recipients }.
// A peer's record as the fold would count it: valid for its place in this
// private group, else null (never read raw).
function validRecord (g, w, seq, r) {
  return grp.validateGroupRecord(r, seq, { root: w === g.group, private: g.private }) === null ? r : null
}

// The removals a rotation from writer `wk` lists in its basis: only the
// fold's own requirement set (`removals`), never a scan of raw records, so
// records the fold ignores (bans from unadmitted writers) cost nothing.
// Those `wk` already follows (its own records and the basis of its earlier
// first blocks) are left out, except community refs (writer not a core of
// this group): the fold covers one only through first blocks it counted, and
// an earlier block written while `wk`'s authority was being cut is not.
function removalRefs (g, wk) {
  const covered = new Set()
  for (const { seq, record } of g.cores.get(wk).entries) {
    const r = validRecord(g, wk, seq, record)
    if (r === null || r.type !== 'group-key' || r.kid !== null) continue
    for (const b of r.basis) if (g.cores.has(b.writer)) covered.add(b.writer + ':' + b.seq)
  }
  const out = []
  for (const r of Array.isArray(g.built.removals) ? g.built.removals : []) {
    const id = r.writer + ':' + r.seq
    if (r.writer === wk || covered.has(id)) continue
    covered.add(id)
    out.push({ writer: r.writer, seq: r.seq })
  }
  return out
}

// The group-key records of a rotation on writer `wk` from seq `from`: one
// first block per basis chunk (the last one sealed to `recipients`, the
// earlier ones only to `wk`, since nobody sends under them), then
// continuations for recipients beyond MAX_KEY_RECIPIENTS.
// sealFor(i, writer, kid) -> base64 of epoch i's key sealed to that writer;
// commitFor(i, kid) -> hex commitment of epoch i's key, on its first block.
function rotationRecords (wk, from, chunks, recipients, sealFor, commitFor, at, auth = null) {
  const out = []
  let seq = from
  for (let i = 0; i < chunks.length; i++) {
    const kid = { writer: wk, seq }
    const list = i === chunks.length - 1 ? recipients : [wk]
    for (let j = 0; j < list.length; j += gc.MAX_KEY_RECIPIENTS) {
      const keys = list.slice(j, j + gc.MAX_KEY_RECIPIENTS).map((w) => ({ writer: w, sealed: sealFor(i, w, kid) }))
      const fields = j === 0 ? { kid: null, basis: chunks[i], keys, auth, commit: commitFor(i, kid), at } : { kid, basis: [], keys, auth, at }
      out.push({ seq, record: buildRecord(() => grp.groupKey(fields)) })
      seq++
    }
  }
  return out
}

function withAppended (input, wk, records) {
  const extra = records.map(({ seq, record }) => ({ seq, record }))
  if (wk === input.root.key) return { ...input, root: { ...input.root, entries: [...input.root.entries, ...extra] } }
  return { ...input, writers: input.writers.map((w) => w.key === wk ? { ...w, entries: [...w.entries, ...extra] } : w) }
}

// Whether the planned rotation's last epoch would be the one this device
// sends under, recipients and basis as given: the fold's own eligibility
// ("Entitled writers", "Eligibility") is the judge, so a recipient the fold
// would not entitle (a pending device, a banned or departed writer) is
// never sealed to.
function rotationEligible (ctx, g, wk, from, chunks, recipients, auth) {
  const pair = gc.newBoxKeyPair()
  const key = gc.newEpochKey()
  try {
    const sealFor = (i, w, kid) => w === wk ? b4a.toString(gc.sealEpochKey(key, g.group, kid, pair.publicKey), 'base64') : DUMMY_SEALED
    const commitFor = (i, kid) => hex(gc.keyCommit(key, g.group, kid))
    const records = rotationRecords(wk, from, chunks, recipients, sealFor, commitFor, nowIso(), auth)
    const last = records.filter((r) => r.record.kid === null).pop()
    const built = foldWithKeys(ctx, withAppended(g.input, wk, records), new Set([wk]), { pair })
    return built.epoch !== null && built.epoch.writer === wk && built.epoch.seq === last.seq
  } finally {
    gc.wipe(key)
    gc.wipe(pair.secretKey)
  }
}

// The writers the fold entitles now (rpc "Entitled writers").
function entitledOf (g) {
  return new Set(Array.isArray(g.built.entitled) ? g.built.entitled : [])
}

// A new epoch from this device's writer -> its kid. The key is sealed to
// exactly the writers the fold entitles, then kept in the holder only.
async function rotateGroup (ctx, g, ownHex) {
  const own = distributorOf(g, ownHex)
  if (own === null) throw new UsageError(GROUP_FORBIDDEN)
  const h = holderOf(ctx)
  if (h === null || !h.unlocked) throw new UsageError(store.LOCKED)
  const tok = h.token()
  const wk = own.key
  const from = g.cores.get(wk).length
  const removals = removalRefs(g, wk)
  const chunks = []
  for (let i = 0; i < removals.length; i += grp.MAX_KEY_BASIS) chunks.push(removals.slice(i, i + grp.MAX_KEY_BASIS))
  if (chunks.length === 0) chunks.push([])
  const recipients = [wk, ...[...entitledOf(g)].filter((w) => w !== wk && canSealTo(boxOfWriter(g, w))).sort()]
  // The real fold over the planned blocks must pick this epoch, or the
  // rotation would leave every sender rekey-pending: nothing is written then.
  const auth = authOf(g, ownHex)
  if (!rotationEligible(ctx, g, wk, from, chunks, recipients, auth)) throw new Error(ROTATION_UNCONFIRMED)
  const keys = chunks.map(() => gc.newEpochKey())
  try {
    const sealFor = (i, w, kid) => b4a.toString(gc.sealEpochKey(keys[i], g.group, kid, b4a.from(boxOfWriter(g, w), 'hex')), 'base64')
    const commitFor = (i, kid) => hex(gc.keyCommit(keys[i], g.group, kid))
    const records = rotationRecords(wk, from, chunks, recipients, sealFor, commitFor, nowIso(), auth)
    await checkRotationRoom(ctx, wk, records)
    let last = null
    for (const r of records) {
      const seq = await appendToOwnGroupCore(ctx, own, r.record, true)
      if (seq !== r.seq) throw new Error(ROTATION_UNCONFIRMED)
      if (r.record.kid === null) last = { writer: wk, seq }
    }
    h.put(tok, last, keys[keys.length - 1])
    return last
  } finally {
    for (const k of keys) gc.wipe(k)
  }
}

// A rotation is written whole or not at all: refused before the first block
// when its blocks would not fit the writer's remaining log budget.
async function checkRotationRoom (ctx, wk, records) {
  const fits = await rotationFits(ctx, wk, records)
  if (fits === null) throw new Error(GROUP_NOT_FOUND)
  if (!fits) throw new UsageError(ROTATION_TOO_BIG)
}

// Whether `records` fit writer `wk`'s remaining log budget; null when the
// core is not held.
async function rotationFits (ctx, wk, records) {
  const limits = { maxLogBlocks: MAX_LOG_BLOCKS, maxLogBytes: MAX_LOG_BYTES, ...ctx.limits }
  const held = await withGroupCore(ctx, wk, async (core) => ({ length: core.length, bytes: core.byteLength }))
  if (held === null) return null
  const length = held.length
  let bytes = held.bytes
  for (const r of records) bytes += b4a.byteLength(JSON.stringify(r.record))
  return length + records.length <= limits.maxLogBlocks && bytes <= limits.maxLogBytes
}

// History ("History on admit"): continuation blocks handing every epoch
// key the fold gave this device to every entitled writer its recipients do
// not list yet, so a delivery that failed earlier is made up for too.
// -> the planned blocks, or null when there is nothing to hand (no
// distributor here, the holder locked, no target or no key missing).
function historyPlan (ctx, g, ownHex) {
  const own = distributorOf(g, ownHex)
  const h = holderOf(ctx)
  if (own === null || h === null || !h.unlocked) return null
  const targets = [...entitledOf(g)].filter((w) => w !== own.key && canSealTo(boxOfWriter(g, w))).sort()
  if (targets.length === 0) return null
  const records = []
  const auth = authOf(g, ownHex)
  for (const e of g.epochs) {
    const need = targets.filter((w) => !e.recipients.has(w))
    const key = need.length === 0 ? null : h.get(e.kid)
    if (key === null) continue
    for (let j = 0; j < need.length; j += gc.MAX_KEY_RECIPIENTS) {
      const keys = need.slice(j, j + gc.MAX_KEY_RECIPIENTS).map((w) => ({
        writer: w,
        sealed: b4a.toString(gc.sealEpochKey(key, g.group, e.kid, b4a.from(boxOfWriter(g, w), 'hex')), 'base64')
      }))
      records.push({ kid: e.kid, record: buildRecord(() => grp.groupKey({ kid: e.kid, basis: [], keys, auth })) })
    }
  }
  return records.length === 0 ? null : records
}

// Planned whole first: a hand-off that would not fit the log (a rogue
// distributor opening thousands of epochs) writes nothing.
async function shareHistory (ctx, g, ownHex) {
  const records = historyPlan(ctx, g, ownHex)
  if (records === null) return
  const own = distributorOf(g, ownHex)
  const h = holderOf(ctx)
  await checkRotationRoom(ctx, own.key, records)
  for (const r of records) {
    // Asked again before every append: a lock in between wipes the keys
    // and stops the hand-off.
    if (h.get(r.kid) === null) return
    await appendToOwnGroupCore(ctx, own, r.record, true)
  }
}

// A plaintext group-post, group-hide or group-meta sealed under the fold's
// epoch for writer `writer` (USAGE 'aguardando nova chave' without one).
function sealForGroup (ctx, g, writer, record) {
  if (boxHexOf(ctx) === null) throw new UsageError(store.LOCKED)
  if (g.built.rekeyPending || g.built.epoch === null) throw new UsageError(GROUP_REKEY_PENDING)
  const h = holderOf(ctx)
  const key = g.epochs.some((e) => e.kid.writer === g.built.epoch.writer && e.kid.seq === g.built.epoch.seq) ? h.get(g.built.epoch) : null
  if (key === null) throw new UsageError(GROUP_REKEY_PENDING)
  const kid = { writer: g.built.epoch.writer, seq: g.built.epoch.seq }
  const { nonce, box } = gc.sealRecord(grp.sealedInner(record, { writer, group: g.group, kid }), key)
  return buildRecord(() => grp.groupSealed({ kid, nonce, box, at: record.at }))
}

// After a write that may change who reads, on a device that may
// distribute: `history` hands every held epoch to the entitled writers
// that lack it, `rotate` opens a new epoch, `repair` opens one only when
// the fold is rekey-pending after the history. The triggering record is
// already written: history that cannot be handed now is not its error, the
// next admit, grant, unban or group.rekey makes it up.
async function afterKeyChange (ctx, base, group, ownHex, { rotate = false, history = false, repair = false }) {
  let g = await loadGroup(ctx, base, group)
  if (g === null || distributorOf(g, ownHex) === null) return
  if (history) {
    try {
      await shareHistory(ctx, g, ownHex)
    } catch {}
    if (rotate || repair) g = await loadGroup(ctx, base, group)
  }
  if (repair && g !== null && g.built.rekeyPending) rotate = true
  // Likewise a rotation that fails here leaves the group rekey-pending,
  // which group.rekey repairs.
  if (rotate) {
    try {
      await rotateGroup(ctx, g, ownHex)
    } catch {}
  }
}

// -> { group, epoch }: rpc.md 5.61. Old epochs missing from an entitled
// writer are handed on first, then the new epoch is opened.
async function groupRekey (ctx, { group }) {
  return withGroup(ctx, group, true, async ({ ownHex, base, g }) => {
    if (!g.private) throw new UsageError(GROUP_PUBLIC_NO_KEY)
    needBox(ctx)
    if (distributorOf(g, ownHex) === null) throw new UsageError(GROUP_FORBIDDEN)
    await shareHistory(ctx, g, ownHex)
    const epoch = await rotateGroup(ctx, await loadGroup(ctx, base, g.group), ownHex)
    return { group: g.group, epoch }
  })
}

// ---- communities (docs/rpc.md 5.57, 5.59, 5.60, 5.62 to 5.69) ----
// A community C is a root whose header kind is `community`, stored as a
// group core; each member device writes one community writer (CW: a
// group-writer naming C and no member). kv groupWriters lists, with `kind:
// 'community'`, the root this device created (writer === community, its root
// nonce) or this device's CW (rootNonce null). The fold is @varanda/core
// lib/group.js buildCommunity over the root, the CWs held and their binding
// diaries; a group names its community in its header and buildGroup gates
// it by that fold.

const COMMUNITY_NOT_FOUND = 'comunidade não encontrada'
const COMMUNITY_FORBIDDEN = 'sem permissão na comunidade'
const COMMUNITY_FULL = 'limite da comunidade atingido'
const COMMUNITY_CREATOR = 'o criador da comunidade já administra'
const COMMUNITY_WAIT = 'aguarde a sincronização da comunidade'
const COMMUNITY_FIRST = 'entre na comunidade primeiro'
const COMMUNITY_GROUPS_FULL = 'a comunidade chegou ao limite de grupos'
const COMMUNITY_CREATOR_ONLY = 'só quem criou a comunidade cria grupos'
const COMMUNITY_CREATOR_DEVICE = 'crie pelo aparelho que criou a comunidade'
const COMMUNITY_MEMBER_NEEDED = 'a pessoa precisa ser membro da comunidade'
const COMMUNITY_LEAVE_CREATOR = 'saia pelo aparelho que criou a comunidade'
const COMMUNITY_LEAVE_WAIT = 'aguarde a sincronização da comunidade para sair'
const COMMUNITY_ROOT_WAIT = 'este aparelho ainda não baixou tudo da comunidade: aguarde para sair'
const COMMUNITY_LEAVE_GROUPS_WAIT = 'aguarde a sincronização dos grupos da comunidade para sair'
const COMMUNITY_ADMIT_WAIT = 'aguarde a sincronização da comunidade para admitir'
const COMMUNITY_LEAVE_DEVICES_WAIT = 'aguarde a sincronização dos seus aparelhos nesta comunidade para sair'
const GROUP_ORPHAN = 'grupo sem comunidade'
const GROUP_OTHER_COMMUNITY = 'o grupo não é dessa comunidade'
const GROUP_COMMUNITY_NEEDED = 'informe a comunidade do grupo'
const GENERAL_NAME = 'Geral'

function communityHeader (h) {
  return validateGroupHeader(h) === null && h.kind === 'community'
}

function communityKeyOf (community) {
  const key = String(community).toLowerCase()
  if (!HEX64.test(key)) throw new Error(COMMUNITY_NOT_FOUND)
  return key
}

// The fold of community `key` from local data, shaped like loadGroup's
// (group, own, built, cores, diaries, joins, input) so the group helpers
// (boundWriters, countedCuts, liveOwnWriter, statusOf...) read it too, or
// null when the root is not held, forked, blocked or no community root.
// `input` is buildCommunity's (and buildGroup's `community`).
async function loadCommunity (ctx, base, key) {
  const { ownHex, ownEntries, association, mod } = base
  if (mod.blocked.has(key)) return null
  const root = await readGroupCore(ctx, key)
  if (root === null || root.length === 0 || root.fork !== 0) return null
  const header = root.entries[0].record
  if (!communityHeader(header)) return null
  const own = (await store.readGroupWriters(ctx.storage)).find((e) => e.group === key) || null
  const keys = new Set(await store.readGroupReplicas(ctx.storage))
  if (own !== null) keys.add(own.key)
  keys.delete(key)
  const writers = []
  const cores = new Map([[key, { diary: header.diary, at: header.at, length: root.length, signed: root.signed, entries: root.entries }]])
  for (const k of [...keys].sort()) {
    const core = await readWriterCoreOf(ctx, k, key)
    if (core === null) continue
    const h = core.entries[0].record
    writers.push({ key: k, entries: core.entries, diary: h.diary })
    cores.set(k, { diary: h.diary, at: h.at, length: core.length, signed: core.signed, entries: core.entries })
  }
  const diaries = new Map()
  const joins = new Map()
  const confirms = new Map()
  for (const d of new Set([ownHex, header.diary, ...writers.map((w) => w.diary)])) {
    const entries = d === ownHex ? (mod.blocked.has(ownHex) ? null : ownEntries) : admittedEntries(await replicaRead(ctx, d, mod), d, association, mod)
    diaries.set(d, entries)
    if (entries !== null) {
      joins.set(d, groupJoinHistory(entries, key))
      confirms.set(d, groupConfirmHistory(entries, key))
    }
  }
  const input = { root: { key, entries: root.entries }, writers, joins, confirms }
  const built = grp.buildCommunity({ ...input, now: Date.now() })
  return { key, group: key, header, own, built, cores, diaries, joins, input }
}

// A stored community root that will never fold (forked, or its block 0 is
// no v2 community header): its entry may give up its slot.
async function communityUnfoldable (ctx, key) {
  const root = await readGroupCore(ctx, key)
  if (root === null || root.length === 0) return false
  return root.fork !== 0 || !communityHeader(root.entries[0].record)
}

async function communitySaysLeft (ctx, base, key) {
  const c = await loadCommunity(ctx, base, key)
  return c !== null && statusOf(c, base.ownHex) === 'left'
}

async function withCommunityBase (ctx, write, fn) {
  if (write) needGroupKeys(ctx)
  const association = await trustRoot(ctx)
  const mod = await moderation(ctx.storage, association)
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (write && diary.length === 0) throw new Error(GENESIS_REQUIRED)
    return fn({ diary, ownHex, base: { ownHex, ownEntries: await store.readAll(diary), association, mod } })
  })
}

// Folds `community` for fn({ diary, ownHex, base, c }). A root not held yet
// goes to `pending` ({ group, own }) when given; a held root that is no
// community root, a blocked or malformed key is NOT_FOUND (with
// `unfoldable`, a stored root that never folds goes to `pending` too).
async function withCommunity (ctx, community, write, fn, pending = null, unfoldable = false) {
  const C = communityKeyOf(community)
  return withCommunityBase(ctx, write, async (ids) => {
    if (ids.base.mod.blocked.has(C)) throw new Error(COMMUNITY_NOT_FOUND)
    const c = await loadCommunity(ctx, ids.base, C)
    if (c === null) {
      const root = await readGroupCore(ctx, C)
      const held = root !== null && root.length > 0
      if (pending === null || (held && !(unfoldable && await communityUnfoldable(ctx, C)))) throw new Error(COMMUNITY_NOT_FOUND)
      return pending({ group: C, own: (await store.readGroupWriters(ctx.storage)).find((e) => e.group === C) || null }, ids)
    }
    return fn({ ...ids, c })
  })
}

// The community a group.create names, with the community root the
// group-create goes to (`group-create` is root-only: only the community's
// creator creates groups, from the device holding the root's nonce) and the
// header's `member` (the device's live community writer); the catalogue must
// have room. After a confirmed leave of the creator the root's powers end for
// good (rpc.md 5.64): the fold voids its group-create, so nothing is written.
async function communityForCreate (ctx, base, C) {
  if (base.mod.blocked.has(C)) throw new Error(COMMUNITY_NOT_FOUND)
  const c = await loadCommunity(ctx, base, C)
  if (c === null) {
    const root = await readGroupCore(ctx, C)
    if (root !== null && root.length > 0) throw new Error(COMMUNITY_NOT_FOUND)
    throw new UsageError(COMMUNITY_WAIT)
  }
  if (c.built.creator !== base.ownHex) throw new UsageError(COMMUNITY_CREATOR_ONLY)
  requireRootAuthority(c)
  if (c.own === null || c.own.rootNonce === null) throw new UsageError(COMMUNITY_CREATOR_DEVICE)
  const live = liveOwnWriter(c, base.ownHex)
  if (statusOf(c, base.ownHex) !== 'member' || live === null) throw new UsageError(COMMUNITY_FORBIDDEN)
  if (c.built.created.size >= MAX_GROUPS_PER_COMMUNITY) throw new UsageError(COMMUNITY_GROUPS_FULL)
  return { c, root: { group: C, key: C, nonce: c.own.rootNonce, kind: 'community' }, member: live.key }
}

async function heldLength (ctx, key) {
  const core = await readGroupCore(ctx, key)
  return core === null ? 0 : core.length
}

// The own diary's join of `writer` in `group`, unless one is there already.
async function joinOnce (ctx, diary, group, writer) {
  const history = groupJoinHistory(await store.readAll(diary), group)
  if (!history.some((j) => j.writer === writer && j.on)) await appendOwn(ctx, diary, groupJoinRecord({ group, writer, on: true }))
}

// Steps 4 to 9 of a planned community.create (kv communityCreate), each
// skipped when already done: the community root header, its entry and
// join, the Geral root header naming the community, its entry and join, the
// group-create of Geral in the community root, then the plan is dropped.
async function finishCommunityCreate (ctx, diary, ownHex, base, plan) {
  const C = plan.community
  const G = plan.group
  const cEntry = { group: C, key: C, nonce: plan.communityNonce, rootNonce: plan.communityNonce, kind: 'community' }
  const gEntry = { group: G, key: G, nonce: plan.groupNonce, rootNonce: plan.groupNonce }
  await makeGroupRoom(ctx, base, C, [G])
  if (await heldLength(ctx, C) === 0) {
    await appendToOwnGroupCore(ctx, cEntry, buildRecord(() => grp.groupHeader({ kind: 'community', diary: ownHex, join: plan.join, name: plan.name, at: plan.at })))
  }
  if (!(await store.readGroupWriters(ctx.storage)).some((e) => e.group === C)) await store.putGroupWriter(ctx.storage, cEntry)
  await joinOnce(ctx, diary, C, C)
  if (await heldLength(ctx, G) === 0) {
    await appendToOwnGroupCore(ctx, gEntry, buildRecord(() => grp.groupHeader({ kind: 'group', diary: ownHex, community: C, member: C, visibility: 'public', join: 'open', name: GENERAL_NAME, at: plan.at })))
  }
  if (!(await store.readGroupWriters(ctx.storage)).some((e) => e.group === G)) await store.putGroupWriter(ctx.storage, gEntry)
  await joinOnce(ctx, diary, G, G)
  const root = await readGroupCore(ctx, C)
  const created = root.entries.some(({ seq, record }) => seq >= 1 && record !== null && typeof record === 'object' && record.type === 'group-create' && record.group === G)
  if (!created) await appendToOwnGroupCore(ctx, cEntry, buildRecord(() => grp.groupCreateRecord({ group: G, seen: null })))
  await store.writeCommunityCreate(ctx.storage, null)
  return { community: C, group: G }
}

// -> { community, group }: a new community root and its first group,
// Geral, both in new own cores (two kv groupWriters slots, made before
// anything is written). The plan (both keys and nonces) is stored first, so
// a call after a failure resumes it and answers the same keys; a plan whose
// root was never written gives way to a call with other params.
async function communityCreate (ctx, { name, join }) {
  return withCommunityBase(ctx, true, async ({ diary, ownHex, base }) => {
    // Checked before anything is planned or written.
    buildRecord(() => grp.groupHeader({ kind: 'community', diary: ownHex, join, name }))
    const planned = await store.readCommunityCreate(ctx.storage)
    if (planned !== null) {
      if ((planned.name === name && planned.join === join) || await heldLength(ctx, planned.community) > 0) {
        return finishCommunityCreate(ctx, diary, ownHex, base, planned)
      }
      await store.writeCommunityCreate(ctx.storage, null)
    }
    await makeGroupRoom(ctx, base, null, [null])
    const c = await newOwnGroupCore(ctx)
    await c.core.close()
    const g = await newOwnGroupCore(ctx)
    await g.core.close()
    const plan = { v: 1, community: c.key, communityNonce: c.nonce, group: g.key, groupNonce: g.nonce, name, join: join === undefined ? 'open' : join, at: nowIso() }
    await store.writeCommunityCreate(ctx.storage, plan)
    return finishCommunityCreate(ctx, diary, ownHex, base, plan)
  })
}

// A writer beyond the community's writer cap is not counted: never 'member'.
function communityJoinState (c, ownHex, writer) {
  const st = statusOf(c, ownHex)
  if (st === 'requested' || st === 'left') return st
  if (!c.built.writers.has(writer)) throw new UsageError(COMMUNITY_FULL)
  return 'member'
}

// The Geral step of community.join: a writer in Geral naming the own
// community writer `cw`, unless one that still writes names it already
// (pendingJoin while Geral's root is not held). -> Geral, or null when no
// writer can be written there (the community join already landed, so a
// refusal of Geral's own is no error of it).
async function joinGeneral (ctx, diary, ownHex, base, G, cw) {
  try {
    if (base.mod.blocked.has(G)) return null
    const g = await loadGroup(ctx, base, G)
    if (g === null) {
      const p = await pendingOf(ctx, base.mod, G)
      if (p === null) return null
      await pendingJoin(ctx, p, { diary, ownHex, base }, { member: cw })
      return G
    }
    // The fold's liveness decides (liveOwnWriter), on a writer naming `cw`;
    // a diary still requested in the community keeps its pending writer,
    // which counts once the community admits it.
    const core = g.own === null ? undefined : g.cores.get(g.own.key)
    const namesCw = core !== undefined && g.own.key !== G && core.entries[0].record.member === cw
    if (namesCw && (liveOwnWriter(g, ownHex) !== null || (g.c !== null && statusOf(g.c, ownHex) !== 'member' && ownPending(g, ownHex)))) return G
    await joinLoaded(ctx, { diary, ownHex, base, g }, cw)
    return G
  } catch (err) {
    if (err instanceof UsageError) return null
    throw err
  }
}

// The rejoin a CW core's header names, or null.
function headerRejoin (core) {
  const first = core && core.entries[0]
  const r = first && first.record !== null && typeof first.record === 'object' ? first.record.rejoin : null
  return r !== null && typeof r === 'object' ? { writer: r.writer, seq: r.seq } : null
}

// -> { state, group }: rpc.md 5.63. A live own community writer answers its
// state without a new one; else a new CW (naming the leave ownRejoinLeave
// picks when it left), the diary join, then the Geral step. `general:
// false` (the device upkeep only, never an RPC param) skips the Geral step:
// the upkeep plans Geral as a group, with its own checks.
async function communityJoin (ctx, { community }, { general: withGeneral = true } = {}) {
  return withCommunity(ctx, community, true, async ({ diary, ownHex, base, c }) => {
    // A root its creator's diary has not bound here yet folds empty: the
    // join waits for the sync like a root not held (the own CW is reused).
    if (c.built.creator === null) {
      await pendingJoin(ctx, { group: c.key, own: c.own }, { diary, ownHex, base }, { community: true })
      return { state: 'pending', group: null }
    }
    if (c.built.bans.has(ownHex) || statusOf(c, ownHex) === 'banned') throw new UsageError(COMMUNITY_FORBIDDEN)
    // A blocked own diary binds none of its writers in the fold.
    if (c.diaries.get(ownHex) === null) throw new UsageError(COMMUNITY_FORBIDDEN)
    // The creator's own leave this device noted but did not finish is
    // finished first: once the entry moves to a new CW it never can be,
    // and the root would keep its authority. A failure joins nothing.
    // Whatever the diary's status: a return from another device keeps the
    // diary a member, and the leave would otherwise stay unconfirmed.
    if (await finishNotedLeave(ctx, diary, c, ownHex, base.ownEntries)) {
      base = { ...base, ownEntries: await store.readAll(diary) }
      c = await loadCommunity(ctx, base, c.key)
      if (c === null) throw new UsageError(COMMUNITY_WAIT)
    }
    const general = c.built.general
    let cw = liveOwnWriter(c, ownHex)
    if (cw === null) {
      const current = c.own === null ? undefined : c.cores.get(c.own.key)
      const left = statusOf(c, ownHex) === 'left'
      let writer = !left && current !== undefined && ownPending(c, ownHex) && await ownWriterDerived(ctx, c.own) ? c.own.key : null
      let rejoin = writer === null ? null : headerRejoin(current)
      if (writer === null) {
        if (groupWritersFull(c) || boundWriters(c, ownHex).length >= MAX_GROUP_WRITERS_PER_DIARY) throw new UsageError(COMMUNITY_FULL)
        // Geral's slot only when this call joins it: the upkeep's room
        // check must not refuse, or evict a left entry, for a slot unused.
        await makeGroupRoom(ctx, base, c.key, general === null || !withGeneral ? [] : [general])
        // A leave of this device's own (owner decision, cycle 10), else the
        // diary's latest leave even while another device keeps it a member:
        // a CW bound after a leave without naming it is cut by it.
        const named = await ownRejoinLeave(ctx, base, diary, c, ownHex)
        c = named.c
        rejoin = named.rejoin
        const record = buildRecord(() => grp.writerHeader({ group: c.key, diary: ownHex, member: null, rejoin }))
        const created = await newOwnGroupCore(ctx)
        try {
          await store.appendGroupRecord(created.core, record, { root: false, community: true, limits: ctx.limits })
        } finally {
          await created.core.close()
        }
        if (c.own !== null) await store.addGroupReplica(ctx.storage, c.own.key)
        await store.putGroupWriter(ctx.storage, { group: c.key, key: created.key, nonce: created.nonce, rootNonce: c.own === null ? null : c.own.rootNonce, kind: 'community' })
        writer = created.key
      } else if (general !== null && withGeneral) {
        // The listed writer is reused: only Geral may need a new slot.
        await makeGroupRoom(ctx, base, c.key, [general])
      }
      // The first on-join signs the header's rejoin: without it the fold
      // takes the CW as generation 0, retired by any earlier leave.
      await appendOwn(ctx, diary, groupJoinRecord({ group: c.key, writer, on: true, ...(rejoin ? { rejoin } : {}) }))
      base = { ...base, ownEntries: await store.readAll(diary) }
      c = await loadCommunity(ctx, base, c.key)
      cw = c.own
    }
    const state = communityJoinState(c, ownHex, cw.key)
    const group = general === null || !withGeneral ? null : await joinGeneral(ctx, diary, ownHex, base, general, cw.key)
    return { state, group }
  }, async (p, ids) => {
    await pendingJoin(ctx, p, ids, { community: true })
    return { state: 'pending', group: null }
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
async function catalogueRoots (ctx, c, ownEntries, ownHex) {
  const keys = c.built.created instanceof Map ? [...c.built.created.keys()] : c.built.groups
  const confirmedBefore = Number.isFinite(c.built.creatorConfirmSeq)
  const roots = []
  let missing = 0
  for (const g of keys) {
    const key = groupKeyOf(g)
    if (!groupJoinHistory(ownEntries, key).some((j) => j.on && j.writer === key)) continue
    if (confirmedBefore && !groupCutHistory(ownEntries, key).some((m) => m.writer === key)) continue
    const root = await readGroupCore(ctx, key)
    if (root !== null && root.fork !== 0) continue
    if (root === null || root.length === 0) {
      missing++
      continue
    }
    const h = root.entries.length > 0 && root.entries[0].seq === 0 ? root.entries[0].record : null
    if (validateGroupHeader(h) !== null || h.kind !== 'group' || h.community !== c.key || h.diary !== ownHex) continue
    roots.push({ group: key, cut: root.length })
  }
  return { roots, missing }
}

// The creator's diary marks how far each group root of C went, at the cuts
// its leave note recorded (never at a length the root reached later):
// `marked` (the own diary entries) skips a root already marked. Every
// root is tried and the first failure is thrown after the rest.
// `ctx.onMark(group)`, when given, runs before each append (a test seam to
// simulate a failure).
async function markRoots (ctx, diary, roots, marked) {
  let failed = null
  for (const { group: g, cut } of roots) {
    try {
      if (marked !== null && groupCutHistory(marked, g).some((m) => m.writer === g)) continue
      if (typeof ctx.onMark === 'function') await ctx.onMark(g)
      await appendOwn(ctx, diary, groupCutRecord({ group: g, writer: g, cut }))
    } catch (err) {
      if (failed === null) failed = err
    }
  }
  if (failed !== null) throw failed
}

// The diary's group-confirm naming the community leave this call appended:
// the fold trusts a leave only through it, never through an off join.
function confirmLeave (ctx, diary, C, writer, seq, record) {
  const digest = grp.leaveDigest(record)
  if (digest === null) throw new Error('registro inválido: group-leave')
  return appendOwn(ctx, diary, buildRecord(() => groupConfirmRecord({ group: C, writer, seq, digest })))
}

// The note of the C leave this device appended as C's creator (kv
// communityLeave): a later community.leave confirms only that exact block,
// never a leave that reached the own CW by replication (anyone holding a
// copy of the CW key).
async function leaveNote (ctx, C) {
  return (await store.readLeaveNotes(ctx.storage)).find((n) => n.community === C) || null
}

async function setLeaveNote (ctx, note) {
  await store.writeLeaveNotes(ctx.storage, [...(await store.readLeaveNotes(ctx.storage)).filter((n) => n.community !== note.community), note])
}

async function clearLeaveNote (ctx, C) {
  const notes = await store.readLeaveNotes(ctx.storage)
  if (notes.some((n) => n.community === C)) await store.writeLeaveNotes(ctx.storage, notes.filter((n) => n.community !== C))
}

// Whether the stored group core `key` holds, at `seq`, the group-leave of
// `digest`. A forked core never matches (the fold drops it too).
// The block itself, not the contiguous prefix: a forced leave of the
// creator lands past a held-back tail of its own root.
async function leaveAtMatches (ctx, key, seq, digest) {
  const entry = await withGroupCore(ctx, key, async (core) => {
    try {
      if (core.fork === 0 && seq < core.length && await core.has(seq)) return { seq, record: decodeBlock(await core.get(seq, { wait: false, raw: true })) }
    } catch {}
    return null
  })
  return entry !== null && hasLeave([entry]) && grp.leaveDigest(entry.record) === digest
}

// The note of C's creator, out of C with its own CW still on in the diary,
// whose CW holds at the note's seq the exact group-leave it noted: what
// community.leave finishes (and community.info reports as leavePending).
// null otherwise.
async function notedLeave (ctx, c, ownHex, ownEntries) {
  const own = c.own
  if (c.header.diary !== ownHex || own === null) return null
  const last = groupJoinHistory(ownEntries, c.key).filter((j) => j.writer === own.key).pop()
  if (last === undefined || !last.on) return null
  const note = await leaveNote(ctx, c.key)
  if (note === null || note.writer !== own.key) return null
  const core = c.cores.get(own.key)
  const entry = core === undefined ? undefined : core.entries.find((e) => e.seq === note.seq)
  if (entry === undefined || !hasLeave([entry]) || grp.leaveDigest(entry.record) !== note.digest) return null
  return (await leaveAtMatches(ctx, own.key, note.seq, note.digest)) ? note : null
}

async function notedLeavePending (ctx, c, ownHex, ownEntries) {
  return (await notedLeave(ctx, c, ownHex, ownEntries)) !== null
}

// Finishes the leave notedLeave names, if any: the missing marks at the
// noted cuts, the group-confirm of exactly that leave unless present, then
// the off join. -> whether it wrote anything.
async function finishNotedLeave (ctx, diary, c, ownHex, ownEntries) {
  const note = await notedLeave(ctx, c, ownHex, ownEntries)
  if (note === null) return false
  await markRoots(ctx, diary, note.roots, ownEntries)
  const confirmed = groupConfirmHistory(ownEntries, c.key).some((e) => e.writer === note.writer && e.seq === note.seq && e.digest === note.digest)
  if (!confirmed) await appendOwn(ctx, diary, buildRecord(() => groupConfirmRecord({ group: c.key, writer: note.writer, seq: note.seq, digest: note.digest })))
  await appendOwn(ctx, diary, groupJoinRecord({ group: c.key, writer: c.own.key, on: false }))
  await clearLeaveNote(ctx, c.key)
  return true
}

// Whether a counted CW of diary d in C other than the root is not held here
// or is held below its signed length.
function ownCwsBehind (c, d) {
  const held = new Set()
  for (const [key, core] of c.cores) if (core.diary === d) held.add(key)
  const counted = joinedCounted(c.joins.get(d) || [], d, c.cores.get(c.key).diary, c.key)
  if (counted.some((w) => w !== c.key && !held.has(w))) return true
  for (const w of c.built.writers) {
    const core = c.cores.get(w)
    if (w !== c.key && core !== undefined && core.diary === d && core.length < (core.signed || 0)) return true
  }
  return false
}

// -> { state: 'left' }: a group-leave in the own community writer listing
// every counted writer of the own diary in the community, then the diary's
// join off. Nothing is written in the community's groups: the gate reads
// the diary as left there.
async function communityLeave (ctx, { community, force = false }) {
  return withCommunity(ctx, community, true, async ({ diary, ownHex, base, c }) => {
    if (statusOf(c, ownHex) === 'banned') throw new UsageError(COMMUNITY_FORBIDDEN)
    // C's creator whose noted leave is written but not finished (a mark
    // failed, or a crash after the note): the missing marks at the noted
    // cuts, the group-confirm of exactly that leave unless present, then the
    // off join, whatever the diary's status now (a return from another
    // device keeps the diary a member).
    if (await finishNotedLeave(ctx, diary, c, ownHex, base.ownEntries)) return { state: 'left' }
    if (statusOf(c, ownHex) === 'left') return { state: 'left' }
    // A request withdraws through its pending CW (no leave of its own); a
    // member through a bound, counted CW holding no leave that C's ban layer
    // still covers (an unban missed it), so it is never locked in C.
    const lingering = c.own !== null && statusOf(c, ownHex) === 'member' && c.built.writers.has(c.own.key) &&
      c.cores.get(c.own.key) !== undefined && !hasLeave(c.cores.get(c.own.key).entries) && boundWriters(c, ownHex).includes(c.own.key)
    const own = liveOwnWriter(c, ownHex) || (statusOf(c, ownHex) === 'requested' && ownPending(c, ownHex) ? c.own : null) || (lingering ? c.own : null)
    if (own === null) throw new UsageError(GROUP_UNCHANGED)
    if (!c.built.writers.has(own.key)) throw new UsageError(COMMUNITY_FULL)
    const cuts = countedCuts(c, ownHex)
    if (c.header.diary === ownHex && c.built.writers.has(c.key) && !cuts.some((x) => x.writer === c.key)) {
      throw new UsageError(COMMUNITY_LEAVE_CREATOR)
    }
    const creator = c.header.diary === ownHex
    // `force`: true skips every wait, a list only the waits it names.
    const skip = (name) => force === true || (Array.isArray(force) && force.includes(name))
    // The creator's leave lists C's root at the contiguous length held here:
    // a copy behind the root's signed length cuts it short, so the creator
    // waits for the sync unless it chose to leave anyway (a held-back tail
    // then never counts, the side that grants the root less).
    if (creator && !skip('root') && (c.joins.get(ownHex) || []).some((j) => j.on && j.writer === c.key)) {
      const root = c.cores.get(c.key)
      if (root.length < (root.signed || 0)) throw new UsageError(COMMUNITY_ROOT_WAIT)
    }
    // A bound root not here yet would stay unmarked: the creator waits for
    // the sync unless it chose to leave anyway (the fold then voids what the
    // root did before, as for any unmarked root).
    // The same for its other counted CWs of C: one not held or held short
    // would be listed short, or not at all (the fold then withdraws it from
    // seq 0).
    if (creator && !skip('devices') && ownCwsBehind(c, ownHex)) {
      throw new UsageError(COMMUNITY_LEAVE_DEVICES_WAIT)
    }
    if (creator && !skip('groups') && (await catalogueRoots(ctx, c, base.ownEntries, ownHex)).missing > 0) {
      throw new UsageError(COMMUNITY_LEAVE_GROUPS_WAIT)
    }
    // The group leaves are planned from the folds before the community
    // leave, while the own group writers are still live.
    const groupLeaves = await plannedGroupLeaves(ctx, base, c.key, ownHex)
    // The group leaves go first: they cut this device's later records in
    // each group by seq (a departed device holds no authority there at all).
    // Best effort: a group whose leave fails never stops the community leave.
    const ended = []
    for (const x of groupLeaves) {
      try {
        await appendToOwnGroupCore(ctx, x.own, buildRecord(() => grp.groupLeave({ seen: x.seen, cuts: x.cuts })), x.priv)
        ended.push(x)
      } catch {}
    }
    const record = buildRecord(() => grp.groupLeave({ seen: c.built.last, cuts }))
    // The creator's note goes before the append, so a failure right after it
    // still lets a later community.leave finish exactly this leave, with the
    // roots' lengths of now (read again after the group leaves, so a root's
    // own group leave lies below its cut).
    let note = null
    if (creator) {
      const core = await readGroupCore(ctx, own.key)
      if (core === null) throw new UsageError(GROUP_UNCHANGED)
      // The append lands at the signed length, past a held-back tail.
      note = { community: c.key, writer: own.key, seq: core.signed, digest: grp.leaveDigest(record), roots: (await catalogueRoots(ctx, c, base.ownEntries, ownHex)).roots }
      await setLeaveNote(ctx, note)
      if (typeof ctx.onLeaveNote === 'function') await ctx.onLeaveNote(c.key)
    }
    const leaveSeq = await appendToOwnGroupCore(ctx, own, record)
    if (note !== null && (leaveSeq !== note.seq || !(await leaveAtMatches(ctx, own.key, leaveSeq, note.digest)))) {
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
    if (note !== null) await markRoots(ctx, diary, note.roots, null)
    await confirmLeave(ctx, diary, c.key, own.key, leaveSeq, record)
    await appendOwn(ctx, diary, groupJoinRecord({ group: c.key, writer: own.key, on: false }))
    if (creator) await clearLeaveNote(ctx, c.key)
    for (const x of ended) {
      try {
        await appendOwn(ctx, diary, groupJoinRecord({ group: x.group, writer: x.own.key, on: false }))
      } catch {}
    }
    return { state: 'left' }
  }, async (p, { diary, base }) => {
    const own = p.own
    const core = own === null ? null : await readGroupCore(ctx, own.key)
    if (core === null || core.length === 0 || hasLeave(core.entries)) throw new UsageError(GROUP_UNCHANGED)
    // No fold yet: the leave can list only this device's writer.
    if (groupJoinHistory(base.ownEntries, p.group).some((j) => j.on && j.writer !== own.key)) throw new UsageError(COMMUNITY_LEAVE_WAIT)
    const record = buildRecord(() => grp.groupLeave({ seen: null, cuts: [{ writer: own.key, seq: core.length }] }))
    const seq = await appendToOwnGroupCore(ctx, own, record)
    await confirmLeave(ctx, diary, p.group, own.key, seq, record)
    await appendOwn(ctx, diary, groupJoinRecord({ group: p.group, writer: own.key, on: false }))
    return { state: 'left' }
  }, true)
}

// The group-leave community.leave writes in each held group of community C
// in the local list with a live own writer: the cuts of group.leave (every
// counted own writer at its local length; skipped when the creator's root
// would be left out).
async function plannedGroupLeaves (ctx, base, C, ownHex) {
  const out = []
  for (const e of await store.readGroupWriters(ctx.storage)) {
    if (e.kind === 'community') continue
    try {
      const g = await loadGroup(ctx, base, e.group)
      if (g === null || g.community !== C || statusOf(g, ownHex) !== 'member') continue
      const own = liveOwnWriter(g, ownHex)
      if (own === null || !g.built.writers.has(own.key)) continue
      const cuts = countedCuts(g, ownHex)
      if (g.cores.get(g.group).diary === ownHex && g.built.writers.has(g.group) && !cuts.some((x) => x.writer === g.group)) continue
      out.push({ group: g.group, own, cuts, seen: g.built.last, priv: g.private })
    } catch {}
  }
  return out
}

// The community named by the held root header of `group`, or null (root not
// held, forked, or no valid group header).
async function groupCommunityOf (ctx, group) {
  const root = await readGroupCore(ctx, groupKeyOf(group))
  if (root === null || root.length === 0 || root.fork !== 0) return null
  const h = root.entries[0].record
  return validateGroupHeader(h) === null && h.kind === 'group' ? h.community : null
}

// After a community write that may change who reads its private groups:
// every held private group of the community in the local list gets the
// key upkeep (afterKeyChange: history, or a rotation), best effort.
async function afterCommunityKeyChange (ctx, base, C, ownHex, change) {
  for (const e of await store.readGroupWriters(ctx.storage)) {
    if (e.kind === 'community') continue
    try {
      const g = await loadGroup(ctx, base, e.group)
      if (g !== null && g.private && g.community === C) await afterKeyChange(ctx, base, e.group, ownHex, change)
    } catch {}
  }
}

// An admit or ban with `group: null` in the own live community writer (the
// community root for its creator's device), by its creator or an admin.
async function communityModerate (ctx, community, make, keyChange) {
  return withCommunity(ctx, community, true, async ({ ownHex, base, c }) => {
    const cw = communityAuthority(c, ownHex)
    if (cw === null) throw new UsageError(COMMUNITY_FORBIDDEN)
    const record = make(c)
    await appendToOwnGroupCore(ctx, cw, record)
    await afterCommunityKeyChange(ctx, base, c.key, ownHex, keyChange(record))
    return { ok: true }
  })
}

function communityTarget (c, member) {
  const d = String(member).toLowerCase()
  if (d === c.built.creator || c.built.admins.has(d)) throw new UsageError(COMMUNITY_FORBIDDEN)
  return d
}

function communityAdmit (ctx, { community, member, on }) {
  return communityModerate(ctx, community, (c) => {
    const d = communityTarget(c, member)
    if (on === true) {
      // Only a request, or a member whose earlier admit missed a writer.
      const st = statusOf(c, d)
      if (st !== 'requested' && st !== 'member') throw new UsageError(GROUP_UNCHANGED)
      const history = c.joins.get(d)
      if (history === undefined || missingWriters(c, d, history)) throw new UsageError(COMMUNITY_ADMIT_WAIT)
    }
    return buildRecord(() => grp.communityAdmit({ group: null, member: d, on, cuts: cutsFor(c, d, on === true), seen: c.built.last }))
  }, grantKeyChange)
}

function communityBan (ctx, { community, member, on }) {
  return communityModerate(ctx, community, (c) => {
    const d = communityTarget(c, member)
    let lifts = null
    if (!on) {
      lifts = c.built.bans.get(d) || null
      if (lifts === null) throw new UsageError(GROUP_UNCHANGED)
    }
    return buildRecord(() => grp.communityBan({ group: null, member: d, on, cuts: cutsFor(c, d, !on), lifts, seen: c.built.last }))
  }, (record) => record.on === true ? { rotate: true } : { history: true })
}

// rpc.md 5.64: a confirmed leave of the creator ends the root's powers for
// good, so whatever the root appends after it the fold voids; refusing here
// keeps a returning creator from writing records that silently never count.
function requireRootAuthority (c) {
  if (c.built.rootAuthority !== true) throw new UsageError(COMMUNITY_FORBIDDEN)
}

// Whether C's root holds an `on: true` group-admin for `d`.
function everGranted (c, d) {
  return c.input.root.entries.some((e) => e && e.record && e.record.type === 'group-admin' && e.record.member === d && e.record.on === true)
}

// The community root as this device writes it: its creator, a member, with
// the root nonce kept in its entry, while the root still has authority.
function communityRootWriter (c, ownHex) {
  if (c.built.creator !== ownHex || statusOf(c, ownHex) !== 'member' || c.own === null || c.own.rootNonce === null) {
    throw new UsageError(COMMUNITY_FORBIDDEN)
  }
  requireRootAuthority(c)
  return { group: c.key, key: c.key, nonce: c.own.rootNonce, kind: 'community' }
}

// Whether C's creator, back after its root's powers ended, repairs C
// through its live community writer (owner decision, cycle 24): the fold
// counts such a meta or drop only while `cwDemote` holds.
function cwRepair (c, ownHex) {
  return c.built.creator === ownHex && c.built.rootAuthority !== true && c.built.cwDemote === true
}

// The live community writer a repair writes on, else the permission error.
function repairWriter (c, ownHex) {
  if (!cwRepair(c, ownHex) || statusOf(c, ownHex) !== 'member') throw new UsageError(COMMUNITY_FORBIDDEN)
  const w = liveOwnWriter(c, ownHex)
  if (w === null) throw new UsageError(COMMUNITY_FORBIDDEN)
  return w
}

// rpc.md 5.69: the creator's root, or its live community writer once the
// root's powers ended (cwRepair).
function communityMeta (ctx, { community, name, join }) {
  if (name === undefined && join === undefined) throw new UsageError(GROUP_UNCHANGED)
  return withCommunity(ctx, community, true, async ({ ownHex, c }) => {
    const fields = {
      name: name === undefined ? c.built.name : name,
      join: join === undefined ? c.built.join : join,
      seen: c.built.last
    }
    if (cwRepair(c, ownHex)) {
      await appendToOwnGroupCore(ctx, repairWriter(c, ownHex), buildRecord(() => grp.communityMetaCw(fields)))
    } else {
      await appendToOwnGroupCore(ctx, communityRootWriter(c, ownHex), buildRecord(() => grp.groupMeta(fields)))
    }
    return { ok: true }
  })
}

// rpc.md 5.72: C's creator as for communityMeta (the root, or its live CW
// once the root's powers ended), or an admin on its own live CW.
function communityInvitePolicy (ctx, { community, members }) {
  return withCommunity(ctx, community, true, async ({ ownHex, c }) => {
    if (c.built.memberInvite === members) throw new UsageError(GROUP_UNCHANGED)
    const record = buildRecord(() => grp.communityInvites({ group: null, on: members, seen: c.built.last }))
    let w
    if (c.built.creator === ownHex) w = cwRepair(c, ownHex) ? repairWriter(c, ownHex) : communityRootWriter(c, ownHex)
    else w = communityAuthority(c, ownHex)
    if (w === null) throw new UsageError(COMMUNITY_FORBIDDEN)
    await appendToOwnGroupCore(ctx, w, record)
    return { ok: true }
  })
}

// rpc.md 5.70: C's creator, back after its root's powers ended, takes group
// `group` off C's catalogue through its live community writer, or with
// `undo` puts a group it dropped back; the root itself keeps the catalogue
// while it has authority, so this is refused then.
function communityRemoveGroup (ctx, { community, group, undo = false }) {
  return withCommunity(ctx, community, true, async ({ ownHex, c }) => {
    const w = repairWriter(c, ownHex)
    const G = typeof group === 'string' && HEX64.test(group) ? group.toLowerCase() : null
    if (G === null) throw new UsageError(GROUP_UNCHANGED)
    if (G === c.built.general) throw new UsageError(GERAL_STAYS)
    const on = undo !== true
    if (on ? !c.built.groups.includes(G) : !c.built.dropped.includes(G)) throw new UsageError(GROUP_UNCHANGED)
    await appendToOwnGroupCore(ctx, w, buildRecord(() => grp.communityDrop({ group: G, on, seen: c.built.last })))
    return { ok: true }
  })
}

// -> { community, member, on }: a group-admin in the community root, by its
// creator only, with cuts over the member's counted community writers (on
// at max(contiguous, signed) length, off at the contiguous one).
async function communitySetAdmin (ctx, { community, member, on }) {
  return withCommunity(ctx, community, true, async ({ ownHex, base, c }) => {
    // A creator whose root lost authority (back after leaving C) can only
    // demote, through its live community writer (cycle 16).
    const rootGone = c.built.creator === ownHex && c.built.rootAuthority !== true
    if (rootGone && (on === true || statusOf(c, ownHex) !== 'member')) throw new UsageError(COMMUNITY_FORBIDDEN)
    if (rootGone && c.built.cwDemote !== true) throw new UsageError(DEMOTE_PENDING)
    const root = rootGone ? liveOwnWriter(c, ownHex) : communityRootWriter(c, ownHex)
    if (root === null) throw new UsageError(COMMUNITY_FORBIDDEN)
    const d = String(member).toLowerCase()
    if (d === c.built.creator) throw new UsageError(COMMUNITY_CREATOR)
    // A grant needs a member; a demotion works for any diary ever granted
    // (left or requested included), so a departed admin's grant never
    // outlives it as a shield against a ban.
    if (on === true && statusOf(c, d) !== 'member') throw new UsageError(COMMUNITY_MEMBER_NEEDED)
    if (on !== true && !everGranted(c, d)) throw new UsageError(GROUP_UNCHANGED)
    const cuts = countedCuts(c, d, on === true)
    if (cuts.length > MAX_GROUP_CUTS) throw new UsageError(COMMUNITY_FULL)
    await appendToOwnGroupCore(ctx, root, rootGone
      ? buildRecord(() => grp.communityDemote({ member: d, cuts, seen: c.built.last }))
      : buildRecord(() => grp.groupAdmin({ member: d, on: on === true, cuts, seen: c.built.last })))
    await afterCommunityKeyChange(ctx, base, c.key, ownHex, on === true ? { history: true } : { rotate: true })
    return { community: c.key, member: d, on: on === true }
  })
}

async function communityMembers (ctx, { community, offset = 0, limit = GROUP_MEMBERS_LIMIT_MAX } = {}) {
  return withCommunity(ctx, community, false, ({ base, c }) => {
    const list = [...c.built.members].filter(([, st]) => st === 'member' || st === 'banned')
    const members = list.slice(offset, offset + limit).map(([d, st]) => {
      const times = writerTimes(c, d)
      return {
        member: d,
        ...authorOf(c, d, base.association, base.mod),
        admin: c.built.admins.has(d),
        banned: st === 'banned',
        joinedAt: times.length > 0 ? times[0] : null
      }
    })
    return { members, total: list.length }
  })
}

async function communityRequests (ctx, { community, offset = 0, limit = GROUP_MEMBERS_LIMIT_MAX } = {}) {
  return withCommunity(ctx, community, false, ({ ownHex, base, c }) => {
    if (!isActingAdmin(c, ownHex)) throw new UsageError(COMMUNITY_FORBIDDEN)
    const list = c.built.requests
    const requests = list.slice(offset, offset + limit).map((d) => {
      const times = writerTimes(c, d)
      return { member: d, ...authorOf(c, d, base.association, base.mod), at: times.length > 0 ? times[times.length - 1] : null }
    })
    return { requests, total: list.length }
  })
}

const PREVIEW_MAX = 140
const READER_ROLES = new Set(['creator', 'admin', 'member'])
const UNREAD_MAX = 99

// The posts group.read lists, in causal order. A locked holder never opened
// a sealed envelope (foldWithKeys), so no sealed post is among them.
function readablePosts (g) {
  return g.built.posts.filter((p) => g.diaries.get(p.diary))
}

// The listed posts after a seen mark: after the marked post while it is
// still listed, else (gone after a sync) each post above it in group order,
// as groupRead's cursor.
function postsAfter (posts, mark) {
  if (mark === null) return posts
  const i = posts.findIndex((p) => p.writer === mark.writer && p.seq === mark.seq)
  if (i >= 0) return posts.slice(i + 1)
  const k = orderKey(mark.at, mark.writer, mark.seq)
  return posts.filter((p) => compareOrder(orderKey(p.at, p.writer, p.seq), k) > 0)
}

// A public descriptor or a private item that carries a voice note.
function isVoiceItem (d) {
  return d !== null && typeof d === 'object' && (typeof d.plainMime === 'string' ? d.plainMime : d.mime) === AUDIO_MIME
}

// A photo or voice post without text still says what it is in the list row.
function previewOf (p) {
  if (p.text === '' && Array.isArray(p.media) && p.media.length > 0) {
    if (p.media.some(isVoiceItem)) return 'Áudio'
    return p.media.every((d) => (typeof d.plainMime === 'string' ? d.plainMime : d.mime) === 'image/gif') ? 'GIF' : 'Foto'
  }
  return Array.from(p.text).slice(0, PREVIEW_MAX).join('')
}

// rpc.md 5.59: a reader row's newest listed post and the others' posts after
// this device's mark (own and hidden ones not counted).
function lastAndUnread (g, base, mark) {
  const posts = readablePosts(g)
  if (posts.length === 0) return { last: null, unread: 0 }
  const p = posts[posts.length - 1]
  const { name, username } = authorOf(g, p.diary, base.association, base.mod)
  const last = {
    name,
    username,
    preview: p.hidden ? '' : previewOf(p),
    at: p.at,
    mine: p.diary === base.ownHex,
    hidden: p.hidden
  }
  let unread = 0
  for (const q of postsAfter(posts, mark)) {
    if (q.diary === base.ownHex || q.hidden) continue
    if (++unread >= UNREAD_MAX) break
  }
  return { last, unread }
}

const PENDING_COMMUNITY = { name: null, join: null, creator: null, role: 'pending', state: 'pending', members: 0, admins: 0, groups: [], general: null, incomplete: true, leavePending: false, repair: false, dropped: [], memberInvite: false, writerHere: false, canWrite: false, rootHere: false, authorityHere: false, writersBound: 0, generalWritersBound: 0 }

// rpc.md 5.59. A root not held yet is pending; a held root that is no
// community root is NOT_FOUND. Each catalogue row names its root when held.
async function communityInfo (ctx, { community }) {
  const C = communityKeyOf(community)
  // A read never writes: a community.create planned here and not finished
  // reads as pending (only community.create resumes it, through the write
  // path and its gate).
  const planned = await store.readCommunityCreate(ctx.storage)
  if (planned !== null && planned.community === C) {
    const entry = (await store.readGroupWriters(ctx.storage)).find((e) => e.group === C)
    return {
      community: C,
      ...PENDING_COMMUNITY,
      writerHere: entry !== undefined,
      canWrite: false,
      rootHere: entry !== undefined && entry.rootNonce !== null
    }
  }
  return withCommunity(ctx, C, false, async ({ ownHex, base, c }) => {
    const seen = await store.readGroupSeen(ctx.storage)
    const keys = diaryGroupKeys(base.ownEntries)
    const groups = []
    for (const key of c.built.groups.slice(0, MAX_GROUPS_PER_COMMUNITY)) {
      const g = await loadGroup(ctx, base, key)
      const role = g === null ? null : roleHere(g, ownHex, base, keys)
      groups.push({
        group: key,
        name: g === null ? null : g.built.name,
        visibility: g === null ? null : (g.private ? 'private' : 'public'),
        join: g === null ? null : g.built.join,
        role,
        general: key === c.built.general,
        ...(READER_ROLES.has(role) ? lastAndUnread(g, base, seen.find((m) => m.group === key) || null) : { last: null, unread: 0 })
      })
    }
    // Geral's slots are spent by the same tap (community.join also joins it),
    // so the app's reserve warning needs its count too.
    // From the own diary's joins, as diaryBound counts them: Geral's root
    // need not be here for the slots the account already spent in it.
    const generalBound = c.built.general ? new Set(groupJoinHistory(base.ownEntries, c.built.general).filter((j) => j.on === true).map((j) => j.writer)).size : 0
    return {
      community: C,
      name: c.built.name,
      join: c.built.join,
      creator: c.built.creator,
      role: roleHere(c, ownHex, base, keys),
      state: 'ready',
      members: memberCount(c),
      admins: c.built.admins.size,
      groups,
      general: c.built.general,
      incomplete: c.built.incomplete,
      leavePending: await notedLeavePending(ctx, c, ownHex, base.ownEntries),
      repair: cwRepair(c, ownHex) && statusOf(c, ownHex) === 'member' && liveOwnWriter(c, ownHex) !== null,
      dropped: [...c.built.dropped],
      memberInvite: c.built.memberInvite === true,
      writerHere: c.own !== null,
      canWrite: countedLive(c, ownHex),
      rootHere: c.own !== null && c.own.rootNonce !== null,
      authorityHere: c.own !== null && c.built.authorityWriters instanceof Set && c.built.authorityWriters.has(c.own.key),
      writersBound: diaryBound(c, ownHex),
      generalWritersBound: generalBound
    }
  }, (p) => ({ community: p.group, ...PENDING_COMMUNITY, writerHere: p.own !== null }))
}

const ROLE_RANK = { creator: 0, admin: 1, member: 2 }

// Creator, admin, member, then the rest; within each by name (null last),
// then by key.
function compareCommunities (a, b) {
  const ra = a.role in ROLE_RANK ? ROLE_RANK[a.role] : 3
  const rb = b.role in ROLE_RANK ? ROLE_RANK[b.role] : 3
  if (ra !== rb) return ra - rb
  if (a.name !== b.name) {
    if (a.name === null) return 1
    if (b.name === null) return -1
    return a.name < b.name ? -1 : 1
  }
  return a.community < b.community ? -1 : a.community > b.community ? 1 : 0
}

// -> { communities }: rpc.md 5.62, every community in kv groupWriters.
async function communityList (ctx) {
  return withCommunityBase(ctx, false, async ({ ownHex, base }) => {
    const list = []
    for (const e of await store.readGroupWriters(ctx.storage)) {
      if (e.kind !== 'community' || base.mod.blocked.has(e.group)) continue
      const c = await loadCommunity(ctx, base, e.group)
      if (c === null) {
        if (await heldLength(ctx, e.group) > 0) continue
        list.push({ community: e.group, name: null, join: null, state: 'pending', role: 'pending', general: null })
        continue
      }
      list.push({
        community: e.group,
        name: typeof c.built.name === 'string' ? c.built.name : null,
        join: c.built.join,
        state: 'ready',
        role: roleOf(c, ownHex),
        general: c.built.general
      })
    }
    const listed = new Set(list.map((r) => r.community))
    for (const e of await store.readGroupWriters(ctx.storage)) listed.add(e.group)
    for (const key of diaryGroupKeys(base.ownEntries)) {
      if (listed.has(key) || base.mod.blocked.has(key)) continue
      const c = await loadCommunity(ctx, base, key)
      if (c === null) continue
      // A held root folds: state stays 'ready' (the name shows); only the
      // role says the account's writers are still arriving.
      list.push({
        community: key,
        name: typeof c.built.name === 'string' ? c.built.name : null,
        join: c.built.join,
        state: 'ready',
        role: writersStillArriving(c, ownHex, base.mod) ? 'pending' : roleOf(c, ownHex),
        general: c.built.general
      })
    }
    return { communities: list.sort(compareCommunities).slice(0, COMMUNITY_LIST_MAX) }
  })
}

// The groups of the local list whose root header names `community` (the
// groups.changed of a community write); [] when none or on any error.
async function communityGroups (ctx, { community }) {
  try {
    const C = communityKeyOf(community)
    const out = []
    for (const e of await store.readGroupWriters(ctx.storage)) {
      if (e.kind === 'community') continue
      const root = await readGroupCore(ctx, e.group)
      const h = root === null || root.length === 0 ? null : root.entries[0].record
      if (h !== null && typeof h === 'object' && h.community === C) out.push(e.group)
    }
    return out
  } catch {
    return []
  }
}

// ---- device upkeep (docs/rpc.md 5.61 and 5.63, browser node only) ----

// The automatic enrolment of a second device stops while the diary binds
// MAX_GROUP_WRITERS_PER_DIARY - AUTO_ENROL_RESERVE writers in a root: the
// seeder never releases a bound slot, so the last two are spent only by an
// explicit tap (owner decision).
const AUTO_ENROL_RESERVE = 2

function autoEnrolRoom (fold, ownHex) {
  if (groupWritersFull(fold)) return 'full'
  if (diaryBound(fold, ownHex) >= MAX_GROUP_WRITERS_PER_DIARY - AUTO_ENROL_RESERVE) return 'reserve'
  return null
}

// A diary the fold counts as a member here and whose writers bind in it:
// writers still arriving, left, banned, requested or a blocked own diary
// all wait for an explicit join.
function autoEnrolStatus (fold, ownHex) {
  return statusOf(fold, ownHex) === 'member' && !fold.built.bans.has(ownHex) && fold.diaries.get(ownHex) !== null
}

// A group writer counts only when its community writer is admitted
// (admittedCws): a CW waiting for an admin would leave a new group writer
// that counts only if an admin ever admits it, a slot spent meanwhile. A
// community this plan enrols first gets a CW the fold admits at once only
// when it is open or the diary created it. Geral follows the same rule: the
// upkeep joins it as a group, never through community.join's Geral step.
function parentAdmits (c, ownHex, planned) {
  const admitted = c.built.admittedCws instanceof Set ? c.built.admittedCws : new Set()
  if (planned) return c.built.join === 'open' || c.built.creator === ownHex
  const cw = liveOwnWriter(c, ownHex)
  return cw !== null && statusOf(c, ownHex) === 'member' && admitted.has(cw.key)
}

// Skip reasons a later sync can resolve (the root, its parent, the
// creator's binding or the unlock arrives); the others need a change by
// a person (an explicit tap, an admin) or never resolve.
const TRANSIENT_SKIPS = new Set(['community-first', 'unheld', 'creator-unbound', 'locked'])

function skip (root, reason) {
  return { root, reason, transient: TRANSIENT_SKIPS.has(reason) }
}

// Whether the own diary ever bound `writer` in `root` (an on:true join).
function diaryBinds (ownEntries, root, writer) {
  return groupJoinHistory(ownEntries, root).some((j) => j.on === true && j.writer === writer)
}

// -> { enrol: [{ root, kind, community, repair? }], share: [{ group,
// writer }], skipped: [{ root, reason, transient }] }, read-only. A
// hand-off the write step would refuse (an orphan, a parent not held or
// blocked, blocks that would not fit the log) is skipped, not planned. Candidates are only
// the roots the own diary binds now (a held key with no join of the diary,
// from an opened link or a catalogue probe, never is) that this device has
// no kv entry for: a device that wrote a writer there once is never
// enrolled again, so an approval community never gets a second CW while
// the first waits for an admin. The one exception is a repair: a listed
// writer the own diary never bound (the diary append of an earlier join
// failed after the kv entry was written). The join reuses that writer
// (ownPending) only when this device derives its key ('foreign'
// otherwise), and binding it spends a slot like a new writer would (the
// seeder never saw it), so the reserve applies the same way.
async function deviceUpkeepPlan (ctx) {
  return withCommunityBase(ctx, false, async ({ ownHex, base }) => {
    const entries = await store.readGroupWriters(ctx.storage)
    const listed = new Map(entries.map((e) => [e.group, e]))
    const enrol = []
    const skipped = []
    const groups = []
    const repairs = new Set()
    for (const key of diaryGroupKeys(base.ownEntries)) {
      if (base.mod.blocked.has(key)) continue
      const entry = listed.get(key)
      if (entry !== undefined) {
        if (diaryBinds(base.ownEntries, key, entry.key)) continue
        // Only a writer this device derives is reused by the join.
        if (groupKeyPairOf(ctx) === null) {
          skipped.push(skip(key, 'locked'))
          continue
        }
        if (!(await ownWriterDerived(ctx, entry))) {
          skipped.push(skip(key, 'foreign'))
          continue
        }
        repairs.add(key)
      }
      const c = await loadCommunity(ctx, base, key)
      if (c === null) {
        groups.push(key)
        continue
      }
      // communityJoin would take the pendingJoin branch for an unbound
      // creator: a generation 0 CW any earlier leave retires.
      let reason = c.built.creator === null ? 'creator-unbound' : null
      if (reason === null && (!autoEnrolStatus(c, ownHex) || liveOwnWriter(c, ownHex) !== null)) reason = 'status'
      if (reason === null) reason = autoEnrolRoom(c, ownHex)
      if (reason === null) enrol.push({ root: key, kind: 'community', community: null, ...(repairs.has(key) ? { repair: true } : {}) })
      else skipped.push(skip(key, reason))
    }
    // Groups after every community: the write pass enrols communities first.
    const planned = new Set(enrol.map((x) => x.root))
    for (const key of groups) {
      const g = await loadGroup(ctx, base, key)
      let reason = null
      if (g === null) reason = 'unheld'
      else if (g.built.orphan) reason = 'orphan'
      else if (g.community === null || g.c === null) reason = 'community-first'
      else if (!autoEnrolStatus(g, ownHex) || liveOwnWriter(g, ownHex) !== null) reason = 'status'
      if (reason === null) reason = autoEnrolRoom(g, ownHex)
      if (reason === null && g.private && boxHexOf(ctx) === null) reason = 'locked'
      if (reason === null && !parentAdmits(g.c, ownHex, planned.has(g.community))) reason = 'community-first'
      if (reason === null) enrol.push({ root: key, kind: 'group', community: g.community, ...(repairs.has(key) ? { repair: true } : {}) })
      else skipped.push(skip(key, reason))
    }
    const share = []
    for (const e of entries) {
      if (e.kind === 'community') continue
      const g = await loadGroup(ctx, base, e.group)
      if (g === null || !g.private) continue
      const own = distributorOf(g, ownHex)
      const records = own === null ? null : historyPlan(ctx, g, ownHex)
      if (records === null) continue
      // The refusals of the write step (withGroup's requireParent, then
      // shareHistory's checkRotationRoom).
      let reason = null
      if (g.built.orphan) reason = 'orphan'
      else if (g.built.community === null || g.c === null) reason = 'community-first'
      else {
        const fits = await rotationFits(ctx, own.key, records)
        if (fits === null) continue
        if (!fits) reason = 'full'
      }
      if (reason === null) share.push({ group: e.group, writer: own.key })
      else skipped.push(skip(e.group, reason))
    }
    return { enrol, share, skipped }
  })
}

// True when the own diary binds a root this device has no diary-bound own
// writer for, exactly the enrol and repair candidates of deviceUpkeepPlan,
// ignoring moderation: it may answer true for a blocked root, never false
// when the plan could enrol. It cannot see the distributor share step, so
// a false answer means no enrol and no repair, not an empty share list.
// The session decides when the full plan runs. Only the own diary and the
// kv writer list are read: a second Hypercore on a group core the live
// sync holds would corrupt it (see withIdentity).
async function deviceUpkeepNeeded (ctx) {
  return withIdentity(ctx, async ({ diary }) => {
    const entries = await store.readAll(diary)
    const listed = new Map((await store.readGroupWriters(ctx.storage)).map((e) => [e.group, e]))
    for (const key of diaryGroupKeys(entries)) {
      const entry = listed.get(key)
      if (entry === undefined || !diaryBinds(entries, key, entry.key)) return true
    }
    return false
  })
}

function upkeepKeys (list, field) {
  const out = new Set()
  for (const x of Array.isArray(list) ? list : []) {
    const k = typeof x === 'string' ? x : (x !== null && typeof x === 'object' ? x[field] : null)
    if (typeof k === 'string') out.add(k.toLowerCase())
  }
  return out
}

function isLocked (err) {
  return !!err && err.message === store.LOCKED
}

async function coreLength (ctx, key) {
  if (typeof key !== 'string') return null
  return withGroupCore(ctx, key, async (core) => core.length)
}

// What a step on `root` can leave behind when it throws half way: the own
// diary's length, this device's kv writer for the root and the length of
// `writer` (default: that kv writer).
async function upkeepFootprint (ctx, root, writer = null) {
  const length = await withIdentity(ctx, async ({ diary }) => diary.length)
  const entry = (await store.readGroupWriters(ctx.storage)).find((e) => e.group === root)
  const own = entry === undefined ? null : entry.key
  const key = writer === null ? own : writer
  return [length, own, key, await coreLength(ctx, key)].join(':')
}

// -> { enrolled: [{ root, kind, state, group }], shared, failed: [{ root,
// message }], changed }. The plan is computed again first: a sync may have
// run since the caller's plan, so only the keys both name are acted on.
// One root's failure goes to `failed` (and to `changed` when it wrote
// something first); a group whose community failed in this call is not
// tried. Only a missing or locked identity, or NEEDS_EXCLUSIVE, throws.
// Nothing is retried here: the caller plans again after the next change.
async function deviceUpkeep (ctx, { enrol = [], share = [] } = {}) {
  needGroupKeys(ctx)
  const wanted = upkeepKeys(enrol, 'root')
  const wantedShare = upkeepKeys(share, 'group')
  const plan = await deviceUpkeepPlan(ctx)
  const enrolled = []
  const shared = []
  const failed = []
  const changed = new Set()
  const attempt = async (root, fn, writer = null) => {
    const before = await upkeepFootprint(ctx, root, writer)
    try {
      await fn()
      return true
    } catch (err) {
      if (isNeedsExclusive(err) || isLocked(err)) throw err
      failed.push({ root, message: err && typeof err.message === 'string' ? err.message : String(err) })
      if (await upkeepFootprint(ctx, root, writer) !== before) changed.add(root)
      return false
    }
  }
  const todo = plan.enrol.filter((x) => wanted.has(x.root))
  const failedCommunities = new Set()
  for (const x of todo.filter((x) => x.kind === 'community')) {
    const ok = await attempt(x.root, async () => {
      const r = await communityJoin(ctx, { community: x.root }, { general: false })
      enrolled.push({ root: x.root, kind: 'community', state: r.state, group: null })
      changed.add(x.root)
    })
    if (!ok) failedCommunities.add(x.root)
  }
  for (const x of todo.filter((x) => x.kind === 'group' && !failedCommunities.has(x.community))) {
    await attempt(x.root, async () => {
      const r = await groupJoin(ctx, { group: x.root, community: x.community })
      enrolled.push({ root: x.root, kind: 'group', state: r.state, group: null })
      changed.add(x.root)
    })
  }
  for (const x of plan.share.filter((x) => wantedShare.has(x.group))) {
    await attempt(x.group, async () => {
      const had = await withGroup(ctx, x.group, true, async ({ ownHex, g }) => {
        const before = historyPlan(ctx, g, ownHex) !== null
        await shareHistory(ctx, g, ownHex)
        return before
      })
      if (had) {
        shared.push(x.group)
        changed.add(x.group)
      }
    }, x.writer)
  }
  return { enrolled, shared, failed, changed: [...changed] }
}

// ---- direct messages (docs/protocol.md section 11) ----

// The newest valid dm-key of a diary's entries ({ seq, record }): highest
// gen, ties by highest seq; a weak box key is invalid (records.js). ->
// { box, gen, seq } | null.
function newestDmKey (entries) {
  let best = null
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e === null || typeof e !== 'object' || e.record === null || typeof e.record !== 'object') continue
    if (e.record.type !== 'dm-key' || validateRecord(e.record, e.seq) !== null) continue
    if (best === null || e.record.gen > best.gen || (e.record.gen === best.gen && e.seq > best.seq)) {
      best = { box: e.record.box, gen: e.record.gen, seq: e.seq }
    }
  }
  return best
}

// Readers that hold no complete replica find a dm-key by a bounded
// newest-first scan (the session's dmLookupOf, 8 windows of 36 seqs), so the
// owner keeps its newest dm-key within the newest DM_KEY_REFRESH_BLOCKS
// blocks of its diary: an older one is appended again, same box and gen (a
// refresh, not a rotation).
const DM_KEY_REFRESH_BLOCKS = 256

function dmKeyCurrent (current, length, { box, gen }) {
  return current !== null && current.box === box && current.gen === gen && current.seq >= length - DM_KEY_REFRESH_BLOCKS
}

// Whether dmKeyEnsure would append (no write gate, nothing written).
async function dmKeyStale (ctx, { box, gen }) {
  return withIdentity(ctx, async ({ diary }) => {
    if (diary.length === 0) return false
    return !dmKeyCurrent(newestDmKey(await store.readAll(diary)), diary.length, { box, gen })
  })
}

// Appends a dm-key for { box, gen } unless the diary's newest valid one is
// exactly that and recent (the caller ran the write gate). -> { box, gen,
// seq | null }.
async function dmKeyEnsure (ctx, { box, gen }) {
  if (!isHex64(box) || !Number.isSafeInteger(gen) || gen < 1) throw new TypeError('chave de caixa inválida')
  return withIdentity(ctx, async ({ diary }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const current = newestDmKey(await store.readAll(diary))
    if (dmKeyCurrent(current, diary.length, { box, gen })) return { box, gen, seq: null }
    const seq = await appendOwn(ctx, diary, { type: 'dm-key', box, gen, at: nowIso() })
    return { box, gen, seq }
  })
}

// The newest dm-key of `member` from local data: the own diary or a stored
// replica. -> { box, gen } (box null only for the own diary without one), or
// null when no stored replica holds a dm-key in what it has read (a replica
// may still be backfilling: the session then peeks, never answers "none"
// from a partial replica).
// A public read: it needs no identity or key pair, and it never deletes
// anything (an empty replica is left to the sync's own sweep).
async function dmLookup (ctx, member) {
  const key = String(member).toLowerCase()
  const cores = borrowedCores(ctx)
  let own = null
  if (cores !== null && hex(cores.diary.key) === key) {
    own = await readBorrowed(cores.diary, (d) => store.readAll(d))
  } else if (cores === null) {
    const status = await store.diaryStatus(ctx.storage)
    if (status.exists && status.publicKey === key) {
      const diary = await store.openDiary(ctx.storage)
      try { own = await store.readAll(diary) } finally { await diary.close() }
    }
  }
  if (own !== null) {
    const best = newestDmKey(own)
    return best === null ? { box: null, gen: null } : { box: best.box, gen: best.gen }
  }
  let entries
  const borrowed = cores === null ? null : cores.replica(key)
  if (borrowed !== null) {
    entries = await readBorrowed(borrowed, async (core) => (await store.readVisible(core)).entries)
  } else {
    if (!(await store.replicaExists(ctx.storage, key))) return null
    if (cores !== null) throw needsExclusive()
    const replica = await store.openReplica(ctx.storage, key)
    try { entries = (await store.readVisible(replica)).entries } finally { await replica.close() }
  }
  const best = newestDmKey(entries)
  return best === null ? null : { box: best.box, gen: best.gen }
}

module.exports = {
  newestDmKey,
  dmKeyEnsure,
  dmKeyStale,
  DM_KEY_REFRESH_BLOCKS,
  dmLookup,
  GENESIS_REQUIRED,
  GROUP_NOT_FOUND,
  GROUP_FORBIDDEN,
  GROUP_UNCHANGED,
  COMMUNITY_NOT_FOUND,
  deepEqual,
  trustRoot,
  withIdentity,
  moderation,
  idCreate,
  idShow,
  identityState,
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
  ownEntries,
  ownNoticeContext,
  followAdd,
  followRemove,
  followList,
  followChange,
  queueFollowChange,
  followOpPayload,
  signFollowOp,
  verifyFollowOp,
  drainFollows,
  legacyFollows,
  confirmLegacyFollows,
  foldFollows,
  mediaPrepare,
  mediaCommit,
  mediaCommitAudio,
  mediaCommitSealed,
  declareMediaCore,
  verifyMedia,
  logRead,
  logReadRaw,
  feedRead,
  profileRead,
  skipReason,
  groupCreate,
  groupJoin,
  groupLeave,
  groupPost,
  groupHide,
  groupBan,
  groupAdmit,
  groupAdmin,
  groupMeta,
  groupInvitePolicy,
  groupRekey,
  canSealTo,
  groupRead,
  groupList,
  groupInfo,
  groupMembers,
  groupRequests,
  communityCreate,
  communityInfo,
  groupSeen,
  communityList,
  communitySetAdmin,
  communityJoin,
  communityLeave,
  communityMembers,
  communityRequests,
  communityAdmit,
  communityBan,
  communityMeta,
  communityInvitePolicy,
  communityRemoveGroup,
  communityGroups,
  groupCommunityOf,
  deviceUpkeepPlan,
  deviceUpkeepNeeded,
  deviceUpkeep,
  AUTO_ENROL_RESERVE,
  isNeedsExclusive,
  needsExclusive
}
