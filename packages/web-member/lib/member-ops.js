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
  MAX_MEDIA_ITEM_BLOCKS
} = require('@varanda/core/lib/records')
const { validateDescriptor, validateMediaHeader, latestMediaCores, followSet, hasFollowRecords } = require('@varanda/core/lib/media')
const { latestUsername, heldUsernames } = require('@varanda/core/lib/username')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { buildFeed } = require('@varanda/core/lib/feed')
const { applyDeletes, deletedSeqs, liveMediaRefs, overlaps, clearDeleted, presentLength } = require('@varanda/core/lib/deletion')
const { engagementState, isLiked, isReposted } = require('@varanda/core/lib/engagement')
const { verifySnapshot, blockedSet, revokedIssuerSet } = require('@varanda/core/lib/blocklist')
const { UsageError } = require('@varanda/core/lib/errors')
const { stillImageSize } = require('@varanda/core/lib/still-image')
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

// Borrowed path (reads only): ctx.cores = { diary, replica(key) } are the
// cores the live sync run holds (./sync.js reader). A second Hypercore on
// the same files would corrupt them, and closing or purging one would pull
// it from under the run, so they are read in place and never closed or
// purged (the run sweeps empty replicas). Whenever this path cannot give
// exactly the exclusive path's answer (a stored replica the run does not
// hold, a core closed or failing under the read) it throws NEEDS_EXCLUSIVE
// and the session reruns the request exclusively.
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

async function postCreate (ctx, { text, media }) {
  if (hasMedia(media)) await verifyMedia(ctx, media)
  return publish(ctx, buildRecord(() => postRecord(hasMedia(media) ? { text, media } : { text })))
}

// to is the parsed { author, seq } reference.
async function postReply (ctx, { to, text, media }) {
  if (!(to.seq >= 1)) throw new UsageError('referência inválida')
  if (hasMedia(media)) await verifyMedia(ctx, media)
  return publish(ctx, buildRecord(() => postRecord(hasMedia(media) ? { text, replyTo: to, media } : { text, replyTo: to })))
}

// to is the parsed { author, seq } reference of the quoted post; media as
// for a reply.
async function postQuote (ctx, { to, text, media }) {
  if (!(to.seq >= 1)) throw new UsageError('referência inválida')
  if (hasMedia(media)) await verifyMedia(ctx, media)
  return publish(ctx, buildRecord(() => postRecord(hasMedia(media) ? { text, quote: to, media } : { text, quote: to })))
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
  if (record.type === 'post') return Array.isArray(record.media) ? record.media : []
  return record.avatar !== undefined ? [record.avatar] : []
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
async function verifyMedia (ctx, media, inspect = null) {
  if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_PER_POST) throw badMedia()
  const own = new Set(await store.readMediaCores(ctx.storage))
  const { ownHex, declared } = await withIdentity(ctx, async ({ diary, ownHex }) => ({
    ownHex,
    declared: new Set(latestMediaCores(await store.readAll(diary), ownHex).map((c) => c.key))
  }))
  for (const descriptor of media) {
    if (validateDescriptor(descriptor) !== null) throw badMedia()
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
    return store.withFollowsLock(ctx.storage, async () => {
      const current = await store.readFollows(ctx.storage)
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
        const pending = (await store.readFollowsPending(ctx.storage)).filter((op) => op.key !== key)
        pending.push(signFollowOp({ key, on: follow, at: nowIso() }, ownHex, keyPair))
        await store.writeFollowsPending(ctx.storage, pending.slice(-(MAX_INVENTORY - 1)))
      }
      await store.writeFollows(ctx.storage, next)
      return { follows: await store.readFollows(ctx.storage), changed: true }
    })
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
// diário' without creating anything; an empty replica is purged (D).
async function readReplica (ctx, key) {
  const read = HEX64.test(key) ? await withReplica(ctx, key, async (core) => ({ entries: await store.readAll(core), fork: core.fork })) : null
  if (read === null) throw new Error('sem dados locais para este diário')
  return read
}

async function logRead (ctx, { author = null } = {}) {
  const own = await withIdentity(ctx, async ({ diary, ownHex, association }) => ({ key: ownHex, association, entries: author && author !== ownHex ? null : await store.readAll(diary) }))
  if (own.entries !== null) return { key: own.key, entries: own.entries }
  // The rule of skipReason: a blocked diary, or one whose block-0
  // certificate comes from a revoked issuer, reads as absent (the same
  // error, never why), even before a sync run purges it and whatever its
  // follow state.
  const key = String(author).toLowerCase()
  const mod = await moderation(ctx.storage, own.association)
  if (mod.blocked.has(key)) throw new Error('sem dados locais para este diário')
  const read = await readReplica(ctx, key)
  const entries = read.entries
  // A snapshot adopted during the read (the run is live) decides the answer.
  const final = await moderation(ctx.storage, own.association)
  // A fork is not refused here (nor on the exclusive path); a closed core is.
  forkNow(read)
  if (final.blocked.has(key)) throw new Error('sem dados locais para este diário')
  if (final.revokedIssuers.size > 0 && revokedIssuerOf(entries, key, own.association, final.revokedIssuers)) {
    throw new Error('sem dados locais para este diário')
  }
  return { key: author, entries }
}

// Whether the log's block-0 certificate fails only because its issuer is
// revoked.
function revokedIssuerOf (entries, key, association, revokedIssuers) {
  const first = entries.length > 0 ? entries[0].record : null
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
      const { entries, present } = await store.readVisible(core)
      return { entries, fork: core.fork, behind: core.length > present }
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
    if (reason === null) kept.push({ key, entries: read.entries })
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

module.exports = {
  GENESIS_REQUIRED,
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
  followOpPayload,
  signFollowOp,
  verifyFollowOp,
  drainFollows,
  legacyFollows,
  confirmLegacyFollows,
  foldFollows,
  mediaPrepare,
  mediaCommit,
  declareMediaCore,
  verifyMedia,
  logRead,
  feedRead,
  profileRead,
  skipReason,
  isNeedsExclusive
}
