'use strict'

// Conversas on a core node (docs/rpc.md 5.73 to 5.80, 5.89, 5.114, 5.161):
// the browser node's DM engine (./dm.js) over file storage in
// <dataDir>/private/dm, injected into @varanda/core/lib/session as its `dm`
// factory. The engine is not moved into core: only its identity changes.
// - The prf is the seed file <dataDir>/private/dm-seed.json (core store.js),
//   read once per unlock and zeroed after; no passkey protects it.
// - The own dm-key goes in the core diary through the session's ops
//   (member.dmKeyEnsure, signed by the diary signer).
// - Stamps prove the Hypercore 11 diary with the v2 proof: the engine gets
//   the diary key next to the signer pair (stampDiary).
// - A Página's ops run as the page delegate actor (member.readDelegate): it
//   is the roster member the owner shares to, with the proof dm.actorBox
//   signs.
// - The dm-key of someone not held here is read from the seeder over a
//   short-lived link of its own (an ephemeral Noise key, an empty
//   inventory), gated on the block 0 certificate, newest blocks first, as
//   the browser node's lookup is. A blocked author answers box null and is
//   never asked for.
// - Text only: media and card on dm.pageDraft are refused before any
//   digest, upload or stamp. Received media opens through readMedia.
// - A Página's private groups: the session folds them with the page's group
//   box (withPageGroupBox, a copy) and pages their roots (heldPages,
//   ops.pagesChanged when they change).
// Transport: wss://<account host>/seeder from an https account origin; ws
// only for a loopback http origin (tests); any other origin is refused.
// The handlers never run on the session's chain: the session's ops do, so
// a handler that awaits one never holds the chain while it waits.

const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { decodeBlock, validateRecord } = require('@varanda/core/lib/records')
const { seederCertForKey, certForKey } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { UsageError } = require('@varanda/core/lib/errors')
const { readDmSeed, ensureDmSeed } = require('@varanda/core/lib/store')
const { newestDmKey } = require('@varanda/core/lib/member')
const { createDmEngine, KEY_MISMATCH } = require('./dm')
const { fileNodeStorage } = require('./file-storage')
const { memoryStorage } = require('./storage')
const { guardedWsStream } = require('./ws-stream')
const { PEEK_CORE_PAGE_SIZE, PEEK_MAX_FRAME } = require('./peek')
const store = require('./node-store')

const HEX64 = /^[0-9a-f]{64}$/
const BAD_ORIGIN = 'endereço da conta inválido: use https (http só neste computador)'
const DM_OFF = 'Conversas ainda não ativadas neste aparelho'
const NO_DELEGATE = 'chave de página não registrada'
const TEXT_ONLY = 'mídia disponível só na versão web'
const NO_SEEDER = 'sem conexão com o semeador'
const BAD_KEY = 'chave inválida'
const DM_BUSY = 'Conversas abertas em outro processo deste aparelho'
const DM_SEED_BAD = 'arquivo das Conversas corrompido neste aparelho'
const BLOCKLIST_UNREADABLE = 'lista de bloqueio ilegível neste aparelho'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
// The browser node's bounded scan: a dm-key older than the newest
// DM_KEY_REFRESH_BLOCKS is refreshed by its owner (member.js).
const PEEK_WINDOW = 36
const LOOKUP_WINDOWS = 8
const PEEK_DEADLINE_MS = 20000
const PAGE_MOVE_HOPS_MAX = 8
const NONE = Object.freeze({ box: null, gen: null })
// close() waits this long at most for the work in flight to end.
const CLOSE_DRAIN_MS = PEEK_DEADLINE_MS

function noop () {}

