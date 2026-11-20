'use strict'

// Blobs in the browser node (docs/protocol.md section 13, @varanda/core
// lib/blob.js): the media a direct message carries, sealed here and stored as
// stamped chunks in the seeder's blob pool.
//
// - sealBlob(plain): secretbox under a fresh random key and nonce, cut into
//   BLOB_CHUNK_BYTES pieces (encodeChunk zero-pads the last). The key buffer
//   is wiped once the descriptor holds its hex; the descriptor only ever
//   travels inside a sealed DM.
// - createBlobClient() keeps a blob stamp wallet in kv blobStamps (each
//   { token, sig } sealed under the caller's local key, as the DM wallet in
//   ./dm.js): stamps on random tokens (dm-postage.js newToken(n, 'blob')),
//   bought ahead over the identified stamp link (kind 'blob') by topUp, on
//   the caller's schedule, and spent on any chunk later. Only the current
//   and the previous blob kid are usable, and a key counts as current only
//   once a stamp under it verified. A top-up whose stamp link closes (its
//   deadline included) after buying something goes on over a new link.
// - createBlobClient().stamp(sealed, keyPair): takes every stamp the blob
//   still needs from the wallet at once (all or none) and builds its frames.
//   With enough stamps in the wallet, nothing is issued around the send. A
//   short wallet forces one top-up and waits for it, buying only what the
//   send lacks plus FORCE_MARGIN (never more than a fill would): only that
//   shortfall puts stamp issuance right next to a put, the residual timing
//   link between the diary on the stamp link and the anonymous chunks. A
//   caller avoids it by watching walletSize and calling topUp early, which
//   fills to BLOB_STAMP_WALLET. Stamped frames stay in the sealed object, in
//   memory only. A full wallet still asks the seeder for its current blob key
//   once every KEY_CHECK_MS: a rotated key buys at least one stamp under it,
//   so the stamps outside the new current and previous pair stop counting.
//   When the key was last seen current more than ROTATION_MS ago (kv
//   blobKeyCheck, a bare time), the seeder may have rotated twice since, so
//   adopting a new kid keeps no stamp under any other kid: the old current
//   kid is then not the seeder's previous one.
// - createBlobClient().put(sealed): every frame of the blob, in order, over a
//   fresh anonymous blob link, each waiting for its ack; it resolves only when
//   every frame was acked in this call (an ack does not say the blob is
//   complete, so a frame acked before is sent again). The node never repeats
//   a put by itself: a lost ack is an uncertain failure, and only the user's
//   retry puts the SAME frames again (the pool answers an identical stored
//   frame as a repeated success), spending no new stamp. A frame the pool
//   refuses as 'invalido' (a spent token once its partial blob was swept, a
//   stamp under a dropped key) is cleared, so the next send stamps it again;
//   a blob swept after part of it was put is then stored anew.
// - createBlobClient().copySource(keyPair): the stamps of a history copy,
//   bought in memory over the stamp link (kind 'copy'), for stamp(sealed,
//   keyPair, source) and send(sealed, keyPair, source); see its comment.
// - fetchBlob(descriptor, seederHttpOrigin): GET /blob/<id>/<index> from the
//   seeder origin only, credentials omitted and redirects refused; every
//   frame decoded and checked against the descriptor, the whole ciphertext's
//   sha256 checked BEFORE opening, the plaintext length and media bounds
//   checked after (decided by the bytes: anything with an image signature
//   must pass mediaBounds whatever mime the sender named). A body is never
//   buffered past BLOB_FRAME_BYTES. Returns bytes in memory, never a remote URL. The GETs are
//   paced (GET_BURST, then one every GET_PACE_MS) under the seeder's shared
//   /media budget, at most GET_WINDOW of them in flight, launched in chunk
//   order; the first failure launches no further chunk and, once the ones in
//   flight settle, the lowest failing chunk's error is thrown (a chunk above
//   a failed one gives up its retries at once and its GET in flight is
//   aborted). A 429 or 503
//   on a read waits its Retry-After (at most RETRY_AFTER_MAX_MS,
//   RETRY_DEFAULT_MS without one) and retries that chunk at most
//   GET_RETRIES times; any other failure, a 404 included, is a normal error
//   at once. Only these reads are ever retried, never a put. Each GET
//   attempt, headers and body together, ends after GET_TIMEOUT_MS as a
//   transient failure (NO_SEEDER), not retried here.
//   The GETs bypass the HTTP cache (cache: 'no-store'): the caller's sealed
//   plaintext cache is the only local copy, and ciphertext must not sit in
//   the browser's cache for the pool's 14 days.
//
// Nothing here logs a key, an id, a token or an address.
const b4a = require('b4a')
const sodium = require('./sodium-browser')
const blob = require('@varanda/core/lib/blob')
const postage = require('@varanda/core/lib/dm-postage')
const { MEDIA_BLOCK_BYTES, MAX_MEDIA_ITEM_BLOCKS } = require('@varanda/core/lib/records')
const { UsageError } = require('@varanda/core/lib/errors')
const { mediaBounds } = require('@varanda/rpc')
const { openBlobLink, openStampLink, NO_SEEDER } = require('./dm-link')
const store = require('./node-store')

