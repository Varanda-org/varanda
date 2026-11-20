'use strict'

// Copying the conversation history to another device of the same identity
// (docs/protocol.md section 11 "History copy"). The browser node's engine
// (./dm.js) wires this module in with the pieces it owns; nothing here
// touches the network except through them.
//
// The old device (autoCopy, kicked by the session, never by a request):
//   1. A device registered after this one, still on and within
//      COPY_WINDOW_MS, that no claim covers yet is a target. A claim (inner
//      v8, kind 'claim': the targets, this device's id and the id the text
//      pointer will carry) is put to the dm pool, sealed to the own box, at
//      most one per CLAIM_GAP_MS, and at most CLAIMS_PER_TARGET by this
//      device for a target.
//   2. The pull runs until the own claim comes back. The pool order is total,
//      so every claim put before it was seen too: the lowest-seq claim that
//      is not stale wins each target. A device that does not win every target
//      of its claim drops the job; at most one device copies to a target.
//   3. Text: every store held here (the own one and each held Página's) is
//      read as rows in filing order, each with its position n, cut into
//      parts of at most PART_BYTES, each sealed as a blob and put; a v3
//      manifest naming the parts and the targets is sealed and put the same
//      way; last, a v7
//      pointer drop (kind 'copy', id = the claim's copy id, signed by the
//      identity key, sealed to the own box, one dm stamp) is put. Its stamps
//      are reserved from the copy source (the seeder's weekly copy allowance,
//      ./blob.js copySource) first; what the reservation did not cover falls
//      back to the daily wallet. The pointer goes only while the claim is far
//      from stale (CLAIM_TTL_MS - CLAIM_MARGIN_MS), so no other device can
//      have taken the claim for stale by then.
//   4. Photos: the cached photos of the own store, newest first from a
//      persisted cursor, sealed again as NEW blobs (a fresh key, so the
//      original blob and key are never reused) and paid from the copy source
//      ONLY (the daily wallet never pays a copied photo), in batches of about
//      PHOTO_BATCH_BYTES: each a v2 manifest of patches (the new descriptors
//      of each message) announced by a v7 pointer whose id derives from the
//      claim (batchIdOf), up to PHOTO_TOTAL_MAX in all. The stage ends when
//      the weekly allowance does; any other stamp failure fails the kick.
//   The job lives in kv dmAutoCopy, so a lock or a close resumes it on the
//   next kick after an unlock; a batch in flight is lost, never doubled (its
//   id is the same when made again). A failed step repeats nothing by itself:
//   a later kick goes on, and only after a pull that completed, so an
//   offline device spends nothing. Before the claim, the text pointer, each
//   photo and each batch pointer, the job checks the latest device view the
//   session gave (checkWanted), so a disconnect stops a copy in progress.
//
// Every device (note, importAll), from the pull:
//   - Claims are kept (kv dmAutoCopy, sealed) with their pool seq and the time
//     they were first seen here, at most CLAIMS_KEPT_MAX, for DM_RETENTION_MS.
//   - The pointer opens only under the own box, signed by the own key (core
//     dm.js openInner, kind 'copy'). A copy id made or imported here is
//     skipped. Anything else becomes a todo in kv dmCopy (sealed), so a
//     pointer the cursor already passed is not lost while the blobs are
//     unreachable; a todo older than DM_RETENTION_MS is dropped. A pointer
//     that belongs to a kept claim is imported only by a device the claim
//     names, else it is marked handled without a fetch. A v3 text manifest
//     names its targets too, so a device it does not name imports nothing
//     even when the claim never reached it; a v1 manifest (a copy made by
//     hand on an earlier build) goes to every device that is on. Nothing is
//     imported until the session told this module which device it is, and a
//     disconnected device imports nothing, even one turned off while an
//     import runs (checked again before each part, store and photo). While
//     the session holds imports (its link dropped or its own diary fell
//     behind, so an off record may be on the way), every import waits.
//   - The manifest and the parts are fetched (fetchBlob checks the frames,
//     the sha256 and the secretbox), parsed and every row is checked by the
//     local store's own row rules plus the sender/recipient rules below.
//     Only reads are ever repeated: a failure that is not "gone" leaves the
//     todo for the next pull; a blob gone or invalid ends it.
//   - Rows are filed BELOW everything the store held when the filing began
//     (the legacy bundle's horizon, ./dm.js legacyHorizon), in n order, so an
//     imported 'deleted' never hides a message received here since and a
//     'deleted' held here still hides the imported older rows. A message is
//     deduped by sender and id, a ctl by its id, a reaction by its id. A row
//     the bundle marked seen is marked seen here. The horizon is kept with the
//     todo before the first chunk is appended and reused by a retry, so an
//     import cut short files the rest in the same order as one that was not.
//     A message's shown time (shownAt) is capped at the receiver's clock.
//   - A Página's store is filed into that page's store when its secrets are
//     held, else kept sealed (kv dmCopyPend) until they are, or until
//     DM_RETENTION_MS passes.
//   - A v2 photo batch: each patch whose message is held here, not hidden by
//     a delete, not cached yet and whose items match opens through the
//     engine's openMedia with the new descriptors, which fills the cache.
//
// Nothing here logs a key, an id, a text or a peer.
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const dm = require('@varanda/core/lib/dm')
const dmFold = require('@varanda/core/lib/dm-fold')
const blobCore = require('@varanda/core/lib/blob')
const { nowIso, isCanonicalIso } = require('@varanda/core/lib/records')
const { UsageError } = require('@varanda/core/lib/errors')
const { copyLinkCard } = require('@varanda/core/lib/link-card')
const { sealBlob, fetchBlob } = require('./blob')
const { validRow } = require('./dm-store')
const store = require('./node-store')

const NOTHING = 'não há conversas para copiar'
const TOO_BIG = 'as conversas são grandes demais para copiar de uma vez'
const COPY_FAILED = 'não deu para copiar as conversas: tente de novo'
const NO_STAMPS = 'o limite de envio de hoje acabou'
const LOCKED = store.LOCKED
// The messages ./dm.js gives a blob that is gone or does not verify.
const MEDIA_GONE = 'mídia indisponível'
const BAD_MEDIA = 'mídia inválida'

const PART_BYTES = 1048576
// The largest part a reader accepts (a writer cuts at PART_BYTES; a row is
// far smaller than the slack).
const PART_PLAIN_MAX = 2 * PART_BYTES
const PIECE_BYTES = 524288
const PIECES_MAX = 64
const PEND_MAX = 16
const STORES_MAX = 64
const PARTS_MAX = 256
const ROWS_MAX = 200000
const TEXT_MAX = 4000
const MADE_MAX = 16
const IMPORTED_MAX = 256
// Room for every photo batch of one automatic copy next to its text: a pull
// that brings a whole copy at once never pushes the text pointer out.
const TODO_MAX = 80
const FAILS_MAX = 3
const PREFETCH_BYTES_MAX = 64 * 1048576
const CHUNK_ROWS = 500
// The automatic copy (see the header). A claim lives CLAIM_TTL_MS from when
// a device first saw it; its maker puts the pointer only while more than
// CLAIM_MARGIN_MS of that is left.
const CLAIM_TTL_MS = 3600000
const CLAIM_MARGIN_MS = 600000
const CLAIM_GAP_MS = 600000
const CLAIMS_PER_TARGET = 3
// Kicks in a row that failed for a reason other than a lock before the job
// ends: a seeder that takes the stamps and then refuses the blobs would
// otherwise cost one batch of the weekly allowance on every tick. A device
// whose last pull failed does not try, so being offline counts none.
const JOB_FAILS_MAX = 3
// Below the pool's 14-day retention: every claim for a target inside the
// window is still in the pool when a device evaluates it.
const COPY_WINDOW_MS = 13 * 86400000
const CLAIMS_KEPT_MAX = 64
const DONE_MAX = 64
const PHOTO_BATCH_BYTES = 16 * 1048576
// 3/4 of the receiver's 256 MiB media cache: the newest photos are not
// evicted by the oldest of the same copy.
const PHOTO_TOTAL_MAX = 192 * 1048576
const PATCHES_MAX = 256
const BATCHES_MAX = 64
if (TODO_MAX <= BATCHES_MAX) throw new Error('TODO_MAX too small')
// The pulls that wait for the own claim to come back, and the pause before
// each one after the first.
const SETTLE_PULLS = 4
const SETTLE_WAIT_MS = 500
const BATCH_DOMAIN = 'varanda/copy-batch/1\n'
const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

function noop () {}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function wipe (b) {
  if (b instanceof Uint8Array) b.fill(0)
}

