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
// Nothing here logs a key, a text or a peer.
const b4a = require('b4a')
const dm = require('@varanda/core/lib/dm')
const dmFold = require('@varanda/core/lib/dm-fold')
const postage = require('@varanda/core/lib/dm-postage')
const { nowIso, MAX_AUDIO_BYTES } = require('@varanda/core/lib/records')
const { UsageError } = require('@varanda/core/lib/errors')
const { certForKey } = require('@varanda/core/lib/cert')
const { verifySnapshot, blockedSet, revokedIssuerSet } = require('@varanda/core/lib/blocklist')
const { mediaBounds, audioBounds, dmTextBytes, DM_MEDIA_KEYS, AUDIO_MS_TOLERANCE } = require('@varanda/rpc')
const { sealBlob, createBlobClient, fetchBlob } = require('./blob')
const sodium = require('./sodium-browser')
const { dmBoxKeyPairFromPrf, dmLocalKeyFromPrf } = require('./passkey')
const { createDmStore } = require('./dm-store')
const { openDmLink, openStampLink } = require('./dm-link')
const store = require('./node-store')

const LOCKED = store.LOCKED
const SELF_SEND = 'não é possível enviar para si'
const BLOCKED = 'você bloqueou esta pessoa'
const NO_BOX = 'esta pessoa ainda não recebe mensagens'
const NO_STAMPS = 'o limite de envio de hoje acabou'
const BAD_REPLY = 'responda uma mensagem desta conversa'
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
// (./blob.js fetchBlob limits).
// createStore, fetch and mediaOrigin: tests only.
function createDmEngine ({ storage, association, seederUrl, createSocket, log = noop, emit = noop, limits = {}, createStore = createDmStore, fetch: fetchImpl, mediaOrigin } = {}) {
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
    ...(limits || {})
  }
  const local = createStore({ storage, cacheBytesMax: L.cacheBytesMax })
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
  // Lazy opens queued or in flight, by sender and message id -> { p, job },
  // and messages whose blob is gone (this unlock only).
  const opening = new Map()
  const gone = new Set()
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
      const data = await store.readBlocklist(storage)
      const snapshot = data === null ? null : data.snapshot
      if (snapshot !== null && verifySnapshot(snapshot, association).ok) {
        return { blocked: blockedSet(snapshot), revokedIssuers: revokedIssuerSet(snapshot) }
      }
    } catch {}
    return { blocked: new Set(), revokedIssuers: new Set() }
  }

  // Any throw leaves no key material behind: the derived pair and key are
  // zeroed and the store locked.
  async function unlock (prf) {
    const gen = ++generation
    let pair = null
    let key = null
    let installed = false
    try {
      const kv = await store.readDmKey(storage)
      const g = kv === null ? 1 : kv.gen
      pair = await dmBoxKeyPairFromPrf(prf, g)
      key = await dmLocalKeyFromPrf(prf)
      if (gen !== generation) return
      await local.unlock(key)
      if (gen !== generation) {
        local.lock()
        return
      }
      zeroPair(box)
      box = { publicKey: pair.publicKey, secretKey: pair.secretKey, gen: g }
      installed = true
    } catch (err) {
      if (gen === generation) local.lock()
      throw err
    } finally {
      if (key !== null) key.fill(0)
      if (!installed) zeroPair(pair)
    }
    // Ctls left from before go out now (a stamped one needs no new stamp).
    if ((await store.readDmCtlQueue(storage)).length > 0) track(flushQueued())
  }

  function lock () {
    generation++
    zeroPair(box)
    box = null
    ownCert = null
    local.lock()
    clearPending()
    forgetAllBlobs()
    dropQueued(false, LOCKED)
    opening.clear()
    gone.clear()
  }

  // Lock, sign-out and reset: the plaintext cache goes too (needs no key).
  function wipeMedia () {
    forgetAllBlobs()
    dropQueued(false, LOCKED)
    opening.clear()
    gone.clear()
    return track(local.wipeCache())
  }

  function unlocked () {
    return box !== null && local.unlocked()
  }

  function requireUnlocked () {
    if (!unlocked()) throw new UsageError(LOCKED)
  }

  function boxHex () {
    requireUnlocked()
    return { box: b4a.toString(box.publicKey, 'hex'), gen: box.gen }
  }

  // ---- folders ----

  async function folded (own) {
    const follows = (await store.readFollows(storage)).map((f) => typeof f === 'string' ? f : f && f.key).filter((k) => typeof k === 'string')
    const stored = new Set(await store.readDmSeen(storage))
    const { messages, ops } = local.snapshot()
    const seen = []
    for (const m of messages) {
      if (m.mine) continue
      const k = dmFold.seenKey(m.from, m.id)
      if (stored.has(local.seenToken(k))) seen.push(k)
    }
    return dmFold.fold({
      self: own,
      followSet: follows,
      seen,
      ops,
      messages: messages.map((m) => ({ id: m.id, from: m.from, to: m.mine ? m.peer : own, text: m.text, replyTo: m.replyTo, media: m.media, at: m.at, filedAt: m.filedAt }))
    })
  }

  // Order and cursor are the fold's: `at` is the effective time it returns
  // (never re-sorted here by the sender's time).
  async function list (own, { folder = 'inbox', limit = 30, before } = {}) {
    requireUnlocked()
    const { inbox, requests } = await folded(own)
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

  async function threadOf (own, peer) {
    const { inbox, requests } = await folded(own)
    return inbox.find((c) => c.peer === peer) || requests.find((c) => c.peer === peer) || null
  }

  // The thread's own state, so the app never guesses it from a list page:
  // its folder from the same fold as dm.list (a request holds a kept peer
  // message, no own one, and the peer is neither followed nor accepted), and
  // whether the newest block op for the peer is 'blocked' (dm-fold canSend).
  // A thread with no kept message is 'inbox': a conversation the person may
  // start.
  function threadState (own, peer, c) {
    const blocked = !dmFold.canSend({ self: own, peer, ops: local.snapshot().ops })
    return { folder: c === null ? 'inbox' : c.folder, blocked }
  }

  async function thread (own, { peer, before, limit = 30 }) {
    requireUnlocked()
    const c = await threadOf(own, peer)
    const state = threadState(own, peer, c)
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
    const page = c.messages.slice(start, end)
    // Another page: what an earlier one queued and did not start is dropped.
    dropQueued(true, OPEN_DROPPED)
    // A request is a peer the person neither follows nor accepted: nothing
    // of theirs is fetched until a tap or an accept.
    const auto = c.folder !== 'request'
    return {
      messages: page.map((m) => ({ id: m.id, from: m.from, text: m.text, replyTo: m.replyTo, at: m.at, mine: m.mine, media: mediaView(m, auto) })),
      next: start > 0 && page.length > 0 ? page[0].id : null,
      ...state
    }
  }

  // ---- media ----

  function openKey (from, id) {
    return from + '\n' + id
  }

  // A thread row's media: the items (cached, or opening in the background
  // now when `auto`), or { unavailable: true } when the blob is gone and
  // nothing is cached. Copies: the caller may hand them out.
  function mediaView (m, auto) {
    if (!Array.isArray(m.media)) return null
    if (local.hasMedia(m.from, m.id)) return m.media.map(mediaItem)
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
        for (const d of m.media) {
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
        !Number.isSafeInteger(index) || index < 0 || index >= dm.DM_MEDIA_MAX) {
      throw new TypeError('parâmetros inválidos')
    }
    const m = await keptMessage(own, from, id)
    if (m === null || !Array.isArray(m.media) || index >= m.media.length) throw new UsageError(MEDIA_GONE)
    const mime = m.media[index].mime
    if (local.hasMedia(from, id)) {
      const items = await local.getMedia(from, id)
      if (items !== null && gen !== generation) {
        items.forEach(wipe)
        throw new UsageError(LOCKED)
      }
      if (items !== null && items.length === m.media.length) {
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
  async function putMedia (own, keyPair, { bytes, mime, width, height, ms }) {
    requireUnlocked()
    const gen = generation
    const voice = mime === dm.DM_AUDIO_MIME
    let ok = false
    if (bytes instanceof Uint8Array && voice) {
      const given = ms === undefined || (Number.isInteger(ms) && ms >= 1 && ms <= dm.DM_AUDIO_MAX_MS)
      ms = given && width === 0 && height === 0 ? voiceMs(bytes, ms) : null
      ok = ms !== null
    } else if (bytes instanceof Uint8Array) {
      ok = dm.DM_MEDIA_MIMES.includes(mime) && (ms === undefined || ms === 0) && mediaBounds(bytes, mime) !== null
      ms = 0
    }
    if (!ok) {
      if (bytes instanceof Uint8Array) wipe(bytes)
      throw new UsageError(BAD_MEDIA)
    }
    const plain = new Uint8Array(bytes)
    wipe(bytes)
    const hash = [sha256Hex(plain), mime, width, height, ms].join('\n')
    let entry = sealedByPlain.get(hash)
    if (entry === undefined || entry.plain === null) {
      let sealed
      try {
        sealed = sealBlob(plain)
      } catch (err) {
        wipe(plain)
        throw err
      }
      entry = { sealed, mime, w: width, h: height, ms, plain, hash, lock: Promise.resolve() }
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
  // answered in this unlock.
  function entryOfItem (item) {
    const entry = sealedById.get(item.id)
    if (entry === undefined || entry.plain === null) throw new UsageError(MEDIA_STALE)
    const want = itemOf(entry)
    if (!DM_MEDIA_KEYS.every((k) => want[k] === item[k])) throw new UsageError(MEDIA_STALE)
    return entry
  }

  async function seen (own, peer) {
    requireUnlocked()
    const c = await threadOf(own, peer)
    if (c === null) return { ok: true }
    const ids = c.messages.filter((m) => !m.mine).map((m) => local.seenToken(dmFold.seenKey(m.from, m.id)))
    if (ids.length > 0) await store.writeDmSeen(storage, [...await store.readDmSeen(storage), ...ids])
    return { ok: true }
  }

  function canSend (own, peer) {
    return dmFold.canSend({ self: own, peer, ops: local.snapshot().ops })
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
  async function readQueue () {
    const out = []
    for (const item of await store.readDmCtlQueue(storage)) {
      const v = local.open(item)
      if (v !== null && typeof v.b === 'string') out.push(v.b)
    }
    return out
  }

  function writeQueue (list) {
    return store.writeDmCtlQueue(storage, list.map((b) => local.seal({ b })))
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
    if (!local.hasMessage(entry.row.from, entry.row.id)) await local.append([{ ...entry.row, filedAt: local.nextFiled() }])
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
  async function flushQueued () {
    try {
      await withQueue(flushCtlQueue)
    } catch {}
    try {
      if ((await store.readDmCtlQueue(storage)).length > 0) log('aviso: estado da conversa ainda não enviado aos seus outros aparelhos')
    } catch {}
  }

  // Inside withQueue: puts the queued ctls, oldest first. A sealed item is
  // stamped and its drop bytes written back to the queue before the put; it
  // stops at the first one that cannot go (no stamp, full pool, rate, lost
  // link) and keeps it. A refused drop (invalido) is removed with a warning.
  async function flushCtlQueue () {
    if (!unlocked()) return
    let queue = await readQueue()
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
          await writeQueue(queue)
        }
        if (link === null) link = await openDmLink(linkOpts)
        emit('dm.sending', {})
        const r = await link.put(bytes)
        if (!r.ok && r.reason !== 'invalido') return
        if (!r.ok) log('aviso: 1 estado de conversa recusado pelo semeador')
        queue = queue.slice(1)
        await writeQueue(queue)
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
  async function send (own, keyPair, { to, text, replyTo = null, media = null }, recipientBox) {
    checkSend(own, to)
    const items = Array.isArray(media) && media.length > 0 ? media.map(mediaItem) : null
    const key = to + '\n' + (replyTo || '') + '\n' + text + '\n' + (items === null ? '' : JSON.stringify(items))
    let entry = pending.get(key)
    if (entry === undefined) {
      const sealedBlobs = items === null ? [] : items.map(entryOfItem)
      // Copied before any await: an overlapping send of the same blob may
      // forget (and wipe) the shared entry meanwhile.
      const plains = sealedBlobs.map((b) => new Uint8Array(b.plain))
      entry = await newEntry(own, keyPair, { to, text, replyTo, items, key }, recipientBox, sealedBlobs, plains).catch((err) => {
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
  async function newEntry (own, keyPair, { to, text, replyTo, items, key }, recipientBox, sealedBlobs, plains) {
    if (recipientBox === null) throw new UsageError(NO_BOX)
    if (replyTo !== null) {
      const c = await threadOf(own, to)
      if (c === null || dmFold.replyTarget(c.messages, replyTo) === null) throw new UsageError(BAD_REPLY)
    }
    const id = dm.newMessageId()
    const at = nowIso()
    const cert = await certOf(own)
    if (items !== null && dmTextBytes(text) > dm.textBudget({ kind: 'msg', id, from: own, to, replyTo, media: items, at, cert })) {
      throw new UsageError(TOO_LONG)
    }
    // Every chunk acked before any drop is stamped or put.
    const gen = generation
    for (const b of sealedBlobs) await upload(b, keyPair)
    if (gen !== generation) throw new UsageError(LOCKED)
    let inner
    try {
      inner = dm.buildInner({ kind: 'msg', id, at, to, text, replyTo, cert, ...(items === null ? {} : { media: items }) }, keyPair)
    } catch (err) {
      throw new UsageError(err && err.message === TOO_LONG ? TOO_LONG : BAD_TEXT)
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
      row: { t: 'msg', id, peer: to, from: own, text, replyTo, media: items, at, mine: true },
      blobs: sealedBlobs,
      plains
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
    try {
      try {
        link = await openDmLink(linkOpts)
      } catch (err) {
        if (err instanceof UsageError) throw err
        throw new UsageError('sem conexão com o semeador')
      }
      let read = 0
      for (;;) {
        if (gen !== generation) throw new UsageError(LOCKED)
        const page = await link.page({ after: cursor, limit: L.pageMax })
        const rows = []
        const ops = local.snapshot().ops
        const mod = await moderation()
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
        if (page.items.length > 0) {
          cursor = page.items[page.items.length - 1].seq
          await store.writeDmCursor(storage, cursor)
        }
        if (page.next === null || page.items.length === 0) break
        if (read >= L.budgetBytes) {
          incomplete = true
          break
        }
      }
    } finally {
      pulling = false
      if (link !== null) link.close()
      if (added > 0 || applied > 0) emit('dm.changed', { added })
    }
    return { added, cursor, incomplete }
  }

  // One pool item -> a row to file, or null (not ours, uncertified, known,
  // blocked here or by the association).
  function openItem (own, bytes, ops, batch, mod) {
    const drop = dm.decodeDrop(bytes)
    if (drop === null) return null
    const inner = dm.openSealed(drop.sealed, box)
    if (inner === null) return null
    const body = dm.openInner(inner, own, { association, revokedIssuers: mod.revokedIssuers })
    if (body === null) return null
    if (body.kind === 'msg' && !body.mine && mod.blocked.has(body.from)) return null
    if (body.kind === 'ctl') {
      if (local.hasOp(body.id) || batch.some((r) => r.t === 'ctl' && r.id === body.id)) return null
      return { t: 'ctl', id: body.id, op: body.op, peer: body.peer, at: body.at }
    }
    const peer = body.mine ? body.to : body.from
    if (local.hasMessage(body.from, body.id) || batch.some((r) => r.t === 'msg' && r.from === body.from && r.id === body.id)) return null
    // A blocked sender's messages are dropped once they open.
    if (!body.mine && !dmFold.canSend({ self: own, peer, ops })) return null
    return { t: 'msg', id: body.id, peer, from: body.from, text: body.text, replyTo: body.replyTo, media: Array.isArray(body.media) ? body.media.map(mediaItem) : null, at: body.at, mine: body.mine }
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
    idle,
    boxHex,
    checkSend,
    list,
    thread,
    seen: tracked(seen),
    send: tracked(send),
    putMedia: tracked(putMedia),
    readMedia: tracked(readMedia),
    wipeMedia,
    set: tracked(set),
    pull: tracked(pull),
    topUp,
    walletSize,
    close,
    get pulling () { return pulling }
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
  BLOBS_MAX,
  voiceMs
}
