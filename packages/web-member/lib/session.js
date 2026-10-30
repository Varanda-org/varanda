// The browser node session (docs/rpc.md section 5): ONE serialized session
// over a ./node-storage.js storage that implements the RPC methods the app
// uses on Hypercore 10, syncing through one seeder over a WebSocket
// (./sync.js). It mirrors @varanda/core lib/session.js rule for rule, so the
// app sees the same contract whether its node is the Bare worklet,
// varanda-serve or this session; the transport (./node.js) passes
// `session.handlers` to createServerDispatcher and `dispatcher.emit` to
// `session.attach`, in memory.
//
// Rules (as lib/session.js):
// - Handlers run strictly one at a time, in arrival order (one promise chain).
// - Every member operation opens the own diary, and a running sync holds it
//   open. Two Hypercore instances on the same storage would corrupt it, so
//   a core is never opened twice: a read that opens cores (feed.read,
//   log.read, profile.read, engagement.read, the notices own-diary read) is
//   served from the live run's cores while a run exists (withCores, web
//   only; the run keeps going, same runId), and opens and closes the storage
//   itself when none does. Only writes, and reads the run cannot serve,
//   preempt: a running sync is aborted and awaited first; a continuous run
//   is restarted afterwards with a new runId (sync.stopped 'preempted',
//   then sync.started).
// - Configuration (association, seeder address) is fixed here and checked
//   before anything touches the storage or the network. There is no DHT, so
//   node.info reports publicDht false.
// - Errors reach the wire only through toRpcError (an explicit table); any
//   other error is INTERNAL 'erro interno' and goes to onInternalError.
// Not mirrored: suspend/resume (the Bare worklet's background state) and the
// data-dir lock (the browser entry, web/node.js, takes a Web Lock instead).
//
// The identity key (web only): the diary's key pair is derived from the
// member's passkey by the page (lib/passkey.js) and handed to the session
// through the host control setKeyPair(); it lives in this closure only (the
// storage holds the public key, ./node-store.js), reaches member-ops as
// ctx.keyPair for the duration of one operation, and is zero-filled by
// clearKeyPair(), reset() and close(). Reads work locked; a write without
// the key is USAGE 'identidade bloqueada: entre com a passkey'. The only
// signatures the session makes outside the diary are account.sign,
// report.sign, terms.sign, invite.sign, push.sign and age.sign: the
// domain-separated account-link statement (@varanda/core lib/account-link.js,
// prefix 'varanda-account-link-v1'), report statement (@varanda/core
// lib/report.js, prefix 'varanda-report-v1'), terms-acceptance statement
// (@varanda/core lib/terms.js, prefix 'varanda-terms-v1'), signup-invite
// request (@varanda/core lib/invite.js, prefix 'varanda-invite-v1'),
// push-subscription statement (@varanda/core lib/push-proof.js, prefix
// 'varanda-push-v1') and age-verification request (@varanda/core
// lib/age.js, prefix 'varanda-age-v1'), whose member and association the
// session fills in
// itself, so a caller can never get
// arbitrary bytes, a certificate or a block signed. Each returns the
// signature only.
//
// Single writer (docs/app.md): the same passkey opens the same diary on
// every device, so before every diary write the session makes sure this
// device holds what the seeder holds (ensureCaughtUp: skipped only while a
// live, verified continuous run tracks the own diary; else an internal once
// run must receive the seeder's hello and reach its advertised length), and
// after the write it sends the diary to the seeder (an internal once run,
// or the continuous run that restarts). The internal runs show as normal
// once runs (sync.started / sync.event / sync.stopped) with the lines
// 'sincronizando antes de publicar' / 'enviando ao semeador', and never
// touch the user's sync intent.
//
// The media key (web only, per device): the page derives this device's
// media core key pair (passkey PRF output + the per-device nonce of kv
// mediaDevice, web/node.js) and hands it in with the identity pair,
// setKeyPair(pair, { media }); it lives in this closure only, reaches
// member-ops as ctx.mediaKeyPair and is zero-filled with the identity pair.
// Uploads go through the host control mediaUpload({ bytes, mime, width,
// height, onProgress }) and never over the RPC channel (one request is
// capped at 64 KiB, @varanda/rpc MAX_REQUEST): the bytes are validated and
// copied synchronously, hashed (WebCrypto SHA-256) on the serial chain
// outside withStore; the own media core is readied (member-ops
// mediaPrepare, inside withStore: it opens a core) and, the first time a
// core is used, declared in the diary through the write gate (`media-core`
// record, gated and pushed like any diary write) BEFORE the bytes are
// stored (member-ops mediaCommit), so a declaration the gate refuses keeps
// the fixed-size core empty for the retry. The result is the descriptor a later
// post.create / post.reply carries in `media`; member-ops verifies it
// against the own cores before the post is appended ('mídia inválida').
// Nothing about the bytes is logged.
//
// Follows are local-first (member-ops followChange: kv follows and kv
// followsPending change at once; the handler's result is unchanged) but
// UNLOCKED only: follow.add / follow.remove are USAGE 'identidade
// bloqueada' while locked, each queued op is signed by the identity key and
// the drain drops any op that does not verify, so nothing planted in a
// signed-out browser profile (DevTools, IndexedDB) is ever signed into the
// public diary (the rule the text outbox follows). The session appends the
// pending changes as `follow` records with a DRAIN: one coalesced serial operation
// (at most one queued) that runs the write gate, member-ops drainFollows
// and the push, exactly as a diary write, without ever touching the user's
// sync intent. It runs only when kv followsPending is non-empty, so a
// member who never follows anyone never sees a run or an event from it.
// The follows a device kept from before `follow` records existed are never
// published on their own (kv follows is unauthenticated and the per-device
// marker deletable): the host controls legacyFollows() / confirmLegacyFollows(keys)
// let the person confirm the exact list once; the confirmed keys become
// signed pending ops and drain like any change, the rest leave kv follows.
// It is scheduled by
// follow.add / follow.remove when something changed, after setKeyPair,
// after cert.add wrote block 0, and on the first own-synced of a continuous run while a
// previous drain failed (drainWanted; at most MAX_DRAIN_RETRIES in a row
// without a new change, so a persistent failure cannot keep restarting the
// run). A drain never fails an RPC: an error is the warning 'aviso:
// seguidos ainda não enviados' and the records stay pending. The drain
// defers (drainWanted) while a user's once run is alive: the app's recovery
// run must not be preempted by it. The other way round, the sync folds the
// own diary's `follow` records into kv follows (another device's follows)
// and emits 'follows-changed { count, length }': the session relays it as
// the RPC event follows.changed { count } (every event) and restarts the
// continuous run once per distinct own length (lastFoldLength; a burst of
// folds while a restart is queued costs one restart), so the run follows
// the new set; a once run is never restarted. The sync's 'media-pushed'
// event (this device's media core confirmed at the seeder) makes no line;
// the lease below learns the confirmation from the 'settled' report that
// follows it.
//
// The lease (web only, docs/rpc.md 6.1; off unless leaseHoldMs > 0, which
// only the browser entry sets): a seeder link that has nothing left to do
// is not held open. The sync reports 'settled { settled, mediaPending }'
// (./sync.js header: inventory complete and not timed out, no unmet goal,
// no failing follow; mediaPending while an own media core with blocks is
// not confirmed pushed). Once a user's continuous run has been settled for
// leaseHoldMs, counted ACROSS the preemptions of writes and fold restarts
// (the clock is kept while a run ends 'preempted' and its successor
// settles again, and reset by an unsettled report or by any other end; a
// read served on the run's cores neither ends nor extends it, so a
// profile.read per second does not keep the link up), with every media
// core confirmed or leaseMediaMaxMs elapsed waiting for one, and while no
// borrow holds it (borrow(fn): a counter for the readers of the live link,
// today diary.peek; the hold waits for it, never past LEASE_BORROW_MAX_MS
// from the first borrow), the run ends: sync.stopped
// { runId, reason: 'idle' }, no result, syncIntent stays 'continuous' and
// leaseUntil = now + leaseGapMs. restartIfWanted does nothing before
// leaseUntil, so the member reads of the gap (feed, profile, log,
// engagement, node.info) do not redial. What dials again, inside the gap
// or after it: a diary write (ensureCaughtUp / pushAfterWrite clear
// leaseUntil before the handler's finally restarts the run), a diary.peek
// (awaitPeek clears it and queues its no-op), and sync.start, which starts
// at once while no run exists; sync.stop clears the intent as always, and
// a stop that lands while an idle run is still unwinding turns its reason
// into 'stopped' (only the lease produces 'idle', with the intent kept). Two
// sync sockets are never open at once (the Espiadinha's own short link is
// apart from them): runSync returns only after its socket closed
// (./sync.js socketCloseMs), and a run is only ever started while `run` is
// null.
//
// Engagement: like.set / repost.set / post.quote are diary writes on the
// post.reply path (unlocked, gate, append, push); a toggle already in the
// requested state writes nothing (changed: false) and pushes only while the
// seeder is not known to hold the current length. engagement.read reads the
// own diary like profile.read (works locked).
//
// On-demand reads (diary.peek, docs/rpc.md): outside the serial chain, like
// peek.read below. It is served by the running sync (./sync.js, through the
// `diaryPeeker` this session owns: the run publishes its peek function once its
// seeder link verified and withdraws it when the link closes or the run
// ends), never by withStore: it opens no storage core, never preempts a
// run, never restarts one itself (a restart beside a withStore write would
// corrupt the storage) and stores nothing. At most MAX_DIARY_PEEKS peeks are in
// flight (USAGE 'ocupado' beyond). When no verified run is live it queues a
// serial no-op, whose restartWhenIdle restarts a wanted continuous run
// safely, and waits for the run's peek up to peekTimeoutMs; otherwise
// NOT_FOUND 'semeador indisponível', which the caller may retry. A peek the
// run drops while stopping (preempted by a write) is retried once on the
// next verified run within the same deadline. Trust: the own key and the
// followed keys are read from the cores the run holds; any other key is
// gated like a quarantine fetch (block 0 certificate, revoked issuers,
// quota, blocklist) on an in-memory core that is closed afterwards, and
// every block is verified by Hypercore against the signed tree; a hidden
// diary answers NOT_FOUND 'diário indisponível', never why. The username
// and profile hints are verified records of the peeked block only (no
// fallback to an earlier record): freshness is the seeder's claim.
//
// reset() removes the diary, this device's media cores (kv mediaCores and
// mediaDevice included), the pending follow changes and the per-device
// migration marker (the kept follows are offered for confirmation again by
// the next identity), and locks both keys; config and follows stay.
//
// The Espiadinha (web only, docs/rpc.md 5.22): peek.read is answered by
// ./peek.js from a dedicated short-lived seeder link and memory cores, in
// browser memory only (a snapshot of at most 5 minutes, nothing written).
// That link is ALWAYS its own (an ephemeral Noise key that announces
// nothing), whatever the sync state: browsing unfollowed diaries over the
// sync link, which announced the member's diary and follows, would let the
// seeder bind that browsing to the member (privacy over capacity). It
// neither borrows nor holds the lease.
// Unlike the other reads it is NOT run inside withStore or withCores and
// does not wait for a running sync: it opens no storage core (the
// preemption exists only because two Hypercore instances on one storage
// corrupt it) and a page
// may take up to 25 s, which must not block the serial chain. Only the
// own-key lookup runs on the chain, and only while the key is not cached
// or an identity change (reset, setKeyPair, clearKeyPair) is pending. One
// peek at a time ('espiadinha já em andamento'); detach, close, reset and
// setKeyPair abort a running one.
//
// Notices (web only, docs/rpc.md 5.28): notices.list is answered by
// ./notices.js like peek.read (own short-lived link, memory cores, nothing
// written); the link's ownership proof is signed by the in-memory identity
// key (locked -> USAGE 'identidade bloqueada'). One at a time ('avisos já
// em andamento'), aborted with the peek. Against a seeder that speaks
// 'varanda/notices/2' the read checks replies, quotes and mentions against
// the own diary: one own-diary read per poll, on the serial chain inside
// withCores (served on a live run's cores like the other reads), skipped
// while the diary length is unchanged (noticeCtxCache, forgotten on lock,
// reset, setKeyPair and close). The link itself still opens no storage core, and a v1 read
// never reads the own diary.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { RpcError, isSafeMessage, capList, capSyncResult, clipText, MAX_LINE, MAX_ID, PEEK_TIMEOUT_MS, FEED_INCOMPLETE_MAX } = require('@varanda/rpc')
const {
  validRecordCopy,
  validateRecord,
  parseRef,
  MEDIA_BLOCK_BYTES,
  MAX_MEDIA_ITEM_BLOCKS,
  MEDIA_MIMES,
  MAX_MEDIA_DIMENSION
} = require('@varanda/core/lib/records')
const { formatEvent, key8 } = require('@varanda/core/lib/sync-format')
const { safe } = require('@varanda/core/lib/safe')
const { UsageError } = require('@varanda/core/lib/errors')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signReport } = require('@varanda/core/lib/report')
const { signTerms } = require('@varanda/core/lib/terms')
const { signInvite } = require('@varanda/core/lib/invite')
const { signAge } = require('@varanda/core/lib/age')
const { signPush, endpointHash } = require('@varanda/core/lib/push-proof')
const { verifyUsernameRecord } = require('@varanda/core/lib/cert')
const { latestUsernameRecord } = require('@varanda/core/lib/username')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const member = require('./member-ops')
const { runSync, SEEDER_UNAVAILABLE, DIARY_UNAVAILABLE } = require('./sync')
const { createPeeker } = require('./peek')
const { createNoticer } = require('./notices')
const { signNoticeProof } = require('@varanda/core/lib/notices')
const store = require('./node-store')
const { checkSeederUrl } = require('./seeder-url')