// Left out for lack of stamps: not a failure, counted instead.
class LeftOut extends Error {}
// A manifest, part or blob that will never import.
class Dead extends Error {}
// A part (or the manifest) that is gone or does not verify now: the todo
// stays for a later pull, and ends after FAILS_MAX pulls that failed so.
class Soft extends Error {}
// The unlock or the generation changed under an import.
class Stop extends Error {}
// This device or a target of the job is no longer one (checkWanted).
class Dropped extends Error {}

// The bucket prefix of a box public key (hex); null for an unusable one, an
// untagged put that every bucket matches, as prefixOf in ./dm.js.
function bucketOf (boxKey) {
  try {
    return dm.bucketPrefix(boxKey)
  } catch {
    return null
  }
}

function exactKeys (o, keys) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const have = Object.keys(o)
  return have.length === keys.length && keys.every((k) => have.includes(k))
}

function isCount (n) {
  return Number.isSafeInteger(n) && n >= 0
}

function itemsOf (m) {
  return Array.isArray(m.media) ? m.media : m.card && m.card.image ? [m.card.image] : []
}

function mediaBytes (m) {
  return itemsOf(m).reduce((n, d) => n + (Number.isSafeInteger(d.bytes) ? d.bytes : 0), 0)
}

function plainDescriptor (d) {
  return { id: d.id, key: d.key, nonce: d.nonce, chunks: d.chunks, bytes: d.bytes, sha256: d.sha256 }
}

function validTodo (t) {
  return t !== null && typeof t === 'object' && typeof t.id === 'string' && HEX32.test(t.id) &&
    blobCore.validateBlobDescriptor(t.copy) && Number.isSafeInteger(t.seen) && t.seen > 0
}

// The import horizon of each store of a todo, by 'own' or the page key.
function horizonsOf (v) {
  const out = {}
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return out
  let n = 0
  for (const k of Object.keys(v)) {
    if ((k === 'own' || HEX64.test(k)) && isCount(v[k]) && n++ < STORES_MAX) out[k] = v[k]
  }
  return out
}

function idList (v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && HEX32.test(x)) : []
}

// The id of photo batch `i` of the copy whose text pointer carries `copy`:
// a device that keeps the claim tells the batch apart without a fetch, and
// a batch made again after an interruption carries the same id.
function batchIdOf (copy, i) {
  return b4a.toString(hcrypto.hash(b4a.from(BATCH_DOMAIN + copy + '\n' + i, 'utf8')), 'hex').slice(0, 32)
}

function idSet (v, max) {
  return Array.isArray(v) && v.length >= 1 && v.length <= max && v.every((x) => typeof x === 'string' && HEX64.test(x)) && new Set(v).size === v.length
}

// A kept claim: { id, copy, for, by, at, seq (pool), seen (first seen here,
// ms), done (its text pointer was seen or made here) }.
function validKept (c) {
  return c !== null && typeof c === 'object' && typeof c.id === 'string' && HEX32.test(c.id) &&
    typeof c.copy === 'string' && HEX32.test(c.copy) && idSet(c.for, dm.DM_CLAIM_FOR_MAX) &&
    typeof c.by === 'string' && HEX64.test(c.by) && typeof c.at === 'string' &&
    Number.isSafeInteger(c.seq) && c.seq >= 1 && Number.isSafeInteger(c.seen) && c.seen > 0 && typeof c.done === 'boolean'
}

function keptOf (c) {
  return { id: c.id, copy: c.copy, for: [...c.for], by: c.by, at: c.at, seq: c.seq, seen: c.seen, done: c.done }
}

function claimStale (c, now) {
  return !c.done && now - c.seen > CLAIM_TTL_MS
}

// Whether claim `job` wins every one of its targets: for each, the lowest-seq
// kept claim naming it that is not stale must be this one.
function claimWins (claims, job, now) {
  const own = claims.find((c) => c.id === job.id)
  if (own === undefined || claimStale(own, now)) return false
  for (const t of job.for) {
    let best = null
    for (const c of claims) {
      if (!c.for.includes(t) || claimStale(c, now)) continue
      if (best === null || c.seq < best.seq) best = c
    }
    if (best === null || best.id !== job.id) return false
  }
  return true
}

// The targets still to claim: none done here, claimed CLAIMS_PER_TARGET times
// by this device already (`claimed` counts only its own claims, so devices
// that claim at the same moment do not use up each other's), or named by a
// claim that is done or not stale.
function wantedTargets ({ targets, claims, done, claimed, now }) {
  return targets.filter((t) => !done.includes(t) && !((claimed[t] || 0) >= CLAIMS_PER_TARGET) &&
    !claims.some((c) => c.for.includes(t) && !claimStale(c, now)))
}

// A bundle row -> { row, n, seen, c } as the local store would hold it, or
// null. self: the diary key of the store (the page's for a Página). blocked:
// the senders the store drops on receipt (moderation).
function cleanRow (r, self, blocked) {
  // n is the row's index in a store of at most ROWS_MAX rows; a larger one
  // would only stretch the filing span (and lose integer precision).
  if (r === null || typeof r !== 'object' || Array.isArray(r) || !isCount(r.n) || r.n >= ROWS_MAX) return null
  const { n, seen, c, ...row } = r
  if ((seen !== undefined && seen !== true) || (c !== undefined && c !== 1)) return null
  if (row.t !== 'msg' && row.t !== 'ctl' && row.t !== 'rx') return null
  if (!validRow({ ...row, filedAt: 0 })) return null
  if (row.peer === self) return null
  // The same shape a received message or reaction has (core dm.js validText,
  // a canonical ISO time), and the same moderation block.
  if (!isCanonicalIso(row.at)) return null
  if (row.t === 'msg') {
    if (row.text.length > TEXT_MAX || !dm.validText(row.text, Array.isArray(row.media) && row.media.length > 0)) return null
    if (row.mine !== (row.from === self)) return null
    if (!row.mine && (row.peer !== row.from || blocked.has(row.from))) return null
  } else if (row.t === 'rx') {
    if (row.mine !== (row.from === self)) return null
    if (!row.mine && blocked.has(row.from)) return null
  }
  return { row, n, seen: seen === true, c: c === 1 }
}

const LIMITS = Object.freeze({ rows: ROWS_MAX, parts: PARTS_MAX, stores: STORES_MAX, manifest: PART_PLAIN_MAX })

// What the reader accepts (rows and parts per store, stores, a manifest of at
// most `manifest` bytes), checked before anything is spent on `rowSets`, one
// array of rows per store. The parts are counted on the rows as they are held:
// a photo swapped in later changes a row by a few bytes.
function checkLimits (rowSets, limits = LIMITS) {
  let stores = 0
  let parts = 0
  for (const rows of rowSets) {
    if (rows.length === 0) continue
    stores++
    const n = cutRows(rows).length
    if (rows.length > limits.rows || n > limits.parts) throw new UsageError(TOO_BIG)
    parts += n
  }
  if (stores > limits.stores || manifestBytes(stores, parts) > limits.manifest) throw new UsageError(TOO_BIG)
}

// The stamps the text of `rowSets` needs: one per chunk of every part and of
// the manifest, at the widest the manifest can be, plus one per part for what
// swapping a photo's descriptor in adds to a row. The weekly copy allowance
// gives them up before any photo, so the text never falls on the daily wallet
// because photos spent the week's stamps.
function stampsNeeded (rowSets) {
  const chunks = (bytes) => Math.ceil((bytes + blobCore.BLOB_MAC_BYTES) / blobCore.BLOB_CHUNK_BYTES)
  let stores = 0
  let parts = 0
  let need = 0
  for (const rows of rowSets) {
    if (rows.length === 0) continue
    stores++
    for (const cur of cutRows(rows)) {
      parts++
      // The part's envelope ({ v, page, rows }) is under 128 bytes.
      need += chunks(b4a.byteLength(JSON.stringify(cur)) + 128) + 1
    }
  }
  return need + chunks(manifestBytes(stores, parts))
}

// The largest manifest for that many stores and parts: every descriptor and
// count at its widest, and the most targets a claim names.
function manifestBytes (stores, parts) {
  const d = JSON.stringify({ id: '0'.repeat(64), key: '0'.repeat(64), nonce: '0'.repeat(48), chunks: 257, bytes: 8421504, sha256: '0'.repeat(64) })
  const page = JSON.stringify({ page: '0'.repeat(64), parts: [], rows: ROWS_MAX, ops: ROWS_MAX })
  const targets = JSON.stringify({ for: Array.from({ length: dm.DM_CLAIM_FOR_MAX }, () => '0'.repeat(64)) })
  return 128 + targets.length + stores * (page.length + 1) + parts * (d.length + 1)
}

function cutRows (rows) {
  const cuts = []
  let cur = []
  let size = 0
  for (const row of rows) {
    const n = b4a.byteLength(JSON.stringify(row)) + 1
    if (size + n > PART_BYTES && cur.length > 0) {
      cuts.push(cur)
      cur = []
      size = 0
    }
    cur.push(row)
    size += n
  }
  if (cur.length > 0) cuts.push(cur)
  return cuts
}

