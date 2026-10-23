// Member sync of the browser node (docs/protocol.md section 6) through ONE
// seeder reached over a WebSocket (the seeder's `seed --ws-port` entry,
// Seeder#acceptStream): the counterpart of @varanda/core lib/sync.js runSync
// for a node with no DHT and no swarm. Same follow states, same gates, same
// quota, same events and the same SyncResult; what changes is the transport
// (one link, re-dialled with a backoff when it drops) and that the only peer
// that counts is a verified seeder.
//
// Follow entry states (as in @varanda/core lib/sync.js):
//   pending  nothing stored; advertised with length 0; the quarantine gate
//            runs when the verified seeder advertises the key with length >= 1
//   regate   quarantine gate passed and the replica is open in the storage,
//            but block 0 has not yet arrived there and passed the LOCAL gate
//   active   local gate passed; live download, advertised with contiguousLength
//   failing  gate failed, quota or fork: its close + purge is in flight
//   failed   skipped; excluded from every goal
//
// Quarantine: block 0 of a pending key is fetched into a Hypercore 10 core in
// MEMORY (./storage.js), never in the node's storage; only when it verifies
// for the trusted association (gateVerdict) and the signed length and
// byteLength learned with it fit the diary quota is the replica opened in
// the storage. The quarantine core is closed before the replica is opened on
// the same stream (one replication channel per discovery key).
//
// The link: an ephemeral Noise key per connection (never the diary key); no
// core is replicated before the seeder's hello verified (role 'seeder' and
// seederCertForKey on its Noise key, as lib/sync.js and ./seeder-link.js
// do); an endpoint that fails that check is dropped. Nothing here logs or
// returns the seeder URL.
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { decodeBlock, validateRecord, MAX_LOG_BLOCKS, MAX_LOG_BYTES } = require('@varanda/core/lib/records')
const { certForKey, seederCertForKey } = require('@varanda/core/lib/cert')
const { attachAdmission, MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { memoryStorage } = require('./storage')
const { wsStream } = require('./ws-stream')
const store = require('./node-store')

const GATE_TIMEOUT_MS = 15000
const GATE_MIN_TIMEOUT_MS = 250
const GATE_RETRY_MS = 15000
// Quarantine fetches in flight at once (a browser tab, not a server).
const MAX_PARALLEL_GATES = 8
// One deadline for the WebSocket, the Noise handshake and the seeder's hello.
const CONNECT_TIMEOUT_MS = 15000
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30000

const HEX64 = /^[0-9a-f]{64}$/

function noop () {}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// Block-0 verdict (docs §5, identical in the seeder and lib/sync.js):
// null = accepted.
function gateVerdict (raw, keyHex, associationHex) {
  try {
    const block0 = decodeBlock(raw)
    if (block0 === null || validateRecord(block0, 0) !== null) return 'not-in-log'
    const r = certForKey(block0.cert, keyHex, associationHex)
    return r.ok ? null : r.reason
  } catch {
    return 'not-in-log'
  }
}

async function localGate (core, keyHex, associationHex) {
  try {
    const raw = await core.get(0, { wait: false, raw: true })
    return gateVerdict(raw, keyHex, associationHex)
  } catch {
    return 'not-in-log'
  }
}

function watchContiguous (core, onGrow) {
  let last = core.contiguousLength
  const check = () => {
    const len = core.contiguousLength
    if (len > last) {
      last = len
      onGrow(len)
    }
  }
  core.on('append', check)
  core.on('download', check)
  return function stop () {
    core.off('append', check)
    core.off('download', check)
  }
}

function watchFork (core, onFork) {
  let fired = false
  const handler = () => {
    if (fired) return
    fired = true
    onFork('fork')
  }
  core.on('truncate', handler)
  core.on('conflict', handler)
  return function stop () {
    core.off('truncate', handler)
    core.off('conflict', handler)
  }
}

// storage: a ./node-storage.js storage. createSocket(url) -> a WebSocket-like
// object (the browser's WebSocket, or the `ws` client in Node). The limits
// and timings after `signal` are injectable for tests; their defaults are
// the protocol constants.
async function runSync ({
  storage,
  associationKey = null,
  seederUrl,
  createSocket,
  once = false,
  timeoutMs = 30000,
  log = noop,
  onEvent = noop,
  signal,
  maxLogBlocks = MAX_LOG_BLOCKS,
  maxLogBytes = MAX_LOG_BYTES,
  maxFollows = MAX_INVENTORY - 1,
  gateTimeoutMs = GATE_TIMEOUT_MS,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  retryMinMs = RETRY_MIN_MS,
  retryMaxMs = RETRY_MAX_MS
} = {}) {
  if (typeof createSocket !== 'function') throw new TypeError('createSocket required')
  // The trust root is checked before anything is opened.
  const config = await store.readConfig(storage)
  if (!config || config.role !== 'member') throw new Error('identidade não encontrada')
  if (associationKey && associationKey.toLowerCase() !== config.association) {
    throw new Error('associação diferente da configurada')
  }
  if (!(await store.diaryExists(storage))) throw new Error('identidade não encontrada')
  const association = config.association
  const deadline = Date.now() + timeoutMs

  let diary = null
  let ownHex = null
  let cert = null
  let stopDiaryWatch = null
  let deadlineTimer = null
  let ending = false // finish() started: no new work, waiting for purges
  let ended = false // result built
  let deadlineHit = false
  let fatal = null
  let result = null
  let settle
  const finished = new Promise((resolve) => { settle = resolve })
  const timers = new Set()
  const inflight = new Set() // quarantine fetches
  const settling = new Set() // purges and local re-gates finish() waits for
  const follows = new Map() // key -> entry
  const skipped = []
  const errorsSoft = []
  const hardErrors = []
  let link = null // the current connection to the seeder
  let readyEmitted = false
  let failures = 0 // consecutive connections that ended without a verified hello
  let fetching = 0
  let admittedEver = false
  let rejectedReason = null
  let confirmedLength = -1

  const emit = (ev) => {
    try {
      onEvent(ev)
    } catch {}
  }
  const softError = (msg) => {
    if (!errorsSoft.includes(msg)) errorsSoft.push(msg)
  }
  const hardError = (msg) => {
    if (!hardErrors.includes(msg)) hardErrors.push(msg)
  }

  function track (p, onOk, onErr) {
    const wrapped = p.then(onOk, onErr).catch(noop)
    settling.add(wrapped)
    wrapped.finally(() => settling.delete(wrapped)).catch(noop)
    return wrapped
  }

  function later (fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
    return timer
  }

  function clearLater (timer) {
    if (timer === null || timer === undefined) return
    clearTimeout(timer)
    timers.delete(timer)
  }

  // ---- the seeder link ----

  // The link once its hello verified, else null.
  function seederLink () {
    return link !== null && link.verified && link.peer !== null ? link : null
  }

  // Length the verified seeder advertises for key (undefined when it does not).
  function theirs (key) {
    const l = seederLink()
    if (l === null || !l.peer.remoteHave.has(key)) return undefined
    return l.peer.remoteHave.get(key)
  }

  function send (msg) {
    const l = seederLink()
    if (l !== null) l.peer.send(msg)
  }

  function inventory () {
    const have = [{ key: ownHex, length: diary.length }]
    for (const e of follows.values()) {
      if (e.state === 'active') have.push({ key: e.key, length: e.core.contiguousLength })
      else if (e.state === 'pending' || e.state === 'regate') have.push({ key: e.key, length: 0 })
    }
    return have
  }

  function connect () {
    if (ending) return
    let socket
    try {
      socket = createSocket(seederUrl)
    } catch {
      reconnectLater()
      return
    }
    const noise = new NoiseSecretStream(true, wsStream(socket), { keyPair: crypto.keyPair() })
    noise.on('error', noop)
    const l = {
      noise,
      peer: null,
      verified: false,
      quarantine: new Set(), // quarantine cores replicating on this link
      lastAdv: new Map(), // key -> last length processed (own + follows only)
      emittedHave: new Map(), // key -> last length reported as a 'have' event
      timer: null
    }
    link = l
    l.timer = later(() => {
      l.timer = null
      if (!l.verified) noise.destroy()
    }, connectTimeoutMs)
    noise.once('connect', () => onLinkConnect(l))
    noise.once('close', () => onLinkClose(l))
  }

  function reconnectLater () {
    if (ending) return
    const wait = Math.min(retryMaxMs, retryMinMs * Math.pow(2, Math.min(failures, 16)))
    failures++
    log('aviso: sem conexão com o semeador; nova tentativa em ' + Math.ceil(wait / 1000) + ' s')
    later(connect, wait)
  }

  function onLinkConnect (l) {
    if (ending || link !== l) {
      l.noise.destroy()
      return
    }
    try {
      // The muxer only (hypercore 10.38.2 index.js:157-187): no core is
      // attached before the hello verified.
      Hypercore.createProtocolStream(l.noise)
      l.peer = attachAdmission(l.noise, {
        role: 'member',
        have: inventory(),
        onmessage: (msg, peer) => onMessage(l, msg, peer),
        oninventory: () => evaluate(),
        log: (ev) => {
          if (ev && ev.event === 'inventory-timeout') log('aviso: inventário incompleto (' + key8(ev.peerKey) + ')')
          else if (ev && ev.event === 'peer-dropped') log('aviso: par descartado (' + key8(ev.peerKey) + '): ' + ev.reason)
        }
      })
    } catch (err) {
      log('aviso: canal de admissão: ' + err.message)
      l.noise.destroy()
      return
    }
    if (!readyEmitted) {
      readyEmitted = true
      emit({ event: 'ready' })
    }
  }

  function onLinkClose (l) {
    clearLater(l.timer)
    l.timer = null
    // Quarantine fetches on this link end now (their get() rejects).
    for (const q of l.quarantine) q.close().catch(noop)
    l.quarantine.clear()
    if (link !== l) return
    link = null
    if (ending) return
    evaluate()
    reconnectLater()
  }

  function onVerified (l) {
    failures = 0
    clearLater(l.timer)
    l.timer = null
    // Verified: only now are the diary and the accepted replicas attached.
    diary.replicate(l.noise)
    for (const e of follows.values()) {
      if ((e.state === 'active' || e.state === 'regate') && e.core) e.core.replicate(l.noise)
    }
    // send() queues until the channel opens, right after hello.
    if (cert) l.peer.send({ type: 'announce', key: ownHex, cert })
  }

  // Keys whose advertisements matter: our own and the follows.
  function relevant (key) {
    return key === ownHex || follows.has(key)
  }

  function onMessage (l, msg, peer) {
    if (ending || link !== l) return
    switch (msg.type) {
      case 'hello': {
        l.verified = msg.role === 'seeder' &&
          peer.peerKey !== null &&
          seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
        emit({ event: 'peer', role: peer.remoteRole, peerKey: peer.peerKey, verified: l.verified })
        if (!l.verified) {
          // Only a verified seeder may hold our diary or serve a follow.
          softError('semeador não verificado')
          log('aviso: o endereço configurado não respondeu como um semeador verificado (' + key8(peer.peerKey) + ')')
          l.noise.destroy()
          return
        }
        onVerified(l)
        for (const [key, length] of peer.remoteHave) {
          if (relevant(key)) {
            l.lastAdv.set(key, length)
            l.emittedHave.set(key, length)
          }
          noteAdvertisement(key, length)
        }
        break
      }
      case 'have': {
        if (!l.verified || !relevant(msg.key)) return
        if (l.lastAdv.get(msg.key) === msg.length) return
        l.lastAdv.set(msg.key, msg.length)
        if (l.emittedHave.get(msg.key) !== msg.length) {
          l.emittedHave.set(msg.key, msg.length)
          emit({ event: 'have', key: msg.key, length: msg.length })
        }
        noteAdvertisement(msg.key, msg.length)
        break
      }
      case 'admitted':
        if (!l.verified) return
        if (relevant(msg.key)) l.lastAdv.set(msg.key, msg.length)
        if (msg.key === ownHex) {
          l.admittedOwn = true
          admittedEver = true
          emit({ event: 'admitted', key: msg.key, length: msg.length })
        }
        noteAdvertisement(msg.key, msg.length)
        break
      case 'rejected':
        if (!l.verified) return
        l.lastAdv.delete(msg.key)
        if (msg.key === ownHex) {
          l.admittedOwn = false
          emit({ event: 'rejected', key: msg.key, reason: msg.reason })
          if (msg.reason === 'timeout') {
            softError('rejeitado: timeout (' + key8(peer.peerKey) + ')')
          } else {
            rejectedReason = msg.reason
            fail(['rejeitado: ' + msg.reason])
            return
          }
        }
        break
      default:
        break // members ignore announce
    }
    evaluate()
  }

  // ---- goals (--once) ----

  function anyFailing () {
    for (const e of follows.values()) if (e.state === 'failing') return true
    return false
  }

  // G2 holds when the verified seeder admitted our diary and advertises its
  // full length; remembered for seederConfirmed.
  function seederHolds () {
    const l = seederLink()
    const met = cert !== null && l !== null && l.admittedOwn === true && (theirs(ownHex) || 0) >= diary.length
    if (met) confirmedLength = diary.length
    return met
  }

  function unmetGoals () {
    const unmet = []
    // G1
    for (const e of follows.values()) {
      if (e.state === 'failed' || e.state === 'failing') continue
      const t = theirs(e.key)
      if (e.state === 'pending') {
        if (t !== undefined && t >= 1) unmet.push(e.key + ':0/' + t)
        else if (e.fetching || e.cutByDeadline || e.discardedRegate) unmet.push(e.key + ':0/' + (t === undefined ? 0 : t))
      } else if (e.state === 'regate') {
        unmet.push(e.key + ':0/' + (t === undefined ? 0 : t))
      } else {
        const ours = e.core.contiguousLength
        const want = Math.max(e.core.length, t === undefined ? 0 : t)
        if (ours < want) unmet.push(e.key + ':' + ours + '/' + want)
      }
    }
    // G2
    if (cert && seederLink() !== null && !seederHolds()) {
      unmet.push(ownHex + ':' + diary.length + '/' + (theirs(ownHex) || 0))
    }
    return unmet
  }

  function evaluate () {
    if (ending || !once || deadlineHit) return
    const l = seederLink()
    if (l === null || !l.peer.inventoryComplete) return
    if (anyFailing()) return
    if (unmetGoals().length === 0) finish(() => [true, []])
  }

  function buildResult (ok, errors) {
    const downloaded = {}
    const unadvertised = []
    for (const e of follows.values()) {
      if (e.state === 'failed' || e.state === 'failing') continue
      const t = theirs(e.key)
      if (e.state === 'active') downloaded[e.key] = e.core.contiguousLength
      if (t === undefined || t < 1) unadvertised.push(e.key)
    }
    const l = seederLink()
    return {
      ok,
      peers: l !== null ? 1 : 0,
      seeders: l !== null ? 1 : 0,
      admitted: admittedEver,
      rejected: rejectedReason,
      downloaded,
      unadvertised,
      skipped: skipped.slice(),
      errors,
      errorsSoft: errorsSoft.slice(),
      seederConfirmed: seederHolds() || (confirmedLength >= 0 && confirmedLength >= diary.length)
    }
  }

  function finish (outcome) {
    if (ending) return
    ending = true
    discardRegate()
    ;(async () => {
      while (settling.size > 0) await Promise.allSettled([...settling])
      ended = true
      let [ok, errors] = outcome()
      if (fatal) {
        ok = false
        errors = fatal.slice()
      } else if (hardErrors.length > 0) {
        ok = false
        errors = [...hardErrors, ...errors.filter((e) => !hardErrors.includes(e))]
      }
      result = buildResult(ok, errors)
      settle()
    })()
  }

  function fail (errors) {
    if (!fatal) fatal = errors
    finish(() => [false, errors])
  }

  function purgeFailed (key) {
    fail(['falha ao limpar diário rejeitado: ' + key8(key)])
  }

  function timeoutOutcome () {
    if (seederLink() === null) return [false, ['sem pares']]
    const unmet = unmetGoals()
    if (unmet.length === 0 && seederLink().peer.inventoryComplete) return [true, []]
    return [false, ['tempo esgotado: ' + unmet.join(', ')]]
  }

  function onDeadline () {
    deadlineTimer = null
    if (ending) return
    deadlineHit = true
    // Gate fetches never run past the deadline: let them report first.
    Promise.allSettled([...inflight]).then(() => finish(timeoutOutcome))
  }

  function onAbort () {
    if (ending) return
    if (once) finish(timeoutOutcome)
    else finish(() => [true, []])
  }

  // ---- follows ----

  function stopEntry (entry) {
    if (entry.stopGrow) entry.stopGrow()
    if (entry.stopFork) entry.stopFork()
    if (entry.stopQuota) entry.stopQuota()
    if (entry.range) entry.range.destroy()
    clearLater(entry.retryTimer)
    entry.stopGrow = entry.stopFork = entry.stopQuota = entry.range = entry.retryTimer = null
  }

  // A replica still in regate never passed the local gate in this run: on
  // ending it is closed and purged (tracked).
  function discardRegate () {
    for (const e of follows.values()) {
      if (e.state !== 'regate') continue
      stopEntry(e)
      e.state = 'pending'
      e.discardedRegate = true
      const core = e.core
      e.core = null
      track((async () => {
        await core.close()
        await store.purgeReplica(storage, e.key)
      })(), noop, () => {
        if (!ended) purgeFailed(e.key)
        else log('aviso: falha ao limpar diário ' + key8(e.key))
      })
    }
  }

  function failFollow (entry, reason, { purge }) {
    if (entry.state === 'failing' || entry.state === 'failed') return
    stopEntry(entry)
    skipped.push({ key: entry.key, reason })
    emit({ event: 'skipped', key: entry.key, reason })
    send({ type: 'rejected', key: entry.key, reason })
    if (!purge) {
      entry.state = 'failed'
      evaluate()
      return
    }
    entry.state = 'failing'
    const core = entry.core
    entry.core = null
    track((async () => {
      if (core) await core.close()
      await store.purgeReplica(storage, entry.key)
    })(), () => {
      entry.state = 'failed'
      evaluate()
    }, () => {
      entry.state = 'failed'
      purgeFailed(entry.key)
    })
  }

  function overQuota (core) {
    return core.length > maxLogBlocks || core.byteLength > maxLogBytes
  }

  // Log quota (S3): the signed length and byteLength advance on the upgrade
  // proof before the blocks arrive. An ACTIVE replica keeps what it verified
  // (the next run hits the quota again at startup); a replica in regate
  // holds nothing verified and is purged. Returns true when it failed.
  function checkQuota (entry) {
    const core = entry.core
    if (ended || !core) return false
    if (entry.state !== 'active' && entry.state !== 'regate') return false
    if (!overQuota(core)) return false
    failFollow(entry, 'quota', { purge: entry.state === 'regate' })
    return true
  }

  // The quota listener is registered BEFORE the growth watcher, and onGrow
  // checks again, so nothing past the limit is advertised or reported.
  function watchEntry (entry, core) {
    entry.core = core
    const check = () => { if (entry.core === core) checkQuota(entry) }
    core.on('append', check)
    entry.stopQuota = () => core.off('append', check)
    entry.stopFork = watchFork(core, () => { onFork(entry) })
    entry.range = core.download({ start: 0, end: -1 })
    entry.stopGrow = watchContiguous(core, (length) => { onGrow(entry, length) })
    if (checkQuota(entry)) return
    const l = seederLink()
    if (l !== null) core.replicate(l.noise)
  }

  function activate (entry, core) {
    entry.state = 'active'
    watchEntry(entry, core)
  }

  function enterRegate (entry, core) {
    entry.state = 'regate'
    watchEntry(entry, core)
    if (entry.state === 'regate' && core.contiguousLength > 0) regate(entry)
  }

  function onGrow (entry, length) {
    if (ended) return
    if (checkQuota(entry)) return
    if (entry.state === 'regate') {
      regate(entry)
      return
    }
    if (entry.state !== 'active') return
    send({ type: 'have', key: entry.key, length })
    emit({ event: 'downloaded', key: entry.key, length })
    evaluate()
  }

  function regate (entry) {
    if (entry.gating || entry.state !== 'regate') return
    entry.gating = true
    const core = entry.core
    track(localGate(core, entry.key, association), (reason) => {
      entry.gating = false
      if (entry.state !== 'regate') return
      if (reason) {
        // The seeder served a different block 0 to the replica than to the
        // quarantine: skip and purge, and the run cannot be ok.
        hardError('bloco 0 divergente: ' + key8(entry.key) + ' (' + reason + ')')
        failFollow(entry, reason, { purge: true })
        return
      }
      entry.state = 'active'
      const length = core.contiguousLength
      send({ type: 'have', key: entry.key, length })
      emit({ event: 'downloaded', key: entry.key, length })
      evaluate()
    }, () => {
      entry.gating = false
      if (entry.state !== 'regate') return
      hardError('bloco 0 divergente: ' + key8(entry.key) + ' (not-in-log)')
      failFollow(entry, 'not-in-log', { purge: true })
    })
  }

  function onFork (entry) {
    if (ended) return
    if (entry.state !== 'active' && entry.state !== 'regate') return
    failFollow(entry, 'fork', { purge: true })
  }

  function noteAdvertisement (key, length) {
    if (key === ownHex) return // G2 reads the advertisement itself
    const entry = follows.get(key)
    if (!entry || entry.state !== 'pending' || length < 1) return
    entry.advSeq++
    maybeFetch(entry)
  }

  function maybeFetch (entry) {
    if (ending || deadlineHit || entry.state !== 'pending' || entry.fetching) return
    if (entry.advSeq <= entry.fetchedAdv) return
    const l = seederLink()
    if (l === null || (theirs(entry.key) || 0) < 1) return
    if (fetching >= MAX_PARALLEL_GATES) return
    let fetchTimeout = gateTimeoutMs
    let deadlineBound = false
    if (once) {
      const left = deadline - Date.now()
      if (left < GATE_MIN_TIMEOUT_MS) return
      deadlineBound = left <= gateTimeoutMs
      fetchTimeout = Math.min(gateTimeoutMs, left)
    }
    entry.fetching = true
    fetching++
    entry.cutByDeadline = false
    entry.fetchedAdv = entry.advSeq
    const p = fetchGate(entry, l, fetchTimeout, deadlineBound).finally(() => {
      entry.fetching = false
      fetching--
      inflight.delete(p)
      // A slot freed: start the next pending fetch, then re-check the goals.
      for (const e of follows.values()) {
        if (fetching >= MAX_PARALLEL_GATES) break
        maybeFetch(e)
      }
      evaluate()
    })
    inflight.add(p)
  }

  // Block 0 through a quarantine core in memory on the link's stream.
  // -> { raw, length, byteLength } (raw null on timeout or a closed link).
  async function quarantineGet0 (l, key, fetchTimeout) {
    const q = new Hypercore(memoryStorage(), b4a.from(key, 'hex'), { valueEncoding: 'binary' })
    l.quarantine.add(q)
    try {
      await q.ready()
      if (l.noise.destroyed) return { raw: null, length: 0, byteLength: 0 }
      q.replicate(l.noise)
      let raw = null
      try {
        raw = await q.get(0, { raw: true, timeout: fetchTimeout })
      } catch {}
      if (raw === null) return { raw: null, length: 0, byteLength: 0 }
      return { raw, length: q.length, byteLength: q.byteLength }
    } finally {
      l.quarantine.delete(q)
      await q.close().catch(noop)
    }
  }

  async function fetchGate (entry, l, fetchTimeout, deadlineBound) {
    let r
    try {
      r = await quarantineGet0(l, entry.key, fetchTimeout)
    } catch {
      r = { raw: null, length: 0, byteLength: 0 }
    }
    if (entry.state !== 'pending') return
    if (r.raw === null) {
      softError('bloco 0 indisponível: ' + key8(entry.key))
      if (deadlineBound || deadlineHit) entry.cutByDeadline = true
      if (ending) return
      if (!once) {
        entry.retryTimer = later(() => {
          entry.retryTimer = null
          entry.fetchedAdv = -1
          maybeFetch(entry)
        }, GATE_RETRY_MS)
      }
      return
    }
    if (ending) return
    const reason = gateVerdict(r.raw, entry.key, association)
    if (reason) {
      failFollow(entry, reason, { purge: false })
      return
    }
    // D2: the quota is checked before anything opens in the storage.
    if (overQuota(r)) {
      failFollow(entry, 'quota', { purge: false })
      return
    }
    let core
    try {
      core = await store.openReplica(storage, entry.key)
    } catch (err) {
      if (!ended) log('aviso: falha ao abrir réplica ' + key8(entry.key) + ': ' + err.message)
      return
    }
    if (ending || entry.state !== 'pending') {
      await core.close().catch(noop)
      track(store.purgeReplica(storage, entry.key), noop, () => {
        if (!ended) purgeFailed(entry.key)
        else log('aviso: falha ao limpar diário ' + key8(entry.key))
      })
      return
    }
    enterRegate(entry, core)
    evaluate()
  }

  try {
    diary = await store.openDiary(storage)
    ownHex = hex(diary.key)
    const block0 = await store.readBlock0(diary)
    if (block0 !== null && validateRecord(block0, 0) === null && certForKey(block0.cert, ownHex, association).ok) cert = block0.cert
    else log('sem certificado válido no bloco 0: o diário não será anunciado')

    if (once) deadlineTimer = setTimeout(onDeadline, Math.max(0, deadline - Date.now()))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    }

    // Follow gate at start (R5.8 a), before any connection.
    let followList = await store.readFollows(storage)
    if (followList.length > maxFollows) {
      log('aviso: limite de diários seguidos excedido: só os primeiros ' + maxFollows + ' serão sincronizados')
      followList = followList.slice(0, maxFollows)
    }
    for (const raw of followList) {
      if (ending) break
      const key = typeof raw === 'string' ? raw.toLowerCase() : ''
      if (!HEX64.test(key) || key === ownHex || follows.has(key)) {
        if (key !== ownHex) log('aviso: chave seguida inválida ignorada')
        continue
      }
      const entry = {
        key,
        state: 'pending',
        core: null,
        range: null,
        stopGrow: null,
        stopFork: null,
        stopQuota: null,
        retryTimer: null,
        fetching: false,
        gating: false,
        advSeq: 0,
        fetchedAdv: 0,
        cutByDeadline: false,
        discardedRegate: false
      }
      follows.set(key, entry)
      if (!(await store.replicaExists(storage, key))) continue
      const core = await store.openReplica(storage, key)
      let reason = null
      if (core.fork !== 0) reason = 'fork'
      else if (core.contiguousLength > 0) reason = await localGate(core, key, association)
      if (core.contiguousLength > 0 && reason === null) {
        activate(entry, core)
        continue
      }
      let purged = true
      await track((async () => {
        await core.close()
        await store.purgeReplica(storage, key)
      })(), noop, () => {
        purged = false
        purgeFailed(key)
      })
      if (!purged) break
      if (reason) {
        entry.state = 'failed'
        skipped.push({ key, reason })
        emit({ event: 'skipped', key, reason })
      }
    }

    if (!ending) {
      stopDiaryWatch = watchContiguous(diary, (length) => {
        send({ type: 'have', key: ownHex, length })
        evaluate()
      })
      connect()
    }

    await finished
    return result
  } finally {
    ending = true
    ended = true
    if (deadlineTimer) clearTimeout(deadlineTimer)
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (signal) signal.removeEventListener('abort', onAbort)
    if (stopDiaryWatch) stopDiaryWatch()
    const l = link
    link = null
    if (l !== null) {
      for (const q of l.quarantine) await q.close().catch(noop)
      l.noise.destroy()
    }
    discardRegate() // a throw may have skipped finish()
    await Promise.allSettled([...inflight])
    for (const e of follows.values()) {
      stopEntry(e)
      if (e.core) {
        const core = e.core
        e.core = null
        await core.close().catch(noop)
      }
    }
    while (settling.size > 0) await Promise.allSettled([...settling])
    if (diary) await diary.close().catch(noop)
  }
}

module.exports = { runSync, gateVerdict, GATE_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_PARALLEL_GATES }