const { BLOB_CHUNK_BYTES, BLOB_FRAME_BYTES, BLOB_MAC_BYTES } = blob
const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES
const BLOB_MAX_PLAIN = MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES
const BLOB_STAMP_LINK_DEADLINE_MS = 180000
// A chat photo is up to about 33 chunks and a voice note up to about 48;
// one item of BLOB_MAX_CHUNKS (257) must fit in a full wallet.
const BLOB_STAMP_WALLET = 300
const BLOB_STAMP_WALLET_LOW = 150
const TOP_UP_EVERY_MS = 600000
// A failed top-up is tried again after this, not after TOP_UP_EVERY_MS.
const TOP_UP_RETRY_MS = 60000
// The seeder rotates its blob key about every 7 days and accepts the current
// and the previous kid; a full wallet checks the key this often.
const KEY_CHECK_MS = 12 * 3600000
const ROTATION_MS = 7 * 24 * 3600000
// The seeder's blob issue bucket is 32 at 4/s and its put bucket 32 at 8/s;
// past a little less than each burst the client paces itself under the rate.
const ISSUE_BURST = 28
const ISSUE_PACE_MS = 270
const PUT_BURST = 28
const PUT_PACE_MS = 135
// A forced top-up at send time buys the shortfall plus this many stamps; the
// background topUp fills the rest of the wallet later.
const FORCE_MARGIN = 8
// A history copy buys its stamps this many at a time over one stamp link.
const COPY_BATCH = 32
// reserve() asks for the text's stamps in batches of this many, so the caller
// can check the unlock and show progress between them.
const COPY_RESERVE_CHUNK = 256
// The seeder's /blob route shares the /media bucket (128 at 64/s, for every
// client); a download stays well under it.
const GET_BURST = 32
const GET_PACE_MS = 63
// One GET at a time paid a full round trip per 32 KiB chunk. The seeder
// answers at most 16 /media responses at once (VARANDA_MEDIA_MAX_IN_FLIGHT,
// docs/seeder-capacity.md) for every client together, so a download keeps
// only 4 in flight: most of the round-trip saving, without one reader
// filling the seeder's slots.
const GET_WINDOW = 4
const GET_RETRIES = 3
const RETRY_AFTER_MAX_MS = 10000
const RETRY_DEFAULT_MS = 1000
// A GET that answered but never finished its body would otherwise hold its
// cipher buffer and connection forever; 30 s matches the native fetch
// (apps/app/worklet/bare-fetch.js), counted over the headers and the body.
const GET_TIMEOUT_MS = 30000
// setTimeout fires at once past this, which would fail every GET.
const MAX_TIMER_MS = 2147483647

const TOO_BIG = 'mídia grande demais'
const BAD_MEDIA = 'mídia inválida'
const NO_STAMPS = 'o limite de envio de mídia de hoje acabou'
const STAMP_FAILED = 'não deu para preparar o envio da mídia'
const UNCONFIRMED = 'não deu para confirmar o envio da mídia'
const NO_COPY_STAMPS = 'o limite semanal de cópia de conversas acabou'
const NO_COPY_ALLOWANCE = 'o semeador não oferece a cópia de conversas'
const SEEDER_FULL = 'o semeador está cheio: tente mais tarde'
const SEEDER_RATE = 'muitos envios seguidos: aguarde um pouco'
const REFUSED = 'mídia recusada pelo semeador'
const NOT_FOUND = 'mídia indisponível'
const BAD_ORIGIN = 'endereço do semeador inválido'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function noop () {}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unconfirmed () {
  const err = new UsageError(UNCONFIRMED)
  err.uncertain = true
  return err
}

// `reason` is the seeder's word, kept so a caller can tell a refused stamp
// ('invalido') from the rest.
function refusal (reason) {
  const err = new UsageError(reason === 'cheio' ? SEEDER_FULL : reason === 'ritmo' ? SEEDER_RATE : REFUSED)
  err.reason = reason
  return err
}

function sha256 (bytes) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, bytes)
  return out
}

function wipe (buf) {
  if (buf instanceof Uint8Array) sodium.sodium_memzero(buf)
}

function isSealed (sealed) {
  return sealed !== null && typeof sealed === 'object' && blob.validateBlobDescriptor(sealed.descriptor) &&
    sealed.id instanceof Uint8Array && sealed.cipher instanceof Uint8Array &&
    Array.isArray(sealed.frames) && Array.isArray(sealed.acked) &&
    sealed.frames.length === sealed.descriptor.chunks && sealed.acked.length === sealed.descriptor.chunks
}

// The ciphertext bytes of chunk i, unpadded.
function piece (cipher, i) {
  return cipher.subarray(i * BLOB_CHUNK_BYTES, Math.min(cipher.byteLength, (i + 1) * BLOB_CHUNK_BYTES))
}

// plain: 1 to BLOB_MAX_PLAIN bytes. Returns the sealed blob: { id,
// descriptor: { id, key, nonce, chunks, bytes, sha256 }, cipher, frames,
// acked }. The caller keeps it in memory for put and for a user's retry.
function sealBlob (plain) {
  if (!(plain instanceof Uint8Array) || plain.byteLength < 1) throw new TypeError('plain must be a non-empty Uint8Array')
  if (plain.byteLength > BLOB_MAX_PLAIN) throw new UsageError(TOO_BIG)
  const key = b4a.alloc(KEY_BYTES)
  const nonce = b4a.alloc(NONCE_BYTES)
  const cipher = b4a.alloc(plain.byteLength + BLOB_MAC_BYTES)
  let keyHex
  try {
    sodium.randombytes_buf(key)
    sodium.randombytes_buf(nonce)
    sodium.crypto_secretbox_easy(cipher, plain, nonce, key)
    keyHex = b4a.toString(key, 'hex')
  } finally {
    wipe(key)
  }
  const id = blob.newBlobId()
  const chunks = Math.ceil(cipher.byteLength / BLOB_CHUNK_BYTES)
  const descriptor = {
    id: b4a.toString(id, 'hex'),
    key: keyHex,
    nonce: b4a.toString(nonce, 'hex'),
    chunks,
    bytes: cipher.byteLength,
    sha256: b4a.toString(sha256(cipher), 'hex')
  }
  return { id, descriptor, cipher, frames: new Array(chunks).fill(null), acked: new Array(chunks).fill(false) }
}