// The filing time everything imported goes below: older than every row the
// store held, like the Página legacy bundle's (./dm.js legacyHorizon).
function horizonOf (lc, snap) {
  const { messages, ops, reactions } = snap
  let min = lc.nextFiled()
  for (const r of [...messages, ...ops, ...reactions]) if (Number.isFinite(r.filedAt) && r.filedAt < min) min = r.filedAt
  return min
}

// Files the rows of one store -> { messages, ops, reactions, skipped, fresh }
// (fresh: the message rows filed now whose photos travelled).
// pin: { get () -> horizon or null, set (horizon) } keeps the horizon with the
// todo, written before the first chunk and reused by a retry, so rows filed
// after an interruption land where an uninterrupted run would have put them
// (the Página legacy import keeps meta.horizon the same way).
// now: the receiver's clock; a shown time is capped at it, so a maker whose
// clock ran ahead cannot pin a conversation above the receiver's own rows.
async function fileRows (ctx, storage, self, rawRows, blocked, { pin = null, now = Date.now(), chunkRows = CHUNK_ROWS } = {}) {
  const lc = ctx.local
  const items = []
  const taken = new Set()
  let skipped = 0
  // The span the rows are filed across, from the bundle's own indexes and not
  // from the rows that pass the filter: a sender unblocked between an
  // interrupted import and its retry must not move a row onto the filing time
  // of one already filed.
  let span = 0
  for (const r of rawRows) {
    const validN = r !== null && typeof r === 'object' && isCount(r.n) && r.n < ROWS_MAX
    if (validN && r.n + 1 > span) span = r.n + 1
    // The first raw row with an n owns its slot even when a block drops it, so
    // an unblock between an interrupted import and its retry cannot hand the
    // slot to another row.
    const dup = validN && taken.has(r.n)
    if (validN) taken.add(r.n)
    const c = dup ? null : cleanRow(r, self, blocked)
    if (c === null) {
      skipped++
      continue
    }
    items.push(c)
  }
  items.sort((x, y) => x.n - y.n)
  // One scan of the store, then sets: a lookup per row (lc.hasMessage and
  // its kin scan every row) would take quadratic time on a large store.
  const snap = lc.snapshot()
  const haveMsg = new Set(snap.messages.map((m) => m.from + '\n' + m.id))
  const haveOp = new Set(snap.ops.map((o) => o.id))
  const haveRx = new Set(snap.reactions.map((x) => x.from + '\n' + x.id))
  let horizon = pin === null ? null : pin.get()
  if (!isCount(horizon)) {
    horizon = horizonOf(lc, snap)
    if (pin !== null) await pin.set(horizon)
  }
  const out = []
  const keys = new Set()
  const seenIds = []
  const fresh = []
  let messages = 0
  let ops = 0
  let reactions = 0
  for (const { row, seen, c, n } of items) {
    const filedAt = horizon - span + n
    const k = row.t + '\n' + (row.from || '') + '\n' + row.id
    if (keys.has(k)) continue
    keys.add(k)
    let filed = { ...row, filedAt }
    if (row.t === 'msg') {
      if (haveMsg.has(row.from + '\n' + row.id)) continue
      haveMsg.add(row.from + '\n' + row.id)
      messages++
      if (seen && !row.mine) seenIds.push(lc.seenToken(dmFold.seenKey(row.from, row.id)))
      if (c && itemsOf(row).length > 0) fresh.push({ ...row, filedAt })
      if (row.shownAt !== undefined) filed = { ...filed, shownAt: Math.min(row.shownAt, now) }
    } else if (row.t === 'ctl') {
      if (haveOp.has(row.id)) continue
      haveOp.add(row.id)
      ops++
    } else {
      if (haveRx.has(row.from + '\n' + row.id)) continue
      haveRx.add(row.from + '\n' + row.id)
      reactions++
    }
    out.push(filed)
  }
  for (let i = 0; i < out.length; i += chunkRows) await lc.append(out.slice(i, i + chunkRows))
  if (seenIds.length > 0) {
    // First in the list (newest last, the cap drops the front): about
    // 5000 imported marks never evict the device's own recent ones.
    const existing = await store.readDmSeen(storage, ctx.prefix)
    const have = new Set(existing)
    await store.writeDmSeen(storage, [...seenIds.filter((id) => !have.has(id)), ...existing], ctx.prefix)
  }
  return { messages, ops, reactions, skipped, fresh }
}