// An account origin -> the seeder WebSocket URL. Throws UsageError.
function seederUrlOf (accountOrigin) {
  let u
  try {
    u = new URL(String(accountOrigin))
  } catch {
    throw new UsageError(BAD_ORIGIN)
  }
  if (u.username !== '' || u.password !== '' || (u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '') throw new UsageError(BAD_ORIGIN)
  if (u.protocol === 'https:') return 'wss://' + u.host + '/seeder'
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return 'ws://' + u.host + '/seeder'
  throw new UsageError(BAD_ORIGIN)
}

function joinDir (dir, ...parts) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return [dir.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

function zero (pair) {
  if (pair && pair.secretKey) pair.secretKey.fill(0)
}

// The dm-key scan of a peeked diary past its gated block 0, as the browser
// node's lookup: seq 1, then up to LOOKUP_WINDOWS windows of PEEK_WINDOW
// seqs, newest first, until a window shows a newer dm-key. -> { box, gen }
// of the newest one read, NONE after a complete scan with none. A read that
// fails or times out, an update that fails, or the deadline reached before
// the scan ends answer "unknown" (throws NO_SEEDER), never an older key or
// NONE. get(seq) -> raw block (throws on failure); update(); length();
// forked() -> true once the diary forked (NONE).
async function scanDmKey ({ get, update, length, forked, deadline, now = Date.now }) {
  try {
    await update()
  } catch {
    throw new Error(NO_SEEDER)
  }
  if (forked()) return NONE
  const len = length()
  const entries = []
  const read = async (seq) => {
    let raw
    try {
      raw = await get(seq)
    } catch {
      throw new Error(NO_SEEDER)
    }
    entries.push({ seq, record: decodeBlock(raw) })
  }
  if (len > 1) await read(1)
  let hi = len - 1
  for (let w = 0; hi > 1 && w < LOOKUP_WINDOWS; w++) {
    if (now() >= deadline) throw new Error(NO_SEEDER)
    const lo = Math.max(2, hi - PEEK_WINDOW + 1)
    const before = newestDmKey(entries)
    const seqs = []
    for (let s = hi; s >= lo; s--) seqs.push(s)
    await Promise.all(seqs.map(read))
    const found = newestDmKey(entries)
    if (found !== null && (before === null || found.seq !== before.seq)) break
    hi = lo - 1
  }
  if (forked()) return NONE
  const best = newestDmKey(entries)
  return best === null ? NONE : { box: best.box, gen: best.gen }
}

// ops (from the core session, each one queued on its chain):
//   own() -> the diary key hex; signer() -> { diary, keyPair } (member.dmSigner);
//   dmKeyEnsure({ box, gen }); dmLookup(key) -> { box, gen } | null;
//   moderation() -> { blocked: Set, revokedIssuers: Set };
//   delegate() -> the page delegate pair | null (caller zeroes);
//   actorBox({ box, gen }) -> { actor, box, gen, at, sig };
//   pageRead(key) -> the page.read answer (throws NOT_FOUND when not held);
//   readers: the engine's identity readers (cert, memberBlocks, blocklist, follows).
// emit(event, data): the session's events. limits: tests (engine limits,
// peekDeadlineMs). dmKeyPeek: tests only, (key, real) -> { box, gen } in
// place of the seeder peek, as the browser node's option; real() runs it.
function createCoreDm ({ dataDir, association, accountOrigin, createSocket, fetch: fetchImpl, hkdf, ops, emit = noop, log = noop, limits = {}, dmKeyPeek = null } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('dataDir required')
  if (typeof createSocket !== 'function') throw new TypeError('createSocket required')
  if (ops === null || typeof ops !== 'object') throw new TypeError('ops required')
  const seederUrl = seederUrlOf(accountOrigin)
  const L = { peekDeadlineMs: PEEK_DEADLINE_MS, closeDrainMs: CLOSE_DRAIN_MS, engine: {}, ...(limits || {}) }
  const safeLog = (t) => { try { log(t) } catch {} }
  const storage = fileNodeStorage(joinDir(dataDir, 'private', 'dm'))
  // In memory only while Conversas is unlocked; zeroed on close.
  let signer = null
  const engine = createDmEngine({
    storage,
    association,
    seederUrl,
    createSocket,
    log: safeLog,
    emit: (event, data) => { try { emit(event, data) } catch {} },
    fetch: fetchImpl,
    hkdf,
    identity: ops.readers,
    stampDiary: () => (signer === null ? null : signer.diary),
    limits: L.engine
  })
  let closed = false
  let closing = null
  let unlocking = null
  // Handler calls and page key checks not settled yet: close() waits for
  // them before it zeroes the signer and closes storage.
  const inflight = new Set()
  const links = new Set()
  let chain = Promise.resolve()

  function track (p) {
    inflight.add(p)
    const done = () => { inflight.delete(p) }
    p.then(done, done)
    return p
  }

  const busy = () => inflight.size > 0 || unlocking !== null

  function serial (fn) {
    return (params) => {
      const p = chain.then(() => fn(params || {}))
      chain = p.catch(noop)
      return p
    }
  }

  function checkOpen () {
    if (closed) throw new UsageError(NO_SEEDER)
  }

  // A close can land between a handler's unlock and its use of the pair.
  function signerPair () {
    checkOpen()
    if (signer === null) throw new UsageError(DM_OFF)
    return signer.keyPair
  }

  // Two engines on the same files corrupt each other's stores: a second
  // process on this dataDir is refused, never let in. Retried on each call,
  // so it succeeds once the other one closes.
  async function lockStorage () {
    try {
      await storage.lock()
    } catch (err) {
      if (err && err.code === 'LOCKED') throw new UsageError(DM_BUSY)
      if (err && err.code === 'LOCK_UNAVAILABLE') throw new UsageError(err.message)
      throw err
    }
  }

  // The store's error names the file only; it still is not the client's.
  function seed (create) {
    try {
      return create ? ensureDmSeed(dataDir) : readDmSeed(dataDir)
    } catch (err) {
      if (err && err.code === 'DM_SEED_INVALID') throw new UsageError(DM_SEED_BAD)
      throw err
    }
  }

  // create: dm.enable makes the seed when there is none; any other call
  // without one is refused (DM_OFF), nothing created.
  async function unlock (create) {
    checkOpen()
    if (engine.unlocked() && signer !== null) return
    if (unlocking === null) {
      unlocking = (async () => {
        await lockStorage()
        if (closed) throw new UsageError(NO_SEEDER)
        const prf = seed(create)
        if (prf === null) throw new UsageError(DM_OFF)
        let s = null
        try {
          s = await ops.signer()
          await engine.unlock(prf)
          await engine.loaded()
          if (closed || !engine.unlocked()) throw new UsageError(DM_OFF)
          if (signer !== null) zero(signer.keyPair)
          signer = s
          s = null
        } finally {
          prf.fill(0)
          if (s !== null) zero(s.keyPair)
        }
        pagesChanged()
      })()
      unlocking.then(() => { unlocking = null }, () => { unlocking = null })
    }
    await unlocking
  }

  async function requireDm () {
    await unlock(false)
    return ops.own()
  }

  // The engine reads an unreadable blocklist as no blocks (the browser
  // depends on that); here a pull that would file items from blocked
  // members or revoked issuers is refused instead, as dm.lookup refuses
  // through ops.moderation. The engine's own reads happen later, so a file
  // broken in between still reads as no blocks for that pull.
  async function requireBlocklist () {
    try {
      await ops.moderation()
    } catch {
      throw new UsageError(BLOCKLIST_UNREADABLE)
    }
  }

  function topUp () {
    if (!closed && signer !== null && engine.unlocked()) engine.topUp(signer.keyPair).catch(noop)
  }

  async function withDelegate (fn) {
    const pair = await ops.delegate()
    if (pair === null) throw new UsageError(NO_DELEGATE)
    try {
      return await fn(b4a.toString(pair.publicKey, 'hex'), pair)
    } finally {
      zero(pair)
    }
  }

  // ---- the stranger's dm-key, over a short-lived seeder link ----

  function openLink (deadline) {
    return new Promise((resolve, reject) => {
      let socket
      try {
        socket = createSocket(seederUrl)
      } catch {
        reject(new Error(NO_SEEDER))
        return
      }
      let noise = null
      const { stream } = guardedWsStream(socket, {
        maxFrame: PEEK_MAX_FRAME,
        onLimit: () => { if (noise !== null) noise.destroy() }
      })
      noise = new NoiseSecretStream(true, stream, { keyPair: crypto.keyPair() })
      noise.on('error', noop)
      const link = { noise }
      links.add(link)
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          links.delete(link)
          noise.destroy()
          reject(err)
        } else {
          resolve(link)
        }
      }
      const timer = setTimeout(() => finish(new Error(NO_SEEDER)), Math.max(1, deadline - Date.now()))
      noise.once('close', () => {
        links.delete(link)
        finish(new Error(NO_SEEDER))
      })
      noise.once('connect', () => {
        if (closed) return finish(new Error(NO_SEEDER))
        try {
          Hypercore.createProtocolStream(noise)
          let verified = false
          attachAdmission(noise, {
            role: 'member',
            have: [],
            onmessage: (msg, peer) => {
              if (msg.type !== 'hello') return
              verified = msg.role === 'seeder' && peer.peerKey !== null && seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
              if (!verified) finish(new Error(NO_SEEDER))
            },
            oninventory: () => { if (verified) finish(null) },
            log: noop
          })
        } catch {
          finish(new Error(NO_SEEDER))
        }
      })
    })
  }

  // -> { box, gen } of the newest dm-key the seeder serves for `key`, both
  // null when a complete scan finds none or the diary does not pass the
  // gate. Throws NO_SEEDER ("unknown") when the seeder cannot be asked or
  // the scan does not complete (scanDmKey).
  async function peekDmKey (key, mod) {
    if (closed) throw new Error(NO_SEEDER)
    const deadline = Date.now() + L.peekDeadlineMs
    const left = () => Math.max(1, deadline - Date.now())
    const link = await openLink(deadline)
    const q = new Hypercore(memoryStorage({ pageSize: PEEK_CORE_PAGE_SIZE }), b4a.from(key, 'hex'), { valueEncoding: 'binary' })
    try {
      await q.ready()
      q.replicate(link.noise)
      let raw0
      try {
        raw0 = await q.get(0, { raw: true, timeout: left() })
      } catch {
        throw new Error(NO_SEEDER)
      }
      const first = decodeBlock(raw0)
      if (validateRecord(first, 0) !== null) return NONE
      if (!certForKey(first.cert, key, association, { revokedIssuers: mod.revokedIssuers }).ok || q.fork !== 0) return NONE
      // Block 0's proof need not carry the seeder's newest length.
      return await scanDmKey({
        get: async (seq) => {
          const raw = await q.get(seq, { raw: true, timeout: left() })
          if (raw === null) throw new Error(NO_SEEDER)
          return raw
        },
        update: () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(NO_SEEDER)), left())
          q.update({ wait: true }).then(
            () => { clearTimeout(timer); resolve() },
            (err) => { clearTimeout(timer); reject(err) }
          )
        }),
        length: () => q.length,
        forked: () => q.fork !== 0,
        deadline
      })
    } finally {
      links.delete(link)
      link.noise.destroy()
      await q.close().catch(noop)
    }
  }

  function peek (key, mod) {
    if (dmKeyPeek === null) return peekDmKey(key, mod)
    return dmKeyPeek(key, () => peekDmKey(key, mod))
  }

  // dm.lookup: local data first; a blocked author answers none and is never
  // asked for on the network.
  async function lookup (memberKey) {
    checkOpen()
    const key = typeof memberKey === 'string' ? memberKey.toLowerCase() : ''
    if (!HEX64.test(key)) throw new UsageError(BAD_KEY)
    const local = await ops.dmLookup(key)
    if (local !== null) return local
    const mod = await ops.moderation()
    if (mod.blocked.has(key)) return { box: null, gen: null }
    // "Unknown" is a connection problem to the client, never "cannot
    // receive messages yet" (box null).
    try {
      return await peek(key, mod)
    } catch {
      throw new UsageError(NO_SEEDER)
    }
  }

  // After a pull, never awaited by it: each held page's published dm-key
  // against the held gen and box, as the browser node checks it. The seeder
  // is asked first (a stored replica can lag a rotation); a stored replica
  // only wins when it is newer. When the seeder cannot be asked, only a
  // stored replica at or past the held gen that disagrees flags. A blocked
  // page is never asked for. One that differs is flagged and
  // 'dm.pageKeyMismatch' goes out. Never throws.
  async function checkPageKeys () {
    let held
    try {
      held = engine.heldPageBoxes()
    } catch {
      return
    }
    await Promise.allSettled(held.map(checkPageKey))
  }

  async function checkPageKey ({ page, box, gen }) {
    try {
      if (closed) return
      const local = await ops.dmLookup(page)
      const mod = await ops.moderation()
      let published
      try {
        if (mod.blocked.has(page)) throw new Error(NO_SEEDER)
        published = await peek(page, mod)
      } catch {
        if (local === null || local.gen === null || local.gen < gen || (local.box === box && local.gen === gen)) return
        published = local
      }
      if (closed) return
      // The seeder answering with no dm-key at all is a mismatch, whatever
      // a stored replica says (an honest page refreshes its key in reach).
      if (published.gen !== null && local !== null && local.gen !== null && local.gen > published.gen) published = local
      const differs = published.box !== box || published.gen !== gen
      if (engine.setPageMismatch(page, box, differs, gen) && differs) emit('dm.pageKeyMismatch', { page })
    } catch {}
  }

  const handlers = {
    'dm.enable': serial(async () => {
      await unlock(true)
      const { box, gen } = engine.boxHex()
      const r = await ops.dmKeyEnsure({ box, gen })
      await store.writeDmKey(storage, gen)
      topUp()
      return r
    }),
    'dm.lookup': ({ member }) => lookup(member),
    'dm.pull': async () => {
      const own = await requireDm()
      await requireBlocklist()
      try {
        return await engine.pull(own)
      } finally {
        topUp()
        track(checkPageKeys().catch(noop))
      }
    },
    'dm.list': serial(async (params) => engine.list(await requireDm(), params)),
    'dm.thread': serial(async (params) => engine.thread(await requireDm(), params)),
    'dm.seen': serial(async ({ peer, page }) => engine.seen(await requireDm(), peer, page)),
    'dm.pageGenerate': serial(async (params) => {
      await requireDm()
      return withDelegate((actor, pair) => engine.pageGenerate(actor, pair, params))
    }),
    'dm.pageShare': serial(async (params) => {
      await requireDm()
      return withDelegate((actor, pair) => engine.pageShare(pair, params))
    }),
    'dm.pageSecrets': async (params) => {
      await requireDm()
      let roster
      try {
        const r = await ops.pageRead(params.page)
        roster = { owner: r.owner, admins: r.admins }
      } catch (err) {
        if (err && err.code === 'NOT_FOUND') throw new UsageError(KEY_MISMATCH)
        throw err
      }
      const pair = await ops.delegate()
      if (pair === null) throw new UsageError(NO_DELEGATE)
      const actor = b4a.toString(pair.publicKey, 'hex')
      zero(pair)
      const r = await serial(() => engine.pageSecrets(actor, roster, params))()
      pagesChanged()
      return r
    },
    'dm.pageDraft': async (params) => {
      const hasMedia = params.media !== undefined && params.media !== null && !(Array.isArray(params.media) && params.media.length === 0)
      if (hasMedia || (params.card !== undefined && params.card !== null)) throw new UsageError(TEXT_ONLY)
      await requireDm()
      let box = null
      if (params.kind === 'msg' && params.to !== undefined && params.to !== params.page) box = (await lookup(params.to)).box
      return serial(async () => {
        await requireDm()
        return engine.pageDraft(params, box, signerPair())
      })()
    },
    'dm.pageSend': serial(async (params) => {
      await requireDm()
      const r = await engine.pageSend(params)
      topUp()
      return r
    }),
    'dm.pageLegacyChunk': async (params) => {
      await requireDm()
      const movedFrom = []
      let at = typeof params.page === 'string' ? params.page : null
      while (at !== null && movedFrom.length < PAGE_MOVE_HOPS_MAX) {
        let r
        try {
          r = await ops.pageRead(at)
        } catch (err) {
          if (err && err.code === 'NOT_FOUND') break
          throw err
        }
        const from = r.movedFrom === null || r.movedFrom === undefined ? null : r.movedFrom.from
        if (from === null || from === params.page || movedFrom.includes(from)) break
        movedFrom.push(from)
        at = from
      }
      return serial(async () => {
        await requireDm()
        return engine.pageLegacyChunk(params, movedFrom)
      })()
    },
    'dm.pageLegacyBlocks': serial(async (params) => {
      await requireDm()
      return engine.pageLegacyBlocks(params)
    }),
    'dm.pageForget': serial(async (params) => {
      await requireDm()
      try {
        return await engine.pageForget(params)
      } finally {
        pagesChanged()
      }
    }),
    // The node's own DM box and gen, the ones its dm-key names (docs/rpc.md
    // 5.161), signed by the page delegate.
    'dm.actorBox': serial(async () => {
      await requireDm()
      const { box, gen } = engine.boxHex()
      return ops.actorBox({ box, gen })
    })
  }

  for (const name of Object.keys(handlers)) {
    const fn = handlers[name]
    handlers[name] = (params) => {
      let p
      try {
        p = fn(params)
      } catch (err) {
        p = Promise.reject(err)
      }
      return track(p)
    }
  }

  // media.readFile kind 'dm' (docs/rpc.md 5.89): -> { bytes, mime, w, h, ms }.
  function readMedia ({ from, id, index, page } = {}) {
    return track((async () => {
      const own = await requireDm()
      const p = { from, id, index }
      if (page !== undefined) p.page = page
      return engine.readMedia(own, p)
    })())
  }

  // The group box pair of a page whose secrets are held here (docs/rpc.md
  // 5.114), for the session's group.read and group.seal with `page`; never
  // over RPC. fn(take) runs on this chain, so a dm.pageForget lands wholly
  // before or after it. take() -> a copy (the caller wipes it), or null when
  // none is held: called as the fold starts, no copy waits in a queue.
  function withPageGroupBox (page, fn) {
    return track(serial(async () => {
      await requireDm()
      return fn(() => {
        if (closed || !engine.unlocked()) return null
        const pair = engine.groupBoxOf(page)
        if (pair === null || pair === undefined) return null
        return { publicKey: b4a.from(pair.publicKey), secretKey: b4a.from(pair.secretKey) }
      })
    })())
  }

  // The held pages may have changed (an unlock, an adoption, a forget):
  // the session's run pages their roots again (ops.pagesChanged).
  function pagesChanged () {
    if (typeof ops.pagesChanged !== 'function') return
    try { ops.pagesChanged() } catch {}
  }

  // The pages whose secrets are held here, for the roots a sync run pages.
  // Synchronous and never on the session's chain (a run starts from it):
  // none while the engine is locked or closed. A change calls
  // ops.pagesChanged, after the engine holds it.
  function heldPages () {
    if (closed) return []
    try {
      return engine.heldPageBoxes().map((p) => p.page)
    } catch {
      return []
    }
  }

  // Later calls refuse (NO_SEEDER). The work in flight ends first, bounded
  // by closeDrainMs, so nothing writes after storage closes and nothing
  // signs with the zeroed pair; past the bound, it is closed anyway.
  function close () {
    if (closing !== null) return closing
    closed = true
    for (const link of links) link.noise.destroy()
    links.clear()
    closing = (async () => {
      const drained = (async () => {
        while (busy()) {
          await Promise.allSettled([...inflight, unlocking, chain])
        }
        await engine.close()
      })()
      let failure = null
      let timer = null
      await Promise.race([
        drained.catch((err) => { failure = err }),
        new Promise((resolve) => { timer = setTimeout(resolve, L.closeDrainMs) })
      ])
      clearTimeout(timer)
      if (signer !== null) {
        zero(signer.keyPair)
        signer = null
      }
      await storage.close().catch(noop)
      if (failure !== null) throw failure
    })()
    return closing
  }

  return { handlers, readMedia, withPageGroupBox, heldPages, close, seederUrl }
}

module.exports = { createCoreDm, seederUrlOf, scanDmKey, BAD_ORIGIN, DM_OFF, TEXT_ONLY, DM_BUSY, DM_SEED_BAD, BLOCKLIST_UNREADABLE }