// storage: the node kv (kv blobStamps). seal(value) -> { nonce, box } and
// open({ nonce, box }) -> value or null: the caller's local key, as the DM
// wallet uses it (./dm-store.js); both may throw while locked.
// limits (tests): wallet, walletLow, issueBurst, issuePaceMs, topUpEveryMs,
// topUpRetryMs, keyCheckMs, rotationMs, putBurst, putPaceMs, forceMargin, copyBatch,
// copyReserveChunk, link (dm-link limits). stampDiary: as ./dm.js's.
function createBlobClient ({ seederUrl, createSocket, association, storage, seal, open, log = noop, limits = {}, stampDiary = () => null } = {}) {
  if (storage === null || typeof storage !== 'object') throw new TypeError('storage is required')
  if (typeof seal !== 'function' || typeof open !== 'function') throw new TypeError('seal and open are required')
  const L = {
    wallet: BLOB_STAMP_WALLET,
    walletLow: BLOB_STAMP_WALLET_LOW,
    issueBurst: ISSUE_BURST,
    issuePaceMs: ISSUE_PACE_MS,
    topUpEveryMs: TOP_UP_EVERY_MS,
    topUpRetryMs: TOP_UP_RETRY_MS,
    keyCheckMs: KEY_CHECK_MS,
    rotationMs: ROTATION_MS,
    putBurst: PUT_BURST,
    putPaceMs: PUT_PACE_MS,
    forceMargin: FORCE_MARGIN,
    copyBatch: COPY_BATCH,
    copyReserveChunk: COPY_RESERVE_CHUNK,
    link: {},
    ...(limits || {})
  }
  const safeLog = (t) => { try { log(t) } catch {} }
  const linkOpts = { seederUrl, createSocket, association, log: safeLog, limits: L.link }
  let walletLock = Promise.resolve()
  let topping = null
  // The earliest time the next unforced top-up may run.
  let nextTopUp = 0
  // When the seeder's blob key was last seen current in the wallet.
  let keyCheckedAt = 0
  // The kv blobKeyCheck time once a read succeeded: null while unread (a
  // failed read is not cached), 0 when absent.
  let lastCheckStored = null
  // keyCheckedAt is not stored yet (a failed write): written again by the
  // next top-up.
  let checkUnsaved = false
  // Why the last top-up stopped short: 'teto' (the daily budget), 'seeder'
  // (no link) or 'falha' (a bad answer); null when it filled the wallet.
  let shortBy = null

  function withWallet (fn) {
    const p = walletLock.then(fn)
    walletLock = p.catch(noop)
    return p
  }

  // The wallet as plain stamps [{ kid, token, sig }]. An item that does not
  // open (another key, tampered) is dropped by the next write.
  async function readWallet () {
    const w = await store.readBlobStamps(storage)
    const items = []
    for (const s of w.items) {
      const v = open({ nonce: s.nonce, box: s.box })
      if (v === null || typeof v !== 'object' || typeof v.token !== 'string' || !/^[0-9a-f]{64}$/.test(v.token) || typeof v.sig !== 'string') continue
      items.push({ kid: s.kid, token: v.token, sig: v.sig })
    }
    return { items, kids: w.kids }
  }

  function writeWallet ({ items, kids }) {
    return store.writeBlobStamps(storage, { items: items.map((s) => ({ kid: s.kid, ...seal({ token: s.token, sig: s.sig }) })), kids })
  }

  // -> the last key check time, or 0 when unknown. Unknown is never stale:
  // the stale rule drops the previous kid's stamps, so it acts only on a
  // time actually read (or set in this process).
  async function lastKeyCheck () {
    if (keyCheckedAt > 0) return keyCheckedAt
    if (lastCheckStored === null) {
      let v
      try {
        v = await storage.readJson('blobKeyCheck')
      } catch {
        return 0
      }
      lastCheckStored = v !== null && typeof v === 'object' && v.v === 1 && Number.isSafeInteger(v.at) && v.at > 0 ? v.at : 0
    }
    return lastCheckStored
  }

  function keyChecked () {
    keyCheckedAt = Date.now()
    return saveKeyCheck()
  }

  function saveKeyCheck () {
    const at = keyCheckedAt
    checkUnsaved = true
    return storage.writeJson('blobKeyCheck', { v: 1, at }).then(() => {
      if (keyCheckedAt === at) checkUnsaved = false
    }, noop)
  }

  function usableOf (w) {
    return w.items.filter((s) => w.kids.length === 0 || w.kids.includes(s.kid))
  }

  // Takes n stamps at once (all or none) -> [{ kid, token, sig }] or null.
  function takeStamps (n) {
    return withWallet(async () => {
      const w = await readWallet()
      const usable = usableOf(w)
      if (usable.length < n) return null
      const taken = usable.slice(0, n)
      const spent = new Set(taken.map((s) => s.token))
      await writeWallet({ items: w.items.filter((s) => !spent.has(s.token)), kids: w.kids })
      return taken
    })
  }

  async function walletSize () {
    return usableOf(await readWallet()).length
  }

  // Fills the wallet to L.wallet when below L.walletLow or `force`, at most
  // once per topUpEveryMs unless forced. A wallet not low whose key check is
  // older than keyCheckMs only asks the seeder's key: an unchanged key buys
  // nothing, a new one fills as usual (at least one stamp, which makes it
  // current). A forced top-up with a `need` (a send waiting) buys only up to
  // need + L.forceMargin, and never past what a fill to max(L.wallet, need)
  // would buy. Single flight. keyPair: the identity pair, for the stamp
  // link's proof. Resolves the stamps bought; never throws.
  function topUp (keyPair, { force = false, need = 0 } = {}) {
    if (topping !== null) return topping
    topping = (async () => {
      try {
        let fresh = 0
        if (checkUnsaved && keyCheckedAt > 0) await saveKeyCheck()
        if (!force && Date.now() < nextTopUp) return 0
        const low = force || (await walletSize()) < L.walletLow
        if (low || Date.now() - keyCheckedAt >= L.keyCheckMs) {
          shortBy = null
          let current = false
          try {
            const fill = Math.max(L.wallet, need)
            const goal = force && need > 0 ? Math.min(fill, need + L.forceMargin) : fill
            const r = await issueStamps(keyPair, goal, { keyOnly: !low })
            fresh = r.fresh
            current = r.current
          } catch {
            if (shortBy === null) shortBy = 'falha'
          }
          if (fresh === 0 && current && !low) return 0
          if (fresh === 0) {
            nextTopUp = Date.now() + L.topUpRetryMs
            safeLog('aviso: selos de mídia não renovados')
          } else {
            nextTopUp = Date.now() + L.topUpEveryMs
          }
        }
        return fresh
      } catch {
        return 0
      }
    })()
    // Cleared outside the body: a body that returns before its first await
    // would clear the slot before it was set.
    const p = topping
    p.then(() => { if (topping === p) topping = null })
    return p
  }

  // -> { fresh, current }: the stamps bought, and whether the seeder's key is
  // the wallet's current one afterwards. keyOnly: buy nothing while the key
  // is unchanged. One stamp link has a deadline: a link lost after it bought
  // at least one stamp is replaced and the purchase goes on, until the target,
  // a 'teto', a bad answer, a changed key or a link that buys nothing.
  async function issueStamps (keyPair, target, { keyOnly = false } = {}) {
    const fresh = []
    let pub = null
    let parsed = null
    let need = 0
    // Unknown (no stored check) is not stale: a wallet that never saw a key
    // has nothing to drop.
    const checked = await lastKeyCheck()
    const stale = checked > 0 && Date.now() - checked >= L.rotationMs
    for (;;) {
      const first = pub === null
      let link
      try {
        link = await openStampLink({ ...linkOpts, limits: { stampDeadlineMs: BLOB_STAMP_LINK_DEADLINE_MS, ...L.link }, keyPair, diary: stampDiary() })
      } catch (err) {
        shortBy = 'seeder'
        if (first) throw err
        break
      }
      const before = fresh.length
      let lost = false
      try {
        let p
        try {
          p = await link.key('blob')
        } catch (err) {
          shortBy = 'seeder'
          if (first) throw err
          break
        }
        if (first) {
          parsed = postage.parsePublicKey(p)
          if (parsed === null) {
            shortBy = 'falha'
            return { fresh: 0, current: false }
          }
          pub = p
          const isCurrent = (await readWallet()).kids[0] === pub.kid
          if (isCurrent) await keyChecked()
          if (keyOnly && isCurrent) return { fresh: 0, current: true }
          // Counted against the stamps still usable once this key is current:
          // a rotation drops the stamps of the pair's older key. A new key
          // needs at least one verified stamp to become current.
          need = target - await usableAfter(pub.kid, stale)
          if (!isCurrent) need = Math.max(need, 1)
        } else if (p === null || typeof p !== 'object' || p.kid !== pub.kid) {
          shortBy = 'falha'
          break
        }
        while (fresh.length < need) {
          if (fresh.length >= L.issueBurst && L.issuePaceMs > 0) await sleep(L.issuePaceMs)
          const token = postage.newToken(parsed.n, 'blob')
          const { blinded, r } = postage.blind(postage.representative(token, 'blob'), parsed.n)
          let res
          try {
            res = await link.issue(postage.toBase64(blinded), 'blob')
          } catch {
            shortBy = 'seeder'
            lost = true
            break
          }
          if (res.error === 'teto') {
            shortBy = 'teto'
            break
          }
          if (res.error !== undefined || res.kid !== pub.kid) {
            shortBy = 'falha'
            break
          }
          const s = postage.fromBase64(res.sig)
          const sig = s === null ? null : postage.unblind(s, r, parsed.n)
          if (sig === null || !postage.verify(token, sig, pub, 'blob')) {
            shortBy = 'falha'
            break
          }
          fresh.push({ kid: pub.kid, token: b4a.toString(token, 'hex'), sig: postage.toBase64(sig) })
        }
      } finally {
        link.close()
      }
      if (!lost || fresh.length === before) break
    }
    // The seeder accepts the current and the previous kid only. A key is
    // taken as current only once a stamp under it verified: a key announced
    // with no usable stamp must not make the wallet drop unspent stamps.
    if (fresh.length === 0) return { fresh: 0, current: false }
    await withWallet(async () => {
      const w = await readWallet()
      const kids = kidsAfter(w.kids, pub.kid, stale)
      const known = new Set(w.items.map((s) => s.token))
      const items = [...w.items.filter((s) => kids.includes(s.kid)), ...fresh.filter((s) => !known.has(s.token))]
      await writeWallet({ items, kids })
    })
    await keyChecked()
    return { fresh: fresh.length, current: true }
  }

  // The kids the wallet keeps once a stamp under kid verified; stale: the
  // last key check is older than a rotation, so a new kid stands alone.
  function kidsAfter (kids, kid, stale) {
    if (kids[0] === kid) return kids
    return stale ? [kid] : [kid, ...kids.slice(0, 1)]
  }

  async function usableAfter (kid, stale) {
    const w = await readWallet()
    const kids = kidsAfter(w.kids, kid, stale)
    return w.items.filter((s) => kids.includes(s.kid)).length
  }

  function shortError () {
    if (shortBy === 'teto') return new UsageError(NO_STAMPS)
    if (shortBy === 'seeder') return new UsageError(NO_SEEDER)
    return new UsageError(STAMP_FAILED)
  }

  // need stamps from the wallet; a short wallet waits for a top-up in flight
  // and then forces one more.
  async function stampsFor (need, keyPair) {
    let stamps = await takeStamps(need)
    if (stamps !== null) return stamps
    if (topping !== null) {
      await topping
      stamps = await takeStamps(need)
      if (stamps !== null) return stamps
    }
    await topUp(keyPair, { force: true, need })
    stamps = await takeStamps(need)
    if (stamps === null) throw shortError()
    return stamps
  }

  // A history copy's stamps (docs/protocol.md section 11): bought one
  // batch at a time over the identified stamp link (kind 'copy', the
  // seeder's weekly allowance for a copy), held in memory only and never
  // put in the wallet, so a copy never spends the daily blob allowance nor
  // the reverse. take(n) resolves n stamps, or throws once the allowance is
  // gone, the seeder cannot be reached (an old seeder never answers the
  // kind) or answers badly. reserve(n) is take that gives what it got instead
  // of throwing. `exhausted` says the weekly allowance ended.
  // take(n, { stop }): stop() is checked before every link and every issue; once
  // it returns true no further issue is sent and no link opened (the app locked,
  // so more stamps would only be thrown away). A stopped take ends like any
  // short purchase, a plain failure that keeps what was bought in the stock, so
  // reserve hands those stamps over and the source stays ended.
  // Nothing here repeats a request: a batch that fails is a normal error
  // and only the user's next copy asks again.
  function copySource (keyPair, { batch = L.copyBatch } = {}) {
    let stock = []
    let failure = null
    // A chunk of 0 or a fraction would never shrink what reserve has left.
    const chunk = Math.max(1, Math.floor(L.copyReserveChunk))
    const source = {
      // reserve's batch size, so a caller can count the batches.
      chunk,
      exhausted: false,
      bought: 0,
      async take (n, { stop = null } = {}) {
        // Stamps already bought are spent first. One failed purchase ends
        // the source for this copy: no request is repeated, and `exhausted`
        // tells the caller whether the weekly allowance ended.
        if (stock.length >= n) {
          const out = stock.slice(0, n)
          stock = stock.slice(n)
          return out
        }
        if (failure !== null) throw failure
        try {
          // A link has one deadline, so a large ask outlives it: a link cut
          // after it bought something goes on over a new one. A refusal, the
          // end of the allowance or a link that bought nothing ends it.
          while (stock.length < n) {
            if (stop !== null && stop()) break
            const { fresh, cut } = await buyCopyStamps(keyPair, Math.max(n - stock.length, batch), source, stop)
            stock = stock.concat(fresh)
            source.bought += fresh.length
            if (!cut || source.exhausted) break
          }
        } catch (err) {
          failure = err
          throw err
        }
        if (stock.length < n) {
          failure = new UsageError(source.exhausted ? NO_COPY_STAMPS : STAMP_FAILED)
          throw failure
        }
        const out = stock.slice(0, n)
        stock = stock.slice(n)
        return out
      },
      // Up to n stamps for the caller to hold: fewer, down to none, when the
      // allowance ends or a purchase fails (whatever was bought is handed
      // over, and the source stays ended as take leaves it). Bought in
      // batches of copyReserveChunk, each over its own link; after each,
      // between(held so far) may return false to stop with what is held, and
      // stop() ends a purchase in progress (see take). Never throws.
      async reserve (n, between = null, stop = null) {
        const out = []
        let left = n
        while (left > 0) {
          let got
          try {
            got = await source.take(Math.min(left, chunk), { stop })
          } catch {
            out.push(...stock)
            stock = []
            break
          }
          for (const s of got) out.push(s)
          left -= got.length
          if (between !== null) {
            let go = false
            try {
              go = (await between(out.length)) !== false
            } catch {}
            if (!go) break
          }
        }
        return out
      }
    }
    return source
  }

  // One stamp link: the key, then up to `count` stamps -> { fresh, cut }.
  // Stops quietly at a 'teto' (marking the source exhausted) so the stamps
  // already bought still count; no link or no key at all throws. cut: the
  // link itself ended (its deadline, a lost socket) rather than the seeder
  // refusing or the allowance ending.
  async function buyCopyStamps (keyPair, count, source, stop = null) {
    let link
    try {
      link = await openStampLink({ ...linkOpts, limits: { stampDeadlineMs: BLOB_STAMP_LINK_DEADLINE_MS, ...L.link }, keyPair, diary: stampDiary() })
    } catch (err) {
      if (err instanceof UsageError) throw err
      throw new UsageError(NO_SEEDER)
    }
    const fresh = []
    let cut = false
    try {
      let p
      try {
        p = await link.key('copy')
      } catch {
        throw new UsageError(NO_COPY_ALLOWANCE)
      }
      const parsed = postage.parsePublicKey(p)
      if (parsed === null) throw new UsageError(STAMP_FAILED)
      while (fresh.length < count) {
        if (stop !== null && stop()) break
        if (fresh.length >= L.issueBurst && L.issuePaceMs > 0) await sleep(L.issuePaceMs)
        const token = postage.newToken(parsed.n, 'blob')
        const { blinded, r } = postage.blind(postage.representative(token, 'blob'), parsed.n)
        let res
        try {
          res = await link.issue(postage.toBase64(blinded), 'copy')
        } catch {
          cut = true
          break
        }
        if (res.error === 'teto') {
          source.exhausted = true
          break
        }
        if (res.error !== undefined || res.kid !== p.kid) break
        const sg = postage.fromBase64(res.sig)
        const sig = sg === null ? null : postage.unblind(sg, r, parsed.n)
        if (sig === null || !postage.verify(token, sig, p, 'blob')) break
        fresh.push({ kid: p.kid, token: b4a.toString(token, 'hex'), sig: postage.toBase64(sig) })
      }
    } finally {
      link.close()
    }
    if (fresh.length === 0 && !source.exhausted) throw new UsageError(STAMP_FAILED)
    return { fresh, cut }
  }

  // Builds the frame of every chunk without one yet, spending one wallet
  // stamp each (or one stamp of `source`, a copySource). Frames already built
  // keep their stamp.
  async function stamp (sealed, keyPair, source = null) {
    if (!isSealed(sealed)) throw new TypeError('invalid sealed blob')
    const missing = []
    for (let i = 0; i < sealed.frames.length; i++) if (sealed.frames[i] === null) missing.push(i)
    if (missing.length === 0) return
    const stamps = source === null ? await stampsFor(missing.length, keyPair) : await source.take(missing.length)
    const count = sealed.descriptor.chunks
    for (const [k, index] of missing.entries()) {
      const s = stamps[k]
      sealed.frames[index] = blob.encodeChunk({
        id: sealed.id,
        index,
        count,
        kid: b4a.from(s.kid, 'hex'),
        sig: postage.bigToBytes(postage.fromBase64(s.sig)),
        token: b4a.from(s.token, 'hex'),
        bytes: piece(sealed.cipher, index)
      })
    }
  }

  // Puts every frame, in order, each once. 'cheio' or 'ritmo' stops at once
  // and throws the seeder's reason; an 'invalido' frame is cleared (the next
  // stamp pays it again) and the rest are still sent, then the refusal is
  // thrown. A lost link or a missing ack throws an uncertain error.
  async function put (sealed) {
    if (!isSealed(sealed)) throw new TypeError('invalid sealed blob')
    if (sealed.frames.some((f) => f === null)) throw new TypeError('stamp the blob before put')
    sealed.acked.fill(false)
    let link
    try {
      link = await openBlobLink(linkOpts)
    } catch (err) {
      if (err instanceof UsageError) throw err
      throw new UsageError(NO_SEEDER)
    }
    let refused = null
    try {
      for (let i = 0; i < sealed.frames.length; i++) {
        if (i >= L.putBurst && L.putPaceMs > 0) await sleep(L.putPaceMs)
        let r
        try {
          r = await link.put(sealed.frames[i])
        } catch {
          throw unconfirmed()
        }
        if (r.ok) {
          sealed.acked[i] = true
        } else if (r.reason === 'invalido') {
          sealed.frames[i] = null
          refused = r.reason
        } else {
          throw refusal(r.reason)
        }
      }
    } finally {
      link.close()
    }
    if (refused !== null) throw refusal(refused)
  }

  async function send (sealed, keyPair, source = null) {
    await stamp(sealed, keyPair, source)
    await put(sealed)
  }

  return { stamp, put, send, topUp, walletSize, copySource }
}