// env: the engine's pieces (see createDmEngine in ./dm.js).
function createDmCopy (env) {
  const { storage, local, blobs } = env
  // What the reader accepts; a test passes smaller ones to reach the edges.
  const limits = env.limits || LIMITS
  // Photo batch sizes; a test passes smaller ones to reach several batches.
  const batchMax = (env.photoBatch && env.photoBatch.bytes) || PHOTO_BATCH_BYTES
  const photoMax = (env.photoBatch && env.photoBatch.total) || PHOTO_TOTAL_MAX
  // The text stage being retried in this unlock: its stamps, sealed parts,
  // manifest and pointer frames, so a part or a drop is put again as the
  // SAME bytes (the pool answers an identical frame as a repeated success)
  // and no stamp is spent twice.
  let attempt = null
  let stateLock = Promise.resolve()
  let autoLock = Promise.resolve()
  // The running import job (importAll) and whether a call joined it.
  let importing = null
  let again = false
  // The running automatic job (autoCopy).
  let auto = null
  // The weekly copy source of a job in this unlock, shared by its text and
  // photo stages: a purchase buys a whole batch, and what the text did not
  // use pays the first photos instead of being thrown away. One whose
  // purchase failed (`failed`) is replaced at the next kick.
  let jobSource = null
  // { self, off, targets } as the session last said (setDevice, autoCopy);
  // null until it says.
  let device = null
  // Imports wait while the session says `device` may be stale (holdImports);
  // a copy this device makes does not.
  let importsHeld = false

  function withState (fn) {
    const p = stateLock.then(fn)
    stateLock = p.catch(noop)
    return p
  }

  function withAuto (fn) {
    const p = autoLock.then(fn)
    autoLock = p.catch(noop)
    return p
  }

  // ---- the sealed record: made, imported, todo ----

  async function readState () {
    const empty = { made: [], imported: [], todo: [] }
    const sealed = await store.readDmCopy(storage)
    if (sealed === null) return empty
    const v = local.open(sealed)
    if (v === null || typeof v !== 'object') return empty
    return {
      made: idList(v.made).slice(-MADE_MAX),
      imported: idList(v.imported).slice(-IMPORTED_MAX),
      todo: (Array.isArray(v.todo) ? v.todo.filter(validTodo) : []).slice(0, TODO_MAX).map((t) => ({ id: t.id, copy: plainDescriptor(t.copy), seen: t.seen, fails: isCount(t.fails) ? Math.min(t.fails, FAILS_MAX) : 0, horizons: horizonsOf(t.horizons) }))
    }
  }

  function writeState (s) {
    return store.writeDmCopy(storage, local.seal({
      made: s.made.slice(-MADE_MAX),
      imported: s.imported.slice(-IMPORTED_MAX),
      todo: s.todo.slice(0, TODO_MAX)
    }))
  }

  function updateState (fn) {
    return withState(async () => {
      const s = await readState()
      fn(s)
      await writeState(s)
      return s
    })
  }

  // ---- the sealed automatic record: job, lastClaim, claimed, done, claims ----

  function validJob (j) {
    return j !== null && typeof j === 'object' && typeof j.id === 'string' && HEX32.test(j.id) &&
      typeof j.copy === 'string' && HEX32.test(j.copy) && idSet(j.for, dm.DM_CLAIM_FOR_MAX) &&
      Number.isSafeInteger(j.put) && j.put > 0 && ['claim', 'text', 'photos'].includes(j.stage) &&
      (j.top === null || Number.isSafeInteger(j.top)) && (j.cursor === null || Number.isSafeInteger(j.cursor)) &&
      isCount(j.batches) && isCount(j.bytes) && (j.fails === undefined || isCount(j.fails))
  }

  function jobOf (j) {
    return { id: j.id, copy: j.copy, for: [...j.for], put: j.put, stage: j.stage, top: j.top, cursor: j.cursor, batches: j.batches, bytes: j.bytes, fails: isCount(j.fails) ? Math.min(j.fails, JOB_FAILS_MAX) : 0 }
  }

  // A kick that failed while still unlocked: the job ends at JOB_FAILS_MAX
  // such kicks in a row (a batch that goes, or the text, resets the count).
  async function failJob () {
    let ended = null
    await updateAuto((a) => {
      if (a.job === null) return
      a.job.fails = Math.min((a.job.fails || 0) + 1, JOB_FAILS_MAX)
      if (a.job.fails < JOB_FAILS_MAX) return
      ended = a.job
      a.job = null
    })
    if (ended !== null && attempt !== null && attempt.id === ended.copy) attempt = null
  }

  async function readAuto () {
    const out = { job: null, lastClaim: 0, claimed: {}, done: [], claims: [] }
    const sealed = await store.readDmAutoCopy(storage)
    const v = sealed === null ? null : local.open(sealed)
    if (v === null || typeof v !== 'object' || v.v !== 1) return out
    const now = Date.now()
    if (validJob(v.job)) out.job = jobOf(v.job)
    if (isCount(v.lastClaim)) out.lastClaim = v.lastClaim
    if (v.claimed !== null && typeof v.claimed === 'object' && !Array.isArray(v.claimed)) {
      for (const k of Object.keys(v.claimed).slice(-CLAIMS_KEPT_MAX)) {
        if (HEX64.test(k) && isCount(v.claimed[k])) out.claimed[k] = Math.min(v.claimed[k], CLAIMS_PER_TARGET)
      }
    }
    if (Array.isArray(v.done)) out.done = v.done.filter((x) => typeof x === 'string' && HEX64.test(x)).slice(-DONE_MAX)
    if (Array.isArray(v.claims)) out.claims = v.claims.filter((c) => validKept(c) && now - c.seen <= dm.DM_RETENTION_MS).slice(-CLAIMS_KEPT_MAX).map(keptOf)
    return out
  }

  function writeAuto (a) {
    const claimed = {}
    for (const k of Object.keys(a.claimed).slice(-CLAIMS_KEPT_MAX)) claimed[k] = a.claimed[k]
    return store.writeDmAutoCopy(storage, local.seal({ v: 1, job: a.job, lastClaim: a.lastClaim, claimed, done: a.done.slice(-DONE_MAX), claims: a.claims.slice(-CLAIMS_KEPT_MAX) }))
  }

  function updateAuto (fn) {
    return withAuto(async () => {
      const a = await readAuto()
      fn(a)
      await writeAuto(a)
      return a
    })
  }

  function saveJob (job) {
    return updateAuto((a) => { a.job = jobOf(job) })
  }

  function dropJob (job) {
    if (attempt !== null && attempt.id === job.copy) attempt = null
    return updateAuto((a) => { if (a.job !== null && a.job.id === job.id) a.job = null })
  }

  // ---- making a copy ----

  // The one place an own drop (a claim or a pointer) is put, with the bucket
  // prefix of the box it is sealed to: the own one, so only the own bucket's
  // pulls carry it (docs/protocol.md section 11). onInvalid: the pool
  // refused the frame as invalid.
  async function putPointer (bytes, prefix, onInvalid = noop) {
    let link
    try {
      link = await env.openDmLink(env.linkOpts)
    } catch (err) {
      if (err instanceof UsageError) throw err
      throw new UsageError('sem conexão com o semeador')
    }
    try {
      let r
      try {
        r = await link.put(bytes, prefix)
      } catch {
        throw env.unconfirmed()
      }
      if (!r.ok) {
        if (r.reason === 'invalido') onInvalid()
        throw env.refusal(r.reason)
      }
    } finally {
      link.close()
    }
  }

  // An own inner -> { bytes, prefix }: sealed to the own box, one dm stamp.
  async function ownDrop (inner, keyPair) {
    const boxKey = env.boxHex().box
    let sealed
    try {
      sealed = dm.sealInner(inner, boxKey)
    } finally {
      inner.fill(0)
    }
    let stamps = await env.takeStamps(1)
    if (stamps === null) {
      await env.topUpDm(keyPair, { force: true })
      stamps = await env.takeStamps(1)
    }
    if (stamps === null) throw new UsageError(NO_STAMPS)
    return { bytes: env.dropOf(sealed, stamps[0]), prefix: bucketOf(boxKey) }
  }

  async function putBlob (sealed) {
    try {
      await blobs.put(sealed)
    } catch (err) {
      if (err && err.uncertain) throw new UsageError(COPY_FAILED)
      throw err
    }
  }

  // A part or the manifest: when the seeder refuses a stamp as invalid (its
  // key rotated since the held ones were bought) every held stamp is stale
  // too, so they are dropped and the retry buys fresh ones instead of failing
  // until the held ones run out.
  async function putRequired (sealed, held) {
    try {
      await putBlob(sealed)
    } catch (err) {
      if (err && err.reason === 'invalido') held.splice(0)
      throw err
    }
  }

  // A copy source purchase failed: the next kick asks with a new source.
  function sourceFailed (source) {
    if (jobSource !== null && jobSource.source === source && !source.exhausted) jobSource.failed = true
  }

  // A photo: the weekly copy allowance only; a copy never spends the daily
  // blob wallet on a photo. Once the allowance ended the photo is left out
  // (LeftOut). Any other failure (no link, a purchase refused or cut, an
  // older seeder that does not answer the kind) fails the kick for now.
  async function stampPhoto (sealed, keyPair, source) {
    try {
      await blobs.stamp(sealed, keyPair, source)
    } catch (err) {
      if (err instanceof UsageError && source.exhausted) throw new LeftOut()
      if (err instanceof UsageError) sourceFailed(source)
      throw err
    }
  }

  // Text parts and manifests must go: the stamps reserved for them first,
  // then the copy source for a shortfall, and only what neither covers (an
  // older seeder, no answer, an allowance spent by an earlier copy this
  // week) is paid from the daily wallet.
  async function stampRequired (sealed, keyPair, held, source) {
    const own = {
      async take (n) {
        if (held.length >= n) return held.splice(0, n)
        const more = await source.take(n - held.length)
        return held.splice(0).concat(more)
      }
    }
    try {
      await blobs.stamp(sealed, keyPair, own)
      return
    } catch (err) {
      if (!(err instanceof UsageError)) throw err
      sourceFailed(source)
    }
    await blobs.stamp(sealed, keyPair)
  }

  // The snapshot without the messages and reactions a 'deleted' op already
  // cut off (dm-fold keeps a row only when it was filed after the op), so a
  // deleted conversation neither travels nor spends photo allowance. Every
  // ctl op stays: the fold on the other device needs them.
  function cutSnap (snap) {
    const cut = new Map()
    for (const o of snap.ops) {
      if (o.op === 'deleted' && !(cut.get(o.peer) >= o.filedAt)) cut.set(o.peer, o.filedAt)
    }
    if (cut.size === 0) return snap
    const live = (r) => !(cut.get(r.peer) >= r.filedAt)
    return { messages: snap.messages.filter(live), ops: snap.ops, reactions: snap.reactions.filter(live) }
  }

  function rowsOf (snap) {
    const rows = [...snap.messages, ...snap.ops, ...snap.reactions]
    // Stable: equal filing times keep messages, then ops, then reactions.
    return rows.map((r, i) => ({ r, i })).sort((x, y) => x.r.filedAt - y.r.filedAt || x.i - y.i).map((x) => x.r)
  }

  function checkGen (gen) {
    if (gen !== env.generation() || !env.unlocked()) throw new UsageError(LOCKED)
  }

  // Whether `job` may take its next step, by the latest view the session
  // gave: this device known and on, every target still a target, the window
  // open. A copy is sealed to the own box, which a disconnected device that
  // holds the passkey can still open, so a job that fails this puts nothing
  // more for any of its targets (Dropped ends it).
  function checkWanted (job) {
    const d = device
    if (d === null || d.self === null || d.off || Date.now() - job.put > COPY_WINDOW_MS || !job.for.every((t) => d.targets.includes(t))) throw new Dropped()
  }

  // Runs a step of `job`; Dropped ends the job instead of failing the kick.
  async function unlessDropped (job, fn) {
    try {
      await fn()
    } catch (err) {
      if (!(err instanceof Dropped)) throw err
      await dropJob(job)
    }
  }

  function emptySnap (s) {
    return s.messages.length + s.ops.length + s.reactions.length === 0
  }

  // The own store and each held Página's, each { page, ctx }.
  async function heldStores () {
    const held = [{ page: null, ctx: env.personal }]
    for (const page of env.pages.pages()) {
      try {
        held.push({ page, ctx: await env.pageCtx(page) })
      } catch {}
    }
    return held
  }

  async function holdsRows () {
    for (const h of await heldStores()) if (!emptySnap(h.ctx.local.snapshot())) return true
    return false
  }

  // The copy source of `job` for this unlock; one whose purchase failed is
  // replaced (sourceFailed).
  function sourceOf (keyPair, gen, job) {
    if (jobSource === null || jobSource.gen !== gen || jobSource.id !== job.id || jobSource.failed) jobSource = { gen, id: job.id, source: blobs.copySource(keyPair), failed: false }
    return jobSource.source
  }

  // The text stage of `job` -> true once its pointer is put, false when the
  // claim came too close to stale first (the job is dropped).
  async function runText (keyPair, gen, job) {
    // Checked again before the pointer; here so a claim already too close to
    // stale spends nothing.
    if (Date.now() - job.put >= CLAIM_TTL_MS - CLAIM_MARGIN_MS) return false
    checkWanted(job)
    if (attempt === null || attempt.gen !== gen || attempt.id !== job.copy) {
      attempt = { gen, id: job.copy, at: nowIso(), stores: null, manifest: null, pointer: null, pointerPrefix: null, held: null }
    }
    const a = attempt
    const source = sourceOf(keyPair, gen, job)
    if (a.stores === null) {
      const held = await heldStores()
      checkGen(gen)
      const snaps = []
      for (const h of held) {
        snaps.push({ ...h, snap: cutSnap(h.ctx.local.snapshot()), seenTokens: new Set(await store.readDmSeen(storage, h.ctx.prefix)) })
      }
      if (snaps.every((h) => emptySnap(h.snap))) throw new UsageError(NOTHING)
      const rowSets = snaps.map((h) => itemsOfStore(h).rows)
      checkLimits(rowSets, limits)
      // The text's stamps come from the weekly copy allowance first, kept in
      // the attempt so a retry reuses them instead of buying again.
      if (a.held === null) {
        const stopped = () => gen !== env.generation() || !env.unlocked()
        a.held = await source.reserve(stampsNeeded(rowSets), () => !stopped(), stopped)
      }
      checkGen(gen)
      const stores = buildStores(snaps)
      if (stores.some((s) => s.parts.length > limits.parts)) throw new UsageError(TOO_BIG)
      a.stores = stores
    }
    for (const s of a.stores) {
      for (const part of s.parts) {
        checkGen(gen)
        if (part.desc !== null) continue
        await stampRequired(part.sealed, keyPair, a.held, source)
        await putRequired(part.sealed, a.held)
        part.desc = plainDescriptor(part.sealed.descriptor)
        part.sealed = null
      }
    }
    if (a.manifest === null) {
      const json = JSON.stringify({
        v: 3,
        id: a.id,
        at: a.at,
        for: job.for,
        stores: a.stores.map((s) => ({ page: s.page, parts: s.parts.map((p) => p.desc), rows: s.rows, ops: s.ops }))
      })
      a.manifest = { sealed: sealBlob(b4a.from(json, 'utf8')), desc: null }
    }
    if (a.manifest.desc === null) {
      checkGen(gen)
      await stampRequired(a.manifest.sealed, keyPair, a.held, source)
      await putRequired(a.manifest.sealed, a.held)
      a.manifest.desc = plainDescriptor(a.manifest.sealed.descriptor)
      a.manifest.sealed = null
    }
    // Past this point another device may already take the claim for stale.
    if (Date.now() - job.put >= CLAIM_TTL_MS - CLAIM_MARGIN_MS) return false
    if (a.pointer === null) {
      const d = await ownDrop(dm.buildInner({ kind: 'copy', id: a.id, copy: a.manifest.desc, at: a.at }, keyPair), keyPair)
      a.pointer = d.bytes
      a.pointerPrefix = d.prefix
    }
    checkGen(gen)
    checkWanted(job)
    // Recorded before the put: this device never imports its own copy.
    await updateState((s) => { if (!s.made.includes(a.id)) s.made.push(a.id) })
    await putPointer(a.pointer, a.pointerPrefix, () => { a.pointer = null })
    attempt = null
    return true
  }

  // The photo stage of `job`: the cached photos of the own store filed at or
  // below job.top, newest first from job.cursor, in batches (flush), until
  // nothing is left, PHOTO_TOTAL_MAX or BATCHES_MAX is reached, or the copy
  // source ends. The cursor and counts are saved after each batch's pointer.
  async function runPhotos (keyPair, gen, job) {
    const source = sourceOf(keyPair, gen, job)
    const snap = cutSnap(env.personal.local.snapshot())
    if (job.top === null) {
      let top = null
      for (const m of snap.messages) if (Number.isSafeInteger(m.filedAt) && (top === null || m.filedAt > top)) top = m.filedAt
      if (top === null) return
      job.top = top
      await saveJob(job)
    }
    const cands = snap.messages
      .filter((m) => itemsOf(m).length > 0 && m.filedAt <= job.top && (job.cursor === null || m.filedAt < job.cursor) && local.hasMedia(m.from, m.id))
      .sort((x, y) => y.filedAt - x.filedAt)
    let patches = []
    let bytes = 0
    let last = null
    const flush = async () => {
      const id = batchIdOf(job.copy, job.batches)
      const at = nowIso()
      const sealed = sealBlob(b4a.from(JSON.stringify({ v: 2, id, at, for: job.for, photos: patches }), 'utf8'))
      checkGen(gen)
      checkWanted(job)
      await stampRequired(sealed, keyPair, [], source)
      await putBlob(sealed)
      const d = await ownDrop(dm.buildInner({ kind: 'copy', id, copy: plainDescriptor(sealed.descriptor), at }, keyPair), keyPair)
      checkGen(gen)
      checkWanted(job)
      await putPointer(d.bytes, d.prefix)
      job.batches++
      job.bytes += bytes
      job.cursor = last
      job.fails = 0
      await saveJob(job)
      patches = []
      bytes = 0
    }
    for (const m of cands) {
      checkGen(gen)
      checkWanted(job)
      if (job.bytes + bytes >= photoMax || job.batches >= BATCHES_MAX) break
      const items = itemsOf(m)
      const plains = await local.getMedia(m.from, m.id)
      if (plains === null || plains.length !== items.length) {
        if (plains !== null) plains.forEach(wipe)
        continue
      }
      const descs = []
      try {
        for (const plain of plains) {
          const sealed = sealBlob(plain)
          await stampPhoto(sealed, keyPair, source)
          await putBlob(sealed)
          descs.push(plainDescriptor(sealed.descriptor))
        }
      } catch (err) {
        if (err instanceof LeftOut) {
          // The allowance is spent: what this batch holds still goes, then
          // the stage ends.
          if (patches.length > 0) await flush()
          return
        }
        // Failed for now: what this batch holds still goes if it can, so the
        // next kick goes on after it instead of sealing those photos again.
        if (patches.length > 0) await flush().catch(noop)
        throw err
      } finally {
        plains.forEach(wipe)
      }
      const media = items.map((d, i) => env.mediaItem({ ...descs[i], mime: d.mime, w: d.w, h: d.h, ms: d.ms }))
      patches.push(Array.isArray(m.media) ? { from: m.from, id: m.id, media } : { from: m.from, id: m.id, card: { image: media[0] } })
      bytes += descs.reduce((n, d) => n + d.bytes, 0)
      last = m.filedAt
      if (bytes >= batchMax || patches.length >= PATCHES_MAX) await flush()
    }
    if (patches.length > 0) await flush()
  }

  // Pulls until the own claim of `job` is kept here -> whether it was. A pull
  // that fails fails the kick: only pulls that went through and did not
  // bring the claim back say it never reached the pool.
  async function settleClaim (own, gen, job) {
    for (let i = 0; i <= SETTLE_PULLS; i++) {
      checkGen(gen)
      if ((await withAuto(readAuto)).claims.some((c) => c.id === job.id)) return true
      if (i === SETTLE_PULLS) break
      if (i > 0) await sleep(SETTLE_WAIT_MS)
      checkGen(gen)
      await env.pull(own)
    }
    return false
  }

  // The job from its stage on (see the header).
  async function resume (own, keyPair, gen, job) {
    if (job.stage === 'claim' && !(await settleClaim(own, gen, job))) {
      await dropJob(job)
      return
    }
    if (job.stage === 'claim' || job.stage === 'text') {
      const a = await withAuto(readAuto)
      const mine = a.claims.find((c) => c.id === job.id)
      if (mine === undefined || !mine.done) {
        if (!claimWins(a.claims, job, Date.now())) {
          await dropJob(job)
          return
        }
        if (job.stage === 'claim') {
          job.stage = 'text'
          await saveJob(job)
        }
        let put
        try {
          put = await runText(keyPair, gen, job)
        } catch (err) {
          // A copy that can never go: the targets count as done, so no claim
          // is put for them again.
          if (err instanceof UsageError && (err.message === TOO_BIG || err.message === NOTHING)) {
            await updateAuto((x) => {
              for (const t of job.for) if (!x.done.includes(t)) x.done.push(t)
              if (x.job !== null && x.job.id === job.id) x.job = null
            })
            attempt = null
            return
          }
          throw err
        }
        if (!put) {
          await dropJob(job)
          return
        }
      }
      job.stage = 'photos'
      job.top = null
      job.cursor = null
      job.fails = 0
      await updateAuto((x) => {
        for (const c of x.claims) if (c.id === job.id) c.done = true
        for (const t of job.for) if (!x.done.includes(t)) x.done.push(t)
        x.job = jobOf(job)
      })
    }
    await runPhotos(keyPair, gen, job)
    await dropJob(job)
  }

  async function autoRun (own, keyPair, view, gen) {
    setDevice(view)
    if (!env.unlocked() || env.blobOrigin === null) return
    const self = device.self
    const a = await withAuto(readAuto)
    const now = Date.now()
    if (a.job !== null) {
      const j = a.job
      return unlessDropped(j, async () => {
        checkWanted(j)
        // A device whose last pull failed (offline) or was cut short spends
        // nothing and counts no failure: a kick after a complete pull goes on.
        if (!env.pullComplete()) return
        await resume(own, keyPair, gen, j)
      })
    }
    if (self === null || device.off || !env.pullComplete()) return
    const wanted = wantedTargets({ targets: device.targets, claims: a.claims, done: a.done, claimed: a.claimed, now })
    if (wanted.length === 0 || (now - a.lastClaim < CLAIM_GAP_MS && a.lastClaim <= now)) return
    if (!(await holdsRows())) return
    checkGen(gen)
    const job = { id: dm.newMessageId(), copy: dm.newMessageId(), for: wanted.sort().slice(0, dm.DM_CLAIM_FOR_MAX), put: now, stage: 'claim', top: null, cursor: null, batches: 0, bytes: 0, fails: 0 }
    // Saved before the put: a claim whose put fails still counts against the
    // gap and this device's claims per target, and its job ends at a later
    // kick (the claim never comes back).
    await updateAuto((x) => {
      x.job = jobOf(job)
      x.lastClaim = now
      for (const t of job.for) x.claimed[t] = Math.min((x.claimed[t] || 0) + 1, CLAIMS_PER_TARGET)
    })
    await unlessDropped(job, async () => {
      const d = await ownDrop(dm.buildInner({ kind: dm.DM_CLAIM_KIND, id: job.id, copy: job.copy, for: job.for, by: self }, keyPair), keyPair)
      checkGen(gen)
      checkWanted(job)
      await putPointer(d.bytes, d.prefix)
      await resume(own, keyPair, gen, job)
    })
  }

  // Kicked by the session (see the header). One job at a time: a call while
  // one runs gets the running one, which checks this view at its next step.
  // Never throws.
  function autoCopy (own, keyPair, view) {
    if (view === null || typeof view !== 'object') return auto !== null ? auto : Promise.resolve()
    if (auto !== null) {
      setDevice(view)
      return auto
    }
    const gen = env.generation()
    const job = (async () => {
      try {
        await autoRun(own, keyPair, view, gen)
      } catch {
        if (gen === env.generation() && env.unlocked()) {
          env.log('aviso: cópia automática de conversas não concluída')
          try {
            await failJob()
          } catch {}
        }
      } finally {
        if (auto === job) auto = null
      }
    })()
    auto = job
    return job
  }

  // { self, off, targets? } of this device, from the session -> whether self
  // or off changed. A view without targets (device.hello, device.list)
  // keeps the ones known for the same self.
  function setDevice (v) {
    if (v === null || typeof v !== 'object') return false
    const self = typeof v.self === 'string' && HEX64.test(v.self) ? v.self : null
    let targets = []
    if (Array.isArray(v.targets)) targets = v.targets.filter((x) => typeof x === 'string' && HEX64.test(x) && x !== self)
    else if (device !== null && device.self === self) targets = device.targets
    const next = { self, off: v.off === true, targets }
    const changed = device === null || device.self !== next.self || device.off !== next.off
    device = next
    return changed
  }

  // on: true while the session's own diary may lag behind a record that
  // turns this device off (its link dropped, or the diary fell behind); an
  // import then waits, and one running stops before its next part, store or
  // photo. -> whether this call released a hold.
  function holdImports (on) {
    const was = importsHeld
    importsHeld = on === true
    return was && !importsHeld
  }

  // The rows of one held store in filing order with n. Each is the store's
  // own plain row without filedAt (never a key of the store), plus n, seen (a
  // received message marked seen here) and, on a message, shownAt: the time
  // this device shows it (the one it imported, else when it filed it).
  function itemsOfStore (h) {
    const rows = []
    let msgs = 0
    let ops = 0
    for (const r of rowsOf(h.snap)) {
      const row = { ...r }
      delete row.filedAt
      const item = { ...row, n: rows.length }
      if (r.t === 'msg') {
        msgs++
        const shown = r.shownAt !== undefined ? r.shownAt : r.filedAt
        if (Number.isSafeInteger(shown) && shown >= 0) item.shownAt = shown
        if (!r.mine && h.seenTokens.has(h.ctx.local.seenToken(dmFold.seenKey(r.from, r.id)))) item.seen = true
      } else {
        ops++
      }
      rows.push(item)
    }
    return { rows, msgs, ops }
  }

  // Cut into sealed parts. A store with no rows is left out of the manifest:
  // the reader refuses a store without parts.
  function buildStores (snaps) {
    const out = []
    for (const h of snaps) {
      const { rows, msgs, ops } = itemsOfStore(h)
      if (rows.length === 0) continue
      out.push({ page: h.page, rows: msgs, ops, parts: splitParts(h.page, rows) })
    }
    return out
  }

  function splitParts (page, rows) {
    return cutRows(rows).map((cur) => ({ sealed: sealBlob(b4a.from(JSON.stringify({ v: 1, page, rows: cur }), 'utf8')), desc: null }))
  }

  // ---- importing a copy ----

  // The pointer rows ({ id, copy }) and claim rows ({ id, copy, for, by, at,
  // seq }) a pull opened. A claim is kept; a pointer marks the claim whose
  // copy id it carries done, and becomes a todo entry unless the id was made
  // or imported here or is already waiting.
  async function note (pointers, claims = []) {
    if (pointers.length === 0 && claims.length === 0) return
    await updateAuto((a) => {
      const now = Date.now()
      for (const c of claims) {
        if (a.claims.some((x) => x.id === c.id)) continue
        // The own claim lives from its put, not from when it came back.
        const kept = { id: c.id, copy: c.copy, for: c.for, by: c.by, at: c.at, seq: c.seq, seen: a.job !== null && a.job.id === c.id ? a.job.put : now, done: false }
        if (!validKept(kept)) continue
        a.claims.push(keptOf(kept))
      }
      for (const p of pointers) for (const c of a.claims) if (c.copy === p.id) c.done = true
      while (a.claims.length > CLAIMS_KEPT_MAX) a.claims.shift()
    })
    if (pointers.length === 0) return
    await updateState((s) => {
      for (const p of pointers) {
        if (!HEX32.test(p.id) || !blobCore.validateBlobDescriptor(p.copy)) continue
        if (s.made.includes(p.id) || s.imported.includes(p.id) || s.todo.some((t) => t.id === p.id)) continue
        if (s.todo.length >= TODO_MAX) s.todo.shift()
        s.todo.push({ id: p.id, copy: plainDescriptor(p.copy), seen: Date.now(), fails: 0, horizons: {} })
      }
    })
  }

  // A manifest that is gone (404) ends the copy; a part that is gone or does
  // not verify, or a manifest that does not verify (a seeder restarting, a
  // proxy rewriting a body), is Soft: the todo waits for a later pull.
  async function fetchJson (desc, part) {
    if (!blobCore.validateBlobDescriptor(desc) || desc.bytes - blobCore.BLOB_MAC_BYTES > PART_PLAIN_MAX) throw new Dead()
    let r
    try {
      r = await fetchBlob(plainDescriptor(desc), env.blobOrigin, { mime: 'application/json', fetch: env.fetchImpl, limits: env.fetchLimits })
    } catch (err) {
      const msg = err && err.message
      if (msg === MEDIA_GONE && !part) throw new Dead()
      if (msg === MEDIA_GONE || msg === BAD_MEDIA) throw new Soft()
      throw err
    }
    try {
      return JSON.parse(b4a.toString(r.bytes, 'utf8'))
    } catch {
      throw new Dead()
    } finally {
      wipe(r.bytes)
    }
  }

  // A text manifest: v3 names its targets (`for`); v1, made by hand on an
  // earlier build, names none.
  function validManifest (m, id) {
    const v3 = m !== null && typeof m === 'object' && m.v === 3
    if (!exactKeys(m, v3 ? ['v', 'id', 'at', 'for', 'stores'] : ['v', 'id', 'at', 'stores']) || (m.v !== 1 && !v3) || m.id !== id || typeof m.at !== 'string' || !ISO.test(m.at)) return false
    if (v3 && !idSet(m.for, dm.DM_CLAIM_FOR_MAX)) return false
    if (!Array.isArray(m.stores) || m.stores.length < 1 || m.stores.length > STORES_MAX) return false
    const pages = new Set()
    for (const s of m.stores) {
      if (!exactKeys(s, ['page', 'parts', 'rows', 'ops']) || !isCount(s.rows) || !isCount(s.ops)) return false
      if (s.page !== null && (typeof s.page !== 'string' || !HEX64.test(s.page))) return false
      if (pages.has(s.page)) return false
      pages.add(s.page)
      if (!Array.isArray(s.parts) || s.parts.length < 1 || s.parts.length > PARTS_MAX || !s.parts.every((d) => blobCore.validateBlobDescriptor(d))) return false
    }
    return true
  }

  function validPatch (p) {
    if (p === null || typeof p !== 'object' || typeof p.from !== 'string' || !HEX64.test(p.from) || typeof p.id !== 'string' || !HEX32.test(p.id)) return false
    const item = (d) => d !== null && typeof d === 'object' && blobCore.validateBlobDescriptor(plainDescriptor(d)) && typeof d.mime === 'string'
    if (exactKeys(p, ['from', 'id', 'media'])) return Array.isArray(p.media) && p.media.length >= 1 && p.media.length <= dm.DM_MEDIA_MAX && p.media.every(item)
    return exactKeys(p, ['from', 'id', 'card']) && exactKeys(p.card, ['image']) && item(p.card.image)
  }

  function validBatch (m, id) {
    return exactKeys(m, ['v', 'id', 'at', 'for', 'photos']) && m.v === 2 && m.id === id && typeof m.at === 'string' && ISO.test(m.at) &&
      idSet(m.for, dm.DM_CLAIM_FOR_MAX) && Array.isArray(m.photos) && m.photos.length >= 1 && m.photos.length <= PATCHES_MAX && m.photos.every(validPatch)
  }

  // A v2 photo batch on a device it names: each patch whose message is held
  // in the own store, not hidden by a delete, not cached yet and whose items
  // match opens with the new descriptors, which fills the cache. -> the
  // photos opened. A photo that did not open is Soft: the batch stays for a
  // later pull, which skips what is cached by then.
  async function applyBatch (m, gen) {
    const d = device
    if (d === null || importsHeld) throw new Stop()
    if (d.off || d.self === null || !m.for.includes(d.self)) return 0
    const lc = env.personal.local
    const rows = new Map(lc.snapshot().messages.map((r) => [r.from + '\n' + r.id, r]))
    let opened = 0
    let soft = false
    // Turned off, told another id or held since the batch began: the photos
    // opened so far stay, the rest waits (importPass goes by the new state).
    let stopped = false
    for (const p of m.photos) {
      alive(gen)
      const x = device
      if (x === null || x.off || x.self !== d.self || importsHeld) {
        stopped = true
        break
      }
      const row = rows.get(p.from + '\n' + p.id)
      if (row === undefined || lc.hiddenByDelete(row.from, row.id) || lc.hasMedia(row.from, row.id)) continue
      const items = itemsOf(row)
      const patched = p.media !== undefined ? p.media : [p.card.image]
      if (items.length !== patched.length || items.some((x, i) => x.mime !== patched[i].mime)) continue
      let next
      if (p.media !== undefined && Array.isArray(row.media)) next = { ...row, media: patched.map((x) => env.mediaItem(x)) }
      else if (p.card !== undefined && row.card && row.card.image) next = { ...row, card: copyLinkCard(row.card, () => env.mediaItem(p.card.image)) }
      else continue
      if (!validRow(next)) continue
      try {
        await env.openCopied(next)
        opened++
      } catch {
        soft = true
      }
    }
    if (opened > 0 && gen === env.generation()) env.emit('dm.changed', { added: 0 })
    alive(gen)
    if (stopped) throw new Stop()
    if (soft) throw new Soft()
    return opened
  }

  // Newest first, within the prefetch budget, never for a conversation in
  // the request folder, and only messages younger than DM_RETENTION_MS: an
  // older original blob is gone (a photo batch brings that photo under a new
  // one), and opening it would only mark the photo unavailable meanwhile.
  async function prefetch (own, fresh) {
    if (fresh.length === 0) return
    let requests
    try {
      requests = new Set((await env.folded(own)).requests.map((c) => c.peer))
    } catch {
      return
    }
    let budget = PREFETCH_BYTES_MAX
    const now = Date.now()
    for (const m of fresh.sort((x, y) => y.filedAt - x.filedAt)) {
      if (requests.has(m.peer) || !(now - Date.parse(m.at) < dm.DM_RETENTION_MS)) continue
      budget -= mediaBytes(m)
      if (budget < 0) break
      env.openMedia(m, true).catch(noop)
    }
  }

  // ---- Página stores that wait for their secrets ----

  async function readPendMeta (k) {
    const sealed = await store.readCopyPiece(storage, k, 'meta')
    const v = sealed === null ? null : local.open(sealed)
    if (v === null || typeof v !== 'object' || typeof v.id !== 'string' || !HEX32.test(v.id) || typeof v.page !== 'string' || !HEX64.test(v.page) || !Number.isSafeInteger(v.seen)) return null
    return { id: v.id, page: v.page, seen: v.seen, horizon: isCount(v.horizon) ? v.horizon : null }
  }

  async function hold (id, page, rows) {
    const bytes = b4a.from(JSON.stringify({ rows }), 'utf8')
    try {
      const n = Math.ceil(bytes.byteLength / PIECE_BYTES)
      if (n < 1 || n > PIECES_MAX) {
        env.log('aviso: conversas de uma Página grandes demais para guardar')
        return
      }
      const items = await store.readCopyPend(storage)
      for (const e of items) {
        const meta = await readPendMeta(e.k)
        if (meta !== null && meta.id === id && meta.page === page) return
      }
      const k = b4a.toString(hcrypto.randomBytes(8), 'hex')
      while (items.length >= PEND_MAX) await store.deleteCopyPendEntry(storage, items.shift().k)
      // The index first: a crash after it leaves an entry settle() finds
      // incomplete and deletes with its pieces, where pieces written first
      // would be left with nothing that deletes them.
      await store.writeCopyPend(storage, [...(await store.readCopyPend(storage)), { k, n }])
      await store.writeCopyPiece(storage, k, 'meta', local.seal({ id, page, seen: Date.now() }))
      for (let i = 0; i < n; i++) {
        await store.writeCopyPiece(storage, k, i, local.sealBytes(bytes.subarray(i * PIECE_BYTES, (i + 1) * PIECE_BYTES)))
      }
    } finally {
      wipe(bytes)
    }
  }

  // Files the held-back stores whose page is held now, drops the expired.
  // -> the messages filed, or -1 when nothing was filed.
  async function settle () {
    let messages = 0
    let any = false
    const mod = await env.moderation()
    for (const e of await store.readCopyPend(storage)) {
      const meta = await readPendMeta(e.k)
      if (meta === null || Date.now() - meta.seen > dm.DM_RETENTION_MS) {
        await store.deleteCopyPendEntry(storage, e.k)
        continue
      }
      if (env.pages.get(meta.page) === null) continue
      const chunks = []
      let ok = true
      for (let i = 0; i < e.n; i++) {
        const sealed = await store.readCopyPiece(storage, e.k, i)
        const piece = sealed === null ? null : local.openBytes(sealed)
        if (piece === null) {
          ok = false
          break
        }
        chunks.push(piece)
      }
      let rows = null
      if (ok) {
        const joined = b4a.concat(chunks)
        try {
          const v = JSON.parse(b4a.toString(joined, 'utf8'))
          if (v !== null && typeof v === 'object' && Array.isArray(v.rows)) rows = v.rows
        } catch {}
        wipe(joined)
      }
      chunks.forEach(wipe)
      if (rows === null) {
        await store.deleteCopyPendEntry(storage, e.k)
        continue
      }
      let ctx
      try {
        ctx = await env.pageCtx(meta.page)
      } catch {
        continue
      }
      const pin = {
        get: () => meta.horizon,
        set: async (h) => {
          meta.horizon = h
          await store.writeCopyPiece(storage, e.k, 'meta', local.seal({ id: meta.id, page: meta.page, seen: meta.seen, horizon: h }))
        }
      }
      const f = await fileRows(ctx, storage, meta.page, rows, mod.association, { pin })
      await store.deleteCopyPendEntry(storage, e.k)
      messages += f.messages
      if (f.messages + f.ops + f.reactions > 0) {
        any = true
        env.emit('dm.changed', { added: f.messages, page: meta.page })
      }
    }
    return any ? messages : -1
  }

  // A lock or a reset since the import began stops the rest of it.
  function alive (gen) {
    if (gen !== env.generation() || !env.unlocked()) throw new Stop()
  }

  async function importOne (own, t, gen) {
    alive(gen)
    const manifest = await fetchJson(t.copy, false)
    if (manifest !== null && typeof manifest === 'object' && manifest.v === 2) {
      if (!validBatch(manifest, t.id)) throw new Dead()
      await applyBatch(manifest, gen)
      return { messages: 0, filed: 0 }
    }
    if (!validManifest(manifest, t.id)) throw new Dead()
    // This device as importPass saw it; a change of id or a turn off since
    // stops the import before the next part or store (importPass then drops
    // what waits).
    const self = device === null ? null : device.self
    const still = () => {
      const x = device
      if (x === null || x.off || x.self !== self || importsHeld) throw new Stop()
    }
    still()
    // A copy made for named devices goes only to them, whatever this device
    // kept of its claim; one that does not know its id yet waits.
    if (manifest.v === 3) {
      if (self === null) throw new Stop()
      if (!manifest.for.includes(self)) return { messages: 0, filed: 0 }
    }
    const bundles = []
    for (const s of manifest.stores) {
      const rows = []
      for (const d of s.parts) {
        alive(gen)
        still()
        const part = await fetchJson(d, true)
        if (!exactKeys(part, ['v', 'page', 'rows']) || part.v !== 1 || part.page !== s.page || !Array.isArray(part.rows)) throw new Dead()
        for (const r of part.rows) rows.push(r)
        if (rows.length > ROWS_MAX) throw new Dead()
      }
      bundles.push({ page: s.page, rows })
    }
    alive(gen)
    const mod = await env.moderation()
    let messages = 0
    let filed = 0
    for (const b of bundles) {
      alive(gen)
      still()
      let ctx = null
      if (b.page === null) ctx = env.personal
      else if (env.pages.get(b.page) !== null) {
        try {
          ctx = await env.pageCtx(b.page)
        } catch {
          ctx = null
        }
      }
      if (ctx === null) {
        await hold(t.id, b.page, b.rows)
        continue
      }
      const key = b.page === null ? 'own' : b.page
      // Written to the todo before the first chunk, so a retry after an
      // interruption files the rest at the positions it would have had.
      const pin = {
        get: () => (isCount(t.horizons[key]) ? t.horizons[key] : null),
        set: async (h) => {
          t.horizons[key] = h
          await updateState((st) => {
            const x = st.todo.find((y) => y.id === t.id)
            if (x !== undefined) x.horizons[key] = h
          })
        }
      }
      const f = await fileRows(ctx, storage, b.page === null ? own : b.page, b.rows, b.page === null ? mod.blocked : mod.association, { pin })
      messages += f.messages
      filed += f.messages + f.ops + f.reactions
      if (f.messages + f.ops + f.reactions > 0) env.emit('dm.changed', b.page === null ? { added: f.messages } : { added: f.messages, page: b.page })
      if (b.page === null) await prefetch(own, f.fresh)
    }
    return { messages, filed }
  }

  // Imports the todo pointers, oldest first, then settles the held-back
  // Página stores. Never throws: a failure that is not final keeps its todo
  // for the next pull.
  // One job at a time: a call while one runs joins it, and the running job
  // goes over the todo once more when it ends, so a pointer noted meanwhile
  // is not left for a later pull. The caller does not have to wait for it.
  // Only the first pass of a job (the one the pull that started it asked for)
  // counts a failure against a todo: the passes that overlapping pulls add
  // are re-reads of the same moment, so a seeder that answers 404 for a few
  // seconds cannot use up the three failures a copy has.
  function importAll (own) {
    if (importing !== null) {
      again = true
      return importing
    }
    const job = (async () => {
      try {
        let counts = true
        do {
          again = false
          await importPass(own, counts)
          counts = false
        } while (again && env.unlocked())
      } finally {
        importing = null
        again = false
      }
    })()
    importing = job
    return job
  }

  async function importPass (own, counts) {
    const gen = env.generation()
    if (env.blobOrigin === null) return
    let total = 0
    let any = false
    const handled = (id) => updateState((st) => {
      st.todo = st.todo.filter((x) => x.id !== id)
      if (!st.imported.includes(id)) st.imported.push(id)
    })
    try {
      const s = await withState(readState)
      const d = device
      // Until the session says which device this is, everything waits (it
      // may be a disconnected one); a disconnected device imports nothing,
      // and what waits is dropped.
      if (d === null) return
      if (d.off) {
        for (const t of s.todo) await handled(t.id)
        return
      }
      if (importsHeld) return
      const claimOf = s.todo.length === 0 ? null : claimIndex(await withAuto(readAuto))
      // Text pointers of claimed copies not imported yet: a photo batch of
      // the same copy waits for its text, or it would find no rows to fill.
      const textPending = new Set()
      for (const t of s.todo) {
        const c = claimOf.get(t.id)
        if (c !== undefined && c.copy === t.id) textPending.add(t.id)
      }
      for (const t of s.todo) {
        if (gen !== env.generation() || !env.unlocked()) return
        // Turned off or told another id since the pass began: the next pass
        // (setDevice starts one) goes by the new state.
        const now = device
        if (now === null || now.off || now.self !== d.self || importsHeld) return
        if (Date.now() - t.seen > dm.DM_RETENTION_MS) {
          textPending.delete(t.id)
          await updateState((st) => { st.todo = st.todo.filter((x) => x.id !== t.id) })
          continue
        }
        // A claimed copy goes only to the devices its claim names; a device
        // without an id yet waits.
        const claim = claimOf.get(t.id)
        if (claim !== undefined) {
          if (d.self === null) continue
          if (!claim.for.includes(d.self)) {
            textPending.delete(t.id)
            await handled(t.id)
            continue
          }
          if (claim.copy !== t.id && textPending.has(claim.copy)) continue
        }
        let r
        try {
          r = await importOne(own, t, gen)
        } catch (err) {
          if (err instanceof Stop) return
          if (err instanceof Dead) {
            textPending.delete(t.id)
            await updateState((st) => {
              st.todo = st.todo.filter((x) => x.id !== t.id)
              if (!st.imported.includes(t.id)) st.imported.push(t.id)
            })
            continue
          }
          if (err instanceof Soft) {
            // The next pull tries again; the third pull that fails so ends it.
            await updateState((st) => {
              const x = st.todo.find((y) => y.id === t.id)
              if (x === undefined) return
              if (counts) x.fails = Math.min(x.fails + 1, FAILS_MAX)
              if (x.fails >= FAILS_MAX) {
                textPending.delete(t.id)
                st.todo = st.todo.filter((y) => y.id !== t.id)
                if (!st.imported.includes(t.id)) st.imported.push(t.id)
              }
            })
            env.log('aviso: cópia de conversas de outro aparelho ainda não importada')
            continue
          }
          env.log('aviso: cópia de conversas de outro aparelho ainda não importada')
          break
        }
        textPending.delete(t.id)
        await updateState((st) => {
          st.todo = st.todo.filter((x) => x.id !== t.id)
          if (!st.imported.includes(t.id)) st.imported.push(t.id)
        })
        total += r.messages
        any = any || r.filed > 0
      }
      if (gen === env.generation() && env.unlocked()) {
        const settled = await settle()
        if (settled >= 0) {
          total += settled
          any = true
        }
      }
    } catch {
      env.log('aviso: cópia de conversas de outro aparelho ainda não importada')
    }
    if (any && gen === env.generation()) env.emit('dm.copyImported', { messages: total })
  }

  // Text pointer and photo batch ids -> the kept claim they belong to.
  function claimIndex (a) {
    const out = new Map()
    for (const c of a.claims) {
      out.set(c.copy, c)
      for (let i = 0; i < BATCHES_MAX; i++) out.set(batchIdOf(c.copy, i), c)
    }
    return out
  }

  // A lock: the attempt, the copy source and the device go (the next unlock
  // may be another identity); the job stays in kv for the next kick.
  function reset () {
    attempt = null
    jobSource = null
    device = null
    importsHeld = false
  }

  return {
    note,
    importAll,
    autoCopy,
    setDevice,
    holdImports,
    reset,
    get copying () { return auto !== null }
  }
}

module.exports = {
  createDmCopy,
  cleanRow,
  checkLimits,
  fileRows,
  stampsNeeded,
  manifestBytes,
  batchIdOf,
  claimWins,
  wantedTargets,
  LIMITS,
  NOTHING,
  COPY_FAILED,
  TOO_BIG,
  PART_BYTES,
  CLAIM_TTL_MS,
  CLAIM_MARGIN_MS,
  CLAIM_GAP_MS,
  CLAIMS_PER_TARGET,
  COPY_WINDOW_MS,
  PHOTO_BATCH_BYTES,
  PHOTO_TOTAL_MAX
}