const HEX64 = /^[0-9a-fA-F]{64}$/
const LOCKED_MESSAGE = 'diretório de dados em uso'
const CLOSED_MESSAGE = 'sessão encerrada'
const INTERNAL_MESSAGE = 'erro interno'
const NOT_SYNCED_MESSAGE = 'sincronize com o semeador antes de publicar'
const BAD_USERNAME_RECORD = 'registro de nome inválido'
const OLD_USERNAME_RECORD = 'registro de nome antigo'
const SELF_REPORT = 'não é possível denunciar a própria chave'
const BAD_REPORT = 'denúncia inválida'
const BAD_PUSH = 'inscrição de notificação inválida'
const GATE_LINE = 'sincronizando antes de publicar'
const PUSH_LINE = 'enviando ao semeador'
const DRAIN_WARNING = 'aviso: seguidos ainda não enviados'
const BAD_MEDIA_ARGS = 'mídia inválida'
const NO_SEEDER = 'sem conexão com o semeador'
const PEEK_BUSY = 'espiadinha já em andamento'
const NOTICES_BUSY = 'avisos já em andamento'
const DIARY_PEEK_BUSY = 'ocupado'
// diary.peek requests in flight at once.
const MAX_DIARY_PEEKS = 2
// One deadline for the internal catch-up and push runs.
const WRITE_GATE_TIMEOUT_MS = 15000
// Failed drains retried from own-synced without a new follow change.
const MAX_DRAIN_RETRIES = 3
// The lease (see the header): the gap after an idle end, how long a run
// waits for an unconfirmed media core, and the longest a borrow holds it.
const LEASE_GAP_MS = 45000
const LEASE_MEDIA_MAX_MS = 120000
const LEASE_BORROW_MAX_MS = 30000
const MAX_MEDIA_ITEM_BYTES = MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES

const noop = () => {}

// ---- error mapping (A6), the table of @varanda/core lib/session.js ----

const USAGE_MESSAGES = new Set([
  'certificado já gravado',
  'grave o certificado de membro antes de publicar',
  'não é possível seguir a própria chave',
  'limite de diários seguidos atingido',
  'limite do diário atingido',
  'diretório não é de um membro',
  'associação diferente da configurada',
  store.LOCKED,
  store.MISMATCH,
  store.MEDIA_INVALID,
  NOT_SYNCED_MESSAGE,
  BAD_USERNAME_RECORD,
  OLD_USERNAME_RECORD,
  SELF_REPORT,
  BAD_REPORT,
  BAD_PUSH,
  NO_SEEDER,
  PEEK_BUSY,
  NOTICES_BUSY
])
const USAGE_PATTERNS = [
  /^certificado inválido \([a-z0-9-]{1,40}\)$/,
  /^registro inválido: [a-z0-9-]{1,40}$/
]
const NOT_FOUND_MESSAGES = new Set([
  'identidade não encontrada',
  'sem dados locais para este diário',
  SEEDER_UNAVAILABLE,
  DIARY_UNAVAILABLE
])

function messageOf (err) {
  try {
    return err !== null && typeof err === 'object' && typeof err.message === 'string' ? err.message : null
  } catch {
    return null
  }
}

function codeOf (err) {
  try {
    return err !== null && typeof err === 'object' && typeof err.code === 'string' ? err.code : null
  } catch {
    return null
  }
}

// Anything thrown inside the session -> an RpcError with a wire code and a
// message from the table above; never throws.
function toRpcError (err, onInternalError = noop) {
  if (err instanceof RpcError && err.isSessionError === true) return err
  const code = codeOf(err)
  const message = messageOf(err)
  if (code === 'LOCKED') return rpcError('LOCKED', LOCKED_MESSAGE)
  if (code === 'USAGE' && err instanceof UsageError) {
    return rpcError('USAGE', isSafeMessage(message) ? message : 'pedido inválido')
  }
  if (message !== null && (code === null || code === 'INVALID_RECORD')) {
    if (USAGE_MESSAGES.has(message) || USAGE_PATTERNS.some((re) => re.test(message))) return rpcError('USAGE', message)
    if (NOT_FOUND_MESSAGES.has(message)) return rpcError('NOT_FOUND', message)
  }
  try { onInternalError(err) } catch {}
  return rpcError('INTERNAL', INTERNAL_MESSAGE)
}

function rpcError (code, message) {
  const err = new RpcError(code, message)
  err.isSessionError = true
  return err
}