// The seeder's HTTP origin, exactly scheme://host[:port]: https, or http on
// a loopback host only. Anything else (a path, a query, credentials) throws.
function seederOrigin (origin) {
  let u
  try {
    u = new URL(origin)
  } catch {
    throw new UsageError(BAD_ORIGIN)
  }
  const plain = u.protocol === 'http:' && LOOPBACK.has(u.hostname)
  // Built from its parts: Bare's URL (the app worklet) has no origin getter.
  const out = u.protocol + '//' + u.host
  if ((u.protocol !== 'https:' && !plain) || u.username !== '' || u.password !== '' ||
      (u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '' ||
      String(origin).replace(/\/$/, '') !== out) {
    throw new UsageError(BAD_ORIGIN)
  }
  return out
}

function header (res, name) {
  return res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null
}

// Retry-After in whole seconds (a date or anything else waits the default),
// capped.
function retryDelay (res, L) {
  const v = header(res, 'retry-after')
  const ms = v !== null && /^[0-9]{1,6}$/.test(String(v).trim()) ? Number(String(v).trim()) * 1000 : L.retryDefaultMs
  return Math.min(ms, L.retryAfterMaxMs)
}

function halted (halt) {
  return halt !== undefined && halt.stop()
}

// sleep(ms), cut short once halt.stop() turns true. halt.wake(fn) calls fn on
// every failure and returns its unsubscribe; the timer is always cleared.
function pause (ms, halt) {
  if (halt === undefined) return sleep(ms)
  return new Promise((resolve) => {
    let timer = null
    let off = noop
    const done = () => {
      clearTimeout(timer)
      off()
      resolve()
    }
    off = halt.wake(() => { if (halt.stop()) done() })
    timer = setTimeout(done, ms)
  })
}

// One GET attempt's deadline: after ms, or on abort() (a halted chunk), its
// signal is aborted and race(p) rejects with NO_SEEDER, so the run settles
// even when the fetch or the body stream ignores the signal. Expiry rejects
// before the signal aborts, so a timeout always reads as NO_SEEDER, which
// keeps the media retryable instead of marked gone. end() clears the timer;
// an attempt that did not finish its frame also aborts its signal, so an
// unread body (a 404, a 429 before its retry) does not hold the connection.
function attemptDeadline (ms) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  let fire = noop
  const expired = new Promise((resolve, reject) => { fire = reject })
  expired.catch(noop)
  let fired = false
  const abort = () => {
    if (fired) return
    fired = true
    fire(new UsageError(NO_SEEDER))
    if (ctrl !== null) try { ctrl.abort() } catch {}
  }
  const timer = setTimeout(abort, ms)
  return {
    signal: ctrl === null ? undefined : ctrl.signal,
    race: (p) => Promise.race([p, expired]),
    abort,
    end (ok) {
      clearTimeout(timer)
      if (!ok) abort()
    }
  }
}

