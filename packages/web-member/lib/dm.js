'use strict'

// Direct messages in the browser node (docs/rpc.md 5.73 to 5.81,
// docs/protocol.md section 11): the engine behind the dm.* handlers of
// ./session.js. It holds, in memory and only while unlocked, the identity's
// box key pair (passkey.js dmBoxKeyPairFromPrf, gen from kv dmKey) and the
// local store (./dm-store.js, keyed by dmLocalKeyFromPrf); lock() zeroes
// both. The folder rules are @varanda/core lib/dm-fold.js, called with the
// local filing times; this file decides nothing about folders itself.
//
// Network: every put and page goes over a fresh anonymous link
// (./dm-link.js openDmLink) that names no diary. Stamps come from a wallet
// in kv dmStamps, topped up on its own schedule over the separate stamp
// link (openStampLink), never right around a send. The node never repeats a
// put by itself: a send whose ack did not arrive keeps its exact drop bytes
// in memory (keyed by recipient, text and reply), and only the user's retry
// of that same message puts them again (the pool answers an identical drop
// as success), so a retry never makes a second message. Those bytes live in
// memory only: a lock, a reset or a reload forgets them, and a retry after
// that builds a new message (which may then arrive twice).
//
// A folder op (dm.set) is filed here at once; its ctl to the own box joins
// kv dmCtlQueue (ciphertext only) and the queue is put in order. A queued
// ctl is stamped once: its exact drop bytes replace it in the queue before
// the first put, so any later put of it is byte-identical (the pool answers
// it as a repeated success) and spends no second stamp. The queue is put
// only after unlock and on the next dm.set, never on a timer.
//
// Every msg carries the own membership certificate (protocol section 11),
// read once from block 0 per unlock. A pull opens a msg only when its
// certificate verifies for the association, and drops a sender on the
// stored blocklist snapshot.
//
// Media (docs/rpc.md 5.75, 5.78, 5.88; protocol sections 11 and 13): a
// photo is checked (mediaBounds; a voice note, audio/mp4, with audioBounds
// and MAX_AUDIO_BYTES, on put and again on open), sealed and put on the
// anonymous blob channel by putMedia (./blob.js), which answers its media item. The sealed
// blob stays in memory (at most BLOBS_MAX, keyed by its id and by its
// plaintext), one put at a time per blob, so the user's retry of the same
// photo re-puts the SAME frames. A failed upload is a normal error, never
// uncertain: nothing was sent, and a blob never named by a message expires
// with the pool. A send with media first makes sure every chunk of every
// item was acked in this session (a user retry re-puts what was not), and
// only then stamps and puts its drops; an item this engine did not put is
// refused. The blob wallet is topped up next to the DM wallet (topUp), and
// a photo whose chunks outnumber the wallet fills it before its put.
// The message row keeps the media items (blob key included); the plaintext
// is opened lazily, on the first dm.thread or readMedia of that message,
// and kept in the store's sealed media cache (./dm-store.js, a total byte
// budget), which the pool's 7-day sweep does not touch. A thread in the
// 'request' folder opens nothing by itself: a stranger's blobs are fetched
// only on an explicit readMedia (a tap) or once the conversation is
// accepted. At most OPEN_MAX opens run at once, the rest wait in order; a
// new dm.thread page drops the background opens that have not started, and
// lock drops every waiting one. A blob gone (404) or that does not
// verify, with nothing cached, shows as media { unavailable: true } while
// the text still shows. Only reads are ever repeated, never a put. lock()
// forgets the sealed blobs; wipeMedia() (lock, sign-out, reset) deletes the
// cache as well.
//
// Páginas (docs/rpc.md 5.114): the page secrets this identity holds live in
// ./page-dm.js. Each held page has its own local store (./dm-store.js under
// node-store pageDmPrefix) and its own pool cursor with the gen it scanned
// for. A pull first runs the own pass; a page whose cursor stands where the
// own one did rides along (a drop the own box does not open is tried with
// that page's boxes, the current gen, the previous ones, then the legacy one), and every other
// held page then catches up from its own cursor with only its boxes, so
// drops pulled before its secrets arrived still open. After each pull the
// newest dm-key the page published is compared with the held box; while they
// differ 'dm.pageKeyMismatch' goes out on every pull and the page's drafts
// and sends are refused. A page message is a draft the page key signs
// elsewhere (dm.pageDraft, dm.pageSend): this node builds the v3 inner and
// its digest, holds it in memory and seals it once the signature verifies.
//
// Nothing here logs a key, a text or a peer.
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const dm = require('@varanda/core/lib/dm')
const dmFold = require('@varanda/core/lib/dm-fold')
const postage = require('@varanda/core/lib/dm-postage')
const { nowIso, MAX_AUDIO_BYTES, VIDEO_MIME, MAX_MOMENT_VIDEO_MS, MAX_MOMENT_VIDEO_BYTES } = require('@varanda/core/lib/records')
const { UsageError } = require('@varanda/core/lib/errors')
const { certForKey } = require('@varanda/core/lib/cert')
const { verifySnapshot, blockedSet, revokedIssuerSet } = require('@varanda/core/lib/blocklist')
const { blockedKeys } = require('@varanda/core/lib/member-block')
const { copyLinkCard } = require('@varanda/core/lib/link-card')
const { openOffer } = require('@varanda/core/lib/testimonials')
const { mediaBounds, audioBounds, videoBounds, dmTextBytes, DM_MEDIA_KEYS, AUDIO_MS_TOLERANCE } = require('@varanda/rpc')
const { sealBlob, createBlobClient, fetchBlob } = require('./blob')
const sodium = require('./sodium-browser')
const { dmBoxKeyPairFromPrf, dmLocalKeyFromPrf } = require('./passkey')
const { createDmStore, SUMMARY_PAGE } = require('./dm-store')
const { createPageHolder, NO_PAGE_KEY, KEY_MISMATCH } = require('./page-dm')
const { openDmLink, openStampLink } = require('./dm-link')
const store = require('./node-store')

const LOCKED = store.LOCKED
const SELF_SEND = 'não é possível enviar para si'
const BLOCKED = 'você bloqueou esta pessoa'
const NO_BOX = 'esta pessoa ainda não recebe mensagens'
const NO_STAMPS = 'o limite de envio de hoje acabou'
const BAD_REPLY = 'responda uma mensagem desta conversa'
const NO_TARGET = 'mensagem não encontrada'
const REACT_MAX = 'limite de reações para esta mensagem atingido'
const NOT_REACTABLE = 'esta mensagem não aceita reações'
const DIGEST_RE = /^[0-9a-f]{64}$/
const TOO_LONG = 'mensagem longa demais'
const BAD_TEXT = 'mensagem inválida'
const PULL_BUSY = 'mensagens já em andamento'
const UNCONFIRMED = 'não deu para confirmar o envio'
const SEEDER_FULL = 'o semeador está cheio: tente mais tarde'
const SEEDER_RATE = 'muitas mensagens seguidas: aguarde um pouco'
const REFUSED = 'mensagem recusada pelo semeador'
const NO_CERT = 'grave o certificado de membro antes de publicar'
const BAD_MEDIA = 'mídia inválida'
const MEDIA_GONE = 'mídia indisponível'
const MEDIA_STALE = 'prepare a mídia de novo'
const UPLOAD_FAILED = 'não deu para enviar a mídia: tente de novo'
// A momento's photo that cannot be fetched or does not verify (the same
// answer for both, so it never says why).
const MOMENT_PHOTO_GONE = 'foto indisponível'
// Sealed blobs kept for a send or a retry (each holds its plaintext and
// ciphertext in memory).
const BLOBS_MAX = 8
const PREVIEW_MAX = 140
const TOP_UP_EVERY_MS = 600000
const PENDING_MAX = 32
// A failed top-up is tried again after this, not after TOP_UP_EVERY_MS.
const TOP_UP_RETRY_MS = 60000
// Issues past the stamp channel's burst wait this long (10 per 10 s there).
const ISSUE_BURST = 8
const ISSUE_PACE_MS = 1100
const OPEN_MAX = 2
const OPEN_DROPPED = 'abertura de mídia cancelada'
const USE_PAGE_DRAFT = 'use dm.pageDraft'
const DRAFT_GONE = 'rascunho expirado'
const BAD_SIGNATURE = 'assinatura inválida'
const BAD_ROW = 'linha inválida'
// n: the service's filing position, shared by rows and ops.
const IMPORT_ROW_KEYS = ['id', 'from', 'to', 'text', 'at', 'replyTo', 'media', 'card', 'fwd', 'n']
// The legacy bundle (docs/rpc.md 5.114): each chunk's plaintext is
// bundleId (32) || uint16be index || uint16be count || at most
// LEGACY_CHUNK_BYTES of the bundle's UTF-8 JSON.
const LEGACY_HEADER_BYTES = 36
const LEGACY_CHUNK_BYTES = 40000
const BUNDLE_KEYS = ['v', 'page', 'box', 'rows', 'ops']
const LEGACY_DONE_MAX = 16
const LEGACY_OP_DOMAIN = b4a.from('varanda/member-dm-local/legacy-op/v1\n', 'utf8')
const SIG_PREFIX_V3 = b4a.from(dm.DM_V3_PREFIX, 'utf8')

function noop () {}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unconfirmed () {
  const err = new UsageError(UNCONFIRMED)
  err.uncertain = true
  return err
}

function preview (text) {
  return Array.from(text).slice(0, PREVIEW_MAX).join('')
}

function wipe (buf) {
  if (buf instanceof Uint8Array) buf.fill(0)
}

function sha256Hex (bytes) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, bytes)
  return b4a.toString(out, 'hex')
}

// The seeder's HTTP origin for GET /blob: the WebSocket address's host with
// https (wss) or http (ws).
function httpOriginOf (seederUrl) {
  try {
    const u = new URL(seederUrl)
    return (u.protocol === 'wss:' ? 'https:' : 'http:') + '//' + u.host
  } catch {
    return null
  }
}

// A voice note's plaintext -> its container duration in ms, or null: audio
// only, in its duration and size bounds, and within AUDIO_MS_TOLERANCE of
// `ms` when one is declared (a sender's ms is not trusted).
function voiceMs (bytes, ms) {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_AUDIO_BYTES) return null
  const audio = audioBounds(bytes)
  if (audio === null) return null
  if (ms !== undefined && !(Number.isInteger(ms) && Math.abs(ms - audio.ms) <= AUDIO_MS_TOLERANCE)) return null
  return audio.ms
}

function mediaItem (d) {
  const o = {}
  for (const k of DM_MEDIA_KEYS) o[k] = d[k]
  return o
}

function zeroPair (pair) {
  if (pair === null) return
  pair.publicKey.fill(0)
  pair.secretKey.fill(0)
}

