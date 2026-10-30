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
//   active   local gate passed; live download, advertised with its present
//            length (trackPresent: never contiguousLength)
//
// Followed diaries (active and regate) download newest-first: block 0..2,
// then the newest NEWEST_BLOCKS blocks, then the history from block 0
// (trackPresent `newest`, docs/protocol.md section 6 "Browser node download
// order"); the own diary stays oldest-first. Every advertised or measured
// length is still the present length.
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
//
// The own diary is opened read-only here (no key pair: ./node-store.js) and
// DOWNLOADED from the verified seeder as a replica is, so a device that
// holds less than the seeder (a fresh device, or one that missed another
// device's writes) catches up: goal G0 (own present length >= the length
// the seeder advertises). When block 0 arrives on a diary that had none,
// the member certificate is recomputed from it, the diary is announced and
// 'own-recovered' is emitted; the recovery in flight counts as an unmet
// goal. The own-sync events feed the session's write gate:
//   own-synced { length }         the verified seeder's actual hello arrived
//                                 (not the inventory timeout) and the diary
//                                 holds what it advertises, or it advertises
//                                 nothing for the key once the inventory is
//                                 complete (a new diary); once per length
//   own-behind { length, theirs } the seeder advertises more than we hold
//   link-closed                   the link dropped: nothing is tracked
//                                 (preceded by 'seeder-busy' and a warning
//                                 when the socket closed with 1013, the
//                                 seeder at its connection cap)
// They are emitted by checkOwnSync() from the hello / have handlers and the
// diary watcher, in once and continuous runs alike.
//
// Moderation (docs/protocol.md section 3, "Blocklist snapshot"): the newest
// signed snapshot this node accepted is kept in the storage's key-value area
// (./node-store.js readBlocklist / writeBlocklist) and enforced from the
// start of every run, before any connection: a blocked followed diary is
// skipped 'blocked' and every stored replica of a blocked key is purged; a
// diary whose v2 certificate comes from a revoked issuer fails its gates as
// 'revoked-issuer' and is purged the same way. The own diary is never
// deleted: when the own key is blocked it is simply not announced. Newer
// snapshots arrive on the 'varanda/blocklist/1' channel of the SAME seeder
// link (@varanda/core lib/blocklist-net.js), attached as soon as the muxer
// exists but adopted only after the seeder's hello verified. There is no
// second WebSocket and no service worker: offline, the node enforces the
// stored snapshot and refreshes it only when the seeder link is back.
// A snapshot that unblocks the own key (or un-revokes the own certificate's
// issuer) makes the diary announced again on the same link. Enforcement of
// an adopted snapshot is tracked like a purge, so it runs to its end even
// when the run is ending and the result never lists a dropped diary.
//
// Replicas outside the follows: an unfollowed diary keeps its replica
// (./member-ops.js followRemove, still readable with log.read) until the
// next run. The storage cannot list its cores, so every run records the
// keys it follows in the key-value entry 'replicas' ({ v: 1, keys }) and
// purges the stored replica of every indexed key it no longer follows (a
// replica nobody syncs would keep what its author deletes later); one whose
// purge failed stays indexed, and the revocation sweep gates it too. A
// replica unfollowed before this index existed is not known here (a
// documented residual); ./member-ops.js still hides a blocked or revoked
// one from log.read.
//
// Own media cores (kv 'mediaCores', ./node-store.js): each stored one is
// opened read-only at run start through store.openMediaCoreReadOnly (lazy
// 'data'; a listed core that is not stored is skipped, nothing is created)
// and, like the own diary, replicated only on a VERIFIED seeder link. They
// are ours: never announced on the admission channel (not in the hello's
// have, no 'have' message), never downloaded into (no download range), and
// never part of the follow goals or the 'replicas' index. Push confirmation:
// Hypercore 10.38.2 has no core-level remoteContiguousLength; the seeder's
// replicator Peer on this link's stream (found in core.peers) has
// `peer.remoteContiguousLength`, what the seeder advertised it holds. A
// block it downloads from us is NOT advertised back (Peer#broadcastRange
// skips a range the remote already has), so a block counts as held when it
// is below that length OR was served to that peer on this link (the core's
// 'upload' event, whose `from` is the Peer): served means sent with its
// proof, not proven stored; a later link's advertised length is the truth,
// so a link close forgets every confirmation and the next link confirms
// again from its own peer (a reconnect to a seeder that is still behind
// keeps the media pending).
// Checked on 'peer-add' and 'upload', and polled every mediaPollMs while
// the link is verified and some core is not yet confirmed (a range update
// from the seeder raises no event on our core). When blocks 0..length-1
// are all held:
//   media-pushed { key, length }  once per (key, length) per link
// Once runs never wait for media (no goal): the app keeps a continuous run,
// which is where the confirmation arrives.
//
// Readiness (the session's lease, docs/rpc.md 6.1): a continuous run reports
// whether its verified link is SETTLED, i.e. the seeder's inventory is
// complete (not by the inventory timeout), no follow is failing and none of
// the once-run goals G0-G3 is unmet, together with whether some own media
// core with blocks is not yet confirmed pushed at its length:
//   settled { settled, mediaPending }  on every change of either flag; a run
//                                      starts unsettled, so its first report
//                                      comes once the link settled
// It is recomputed wherever a goal can change (checkSettled: evaluate, a
// fetch or purge starting, a replica's signed length growing, a media
// confirmation) and never emitted while the run is ending. Once runs do not
// report it. The session alone decides what to do with it; nothing here
// ends a run for being idle.
//
// The link is closed before the run returns: after the Noise stream is
// destroyed, runSync waits for the socket's 'close' (at most socketCloseMs)
// so the next run of the same session never opens a second socket while
// the previous one is still closing. The wait is on the last socket the run
// opened, whether or not its link is still live: a link whose Noise stream
// closed (the run then waiting to reconnect) may have a socket that is
// still CLOSING.
//
// Follow fold: the own diary's valid `follow` records (decodeBlock +
// validRecordCopy, seq >= 1, the last op per key wins, the own key ignored)
// are replayed incrementally at run start, before any connection (seeded
// from the own tracker's initial scan, so the blocks below its present
// length are decoded once, then a cursor from there), and whenever the own diary is caught up (each own-synced, see
// checkOwnSync), never per downloaded chunk while own-behind: the session
// restarts the continuous run once per distinct follows-changed length, so
// a fresh device's catch-up folds once at its end, and another device's
// writes (small increments that each end own-synced) still fold promptly.
// Once at least one follow record was seen, the derived set goes
// to store.writeFoldedFollows (one call in flight, later growth coalesced;
// tracked, so finish() waits; none started after `ending`), which keeps the
// still-pending local ops on top; when kv follows changed:
//   follows-changed { count, length }  count = the new number of follows,
//                                      length = the own contiguous length folded
// The run's own follow states are not changed live: the session restarts
// the run on follows-changed.
//
// On-demand reads (diary.peek, docs/rpc.md): the session hands in a `peeker`
// and this run publishes its peek function on it (peeker.set) once the
// seeder link verified, withdrawing it (peeker.clear) when the link closes
// or the run ends. A peek is served by the run itself, OUTSIDE the session's
// serial chain: it never opens a storage core, never preempts or restarts
// anything, writes nothing and enters no index. The own diary and the open
// follow cores are read in place (Hypercore 10 refuses a second replication
// channel for a key already on the stream); any other key gets an in-memory
// core on the verified link, gated exactly like a quarantine fetch (block 0
// member certificate for the trusted association, revoked issuers, signed
// length and byteLength within the quota) and closed when the peek ends.
// Every block read is verified by Hypercore against the signed tree. Trust:
// the result is only as fresh as the seeder's claim; a blocked, ungated or
// unknown key answers 'diário indisponível' (never why); a peek the run
// cannot serve any more (ending, link gone) answers 'semeador indisponível'
// and the session retries once on the next verified run. Reads of a peeked
// core are shared between concurrent peeks of the same key on the link.
// The Espiadinha (peek.read, ./peek.js) never rides this link: it opens its
// own short link with an ephemeral key (docs/rpc.md 5.22).
//
// Member reads over the run's cores: the session may hand in a `reader`;
// once the startup sequence opened the own diary and the stored follows
// (just before the first connection) the run publishes { diary, replica,
// hold, release } on it (reader.set), withdrawing it (reader.clear) before
// teardown closes any core and whenever runSync returns or throws. A second
// Hypercore instance on the same storage corrupts it, so the reader only
// ever sees cores this run already holds: replica(key) is the open follow
// core in whatever state, or null, and never opens one (the run opens
// replicas itself mid-run, after a quarantine fetch or a sweep). A hold
// keeps teardown from closing the cores until it is released; none starts
// once the run is ending. Holds do not fence the run's own mid-run closes
// (a failed or forked follow, a re-gate, a sweep, cleared deleted blocks):
// a read that meets a closed core fails and the session reruns it on its
// exclusive path instead.
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { decodeBlock, validateRecord, validRecordCopy, MAX_LOG_BLOCKS, MAX_LOG_BYTES } = require('@varanda/core/lib/records')
const { certForKey, seederCertForKey, verifyUsernameRecord } = require('@varanda/core/lib/cert')
const { attachAdmission, MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { createBlocklistState, compareSnapshots } = require('@varanda/core/lib/blocklist')
const { attachBlocklist } = require('@varanda/core/lib/blocklist-net')
const {
  presentState,
  presentLength,
  deletedRanges,
  clearDeleted
} = require('@varanda/core/lib/deletion')
const { memoryStorage } = require('./storage')
const { guardedWsStream } = require('./ws-stream')
const store = require('./node-store')

const GATE_TIMEOUT_MS = 15000
const GATE_MIN_TIMEOUT_MS = 250
const GATE_RETRY_MS = 15000
// Quarantine fetches in flight at once (a browser tab, not a server).
const MAX_PARALLEL_GATES = 8
// Stored follows opened (and gated locally) at once at run start.
const MAX_PARALLEL_OPENS = 8
// One deadline for the WebSocket, the Noise handshake and the seeder's hello.
const CONNECT_TIMEOUT_MS = 15000
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30000
// Push confirmation poll of the own media cores (see the header).
const MEDIA_POLL_MS = 1000
// Longest wait for the socket's close after the run destroyed its link.
const SOCKET_CLOSE_MS = 1000
const SOCKET_CLOSED = 3 // WebSocket.CLOSED

const HEX64 = /^[0-9a-f]{64}$/
const REPLICA_INDEX = 'replicas'
// diary.peek outcomes (the session maps both to NOT_FOUND).
const SEEDER_UNAVAILABLE = 'semeador indisponível'
const DIARY_UNAVAILABLE = 'diário indisponível'

function noop () {}

const NO_READER = { set: noop, clear: noop }

function key8 (hex) {
  return String(hex).slice(0, 8)
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

// Block-0 verdict (docs §5, identical in the seeder and lib/sync.js):
// null = accepted. opts = { revokedIssuers } (the current snapshot's revoked
// issuer keys): a v2 certificate from one of them is 'revoked-issuer'.
function gateVerdict (raw, keyHex, associationHex, opts) {
  try {
    const block0 = decodeBlock(raw)
    if (block0 === null || validateRecord(block0, 0) !== null) return 'not-in-log'
    const r = certForKey(block0.cert, keyHex, associationHex, opts)
    return r.ok ? null : r.reason
  } catch {
    return 'not-in-log'
  }
}

async function localGate (core, keyHex, associationHex, opts) {
  try {
    const raw = await core.get(0, { wait: false, raw: true })
    return gateVerdict(raw, keyHex, associationHex, opts)
  } catch {
    return 'not-in-log'
  }
}

// The keys recorded in the 'replicas' entry (see the header); a torn value
// reads as empty, an IndexedDB failure throws.
async function readReplicaIndex (storage) {
  let data = null
  try {
    data = await storage.readJson(REPLICA_INDEX)
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
  }
  const keys = new Set()
  if (data && data.v === 1 && Array.isArray(data.keys)) {
    for (const k of data.keys) if (typeof k === 'string' && HEX64.test(k)) keys.add(k)
  }
  return keys
}

// Resolves once the socket reports CLOSED (its 'close' event, or right away
// when it already is), or after maxMs: a peer that never answers the close
// handshake must not hold the run. Never rejects.
function socketClosed (socket, maxMs) {
  return new Promise((resolve) => {
    let timer = null
    const done = () => {
      clearTimeout(timer)
      try { socket.removeEventListener('close', done) } catch {}
      resolve()
    }
    try {
      if (socket.readyState === SOCKET_CLOSED) return resolve()
      socket.addEventListener('close', done)
    } catch {
      return resolve()
    }
    timer = setTimeout(done, maxMs)
  })
}

// Hypercore keeps its ranges in an array that every add and remove walks,
// so a handle never opens more than this many at once. Past the cap the
// deleted seqs sit inside the live tail range, where a stale peer can
// still serve one (cleared again on download, but churn), so the cap is
// high enough that a person who deleted many posts keeps exact gaps: it
// only bites on crafted diaries with thousands of gaps.
const MAX_RANGES = 1024

// Whether blocks [start, end) are all local already (a read error: no).
async function localRange (core, start, end) {
  try {
    return await core.has(start, end)
  } catch {
    return false
  }
}

// @varanda/core lib/deletion.js downloadExcept with linear ranges: a diary
// downloads in block order, so its prefix (what readAll shows) is readable
// early. One range per gap between deleted seqs that is not already local,
// at most MAX_RANGES - 1 of them, then one live range to the end; a deleted
// seq that still arrives (a request already answered, or one inside the
// live range past the cap) is cleared. The seqs given at creation were
// cleared by the caller; an update clears only the seqs new to the set and
// reopens the ranges only when they change: a set that only grew inside
// the live range of a capped handle keeps them. Opens and updates run one
// at a time.
function linearExcept (core, deleted) {
  let current = []
  let currentSet = new Set()
  let ranges = []
  let destroyed = false
  let tailStart = 0
  let capped = false
  const tried = new Set()
  const close = () => {
    for (const r of ranges) {
      try { r.destroy() } catch {}
    }
    ranges = []
  }
  const open = async () => {
    const gaps = []
    let start = 0
    let cap = false
    for (const seq of current) {
      if (gaps.length / 2 >= MAX_RANGES - 1) {
        cap = true
        break
      }
      if (seq > start && !(await localRange(core, start, seq))) gaps.push(start, seq)
      if (destroyed) return
      start = seq + 1
    }
    if (destroyed) return
    close()
    capped = cap
    tailStart = start
    for (let g = 0; g < gaps.length; g += 2) ranges.push(core.download({ start: gaps[g], end: gaps[g + 1], linear: true }))
    ranges.push(core.download({ start, end: -1, linear: true }))
  }
  const onDownload = (index) => {
    if (currentSet.has(index)) clearDeleted(core, [index]).catch(noop)
  }
  const set = (next) => {
    currentSet = new Set([...next].filter((s) => Number.isSafeInteger(s) && s > 0))
    current = [...currentSet].sort((a, b) => a - b)
  }
  set(deleted)
  for (const seq of current) tried.add(seq)
  core.on('download', onDownload)
  let chain = open().catch(noop)
  const update = async (next) => {
    if (destroyed) return []
    const before = currentSet
    set(next)
    let shrunk = false
    for (const seq of before) {
      if (currentSet.has(seq)) continue
      shrunk = true
      tried.delete(seq)
    }
    let reopen = shrunk
    for (const seq of current) {
      if (reopen) break
      if (!before.has(seq) && (!capped || seq < tailStart)) reopen = true
    }
    if (reopen) await open()
    const fresh = []
    for (const seq of current) {
      if (tried.has(seq)) continue
      tried.add(seq)
      fresh.push(seq)
    }
    return clearDeleted(core, fresh)
  }
  return {
    update (next) {
      const run = chain.then(() => update(next))
      chain = run.catch(noop)
      return run
    },
    destroy () {
      destroyed = true
      core.off('download', onDownload)
      close()
    }
  }
}

// A block whose read failed (it may be a tombstone) is read again after this
// delay, this many times; after that only on a later step. It stays out of
// the reported length until it is read.
const TOMB_RETRY_MS = 250
const TOMB_RETRY_MAX = 5

// Newest-first download of a followed diary (trackPresent `newest`): the
// window is one A Rua page (FEED_LIMIT_MAX is 31), the head also asks for
// blocks 0..HEAD_LOW-1 (block 0 and where the first profile usually is,
// the Espiadinha's window), and a window that brings no block for
// HEAD_STALL_MS gives way to the history.
const NEWEST_BLOCKS = 32
const HEAD_LOW = 3
const HEAD_STALL_MS = 3000

// Target seq of the valid tombstone at block seq, null for any other block,
// undefined for a read error (the checks of tombstoneAt, block read once).
async function tombstoneTarget (core, seq) {
  try {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq >= core.length || !(await core.has(seq))) return null
    const copy = validRecordCopy(decodeBlock(await core.get(seq, { wait: false, raw: true })), seq)
    return copy !== null && copy.type === 'delete' ? copy.seq : null
  } catch {
    return undefined
  }
}

// The deletion fold (deletedSeqs) over tombstones already validated, as
// seq -> target, so a step never copies the records it already checked.
function foldTargets (tombs) {
  const deleted = new Set()
  for (const seq of [...tombs.keys()].sort((a, b) => b - a)) {
    if (!deleted.has(seq)) deleted.add(tombs.get(seq))
  }
  return deleted
}

// The present length of a diary core (own or followed) and what deletions
// hide in it (@varanda/core lib/deletion.js). contiguousLength is never the
// end: Hypercore 10 does not keep its lowered value across a reopen after a
// clear, and a cleared block pins it. Every arriving block is checked for a
// tombstone, whatever the prefix (a tombstone above a hole nobody serves
// any more is what lets the present length pass it); the blocks the fold
// deletes are never asked for (linearExcept) and are cleared unless
// noClear. Events are handled one at a time after the initial scan, and
// at most one step waits behind the running one: events that arrive
// meanwhile merge into it, so a burst of blocks costs a few steps, not one
// fold and one present-length walk per block.
// -> { ready, present (), deleted (), destroy (), steps () }, steps() being
// the number of steps run (test-only). onScan(state) with the initial
// presentState result, before anything else uses it; onReady(present) once
// the initial scan is done; onGrow(present) when the present length grows
// after it; onDeleted(deleted) whenever the deleted set changed (and after
// the initial scan when it is not empty); onError(err) once when the
// initial scan fails (the tracker then stops, with present 0).
//
// newest > 0 (followed diaries in the browser) downloads in two strict
// phases, never both at once: Hypercore 10.38.2 picks among a core's open
// ranges at random, so a newest range open next to the history range would
// get about half of the requests. The HEAD asks for block 0..HEAD_LOW-1
// (only those while block 0 is missing), waits for the signed length when
// expect(length) announced more than the core knows (nothing is requested
// past the signed length), then asks for the newest `newest` blocks below
// it, split around deleted seqs. The BODY is the linear download above,
// from block 0. The body runs when the newest window already reaches the
// prefix (a small diary: newest 0 behaves exactly so), once the window is
// all stored or deleted, or when it brought no block for stallMs (the
// seeder may lack it); a target that grows past that and leaves the
// history more than `newest` blocks behind runs the head again. The
// reported length stays the present length on both phases.
// -> also expect(length), the length a seeder advertised (a hint only).
function trackPresent (core, { noClear = false, download = true, newest = 0, stallMs = HEAD_STALL_MS, onScan = noop, onReady = noop, onGrow = noop, onDeleted = noop, onError = noop }) {
  const tombs = new Map() // seq -> target of each local valid tombstone
  const retry = new Map() // index -> failed reads of a block not yet learned
  let deleted = new Set()
  let present = 0
  let range = null
  let stopped = false
  let chain = Promise.resolve()
  let waiting = false
  let steps = 0
  let timer = null
  const arrived = []
  let scheduling = false // the initial scan is done: schedule() decides
  let phase = null // 'head' | 'body'
  let heads = []
  let headKey = ''
  let hint = 0
  let bodyAt = -1 // the target the body was chosen for (window done or stalled)
  let stall = null

  const sameSet = (a, b) => a.size === b.size && [...a].every((s) => b.has(s))
  const learn = async (index) => {
    if (tombs.has(index)) return false
    const target = await tombstoneTarget(core, index)
    if (target === undefined) {
      retry.set(index, (retry.get(index) || 0) + 1)
      return false
    }
    retry.delete(index)
    if (target === null || tombs.has(index)) return false
    tombs.set(index, target)
    return true
  }
  // A length never covers a block whose read failed: it may be a tombstone.
  const capped = (len) => {
    for (const index of retry.keys()) len = Math.min(len, index)
    return len
  }
  // A quiet link still retries the failed reads.
  const later = () => {
    if (stopped || timer !== null) return
    if (![...retry.values()].some((failed) => failed < TOMB_RETRY_MAX)) return
    timer = setTimeout(() => {
      timer = null
      queue()
    }, TOMB_RETRY_MS)
  }
  const apply = async (next) => {
    let from = present
    for (const seq of deleted) {
      if (!next.has(seq)) {
        from = 0
        break
      }
    }
    deleted = next
    if (range !== null) await range.update(next)
    else if (!noClear) await clearDeleted(core, next)
    return from
  }
  const openBody = () => {
    if (!download) return
    if (noClear) {
      const plain = core.download({ start: 0, end: -1, linear: true })
      range = { update: async () => [], destroy: () => plain.destroy() }
    } else {
      range = linearExcept(core, deleted)
    }
  }

  // Learns the blocks that arrived, applies what they delete and walks the
  // present length from `from`, again while a block below it arrived
  // during the awaits: a reported length never covers a tombstone that is
  // stored but not yet applied. -> the length, null once stopped.
  const settle = async (from) => {
    for (;;) {
      let learned = false
      for (const index of arrived.splice(0)) {
        if (await learn(index)) learned = true
      }
      if (learned) {
        const next = foldTargets(tombs)
        if (!sameSet(next, deleted)) from = Math.min(from, await apply(next))
      }
      if (stopped) return null
      const len = await presentLength(core, deleted, from)
      if (stopped) return null
      if (!arrived.some((index) => index < len)) return capped(len)
    }
  }

  const closeHeads = () => {
    for (const r of heads) {
      try { r.destroy() } catch {}
    }
    heads = []
    headKey = ''
  }
  const clearStall = () => {
    if (stall !== null) clearTimeout(stall)
    stall = null
  }
  const armStall = () => {
    clearStall()
    if (stopped) return
    stall = setTimeout(() => {
      stall = null
      if (stopped || phase !== 'head') return
      bodyAt = Math.max(core.length, hint)
      queue()
    }, stallMs)
  }
  const wantHead = (target) => newest > 0 && target > bodyAt && target - newest > Math.max(present, HEAD_LOW)
  // [start, end) without the deleted seqs, as [start, end) pairs.
  const around = (start, end) => {
    const out = []
    let from = start
    for (let i = start; i < end; i++) {
      if (!deleted.has(i)) continue
      if (i > from) out.push([from, i])
      from = i + 1
    }
    if (end > from) out.push([from, end])
    return out
  }
  const closeBody = () => {
    if (range === null) return
    try { range.destroy() } catch {}
    range = null
    // A body update cut short by the close may have left deleted blocks.
    if (!noClear) clearDeleted(core, deleted).catch(noop)
  }
  const toBody = () => {
    if (phase === 'head') {
      closeHeads()
      clearStall()
    }
    phase = 'body'
    if (range === null) openBody()
  }
  const schedule = async () => {
    if (!download || stopped || !scheduling) return
    const len = core.length
    const target = Math.max(len, hint)
    if (!wantHead(target)) return toBody()
    const segs = []
    let done = false
    if (!(await localRange(core, 0, 1))) {
      segs.push(...around(0, HEAD_LOW))
    } else {
      segs.push(...around(0, Math.min(HEAD_LOW, len)))
      if (len >= target) {
        const ws = Math.max(HEAD_LOW, len - newest)
        const window = around(ws, len)
        done = true
        for (const [a, b] of window) {
          if (!(await localRange(core, a, b))) done = false
        }
        segs.push(...window)
      }
    }
    if (stopped) return
    if (done) {
      bodyAt = target
      return toBody()
    }
    closeBody()
    const key = segs.map(([a, b]) => a + '-' + b).join(',')
    if (phase === 'head' && key === headKey) return
    closeHeads()
    phase = 'head'
    headKey = key
    for (const [a, b] of segs) heads.push(core.download({ start: a, end: b, linear: true }))
    armStall()
  }

  const step = async () => {
    if (stopped) return
    steps++
    for (const index of retry.keys()) {
      if (!arrived.includes(index)) arrived.push(index)
    }
    const before = deleted
    const len = await settle(present)
    if (len === null) return
    if (deleted !== before) onDeleted(deleted)
    if (len > present) {
      present = len
      onGrow(len)
    } else {
      present = len
    }
    await schedule()
  }
  const queue = () => {
    if (waiting) return
    waiting = true
    // A step that threw still arms the retry of a failed read.
    chain = chain.then(() => {
      waiting = false
      return step()
    }).catch(noop).then(later)
  }
  const onDownload = (index) => {
    arrived.push(index)
    if (phase === 'head') {
      if (!noClear && deleted.has(index)) clearDeleted(core, [index]).catch(noop)
      armStall()
    }
    queue()
  }
  const onAppend = () => { queue() }
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    core.off('download', onDownload)
    core.off('append', onAppend)
    clearStall()
    closeHeads()
    if (range !== null) {
      try { range.destroy() } catch {}
      range = null
    }
  }

  // Listening first: a block that arrives during the scan is checked again
  // right after it.
  core.on('download', onDownload)
  core.on('append', onAppend)
  const ready = (async () => {
    const state = await presentState(core)
    onScan(state)
    for (const entry of state.raw) {
      const copy = entry.record === null ? null : validRecordCopy(entry.record, entry.seq)
      if (copy !== null && copy.type === 'delete') tombs.set(entry.seq, copy.seq)
    }
    deleted = state.deleted
    present = state.present
    if (stopped) return
    if (!noClear) await clearDeleted(core, deleted)
    if (stopped) return
    scheduling = true
    await schedule()
    if (stopped) return
    const len = await settle(0)
    if (len === null) return
    later()
    present = len
    if (deleted.size > 0) onDeleted(deleted)
    onReady(present)
  })()
  // Fail closed: a replica whose initial scan failed reports no length and
  // takes no more steps, so it is never taken as caught up.
  chain = ready.catch((err) => {
    if (stopped) return
    stop()
    present = 0
    try { onError(err) } catch {}
  })

  return {
    ready,
    present: () => present,
    deleted: () => deleted,
    steps: () => steps,
    // The signed length a seeder advertised: it may only delay the body
    // (by stallMs at most); requests stay below the signed length.
    expect (length) {
      if (!Number.isSafeInteger(length) || length <= hint) return
      hint = length
      if (newest <= 0 || stopped || !scheduling) return
      // Closed now, before a link just attached sends the body's requests.
      if (phase === 'body' && wantHead(Math.max(core.length, hint))) closeBody()
      queue()
    },
    destroy: stop
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
// object (the browser's WebSocket, or the `ws` client in Node). peeker
// (optional): { set (fn), clear (fn) } that receives this run's diary.peek
// function (see the header). The limits and timings after `signal` are
// injectable for tests; their defaults are the protocol constants.
// The session's reader (see the header) is withdrawn however the run ends,
// before it published too.
async function runSync (opts = {}) {
  const reader = (opts && opts.reader) || NO_READER
  try {
    return await syncRun({ ...opts, reader })
  } finally {
    clearReader(reader)
  }
}

function clearReader (reader) {
  try {
    reader.clear()
  } catch {}
}

async function syncRun ({
  storage,
  associationKey = null,
  seederUrl,
  createSocket,
  once = false,
  timeoutMs = 30000,
  log = noop,
  onEvent = noop,
  peeker = null,
  reader = NO_READER,
  signal,
  maxLogBlocks = MAX_LOG_BLOCKS,
  maxLogBytes = MAX_LOG_BYTES,
  maxFollows = MAX_INVENTORY - 1,
  gateTimeoutMs = GATE_TIMEOUT_MS,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  retryMinMs = RETRY_MIN_MS,
  retryMaxMs = RETRY_MAX_MS,
  mediaPollMs = MEDIA_POLL_MS,
  socketCloseMs = SOCKET_CLOSE_MS,
  blocklistMinIntervalMs, // test-only: blocklist-net.js minIntervalMs
  newestBlocks = NEWEST_BLOCKS, // followed diaries: trackPresent `newest`
  headStallMs = HEAD_STALL_MS,
  noClear = false // keep the bytes of deleted blocks (tombstones still apply)
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
  // The stored snapshot is kept only if it still verifies for the trust
  // root (createBlocklistState). A storage failure refuses the run: syncing
  // without knowing what is blocked could fetch a blocked diary again.
  const blocklist = createBlocklistState({
    association,
    load: async () => {
      const data = await store.readBlocklist(storage)
      return data === null ? null : data.snapshot
    },
    save: (snapshot) => store.writeBlocklist(storage, snapshot)
  })
  try {
    await blocklist.ready()
  } catch {
    log('erro: falha ao ler a lista de bloqueio')
    throw new Error('falha ao ler a lista de bloqueio')
  }
  const deadline = Date.now() + timeoutMs

  let diary = null
  let ownHex = null
  let cert = null
  let ownTracker = null // the own diary's present-length tracker (catch-up, G0)
  let recovering = false // block 0 arrived on a diary with no cert: reading it
  let recoveryFailed = false
  let lastOwnSynced = -1 // length last reported as own-synced on this link
  let lastOwnBehind = null // 'length/theirs' last reported as own-behind
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
  let lastSocket = null // the last socket opened, awaited at run end
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
  const isBlockedKey = (key) => blocklist.blocked().has(key)
  const gateOpts = () => ({ revokedIssuers: blocklist.revokedIssuers() })
  let unfollowedReplicas = new Set() // index keys not followed in this run
  const stillFollowed = new Set() // kv follows at run start, over the limit too
  let sweepChain = Promise.resolve() // storage sweeps run one at a time
  const media = [] // own media cores: { key, core, pushed, stop, uploaded, revoked }
  let mediaRevoke = Promise.resolve() // the last revokeOwnMedia pass
  let mediaTimer = null
  const fold = { cursor: 1, seed: null, ops: new Map(), seen: false, running: false, again: false }
  let lastSettled = { settled: false, mediaPending: false } // last 'settled' verdict
  let holds = 0 // reader holds outstanding
  let drained = Promise.resolve() // resolves when holds reaches 0
  let drain = noop

  function hold () {
    if (ending) return false
    if (holds++ === 0) drained = new Promise((resolve) => { drain = resolve })
    return true
  }

  function release () {
    if (holds === 0) return
    if (--holds === 0) drain()
  }

  function replica (key) {
    const e = follows.get(key)
    if (!e || e.core === null || e.core.closing) return null
    return e.core
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
      if (e.state === 'active') have.push({ key: e.key, length: entryPresent(e) })
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
    lastSocket = socket
    // Behind the frame guard with MAX_EXTERNAL_FRAME (a seeder's batches
    // legitimately reach 8 MiB): a frame declaring more is cut at its header
    // and the link closes through onLinkClose (reconnect as for any loss).
    const { ws, stream } = guardedWsStream(socket, {
      onLimit: () => log('aviso: quadro grande demais do semeador')
    })
    const noise = new NoiseSecretStream(true, stream, { keyPair: crypto.keyPair() })
    noise.on('error', noop)
    const l = {
      socket,
      noise,
      ws, // the WebSocketStream: its closeCode tells a full seeder (1013)
      peer: null,
      verified: false,
      hello: false, // the seeder's actual hello arrived (and verified)
      inventoryTimedOut: false, // inventoryComplete came from the timeout
      quarantine: new Set(), // quarantine and peek cores replicating on this link
      peeks: new Map(), // key -> the shared peek core of this link ({ core, ready, refs })
      peek: null, // this link's diary.peek function, published on the peeker
      lastAdv: new Map(), // key -> last length processed (own + follows only)
      emittedHave: new Map(), // key -> last length reported as a 'have' event
      timer: null,
      blocklist: null, // the 'varanda/blocklist/1' handle on this link
      blocklistUnsupported: false, // the seeder does not speak it (pre-B2)
      blocklistOffers: 0, // offers from this link in flight
      blocklistOfferedHave: null, // ordering key of the newest offer from this link that resolved
      verifiedGate: null, // resolves at onVerified, rejects on an unverified close
      passVerified: noop,
      failVerified: noop
    }
    l.verifiedGate = new Promise((resolve, reject) => {
      l.passVerified = resolve
      l.failVerified = reject
    })
    l.verifiedGate.catch(noop)
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
      // The blocklist channel goes on the muxer at once, before the hello,
      // so whichever side opens first is paired (protomux pairs an incoming
      // open only for an opened or `pair`ed protocol); its snapshots are
      // held by offerFromLink until the hello verified.
      attachLinkBlocklist(l)
      l.peer = attachAdmission(l.noise, {
        role: 'member',
        have: inventory(),
        onmessage: (msg, peer) => onMessage(l, msg, peer),
        oninventory: () => {
          checkOwnSync()
          evaluate()
        },
        log: (ev) => {
          if (ev && ev.event === 'inventory-timeout') {
            l.inventoryTimedOut = true
            log('aviso: inventário incompleto (' + key8(ev.peerKey) + ')')
          } else if (ev && ev.event === 'peer-dropped') {
            log('aviso: par descartado (' + key8(ev.peerKey) + '): ' + ev.reason)
          }
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
    // A link that closes unverified never adopts what it sent.
    l.failVerified(new Error('link fechado'))
    withdrawPeek(l)
    // Quarantine fetches and peeks on this link end now (their get() rejects).
    for (const q of l.quarantine) q.close().catch(noop)
    l.quarantine.clear()
    if (link !== l) return
    link = null
    if (ending) return
    // Nothing is tracked until the next link's hello: own-synced is
    // reported again then, even for an unchanged length, and every media
    // core must be confirmed again by the next link (see the header).
    lastOwnSynced = -1
    for (const m of media) m.pushed = -1
    lastOwnBehind = null
    if (l.ws.closeCode === 1013) {
      log('aviso: semeador ocupado; tente novamente em instantes')
      emit({ event: 'seeder-busy' })
    }
    emit({ event: 'link-closed' })
    evaluate()
    reconnectLater()
  }

  function onVerified (l) {
    failures = 0
    clearLater(l.timer)
    l.timer = null
    // Verified: only now are the diary, the own media cores (never
    // announced) and the accepted replicas attached.
    diary.replicate(l.noise)
    for (const m of media) m.core.replicate(l.noise)
    for (const e of follows.values()) {
      if ((e.state === 'active' || e.state === 'regate') && e.core) e.core.replicate(l.noise)
    }
    pollMedia()
    // send() queues until the channel opens, right after hello.
    announceOwn()
    // Snapshots held since the channel opened may now be offered, and our
    // have goes out again so the seeder sends anything newer (C2).
    l.passVerified()
    if (l.blocklist !== null) l.blocklist.announce()
    // On-demand reads are served from this link from now on.
    if (peeker !== null) {
      l.peek = (key, seqs, profileSeq, usernameSeq, deadline) => peek(l, key, seqs, profileSeq, usernameSeq, deadline)
      peeker.set(l.peek)
    }
  }

  function withdrawPeek (l) {
    if (peeker === null || l.peek === null) return
    peeker.clear(l.peek)
    l.peek = null
  }

  // The own diary is announced only with a valid certificate and when the
  // association has neither blocked the key nor revoked the certificate's
  // issuer (the seeder would refuse it; the diary itself is never deleted).
  function announceOwn () {
    if (cert === null || ownRefused()) return
    send({ type: 'announce', key: ownHex, cert })
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
        l.hello = true
        onVerified(l)
        for (const [key, length] of peer.remoteHave) {
          if (relevant(key)) {
            l.lastAdv.set(key, length)
            l.emittedHave.set(key, length)
          }
          noteAdvertisement(key, length)
        }
        checkOwnSync()
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
        if (msg.key === ownHex) checkOwnSync()
        break
      }
      case 'admitted':
        if (!l.verified) return
        if (relevant(msg.key)) l.lastAdv.set(msg.key, msg.length)
        if (msg.key === ownHex) {
          l.admittedOwn = true
          admittedEver = true
          emit({ event: 'admitted', key: msg.key, length: msg.length })
          checkOwnSync()
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
          } else if (!once && (msg.reason === 'blocked' || msg.reason === 'revoked-issuer')) {
            // A moderation drop (the seeder adopted a snapshot refusing the
            // own diary) does not end a continuous run: a later snapshot
            // may allow it again on this link (onOwnModeration).
            rejectedReason = msg.reason
            softError('rejeitado: ' + msg.reason)
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

  // ---- the own diary: catch-up (G0), own-sync events, certificate recovery ----

  // -> { behind, theirs } once the verified seeder's actual hello arrived and
  // the own key's advertisement is known: undefined = not advertised, which
  // means a new diary only after a complete inventory that did not time out
  // (lib/admission.js marks inventoryComplete on a timer too). Else null.
  function ownSyncState () {
    const l = seederLink()
    if (l === null || !l.hello) return null
    const t = theirs(ownHex)
    if (t === undefined) {
      if (!l.peer.inventoryComplete || l.inventoryTimedOut) return null
      return { behind: false, theirs: 0 }
    }
    return { behind: t > ownPresent(), theirs: t }
  }

  // The own diary's present length (trackPresent), never contiguousLength.
  function ownPresent () {
    return ownTracker === null ? 0 : ownTracker.present()
  }

  function entryPresent (entry) {
    return entry.tracker ? entry.tracker.present() : 0
  }

  // Emits own-synced / own-behind whatever the run mode (evaluate() only
  // works for once runs), once per length.
  function checkOwnSync () {
    if (ending) return
    const s = ownSyncState()
    if (s === null) return
    const length = ownPresent()
    if (s.behind) {
      const mark = length + '/' + s.theirs
      if (lastOwnBehind === mark) return
      lastOwnBehind = mark
      emit({ event: 'own-behind', length, theirs: s.theirs })
      return
    }
    if (lastOwnSynced === length) return
    lastOwnSynced = length
    lastOwnBehind = null
    emit({ event: 'own-synced', length })
    // Caught up: fold now (never per downloaded chunk while behind).
    scheduleFold()
  }

  // Block 0 arrived on a diary opened without a certificate (a fresh
  // device): recompute it as at open, announce, and report own-recovered.
  // Tracked, so finish() waits for it; unmetGoals holds the run meanwhile.
  function recoverCert () {
    if (recovering || recoveryFailed || ending || cert !== null || ownPresent() < 1) return
    recovering = true
    track(store.readBlock0(diary), (block0) => {
      recovering = false
      if (ending || cert !== null) return
      if (block0 !== null && validateRecord(block0, 0) === null && certForKey(block0.cert, ownHex, association).ok) {
        cert = block0.cert
        announceOwn()
        emit({ event: 'own-recovered', length: ownPresent() })
      } else {
        recoveryFailed = true
        log('sem certificado válido no bloco 0: o diário não será anunciado')
      }
      evaluate()
    }, () => {
      recovering = false
      recoveryFailed = true
      evaluate()
    })
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
        const ours = entryPresent(e)
        const want = Math.max(e.core.length, t === undefined ? 0 : t)
        if (ours < want) unmet.push(e.key + ':' + ours + '/' + want)
      }
    }
    // G0: the own diary holds what the verified seeder advertises for it,
    // and no certificate recovery is in flight (regardless of cert: a fresh
    // device has none until block 0 arrives). As ownSyncState: an own key
    // not advertised counts as "nothing held" only when the inventory
    // completed for real; after the inventory timeout what the seeder
    // holds is unknown and the goal stays unmet.
    const own = theirs(ownHex)
    const l = seederLink()
    if (own === undefined) {
      if (l !== null && l.inventoryTimedOut) unmet.push(ownHex + ':' + ownPresent() + '/?')
      else if (recovering) unmet.push(ownHex + ':recovering')
    } else if (own > ownPresent()) {
      unmet.push(ownHex + ':' + ownPresent() + '/' + own)
    } else if (recovering) {
      unmet.push(ownHex + ':recovering')
    }
    // G2 (a refused own diary is never announced, so never held)
    if (cert && !ownRefused() && seederLink() !== null && !seederHolds()) {
      unmet.push(ownHex + ':' + diary.length + '/' + (theirs(ownHex) || 0))
    }
    // G3: the verified seeder's snapshot is known and not newer than ours
    // (or one it sent was refused), or it does not speak the channel.
    if (l !== null && !blocklistSettled(l)) unmet.push('blocklist')
    return unmet
  }

  function evaluate () {
    checkSettled()
    if (ending || !once || deadlineHit) return
    const l = seederLink()
    if (l === null || !l.peer.inventoryComplete) return
    if (anyFailing()) return
    if (unmetGoals().length === 0) finish(() => [true, []])
  }

  // The readiness report of a continuous run (see the header): the goals of
  // a once run, met on a link whose inventory completed for real, plus the
  // media confirmation; emitted on change only.
  function checkSettled () {
    if (once || ending) return
    const l = seederLink()
    const settled = l !== null && l.hello && l.peer.inventoryComplete && !l.inventoryTimedOut &&
      !anyFailing() && unmetGoals().length === 0
    const mediaPending = settled && media.some((m) => m.core.length > 0 && m.pushed !== m.core.length)
    if (lastSettled.settled === settled && lastSettled.mediaPending === mediaPending) return
    lastSettled = { settled, mediaPending }
    emit({ event: 'settled', settled, mediaPending })
  }

  function buildResult (ok, errors) {
    const downloaded = {}
    const unadvertised = []
    for (const e of follows.values()) {
      if (e.state === 'failed' || e.state === 'failing') continue
      const t = theirs(e.key)
      if (e.state === 'active' && !isBlockedKey(e.key)) downloaded[e.key] = entryPresent(e)
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
    if (link !== null) withdrawPeek(link)
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
    checkSettled()
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
    // A signed length growing ahead of its blocks unsettles the link (G1).
    const check = () => {
      if (entry.core !== core) return
      if (!checkQuota(entry)) checkSettled()
    }
    core.on('append', check)
    entry.stopQuota = () => core.off('append', check)
    entry.stopFork = watchFork(core, () => { onFork(entry) })
    // Growth is on the present length: readAll ends there, and a deleted
    // block is never asked for and is cleared when it arrives anyway.
    const tracker = trackPresent(core, {
      noClear,
      newest: newestBlocks,
      stallMs: headStallMs,
      onReady: (present) => {
        if (entry.core !== core) return
        if (entry.state === 'regate') {
          if (present > 0) regate(entry)
          return
        }
        // An inventory sent or answered before the scan finished saw 0.
        if (entry.state === 'active') onScanned(entry, present)
      },
      onGrow: (length) => {
        if (entry.core === core) onGrow(entry, length)
      },
      // Fail closed: nothing is downloaded, but the follow is reported.
      onError: () => {
        if (ended || entry.core !== core) return
        softError('falha ao ler a réplica de ' + key8(entry.key))
        evaluate()
      }
    })
    entry.tracker = tracker
    entry.stopGrow = () => tracker.destroy()
    expectLength(entry, theirs(entry.key) || 0)
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

  // The initial scan of a stored replica finished: advertise what it holds
  // and judge completion again, as a growth would.
  function onScanned (entry, present) {
    if (ended) return
    if (checkQuota(entry)) return
    if (present > 0) send({ type: 'have', key: entry.key, length: present })
    evaluate()
  }

  function regate (entry) {
    if (entry.gating || entry.state !== 'regate') return
    entry.gating = true
    const core = entry.core
    track(localGate(core, entry.key, association, gateOpts()), (reason) => {
      entry.gating = false
      if (entry.state !== 'regate') return
      if (reason === 'blocked' || reason === 'revoked-issuer') {
        // A snapshot adopted after the quarantine verdict: moderation, not
        // divergent data (the same skip and purge as any blocked author).
        failFollow(entry, reason, { purge: true })
        return
      }
      if (reason) {
        // The seeder served a different block 0 to the replica than to the
        // quarantine: skip and purge, and the run cannot be ok.
        hardError('bloco 0 divergente: ' + key8(entry.key) + ' (' + reason + ')')
        failFollow(entry, reason, { purge: true })
        return
      }
      entry.state = 'active'
      const length = entryPresent(entry)
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

  // A follow's newest window is anchored on its signed length; the
  // seeder's claim only tells the tracker to wait for it.
  function expectLength (entry, length) {
    if (entry.tracker && (entry.state === 'active' || entry.state === 'regate')) {
      entry.tracker.expect(Math.min(length, maxLogBlocks))
    }
  }

  function noteAdvertisement (key, length) {
    if (key === ownHex) return // G2 reads the advertisement itself
    if (isBlockedKey(key)) return
    const entry = follows.get(key)
    if (entry && Number.isSafeInteger(length)) expectLength(entry, length)
    if (!entry || entry.state !== 'pending' || length < 1) return
    entry.advSeq++
    maybeFetch(entry)
  }

  function maybeFetch (entry) {
    if (ending || deadlineHit || entry.state !== 'pending' || entry.fetching) return
    if (isBlockedKey(entry.key)) return
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
    checkSettled()
    const p = fetchGate(entry, l, fetchTimeout, deadlineBound).finally(() => {
      entry.fetching = false
      entry.fetch = null
      fetching--
      inflight.delete(p)
      // A slot freed: start the next pending fetch, then re-check the goals.
      for (const e of follows.values()) {
        if (fetching >= MAX_PARALLEL_GATES) break
        maybeFetch(e)
      }
      evaluate()
    })
    entry.fetch = p // a peek of this key waits for the gate to settle
    inflight.add(p)
  }

  // Block 0 through a quarantine core in memory on the link's stream (shared
  // with any peek of the key in flight, acquireLinkCore).
  // -> { raw, length, byteLength } (raw null on timeout or a closed link).
  async function quarantineGet0 (l, key, fetchTimeout) {
    const none = { raw: null, length: 0, byteLength: 0 }
    let held
    try {
      held = await acquireLinkCore(l, key)
    } catch {
      return none
    }
    const q = held.core
    try {
      if (l.noise.destroyed) return none
      let raw = null
      try {
        raw = await q.get(0, { raw: true, timeout: fetchTimeout })
      } catch {}
      if (raw === null) return none
      return { raw, length: q.length, byteLength: q.byteLength }
    } finally {
      held.release()
      // A peek still sharing the core keeps it on the link: the replica
      // (same discovery key, same stream) opens only once it is closed.
      await held.closed
    }
  }

  // The in-memory core for `key` on link `l`, one per key per link, shared
  // by the quarantine fetch and the peeks in flight for it (Hypercore 10
  // refuses a second replication channel for a discovery key already on the
  // stream) and closed when the last holder releases it; held in
  // l.quarantine so a link close ends its reads. -> { core, release, closed }
  // (closed: resolves once the core is closed).
  function acquireLinkCore (l, key) {
    let shared = l.peeks.get(key)
    if (shared === undefined) {
      const q = new Hypercore(memoryStorage(), b4a.from(key, 'hex'), { valueEncoding: 'binary' })
      l.quarantine.add(q)
      let onClosed
      shared = {
        core: q,
        refs: 0,
        ready: q.ready().then(() => {
          if (l.noise.destroyed) throw unavailable()
          q.replicate(l.noise)
        }),
        closed: new Promise((resolve) => { onClosed = resolve })
      }
      shared.onClosed = onClosed
      l.peeks.set(key, shared)
    }
    shared.refs++
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (--shared.refs > 0) return
      if (l.peeks.get(key) === shared) l.peeks.delete(key)
      l.quarantine.delete(shared.core)
      shared.core.close().catch(noop).then(shared.onClosed)
    }
    return shared.ready.then(() => ({ core: shared.core, release, closed: shared.closed }), (err) => {
      release()
      throw err
    })
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
    if (isBlockedKey(entry.key)) {
      failFollow(entry, 'blocked', { purge: false })
      return
    }
    const reason = gateVerdict(r.raw, entry.key, association, gateOpts())
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

  // ---- on-demand reads: diary.peek (see the header) ----

  function unavailable () {
    return new Error(SEEDER_UNAVAILABLE)
  }

  function hidden () {
    return new Error(DIARY_UNAVAILABLE)
  }

  // Hypercore treats a timeout of 0 as none: never less than 1 ms.
  function budget (deadline) {
    return Math.max(1, deadline - Date.now())
  }

  // -> the peek result (docs/rpc.md diary.peek). key: lowercase hex64;
  // seqs: the requested seqs (each lands in exactly one of entries, invalid
  // or missing); profileSeq / usernameSeq: the seeder's hints (null = none),
  // read only for `profile` / `username`; deadline: the session's.
  async function peek (l, key, seqs, profileSeq, usernameSeq, deadline) {
    if (ending || link !== l || seederLink() !== l) throw unavailable()
    if (isBlockedKey(key)) throw hidden()
    const { core, release } = await lendCore(l, key)
    try {
      const raw0 = key === ownHex ? null : await gatePeek(l, core, key, deadline)
      const result = await readPeek(l, core, key, seqs, profileSeq, usernameSeq, deadline)
      // Moderation and integrity right before answering: a snapshot adopted
      // or a fork seen while the blocks downloaded hides the diary.
      if (isBlockedKey(key)) throw hidden()
      if (raw0 !== null && (core.fork !== 0 || gateVerdict(raw0, key, association, gateOpts()) !== null)) throw hidden()
      return result
    } finally {
      release()
    }
  }

  // The core for `key` on link `l` under the run's ownership rules (a
  // peek, diary.peek): the own diary and an open follow core
  // are the run's (release is a no-op; a follow whose quarantine gate is in
  // flight waits for it, its core is never doubled on the link); a follow
  // in any other state is hidden; any other key gets the link's shared
  // in-memory core. -> { core, release, closed }; throws unavailable() when
  // the link is gone.
  async function lendCore (l, key) {
    if (ending || link !== l || seederLink() !== l) throw unavailable()
    if (key === ownHex) return { core: diary, release: noop, closed: null }
    const entry = follows.get(key)
    if (entry && entry.fetch) await entry.fetch.catch(noop)
    if (ending || link !== l) throw unavailable()
    if (entry && entry.core && (entry.state === 'active' || entry.state === 'regate')) {
      return { core: entry.core, release: noop, closed: null }
    }
    if (entry && entry.state !== 'pending') throw hidden()
    return acquireLinkCore(l, key)
  }

  // The quarantine gate on a peeked core: block 0 within the deadline, the
  // certificate verdict (revoked issuers included), the signed quota, no
  // fork, the blocklist again. Any failure hides the diary. -> raw block 0.
  async function gatePeek (l, core, key, deadline) {
    let raw = null
    try {
      raw = await core.get(0, { raw: true, timeout: budget(deadline) })
    } catch {}
    if (ending || link !== l) throw unavailable()
    if (raw === null || isBlockedKey(key) || core.fork !== 0) throw hidden()
    if (gateVerdict(raw, key, association, gateOpts()) !== null || overQuota(core)) throw hidden()
    return raw
  }

  function deletedOf (core) {
    if (core === diary && ownTracker !== null) return ownTracker.deleted()
    for (const e of follows.values()) {
      if (e.core === core && e.tracker) return e.tracker.deleted()
    }
    return new Set()
  }

  async function readPeek (l, core, key, seqs, profileSeq, usernameSeq, deadline) {
    const wanted = new Set(seqs)
    if (profileSeq !== null) wanted.add(profileSeq)
    if (usernameSeq !== null) wanted.add(usernameSeq)
    // A replica still catching up holds less than the verified seeder
    // advertises: blocks up to that length are asked for (and verified
    // against the signed tree on arrival); beyond it nothing is asked.
    const limit = Math.max(core.length, theirs(key) || 0)
    // A seq the local fold of the own diary or of a followed core knows
    // deleted is never asked for (its bytes are cleared everywhere): it is
    // missing at once. On a temporary core a cleared block simply never
    // arrives and is missing after the timeout.
    const known = deletedOf(core)
    const blocks = new Map() // seq -> raw bytes, or null when absent
    await Promise.all([...wanted].map(async (seq) => {
      let raw = null
      if (seq < limit && !known.has(seq)) {
        try {
          raw = await core.get(seq, { raw: true, timeout: budget(deadline) })
        } catch {
          if (ending || link !== l) throw unavailable()
          // A core closed under the read (the run dropped the follow): hidden.
          if (core.closing) throw hidden()
        }
      }
      blocks.set(seq, raw)
    }))
    const decoded = (seq) => {
      const raw = blocks.get(seq)
      return raw === null || raw === undefined ? null : validRecordCopy(decodeBlock(raw), seq)
    }
    const entries = []
    const invalid = []
    const missing = []
    for (const seq of seqs) {
      if (blocks.get(seq) === null) {
        missing.push(seq)
        continue
      }
      const record = decoded(seq)
      if (record === null) invalid.push(seq)
      else entries.push({ seq, record })
    }
    const profile = profileSeq === null ? null : decoded(profileSeq)
    const username = usernameSeq === null ? null : decoded(usernameSeq)
    return {
      key,
      length: core.length,
      entries,
      invalid,
      missing,
      profile: profile !== null && profile.type === 'profile' ? { name: profile.name, bio: profile.bio, avatar: profile.avatar === undefined ? null : profile.avatar } : null,
      username: username !== null && username.type === 'username' && verifyUsernameRecord(username, key, association, gateOpts()).ok
        ? username.username
        : null
    }
  }

  // ---- moderation: the blocklist snapshot ----

  let warnedOwnBlocked = false
  let warnedOwnRevoked = false

  // Whether the association refuses the own diary (blocked key, or a v2
  // certificate from a revoked issuer: `cert` was verified when it was set).
  // Warns once per run.
  function ownRefused () {
    if (ownHex === null) return false
    if (isBlockedKey(ownHex)) {
      if (!warnedOwnBlocked) {
        warnedOwnBlocked = true
        log('aviso: sua identidade está bloqueada pela associação')
      }
      return true
    }
    if (cert !== null && cert.v === 2 && blocklist.revokedIssuers().has(cert.issuer)) {
      if (!warnedOwnRevoked) {
        warnedOwnRevoked = true
        log('aviso: o emissor do seu certificado foi revogado pela associação')
      }
      return true
    }
    return false
  }

  function attachLinkBlocklist (l) {
    l.blocklist = attachBlocklist(l.noise, {
      current: blocklist.current,
      offer: (snapshot) => offerFromLink(l, snapshot),
      compare: compareSnapshots,
      ...(blocklistMinIntervalMs === undefined ? {} : { minIntervalMs: blocklistMinIntervalMs }),
      onhave: () => evaluate(),
      log: (ev) => {
        if (ev && ev.event === 'peer-dropped') log('aviso: par descartado (' + key8(ev.peerKey) + '): ' + ev.reason)
      }
    })
    l.blocklist.supported.then((ok) => {
      if (ok || link !== l) return
      l.blocklistUnsupported = true
      evaluate()
    }, noop)
  }

  function blocklistSettled (l) {
    if (l.blocklistUnsupported) return true
    if (l.blocklist === null || l.blocklistOffers > 0) return false
    const remote = l.blocklist.remoteHave
    if (remote === null) return false
    if (compareSnapshots(blocklist.current(), remote) >= 0) return true
    // The seeder's newest was offered and refused (forged, stale): nothing
    // newer to wait for from this link.
    return l.blocklistOfferedHave !== null && compareSnapshots(l.blocklistOfferedHave, remote) >= 0
  }

  // Snapshots from the link wait for the hello to verify: an endpoint that
  // is not a certified seeder never changes what this node enforces. A
  // rejection is a local failure to blocklist-net.js (it retries while the
  // connection lives), never a bad message from the peer.
  async function offerFromLink (l, snapshot) {
    await l.verifiedGate
    if (ending || link !== l) throw new Error('fora da sincronização')
    l.blocklistOffers++
    // The save and the enforcement of what it adopted are ONE tracked unit:
    // a snapshot saved while the run is ending (timeout, cancel) is still
    // enforced, and finish() builds the result only after its purges were
    // tracked (onAdopted tracks them synchronously, before the unit settles).
    let r
    let error = null
    const unit = (async () => {
      try {
        r = await blocklist.offer(snapshot)
      } catch (err) {
        error = err
        return
      }
      if (r.adopted) onAdopted(r)
    })()
    track(unit, noop, noop)
    await unit
    l.blocklistOffers--
    if (error !== null) {
      if (!ended) log('aviso: falha ao gravar a lista de bloqueio')
      evaluate()
      throw error
    }
    // Settles G3 only for what this offer covered: a newer snapshot the
    // seeder advertises later keeps the run open until it is offered too.
    const offered = { moderatorDate: snapshot && snapshot.moderatorDate, seq: snapshot && snapshot.seq }
    if (l.blocklistOfferedHave === null || compareSnapshots(offered, l.blocklistOfferedHave) > 0) {
      l.blocklistOfferedHave = offered
    }
    evaluate()
    return r
  }

  // A snapshot was adopted (and saved): enforced whatever the run's state.
  // The web node holds one link, so there is no other blocklist handle to
  // announce it to (C4).
  function onAdopted (r) {
    onOwnModeration(r)
    sweepBlocked()
    if (r.revokedAdded.size > 0) {
      regateRevoked()
      sweepRevoked()
    }
  }

  // The own diary's standing, recomputed both ways from the adopted
  // snapshot (the sets say what it was before the swap). Newly refused: the
  // seeder drops it, so a later admission must be fresh (G2). Allowed again:
  // announced at once on the current link, and G2 applies again.
  function onOwnModeration ({ added, removed, revokedAdded, revokedRemoved }) {
    if (ownHex === null) return
    const issuer = cert !== null && cert.v === 2 ? cert.issuer : null
    const nowBlocked = isBlockedKey(ownHex)
    const nowRevoked = issuer !== null && blocklist.revokedIssuers().has(issuer)
    const wasBlocked = nowBlocked ? !added.has(ownHex) : removed.has(ownHex)
    const wasRevoked = issuer !== null && (nowRevoked ? !revokedAdded.has(issuer) : revokedRemoved.has(issuer))
    // A later refusal warns again.
    if (!nowBlocked) warnedOwnBlocked = false
    if (!nowRevoked) warnedOwnRevoked = false
    const l = seederLink()
    if (nowBlocked || nowRevoked) {
      ownRefused()
      if (!wasBlocked && !wasRevoked && l !== null) l.admittedOwn = false
      return
    }
    if (!wasBlocked && !wasRevoked) return
    if (l !== null) l.admittedOwn = false
    if (ending) return
    announceOwn()
    evaluate()
  }

  // Storage sweeps (blocked, revoked) never overlap: two of them must not
  // open or purge the same replica at once.
  function serialSweep (fn) {
    const p = sweepChain.then(fn)
    sweepChain = p.catch(noop)
    return p
  }

  // Every blocked key other than the own one: a follow not yet failed fails
  // 'blocked' and is purged; whatever the storage still holds for any other
  // blocked key (a failed follow, an unfollowed diary) is purged directly
  // (C7: failFollow returns at once for a failing/failed entry, and a quota
  // failure keeps an active replica's blocks). -> the tracked sweep.
  function sweepBlocked () {
    const direct = []
    const cores = []
    for (const key of blocklist.blocked()) {
      if (key === ownHex) continue
      const entry = follows.get(key)
      if (entry && entry.state !== 'failing' && entry.state !== 'failed') {
        failFollow(entry, 'blocked', { purge: true })
        continue
      }
      if (entry && entry.state === 'failing') continue // its purge is in flight
      if (entry && entry.core) {
        cores.push(entry.core)
        entry.core = null
      }
      direct.push(key)
    }
    return track(serialSweep(async () => {
      for (const core of cores) await core.close()
      for (const key of direct) {
        if (await store.replicaExists(storage, key)) await store.purgeReplica(storage, key)
      }
    }), noop, () => {
      if (!ended) fail(['falha ao limpar diário bloqueado'])
      else log('aviso: falha ao limpar diário bloqueado')
    })
  }

  // A newly revoked issuer: every accepted replica is gated again with the
  // new set, and one whose certificate comes from that issuer fails
  // 'revoked-issuer' and is purged.
  function regateRevoked () {
    for (const entry of follows.values()) {
      if ((entry.state !== 'active' && entry.state !== 'regate') || !entry.core) continue
      const core = entry.core
      track(localGate(core, entry.key, association, gateOpts()), (reason) => {
        if (reason !== 'revoked-issuer' || entry.core !== core) return
        if (entry.state !== 'active' && entry.state !== 'regate') return
        failFollow(entry, reason, { purge: true })
      }, noop)
    }
  }

  // Stored replicas the follow states do not cover (an unfollowed diary, a
  // failed follow that kept its blocks): one whose block-0 v2 certificate
  // comes from a revoked issuer is purged. Never the own diary; a blocked
  // key is sweepBlocked's. -> the tracked sweep.
  function sweepRevoked () {
    const cores = []
    const keys = []
    for (const key of unfollowedReplicas) {
      if (key !== ownHex && !follows.has(key) && !isBlockedKey(key)) keys.push(key)
    }
    for (const entry of follows.values()) {
      if (entry.state !== 'failed' || isBlockedKey(entry.key)) continue
      if (entry.core) {
        cores.push(entry.core)
        entry.core = null
      }
      keys.push(entry.key)
    }
    return track(serialSweep(async () => {
      for (const core of cores) await core.close()
      for (const key of keys) {
        if (!(await store.replicaExists(storage, key))) continue
        const core = await store.openReplica(storage, key)
        let reason
        try {
          reason = await localGate(core, key, association, gateOpts())
        } finally {
          await core.close()
        }
        if (reason === 'revoked-issuer') await store.purgeReplica(storage, key)
      }
    }), noop, () => {
      if (!ended) fail(['falha ao limpar diário de emissor revogado'])
      else log('aviso: falha ao limpar diário de emissor revogado')
    })
  }

  // Records this run's follows in the 'replicas' index and purges the
  // stored replica of every indexed key no longer followed: nobody keeps it
  // in sync any more, so a deletion its author makes later would never be
  // cleared from it. A key whose purge failed stays indexed (and in the
  // revocation sweep). Best effort: a failure only narrows what the sweeps
  // can reach. Under noClear nothing is purged (as the node's
  // sweepUnfollowed under the kill switch): the key stays indexed.
  async function updateReplicaIndex () {
    try {
      const previous = await readReplicaIndex(storage)
      const next = new Set()
      for (const key of previous) {
        if (key === ownHex || follows.has(key)) continue
        if (!(await store.replicaExists(storage, key))) continue
        // Over the follow limit is still followed, only not synced now.
        if (stillFollowed.has(key) || noClear) {
          next.add(key)
          continue
        }
        try {
          await store.purgeReplica(storage, key)
        } catch {
          next.add(key)
        }
      }
      unfollowedReplicas = new Set(next)
      for (const key of follows.keys()) next.add(key)
      const same = next.size === previous.size && [...next].every((k) => previous.has(k))
      if (!same) await storage.writeJson(REPLICA_INDEX, { v: 1, keys: [...next].sort() })
    } catch {
      log('aviso: falha ao atualizar o índice de réplicas')
    }
  }

  // ---- own media cores: replicated, never announced; push confirmation ----

  // The stored own media cores, read-only (see the header). A core that
  // fails to open is skipped with a warning: media never fails a run.
  async function openOwnMedia () {
    let keys = []
    try {
      keys = await store.readMediaCores(storage)
    } catch {
      log('aviso: falha ao ler os núcleos de mídia')
      return
    }
    for (const key of keys) {
      if (ending) return
      if (key === ownHex || media.some((m) => m.key === key)) continue
      let core = null
      try {
        core = await store.openMediaCoreReadOnly(storage, key)
      } catch {
        log('aviso: falha ao abrir o núcleo de mídia ' + key8(key))
        continue
      }
      if (core === null) continue
      // uploaded: replicator Peer -> the block indexes served to it.
      // revoked: block indexes a tombstone of the own diary deleted.
      const m = { key, core, pushed: -1, stop: null, uploaded: new WeakMap(), revoked: new Set() }
      const onPeer = () => {
        checkMedia()
        pollMedia()
      }
      const onUpload = (index, byteLength, from) => {
        if (from) {
          let set = m.uploaded.get(from)
          if (set === undefined) m.uploaded.set(from, (set = new Set()))
          set.add(index)
        }
        onPeer()
      }
      core.on('peer-add', onPeer)
      core.on('upload', onUpload)
      m.stop = () => {
        core.off('peer-add', onPeer)
        core.off('upload', onUpload)
      }
      media.push(m)
    }
  }

  // Whether the seeder peer of the verified link holds blocks 0..length-1
  // of a media core: below its remoteContiguousLength, in its remote
  // bitfield (what it advertised, Hypercore 10.38.2: per replicator Peer;
  // a seeder that cleared a deleted block advertises a contiguous range
  // pinned at it and the rest as a bitfield) or served to it on this link
  // (the 'upload' event; its range broadcast is skipped for a block we
  // already have, so the advertised length alone never grows). A revoked
  // (deleted) block counts as held: nobody keeps it, so it must not stall
  // the confirmation of the photos that survive.
  function seederHoldsMedia (m, l, length) {
    for (const peer of m.core.peers) {
      if (peer.stream !== l.noise) continue
      const uploaded = m.uploaded.get(peer)
      for (let i = peer.remoteContiguousLength; i < length; i++) {
        if (m.revoked.has(i) || peer.remoteBitfield.get(i)) continue
        if (uploaded === undefined || !uploaded.has(i)) {
          // A new link only learns the seeder's contiguous range at open:
          // ask once per segment for its bitfield past it (Hypercore 10.38.2
          // Peer#_maybeWant, the request path's own call; the seeder
          // answers with bitfield messages), so blocks held past a cleared
          // one are confirmed on the next check.
          if (typeof peer._maybeWant === 'function') {
            try { peer._maybeWant(i, length - i) } catch {}
          }
          return false
        }
      }
      return true
    }
    return false
  }

  // The own diary's effective tombstones name media ranges (in cores the
  // diary declared, no surviving post or profile overlapping): each range
  // of an open own media core is revoked (seederHoldsMedia) and, unless
  // noClear, cleared. Re-run on every change of the deleted set (a deletion
  // made on another device arrives as a downloaded tombstone); tracked.
  function revokeOwnMedia () {
    if (media.length === 0) return
    mediaRevoke = track((async () => {
      const state = await presentState(diary)
      for (const r of deletedRanges(state.raw, media.map((m) => m.key))) {
        const m = media.find((x) => x.key === r.core)
        if (m === undefined) continue
        for (let i = Math.max(1, r.start); i < r.start + r.blocks; i++) m.revoked.add(i)
        if (!noClear) await store.clearMediaRanges(m.core, [r])
      }
      checkMedia()
    })(), noop, () => {
      if (!ended) log('aviso: falha ao limpar fotos apagadas')
    })
  }

  function checkMedia () {
    const l = seederLink()
    if (l === null || ended) return
    for (const m of media) {
      const length = m.core.length
      if (length < 1 || m.pushed === length) continue
      if (seederHoldsMedia(m, l, length)) {
        m.pushed = length
        emit({ event: 'media-pushed', key: m.key, length })
      }
    }
    checkSettled()
  }

  // The light poll runs only while the link is verified and some core is
  // not yet confirmed at its length.
  function pollMedia () {
    if (mediaTimer !== null || ending) return
    if (seederLink() === null) return
    if (!media.some((m) => m.core.length > 0 && m.pushed !== m.core.length)) return
    mediaTimer = later(() => {
      mediaTimer = null
      checkMedia()
      pollMedia()
    }, mediaPollMs)
  }

  // ---- the follow fold (see the header) ----

  // Replays the own diary's follow records from the cursor up to its
  // present length -> the length replayed. A block below it that is not
  // held, or that the fold deleted, has no effect.
  async function replayFollows () {
    const length = ownPresent()
    const deleted = ownTracker === null ? new Set() : ownTracker.deleted()
    if (fold.seed !== null) {
      for (const record of fold.seed) {
        if (deleted.has(record.seq)) continue
        fold.seen = true
        if (record.key === ownHex) continue
        fold.ops.set(record.key, record.on)
      }
      fold.seed = null
    }
    // The cursor passes a seq only once it was handled: a throw leaves it
    // there, so the next fold retries it.
    for (let seq = fold.cursor; seq < length; seq = ++fold.cursor) {
      if (deleted.has(seq) || !(await diary.has(seq))) continue
      const record = validRecordCopy(decodeBlock(await diary.get(seq, { wait: false, raw: true })), seq)
      if (record === null || record.type !== 'follow') continue
      fold.seen = true
      if (record.key === ownHex) continue
      fold.ops.set(record.key, record.on)
    }
    return length
  }

  async function foldLoop () {
    do {
      fold.again = false
      const length = await replayFollows()
      if (!fold.seen) continue
      const derived = [...fold.ops].filter(([, on]) => on).map(([key]) => key)
      const r = await store.writeFoldedFollows(storage, derived, ownHex)
      if (r && r.changed === true) emit({ event: 'follows-changed', count: r.follows.length, length })
    } while (fold.again)
  }

  // The follow records of the own tracker's initial scan below its present
  // length, in seq order, kept until the first fold applies them with the
  // deleted set of that moment (as reading them there would); the cursor
  // starts past them.
  function seedFold (state) {
    const seed = []
    for (const entry of state.raw) {
      if (entry.seq < 1 || entry.seq >= state.present || entry.record === null) continue
      const record = validRecordCopy(entry.record, entry.seq)
      if (record === null || record.type !== 'follow') continue
      seed.push({ seq: entry.seq, key: record.key, on: record.on })
    }
    fold.seed = seed
    fold.cursor = Math.max(1, state.present)
  }

  function scheduleFold () {
    if (ending) return
    if (fold.running) {
      fold.again = true
      return
    }
    fold.running = true
    track(foldLoop(), () => {
      fold.running = false
    }, () => {
      fold.running = false
      if (!ended) log('aviso: falha ao atualizar os diários seguidos')
    })
  }

  try {
    diary = await store.openDiary(storage)
    ownHex = hex(diary.key)
    const block0 = await store.readBlock0(diary)
    if (block0 !== null && validateRecord(block0, 0) === null && certForKey(block0.cert, ownHex, association).ok) cert = block0.cert
    else log('sem certificado válido no bloco 0: o diário não será anunciado')
    ownRefused()
    await openOwnMedia()
    // Deleted blocks and media are cleared, and growth is measured on the
    // present length, before any connection; whatever the verified seeder
    // holds beyond us is fetched (only a verified link replicates the
    // diary, onVerified), deleted blocks never.
    ownTracker = trackPresent(diary, {
      noClear,
      onScan: seedFold,
      onGrow: (length) => {
        send({ type: 'have', key: ownHex, length })
        if (cert === null) recoverCert()
        checkOwnSync()
        evaluate()
      },
      onDeleted: () => { revokeOwnMedia() }
    })
    await ownTracker.ready
    await mediaRevoke
    // What the own diary already holds is folded before any connection.
    scheduleFold()

    if (once) deadlineTimer = setTimeout(onDeadline, Math.max(0, deadline - Date.now()))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    }

    // Follow gate at start (R5.8 a), before any connection.
    let followList = await store.readFollows(storage)
    for (const k of followList) if (typeof k === 'string') stillFollowed.add(k.toLowerCase())
    if (followList.length > maxFollows) {
      log('aviso: limite de diários seguidos excedido: só os primeiros ' + maxFollows + ' serão sincronizados')
      followList = followList.slice(0, maxFollows)
    }
    // Pass 1, in list order: what is followed and what is blocked.
    const items = []
    const listed = new Set()
    for (const raw of followList) {
      const key = typeof raw === 'string' ? raw.toLowerCase() : ''
      if (!HEX64.test(key) || key === ownHex || listed.has(key)) {
        if (key !== ownHex) log('aviso: chave seguida inválida ignorada')
        continue
      }
      listed.add(key)
      items.push({ key, blocked: isBlockedKey(key) })
    }
    // Pass 2: the stored follows are opened and gated locally, a few at a
    // time (each key once, and nothing else opens a replica before the
    // first connection). A slot touches no shared state; none starts once
    // the run is ending.
    const slots = new Array(items.length).fill(null)
    const opened = items.map(() => {
      let resolve
      const p = new Promise((_resolve) => { resolve = _resolve })
      return { p, resolve }
    })
    const openSlot = async ({ key, blocked }) => {
      const slot = { core: null, reason: null, held0: false, error: null }
      if (blocked) return slot
      try {
        if (ending || !(await store.replicaExists(storage, key)) || ending) return slot
        slot.core = await store.openReplica(storage, key)
        slot.held0 = slot.core.length > 0 && await slot.core.has(0)
        if (slot.core.fork !== 0) slot.reason = 'fork'
        else if (slot.held0) slot.reason = await localGate(slot.core, key, association, gateOpts())
      } catch (err) {
        slot.error = err
        if (slot.core !== null) await slot.core.close().catch(noop)
        slot.core = null
      }
      return slot
    }
    let nextOpen = 0
    const workers = []
    for (let w = 0; w < Math.min(MAX_PARALLEL_OPENS, items.length); w++) {
      workers.push((async () => {
        while (nextOpen < items.length) {
          const i = nextOpen++
          slots[i] = await openSlot(items[i])
          opened[i].resolve(slots[i])
        }
      })())
    }
    // Pass 3, serial and in list order: the follow states, skip events and
    // purges as each slot is ready. A core opened but never taken (the run
    // ending, a failed purge, an error) is closed before going on.
    try {
      for (let i = 0; i < items.length; i++) {
        if (ending) break
        const { key, blocked } = items[i]
        const entry = {
          key,
          state: 'pending',
          core: null,
          range: null,
          stopGrow: null,
          stopFork: null,
          stopQuota: null,
          tracker: null, // trackPresent of the open core
          retryTimer: null,
          fetching: false,
          fetch: null, // the quarantine fetch in flight (peeks wait for it)
          gating: false,
          advSeq: 0,
          fetchedAdv: 0,
          cutByDeadline: false,
          discardedRegate: false
        }
        follows.set(key, entry)
        if (blocked) {
          // Never opened: the sweep below purges whatever is stored.
          entry.state = 'failed'
          skipped.push({ key, reason: 'blocked' })
          emit({ event: 'skipped', key, reason: 'blocked' })
          continue
        }
        const slot = await opened[i].p
        if (slot.error !== null) throw slot.error
        if (slot.core === null) continue
        const core = slot.core
        slot.core = null
        const { reason, held0 } = slot
        if (held0 && reason === null) {
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
    } finally {
      await Promise.all(workers)
      for (const slot of slots) {
        if (slot === null || slot.core === null) continue
        const core = slot.core
        slot.core = null
        await core.close().catch(noop)
      }
    }

    if (!ending) await updateReplicaIndex()
    // Stored replicas of blocked keys, and unfollowed ones from a revoked
    // issuer, go before any connection.
    if (!ending) await sweepBlocked()
    if (!ending && blocklist.revokedIssuers().size > 0) await sweepRevoked()

    if (!ending) {
      reader.set({ diary, replica, hold, release })
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
    if (ownTracker !== null) ownTracker.destroy()
    const l = link
    link = null
    if (l !== null) {
      withdrawPeek(l)
      for (const q of l.quarantine) await q.close().catch(noop)
      l.noise.destroy()
    }
    // The socket is closed before the run returns (see the header): the
    // last one, also when its link already closed and it is still CLOSING.
    if (lastSocket !== null) {
      const socket = lastSocket
      lastSocket = null
      await socketClosed(socket, socketCloseMs)
    }
    discardRegate() // a throw may have skipped finish()
    await Promise.allSettled([...inflight])
    clearReader(reader)
    await drained
    for (const e of follows.values()) {
      stopEntry(e)
      if (e.core) {
        const core = e.core
        e.core = null
        await core.close().catch(noop)
      }
    }
    while (settling.size > 0) await Promise.allSettled([...settling])
    mediaTimer = null
    for (const m of media.splice(0)) {
      m.stop()
      await m.core.close().catch(noop)
    }
    if (diary) await diary.close().catch(noop)
  }
}

module.exports = { runSync, gateVerdict, trackPresent, linearExcept, MAX_RANGES, NEWEST_BLOCKS, HEAD_LOW, HEAD_STALL_MS, GATE_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_PARALLEL_GATES, MAX_PARALLEL_OPENS, SEEDER_UNAVAILABLE, DIARY_UNAVAILABLE }