// pace(halt): resolves when the next GET may go out. halt (optional): { stop,
// wake }; once stop() is true the chunk's error can no longer be the one
// thrown, so no GET goes out for it, not even the first, a 429 or 503 is not
// retried and its Retry-After is not waited out. The error thrown then is
// never surfaced. Each attempt has its own L.getTimeoutMs deadline over the
// headers and the body; a timed-out attempt is not retried here (only a 429
// or 503 is), and halting a chunk aborts its GET still in flight.
async function getFrame (doFetch, url, L, pace, halt) {
  for (let attempt = 0; ; attempt++) {
    await pace(halt)
    if (halted(halt)) throw new UsageError(NO_SEEDER)
    const deadline = attemptDeadline(L.getTimeoutMs)
    const off = halt === undefined ? noop : halt.wake(() => { if (halt.stop()) deadline.abort() })
    let ok = false
    let wait
    try {
      let res
      try {
        res = await deadline.race(doFetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: deadline.signal }))
      } catch {
        throw new UsageError(NO_SEEDER)
      }
      if ((res.status !== 429 && res.status !== 503) || attempt >= L.getRetries) {
        const body = await deadline.race(frameBody(res))
        ok = true
        return body
      }
      wait = retryDelay(res, L)
    } finally {
      off()
      deadline.end(ok)
    }
    if (halted(halt)) throw new UsageError(NO_SEEDER)
    await pause(wait, halt)
    if (halted(halt)) throw new UsageError(NO_SEEDER)
  }
}