// limits (tests): issueBurst, issuePaceMs, topUpEveryMs, topUpRetryMs,
// budgetBytes, pageMax, openMax, cacheBytesMax (./dm-store.js), link
// (dm-link limits), blob (./blob.js createBlobClient limits), fetch
// (./blob.js fetchBlob limits), fold (the dm-fold fold, to count calls).
// createStore, fetch and mediaOrigin: tests only.
function createDmEngine ({ storage, association, seederUrl, createSocket, log = noop, emit = noop, limits = {}, createStore = createDmStore, fetch: fetchImpl, mediaOrigin, hkdf } = {}) {
  const L = {
    issueBurst: ISSUE_BURST,
    issuePaceMs: ISSUE_PACE_MS,
    topUpEveryMs: TOP_UP_EVERY_MS,
    topUpRetryMs: TOP_UP_RETRY_MS,
    budgetBytes: dm.DM_PULL_BUDGET_BYTES,
    pageMax: dm.DM_PAGE_MAX,
    openMax: OPEN_MAX,
    cacheBytesMax: undefined,
    link: {},
    blob: {},
    fetch: {},
    fold: dmFold.fold,
    // Tests only: the summary write delay and a gate before the own rows load.
    summaryDelayMs: undefined,
    loadGate: null,
    ...(limits || {})
  }
  const local = createStore({ storage, cacheBytesMax: L.cacheBytesMax, summaryDelayMs: L.summaryDelayMs, loadGate: L.loadGate })
  // The own store; a held page's is { local, prefix, page, ready } (pageCtx).
  const personal = { local, prefix: '', page: null }
  const pages = createPageHolder({ storage, association })
  const pageStores = new Map()
  // page -> adoption epoch, bumped whenever its keys change: a pull writes a
  // page cursor only while the epoch it started with is current, so it never
  // overwrites the restart an adoption made under it.
  const pageEpochs = new Map()
  // Pages a dm.pageForget is removing: no new store is opened for them.
  const forgetting = new Set()
  let box = null // { publicKey, secretKey, gen }
  let generation = 0
  let pulling = false
  let topping = null
  // The earliest time the next unforced top-up may run.
  let nextTopUp = 0
  // Every operation in flight (pull, send, set, seen, top-up): idle() waits
  // for them, so a reset never deletes the store under one.
  const inflight = new Set()
  let walletLock = Promise.resolve()
  let queueLock = Promise.resolve()
  // The own membership certificate, read from block 0 once per unlock.
  let ownCert = null
  const pending = new Map()
  const linkOpts = { seederUrl, createSocket, association, log: (t) => { try { log(t) } catch {} }, limits: L.link }
  // Both throw while locked: the blob wallet is sealed under the local key.
  const blobs = createBlobClient({
    seederUrl,
    createSocket,
    association,
    storage,
    seal: (v) => local.seal(v),
    open: (b) => local.open(b),
    log: linkOpts.log,
    limits: { link: L.link, ...L.blob }
  })
  const blobOrigin = mediaOrigin === undefined ? httpOriginOf(seederUrl) : mediaOrigin
  // Sealed blobs put (or being put) in this unlock: id -> entry and
  // plaintext key -> entry; entry = { sealed, mime, w, h, ms, plain, hash, lock }.
  const sealedById = new Map()
  const sealedByPlain = new Map()
  // Momento items putPublicMedia answered in this unlock, by blob id -> item
  // (no plaintext kept: a retry seals a fresh blob).
  const publicItems = new Map()
  // Lazy opens queued or in flight, by sender and message id -> { p, job },
  // and messages whose blob is gone (this unlock only).
  const opening = new Map()
  const gone = new Set()
  // The last fold per store (own or a page's): { version, own, follows,
  // seen, result }. Reused only while the store's version, the self key and
  // the kv follows and seen texts are all unchanged; every caller only
  // reads the result. Memory only, dropped on lock and unlock.
  const foldMemo = new Map()
  // Opens waiting for one of the L.openMax slots, in order; job =
  // { key, background, start, cancel }.
  const openQueue = []
  let openActive = 0

  function track (p) {
    inflight.add(p)
    const done = () => { inflight.delete(p) }
    p.then(done, done)
    return p
  }

  // Resolves once every tracked operation and the store's queue settled.
  async function idle () {
    while (inflight.size > 0) await Promise.allSettled([...inflight])
    await local.idle()
    for (const s of [...pageStores.values()]) await s.local.idle()
  }

  function withWallet (fn) {
    const p = walletLock.then(fn)
    walletLock = p.catch(noop)
    return p
  }

  // Every read and write of kv dmCtlQueue, so a stamp is taken once per item.
  function withQueue (fn) {
    const p = queueLock.then(fn)
    queueLock = p.catch(noop)
    return p
  }

  // -> the own certificate for `own`, or throws NO_CERT.
  async function certOf (own) {
    if (ownCert !== null && ownCert.member === own) return ownCert
    let block0 = null
    if (await store.diaryExists(storage)) {
      const diary = await store.openDiary(storage)
      try {
        block0 = await store.readBlock0(diary)
      } finally {
        await diary.close()
      }
    }
    const cert = block0 !== null && typeof block0 === 'object' ? block0.cert : null
    if (!certForKey(cert, own, association).ok) throw new UsageError(NO_CERT)
    ownCert = cert
    return cert
  }

  // The stored blocklist snapshot's sets (empty when none verifies).
  async function moderation () {
    try {
      // The member's own blocks drop a sender as the association's do, also
      // on a device the conversation op never reached.
      const own = blockedKeys(await store.readMemberBlocks(storage))
      const data = await store.readBlocklist(storage)
      const snapshot = data === null ? null : data.snapshot
      if (snapshot !== null && verifySnapshot(snapshot, association).ok) {
        // `association` alone: a page's inbox keeps the association's blocks,
        // not the member's own.
        return { blocked: new Set([...blockedSet(snapshot), ...own]), association: blockedSet(snapshot), revokedIssuers: revokedIssuerSet(snapshot) }
      }
      return { blocked: own, association: new Set(), revokedIssuers: new Set() }
    } catch {}
    return { blocked: new Set(), association: new Set(), revokedIssuers: new Set() }
  }

  // Any throw leaves no key material behind: the derived pair and key are
  // zeroed and the store locked. Resolves once the rows are loaded; onKey()
  // runs before that, once the keys are installed and the list summary
  // read (keyReady()), so dm.list may answer a first page from it.
  async function unlock (prf, { onKey = null } = {}) {
    const gen = ++generation
    foldMemo.clear()
    let pair = null
    let key = null
    let installed = false
    try {
      const kv = await store.readDmKey(storage)
      const g = kv === null ? 1 : kv.gen
      pair = await dmBoxKeyPairFromPrf(prf, g, { hkdf })
      key = await dmLocalKeyFromPrf(prf, { hkdf })
      if (gen !== generation) return
      const full = local.unlock(key)
      full.catch(noop)
      await local.keyStage()
      if (gen !== generation) {
        local.lock()
        return
      }
      if (!local.keyReady()) {
        await full
        throw new UsageError(LOCKED)
      }
      await pages.unlock(key)
      if (gen !== generation) {
        pages.lock()
        local.lock()
        return
      }
      zeroPair(box)
      box = { publicKey: pair.publicKey, secretKey: pair.secretKey, gen: g }
      installed = true
    } catch (err) {
      if (gen === generation) {
        pages.lock()
        local.lock()
      }
      throw err
    } finally {
      if (key !== null) key.fill(0)
      if (!installed) zeroPair(pair)
    }
    if (onKey !== null && gen === generation) {
      try { onKey() } catch {}
    }
    try {
      await local.loaded()
    } catch (err) {
      if (gen === generation) lock()
      throw err
    }
    if (gen !== generation || !local.unlocked()) return
    // Ctls left from before go out now (a stamped one needs no new stamp),
    // the own queue first, then each held page's.
    if ((await store.readDmCtlQueue(storage)).length > 0) track(flushQueued())
    for (const page of pages.pages()) {
      if ((await store.readDmCtlQueue(storage, store.pageDmPrefix(page))).length === 0) continue
      track(pageCtx(page).then((ctx) => flushQueued(ctx)).catch(noop))
    }
  }

  function lock () {
    generation++
    zeroPair(box)
    box = null
    ownCert = null
    local.lock()
    pages.lock()
    for (const s of pageStores.values()) s.local.lock()
    pageStores.clear()
    foldMemo.clear()
    clearPending()
    forgetAllBlobs()
    publicItems.clear()
    dropQueued(false, LOCKED)
    opening.clear()
    gone.clear()
  }

  // Lock, sign-out and reset: the plaintext cache and every list summary go
  // too (needs no key).
  function wipeMedia () {
    forgetAllBlobs()
    dropQueued(false, LOCKED)
    opening.clear()
    gone.clear()
    return track(Promise.all([local.wipeCache(), dropPageSummaries()]).then(([r]) => r))
  }

  // The list summaries of every page this device lists (a reset runs it
  // before the lists go): a page adopted again under the same secrets must
  // not meet the summary of the history it forgot.
  async function dropPageSummaries () {
    const listed = new Set([...Object.keys(await store.readPageSecrets(storage)), ...await store.readPageStores(storage)])
    for (const page of listed) await storage.writeJson(store.pageDmPrefix(page) + 'dmSummary', null)
  }

  function unlocked () {
    return box !== null && local.unlocked()
  }

  // The keys are installed; the own rows may still be loading.
  function keyReady () {
    return box !== null && local.keyReady()
  }

  // Settles once the own rows of the current unlock are loaded.
  function loaded () {
    return local.loaded()
  }

  function requireUnlocked () {
    if (!unlocked()) throw new UsageError(LOCKED)
  }

  function requireKey () {
    if (!keyReady()) throw new UsageError(LOCKED)
  }

  // An operation that needs the rows waits for a load under way.
  async function whenLoaded () {
    if (keyReady() && !local.unlocked()) await local.loaded().catch(noop)
    requireUnlocked()
  }

  function boxHex () {
    requireUnlocked()
    return { box: b4a.toString(box.publicKey, 'hex'), gen: box.gen }
  }

  // A depoimento's sealed box (docs/protocol.md section 2) -> { text, nonce }
  // or null; the pair never leaves the engine. Only the current generation
  // is held, so a depoimento sealed to an older dm-key gen reads as null and
  // is omitted from testimonial.pending.
  function openTestimonial (sealed, gen) {
    requireUnlocked()
    if (gen !== box.gen) return null
    return openOffer(sealed, box)
  }

  // ---- folders ----

  // A held page's store, opened once per unlock under its own key. Throws
  // NO_PAGE_KEY for a page this node holds no secrets of, or one being
  // forgotten (a pull then never opens its store again under the forget).
  // keyOnly: the page's key and summary suffice (dm.list); its rows may
  // still be loading.
  async function pageCtx (page, keyOnly = false) {
    if (keyOnly) requireKey()
    else requireUnlocked()
    if (forgetting.has(page)) throw new UsageError(NO_PAGE_KEY)
    pages.need(page)
    let s = pageStores.get(page)
    if (s === undefined) {
      // Listed before anything of it is written, so a reset always finds it.
      await store.notePageStore(storage, page)
      if (pageStores.get(page) !== undefined) return pageCtx(page, keyOnly)
      const prefix = store.pageDmPrefix(page)
      const lc = createDmStore({ storage, cacheBytesMax: L.cacheBytesMax, prefix, summaryDelayMs: L.summaryDelayMs })
      const k = pages.localKeyOf(page)
      // The store copies the key before unlock() returns.
      const full = lc.unlock(k)
      k.fill(0)
      s = { local: lc, prefix, page, ready: lc.keyStage() }
      pageStores.set(page, s)
      // A failed row load drops the store as a failed key stage does, so
      // the next call starts a fresh unlock instead of meeting a dead one.
      const failed = s
      full.catch(() => {
        if (pageStores.get(page) === failed) {
          pageStores.delete(page)
          foldMemo.delete(failed.local)
        }
      })
    }
    try {
      await s.ready
      if (!keyOnly) await s.local.loaded()
    } catch (err) {
      if (pageStores.get(page) === s) pageStores.delete(page)
      throw err
    }
    if (pageStores.get(page) !== s || !(keyOnly ? s.local.keyReady() : s.local.unlocked())) throw new UsageError(LOCKED)
    return s
  }

  // The context of a request's optional `page` -> [self, ctx].
  async function contextOf (own, page, keyOnly = false) {
    if (page === undefined || page === null) return [own, personal]
    return [page, await pageCtx(page, keyOnly)]
  }

  // The kv follows (own store only) and seen texts a fold reads, with
  // their sha256 digests (the list summary's).
  async function foldInputs (ctx) {
    const follows = ctx === personal ? (await store.readFollows(storage)).map((f) => typeof f === 'string' ? f : f && f.key).filter((k) => typeof k === 'string') : []
    const storedIds = await store.readDmSeen(storage, ctx.prefix)
    const followsText = JSON.stringify(follows)
    const seenText = JSON.stringify(storedIds)
    return { follows, storedIds, followsText, seenText, followsHash: sha256Hex(b4a.from(followsText, 'utf8')), seenHash: sha256Hex(b4a.from(seenText, 'utf8')) }
  }

  // A page follows no one here: its folders come from its ops alone.
  // The kv reads run on every call (another tab or device may have changed
  // them); only the fold itself is reused.
  async function folded (own, ctx = personal) {
    const gen = generation
    const { follows, storedIds, followsText, seenText, followsHash, seenHash } = await foldInputs(ctx)
    const lc = ctx.local
    const hit = foldMemo.get(lc)
    if (hit !== undefined && lc.unlocked() && hit.version === lc.version() && hit.own === own && hit.follows === followsText && hit.seen === seenText) return hit.result
    const version = lc.version()
    const stored = new Set(storedIds)
    const { messages, ops, reactions } = lc.snapshot()
    const seen = []
    for (const m of messages) {
      if (m.mine) continue
      const k = dmFold.seenKey(m.from, m.id)
      if (stored.has(lc.seenToken(k))) seen.push(k)
    }
    const result = L.fold({
      self: own,
      followSet: follows,
      seen,
      ops,
      messages: messages.map((m) => ({ id: m.id, from: m.from, to: m.mine ? m.peer : own, text: m.text, replyTo: m.replyTo, fwd: m.fwd, media: m.media, card: m.card, at: m.at, filedAt: m.filedAt, digest: m.digest })),
      reactions: (reactions || []).map((r) => ({ id: r.id, from: r.from, to: r.to, target: { from: r.target.from, id: r.target.id, digest: r.target.digest }, emoji: r.emoji, rev: r.rev, filedAt: r.filedAt }))
    })
    // A store locked (or relocked) since is never remembered.
    const current = ctx === personal || pageStores.get(ctx.page) === ctx
    if (gen === generation && current && lc.unlocked() && lc.version() === version) {
      foldMemo.set(lc, { version, own, follows: followsText, seen: seenText, result })
      if (typeof lc.saveSummary === 'function') {
        lc.saveSummary({
          version,
          follows: followsHash,
          seen: seenHash,
          inbox: pageOf(result.inbox, result.requests, 'inbox', SUMMARY_PAGE),
          requests: pageOf(result.inbox, result.requests, 'request', SUMMARY_PAGE)
        })
      }
    }
    return result
  }

  // A first page from the store's summary -> the dm.list result, or null
  // when it cannot answer (rows loaded, another page, no matching summary).
  async function summaryList (ctx, folder, limit, before) {
    if (before !== undefined && before !== null) return null
    if (typeof ctx.local.summaryFor !== 'function' || ctx.local.unlocked()) return null
    const gen = generation
    const inputs = await foldInputs(ctx)
    if (gen !== generation) throw new UsageError(LOCKED)
    const s = ctx.local.summaryFor({ follows: inputs.followsHash, seen: inputs.seenHash })
    if (s === null) return null
    const p = folder === 'request' ? s.requests : s.inbox
    // Past the stored page only when it is the whole folder.
    if (limit > p.conversations.length && p.next !== null) return null
    const conversations = p.conversations.slice(0, limit)
    const more = limit < p.conversations.length || p.next !== null
    const tail = conversations[conversations.length - 1]
    return { conversations, next: more && tail ? { at: tail.at, peer: tail.peer } : null, requests: p.requests, inboxUnread: p.inboxUnread }
  }

  // Settles once the rows a dm.list of `page` (or the own) reads are loaded
  // or failed; never rejects.
  async function listLoaded ({ page } = {}) {
    await local.loaded().catch(noop)
    if (page === undefined || page === null) return
    const s = pageStores.get(page)
    if (s !== undefined) await s.local.loaded().catch(noop)
  }

  // Whether dm.list can answer now without waiting for the own rows: they
  // are loaded, or (no page, a first page) the summary matches.
  async function listReady ({ folder = 'inbox', limit = 30, before, page } = {}) {
    if (!keyReady()) return false
    if (local.unlocked()) return true
    if (page !== undefined && page !== null) return false
    return (await summaryList(personal, folder, limit, before)) !== null
  }

  // Order and cursor are the fold's: `at` is the effective time it returns
  // (never re-sorted here by the sender's time).
  // wait false: on a summary miss with the rows still loading -> null at
  // once (the session then waits for listLoaded off its chain).
  async function list (own, { folder = 'inbox', limit = 30, before, page: pageKey } = {}, { wait = true } = {}) {
    requireKey()
    const gen = generation
    const [self, ctx] = await contextOf(own, pageKey, true)
    if (!ctx.local.unlocked()) {
      const hit = await summaryList(ctx, folder, limit, before)
      if (hit !== null) return hit
      if (!wait) return null
      await ctx.local.loaded().catch(noop)
      const current = ctx === personal || pageStores.get(ctx.page) === ctx
      if (gen !== generation || !current || !ctx.local.unlocked()) throw new UsageError(LOCKED)
    }
    const { inbox, requests } = await folded(self, ctx)
    return pageOf(inbox, requests, folder, limit, before)
  }

  // One dm.list page of a fold's folders.
  function pageOf (inbox, requests, folder, limit, before) {
    const all = folder === 'request' ? requests : inbox
    let start = 0
    if (before !== undefined && before !== null) {
      const i = all.findIndex((c) => c.at === before.at && c.peer === before.peer)
      if (i !== -1) {
        start = i + 1
      } else {
        const t = Date.parse(before.at)
        start = all.findIndex((c) => Date.parse(c.at) < t || (Date.parse(c.at) === t && c.peer > before.peer))
        if (start === -1) start = all.length
      }
    }
    const page = all.slice(start, start + limit)
    const conversations = page.map((c) => {
      const last = c.messages[c.messages.length - 1]
      return { peer: c.peer, folder: c.folder, preview: preview(dmFold.previewText(last)), at: c.at, unread: c.unread, mine: last.mine }
    })
    const more = start + page.length < all.length
    const tail = page[page.length - 1]
    return {
      conversations,
      next: more && tail ? { at: tail.at, peer: tail.peer } : null,
      requests: requests.some((c) => c.unread),
      inboxUnread: inbox.some((c) => c.unread)
    }
  }

  async function threadOf (own, peer, ctx = personal) {
    const { inbox, requests } = await folded(own, ctx)
    return inbox.find((c) => c.peer === peer) || requests.find((c) => c.peer === peer) || null
  }

  // The thread's own state, so the app never guesses it from a list page:
  // its folder from the same fold as dm.list (a request holds a kept peer
  // message, no own one, and the peer is neither followed nor accepted), and
  // whether the newest block op for the peer is 'blocked' (dm-fold canSend).
  // A thread with no kept message is 'inbox': a conversation the person may
  // start.
  function threadState (own, peer, c, ctx = personal) {
    const blocked = !dmFold.canSend({ self: own, peer, ops: ctx.local.ops() })
    return { folder: c === null ? 'inbox' : c.folder, blocked }
  }

  async function thread (own, { peer, before, limit = 30, page }) {
    await whenLoaded()
    const [self, ctx] = await contextOf(own, page)
    const c = await threadOf(self, peer, ctx)
    const state = threadState(self, peer, c, ctx)
    if (c === null) return { messages: [], next: null, ...state }
    // `before` is an id, unique within the thread (core dm-fold keeps one
    // row per id per conversation); an id no longer kept pages from the
    // newest.
    let end = c.messages.length
    if (before !== undefined && before !== null) {
      const i = c.messages.findIndex((m) => m.id === before)
      if (i !== -1) end = i
    }
    const start = Math.max(0, end - limit)
    const rows = c.messages.slice(start, end)
    // Another page: what an earlier one queued and did not start is dropped.
    dropQueued(true, OPEN_DROPPED)
    // A request is a peer the person neither follows nor accepted: nothing
    // of theirs is fetched until a tap or an accept.
    const auto = c.folder !== 'request'
    return {
      messages: rows.map((m) => threadRow(m, mediaView(m, auto, ctx))),
      next: start > 0 && rows.length > 0 ? rows[0].id : null,
      ...state
    }
  }

  // `reactions` only when the fold gave the row one; `reactable: false` only
  // on a row stored without a digest, which never has reactions.
  function threadRow (m, media) {
    const row = { id: m.id, from: m.from, text: m.text, replyTo: m.replyTo, fwd: m.fwd, at: m.at, mine: m.mine, media, card: m.card ? copyLinkCard(m.card, mediaItem) : null }
    if (typeof m.digest !== 'string' || !DIGEST_RE.test(m.digest)) row.reactable = false
    if (Array.isArray(m.reactions) && m.reactions.length > 0) row.reactions = m.reactions.map((r) => ({ emoji: r.emoji, mine: r.mine }))
    return row
  }

  // ---- media ----

  function messageItems (m) {
    return Array.isArray(m.media) ? m.media : m.card && m.card.image ? [m.card.image] : []
  }

  function openKey (from, id) {
    return from + '\n' + id
  }

  // A thread row's media: the items (cached, or opening in the background
  // now when `auto`), or { unavailable: true } when the blob is gone and
  // nothing is cached. Copies: the caller may hand them out.
  // A page's media is never opened in the background (no readMedia for a
  // page): its thread shows the items only.
  function mediaView (m, auto, ctx = personal) {
    if (!Array.isArray(m.media)) return null
    if (ctx.local.hasMedia(m.from, m.id)) return m.media.map(mediaItem)
    if (ctx !== personal) return m.media.map(mediaItem)
    if (gone.has(openKey(m.from, m.id))) return { unavailable: true }
    if (auto) openMedia(m, true).catch(noop)
    return m.media.map(mediaItem)
  }

  function pumpOpens () {
    while (openActive < L.openMax && openQueue.length > 0) {
      const job = openQueue.shift()
      openActive++
      const free = () => {
        openActive--
        pumpOpens()
      }
      job.start().then(free, free)
    }
  }

  // Drops the waiting opens (only the background ones when `backgroundOnly`):
  // each rejects with `reason` and leaves `opening`, so a later read starts
  // afresh. Running opens finish on their own (they check the generation).
  function dropQueued (backgroundOnly, reason) {
    for (let i = openQueue.length - 1; i >= 0; i--) {
      const job = openQueue[i]
      if (backgroundOnly && !job.background) continue
      openQueue.splice(i, 1)
      const known = opening.get(job.key)
      if (known !== undefined && known.job === job) opening.delete(job.key)
      job.cancel(new UsageError(reason))
    }
  }

  // Fetches, verifies and opens every item of message m, then caches the
  // plaintext -> the items' bytes (shared by every waiter: copy before
  // handing out). One open per message at a time, at most L.openMax at
  // once; a `background` open (a thread page) may be dropped while it
  // waits, an explicit one (readMedia) never is, and promotes a waiting
  // background open of the same message. A blob gone or one that does not
  // verify marks the message gone and says so with dm.changed (no item in
  // the event). Any other failure is retried by the next read only.
  function openMedia (m, background = false) {
    const k = openKey(m.from, m.id)
    const known = opening.get(k)
    if (known !== undefined) {
      if (!background) known.job.background = false
      return known.p
    }
    const gen = generation
    const job = { key: k, background, start: null, cancel: null }
    const p = track(new Promise((resolve, reject) => {
      job.cancel = reject
      job.start = () => {
        const r = runOpen(m, k, gen)
        r.then(resolve, reject)
        return r
      }
    }))
    opening.set(k, { p, job })
    const done = () => {
      const now = opening.get(k)
      if (now !== undefined && now.p === p) opening.delete(k)
    }
    p.then(done, done)
    openQueue.push(job)
    pumpOpens()
    return p
  }

  function runOpen (m, k, gen) {
    return (async () => {
      if (gen !== generation) throw new UsageError(LOCKED)
      if (blobOrigin === null) throw new UsageError(MEDIA_GONE)
      const out = []
      try {
        for (const d of messageItems(m)) {
          const r = await fetchBlob({ id: d.id, key: d.key, nonce: d.nonce, chunks: d.chunks, bytes: d.bytes, sha256: d.sha256 }, blobOrigin, { mime: d.mime, fetch: fetchImpl, limits: L.fetch })
          out.push(r.bytes)
          // fetchBlob checks images only; a voice note's bytes decide too
          // (no video track, a duration in bounds), not its label.
          if (d.mime === dm.DM_AUDIO_MIME && voiceMs(r.bytes, d.ms) === null) throw new UsageError(BAD_MEDIA)
        }
      } catch (err) {
        for (const b of out) wipe(b)
        const msg = err && err.message
        if (gen === generation && (msg === MEDIA_GONE || msg === BAD_MEDIA)) {
          gone.add(k)
          emit('dm.changed', { added: 0 })
          throw new UsageError(MEDIA_GONE)
        }
        throw err
      }
      if (gen !== generation) {
        for (const b of out) wipe(b)
        throw new UsageError(LOCKED)
      }
      try {
        await local.putMedia(m.from, m.id, out)
      } catch {
        if (gen === generation) log('aviso: mídia aberta mas não guardada neste aparelho')
      }
      // A lock while the cache write ran: no plaintext outlives it.
      if (gen !== generation) {
        for (const b of out) wipe(b)
        throw new UsageError(LOCKED)
      }
      return out
    })()
  }

  // The message (from, id) as the fold keeps it for `own`, or null.
  async function keptMessage (own, from, id) {
    const { inbox, requests } = await folded(own)
    for (const c of [...inbox, ...requests]) {
      const m = c.messages.find((x) => x.from === from && x.id === id)
      if (m !== undefined) return m
    }
    return null
  }

  // The plaintext of item `index` of a kept message -> { bytes, mime }
  // (bytes: a fresh copy the caller owns). Opens the blob when not cached;
  // a message deleted, blocked, without media or whose blob is gone
  // answers MEDIA_GONE.
  async function readMedia (own, { from, id, index }) {
    requireUnlocked()
    const gen = generation
    if (typeof from !== 'string' || !/^[0-9a-f]{64}$/.test(from) || typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id) ||
        (index !== 'card' && (!Number.isSafeInteger(index) || index < 0 || index >= dm.DM_MEDIA_MAX))) {
      throw new TypeError('parâmetros inválidos')
    }
    const m = await keptMessage(own, from, id)
    if (m === null) throw new UsageError(MEDIA_GONE)
    if (index === 'card') {
      if (!m.card || !m.card.image) throw new UsageError(MEDIA_GONE)
      index = 0
    } else if (!Array.isArray(m.media)) throw new UsageError(MEDIA_GONE)
    const descriptors = messageItems(m)
    if (index >= descriptors.length) throw new UsageError(MEDIA_GONE)
    const mime = descriptors[index].mime
    if (local.hasMedia(from, id)) {
      const items = await local.getMedia(from, id)
      if (items !== null && gen !== generation) {
        items.forEach(wipe)
        throw new UsageError(LOCKED)
      }
      if (items !== null && items.length === descriptors.length) {
        items.forEach((b, i) => { if (i !== index) wipe(b) })
        return { bytes: items[index], mime }
      }
      if (items !== null) items.forEach(wipe)
    }
    if (gone.has(openKey(from, id))) throw new UsageError(MEDIA_GONE)
    const items = await openMedia(m)
    if (gen !== generation) throw new UsageError(LOCKED)
    const copy = new Uint8Array(items[index].byteLength)
    copy.set(items[index])
    return { bytes: copy, mime }
  }

  function forgetBlob (entry) {
    if (sealedById.get(entry.sealed.descriptor.id) === entry) sealedById.delete(entry.sealed.descriptor.id)
    if (sealedByPlain.get(entry.hash) === entry) sealedByPlain.delete(entry.hash)
    wipe(entry.plain)
    entry.plain = null
  }

  function forgetAllBlobs () {
    for (const entry of [...sealedById.values()]) forgetBlob(entry)
    sealedByPlain.clear()
  }

  function itemOf (entry) {
    return mediaItem({ ...entry.sealed.descriptor, mime: entry.mime, w: entry.w, h: entry.h, ms: entry.ms })
  }

  // One put at a time per sealed blob: a second send of the same blob waits
  // and then finds every frame acked. A lost ack is a normal error here:
  // nothing was sent yet, and the same frames go again on the user's retry.
  function upload (entry, keyPair) {
    const p = entry.lock.then(async () => {
      if (entry.sealed.acked.every(Boolean)) return
      try {
        await blobs.send(entry.sealed, keyPair)
      } catch (err) {
        if (err && err.uncertain) throw new UsageError(UPLOAD_FAILED)
        throw err
      }
    })
    entry.lock = p.catch(noop)
    return p
  }

  // bytes: the caller's copy, wiped here. -> the media item a dm.send
  // carries. The same photo (bytes, mime, sides) again reuses its sealed
  // blob, so a retry re-puts the same frames. The entry keeps a copy of its
  // own: the caller wipes its buffer on a failure, and a failed put leaves
  // the entry whole for that retry.
  // A voice note's ms is its container's: a given ms must be within
  // AUDIO_MS_TOLERANCE of it.
  // to: the destination's diary key, required, part of the reuse key and
  // kept on the entry. An entry outlives an uncertain send (kept for its
  // retry), so without it the same photo forwarded to a second conversation
  // would carry the first one's blob and let the seeder link the readers of
  // both; send refuses an item prepared for another destination.
  async function putMedia (own, keyPair, { bytes, mime, width, height, ms, to }) {
    requireUnlocked()
    const gen = generation
    const voice = mime === dm.DM_AUDIO_MIME
    const toOk = typeof to === 'string' && /^[0-9a-f]{64}$/.test(to)
    let ok = false
    if (toOk && bytes instanceof Uint8Array && voice) {
      const given = ms === undefined || (Number.isInteger(ms) && ms >= 1 && ms <= dm.DM_AUDIO_MAX_MS)
      ms = given && width === 0 && height === 0 ? voiceMs(bytes, ms) : null
      ok = ms !== null
    } else if (toOk && bytes instanceof Uint8Array) {
      ok = dm.DM_MEDIA_MIMES.includes(mime) && (ms === undefined || ms === 0) && mediaBounds(bytes, mime) !== null
      ms = 0
    }
    if (!ok) {
      if (bytes instanceof Uint8Array) wipe(bytes)
      throw new UsageError(BAD_MEDIA)
    }
    const plain = new Uint8Array(bytes)
    wipe(bytes)
    const hash = [sha256Hex(plain), mime, width, height, ms, to].join('\n')
    let entry = sealedByPlain.get(hash)
    if (entry === undefined || entry.plain === null) {
      let sealed
      try {
        sealed = sealBlob(plain)
      } catch (err) {
        wipe(plain)
        throw err
      }
      entry = { sealed, mime, w: width, h: height, ms, to, plain, hash, lock: Promise.resolve() }
      sealedById.set(sealed.descriptor.id, entry)
      sealedByPlain.set(hash, entry)
      while (sealedById.size > BLOBS_MAX) forgetBlob(sealedById.values().next().value)
    } else {
      wipe(plain)
    }
    const missing = entry.sealed.frames.filter((f) => f === null).length
    if (missing > 0 && (await blobs.walletSize()) < missing) await blobs.topUp(keyPair, { force: true })
    if (gen !== generation) throw new UsageError(LOCKED)
    await upload(entry, keyPair)
    if (gen !== generation) throw new UsageError(LOCKED)
    return itemOf(entry)
  }

  // The sealed blob of a dm.send item, which must be exactly what putMedia
  // answered in this unlock for this same destination.
  function entryOfItem (item, to) {
    const entry = sealedById.get(item.id)
    if (entry === undefined || entry.plain === null || entry.to !== to) throw new UsageError(MEDIA_STALE)
    const want = itemOf(entry)
    if (!DM_MEDIA_KEYS.every((k) => want[k] === item[k])) throw new UsageError(MEDIA_STALE)
    return entry
  }

  // A momento's photo (docs/rpc.md 5.113). bytes: the caller's copy, wiped
  // here. Every call seals a FRESH blob, never the putMedia reuse map: the
  // key and nonce go public in the moment record, so a blob shared with a
  // DM (or another moment) would open that one for every reader of the
  // diary. The upload takes stamps as putMedia does. -> the item, ms 0.
  // A short video (mime video/mp4, the caller's stripped copy) must pass the
  // strict check a reader makes with exactly the given sides and ms: the
  // item's sides and duration are the container's. DM media never takes one.
  async function putPublicMedia (own, keyPair, { bytes, mime, width, height, ms = 0 }) {
    requireUnlocked()
    const gen = generation
    let ok
    if (mime === VIDEO_MIME) {
      const video = bytes instanceof Uint8Array && bytes.byteLength >= 1 && bytes.byteLength <= MAX_MOMENT_VIDEO_BYTES
        ? videoBounds(bytes, { maxMs: MAX_MOMENT_VIDEO_MS })
        : null
      ok = video !== null && video.width === width && video.height === height && video.ms === ms
    } else {
      ok = bytes instanceof Uint8Array && mime !== dm.DM_AUDIO_MIME && dm.DM_MEDIA_MIMES.includes(mime) &&
        Number.isInteger(width) && width >= 1 && Number.isInteger(height) && height >= 1 &&
        mediaBounds(bytes, mime) !== null
      ms = 0
    }
    if (!ok) {
      if (bytes instanceof Uint8Array) wipe(bytes)
      throw new UsageError(BAD_MEDIA)
    }
    let sealed
    try {
      sealed = sealBlob(bytes)
    } finally {
      wipe(bytes)
    }
    const entry = { sealed, lock: Promise.resolve() }
    const missing = sealed.frames.filter((f) => f === null).length
    if (missing > 0 && (await blobs.walletSize()) < missing) await blobs.topUp(keyPair, { force: true })
    if (gen !== generation) throw new UsageError(LOCKED)
    await upload(entry, keyPair)
    if (gen !== generation) throw new UsageError(LOCKED)
    const item = mediaItem({ ...sealed.descriptor, mime, w: width, h: height, ms })
    publicItems.set(item.id, item)
    while (publicItems.size > BLOBS_MAX) publicItems.delete(publicItems.keys().next().value)
    return mediaItem(item)
  }

  // Whether `item` is exactly one putPublicMedia answered in this unlock.
  function isOwnPublicItem (item) {
    if (!unlocked() || item === null || typeof item !== 'object') return false
    const want = publicItems.get(item.id)
    return want !== undefined && DM_MEDIA_KEYS.every((k) => want[k] === item[k])
  }

  // A published item is not offered again: the next moment seals its own.
  function forgetPublicItem (item) {
    if (item !== null && typeof item === 'object' && isOwnPublicItem(item)) publicItems.delete(item.id)
  }

  // A momento's photo -> { bytes, mime, w, h } (bytes: a fresh copy the
  // caller owns). The key and nonce are the record's own (public), so no
  // unlock is needed: the blob is fetched over plain HTTP GETs from the
  // seeder's origin. Gone, refused or not verifying (size, sha256, an image
  // of that mime) all answer MOMENT_PHOTO_GONE. A video answers its ms too:
  // fetchBlob checks images only, so its bytes must pass the strict video
  // check with exactly the item's sides and duration.
  async function readPublicMedia (item) {
    const d = item
    const video = d !== null && typeof d === 'object' && d.mime === VIDEO_MIME
    if (d === null || typeof d !== 'object' || (video
      ? !(Number.isInteger(d.ms) && d.ms >= 1 && d.ms <= MAX_MOMENT_VIDEO_MS)
      : d.ms !== 0 || d.mime === dm.DM_AUDIO_MIME || !dm.DM_MEDIA_MIMES.includes(d.mime))) {
      throw new Error(MOMENT_PHOTO_GONE)
    }
    if (blobOrigin === null) throw new Error(MOMENT_PHOTO_GONE)
    let r
    try {
      r = await fetchBlob({ id: d.id, key: d.key, nonce: d.nonce, chunks: d.chunks, bytes: d.bytes, sha256: d.sha256 }, blobOrigin, { mime: d.mime, fetch: fetchImpl, limits: L.fetch })
    } catch (err) {
      const msg = err && err.message
      if (msg === MEDIA_GONE || msg === BAD_MEDIA) throw new Error(MOMENT_PHOTO_GONE)
      throw err
    }
    if (video) {
      const v = videoBounds(r.bytes, { maxMs: MAX_MOMENT_VIDEO_MS })
      if (v === null || v.width !== d.w || v.height !== d.h || v.ms !== d.ms) {
        wipe(r.bytes)
        throw new Error(MOMENT_PHOTO_GONE)
      }
      return { bytes: r.bytes, mime: d.mime, w: d.w, h: d.h, ms: d.ms }
    }
    return { bytes: r.bytes, mime: d.mime, w: d.w, h: d.h }
  }

  async function seen (own, peer, page) {
    requireUnlocked()
    const [self, ctx] = await contextOf(own, page)
    const c = await threadOf(self, peer, ctx)
    if (c === null) return { ok: true }
    const ids = c.messages.filter((m) => !m.mine).map((m) => ctx.local.seenToken(dmFold.seenKey(m.from, m.id)))
    if (ids.length > 0) await store.writeDmSeen(storage, [...await store.readDmSeen(storage, ctx.prefix), ...ids], ctx.prefix)
    return { ok: true }
  }

  function canSend (own, peer) {
    return dmFold.canSend({ self: own, peer, ops: local.ops() })
  }

  // ---- the wallet ----

  // The wallet as plain stamps [{ kid, token, sig }] (kv holds each
  // { token, sig } sealed under the local key); throws while locked. An item
  // that does not open (another key, tampered, an old plaintext form) is
  // dropped by the next write.
  async function readWallet () {
    const w = await store.readDmStamps(storage)
    const items = []
    for (const s of w.items) {
      const v = local.open({ nonce: s.nonce, box: s.box })
      if (v === null || typeof v.token !== 'string' || !/^[0-9a-f]{64}$/.test(v.token) || typeof v.sig !== 'string') continue
      items.push({ kid: s.kid, token: v.token, sig: v.sig })
    }
    return { items, kids: w.kids }
  }

  function writeWallet ({ items, kids }) {
    return store.writeDmStamps(storage, { items: items.map((s) => ({ kid: s.kid, ...local.seal({ token: s.token, sig: s.sig }) })), kids })
  }

  // The ctl queue as base64 strings (sealed envelopes or encoded drops);
  // kv holds each sealed under the local key. Throws while locked.
  async function readQueue (ctx = personal) {
    const out = []
    for (const item of await store.readDmCtlQueue(storage, ctx.prefix)) {
      const v = ctx.local.open(item)
      if (v !== null && typeof v.b === 'string') out.push(v.b)
    }
    return out
  }

  function writeQueue (list, ctx = personal) {
    return store.writeDmCtlQueue(storage, list.map((b) => ctx.local.seal({ b })), ctx.prefix)
  }

  // Takes n stamps at once (all or none) -> [{ kid, token, sig }] or null.
  function takeStamps (n) {
    return withWallet(async () => {
      const w = await readWallet()
      const usable = w.items.filter((s) => w.kids.length === 0 || w.kids.includes(s.kid))
      if (usable.length < n) return null
      const taken = usable.slice(0, n)
      const spent = new Set(taken.map((s) => s.token))
      await writeWallet({ items: w.items.filter((s) => !spent.has(s.token)), kids: w.kids })
      return taken
    })
  }

  async function walletSize () {
    const w = await readWallet()
    return w.items.filter((s) => w.kids.length === 0 || w.kids.includes(s.kid)).length
  }

  // Fills the wallet to DM_STAMP_WALLET when below DM_STAMP_WALLET_LOW (or
  // `force`), at most once per topUpEveryMs unless forced. Single flight.
  // keyPair: the identity pair, for the stamp link's proof. Never throws.
  function topUp (keyPair, opts) {
    // The blob wallet on the same schedule; it limits itself (./blob.js).
    if (unlocked()) track(blobs.topUp(keyPair).catch(() => 0))
    return topUpDm(keyPair, opts)
  }

  function topUpDm (keyPair, { force = false } = {}) {
    if (topping !== null) return topping
    topping = track((async () => {
      try {
        let fresh = 0
        if ((force || Date.now() >= nextTopUp) && (force || (await walletSize()) < dm.DM_STAMP_WALLET_LOW)) {
          try {
            fresh = await issueStamps(keyPair)
          } catch {}
          if (fresh === 0) {
            nextTopUp = Date.now() + L.topUpRetryMs
            log('aviso: selos de mensagem não renovados')
          } else {
            nextTopUp = Date.now() + L.topUpEveryMs
          }
        }
        return fresh
      } catch {
        return 0
      }
    })())
    // Cleared outside the body: a body that returns before its first await
    // would clear the slot before it was set.
    const p = topping
    p.then(() => { if (topping === p) topping = null })
    return p
  }

  async function issueStamps (keyPair) {
    const link = await openStampLink({ ...linkOpts, keyPair })
    const fresh = []
    let pub
    try {
      pub = await link.key()
      const parsed = postage.parsePublicKey(pub)
      if (parsed === null) return 0
      const need = dm.DM_STAMP_WALLET - await walletSize()
      for (let i = 0; i < need; i++) {
        if (i >= L.issueBurst && L.issuePaceMs > 0) await sleep(L.issuePaceMs)
        const token = postage.newToken(parsed.n)
        const { blinded, r } = postage.blind(postage.representative(token), parsed.n)
        const res = await link.issue(postage.toBase64(blinded))
        if (res.error !== undefined || res.kid !== pub.kid) break
        const s = postage.fromBase64(res.sig)
        if (s === null) break
        const sig = postage.unblind(s, r, parsed.n)
        if (!postage.verify(token, sig, pub)) break
        fresh.push({ kid: pub.kid, token: b4a.toString(token, 'hex'), sig: postage.toBase64(sig) })
      }
    } finally {
      link.close()
    }
    // The seeder accepts the current and the previous kid only. A key is
    // taken as current only once a stamp under it verified: a key announced
    // with no usable stamp must not make the wallet drop unspent stamps.
    if (fresh.length === 0) return 0
    await withWallet(async () => {
      const w = await readWallet()
      const kids = w.kids[0] === pub.kid ? w.kids : [pub.kid, ...w.kids.slice(0, 1)]
      const known = new Set(w.items.map((s) => s.token))
      const items = [...w.items.filter((s) => kids.includes(s.kid)), ...fresh.filter((s) => !known.has(s.token))]
      await writeWallet({ items, kids })
    })
    return fresh.length
  }

  function dropOf (sealed, stamp) {
    return dm.encodeDrop({
      dropId: dm.newDropId(),
      kid: b4a.from(stamp.kid, 'hex'),
      rsaSig: b4a.from(stamp.sig, 'base64'),
      token: b4a.from(stamp.token, 'hex'),
      sealed
    })
  }

  // ---- sending ----

  function refusal (reason) {
    if (reason === 'cheio') return new UsageError(SEEDER_FULL)
    if (reason === 'ritmo') return new UsageError(SEEDER_RATE)
    return new UsageError(REFUSED)
  }

  // Puts every drop of the entry not acked yet; files the message once the
  // recipient's drop is acked. A lost link throws unconfirmed().
  async function deliver (entry) {
    if (entry.acked.every(Boolean)) {
      await fileSent(entry)
      return
    }
    let link
    try {
      link = await openDmLink(linkOpts)
    } catch (err) {
      if (err instanceof UsageError) throw err
      throw new UsageError('sem conexão com o semeador')
    }
    try {
      for (let i = 0; i < entry.drops.length; i++) {
        if (entry.acked[i]) continue
        let r
        emit('dm.sending', {})
        try {
          r = await link.put(entry.drops[i])
        } catch {
          throw unconfirmed()
        }
        if (!r.ok) {
          if (r.reason === 'invalido') {
            pending.delete(entry.key)
            dropEntry(entry)
          }
          throw refusal(r.reason)
        }
        entry.acked[i] = true
        if (i === 0) await fileSent(entry)
      }
    } finally {
      link.close()
    }
    await fileSent(entry)
  }

  // Files the sent message here once its recipient drop was acked; separate
  // from the put, so a retry after a failed filing files without a re-put.
  async function fileSent (entry) {
    if (entry.row === null || !entry.acked[0]) return
    const lc = entry.local || local
    const filed = entry.row.t === 'rx' ? lc.hasReaction(entry.row.from, entry.row.id) : lc.hasMessage(entry.row.from, entry.row.id)
    if (!filed) await lc.append([{ ...entry.row, filedAt: lc.nextFiled() }])
    const row = entry.row
    entry.row = null
    // The sender's own photos are cached from the bytes it put, so its
    // thread never downloads them back: from the entry's private copies,
    // which no other send or forgetBlob touches (the store copies them
    // before its first await).
    const plains = entry.plains || []
    entry.plains = null
    if (plains.length > 0) {
      try {
        await local.putMedia(row.from, row.id, plains)
      } catch {}
      plains.forEach(wipe)
    }
  }

  function dropEntry (entry) {
    if (Array.isArray(entry.plains)) entry.plains.forEach(wipe)
    entry.plains = null
  }

  function clearPending () {
    for (const entry of pending.values()) dropEntry(entry)
    pending.clear()
  }

  // Puts the queue (flushCtlQueue). Never throws; warns when something
  // stays queued.
  async function flushQueued (ctx = personal) {
    try {
      await withQueue(() => flushCtlQueue(ctx))
    } catch {}
    try {
      if ((await store.readDmCtlQueue(storage, ctx.prefix)).length > 0) log('aviso: estado da conversa ainda não enviado aos seus outros aparelhos')
    } catch {}
  }

  // Inside withQueue: puts the queued ctls, oldest first. A sealed item is
  // stamped and its drop bytes written back to the queue before the put; it
  // stops at the first one that cannot go (no stamp, full pool, rate, lost
  // link) and keeps it. A refused drop (invalido) is removed with a warning.
  async function flushCtlQueue (ctx = personal) {
    if (!unlocked()) return
    let queue = await readQueue(ctx)
    if (queue.length === 0) return
    let link = null
    try {
      while (queue.length > 0) {
        let bytes = b4a.from(queue[0], 'base64')
        if (bytes.byteLength !== dm.DM_DROP_BYTES) {
          const stamps = await takeStamps(1)
          if (stamps === null) return
          bytes = dropOf(bytes, stamps[0])
          queue = [b4a.toString(bytes, 'base64'), ...queue.slice(1)]
          await writeQueue(queue, ctx)
        }
        if (link === null) link = await openDmLink(linkOpts)
        emit('dm.sending', {})
        const r = await link.put(bytes)
        if (!r.ok && r.reason !== 'invalido') return
        if (!r.ok) log('aviso: 1 estado de conversa recusado pelo semeador')
        queue = queue.slice(1)
        await writeQueue(queue, ctx)
      }
    } finally {
      if (link !== null) link.close()
    }
  }

  function checkSend (own, to) {
    requireUnlocked()
    if (to === own) throw new UsageError(SELF_SEND)
    if (!canSend(own, to)) throw new UsageError(BLOCKED)
  }

  // to: hex64; recipientBox: hex64 | null (dm.lookup). keyPair: identity.
  // media: null or dm.send items (docs/rpc.md 5.75), each answered by
  // putMedia in this unlock.
  async function send (own, keyPair, { to, text, replyTo = null, media = null, card = null, fwd = 0 }, recipientBox) {
    checkSend(own, to)
    const items = Array.isArray(media) && media.length > 0 ? media.map(mediaItem) : null
    card = card === null ? null : copyLinkCard(card, mediaItem)
    const key = to + '\n' + (replyTo || '') + '\n' + text + '\n' + fwd + '\n' + (items === null ? '' : JSON.stringify(items)) + '\n' + JSON.stringify(card)
    let entry = pending.get(key)
    if (entry === undefined) {
      const sealedBlobs = messageItems({ media: items, card }).map((item) => entryOfItem(item, to))
      // Copied before any await: an overlapping send of the same blob may
      // forget (and wipe) the shared entry meanwhile.
      const plains = sealedBlobs.map((b) => new Uint8Array(b.plain))
      entry = await newEntry(own, keyPair, { to, text, replyTo, fwd, items, card, key }, recipientBox, sealedBlobs, plains).catch((err) => {
        plains.forEach(wipe)
        throw err
      })
      if (pending.size >= PENDING_MAX) {
        const oldest = pending.keys().next().value
        dropEntry(pending.get(oldest))
        pending.delete(oldest)
      }
      pending.set(key, entry)
    }
    await deliver(entry)
    if (pending.get(key) === entry) pending.delete(key)
    dropEntry(entry)
    for (const b of entry.blobs) forgetBlob(b)
    entry.blobs = []
    return { id: entry.id, at: entry.at }
  }

  // A new pending send: checked, its blobs acked, sealed and stamped.
  async function newEntry (own, keyPair, { to, text, replyTo, fwd, items, card, key }, recipientBox, sealedBlobs, plains) {
    if (recipientBox === null) throw new UsageError(NO_BOX)
    if (replyTo !== null) {
      const c = await threadOf(own, to)
      if (c === null || dmFold.replyTarget(c.messages, replyTo) === null) throw new UsageError(BAD_REPLY)
    }
    const id = dm.newMessageId()
    const at = nowIso()
    const cert = await certOf(own)
    if ((items !== null || card !== null) && dmTextBytes(text) > dm.textBudget({ kind: 'msg', id, from: own, to, replyTo, fwd, media: items, card, at, cert })) {
      throw new UsageError(TOO_LONG)
    }
    // Every chunk acked before any drop is stamped or put.
    const gen = generation
    for (const b of sealedBlobs) await upload(b, keyPair)
    if (gen !== generation) throw new UsageError(LOCKED)
    let inner
    try {
      inner = dm.buildInner({ kind: 'msg', id, at, to, text, replyTo, fwd, cert, card, ...(items === null ? {} : { media: items }) }, keyPair)
    } catch (err) {
      throw new UsageError(err && err.message === TOO_LONG ? TOO_LONG : BAD_TEXT)
    }
    let sealedTo, sealedSelf, digest
    try {
      digest = dm.frameDigest(inner)
      sealedTo = dm.sealInner(inner, recipientBox)
      sealedSelf = dm.sealInner(inner, b4a.toString(box.publicKey, 'hex'))
    } catch {
      throw new UsageError(NO_BOX)
    } finally {
      inner.fill(0)
    }
    const stamps = await takeStamps(2)
    if (stamps === null) throw new UsageError(NO_STAMPS)
    return {
      key,
      id,
      at,
      drops: [dropOf(sealedTo, stamps[0]), dropOf(sealedSelf, stamps[1])],
      acked: [false, false],
      row: { t: 'msg', id, peer: to, from: own, text, replyTo, fwd, media: items, card, at, mine: true, digest },
      blobs: sealedBlobs,
      plains
    }
  }

  // A reaction (inner v4) to a message of the held thread with `to`: sealed
  // to the peer and to the own box and stamped as one dm.send (two stamps),
  // filed here once the peer's drop is acked. At most one pending op per
  // (to, target): the same emoji only puts what was not acked; another one
  // is a new op. With none pending, a call whose emoji is already the own
  // reaction ('' with none) sends nothing. -> { ok: true }
  async function react (own, keyPair, { to, target, emoji }, recipientBox) {
    checkSend(own, to)
    await whenLoaded()
    const key = 'rx\n' + to + '\n' + target.from + '\n' + target.id
    let entry = pending.get(key)
    if (entry === undefined || entry.rx.emoji !== emoji) {
      const c = await threadOf(own, to)
      const row = c === null ? undefined : c.messages.find((m) => m.from === target.from && m.id === target.id)
      if (row === undefined) throw new UsageError(NO_TARGET)
      // A row stored without a digest (an earlier build, a Página's legacy
      // history) takes no reaction: nothing would bind the op to its content.
      if (typeof row.digest !== 'string' || !DIGEST_RE.test(row.digest)) throw new UsageError(NOT_REACTABLE)
      const prior = pending.get(key)
      if (prior === undefined) {
        const mine = Array.isArray(row.reactions) ? row.reactions.find((r) => r.mine) : undefined
        if ((mine === undefined ? '' : mine.emoji) === emoji) return { ok: true }
      }
      // A different emoji replaces the pending op: its unacked drops are
      // abandoned, and the higher rev wins wherever both arrive.
      // The target from the stored row, never from the caller: its digest
      // binds the reaction to this message.
      const t = { from: row.from, id: row.id, digest: row.digest }
      entry = await newReaction(own, keyPair, { to, target: t, emoji, key }, recipientBox, prior === undefined || prior.rx.digest !== row.digest ? 0 : prior.rx.rev)
      if (pending.get(key) !== undefined) {
        dropEntry(pending.get(key))
        pending.delete(key)
      } else if (pending.size >= PENDING_MAX) {
        const oldest = pending.keys().next().value
        dropEntry(pending.get(oldest))
        pending.delete(oldest)
      }
      pending.set(key, entry)
    }
    await deliver(entry)
    if (pending.get(key) === entry) pending.delete(key)
    return { ok: true }
  }

  // rev: one past the highest the store or the pending op (pendingRev)
  // holds for (to, target, own), target digest included, so an unacked op never ties with the next.
  async function newReaction (own, keyPair, { to, target, emoji, key }, recipientBox, pendingRev) {
    if (recipientBox === null) throw new UsageError(NO_BOX)
    const id = dm.newMessageId()
    const at = nowIso()
    const cert = await certOf(own)
    // Read after the await: a pull may have filed a newer op of another
    // device of this passkey meanwhile, and a stale rev would lose to it.
    const rev = Math.max(local.reactionRev(to, target, own), pendingRev) + 1
    if (rev > dm.DM_REACT_REV_MAX) throw new UsageError(REACT_MAX)
    const t = { from: target.from, id: target.id, digest: target.digest }
    let inner
    try {
      inner = dm.buildInner({ kind: 'react', id, at, to, target: t, emoji, rev, cert }, keyPair)
    } catch {
      throw new UsageError(BAD_TEXT)
    }
    let sealedTo, sealedSelf
    try {
      sealedTo = dm.sealInner(inner, recipientBox)
      sealedSelf = dm.sealInner(inner, b4a.toString(box.publicKey, 'hex'))
    } catch {
      throw new UsageError(NO_BOX)
    } finally {
      inner.fill(0)
    }
    const stamps = await takeStamps(2)
    if (stamps === null) throw new UsageError(NO_STAMPS)
    return {
      key,
      id,
      at,
      drops: [dropOf(sealedTo, stamps[0]), dropOf(sealedSelf, stamps[1])],
      acked: [false, false],
      row: { t: 'rx', id, peer: to, from: own, to, target: t, emoji, rev, at, mine: true },
      rx: { emoji, rev, digest: t.digest },
      blobs: [],
      plains: null
    }
  }

  // The op is filed here first; the ctl to the own box only tells the other
  // own devices. Never anything to the peer.
  async function set (own, keyPair, { peer, state }) {
    requireUnlocked()
    if (peer === own) throw new UsageError('nada a alterar')
    const id = dm.newMessageId()
    const at = nowIso()
    await local.append([{ t: 'ctl', id, op: state, peer, at, filedAt: local.nextFiled() }])
    const inner = dm.buildInner({ kind: 'ctl', id, at, op: state, peer }, keyPair)
    let sealed
    try {
      sealed = dm.sealInner(inner, b4a.toString(box.publicKey, 'hex'))
    } finally {
      inner.fill(0)
    }
    // The op is filed here either way. The new ctl goes behind any older
    // queued one, so the other devices file them in order.
    const dropped = await withQueue(() => store.pushDmCtlQueue(storage, local.seal({ b: b4a.toString(sealed, 'base64') })))
    if (dropped > 0) log('aviso: ' + dropped + ' estados de conversa antigos descartados da fila')
    await flushQueued()
    return { ok: true }
  }

  // ---- pulling ----

  // Each held page's scan state for one pull: its store, its boxes (the
  // held gen, the previous ones, then the legacy one) and its pool cursor. A cursor scanned
  // for another gen starts over (the pool keeps 7 days).
  async function pageScans () {
    const out = []
    for (const page of pages.pages()) {
      try {
        const epoch = pageEpochs.get(page) || 0
        const ctx = await pageCtx(page)
        const e = pages.get(page)
        if (e === null) continue
        // Each box with the page key its drops are addressed to.
        const boxes = [e.dmBox, ...e.previous.map((x) => x.box)].map((pair) => ({ pair, key: page }))
        if (e.legacy !== null) boxes.push({ pair: e.legacy.box, key: e.legacy.page })
        // A cursor scanned with other boxes starts over: an adoption whose
        // own cursor reset never got written still heals here.
        const set = boxSetOf(e)
        let cursor = await store.readPageCursor(storage, ctx.prefix)
        if (cursor.gen !== e.gen || cursor.set !== set) cursor = { after: 0, gen: e.gen, set }
        out.push({ page, ctx, gen: e.gen, set, epoch, boxes, cursor, added: 0, applied: 0, stale: false })
      } catch {}
    }
    return out
  }

  // A hex32 digest of a held page's public boxes (current, previous, then
  // legacy): read only, sends always seal to the current one.
  function boxSetOf (e) {
    const parts = [e.dmBox.publicKey, ...e.previous.map((x) => x.box.publicKey)]
    if (e.legacy !== null) parts.push(e.legacy.box.publicKey)
    return b4a.toString(hcrypto.hash(parts), 'hex').slice(0, 32)
  }

  async function pull (own) {
    requireUnlocked()
    if (pulling) throw new UsageError(PULL_BUSY)
    pulling = true
    const gen = generation
    let added = 0
    let applied = 0
    let cursor = await store.readDmCursor(storage)
    let incomplete = false
    let link = null
    let scans = []
    try {
      try {
        link = await openDmLink(linkOpts)
      } catch (err) {
        if (err instanceof UsageError) throw err
        throw new UsageError('sem conexão com o semeador')
      }
      scans = await pageScans()
      // Pages scanned up to where the own cursor stands ride along.
      const along = scans.filter((p) => p.cursor.after === cursor)
      let read = 0
      for (;;) {
        if (gen !== generation) throw new UsageError(LOCKED)
        const page = await link.page({ after: cursor, limit: L.pageMax })
        const rows = []
        // A copy: this page's ctls join it as they are filed.
        const ops = [...local.ops()]
        const mod = await moderation()
        const missed = []
        for (const item of page.items) {
          read += item.bytes.byteLength
          const row = openItem(own, item.bytes, ops, rows, mod)
          if (row !== null) {
            // Filed now, on the monotonic clock: a ctl earlier in this page
            // then counts for the items after it (dm-fold ignores a row
            // without filedAt).
            row.filedAt = local.nextFiled()
            rows.push(row)
            if (row.t === 'ctl') ops.push(row)
          } else if (along.length > 0) {
            missed.push(item.bytes)
          }
        }
        if (gen !== generation) throw new UsageError(LOCKED)
        if (rows.length > 0) {
          await local.append(rows)
          for (const r of rows) {
            if (r.t === 'msg') added++
            else applied++
          }
        }
        for (const p of along) await filePageItems(p, missed, mod)
        if (page.items.length > 0) {
          cursor = page.items[page.items.length - 1].seq
          await store.writeDmCursor(storage, cursor)
          for (const p of along) await movePageCursor(p, cursor)
        }
        if (page.next === null || page.items.length === 0) break
        if (read >= L.budgetBytes) {
          incomplete = true
          break
        }
      }
      // The other held pages catch up from their own cursor.
      for (const p of scans) {
        if (incomplete) break
        if (along.includes(p)) continue
        for (;;) {
          if (gen !== generation) throw new UsageError(LOCKED)
          if (p.stale) break
          const page = await link.page({ after: p.cursor.after, limit: L.pageMax })
          const mod = await moderation()
          for (const item of page.items) read += item.bytes.byteLength
          await filePageItems(p, page.items.map((item) => item.bytes), mod)
          if (page.items.length > 0) await movePageCursor(p, page.items[page.items.length - 1].seq)
          if (page.next === null || page.items.length === 0) break
          if (read >= L.budgetBytes) {
            incomplete = true
            break
          }
        }
      }
    } finally {
      pulling = false
      if (link !== null) link.close()
      if (added > 0 || applied > 0) emit('dm.changed', { added })
      for (const p of scans) {
        if (p.added > 0 || p.applied > 0) emit('dm.changed', { added: p.added, page: p.page })
      }
    }
    return { added, cursor, incomplete }
  }

  // An adoption or a forget since the pull began (the epoch moved) leaves
  // the page to the next pull: nothing more is written for it here.
  function pageStale (p) {
    if (p.stale || forgetting.has(p.page) || (pageEpochs.get(p.page) || 0) !== p.epoch) p.stale = true
    return p.stale
  }

  async function movePageCursor (p, after) {
    if (pageStale(p)) return
    if (!p.ctx.local.unlocked()) throw new UsageError(LOCKED)
    p.cursor = { after, gen: p.gen, set: p.set }
    await store.writePageCursor(storage, p.ctx.prefix, p.cursor)
  }

  // Pool items (drop bytes) -> rows filed in page p's store.
  async function filePageItems (p, items, mod) {
    if (items.length === 0 || pageStale(p)) return
    const lc = p.ctx.local
    const rows = []
    const ops = lc.snapshot().ops
    for (const bytes of items) {
      const row = openPageItem(p, bytes, ops, rows, mod)
      if (row !== null) {
        row.filedAt = lc.nextFiled()
        rows.push(row)
        if (row.t === 'ctl') ops.push(row)
      }
    }
    if (rows.length === 0) return
    try {
      await lc.append(rows)
    } catch (err) {
      // A forget that locked the store under this append.
      if (pageStale(p)) return
      throw err
    }
    for (const r of rows) {
      if (r.t === 'msg') p.added++
      else p.applied++
    }
  }

  // The held pages and their boxes (hex), for the published-key check the
  // session runs after a pull, outside any tracked operation (its lookup
  // queues on the session's chain, which a reset may hold while it waits
  // for this engine to go idle).
  function heldPageBoxes () {
    if (!unlocked()) return []
    return pages.pages().map((page) => {
      const e = pages.get(page)
      return { page, box: b4a.toString(e.dmBox.publicKey, 'hex'), gen: e.gen }
    })
  }

  // While the page's published dm-key differs from the held gen or box, the
  // page is flagged (drafts and sends refused). `box`, `gen`: the held ones
  // the check compared; a page adopted again since then is left as it is.
  // -> whether the flag was applied.
  function setPageMismatch (page, box, differs, gen) {
    const e = pages.get(page)
    if (e === null || b4a.toString(e.dmBox.publicKey, 'hex') !== box) return false
    if (gen !== undefined && e.gen !== gen) return false
    pages.setMismatch(page, differs)
    return true
  }

  // One pool item -> a row to file, or null (not ours, uncertified, known,
  // blocked here or by the association).
  function openItem (own, bytes, ops, batch, mod) {
    const drop = dm.decodeDrop(bytes)
    if (drop === null) return null
    const inner = dm.openSealed(drop.sealed, box)
    if (inner === null) return null
    const body = dm.openInner(inner, own, { association, revokedIssuers: mod.revokedIssuers })
    if (body === null || dm.pageInnerStale(body, Date.now())) return null
    return rowOf(own, body, ops, batch, mod.blocked, local, dm.bodyDigest(body))
  }

  // The same rules with the page as self, opened by the page's boxes; only
  // the association's blocks drop a sender.
  function openPageItem (p, bytes, ops, batch, mod) {
    const drop = dm.decodeDrop(bytes)
    if (drop === null) return null
    for (const { pair, key } of p.boxes) {
      const inner = dm.openSealed(drop.sealed, pair)
      if (inner === null) continue
      let body = dm.openInner(inner, key, { association, revokedIssuers: mod.revokedIssuers })
      // A page message put after its signature's expiry is a replay of a
      // stockpiled signature (core dm.js pageInnerStale): never filed.
      if (body === null || dm.pageInnerStale(body, Date.now())) return null
      // A Página conversation has no reactions: a v4 body is never filed.
      if (body.kind === 'react') return null
      // Of the body as signed, before a carried legacy key is renamed.
      const digest = dm.bodyDigest(body)
      // A drop to the key a carried legacy box belonged to is filed for this
      // page, as the bundle's rows are.
      if (key !== p.page) {
        if (body.kind === 'ctl' && body.peer === p.page) return null
        body = { ...body, from: body.from === key ? p.page : body.from, to: body.to === key ? p.page : body.to }
        if (body.from === body.to) return null
      }
      return rowOf(p.page, body, ops, batch, mod.association, p.ctx.local, digest)
    }
    return null
  }

  // digest: dm.bodyDigest of the verified body (what a reaction names).
  function rowOf (own, body, ops, batch, blocked, lc, digest) {
    if ((body.kind === 'msg' || body.kind === 'react') && !body.mine && blocked.has(body.from)) return null
    if (body.kind === 'react') return reactionRowOf(own, body, ops, batch, lc)
    if (body.kind === 'ctl') {
      if (lc.hasOp(body.id) || batch.some((r) => r.t === 'ctl' && r.id === body.id)) return null
      return { t: 'ctl', id: body.id, op: body.op, peer: body.peer, at: body.at }
    }
    const peer = body.mine ? body.to : body.from
    if (lc.hasMessage(body.from, body.id) || batch.some((r) => r.t === 'msg' && r.from === body.from && r.id === body.id)) return null
    // A blocked sender's messages are dropped once they open.
    if (!body.mine && !dmFold.canSend({ self: own, peer, ops })) return null
    return { t: 'msg', id: body.id, peer, from: body.from, text: body.text, replyTo: body.replyTo, fwd: body.fwd === 1 ? 1 : 0, media: Array.isArray(body.media) ? body.media.map(mediaItem) : null, card: body.card ? copyLinkCard(body.card, mediaItem) : null, at: body.at, mine: body.mine, digest }
  }

  // Kept even while its target is not stored: the fold applies it once the
  // target is. Never a message row, so it takes no (from, id) message slot.
  function reactionRowOf (own, body, ops, batch, lc) {
    if (lc.hasReaction(body.from, body.id) || batch.some((r) => r.t === 'rx' && r.from === body.from && r.id === body.id)) return null
    const peer = body.mine ? body.to : body.from
    if (!body.mine && !dmFold.canSend({ self: own, peer, ops })) return null
    return { t: 'rx', id: body.id, peer, from: body.from, to: body.to, target: { from: body.target.from, id: body.target.id, digest: body.target.digest }, emoji: body.emoji, rev: body.rev, at: body.at, mine: body.mine }
  }

  // ---- Páginas (docs/rpc.md 5.114) ----

  function pageGenerate (own, identity, params) {
    requireUnlocked()
    return pages.generate(own, identity, params)
  }

  function pageShare (identity, params) {
    requireUnlocked()
    return pages.share(identity, params)
  }

  // roster: the page's current { owner, admins }, read before this runs (a
  // tracked operation never waits on the session's queue). A new gen or box
  // scans the pool again for that page from its oldest drop.
  async function pageSecrets (own, roster, params) {
    requireUnlocked()
    const r = await pages.adopt(own, box, roster, params)
    if (r.changed) {
      pageEpochs.set(params.page, (pageEpochs.get(params.page) || 0) + 1)
      const ctx = await pageCtx(params.page)
      await store.writePageCursor(storage, ctx.prefix, { after: 0, gen: params.gen, set: boxSetOf(pages.get(params.page)) })
    }
    return { ok: true }
  }

  // recipientBox: the newest dm-key box of `to` (a msg), as dm.send's.
  async function pageDraft ({ page, kind, to, text, replyTo, fwd, op, peer }, recipientBox) {
    requireUnlocked()
    const e = pages.need(page)
    pages.requireMatch(page)
    const ctx = await pageCtx(page)
    let fields
    if (kind === 'msg') {
      if (typeof to !== 'string' || typeof text !== 'string') throw new UsageError(BAD_TEXT)
      if (to === page) throw new UsageError(SELF_SEND)
      if (!dmFold.canSend({ self: page, peer: to, ops: ctx.local.ops() })) throw new UsageError(BLOCKED)
      if (typeof recipientBox !== 'string') throw new UsageError(NO_BOX)
      const reply = replyTo === undefined ? null : replyTo
      if (reply !== null) {
        const c = await threadOf(page, to, ctx)
        if (c === null || dmFold.replyTarget(c.messages, reply) === null) throw new UsageError(BAD_REPLY)
      }
      fields = { kind: 'msg', from: page, to, text, replyTo: reply, fwd: fwd === 1 ? 1 : 0, cert: e.cert }
    } else {
      if (typeof peer !== 'string' || peer === page || !dm.DM_OPS.includes(op)) throw new UsageError('nada a alterar')
      fields = { kind: 'ctl', from: page, to: page, op, peer, cert: e.cert }
    }
    let d
    try {
      d = dm.innerDigest(fields)
    } catch (err) {
      throw new UsageError(err && err.message === TOO_LONG ? TOO_LONG : BAD_TEXT)
    }
    pages.putDraft(d.body.id, { page, kind, json: d.json, body: d.body, box: kind === 'msg' ? recipientBox : null, entry: null })
    return { id: d.body.id, digest: d.digest, at: d.body.at }
  }

  function verifyPageSig (json, sigHex, expiresAt, page) {
    try {
      if (typeof sigHex !== 'string' || !/^[0-9a-f]{128}$/.test(sigHex)) return false
      const digest = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
      sodium.crypto_hash_sha256(digest, json)
      const exp = b4a.alloc(8)
      new DataView(exp.buffer, exp.byteOffset, 8).setBigUint64(0, BigInt(expiresAt))
      return hcrypto.verify(b4a.concat([SIG_PREFIX_V3, digest, exp]), b4a.from(sigHex, 'hex'), b4a.from(page, 'hex'))
    } catch {
      return false
    }
  }

  // A msg goes as dm.send's: to the recipient's box and the page's own, two
  // stamps from this identity's wallet, the exact drops kept on the draft so
  // the user's retry after an unconfirmed put repeats the same bytes. A ctl
  // goes to the page box only, through the page's ctl queue.
  async function pageSend ({ page, id, signature, expiresAt }) {
    requireUnlocked()
    const d = pages.draftOf(page, id)
    if (d === null) throw new UsageError(DRAFT_GONE)
    const e = pages.need(page)
    pages.requireMatch(page)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new UsageError(BAD_SIGNATURE)
    if (!verifyPageSig(d.json, signature, expiresAt, page)) throw new UsageError(BAD_SIGNATURE)
    const ctx = await pageCtx(page)
    const b = d.body
    if (d.kind === 'ctl') {
      // Each step once: a retry after a failed write redoes only what is
      // missing, with the same sealed bytes.
      if (d.sealed === undefined) {
        const inner = dm.assembleInner(d.json, signature, expiresAt)
        try {
          d.sealed = b4a.toString(dm.sealInner(inner, b4a.toString(e.dmBox.publicKey, 'hex')), 'base64')
        } finally {
          inner.fill(0)
        }
      }
      if (!ctx.local.hasOp(b.id)) await ctx.local.append([{ t: 'ctl', id: b.id, op: b.op, peer: b.peer, at: b.at, filedAt: ctx.local.nextFiled() }])
      if (d.queued !== true) {
        const dropped = await withQueue(() => store.pushDmCtlQueue(storage, ctx.local.seal({ b: d.sealed }), ctx.prefix))
        d.queued = true
        if (dropped > 0) log('aviso: ' + dropped + ' estados de conversa antigos descartados da fila')
      }
      pages.dropDraft(id)
      await flushQueued(ctx)
      // A legacy block signed again leaves the pending list once its ctl was
      // put, never before.
      if (b.op === 'blocked') {
        try {
          if (!(await stillQueued(ctx, d.sealed))) await dropLegacyBlock(ctx, b.peer)
        } catch {
          log('aviso: lista de bloqueios antigos não atualizada')
        }
      }
      return { id: b.id, at: b.at }
    }
    // The page may have blocked the recipient after this draft was made.
    if (!dmFold.canSend({ self: page, peer: b.to, ops: ctx.local.ops() })) throw new UsageError(BLOCKED)
    let entry = d.entry
    if (entry === null) {
      const inner = dm.assembleInner(d.json, signature, expiresAt)
      let sealedTo, sealedSelf
      try {
        sealedTo = dm.sealInner(inner, d.box)
        sealedSelf = dm.sealInner(inner, b4a.toString(e.dmBox.publicKey, 'hex'))
      } catch {
        throw new UsageError(NO_BOX)
      } finally {
        inner.fill(0)
      }
      const stamps = await takeStamps(2)
      if (stamps === null) throw new UsageError(NO_STAMPS)
      entry = {
        key: null,
        id: b.id,
        at: b.at,
        drops: [dropOf(sealedTo, stamps[0]), dropOf(sealedSelf, stamps[1])],
        acked: [false, false],
        row: { t: 'msg', id: b.id, peer: b.to, from: page, text: b.text, replyTo: b.replyTo, fwd: b.fwd, media: null, card: null, at: b.at, mine: true, digest: dm.bodyDigest(b) },
        blobs: [],
        plains: [],
        local: ctx.local
      }
      d.entry = entry
    }
    // The page's queued ops go first, as the own ones do before a dm.set.
    await flushQueued(ctx)
    await deliver(entry)
    pages.dropDraft(id)
    return { id: b.id, at: b.at }
  }

  // A row of the page's history the service held in plaintext: checked with
  // the inner rules (core dm.js innerDigest builds and validates the body:
  // text, media, card, never both, from !== to) and one side is the page.
  function validImportRow (page, r) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return false
    const keys = Object.keys(r)
    if (keys.length !== IMPORT_ROW_KEYS.length || !IMPORT_ROW_KEYS.every((k) => keys.includes(k))) return false
    if (typeof r.id !== 'string' || !/^[0-9a-f]{32}$/.test(r.id) || !Number.isSafeInteger(r.n) || r.n < 0) return false
    if (r.fwd !== 0 && r.fwd !== 1) return false
    if (typeof r.from !== 'string' || typeof r.to !== 'string' || r.from === r.to || (r.from !== page && r.to !== page)) return false
    try {
      dm.innerDigest({ kind: 'msg', id: r.id, from: r.from, to: r.to, text: r.text, replyTo: r.replyTo, media: r.media, card: r.card, fwd: r.fwd, at: r.at, cert: null })
      return true
    } catch {
      return false
    }
  }

  // Whether the ctl sealed as `sealedB64` is still in the page's queue,
  // stamped or not.
  async function stillQueued (ctx, sealedB64) {
    const target = b4a.from(sealedB64, 'base64')
    for (const item of await readQueue(ctx)) {
      if (item === sealedB64) return true
      const drop = dm.decodeDrop(b4a.from(item, 'base64'))
      if (drop !== null && b4a.equals(drop.sealed, target)) return true
    }
    return false
  }

  // kv dmLegacyBlocks: the peers whose legacy block the page key still has
  // to sign again, sealed under the page store's key.
  async function legacyBlocksOf (ctx) {
    const sealed = await store.readPageLegacyBlocks(storage, ctx.prefix)
    if (sealed === null) return []
    const bytes = ctx.local.openBytes(sealed)
    if (bytes === null) return []
    try {
      const v = JSON.parse(b4a.toString(bytes, 'utf8'))
      if (v === null || typeof v !== 'object' || !Array.isArray(v.peers)) return []
      return [...new Set(v.peers.filter((k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)))]
    } catch {
      return []
    } finally {
      wipe(bytes)
    }
  }

  async function writeLegacyBlocks (ctx, peers) {
    if (peers.length === 0) return store.writePageLegacyBlocks(storage, ctx.prefix, null)
    const bytes = b4a.from(JSON.stringify({ peers }), 'utf8')
    try {
      await store.writePageLegacyBlocks(storage, ctx.prefix, ctx.local.sealBytes(bytes))
    } finally {
      wipe(bytes)
    }
  }

  // kv dmLegacyDone: the bundle ids filed here, sealed the same way, so the
  // same bundle fed again (after an uncertain 'dm-legacy-done') never files
  // its ops a second time.
  async function legacyDoneOf (ctx) {
    const sealed = await store.readPageLegacyDone(storage, ctx.prefix)
    if (sealed === null) return []
    const bytes = ctx.local.openBytes(sealed)
    if (bytes === null) return []
    try {
      const v = JSON.parse(b4a.toString(bytes, 'utf8'))
      if (v === null || typeof v !== 'object' || !Array.isArray(v.ids)) return []
      return v.ids.filter((k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k))
    } catch {
      return []
    } finally {
      wipe(bytes)
    }
  }

  async function writeLegacyDone (ctx, ids) {
    const bytes = b4a.from(JSON.stringify({ ids: [...new Set(ids)].slice(-LEGACY_DONE_MAX) }), 'utf8')
    try {
      await store.writePageLegacyDone(storage, ctx.prefix, ctx.local.sealBytes(bytes))
    } finally {
      wipe(bytes)
    }
  }

  async function dropLegacyBlock (ctx, peer) {
    const peers = await legacyBlocksOf(ctx)
    if (peers.includes(peer)) await writeLegacyBlocks(ctx, peers.filter((k) => k !== peer))
  }

  function validImportOp (page, o) {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
    const keys = Object.keys(o)
    return keys.length === 3 && keys.includes('op') && keys.includes('peer') && keys.includes('n') &&
      Number.isSafeInteger(o.n) && o.n >= 0 && dm.DM_OPS.includes(o.op) &&
      typeof o.peer === 'string' && /^[0-9a-f]{64}$/.test(o.peer) && o.peer !== page
  }

  // Whether the parsed bundle's frame is exactly { v: 1, page, box, rows,
  // ops }. Its rows and ops are checked one by one when filed.
  function validBundle (page, v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    const keys = Object.keys(v)
    if (keys.length !== BUNDLE_KEYS.length || !BUNDLE_KEYS.every((k) => keys.includes(k))) return false
    if (v.v !== 1 || v.page !== page || typeof v.box !== 'string' || !/^[0-9a-f]{64}$/.test(v.box)) return false
    return Array.isArray(v.rows) && Array.isArray(v.ops)
  }

  // A legacy op's local id, the same on every retry of the same bundle, so
  // an import repeated after a failure files it once.
  function legacyOpId (bundleId, i) {
    const n = b4a.alloc(4)
    new DataView(n.buffer, n.byteOffset, 4).setUint32(0, i)
    return b4a.toString(hcrypto.hash([LEGACY_OP_DOMAIN, b4a.from(bundleId, 'hex'), n]), 'hex').slice(0, 32)
  }

  // One chunk of the legacy bundle the service sealed to this identity's own
  // dm-key box (docs/rpc.md 5.114), for a page whose secrets are held. Each
  // chunk is kept sealed under the page store's key until all `count` are
  // here; then the bundle is checked (a bad frame refuses it and nothing is
  // filed; a bad row or op is skipped and counted, since the service no
  // longer holds the history to send it again) and filed: rows as legacy
  // rows, seen; ops as local ops
  // only (never put to the pool), in their order; its gen 1 box secret as
  // the page's legacy box; the peers it leaves blocked as the pending list
  // (dm.pageLegacyBlocks). A chunk sealed to another box (after a transfer)
  // answers KEY_MISMATCH and touches nothing.
  //
  // movedFrom: the pages this one moved from, newest first, as the chain of
  // verified page-origin records names them (read by the caller), or null.
  // A bundle carried over on a move names one of them: its rows and ops are
  // filed for this one, and its box becomes the legacy box only when none
  // is held.
  async function pageLegacyChunk ({ page, id, index, count, sealed }, movedFrom = null) {
    requireUnlocked()
    const ctx = await pageCtx(page)
    let plain = null
    try {
      const bytes = b4a.from(sealed, 'base64')
      if (bytes.byteLength > sodium.crypto_box_SEALBYTES + LEGACY_HEADER_BYTES) {
        plain = b4a.alloc(bytes.byteLength - sodium.crypto_box_SEALBYTES)
        if (!sodium.crypto_box_seal_open(plain, bytes, box.publicKey, box.secretKey)) plain = null
      }
    } catch {
      plain = null
    }
    if (plain === null) throw new UsageError(KEY_MISMATCH)
    try {
      const head = new DataView(plain.buffer, plain.byteOffset, LEGACY_HEADER_BYTES)
      if (b4a.toString(plain.subarray(0, 32), 'hex') !== id || head.getUint16(32) !== index || head.getUint16(34) !== count ||
          index >= count || plain.byteLength - LEGACY_HEADER_BYTES > LEGACY_CHUNK_BYTES) throw new UsageError(BAD_ROW)
      const done = await legacyDoneOf(ctx)
      if (done.includes(id)) {
        return { complete: true, added: 0, blocked: (await legacyBlocksOf(ctx)).length, skipped: 0 }
      }
      // A page has one legacy history: another bundle after it is refused.
      if (done.length > 0) throw new UsageError(BAD_ROW)
      let meta = await store.readPageLegacy(storage, ctx.prefix)
      if (meta !== null && meta.id === id && meta.count !== count) throw new UsageError(BAD_ROW)
      if (meta !== null && meta.id !== id) {
        await store.deletePageLegacyChunks(storage, ctx.prefix)
        meta = null
      }
      if (meta === null) {
        meta = { id, count, have: [], horizon: legacyHorizon(ctx.local) }
        await store.writePageLegacy(storage, ctx.prefix, meta)
      }
      if (!meta.have.includes(index)) {
        await store.writePageLegacyChunk(storage, ctx.prefix, index, ctx.local.sealBytes(plain.subarray(LEGACY_HEADER_BYTES)))
        meta = { ...meta, have: [...meta.have, index] }
        await store.writePageLegacy(storage, ctx.prefix, meta)
      }
      if (meta.have.length < count) return { complete: false, added: 0, blocked: 0, skipped: 0 }
    } finally {
      wipe(plain)
    }
    return fileLegacyBundle(page, ctx, id, count, movedFrom)
  }

  // The filing time the legacy items go below: older than every row the page
  // store held when the bundle began, so a legacy op never reaches a message
  // pulled since. Kept with the chunks, the same on every retry.
  function legacyHorizon (lc) {
    const { messages, ops } = lc.snapshot()
    let min = lc.nextFiled()
    for (const r of [...messages, ...ops]) if (Number.isFinite(r.filedAt) && r.filedAt < min) min = r.filedAt
    return min
  }

  async function fileLegacyBundle (page, ctx, id, count, movedFrom) {
    const parts = []
    let bundle
    try {
      for (let i = 0; i < count; i++) {
        const s = await store.readPageLegacyChunk(storage, ctx.prefix, i)
        const part = s === null ? null : ctx.local.openBytes(s)
        if (part === null) {
          // A stored chunk that no longer opens is asked for again.
          const meta = await store.readPageLegacy(storage, ctx.prefix)
          if (meta !== null) await store.writePageLegacy(storage, ctx.prefix, { ...meta, have: meta.have.filter((x) => x !== i) })
          throw new UsageError(BAD_ROW)
        }
        parts.push(part)
      }
      try {
        bundle = JSON.parse(b4a.toString(b4a.concat(parts), 'utf8'))
      } catch {
        throw new UsageError(BAD_ROW)
      }
    } finally {
      parts.forEach(wipe)
    }
    const before = (Array.isArray(movedFrom) ? movedFrom : [movedFrom])
      .filter((k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k) && k !== page)
    if (!validBundle(page, bundle) && !before.some((k) => validBundle(k, bundle))) throw new UsageError(BAD_ROW)
    const carried = bundle.page !== page
    const secret = b4a.from(bundle.box, 'hex')
    try {
      // Another legacy box held already: nothing of this bundle is filed.
      const held = pages.legacyMatches(page, secret)
      if (!carried && held === false) throw new UsageError(BAD_ROW)
      return await fileLegacyItems(page, ctx, id, bundle, secret, !carried || held === null)
    } finally {
      wipe(secret)
    }
  }

  async function fileLegacyItems (page, ctx, id, bundle, secret, adoptBox) {
    const meta = await store.readPageLegacy(storage, ctx.prefix)
    const horizon = meta !== null && meta.id === id && meta.horizon !== null ? meta.horizon : legacyHorizon(ctx.local)
    // Each valid item once per filing position (a repeated n skips the later
    // item), then everything in n order, so a deleted op hides only the rows
    // filed before it. An op keeps its bundle index (its local id).
    const items = []
    const taken = new Set()
    let skipped = 0
    const take = (item, ok) => {
      if (!ok || taken.has(item.n)) {
        skipped++
        return
      }
      taken.add(item.n)
      items.push(item)
    }
    // A carried bundle's page side is this page now.
    const src = bundle.page
    const carry = (r) => src === page || r === null || typeof r !== 'object' || Array.isArray(r)
      ? r
      : { ...r, from: r.from === src ? page : r.from, to: r.to === src ? page : r.to }
    for (const r of bundle.rows) {
      const c = carry(r)
      take({ n: r && r.n, r: c }, validImportRow(page, c))
    }
    bundle.ops.forEach((o, i) => take({ n: o && o.n, o, i }, validImportOp(page, o) && o.peer !== src))
    items.sort((x, y) => x.n - y.n)
    const rows = items.filter((x) => x.r !== undefined).map((x) => x.r)
    const goodOps = items.filter((x) => x.o !== undefined)
    const lc = ctx.local
    const out = []
    const ops = []
    const at = nowIso()
    for (let pos = 0; pos < items.length; pos++) {
      const item = items[pos]
      // Below the horizon in n order, the same values on every retry.
      const filedAt = horizon - items.length + pos
      if (item.o !== undefined) {
        const oid = legacyOpId(id, item.i)
        if (!lc.hasOp(oid)) ops.push({ t: 'ctl', id: oid, op: item.o.op, peer: item.o.peer, at, filedAt })
        continue
      }
      const r = item.r
      if (lc.hasMessage(r.from, r.id) || out.some((x) => x.from === r.from && x.id === r.id)) continue
      const mine = r.from === page
      out.push({
        t: 'msg',
        id: r.id,
        peer: mine ? r.to : r.from,
        from: r.from,
        text: r.text,
        replyTo: r.replyTo,
        fwd: r.fwd,
        media: r.media === null ? null : r.media.map(mediaItem),
        card: r.card === null ? null : copyLinkCard(r.card, mediaItem),
        at: r.at,
        mine,
        legacy: true,
        filedAt
      })
    }
    if (out.length > 0 || ops.length > 0) {
      try {
        await lc.append([...out, ...ops].sort((x, y) => x.filedAt - y.filedAt))
      } catch (err) {
        if (err instanceof TypeError) throw new UsageError(BAD_ROW)
        throw err
      }
    }
    // Every row of the bundle now in the store, filed by this call or by an
    // earlier one that failed after it: a retry still marks it seen.
    const seenIds = rows.filter((r) => r.from !== page && lc.hasMessage(r.from, r.id)).map((r) => lc.seenToken(dmFold.seenKey(r.from, r.id)))
    if (seenIds.length > 0) await store.writeDmSeen(storage, [...await store.readDmSeen(storage, ctx.prefix), ...seenIds], ctx.prefix)
    if (adoptBox && await pages.setLegacy(page, secret, src)) {
      // The page scans the pool again, so drops sealed to the legacy box open.
      pageEpochs.set(page, (pageEpochs.get(page) || 0) + 1)
      const e = pages.need(page)
      await store.writePageCursor(storage, ctx.prefix, { after: 0, gen: e.gen, set: boxSetOf(e) })
    }
    // The newest block-class op per peer decides.
    const last = new Map()
    for (const { o } of goodOps) if (o.op === 'blocked' || o.op === 'unblocked') last.set(o.peer, o.op)
    const blocked = [...last].filter(([, op]) => op === 'blocked').map(([peer]) => peer)
    const pending = [...new Set([...await legacyBlocksOf(ctx), ...blocked])]
    await writeLegacyBlocks(ctx, pending)
    await writeLegacyDone(ctx, [...await legacyDoneOf(ctx), id])
    await store.deletePageLegacyChunks(storage, ctx.prefix)
    if (out.length > 0 || ops.length > 0) emit('dm.changed', { added: out.length, page })
    return { complete: true, added: out.length, blocked: pending.length, skipped }
  }

  // -> { pending: [peer] }: the legacy blocks still to sign again.
  async function pageLegacyBlocks ({ page }) {
    requireUnlocked()
    const ctx = await pageCtx(page)
    return { pending: await legacyBlocksOf(ctx) }
  }

  // The page is marked first: a pull under way stops writing for it and no
  // new one opens its store again. The history goes before the secrets and
  // the registry entry, so a failure in between leaves a page still listed
  // for the next try.
  async function pageForget ({ page }) {
    requireUnlocked()
    forgetting.add(page)
    pageEpochs.set(page, (pageEpochs.get(page) || 0) + 1)
    try {
      const s = pageStores.get(page)
      pageStores.delete(page)
      if (s !== undefined) {
        foldMemo.delete(s.local)
        try { await s.ready } catch {}
        s.local.lock()
        await s.local.idle()
      }
      await storage.writeJson(store.pageDmPrefix(page) + 'dmSummary', null)
      await store.deletePageDm(storage, page)
      await pages.forget(page)
      await store.forgetPageStore(storage, page)
    } finally {
      forgetting.delete(page)
    }
    return { ok: true }
  }

  async function close () {
    lock()
    await idle()
    await local.close()
  }

  const tracked = (fn) => (...args) => track(fn(...args))

  return {
    unlock,
    lock,
    unlocked,
    keyReady,
    loaded,
    listReady,
    listLoaded,
    idle,
    boxHex,
    openTestimonial,
    checkSend,
    list,
    thread,
    seen: tracked(seen),
    send: tracked(send),
    react: tracked(react),
    putMedia: tracked(putMedia),
    readMedia: tracked(readMedia),
    putPublicMedia: tracked(putPublicMedia),
    isOwnPublicItem,
    forgetPublicItem,
    readPublicMedia,
    wipeMedia,
    dropPageSummaries,
    set: tracked(set),
    pull: tracked(pull),
    pageGenerate,
    pageShare,
    pageSecrets: tracked(pageSecrets),
    pageDraft: tracked(pageDraft),
    pageSend: tracked(pageSend),
    pageLegacyChunk: tracked(pageLegacyChunk),
    pageLegacyBlocks: tracked(pageLegacyBlocks),
    pageForget: tracked(pageForget),
    groupBoxOf: (page) => pages.groupBoxOf(page),
    heldPageBoxes,
    holdsPage: (page) => pages.get(page) !== null,
    setPageMismatch,
    topUp,
    walletSize,
    close,
    get pulling () { return pulling },
    // Tests: how many stores have a remembered fold.
    get foldMemoSize () { return foldMemo.size }
  }
}

module.exports = {
  createDmEngine,
  SELF_SEND,
  BLOCKED,
  NO_BOX,
  NO_STAMPS,
  BAD_REPLY,
  TOO_LONG,
  PULL_BUSY,
  UNCONFIRMED,
  NO_CERT,
  BAD_MEDIA,
  MEDIA_GONE,
  MEDIA_STALE,
  UPLOAD_FAILED,
  MOMENT_PHOTO_GONE,
  BLOBS_MAX,
  NO_PAGE_KEY,
  KEY_MISMATCH,
  USE_PAGE_DRAFT,
  DRAFT_GONE,
  BAD_ROW,
  voiceMs
}
