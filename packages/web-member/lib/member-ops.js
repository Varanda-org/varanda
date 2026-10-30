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
  profileRecord,
  postRecord,
  mediaCoreRecord,
  followRecord,
  groupJoinRecord,
  likeRecord,
  repostRecord,
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
const { latestUsername } = require('@varanda/core/lib/username')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { buildFeed } = require('@varanda/core/lib/feed')
const { engagementState, isLiked, isReposted } = require('@varanda/core/lib/engagement')
const { verifySnapshot, blockedSet, revokedIssuerSet } = require('@varanda/core/lib/blocklist')
const { UsageError } = require('@varanda/core/lib/errors')
const grp = require('@varanda/core/lib/group')
const { GROUP_LIMIT_DEFAULT, GROUP_MEMBERS_LIMIT_MAX } = require('@varanda/rpc')
const store = require('./node-store')

const {
  buildGroup, groupJoinHistory, validateGroupHeader, validateWriterHeader,
  orderKey, compareOrder, MAX_GROUPS_PER_DIARY, MAX_GROUP_CUTS, MAX_GROUP_WRITERS_PER_DIARY
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

async function profileSet (ctx, { name, bio }) {
  const record = buildRecord(() => profileRecord({ name, bio: bio || '' }))
  const { seq } = await publish(ctx, record)
  return { seq }
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
// block local and the bytes matching; else 'mídia inválida'.
async function verifyMedia (ctx, media) {
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
  const own = await withIdentity(ctx, async ({ diary, ownHex, association }) => ({ key: ownHex, association, entries: author && author !== ownHex ? null : await store.readAll(diary) }))
  if (own.entries !== null) return { key: own.key, entries: own.entries }
  // The rule of skipReason: a blocked diary, or one whose block-0
  // certificate comes from a revoked issuer, reads as absent (the same
  // error, never why), even before a sync run purges it and whatever its
  // follow state.
  const key = String(author).toLowerCase()
  const mod = await moderation(ctx.storage, own.association)
  if (mod.blocked.has(key)) throw new Error('sem dados locais para este diário')
  const entries = await readReplica(ctx, key)
  if (mod.revokedIssuers.size > 0 && revokedIssuerOf(entries, key, own.association, mod.revokedIssuers)) {
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
  const kept = [own]
  const skipped = []
  const seen = new Set([own.key])
  for (const raw of await store.readFollows(ctx.storage)) {
    if (typeof raw !== 'string' || !HEX64.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    // Hidden before any read, whether or not its purge already ran.
    if (mod.blocked.has(key)) {
      skipped.push({ key, reason: 'blocked' })
      continue
    }
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
      reason = skipReason(replica, entries, key, association, mod)
      empty = replica.contiguousLength === 0
    } finally {
      await replica.close()
    }
    // An empty core must not linger in the storage.
    if (empty) await store.purgeReplica(ctx.storage, key)
    if (reason === null) kept.push({ key, entries })
    else skipped.push({ key, reason })
  }
  const built = buildFeed({ logs: kept, limit: limit || Infinity, association, revokedIssuers: mod.revokedIssuers, before })
  return { items: built.items, skipped, future: built.future }
}

// ---- profile.read ----

// The entries of a non-own diary when feedRead would show it, else null:
// the admission rules of feedRead (blocked, no local data, skipReason), not
// those of logRead. Never creates a replica; an empty one is purged.
async function admittedEntries (ctx, key, association, mod) {
  if (mod.blocked.has(key)) return null
  if (!(await store.replicaExists(ctx.storage, key))) return null
  const replica = await store.openReplica(ctx.storage, key)
  let entries
  let reason
  let empty
  try {
    entries = await store.readAll(replica)
    reason = skipReason(replica, entries, key, association, mod)
    empty = replica.contiguousLength === 0
  } finally {
    await replica.close()
  }
  if (empty) await store.purgeReplica(ctx.storage, key)
  return reason === null ? entries : null
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
  const profiles = []
  const missing = []
  for (const key of keys) {
    const entries = key === own.key ? own.entries : (HEX64.test(key) ? await admittedEntries(ctx, key, association, mod) : null)
    if (entries === null) {
      missing.push(key)
      continue
    }
    const profile = latestProfile(entries)
    profiles.push({
      author: key,
      name: profile === null ? null : profile.name,
      bio: profile === null ? null : profile.bio,
      username: latestUsername(entries, key, association, { revokedIssuers: mod.revokedIssuers })
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

async function appendToOwnGroupCore (ctx, entry, record) {
  const core = await openOwnGroupCore(ctx, entry)
  try {
    return await store.appendGroupRecord(core, record, { root: entry.key === entry.group, limits: ctx.limits })
  } finally {
    await core.close()
  }
}

// A stored group core's entries, read-only -> { entries, length, fork } or null.
async function readGroupCore (storage, key) {
  const core = await store.openGroupCoreReadOnly(storage, key)
  if (core === null) return null
  try {
    return { entries: await store.readAll(core), length: core.contiguousLength, signed: core.length, fork: core.fork }
  } finally {
    await core.close()
  }
}

// A stored writer core of `group` -> { entries, length, fork, header } or
// null. Block 0 is decoded first so the cores of other groups are never read
// in full: every operation on one group would otherwise decode every group
// core this device holds.
async function readWriterCoreOf (storage, key, group) {
  const core = await store.openGroupCoreReadOnly(storage, key)
  if (core === null) return null
  try {
    if (core.contiguousLength === 0 || core.fork !== 0) return null
    let h = null
    try {
      h = decodeBlock(await core.get(0, { wait: false, raw: true }))
    } catch {}
    if (validateWriterHeader(h) !== null || h.group !== group) return null
    return { entries: await store.readAll(core), length: core.contiguousLength, signed: core.length, fork: core.fork }
  } finally {
    await core.close()
  }
}

// This version folds only public groups: a crafted private or community
// root would take a kv groupWriters slot and never fold.
function foldableHeader (h) {
  return validateGroupHeader(h) === null && h.kind === 'group' && h.visibility === 'public'
}

// A stored root that will never fold (its block 0 is no public group
// header): its kv groupWriters entry may give up its slot.
async function rootUnfoldable (storage, group) {
  const root = await readGroupCore(storage, group)
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
  return joinedCounted(history, d, g.cores.get(g.group).diary, g.group).some((w) => !held.has(w))
}

function hasLeave (entries) {
  return entries.some(({ seq, record }) => seq >= 1 && record !== null && typeof record === 'object' && record.type === 'group-leave')
}

// An own writer still writes for the device until it holds a group-leave.
async function ownCoreLeft (storage, key) {
  const core = await readGroupCore(storage, key)
  return core === null || core.length === 0 || hasLeave(core.entries)
}

// The fold reports the own diary as left, a leave from another device of
// the diary included. A group that does not load is not known to be left.
async function foldSaysLeft (ctx, base, group) {
  const g = await loadGroup(ctx, base, group)
  return g !== null && statusOf(g, base.ownHex) === 'left'
}

// Room in kv groupWriters for `group`: at most MAX_GROUPS_PER_DIARY entries
// that still write ('limite de grupos atingido'); a full list gives up its
// oldest left entry, whose core stays readable as a replica. An entry is
// left when its own core holds a leave or the fold says the diary left;
// folds are only read for a full list.
async function makeGroupRoom (ctx, base, group) {
  const entries = await store.readGroupWriters(ctx.storage)
  if (entries.some((e) => e.group === group)) return
  if (entries.length < MAX_GROUPS_PER_DIARY) return
  const left = []
  for (const e of entries) {
    if (await ownCoreLeft(ctx.storage, e.key) || await rootUnfoldable(ctx.storage, e.group) || await foldSaysLeft(ctx, base, e.group)) left.push(e)
  }
  if (entries.length - left.length >= MAX_GROUPS_PER_DIARY) throw new UsageError(store.GROUPS_FULL)
  if (entries.length >= MAX_GROUPS_PER_DIARY) {
    // A group this device created is never evicted: its entry holds the only
    // copy of the root nonce, and the root cannot be written without it.
    const victim = left.find((e) => e.rootNonce === null)
    if (victim === undefined) throw new UsageError(store.GROUPS_FULL)
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
  const root = await readGroupCore(ctx.storage, group)
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
    const core = await readWriterCoreOf(ctx.storage, key, group)
    if (core === null) continue
    const h = core.entries[0].record
    if (validateWriterHeader(h) !== null || h.group !== group) continue
    writers.push({ key, entries: core.entries, diary: h.diary })
    cores.set(key, { diary: h.diary, at: h.at, length: core.length, signed: core.signed, entries: core.entries })
  }
  const diaries = new Map()
  const joins = new Map()
  // Only the diaries that can bind a core of this group: the own diary, the
  // creator's and the authors of the writers held (followed or stored for
  // the group, kv groupDiaries). Reading every follow would decode diaries
  // that bind nothing here on each group operation.
  for (const d of new Set([ownHex, rootHeader.diary, ...writers.map((w) => w.diary)])) {
    // A blocked own diary binds none of its writers, as in the core node (the
    // feed keeps its own rule for the own diary).
    const entries = d === ownHex ? (mod.blocked.has(ownHex) ? null : ownEntries) : await admittedEntries(ctx, d, association, mod)
    diaries.set(d, entries)
    if (entries !== null) joins.set(d, groupJoinHistory(entries, group))
  }
  const built = buildGroup({ root: { key: group, entries: root.entries }, writers, joins, communities: [], now: Date.now() })
  return { group, own, built, cores, diaries, joins }
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

function isActingAdmin (g, d) {
  return statusOf(g, d) === 'member' && g.built.admins.has(d)
}

// The own writer of this device when it still writes: listed, not left and
// bound by the own diary. A leave from another device of the diary ends it
// too: the diary is 'left' until some writer rejoins.
function liveOwnWriter (g, ownHex) {
  if (g.own === null || statusOf(g, ownHex) === 'left') return null
  const c = g.cores.get(g.own.key)
  if (c === undefined || hasLeave(c.entries)) return null
  return boundWriters(g, ownHex).includes(g.own.key) ? g.own : null
}

// A writer the fold did not count (beyond the writer cap) still looks live
// when another writer keeps the diary a member, but anything it writes is
// discarded by the fold.
function requireCounted (g, key) {
  if (!g.built.writers.has(key)) throw new UsageError(store.GROUP_FULL)
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
  const root = await readGroupCore(ctx.storage, group)
  if (root !== null && root.length > 0) return null
  return { group, own: (await store.readGroupWriters(ctx.storage)).find((e) => e.group === group) || null }
}

function requirePendingOwn ({ own }) {
  if (own === null) throw new Error(GROUP_NOT_FOUND)
  return own
}

const PENDING_INFO = { name: null, join: null, role: 'pending', members: 0 }

// Opens the own diary and folds `group`: write = true needs the unlocked
// identity, the group key derivation and block 0. A pending group goes to
// `pending` when given, and is NOT_FOUND otherwise.
async function withGroup (ctx, group, write, fn, pending = null) {
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

// -> { group }: a new public group whose root is a new own core; the own
// diary binds it at once (writer === group).
async function groupCreate (ctx, { name, join }) {
  needGroupKeys(ctx)
  const association = await trustRoot(ctx)
  const mod = await moderation(ctx.storage, association)
  return withIdentity(ctx, async ({ diary, ownHex }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    const header = buildRecord(() => grp.groupHeader({ kind: 'group', diary: ownHex, visibility: 'public', join, name, box: null }))
    await makeGroupRoom(ctx, { ownHex, ownEntries: await store.readAll(diary), association, mod }, null)
    const { core, key, nonce } = await newOwnGroupCore(ctx)
    try {
      await store.appendGroupRecord(core, header, { root: true, limits: ctx.limits })
    } finally {
      await core.close()
    }
    await store.putGroupWriter(ctx.storage, { group: key, key, nonce, rootNonce: nonce })
    await appendOwn(ctx, diary, groupJoinRecord({ group: key, writer: key, on: true }))
    return { group: key }
  })
}

// The checks that need the fold (ban, membership, rejoin) wait for the
// root: kv groupReplicas makes the next sync fetch it, and the fold then
// decides the state.
async function pendingJoin (ctx, { group, own }, { diary, ownHex, base }) {
  const core = own === null ? null : await readGroupCore(ctx.storage, own.key)
  const written = core !== null && core.length > 0
  if (written && hasLeave(core.entries)) throw new UsageError('o grupo ainda não chegou: entre de novo depois da sincronização')
  let writer = written ? own.key : null
  if (writer === null) {
    const bound = new Set(groupJoinHistory(base.ownEntries, group).filter((j) => j.on).map((j) => j.writer))
    if (bound.size >= MAX_GROUP_WRITERS_PER_DIARY) throw new UsageError(store.GROUP_FULL)
    await makeGroupRoom(ctx, base, group)
    const record = buildRecord(() => grp.writerHeader({ group, diary: ownHex, rejoin: null }))
    const created = await newOwnGroupCore(ctx)
    try {
      await store.appendGroupRecord(created.core, record, { root: false, limits: ctx.limits })
    } finally {
      await created.core.close()
    }
    await store.putGroupWriter(ctx.storage, { group, key: created.key, nonce: created.nonce, rootNonce: null })
    writer = created.key
  }
  await store.addGroupReplica(ctx.storage, group)
  const joins = groupJoinHistory(base.ownEntries, group)
  if (!joins.some((j) => j.writer === writer && j.on)) await appendOwn(ctx, diary, groupJoinRecord({ group, writer, on: true }))
  return { state: 'pending' }
}

// -> { state: 'member' | 'requested' | 'pending' }. Idempotent while this
// device's writer still writes; a writer that left is followed by a new one
// naming the diary's latest leave (rejoin).
async function groupJoin (ctx, { group }) {
  return withGroup(ctx, group, true, async ({ diary, ownHex, base, g }) => {
    // bans, not members: a diary banned before it had a writer is not listed.
    if (g.built.bans.has(ownHex)) throw new UsageError(GROUP_FORBIDDEN)
    // A blocked own diary binds none of its writers in the fold.
    if (g.diaries.get(ownHex) === null) throw new UsageError(GROUP_FORBIDDEN)
    const live = liveOwnWriter(g, ownHex)
    if (live !== null) return { state: joinState(g, ownHex, live.key) }
    // Listed and still writing but not bound (a join cut short): bind it.
    const current = g.own === null ? undefined : g.cores.get(g.own.key)
    const left = statusOf(g, ownHex) === 'left'
    let writer = !left && current !== undefined && !hasLeave(current.entries) ? g.own.key : null
    if (writer === null) {
      if (groupWritersFull(g)) throw new UsageError(store.GROUP_FULL)
      // The fold counts at most MAX_GROUP_WRITERS_PER_DIARY writers per diary
      // (the earliest bound): a new one would never count.
      if (boundWriters(g, ownHex).length >= MAX_GROUP_WRITERS_PER_DIARY) throw new UsageError(store.GROUP_FULL)
      await makeGroupRoom(ctx, base, g.group)
      // The causal latest leave, never the newest timestamp.
      const rejoin = statusOf(g, ownHex) === 'left' ? (g.built.leaves.get(ownHex) || null) : null
      const record = buildRecord(() => grp.writerHeader({ group: g.group, diary: ownHex, rejoin }))
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
  }, (p, ids) => pendingJoin(ctx, p, ids))
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
    const own = liveOwnWriter(g, ownHex)
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
    await appendToOwnGroupCore(ctx, own, buildRecord(() => grp.groupLeave({ seen: g.built.last, cuts })))
    await appendOwn(ctx, diary, groupJoinRecord({ group: g.group, writer: own.key, on: false }))
    return { state: 'left' }
  }, async (p, { diary, base }) => {
    const own = requirePendingOwn(p)
    const core = await readGroupCore(ctx.storage, own.key)
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
  })
}

// -> { seq }. `seen` is the newest record of the local causal order.
async function groupPost (ctx, { group, text, replyTo = null }) {
  return withGroup(ctx, group, true, async ({ ownHex, g }) => {
    const own = liveOwnWriter(g, ownHex)
    if (own === null || statusOf(g, ownHex) !== 'member') throw new UsageError(GROUP_FORBIDDEN)
    requireCounted(g, own.key)
    const record = buildRecord(() => grp.groupPost({ text, replyTo, seen: g.built.last }))
    return { seq: await appendToOwnGroupCore(ctx, own, record) }
  })
}

// A moderation record in this device's writer, checked against the local
// fold first.
async function groupModerate (ctx, group, make) {
  return withGroup(ctx, group, true, async ({ ownHex, g }) => {
    const own = liveOwnWriter(g, ownHex)
    if (own === null) throw new UsageError(GROUP_FORBIDDEN)
    const record = make(g, ownHex)
    requireCounted(g, own.key)
    await appendToOwnGroupCore(ctx, own, record)
    return { ok: true }
  })
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
    } else if (isActingAdmin(g, ownHex)) {
      writer = liveOwnWriter(g, ownHex)
    }
    if (writer === null) throw new UsageError(GROUP_FORBIDDEN)
    requireCounted(g, writer.key)
    await appendToOwnGroupCore(ctx, writer, buildRecord(() => grp.groupHide({ target, on, seen: g.built.last })))
    return { ok: true }
  })
}

// The creator and current admins are never targets of an admit or a ban.
function checkTarget (g, ownHex, member) {
  if (!isActingAdmin(g, ownHex)) throw new UsageError(GROUP_FORBIDDEN)
  const d = String(member).toLowerCase()
  if (d === g.built.creator || g.built.admins.has(d)) throw new UsageError(GROUP_FORBIDDEN)
  return d
}

function groupAdmit (ctx, { group, member, on }) {
  return groupModerate(ctx, group, (g, ownHex) => {
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
    return buildRecord(() => grp.groupAdmit({ member: d, on, cuts, seen: g.built.last }))
  })
}

// An unban lifts the ban the local fold holds in force for the member, the
// same latest ban again while a counted writer an earlier unban did not list
// stays banned.
function groupBan (ctx, { group, member, on }) {
  return groupModerate(ctx, group, (g, ownHex) => {
    const d = checkTarget(g, ownHex, member)
    let lifts = null
    if (!on) {
      lifts = g.built.bans.get(d) || null
      if (lifts === null) throw new UsageError(GROUP_UNCHANGED)
    }
    return buildRecord(() => grp.groupBan({ member: d, on, cuts: cutsFor(g, d, !on), lifts, seen: g.built.last }))
  })
}

// Root-only records: the creator, through the root this device created
// (its nonce kept in the entry even after a leave and rejoin).
async function groupCharter (ctx, group, make) {
  return withGroup(ctx, group, true, async ({ ownHex, g }) => {
    if (g.built.creator !== ownHex || statusOf(g, ownHex) !== 'member' || g.own === null || g.own.rootNonce === null) {
      throw new UsageError(GROUP_FORBIDDEN)
    }
    await appendToOwnGroupCore(ctx, { group: g.group, key: g.group, nonce: g.own.rootNonce }, make(g))
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
  })
}

function groupMeta (ctx, { group, name, join }) {
  if (name === undefined && join === undefined) throw new UsageError(GROUP_UNCHANGED)
  return groupCharter(ctx, group, (g) => buildRecord(() => grp.groupMeta({
    name: name === undefined ? g.built.name : name,
    join: join === undefined ? g.built.join : join,
    seen: g.built.last
  })))
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
      hidden: p.hidden,
      ...authorOf(g, p.diary, base.association, base.mod)
    }))
    const oldest = items.length > 0 ? items[items.length - 1] : null
    return {
      items,
      next: start > 0 && oldest !== null ? { at: oldest.at, writer: oldest.writer, seq: oldest.seq } : null,
      hidden: items.filter((p) => p.hidden).length,
      incomplete: g.built.incomplete
    }
  }, (p) => {
    requirePendingOwn(p)
    return { items: [], next: null, hidden: 0, incomplete: true }
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
      const g = await loadGroup(ctx, base, e.group)
      if (g === null) {
        if (await pendingOf(ctx, mod, e.group) !== null) groups.push({ group: e.group, ...PENDING_INFO })
        continue
      }
      groups.push({ group: e.group, name: g.built.name, join: g.built.join, role: roleOf(g, ownHex), members: memberCount(g) })
    }
    return { groups: groups.slice(offset, offset + limit), total: groups.length }
  })
}

async function groupInfo (ctx, { group }) {
  return withGroup(ctx, group, false, ({ ownHex, g }) => ({
    group: g.group,
    name: g.built.name,
    join: g.built.join,
    creator: g.built.creator,
    role: roleOf(g, ownHex),
    members: memberCount(g),
    state: stateOf(g, ownHex)
  }), (p) => {
    requirePendingOwn(p)
    return { group: p.group, ...PENDING_INFO, creator: null, state: 'pending' }
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

module.exports = {
  GENESIS_REQUIRED,
  GROUP_NOT_FOUND,
  GROUP_FORBIDDEN,
  GROUP_UNCHANGED,
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
  likeSet,
  repostSet,
  engagementRead,
  usernameAdd,
  ownEntries,
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
  groupCreate,
  groupJoin,
  groupLeave,
  groupPost,
  groupHide,
  groupBan,
  groupAdmit,
  groupAdmin,
  groupMeta,
  groupRead,
  groupList,
  groupInfo,
  groupMembers,
  groupRequests
}