// The frame of a final answer: its status and length checked, its body read
// under the cap.
async function frameBody (res) {
  if (res.status === 404) throw new UsageError(NOT_FOUND)
  if (res.status === 429) throw new UsageError(SEEDER_RATE)
  if (res.status !== 200 || res.redirected === true) throw new UsageError(NO_SEEDER)
  const length = header(res, 'content-length')
  if (length !== null && length !== String(BLOB_FRAME_BYTES)) throw new UsageError(BAD_MEDIA)
  const body = await readCapped(res, length !== null)
  // A body that ended early says nothing about the blob: a transient read
  // error, so the media stays retryable instead of marked gone.
  if (body.byteLength < BLOB_FRAME_BYTES) throw new UsageError(NO_SEEDER)
  return body
}

// The body, never buffering more than BLOB_FRAME_BYTES: streamed and cut off
// past the cap, or, with no stream, read whole only under a Content-Length
// already checked.
async function readCapped (res, sized) {
  const stream = res.body
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    const out = new Uint8Array(BLOB_FRAME_BYTES)
    let n = 0
    for (;;) {
      let step
      try {
        step = await reader.read()
      } catch {
        throw new UsageError(NO_SEEDER)
      }
      if (step.done) break
      const v = step.value
      if (!(v instanceof Uint8Array) || n + v.byteLength > BLOB_FRAME_BYTES) {
        try { reader.cancel().catch(noop) } catch {}
        throw new UsageError(BAD_MEDIA)
      }
      out.set(v, n)
      n += v.byteLength
    }
    return out.subarray(0, n)
  }
  if (!sized) throw new UsageError(BAD_MEDIA)
  try {
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    throw new UsageError(NO_SEEDER)
  }
}