// ---- configuration ----

function checkConfig ({ storage, association, seederUrl, createSocket }) {
  if (storage === null || typeof storage !== 'object' || typeof storage.core !== 'function') {
    throw new TypeError('storage required')
  }
  if (typeof createSocket !== 'function') throw new TypeError('createSocket required')
  if (typeof association !== 'string' || !HEX64.test(association)) {
    throw new UsageError('chave da associação inválida')
  }
  return { association: association.toLowerCase(), seederUrl: checkSeederUrl(seederUrl) }
}

// A minimal AbortSignal (runSync only uses `aborted` and add/removeEventListener).
function createAbort () {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener (type, fn) { if (type === 'abort') listeners.add(fn) },
    removeEventListener (type, fn) { if (type === 'abort') listeners.delete(fn) }
  }
  function abort () {
    if (signal.aborted) return
    signal.aborted = true
    for (const fn of [...listeners]) {
      listeners.delete(fn)
      try { fn() } catch {}
    }
  }
  return { signal, abort }
}

function isTimeout (result) {
  if (!result || result.ok !== false || !Array.isArray(result.errors)) return false
  const first = result.errors[0]
  return first === 'sem pares' || (typeof first === 'string' && first.startsWith('tempo esgotado'))
}

function line (text) {
  return clipText(String(text), MAX_LINE)
}

// A log line with a path separator (a URL included) or a run of 16+ hex
// digits keeps its prefix up to the first ': ' after 'aviso: ' and ends with
// ': erro interno' (@varanda/core lib/session.js redactLogLine). -> [line, redacted]
const UNSAFE_LOG = /[/\\]|[0-9a-fA-F]{16}/

function redactLogLine (text) {
  const str = String(text)
  if (!UNSAFE_LOG.test(str)) return [str, false]
  const cut = str.indexOf(': ', 'aviso: '.length)
  const head = cut === -1 ? 'aviso' : str.slice(0, cut)
  return [UNSAFE_LOG.test(head) ? 'aviso: erro interno' : head + ': erro interno', true]
}

// ---- the session ----

