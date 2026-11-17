'use strict'

// Copying the conversation history to another device of the same identity
// (docs/protocol.md section 11 "History copy", docs/rpc.md 5.152). The
// browser node's engine (./dm.js) wires this module in with the pieces it
// owns; nothing here touches the network except through them.
//
// The old device (historyCopy, only on the user's dm.historyCopy call):
//   1. Every store held here (the own one and each held Página's) is read as
//      rows in filing order, each with its position n. The cached photos of
//      the own store are sealed again as NEW blobs (a fresh key, so the
//      original blob and key are never reused) and put, newest first; a row
//      whose photos travelled points at the new descriptors and carries c: 1.
//      A photo not cached here, or left out because the weekly copy
//      allowance ended, stays as it was and is counted.
//   2. The rows are cut into parts of at most PART_BYTES, each sealed as a
//      blob and put; a manifest naming the parts is sealed and put the same
//      way; last, a v7 pointer drop (kind 'copy', signed by the identity key,
//      sealed to the own box, one dm stamp) is put to the dm pool.
//   3. Blob stamps come from the copy source first (the seeder's weekly copy
//      allowance, ./blob.js copySource). The text's stamps (every part and the
//      manifest, estimated from the rows) are reserved from it BEFORE any
//      photo, so photos can never push the text onto the daily wallet. A
//      photo is paid from the rest of the allowance only: when it cannot be
//      used (ended, an older seeder, no answer, any failure) the photo is left
//      out and counted, never paid from the daily wallet. The text parts and
//      the manifest must go, so whatever the reservation did not cover (an
//      older seeder, a refusal or no answer, an allowance an earlier copy
//      spent) falls back to the daily wallet. The reservation is bought in
//      batches over several stamp links, so a link's deadline is not a case.
//   A failed call is a normal error and repeats nothing by itself. The user's
//   retry in the same unlock keeps the copy id, the photos already put (only
//   their new descriptors are kept), and the sealed parts, manifest and
//   pointer frames, so a blob or a drop is put again as the SAME bytes (the
//   pool answers an identical frame as a repeated success) and no stamp is
//   spent twice. The id is recorded as made here before the pointer is put.
//
// Every device (note, importAll), from the pull:
//   - The pointer opens only under the own box, signed by the own key (core
//     dm.js openInner, kind 'copy'). A copy id made or imported here is
//     skipped. Anything else becomes a todo in kv dmCopy (sealed), so a
//     pointer the cursor already passed is not lost while the blobs are
//     unreachable; a todo older than DM_RETENTION_MS is dropped.
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
//   - The photos that travelled are fetched in the background (the engine's
//     openMedia, newest first, within PREFETCH_BYTES_MAX), never for a
//     conversation in the request folder.
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

const COPY_BUSY = 'cópia de conversas já em andamento'
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
const IMPORTED_MAX = 64
const TODO_MAX = 8
const FAILS_MAX = 3
const PREFETCH_BYTES_MAX = 64 * 1048576
const CHUNK_ROWS = 500
const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