// descriptor: { id, key, nonce, chunks, bytes, sha256 } from a sealed DM.
// opts.mime: the type the message names; an image type (or none) must pass
// mediaBounds. opts.fetch and opts.limits (getBurst, getPaceMs, getWindow,
// getRetries, retryAfterMaxMs, retryDefaultMs, getTimeoutMs): tests only. Resolves
// { bytes, bounds }. Chunks are fetched getWindow at a time (GET_WINDOW, kept
// small because the seeder's 16 responses in flight are shared by all
// clients); the hash and the open still wait for every chunk.
async function fetchBlob (descriptor, seederHttpOrigin, { mime, fetch: doFetch = globalThis.fetch, limits = {} } = {}) {
  if (!blob.validateBlobDescriptor(descriptor)) throw new UsageError(BAD_MEDIA)
  if (descriptor.bytes - BLOB_MAC_BYTES > BLOB_MAX_PLAIN) throw new UsageError(BAD_MEDIA)
  if (typeof doFetch !== 'function') throw new TypeError('fetch is not available')
  const origin = seederOrigin(seederHttpOrigin)
  const L = {
    getBurst: GET_BURST,
    getPaceMs: GET_PACE_MS,
    getWindow: GET_WINDOW,
    getRetries: GET_RETRIES,
    retryAfterMaxMs: RETRY_AFTER_MAX_MS,
    retryDefaultMs: RETRY_DEFAULT_MS,
    getTimeoutMs: GET_TIMEOUT_MS,
    ...(limits || {})
  }
  if (!Number.isInteger(L.getTimeoutMs) || L.getTimeoutMs <= 0 || L.getTimeoutMs > MAX_TIMER_MS) L.getTimeoutMs = GET_TIMEOUT_MS
  const inFlight = Number.isInteger(L.getWindow) ? Math.max(1, L.getWindow) : GET_WINDOW
  let sent = 0
  let last = 0
  let turns = Promise.resolve()
  // Past the burst, one GET per getPaceMs counted from the previous GET, so
  // a slow answer or a retry wait is not paid twice. Chained so concurrent
  // chunks and retries each take the next slot in the order they ask. A
  // halted chunk sends nothing, so its slot ends at once and is not counted:
  // the slots queued behind it do not wait for a GET that never goes out.
  const pace = (halt) => {
    turns = turns.then(async () => {
      if (halted(halt)) return
      if (sent >= L.getBurst && L.getPaceMs > 0) {
        const wait = last + L.getPaceMs - Date.now()
        if (wait > 0) await pause(wait, halt)
        if (halted(halt)) return
      }
      sent++
      last = Date.now()
    })
    return turns
  }
  const { id, chunks, bytes } = descriptor
  const cipher = b4a.alloc(bytes)
  let failed = null
  const wakers = new Set()
  const wake = (fn) => {
    wakers.add(fn)
    return () => wakers.delete(fn)
  }
  const getChunk = async (index) => {
    // Only a lower failed chunk stops this one: a chunk below a failure keeps
    // retrying, since its own outcome may still be the error thrown.
    const halt = { stop: () => failed !== null && failed.index < index, wake }
    const chunk = blob.decodeChunk(await getFrame(doFetch, origin + '/blob/' + id + '/' + index, L, pace, halt))
    if (chunk === null || b4a.toString(chunk.id, 'hex') !== id || chunk.index !== index || chunk.count !== chunks) {
      throw new UsageError(BAD_MEDIA)
    }
    const take = Math.min(BLOB_CHUNK_BYTES, bytes - index * BLOB_CHUNK_BYTES)
    for (let i = take; i < BLOB_CHUNK_BYTES; i++) {
      if (chunk.bytes[i] !== 0) throw new UsageError(BAD_MEDIA)
    }
    cipher.set(chunk.bytes.subarray(0, take), index * BLOB_CHUNK_BYTES)
  }
  let next = 0
  // Each lane takes the next chunk in index order. The lowest failing index
  // wins, not the first to fail, so the error a caller maps does not depend
  // on which answer came back first.
  const lane = async () => {
    while (failed === null && next < chunks) {
      const index = next++
      try {
        await getChunk(index)
      } catch (err) {
        if (failed === null || index < failed.index) {
          failed = { index, err }
          for (const fn of [...wakers]) fn()
        }
      }
    }
  }
  const lanes = []
  for (let i = 0; i < Math.min(inFlight, chunks); i++) lanes.push(lane())
  await Promise.all(lanes)
  if (failed !== null) throw failed.err
  if (b4a.toString(sha256(cipher), 'hex') !== descriptor.sha256) throw new UsageError(BAD_MEDIA)

  const key = b4a.from(descriptor.key, 'hex')
  const plain = b4a.alloc(bytes - BLOB_MAC_BYTES)
  let opened = false
  try {
    opened = sodium.crypto_secretbox_open_easy(plain, cipher, b4a.from(descriptor.nonce, 'hex'), key)
  } catch {
    opened = false
  } finally {
    wipe(key)
  }
  if (!opened || plain.byteLength !== bytes - BLOB_MAC_BYTES) {
    wipe(plain)
    throw new UsageError(BAD_MEDIA)
  }
  // The bytes decide, not the sender's label: anything that starts like an
  // image must pass the bounds whatever the mime says. A mime is compared
  // case-insensitively; an image mime (or none) requires an image.
  const label = typeof mime === 'string' ? mime.toLowerCase() : mime
  const named = label === undefined || (typeof label === 'string' && label.startsWith('image/'))
  let bounds = null
  if (named || looksLikeImage(plain)) {
    bounds = mediaBounds(plain, named ? label : undefined)
    if (bounds === null) {
      wipe(plain)
      throw new UsageError(BAD_MEDIA)
    }
  }
  return { bytes: plain, bounds }
}