// syncOptions: test-only overrides passed to runSync (limits and timings).
// limits: test-only overrides of the own diary limits.
// writeGate: the catch-up run before every diary write and the push run
// after it (test fixtures without a seeder pass false; the browser entry
// never passes it). writeGateTimeoutMs: their deadline (tests).
// peekTimeoutMs: the diary.peek deadline (tests; the contract's otherwise).
// leaseHoldMs: the lease (header); 0 = off. leaseGapMs, leaseMediaMaxMs:
// its gap and its media wait. noClear: keep the bytes of deleted blocks
// (the browser's VARANDA_NO_CLEAR kill switch; tombstones still hide them).
function createBrowserSession ({
  storage,
  association,
  seederUrl,
  createSocket,
  onInternalError = noop,
  syncOptions = {},
  limits,
  writeGate = true,
  writeGateTimeoutMs = WRITE_GATE_TIMEOUT_MS,
  peekTimeoutMs = PEEK_TIMEOUT_MS,
  leaseHoldMs = 0,
  leaseGapMs = LEASE_GAP_MS,
  leaseMediaMaxMs = LEASE_MEDIA_MAX_MS,
  noClear = false
} = {}) {
  const cfg = checkConfig({ storage, association, seederUrl, createSocket })
  const reportInternal = (err) => {
    try { onInternalError(err) } catch {}
  }

  function ctx () {
    return { storage, association: cfg.association, keyPair, mediaKeyPair, limits, noClear: noClear === true }
  }

  let emitter = null
  let chain = Promise.resolve()
  let queued = 0 // operations accepted and not finished
  let closed = false
  let closing = null
  let run = null // { runId, once, internal, ownSynced, onOwnSynced, abort, reason, done, leased, settled, leaseTimer }
  let lastRunId = 0
  let connection = 0 // epoch, bumped by detach()
  let syncIntent = null // 'continuous' while a user-started continuous run should be running
  // The lease (header): no continuous run is restarted before leaseUntil;
  // leaseSettledSince / leaseMediaSince = when the link became settled /
  // started waiting for a media core (kept across preemptions); borrows =
  // the readers holding the link open, borrowedSince = the first of them.
  let leaseUntil = 0
  let leaseSettledSince = null
  let leaseMediaSince = null
  let borrows = 0
  let borrowedSince = null
  // Own identity, cached once known (the key never changes; block 0 is
  // append-only, so only `memberCert: true` is cached).
  let ownKey = null
  let certKnown = false
  // Identity changes (reset, setKeyPair, clearKeyPair) called and not yet
  // settled: counted synchronously on the call, before they queue, so a
  // peek.read / notices.list arriving while one waits on the chain (ownKey
  // still set) takes the chain too and runs after it.
  let identityPending = 0
  let diaryInfo = null // { publicKey, legacy } once the stored diary was looked at
  // The identity key pair and this device's media key pair (session-owned
  // copies, zero-filled together when cleared).
  let keyPair = null
  let mediaKeyPair = null
  // The follow drain: at most one operation queued; drainWanted after a
  // failure (retried from own-synced, drainRetries times in a row).
  let drainQueued = false
  let drainWanted = false
  let drainRetries = 0
  // The own length of the last fold the continuous run was restarted for.
  let lastFoldLength = null
  // Last own-sync verdict of a run: the own diary held what the verified
  // seeder advertised (or the seeder held nothing for the key).
  let synced = false
  // The seeder may not hold the diary's current length: set by every append
  // (and at start, unknown), cleared when a run confirms the local length
  // (a once run's seederConfirmed, or a continuous run's have/admitted for
  // the own key at the length of the last write). While set, every write
  // handler pushes, an idempotent one included.
  let unpushed = true
  let localLength = null // length after the last write here, when known
  // diary.peek: the running sync publishes its peek function here once its
  // seeder link verified (runSync `peeker`) and withdraws it when the link
  // closes or the run ends; set() wakes the handlers waiting for one.
  const diaryPeeker = {
    peek: null,
    waiters: new Set(),
    set (fn) {
      this.peek = fn
      for (const wake of [...this.waiters]) wake(fn)
    },
    clear (fn) {
      if (this.peek === fn) this.peek = null
    }
  }
  let diaryPeeksInFlight = 0
  // The Espiadinha: its peeker and the one peek.read in flight (its promise;
  // never the promise of a refused call). `peeking` is the slot, released at
  // once by detach/reset/setKeyPair; `unwinding` keeps every read that has
  // not settled yet, aborted ones included, so close() still awaits them
  // before ./node.js closes the storage.
  let peeking = null
  // The one notices.list in flight (its own slot, same rules as `peeking`;
  // its promise joins `unwinding` too).
  let noticing = null
  // The own context of the last v2 notices read (member-ops
  // ownNoticeContext), reused while the own diary's length is unchanged.
  let noticeCtxCache = null
  const unwinding = new Set()

  // A run's events carry the connection epoch it started in: once that
  // connection is detached, a run still unwinding reports to nobody, not to
  // the connection that attached after it.
  function send (event, data, epoch = connection) {
    const fn = emitter
    if (fn === null || epoch !== connection) return
    try { fn(event, data) } catch {}
  }

  function warning (text, epoch) {
    send('warning', { line: line(text) }, epoch)
  }

  const peeker = createPeeker({
    storage,
    association: cfg.association,
    seederUrl: cfg.seederUrl,
    createSocket,
    ownKey: cachedOwnKey,
    log: (text) => warning(safe(text)),
    limits: syncOptions.peek
  })

  // The proof signer of the notices link: synchronous, with the in-memory
  // key, for the own key the read resolved (account.sign's checks).
  const noticer = createNoticer({
    storage,
    association: cfg.association,
    seederUrl: cfg.seederUrl,
    createSocket,
    ownKey: cachedOwnKey,
    sign: (payload, own) => {
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      return signNoticeProof(payload, keyPair)
    },
    // The opaque `seen` token of a notice row (docs/rpc.md 5.28): a BLAKE2b
    // keyed by the identity secret (no length extension), stable for this
    // identity and (key, seq), unlinkable to the follower key without the
    // secret. The app stores only these tokens, so whoever reads the origin's
    // storage while the passkey is locked cannot confirm who followed.
    seenToken: (own, key, seq) => {
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      const digest = crypto.hash([
        b4a.from('varanda-notices-seen-v1\n'),
        keyPair.secretKey.subarray(0, 32),
        b4a.from(own + '\n' + key + ':' + seq)
      ])
      return b4a.toString(digest, 'hex').slice(0, 32)
    },
    log: (text) => warning(safe(text)),
    limits: syncOptions.notices
  })

  // ---- sync runs ----

  // internal: a gate or push run of the session itself (its line names it;
  // it never changes syncIntent). onOwnSynced: called on the run's first
  // own-synced. -> the run record.
  function startRun ({ once, timeoutMs, internal = false, label = null, onOwnSynced = noop }) {
    lastRunId = lastRunId >= MAX_ID ? 1 : lastRunId + 1
    const runId = lastRunId
    const epoch = connection
    const { signal, abort } = createAbort()
    // leased: a user's continuous run under the lease; settled: its last
    // readiness report; leaseTimer: the hold.
    const r = { runId, once, internal, ownSynced: false, abort, reason: null, done: null, leased: !once && !internal && leaseHoldMs > 0, settled: false, leaseTimer: null, ready: null }
    // The run's reader (withCores): `ready` settles with the api the run
    // publishes, or null once it withdraws it or ends without publishing.
    // Fresh per run, so a read never borrows a previous run's cores.
    let publish
    r.ready = new Promise((resolve) => { publish = resolve })
    const reader = {
      set (api) { publish(api) },
      clear () { publish(null) }
    }
    run = r
    send('sync.started', { runId, once }, epoch)
    if (label !== null) send('sync.event', { runId, line: line(label) }, epoch)
    const event = (text) => send('sync.event', { runId, line: line(text) }, epoch)
    r.done = (async () => {
      let result = null
      let error = null
      try {
        result = await runSync({
          ...syncOptions,
          noClear: noClear === true,
          storage,
          associationKey: cfg.association,
          seederUrl: cfg.seederUrl,
          createSocket,
          once,
          timeoutMs: once ? timeoutMs : undefined,
          peeker: diaryPeeker,
          reader,
          log: (text) => {
            const [clean, redacted] = redactLogLine(text)
            if (redacted) reportInternal(new Error(String(text)))
            warning(safe(clean), epoch)
          },
          onEvent: (ev) => {
            if (!ev) return
            switch (ev.event) {
              case 'skipped':
                warning('aviso: diário ' + key8(ev.key) + ' ignorado (' + safe(ev.reason) + ')', epoch)
                return
              case 'own-synced':
                synced = true
                event('diário próprio sincronizado (' + safe(String(ev.length)) + ')')
                if (!r.ownSynced) {
                  r.ownSynced = true
                  try { onOwnSynced() } catch {}
                  if (!once && drainWanted && drainRetries < MAX_DRAIN_RETRIES) scheduleDrain()
                }
                return
              case 'follows-changed':
                // The sync folded the own diary's follow records into kv
                // follows: the page learns the count; a continuous run is
                // restarted once per own length so it follows the new set.
                // A malformed event is dropped whole.
                if (!Number.isSafeInteger(ev.count) || ev.count < 0 || !Number.isSafeInteger(ev.length) || ev.length < 0) return
                send('follows.changed', { count: ev.count }, epoch)
                if (!once) scheduleFoldRestart(ev.length)
                return
              case 'media-pushed':
                // The seeder holds this device's media core up to `length`:
                // no line for the page; the lease sees it through the
                // 'settled' report the sync emits right after.
                return
              case 'settled':
                // The run's readiness report (header, "The lease").
                if (r.leased) noteSettled(r, ev)
                return
              case 'own-behind':
                synced = false
                r.ownSynced = false
                event('diário próprio atrasado (' + safe(String(ev.length)) + '/' + safe(String(ev.theirs)) + ')')
                return
              case 'link-closed':
                synced = false
                r.ownSynced = false
                return
              case 'own-recovered':
                certKnown = true
                event('certificado recuperado do semeador')
                return
              case 'have':
              case 'admitted':
                if (ev.key === ownKey && localLength !== null && ev.length >= localLength) unpushed = false
                break
              default:
                break
            }
            const text = formatEvent(ev)
            if (text !== null) event(text)
          },
          signal
        })
      } catch (err) {
        error = err
      }
      if (run === r) run = null
      clearLease(r)
      // A drain deferred by this user's once run is due now.
      if (once && !internal && drainWanted && drainRetries < MAX_DRAIN_RETRIES) scheduleDrain()
      if (error !== null) {
        if (!internal) syncIntent = null
        if (r.leased) leaseSettledSince = leaseMediaSince = null
        warning('erro: ' + toRpcError(error, reportInternal).message, epoch)
        send('sync.stopped', { runId, reason: 'error' }, epoch)
        return
      }
      if (once && result && result.seederConfirmed === true) unpushed = false
      let reason = r.reason
      // 'idle' only while the continuous intent really is kept (stopRun).
      if (reason === 'idle' && syncIntent !== 'continuous') reason = 'stopped'
      if (reason === null) {
        if (once) {
          reason = isTimeout(result) ? 'timeout' : 'done'
        } else {
          reason = 'done'
          syncIntent = null
        }
      }
      // The hold survives only a preemption (its successor resumes it).
      if (r.leased && reason !== 'preempted') leaseSettledSince = leaseMediaSince = null
      const data = { runId, reason }
      if (once) data.result = capSyncResult(result)
      send('sync.stopped', data, epoch)
      // A diary.peek still waiting for a link (its wait began under this
      // run, which the lease ended or a request preempted): the no-op it
      // queued may have run its restart check while `run` was still this
      // one, and nothing else need be queued, so the check runs again now
      // that `run` is clear, the gap cleared too.
      if (diaryPeeker.waiters.size > 0) {
        kickLease()
        restartWhenIdle(0)
      }
    })()
    // Settled once here, not raced per read: a race on r.done for every
    // read would keep one callback per read alive until the run ends.
    r.done.then(reader.clear, reader.clear)
    return r
  }

  // An explicit stop ('stopped': sync.stop, reset, detach, close, each of
  // which cleared the intent first) overrides an 'idle' the lease set on a
  // run that is still unwinding: 'idle' claims the intent was kept, and the
  // gap no longer applies. Only the lease itself ever sets 'idle'.
  async function stopRun (reason) {
    const r = run
    if (r === null) return false
    if (r.reason === null) {
      r.reason = reason
    } else if (r.reason === 'idle' && reason === 'stopped') {
      r.reason = reason
      kickLease()
    }
    r.abort()
    await r.done
    return true
  }

  function restartIfWanted () {
    if (syncIntent !== 'continuous' || run !== null || closed) return
    if (Date.now() < leaseUntil) return // the lease's gap (header)
    startRun({ once: false })
  }

  // ---- the lease (see the header) ----

  // A leased run's readiness report: the hold's clock starts at the first
  // settled report (or is resumed from the preempted predecessor), the
  // media wait at the first report that is settled with media pending, and
  // any unsettled report resets both.
  function noteSettled (r, { settled, mediaPending }) {
    r.settled = settled === true
    const now = Date.now()
    if (!r.settled) {
      leaseSettledSince = leaseMediaSince = null
    } else {
      if (leaseSettledSince === null) leaseSettledSince = now
      if (mediaPending !== true) leaseMediaSince = null
      else if (leaseMediaSince === null) leaseMediaSince = now
    }
    armLease(r)
  }

  // When the hold ends, from its clocks; null while nothing is settled.
  function leaseDue () {
    if (leaseSettledSince === null) return null
    let due = leaseSettledSince + leaseHoldMs
    if (leaseMediaSince !== null) due = Math.max(due, leaseMediaSince + leaseMediaMaxMs)
    if (borrows > 0) due = Math.max(due, borrowedSince + LEASE_BORROW_MAX_MS)
    return due
  }

  // (Re)arms the hold of the live leased run `r` for leaseDue().
  function armLease (r) {
    clearLease(r)
    if (run !== r || r.reason !== null || !r.settled || closed) return
    const due = leaseDue()
    if (due === null) return
    r.leaseTimer = setTimeout(() => {
      r.leaseTimer = null
      if (run !== r || r.reason !== null || !r.settled || closed) return
      const now = Date.now()
      const at = leaseDue()
      if (at === null) return
      if (at > now) {
        armLease(r)
        return
      }
      // Idle: the run ends cleanly (its sync.stopped carries 'idle' and the
      // intent stays), and nothing redials before the gap ends.
      leaseUntil = now + leaseGapMs
      r.reason = 'idle'
      r.abort()
    }, Math.max(0, due - Date.now()))
  }

  function clearLease (r) {
    if (r.leaseTimer === null) return
    clearTimeout(r.leaseTimer)
    r.leaseTimer = null
  }

  // A kick: the gap ends now (the caller's finally restarts the run).
  function kickLease () {
    leaseUntil = 0
  }

  // Runs fn() while counted as a borrower of the live link (a diary.peek):
  // the hold waits for the last borrower, never past
  // LEASE_BORROW_MAX_MS from the first. It starts no run and never fails
  // for the lease's sake; fn's outcome is the caller's.
  async function borrow (fn) {
    if (borrows++ === 0) {
      borrowedSince = Date.now()
      if (run !== null && run.leased) armLease(run)
    }
    try {
      return await fn()
    } finally {
      if (--borrows === 0) {
        borrowedSince = null
        if (run !== null && run.leased) armLease(run)
      }
    }
  }

  // Restarts only when no other operation is waiting (one preemption for a
  // burst of requests). `self` = how many queued operations are the caller.
  function restartWhenIdle (self) {
    if (queued <= self) restartIfWanted()
  }

  // ---- serialization ----

  async function withStore (fn) {
    if (run !== null) await stopRun('preempted')
    return fn(ctx())
  }

  // A read that opens cores: while a run exists it is served on the run's
  // own cores (ctx.cores, held so teardown waits for it), never a second
  // instance and without stopping the run, the lease or its clocks; only a
  // read the run cannot serve (member-ops NEEDS_EXCLUSIVE) falls back to
  // withStore and preempts. The hold is released before that fallback:
  // stopRun waits for every hold, ours included.
  async function withCores (fn) {
    const r = run
    if (r === null) return withStore(fn)
    const api = await r.ready
    if (api === null || !api.hold()) {
      await r.done
      return withStore(fn)
    }
    try {
      return await fn({ ...ctx(), cores: { diary: api.diary, replica: api.replica } })
    } catch (err) {
      if (!member.isNeedsExclusive(err)) throw err
    } finally {
      api.release()
    }
    return withStore(fn)
  }

  // ---- the write gate and the push ----

  // A live, verified continuous run that confirmed own-sync for the current
  // length (own-synced, and no own-behind or link loss since).
  function trackingOwn () {
    return run !== null && !run.once && run.ownSynced === true
  }

  // Before a diary write: this device must hold what the seeder holds for
  // its key. Unless a continuous run tracks it, an internal once run must
  // receive the seeder's hello and reach the advertised length (own-synced
  // from THAT run); it is stopped as soon as that happened. The user's sync
  // intent is restored whatever the outcome.
  // epoch: the handler's connection epoch; a client that detached while the
  // gate ran gets 'conexão encerrada' and nothing is written, and the sync
  // intent is restored only when nothing (detach) changed it meanwhile.
  async function ensureCaughtUp (epoch) {
    kickLease() // a write redials, inside the lease's gap too
    if (!writeGate || trackingOwn()) return
    if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
    if (run !== null) await stopRun('preempted')
    const intent = syncIntent
    synced = false
    let ok = false
    let arrived
    const caughtUp = new Promise((resolve) => { arrived = resolve })
    const r = startRun({
      once: true,
      timeoutMs: writeGateTimeoutMs,
      internal: true,
      label: GATE_LINE,
      onOwnSynced: () => {
        ok = true
        arrived()
      }
    })
    await Promise.race([caughtUp, r.done])
    await stopRun('preempted')
    if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
    syncIntent = intent
    if (!ok) throw new UsageError(NOT_SYNCED_MESSAGE)
  }

  // After a diary write (or any write handler while the seeder is not known
  // to hold the current length): the seeder receives it. A continuous run
  // that the write preempted restarts afterwards (restartWhenIdle) and
  // pushes; else an internal once run does, awaited so the caller knows it
  // ended (its outcome is in the sync.stopped event; the write stays either
  // way, and an unconfirmed push is retried on the next write).
  async function pushAfterWrite () {
    kickLease()
    if (!writeGate || closed || !unpushed || syncIntent === 'continuous') return
    if (run !== null) await stopRun('preempted')
    const r = startRun({ once: true, timeoutMs: writeGateTimeoutMs, internal: true, label: PUSH_LINE })
    await r.done
  }

  // Marks the diary as having grown here to `length`.
  function wrote (seq) {
    localLength = seq + 1
    unpushed = true
  }

  // Writes need the identity AND the key; checked before any network run.
  async function requireUnlocked () {
    const own = await requireOwnKey()
    if (keyPair === null) throw new UsageError(store.LOCKED)
    return own
  }

  // ---- the follow drain and the fold relay ----

  // Appends the pending follow changes as a diary write: gate, member-ops
  // drainFollows, push. Whether there is work is decided from the kv area
  // alone, before any run or core open: kv followsPending non-empty;
  // otherwise nothing runs and no event is emitted (a member who never
  // follows anyone sees exactly the runs of a diary write, no more). Defers
  // while a user's once run is alive (it would be preempted and never
  // restarted). Never throws to a caller: a failure is a warning and
  // drainWanted.
  const drain = serial(async (_, epoch) => {
    drainQueued = false
    if (keyPair === null) return
    if (!(await store.diaryExists(storage))) return
    if ((await store.readFollowsPending(storage)).length === 0) return
    if (run !== null && run.once) {
      drainWanted = true
      return
    }
    try {
      await ensureCaughtUp(epoch)
      const { seq } = await withStore((c) => member.drainFollows(c))
      if (seq !== null) wrote(seq)
      drainWanted = false
      drainRetries = 0
      await pushAfterWrite()
    } catch (err) {
      drainWanted = true
      drainRetries++
      warning(DRAIN_WARNING)
    }
  })

  // Queues one drain (coalesced: a drain already queued covers this call).
  function scheduleDrain () {
    if (drainQueued || closed || keyPair === null) return
    drainQueued = true
    drain({}).catch(noop)
  }

  // Stops the continuous run once for the own length of a fold; the serial
  // chain's restartWhenIdle restarts it with the folded follows (after any
  // write or drain already queued). Coalesced: while a restart is queued, a
  // new fold only updates the length it is for (foldLength), so a burst of
  // folds costs one restart, and a length already restarted for costs none.
  let foldQueued = false
  let foldLength = null

  const restartForFold = serial(async () => {
    foldQueued = false
    if (run === null || run.once || foldLength === lastFoldLength) return
    lastFoldLength = foldLength
    await stopRun('preempted')
  })

  function scheduleFoldRestart (length) {
    foldLength = length
    if (foldQueued || closed || length === lastFoldLength) return
    foldQueued = true
    restartForFold({}).catch(noop)
  }

  // ---- on-demand reads: diary.peek (see the header) ----

  // Resolves with a live peek function other than `not` (the one a dropped
  // attempt used) before `deadline`, else null. Never starts a run here: a
  // queued serial no-op lets restartWhenIdle restart a wanted continuous
  // run once nothing else is on the chain.
  function awaitPeek (not, deadline) {
    if (diaryPeeker.peek !== null && diaryPeeker.peek !== not) return Promise.resolve(diaryPeeker.peek)
    kickLease() // the no-op's finally redials, inside the lease's gap too
    if (!closed) serial(async () => {})({}).catch(noop)
    return new Promise((resolve) => {
      let timer = null
      const wake = (fn) => {
        if (fn === not) return
        diaryPeeker.waiters.delete(wake)
        clearTimeout(timer)
        resolve(fn)
      }
      diaryPeeker.waiters.add(wake)
      timer = setTimeout(() => {
        diaryPeeker.waiters.delete(wake)
        resolve(null)
      }, Math.max(0, deadline - Date.now()))
    })
  }

  // NOT a serial handler: runs beside the chain, inside the running sync.
  // The peek holds the lease (borrow) from its wait to its answer, so the
  // hold cannot end the run under it.
  function diaryPeek (params) {
    if (closed) return Promise.reject(rpcError('LOCKED', CLOSED_MESSAGE))
    if (diaryPeeksInFlight >= MAX_DIARY_PEEKS) return Promise.reject(rpcError('USAGE', DIARY_PEEK_BUSY))
    return borrow(() => diaryPeekWith(params))
  }

  async function diaryPeekWith ({ author, seqs, profileSeq, usernameSeq }) {
    diaryPeeksInFlight++
    try {
      const deadline = Date.now() + peekTimeoutMs
      const key = author.toLowerCase()
      let dropped = null
      // Two attempts: a run that stops under the first (preempted by a
      // write) drops it; the next verified run serves the second.
      for (let attempt = 0; attempt < 2; attempt++) {
        const peek = await awaitPeek(dropped, deadline)
        if (peek === null) throw new Error(SEEDER_UNAVAILABLE)
        try {
          return await peek(key, seqs, profileSeq === undefined ? null : profileSeq, usernameSeq === undefined ? null : usernameSeq, deadline)
        } catch (err) {
          if (messageOf(err) !== SEEDER_UNAVAILABLE || Date.now() >= deadline) throw err
          dropped = peek
        }
      }
      throw new Error(SEEDER_UNAVAILABLE)
    } catch (err) {
      throw toRpcError(err, reportInternal)
    } finally {
      diaryPeeksInFlight--
    }
  }

  function serial (fn) {
    return (params) => {
      const epoch = connection
      queued++
      const p = chain.then(async () => {
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        try {
          return await fn(params, epoch)
        } catch (err) {
          throw toRpcError(err, reportInternal)
        } finally {
          restartWhenIdle(1)
        }
      })
      const settled = () => { queued-- }
      chain = p.then(settled, settled)
      return p
    }
  }

  // ---- identity ----

  async function identity () {
    if (ownKey !== null && certKnown) return { publicKey: ownKey, memberCert: true }
    const r = await withStore((c) => member.identityState(c))
    if (r.publicKey !== null) ownKey = r.publicKey
    if (r.memberCert) certKnown = true
    return r
  }

  // The own key for code running off the chain (the peeker, the noticer):
  // peek.read / notices.list resolved it before starting them, so a miss
  // means reset/setKeyPair intervened. Never identity()/withStore, which
  // would open storage outside the chain.
  function cachedOwnKey () {
    if (ownKey === null) throw new Error('identidade não encontrada')
    return ownKey
  }

  // The own-key lookup of peek.read / notices.list: the chain only while
  // the key is not cached or an identity change is pending. Again after
  // each pass: an identity change queued right behind a cold lookup clears
  // the key it just cached. Every pass runs after the changes counted when
  // it was queued, so this ends; a real NOT_FOUND propagates.
  async function lookupOwnKey (params) {
    while (lookupWanted()) await serial(async () => requireOwnKey())(params)
  }

  function lookupWanted () {
    return !closed && (ownKey === null || identityPending > 0)
  }

  // An identity change counted in identityPending until it settles. With
  // `abort`, a peek or notices read already past lookupOwnKey belongs to the
  // previous identity and is ended now, as detach does: its own job may wait
  // behind a busy chain while that read goes on off the chain.
  function identityChange (p, { abort = false } = {}) {
    identityPending++
    if (abort) {
      peeker.abort()
      peeking = null
      noticer.abort()
      noticing = null
    }
    return p().finally(() => { identityPending-- })
  }

  async function requireOwnKey () {
    if (ownKey !== null) return ownKey
    const { publicKey } = await identity()
    if (publicKey === null) throw new Error('identidade não encontrada')
    return publicKey
  }

  function syncState () {
    return run === null ? { state: 'idle' } : { state: 'running', runId: run.runId, once: run.once }
  }

  // like.set / repost.set: the post.reply path around member-ops' toggle.
  async function engagementSet (toggle, { to, on }, epoch) {
    const ref = parseRef(to)
    if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
    await requireUnlocked()
    await ensureCaughtUp(epoch)
    const r = await withStore((c) => toggle(c, { to: ref, on }))
    if (r.changed) wrote(r.seq)
    await pushAfterWrite()
    return { seq: r.seq, on: r.on, changed: r.changed }
  }

  // post.delete / profile.delete: the post.reply path around member-ops'
  // tombstone writer (a target already deleted writes nothing).
  async function recordDelete (remove, { to }, epoch) {
    const ref = parseRef(to)
    if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
    await requireUnlocked()
    await ensureCaughtUp(epoch)
    const r = await withStore((c) => remove(c, { to: ref }))
    if (r.changed) wrote(r.seq)
    await pushAfterWrite()
    return { seq: r.seq, ref: r.ref, changed: r.changed, deleted: r.deleted }
  }

  // ---- handlers (docs/rpc.md section 5; params arrive validated) ----

  const handlers = {
    'node.info': serial(async () => {
      const { publicKey, memberCert } = await identity()
      restartWhenIdle(1)
      return {
        publicKey,
        memberCert,
        followCount: (await store.readFollows(storage)).length,
        sync: syncState(),
        publicDht: false
      }
    }),

    'identity.create': serial(async () => {
      const r = await withStore((c) => member.idCreate(c))
      ownKey = r.publicKey
      // Only a diary made now is known not to be legacy; an existing one is
      // read from its header by identityStatus.
      if (r.created) {
        diaryInfo = { publicKey: r.publicKey, legacy: false }
        unpushed = true
      }
      return { publicKey: r.publicKey, association: r.association }
    }),

    'identity.show': serial(async () => {
      const r = await withStore((c) => member.idShow(c))
      ownKey = r.publicKey
      return { publicKey: r.publicKey, association: r.association }
    }),

    'cert.add': serial(async ({ cert }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.certAdd(c, cert))
      certKnown = true
      if (r.appended) wrote(r.seq)
      await pushAfterWrite()
      // Block 0 exists now: follows queued before it can reach the diary.
      if (r.appended) followChanged()
      return { seq: r.seq }
    }),

    // Signs the account-link statement with the in-memory key (docs/rpc.md
    // 5.18). Not a diary write: no withStore/ensureCaughtUp (they would
    // preempt a running sync for nothing), no append, no network, and the
    // key stays set. The result never carries the payload or a key.
    'account.sign': serial(async ({ phase, nonce, username, sub }) => {
      // The diary's key, without opening the store: setKeyPair forgets
      // ownKey, but diaryInfo (cached by identityStatus from the header)
      // still holds it, and the key never changes short of reset. Only a
      // node that has seen neither reads the store, which preempts a run as
      // node.info does, and restarts it the same way.
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      // A pair for another diary would only make a signature the service
      // refuses.
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      const signature = signAccountLink({ phase, nonce, member: own, username, association: cfg.association, sub }, keyPair)
      return { signature }
    }),

    // Signs the report statement with the in-memory key (docs/rpc.md 5.20),
    // exactly like account.sign: not a diary write, no append, no network,
    // and the result never carries the payload or a key. The session fills
    // in member and association; text and quote enter the payload hashed.
    'report.sign': serial(async ({ nonce, target, seq, reason, text, quote }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      if (target === own) throw new UsageError(SELF_REPORT)
      const fields = { nonce, member: own, association: cfg.association, target, seq: seq === undefined ? null : seq, reason, text, quote }
      let signature
      try {
        signature = signReport(fields, keyPair)
      } catch (err) {
        // A shape the RPC layer lets through but the statement refuses (a
        // control character or a lone surrogate in text or quote).
        if (err instanceof TypeError) throw new UsageError(BAD_REPORT)
        throw err
      }
      return { signature }
    }),

    // Signs the terms-acceptance statement with the in-memory key
    // (docs/rpc.md 5.29), exactly like account.sign: not a diary write, no
    // append, no network, and the result never carries the payload or a key.
    // The session fills in member and association.
    'terms.sign': serial(async ({ nonce, version }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      const signature = signTerms({ nonce, member: own, association: cfg.association, version }, keyPair)
      return { signature }
    }),

    // Signs the signup-invite request with the in-memory key (docs/rpc.md
    // 5.30), exactly like terms.sign. The session fills in member and
    // association.
    'invite.sign': serial(async ({ action, nonce }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      const signature = signInvite({ action, nonce, member: own, association: cfg.association }, keyPair)
      return { signature }
    }),

    // Signs the age-verification request with the in-memory key (docs/rpc.md
    // 5.32), exactly like invite.sign. It needs no member certificate: the
    // age check runs before the account link.
    'age.sign': serial(async ({ action, nonce }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      const signature = signAge({ action, nonce, member: own, association: cfg.association }, keyPair)
      return { signature }
    }),

    // Signs the push-subscription statement with the in-memory key
    // (docs/rpc.md 5.31), exactly like terms.sign. The session fills in
    // member, association and the endpoint hash, so the caller never hands
    // in bytes to sign.
    'push.sign': serial(async ({ nonce, action, endpoint, p256dh, auth }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      let signature
      try {
        signature = signPush({ nonce, member: own, association: cfg.association, action, endpointHash: endpointHash(endpoint), p256dh, auth }, keyPair)
      } catch (err) {
        // The RPC layer lets through endpoints and keys the statement
        // refuses (a fragment marker, a p256dh that is not a P-256 point).
        if (err instanceof TypeError) throw new UsageError(BAD_PUSH)
        throw err
      }
      return { signature }
    }),

    'profile.set': serial(async ({ name, bio, avatar }, epoch) => {
      const own = await requireUnlocked()
      await ensureCaughtUp(epoch)
      const { seq } = await withStore((c) => member.profileSet(c, { name, bio, avatar }))
      wrote(seq)
      await pushAfterWrite()
      return { seq, ref: own + ':' + seq }
    }),

    // Appends an issuer-signed username record (docs/rpc.md 5.19). The record
    // must verify for the own key and the configured association. The gate
    // runs before the "already the latest" check, so a record another device
    // published (caught up here by the gate) is not appended again; a record
    // that already is the diary's latest verified one is not written, but is
    // still pushed while the seeder is not known to hold it (a push that
    // failed after the append is retried by handing the record in again).
    // The newest record by seq is the displayed name, so a record not newer
    // (by `date`) than the latest one is refused: an earlier name would
    // revert a rename, and two records of the same instant cannot be ordered.
    'username.add': serial(async ({ record }, epoch) => {
      const own = await requireUnlocked()
      if (!verifyUsernameRecord(record, own, cfg.association).ok) throw new UsageError(BAD_USERNAME_RECORD)
      await ensureCaughtUp(epoch)
      const { entries } = await withStore((c) => member.ownEntries(c))
      const latest = latestUsernameRecord(entries, own, cfg.association)
      if (latest !== null && member.deepEqual(latest, record)) {
        await pushAfterWrite()
        return { changed: false, username: record.username }
      }
      if (latest !== null && record.date <= latest.date) throw new UsageError(OLD_USERNAME_RECORD)
      const { seq } = await withStore((c) => member.usernameAdd(c, record))
      wrote(seq)
      await pushAfterWrite()
      return { changed: true, username: record.username, seq }
    }),

    // `media` (optional): descriptors from mediaUpload, verified by
    // member-ops against the own declared media cores before the append.
    'post.create': serial(async ({ text, media }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.postCreate(c, { text, media }))
      wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    'post.reply': serial(async ({ to, text, media }, epoch) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.postReply(c, { to: ref, text, media }))
      wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    // A quote: the post.reply path with a `quote` target.
    'post.quote': serial(async ({ to, text, media }, epoch) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.postQuote(c, { to: ref, text, media }))
      wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq }
    }),

    'post.delete': serial(async ({ to }, epoch) => recordDelete(member.postDelete, { to }, epoch)),

    'profile.delete': serial(async ({ to }, epoch) => recordDelete(member.profileDelete, { to }, epoch)),

    // Idempotent toggles on the post.reply path: a state already held
    // writes nothing (changed: false) and only pushes an outstanding length.
    'like.set': serial(async ({ to, on }, epoch) => engagementSet(member.likeSet, { to, on }, epoch)),

    'repost.set': serial(async ({ to, on }, epoch) => engagementSet(member.repostSet, { to, on }, epoch)),

    // Which of the refs the own diary likes / reposts; local data only,
    // works locked (as profile.read).
    'engagement.read': serial(async ({ refs }) => {
      const r = await withCores((c) => member.engagementRead(c, { refs }))
      return { liked: r.liked, reposted: r.reposted }
    }),

    'diary.peek': diaryPeek,

    // Local-first, unlocked only (a change queued while signed out would be
    // signed into the diary at the next sign-in by whoever had the browser);
    // the diary write is the drain, scheduled and not awaited: its outcome
    // never fails this request.
    'follow.add': serial(async ({ key }) => {
      await requireUnlocked()
      const r = await withStore((c) => member.followChange(c, key, true))
      if (r.changed) followChanged()
      return { changed: r.changed, followCount: r.follows.length }
    }),

    'follow.remove': serial(async ({ key }) => {
      await requireUnlocked()
      const r = await withStore((c) => member.followChange(c, key, false))
      if (r.changed) followChanged()
      return { changed: r.changed, followCount: r.follows.length }
    }),

    // On the chain (an add/remove that arrived first is listed), but not in
    // withStore: kv reads only, no core opened, so a run is not stopped; a
    // concurrent fold write is one JSON write, read old or new.
    'follow.list': serial(async ({ offset, limit }) => {
      const { follows } = await member.followList(ctx())
      return { follows: follows.slice(offset, offset + limit), total: follows.length }
    }),

    'log.read': serial(async ({ author, limit, before }) => {
      const r = await withCores((c) => member.logRead(c, { author: author === undefined ? null : author }))
      const all = r.entries
      // The window ends at `before` (exclusive), clamped to the length.
      const end = before === undefined ? all.length : Math.min(before, all.length)
      const window = all.slice(Math.max(0, end - limit), end)
      const entries = []
      const invalid = []
      for (const { seq, record, deleted } of window) {
        if (record === null) {
          invalid.push({ seq, reason: deleted === true ? 'deleted' : 'malformed' })
          continue
        }
        const copy = validRecordCopy(record, seq)
        if (copy !== null) entries.push({ seq, record: copy })
        else invalid.push({ seq, reason: validateRecord(record, seq) || 'malformed' })
      }
      return { key: r.key, entries, invalid, entriesTruncated: Math.max(0, end - limit) }
    }),

    'feed.read': serial(async ({ limit, before }) => {
      const r = await withCores((c) => member.feedRead(c, { limit, before: before === undefined ? null : before }))
      const skipped = capList(r.skipped)
      const future = capList(r.future)
      const incomplete = capList(r.incomplete, FEED_INCOMPLETE_MAX)
      return {
        items: r.items,
        skipped: skipped.list,
        skippedTruncated: skipped.truncated,
        future: future.list,
        futureTruncated: future.truncated,
        incomplete: incomplete.list,
        incompleteTruncated: incomplete.truncated
      }
    }),

    // Local data only, works locked (docs/rpc.md 5.21).
    'profile.read': serial(async ({ authors }) => {
      const r = await withCores((c) => member.profileRead(c, { authors }))
      return { profiles: r.profiles, missing: r.missing }
    }),

    // The Espiadinha (docs/rpc.md 5.22), works locked. NOT wrapped in
    // serial as a whole, on purpose: the peeker opens no storage core (it
    // reads kv and fetches into memory cores over its own link), so it has
    // no reason to preempt a running sync, and a page may take up to 25 s,
    // which must not hold every other request on the chain. Only the
    // own-key lookup may run serialized (NOT_FOUND 'identidade não
    // encontrada' as the other reads), and only while the key is not cached
    // or an identity change is pending (lookupOwnKey): then it may preempt
    // once and runs after that change. A cached key skips the chain, so a
    // write waiting on its gate does not hold the Espiadinha.
    // One at a time: the check runs BEFORE anything starts and the promise
    // of a refused call is never tracked.
    // The connection epoch is captured on arrival: a client that detached
    // while the lookup was queued (detach's abort found no peek to end)
    // gets 'conexão encerrada' and no link is ever opened for it; a read
    // that did start is aborted by detach and frees the slot at once.
    'peek.read': async (params) => {
      const epoch = connection
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      if (peeking !== null) throw rpcError('USAGE', PEEK_BUSY)
      // Checked again after the await, in the same turn as the dispatch: an
      // identity change called meanwhile found no read to abort.
      do await lookupOwnKey(params)
      while (lookupWanted())
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
      if (peeking !== null) throw rpcError('USAGE', PEEK_BUSY)
      const p = peeker.read(params)
      peeking = p
      unwinding.add(p)
      p.then(() => unwinding.delete(p), () => unwinding.delete(p))
      try {
        return await p
      } catch (err) {
        throw toRpcError(err, reportInternal)
      } finally {
        if (peeking === p) peeking = null
      }
    },

    // Notices (docs/rpc.md 5.28), works only unlocked (the link's proof is
    // signed by the identity key). Shaped like peek.read: not serial as a
    // whole, its own slot; only the own-key lookup (lookupOwnKey's rule)
    // and, on a v2 read, the own-diary read run on the chain.
    'notices.list': async (params) => {
      const epoch = connection
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      // Locked: refused before any socket is opened (the link's proof needs
      // the pair), and again after the wait, which may have seen a lock.
      if (keyPair === null) throw rpcError('USAGE', store.LOCKED)
      if (noticing !== null) throw rpcError('USAGE', NOTICES_BUSY)
      // Checked again after the await, in the same turn as the dispatch: an
      // identity change called meanwhile found no read to abort.
      do await lookupOwnKey(params)
      while (lookupWanted())
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
      if (keyPair === null) throw rpcError('USAGE', store.LOCKED)
      if (noticing !== null) throw rpcError('USAGE', NOTICES_BUSY)
      // Called by the noticer only on a v2 read: the own diary is read on
      // the chain (withCores alone does not exclude a write; serial does).
      const ownContext = () => serial(async () => {
        if (keyPair === null) throw new UsageError(store.LOCKED)
        noticeCtxCache = await withCores((c) => member.ownNoticeContext(c, noticeCtxCache))
        return noticeCtxCache
      })(params)
      const p = noticer.read(params, ownContext)
      noticing = p
      unwinding.add(p)
      p.then(() => unwinding.delete(p), () => unwinding.delete(p))
      try {
        return await p
      } catch (err) {
        throw toRpcError(err, reportInternal)
      } finally {
        if (noticing === p) noticing = null
      }
    },

    'sync.start': serial(async ({ once, timeoutMs }, epoch) => {
      const gone = () => epoch !== connection
      if (gone()) throw rpcError('USAGE', 'conexão encerrada')
      if (run !== null) throw rpcError('USAGE', 'sincronização já em andamento')
      const { publicKey } = await identity()
      if (gone()) throw rpcError('USAGE', 'conexão encerrada')
      if (publicKey === null) throw rpcError('NOT_FOUND', 'identidade não encontrada')
      if (run !== null) throw rpcError('USAGE', 'sincronização já em andamento')
      syncIntent = once ? null : 'continuous'
      kickLease() // an explicit start ignores the lease's gap
      const { runId } = startRun({ once, timeoutMs })
      return { runId }
    }),

    'sync.stop': serial(async () => {
      syncIntent = null
      kickLease()
      // The hold clocks survive a preempted end on purpose; an explicit stop
      // ends the intent, so a later start must earn its own hold.
      leaseSettledSince = leaseMediaSince = null
      const stopped = await stopRun('stopped')
      return { stopped }
    }),

    'sync.status': serial(async () => {
      restartWhenIdle(1)
      return syncState()
    })
  }

  // ---- host controls ----

  // Every control below runs on the handler chain (serial), so none can
  // overlap an RPC on the same storage or an append signing with the key.

  function copyKey (buf, size) {
    if (!(buf instanceof Uint8Array) || buf.byteLength !== size) throw new TypeError('par de chaves inválido')
    const out = new Uint8Array(size)
    out.set(buf)
    return out
  }

  function copyPair (pair) {
    if (pair === null || typeof pair !== 'object') throw new TypeError('par de chaves inválido')
    return { publicKey: copyKey(pair.publicKey, 32), secretKey: copyKey(pair.secretKey, 64) }
  }

  function zeroPair (pair) {
    if (pair === null) return
    pair.secretKey.fill(0)
    pair.publicKey.fill(0)
  }

  // Both keys go together: a locked identity has no media key either. A
  // notices read in flight (its link is held by the proof the pair signed)
  // is aborted and its slot freed, wherever the lock comes from.
  function zeroKeyPair () {
    noticer.abort()
    noticing = null
    noticeCtxCache = null
    zeroPair(keyPair)
    keyPair = null
    zeroPair(mediaKeyPair)
    mediaKeyPair = null
  }

  // A follow change happened: a drain is due, retries start afresh.
  function followChanged () {
    drainRetries = 0
    scheduleDrain()
  }

  // Unlocks the identity with the pair derived from the passkey, and this
  // device's media key pair when the page derived one (`media`; without it
  // uploads are refused as locked). Both are copied synchronously (the
  // caller may zero its buffers right away); any previous pair is
  // zero-filled. The cached identity is forgotten so a stored diary of
  // another key surfaces on the next operation as USAGE 'passkey não
  // corresponde ao diário guardado'. Nothing is written here; the follow
  // drain is scheduled right after.
  function setKeyPair (pair, { media } = {}) {
    const copy = copyPair(pair)
    let mediaCopy = null
    try {
      if (media !== undefined && media !== null) mediaCopy = copyPair(media)
    } catch (err) {
      zeroPair(copy)
      throw err
    }
    return identityChange(() => serial(async () => {
      // A peek in flight belongs to the previous identity.
      peeker.abort()
      peeking = null
      noticer.abort()
      noticing = null
      zeroKeyPair()
      keyPair = copy
      mediaKeyPair = mediaCopy
      synced = false
      ownKey = null
      certKnown = false
      followChanged()
    })(), { abort: true }).catch((err) => {
      zeroPair(copy)
      zeroPair(mediaCopy)
      throw err
    })
  }

  function isIntIn (value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max
  }

  // Stores one image in this device's media core -> its descriptor (the
  // `media` entry of a later post). Validated and copied synchronously
  // (TypeError), then on the serial chain: unlocked with a media key (else
  // USAGE 'identidade bloqueada'), hashed, the core readied (mediaPrepare,
  // inside withStore), declared through the write gate and pushed like any
  // diary write when the diary does not declare it yet, and only then
  // stored (mediaCommit, inside withStore). onProgress (optional) hears
  // 0.25 hashed, 0.75 stored, 1 done; errors reach the caller as RPC
  // errors ({ code, message }). Nothing about the bytes is logged.
  function mediaUpload ({ bytes, mime, width, height, onProgress } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_MEDIA_ITEM_BYTES) throw new TypeError(BAD_MEDIA_ARGS)
    if (typeof mime !== 'string' || !MEDIA_MIMES.includes(mime)) throw new TypeError(BAD_MEDIA_ARGS)
    if (!isIntIn(width, 1, MAX_MEDIA_DIMENSION) || !isIntIn(height, 1, MAX_MEDIA_DIMENSION)) throw new TypeError(BAD_MEDIA_ARGS)
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    const progress = typeof onProgress === 'function' ? (fraction) => { try { onProgress(fraction) } catch {} } : noop
    return serial(async (_, epoch) => {
      await requireUnlocked()
      if (mediaKeyPair === null) throw new UsageError(store.LOCKED)
      // The declaration needs block 0: checked before any byte is stored, so
      // a diary without its certificate gets no orphan media core.
      if (!(await identity()).memberCert) throw new Error(member.GENESIS_REQUIRED)
      const subtle = globalThis.crypto && globalThis.crypto.subtle
      if (!subtle) throw new Error('WebCrypto indisponível')
      const sha256 = b4a.toString(new Uint8Array(await subtle.digest('SHA-256', copy)), 'hex')
      progress(0.25)
      const blocks = []
      for (let at = 0; at < copy.byteLength; at += MEDIA_BLOCK_BYTES) {
        blocks.push(copy.subarray(at, Math.min(copy.byteLength, at + MEDIA_BLOCK_BYTES)))
      }
      // Declare BEFORE storing: a declaration the gate refuses (seeder
      // unreachable) rejects with nothing appended, so a retry never fills
      // the fixed-size core with another copy of the item.
      const { core, declared } = await withStore((c) => member.mediaPrepare(c))
      if (!declared) {
        await ensureCaughtUp(epoch)
        const { seq } = await withStore((c) => member.declareMediaCore(c, core))
        wrote(seq)
        await pushAfterWrite()
      }
      const descriptor = await withStore((c) => member.mediaCommit(c, { blocks, mime, width, height, sha256 }))
      progress(0.75)
      progress(1)
      return descriptor
    })({})
  }

  // Locks the identity: the pair is zero-filled. After close() it already is.
  function clearKeyPair () {
    if (closing !== null) return closing.then(noop)
    return identityChange(() => serial(async () => { zeroKeyPair() })())
  }

  // The follows kept from before `follow` records existed (member-ops
  // legacyFollows) -> { keys }; unlocked only.
  const legacyFollows = serial(async () => {
    await requireUnlocked()
    return withStore((c) => member.legacyFollows(c))
  })

  // Publishes exactly the confirmed legacy follows (member-ops
  // confirmLegacyFollows: signed pending ops, the rest leave kv follows,
  // the marker is set) -> { published }, and schedules the drain. keys:
  // at most MAX_INVENTORY - 1 lowercase hex64 strings (TypeError otherwise).
  function confirmLegacyFollows (keys) {
    if (!Array.isArray(keys) || keys.length > MAX_INVENTORY - 1 ||
        keys.some((k) => typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k))) {
      throw new TypeError('chaves inválidas')
    }
    const copy = [...keys]
    return serial(async () => {
      await requireUnlocked()
      const r = await withStore((c) => member.confirmLegacyFollows(c, copy))
      followChanged()
      return { published: r.published }
    })({})
  }

  // -> { exists, publicKey (hex | null), legacy, unlocked, synced }, from the
  // storage (cached once the diary was seen: its key never changes short of
  // reset) without the key pair, so a mismatch is reported, not thrown.
  const identityStatus = serial(async () => {
    if (diaryInfo === null) {
      const s = await withStore((c) => store.diaryStatus(c.storage))
      if (s.exists) {
        diaryInfo = { publicKey: s.publicKey, legacy: s.legacy }
        ownKey = s.publicKey
      }
      return { ...s, unlocked: keyPair !== null, synced }
    }
    return { exists: true, publicKey: diaryInfo.publicKey, legacy: diaryInfo.legacy, unlocked: keyPair !== null, synced }
  })

  // Removes the diary (every page, the oplog header slots of a legacy store
  // included), this device's media cores (kv mediaCores and mediaDevice
  // with them), the pending follow changes and the per-device migration
  // marker, and locks both keys; 'config' and 'follows' stay. A sync in
  // progress is stopped and not restarted.
  const resetChain = serial(async () => {
    peeker.abort()
    peeking = null
    noticer.abort()
    noticing = null
    syncIntent = null
    kickLease()
    await stopRun('stopped')
    await storage.deleteCore(store.DIARY)
    store.forgetLegacy(storage)
    await store.deleteMediaCores(storage)
    await store.writeFollowsPending(storage, [])
    await store.clearFollowsMigrated(storage)
    zeroKeyPair()
    ownKey = null
    certKnown = false
    diaryInfo = null
    synced = false
    unpushed = true
    localLength = null
    drainWanted = false
    drainRetries = 0
    lastFoldLength = null
    foldLength = null
  })

  function attach (emit) {
    if (typeof emit !== 'function') throw new TypeError('emit required')
    emitter = emit
  }

  // The connection closed: no more events, and a running sync and a
  // running peek stop.
  function detach () {
    // The slot is released at once (the aborted read, still unwinding, sees
    // it was aborted and throws; its finally only clears its own promise),
    // so a reconnected client's peek.read starts immediately.
    peeker.abort()
    peeking = null
    noticer.abort()
    noticing = null
    connection++
    emitter = null
    syncIntent = null
    return stopRun('stopped').then(noop)
  }

  // Stops accepting requests (later ones -> LOCKED 'sessão encerrada'),
  // stops the sync (a gate run a write is waiting on included: that write
  // fails instead of holding the close for its deadline) and the peek,
  // awaits every queued operation and the peek in flight (settled either
  // way: ./node.js closes the storage right after), and zero-fills the key.
  // Idempotent. The storage stays open: its owner (./node.js) closes it
  // after this.
  function close () {
    if (closing !== null) return closing
    closed = true
    syncIntent = null
    peeker.abort()
    peeking = null
    noticer.abort()
    noticing = null
    closing = (async () => {
      await stopRun('stopped')
      await chain
      // Every read still unwinding, also one a detach (node.close closes the
      // port first) already released the slot of.
      await Promise.allSettled([...unwinding])
      await stopRun('stopped')
      peeker.close()
      noticer.close()
      zeroKeyPair()
    })()
    return closing
  }

  return {
    handlers,
    attach,
    detach,
    close,
    setKeyPair,
    clearKeyPair,
    mediaUpload,
    borrow,
    legacyFollows: () => legacyFollows({}),
    confirmLegacyFollows,
    identityStatus: () => identityStatus({}),
    reset: () => identityChange(() => resetChain({}), { abort: true }),
    // 'open' | 'closed'
    get state () {
      return closed ? 'closed' : 'open'
    }
  }
}

module.exports = { createBrowserSession, toRpcError, checkConfig, redactLogLine }