function noop () {}

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
// count at its widest.
function manifestBytes (stores, parts) {
  const d = JSON.stringify({ id: '0'.repeat(64), key: '0'.repeat(64), nonce: '0'.repeat(48), chunks: 257, bytes: 8421504, sha256: '0'.repeat(64) })
  const page = JSON.stringify({ page: '0'.repeat(64), parts: [], rows: ROWS_MAX, ops: ROWS_MAX })
  return 128 + stores * (page.length + 1) + parts * (d.length + 1)
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
  let copying = false
  // The copy being retried by the user in this unlock (see the header).
  let attempt = null
  let stateLock = Promise.resolve()
  // The running import job (importAll) and whether a call joined it.
  let importing = null
  let again = false

  function withState (fn) {
    const p = stateLock.then(fn)
    stateLock = p.catch(noop)
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

  // ---- making a copy ----

  // The one place the pointer drop is put, with the bucket prefix of the box
  // it is sealed to: the own one, so only the own bucket's pulls carry it
  // (docs/protocol.md section 11).
  async function putPointer (bytes, prefix) {
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
        if (r.reason === 'invalido' && attempt !== null) attempt.pointer = null
        throw env.refusal(r.reason)
      }
    } finally {
      link.close()
    }
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
  async function putRequired (sealed, a) {
    try {
      await putBlob(sealed)
    } catch (err) {
      if (err && err.reason === 'invalido') a.held = []
      throw err
    }
  }

  // A photo: the weekly copy allowance only. When it cannot be used (it
  // ended, an older seeder, no answer, any failure) the photo is left out
  // (LeftOut); a copy never spends the daily blob wallet on a photo.
  async function stampPhoto (sealed, keyPair, source) {
    try {
      await blobs.stamp(sealed, keyPair, source)
    } catch (err) {
      if (err instanceof UsageError) throw new LeftOut()
      throw err
    }
  }

  // Text parts and the manifest must go: the stamps reserved for them before
  // any photo, then the copy source for a shortfall, and only what neither
  // covers (an older seeder, no answer, an allowance spent by an earlier
  // copy this week) is paid from the daily wallet.
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

  // -> { id, messages, photos, notCached, leftOut }
  async function historyCopy (own, keyPair) {
    env.requireUnlocked()
    if (copying) throw new UsageError(COPY_BUSY)
    copying = true
    const gen = env.generation()
    try {
      return await run(keyPair, gen)
    } finally {
      copying = false
    }
  }

  async function run (keyPair, gen) {
    if (attempt === null || attempt.gen !== gen) {
      attempt = { gen, id: dm.newMessageId(), at: nowIso(), photos: new Map(), stores: null, counts: null, manifest: null, pointer: null, pointerPrefix: null, held: null }
    }
    const a = attempt
    const source = blobs.copySource(keyPair)

    if (a.stores === null) {
      const held = [{ page: null, ctx: env.personal }]
      for (const page of env.pages.pages()) {
        try {
          held.push({ page, ctx: await env.pageCtx(page) })
        } catch {}
      }
      checkGen(gen)
      const snaps = []
      for (const h of held) {
        snaps.push({ ...h, snap: cutSnap(h.ctx.local.snapshot()), seenTokens: new Set(await store.readDmSeen(storage, h.ctx.prefix)) })
      }
      if (snaps.every((h) => h.snap.messages.length + h.snap.ops.length + h.snap.reactions.length === 0)) throw new UsageError(NOTHING)
      const rowSets = snaps.map((h) => itemsOfStore(h, new Map()).rows)
      checkLimits(rowSets, limits)
      // The photos of the own store, newest first.
      const cands = []
      // notCached: photos this device no longer holds; leftOut: photos the
      // weekly copy allowance did not reach.
      let notCached = 0
      let leftOut = 0
      for (const m of snaps[0].snap.messages) {
        const items = itemsOf(m)
        if (items.length === 0) continue
        if (!local.hasMedia(m.from, m.id)) notCached += items.length
        else cands.push(m)
      }
      cands.sort((x, y) => y.filedAt - x.filedAt)
      // The text goes first: its stamps are taken from the weekly copy
      // allowance before any photo can spend it, and kept in the attempt so a
      // retry reuses them instead of buying again. A large text takes several
      // batches (each over its own link), and each batch is one step of the
      // progress: between them the unlock is checked and the sheet moves on.
      // A retry that holds the stamps has no batch.
      const need = stampsNeeded(rowSets)
      const batches = a.held === null ? Math.ceil(need / source.chunk) : 0
      const total = cands.length + 2 + batches
      a.total = total
      let done = 0
      if (a.held === null) {
        env.emit('dm.copyProgress', { done, total })
        const stopped = () => gen !== env.generation() || !env.unlocked()
        a.held = await source.reserve(need, () => {
          if (stopped()) return false
          done++
          env.emit('dm.copyProgress', { done, total })
          return true
        }, stopped)
        // It may have stopped early (the allowance ended): the steps of the
        // batches not bought are counted as done.
        done = batches
      }
      checkGen(gen)
      env.emit('dm.copyProgress', { done, total })
      let photos = 0
      let stop = false
      for (const m of cands) {
        checkGen(gen)
        const key = m.from + '\n' + m.id
        const items = itemsOf(m)
        if (stop) {
          leftOut += items.length
          continue
        }
        let entry = a.photos.get(key)
        if (entry === undefined) {
          entry = { slots: items.map(() => ({ sealed: null, desc: null })), media: null }
          a.photos.set(key, entry)
        }
        if (entry.media === null) {
          const plains = await local.getMedia(m.from, m.id)
          if (plains === null || plains.length !== items.length) {
            if (plains !== null) plains.forEach(wipe)
            notCached += items.length
            a.photos.delete(key)
            continue
          }
          try {
            for (let i = 0; i < items.length; i++) {
              const slot = entry.slots[i]
              if (slot.desc !== null) continue
              if (slot.sealed === null) slot.sealed = sealBlob(plains[i])
              await stampPhoto(slot.sealed, keyPair, source)
              await putBlob(slot.sealed)
              slot.desc = plainDescriptor(slot.sealed.descriptor)
              slot.sealed = null
            }
          } catch (err) {
            if (err instanceof LeftOut) {
              stop = true
              leftOut += items.length
              continue
            }
            throw err
          } finally {
            plains.forEach(wipe)
          }
          entry.media = items.map((d, i) => env.mediaItem({ ...entry.slots[i].desc, mime: d.mime, w: d.w, h: d.h, ms: d.ms }))
        }
        photos += items.length
        done++
        env.emit('dm.copyProgress', { done, total })
      }
      checkGen(gen)
      // Checked before it is kept: a retry after a refusal here must not
      // find stores to upload and no counts.
      const stores = buildStores(snaps, a.photos)
      if (stores.some((s) => s.parts.length > limits.parts)) throw new UsageError(TOO_BIG)
      a.stores = stores
      a.counts = { photos, notCached, leftOut }
    }
    const total = a.total
    let done = total - 2
    let messages = 0
    for (const s of a.stores) messages += s.rows

    for (const s of a.stores) {
      for (const part of s.parts) {
        checkGen(gen)
        if (part.desc !== null) continue
        await stampRequired(part.sealed, keyPair, a.held, source)
        await putRequired(part.sealed, a)
        part.desc = plainDescriptor(part.sealed.descriptor)
        part.sealed = null
      }
    }
    if (a.manifest === null) {
      const json = JSON.stringify({
        v: 1,
        id: a.id,
        at: a.at,
        stores: a.stores.map((s) => ({ page: s.page, parts: s.parts.map((p) => p.desc), rows: s.rows, ops: s.ops }))
      })
      a.manifest = { sealed: sealBlob(b4a.from(json, 'utf8')), desc: null }
    }
    if (a.manifest.desc === null) {
      checkGen(gen)
      await stampRequired(a.manifest.sealed, keyPair, a.held, source)
      await putRequired(a.manifest.sealed, a)
      a.manifest.desc = plainDescriptor(a.manifest.sealed.descriptor)
      a.manifest.sealed = null
    }
    done++
    env.emit('dm.copyProgress', { done, total })

    if (a.pointer === null) {
      const inner = dm.buildInner({ kind: 'copy', id: a.id, copy: a.manifest.desc, at: a.at }, keyPair)
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
      a.pointer = env.dropOf(sealed, stamps[0])
      a.pointerPrefix = bucketOf(boxKey)
    }
    checkGen(gen)
    // Recorded before the put: this device never imports its own copy.
    await updateState((s) => { if (!s.made.includes(a.id)) s.made.push(a.id) })
    await putPointer(a.pointer, a.pointerPrefix)
    done++
    env.emit('dm.copyProgress', { done, total })
    attempt = null
    return { id: a.id, messages, photos: a.counts.photos, notCached: a.counts.notCached, leftOut: a.counts.leftOut }
  }

  // The rows of one held store in filing order with n, the photos that
  // travelled swapped in. Each is the store's own plain row without filedAt
  // (never a key of the store), plus n, seen (a received message marked seen
  // here), c (its photos travelled) and, on a message, shownAt: the time this
  // device shows it (the one it imported, else when it filed it).
  function itemsOfStore (h, photoMap) {
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
        const entry = photoMap.get(r.from + '\n' + r.id)
        if (h.page === null && entry !== undefined && entry.media !== null) {
          if (Array.isArray(r.media)) item.media = entry.media.map((d) => ({ ...d }))
          else if (r.card && r.card.image) item.card = copyLinkCard(r.card, () => ({ ...entry.media[0] }))
          item.c = 1
        }
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
  function buildStores (snaps, photoMap) {
    const out = []
    for (const h of snaps) {
      const { rows, msgs, ops } = itemsOfStore(h, photoMap)
      if (rows.length === 0) continue
      out.push({ page: h.page, rows: msgs, ops, parts: splitParts(h.page, rows) })
    }
    return out
  }

  function splitParts (page, rows) {
    return cutRows(rows).map((cur) => ({ sealed: sealBlob(b4a.from(JSON.stringify({ v: 1, page, rows: cur }), 'utf8')), desc: null }))
  }

  // ---- importing a copy ----

  // The pointer rows a pull opened ({ id, copy }) -> todo entries, unless
  // the id was made or imported here or is already waiting.
  async function note (pointers) {
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

  function validManifest (m, id) {
    if (!exactKeys(m, ['v', 'id', 'at', 'stores']) || m.v !== 1 || m.id !== id || typeof m.at !== 'string' || !ISO.test(m.at)) return false
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

  // Newest first, within the prefetch budget, never for a conversation in
  // the request folder.
  async function prefetch (own, fresh) {
    if (fresh.length === 0) return
    let requests
    try {
      requests = new Set((await env.folded(own)).requests.map((c) => c.peer))
    } catch {
      return
    }
    let budget = PREFETCH_BYTES_MAX
    for (const m of fresh.sort((x, y) => y.filedAt - x.filedAt)) {
      if (requests.has(m.peer)) continue
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
    if (!validManifest(manifest, t.id)) throw new Dead()
    const bundles = []
    for (const s of manifest.stores) {
      const rows = []
      for (const d of s.parts) {
        alive(gen)
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
    try {
      const s = await withState(readState)
      for (const t of s.todo) {
        if (gen !== env.generation() || !env.unlocked()) return
        if (Date.now() - t.seen > dm.DM_RETENTION_MS) {
          await updateState((st) => { st.todo = st.todo.filter((x) => x.id !== t.id) })
          continue
        }
        let r
        try {
          r = await importOne(own, t, gen)
        } catch (err) {
          if (err instanceof Stop) return
          if (err instanceof Dead) {
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

  function reset () {
    attempt = null
  }

  return {
    historyCopy,
    note,
    importAll,
    reset,
    get copying () { return copying }
  }
}

module.exports = { createDmCopy, cleanRow, checkLimits, fileRows, stampsNeeded, manifestBytes, LIMITS, COPY_BUSY, NOTHING, COPY_FAILED, TOO_BIG, PART_BYTES }