function ascii (b, at, text) {
  if (b.byteLength < at + text.length) return false
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false
  return true
}

// An AVIF start, as mediaBounds sniffs it: an ftyp box of 16 to 144 bytes,
// a multiple of 4, all present, whose major brand is avif, or mif1 with avif
// among the compatible brands. An avis brand anywhere is a sequence, not an image; mif1
// alone is HEIC and isom, mp42 or M4A are video or audio.
function looksLikeAvif (b) {
  if (b.byteLength < 16 || !ascii(b, 4, 'ftyp')) return false
  const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  if (size < 16 || size > 144 || size % 4 !== 0 || size > b.byteLength) return false
  const brands = [String.fromCharCode(b[8], b[9], b[10], b[11])]
  for (let at = 16; at + 4 <= size; at += 4) brands.push(String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]))
  if (brands.includes('avis')) return false
  return brands[0] === 'avif' || (brands[0] === 'mif1' && brands.indexOf('avif', 1) !== -1)
}

// A JPEG, PNG, GIF, WebP or AVIF start, the formats mediaBounds parses (as
// loose as its own sniffing, so GIF87a/GIF89a and the full PNG signature
// match).
function looksLikeImage (b) {
  if (b.byteLength >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true
  if (b.byteLength >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true
  return ascii(b, 0, 'GIF8') || (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) || looksLikeAvif(b)
}

module.exports = {
  sealBlob,
  createBlobClient,
  fetchBlob,
  seederOrigin,
  BLOB_MAX_PLAIN,
  BLOB_STAMP_LINK_DEADLINE_MS,
  BLOB_STAMP_WALLET,
  BLOB_STAMP_WALLET_LOW,
  FORCE_MARGIN,
  KEY_CHECK_MS,
  ROTATION_MS,
  GET_BURST,
  GET_PACE_MS,
  GET_WINDOW,
  GET_RETRIES,
  GET_TIMEOUT_MS,
  looksLikeImage
}
