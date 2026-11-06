'use strict'

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
//   log.read, profile.read, engagement.read, the community.* and group.*
//   reads, the notices own-diary read, the upkeep's plan) is served from
//   the live run's cores while a run exists (withCores, web only; the run
//   keeps going, same runId), and opens and closes the storage itself when
//   none does. Only writes, and reads the run cannot serve, preempt: a
//   running sync is aborted and awaited first; a continuous run is
//   restarted afterwards with a new runId (sync.stopped 'preempted', then
//   sync.started).
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
// Group keys use the passkey PRF handed in as setKeyPair(pair, { prf }).
// The session copies it, derives each writer with its stored nonce and
// clears it with the identity. Writes also wait for group-synced on the
// own writer (and the creator root), then restart sync to push new lengths.
// Lock/reset cancel queued group writes and interrupt their pending gates.
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
// The device upkeep (docs/rpc.md 5.61 and 5.63): a device of an account
// takes part by itself in the communities and groups its diary binds
// (member-ops deviceUpkeepPlan / deviceUpkeep: a CW and the Geral writer
// here, epoch keys handed by the creator's device to the account's new
// writers). ONE serial pass at a time, never inside onEvent. A pass plans
// in full on the live run's cores (withCores: the run lends its own group
// cores and the foreign ones it keeps; a core it does not lend reruns the
// plan under withStore), so an empty plan never stops the run. One
// exception skips the full plan: the echo of a write made on this device (an own
// length equal to its last write: a post, a like, a follow), after the
// session's first full plan, with no failure, transient skip or unarmed
// 'group-writer' since, and a full plan younger than upkeepFullMaxAgeMs,
// first asks on the borrowed diary (withCores) whether a root lacks a
// bound writer of this device, and ends there without stopping the run.
// Any other trigger arriving before that pass makes it plan in full. That
// is safe: a write here that creates share work (an admit, a role change)
// lands in a group core and arrives as 'groups-changed', which plans in
// full, and a diary join is enrol work the precheck sees.
// Only a non-empty plan writes, through the write gate, then pushes,
// like a diary write. It is armed by a NEW own length on a user's
// continuous run (another device appended, or a write here landed; the
// pass's own write does not re-arm it, unless the write gate brought blocks
// of another device; an unlock arms from the live run's last own length, a
// reload or a new connection from the next own-synced), and once per
// arming by a 'settled' report after the passes ran out; a failed pass or
// a failed root queues another within the bound; a 'group-writer' (a writer
// core stored for the first time, once per key and at most
// MAX_UPKEEP_WRITERS keys per session) arms afresh, so the distributor
// plans after the new device's writer arrived; while armed, a
// 'groups-changed' (the root or writer a skipped root waited for) queues
// another pass. A timer (upkeepDelayMs) coalesces a burst into one pass, at
// most MAX_UPKEEP_PASSES per arming, so a plan the run's cores cannot serve
// stops its continuous run a bounded number of times per new own length;
// progress earns fresh passes for what the write unblocked, and a pass
// that leaves nothing waiting (no failure, no skip a sync can resolve) and
// saw no newer arming disarms. A step that threw after writing still sends
// groups.changed and pushes. It defers while a user's once run
// is alive (as the drain), is silent while locked, and a failure is the
// warning 'aviso: participação automática neste aparelho não concluída',
// never an RPC error: nothing is resent, the next pass plans again from
// storage.
//
// The lease (web only, docs/rpc.md 6.1; off unless leaseHoldMs > 0, which
// no shipped entry sets today, the browser entry keeps it off): a seeder link that has nothing left to do
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
//
// Direct messages (web only, docs/rpc.md 5.73 to 5.81): ./dm.js holds the
// box key pair and the local store key, derived at setKeyPair from the PRF
// and zeroed with the identity (lock, reset, close). dm.enable publishes the
// dm-key through the write gate; dm.send and dm.set put over a fresh
// anonymous link (./dm-link.js), never the sync socket; dm.pull runs off the
// chain (one at a time); dm.lookup reads local data on the chain and
// otherwise a bounded newest-first diary.peek scan off it. A continuous run
// ticks a pull every DM_PULL_EVERY_MS and a wallet check (top-ups over the
// separate stamp link, at most one per 10 minutes, and once after an
// unlock with a dm-key). reset() removes the local store and the dm kv.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { RpcError, isSafeMessage, capList, capSyncResult, clipText, MAX_LINE, MAX_ID, PEEK_TIMEOUT_MS, FEED_INCOMPLETE_MAX, mediaBounds, audioBounds, stripAudioMetadata, AUDIO_MS_TOLERANCE } = require('@varanda/rpc')
const {
  validRecordCopy,
  validateRecord,
  parseRef,
  MEDIA_BLOCK_BYTES,
  MAX_MEDIA_ITEM_BLOCKS,
  MEDIA_MIMES,
  MAX_MEDIA_DIMENSION,
  AUDIO_MIME,
  MAX_AUDIO_MS,
  MAX_AUDIO_BYTES
} = require('@varanda/core/lib/records')
const { formatEvent, key8 } = require('@varanda/core/lib/sync-format')
const { safe } = require('@varanda/core/lib/safe')
const { UsageError } = require('@varanda/core/lib/errors')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signReport, signDmReport } = require('@varanda/core/lib/report')
const { signTerms } = require('@varanda/core/lib/terms')
const { signRecovery, blobHashOf } = require('@varanda/core/lib/recovery-proof')
const { signInvite } = require('@varanda/core/lib/invite')
const { signAge } = require('@varanda/core/lib/age')
const { signPush, endpointHash } = require('@varanda/core/lib/push-proof')
const { verifyUsernameRecord } = require('@varanda/core/lib/cert')
const { verifyAgeVerified, verifyAgeSince } = require('@varanda/core/lib/age-proof')
const { latestUsernameRecord } = require('@varanda/core/lib/username')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const member = require('./member-ops')
const { runSync, SEEDER_UNAVAILABLE, DIARY_UNAVAILABLE } = require('./sync')
const { createPeeker } = require('./peek')
const { createNoticer } = require('./notices')
const { createPageFeeder } = require('./page-feed')
const { signPage, canonicalOp, opHash: pageOpHash, ACTIONS: PAGE_STATEMENTS } = require('@varanda/core/lib/page-proof')
const { signRoster, signAccept, signOffer, signOrigin, signClose, signMoved, pageState, PAGE_ROSTER_REFRESH_BLOCKS } = require('@varanda/core/lib/page')
const { pageLifecycle, cutEntries, originOf } = require('@varanda/core/lib/page-lifecycle')
const { deletedSeqs, applyDeletes } = require('@varanda/core/lib/deletion')
const { followSet } = require('@varanda/core/lib/media')
const { sealMedia, openMedia, validPrivateItem, PRIVATE_ITEM_KEYS, MAX_SEALED_MEDIA_PLAIN_BYTES } = require('@varanda/core/lib/group-media')
const { signNoticeProof } = require('@varanda/core/lib/notices')
const store = require('./node-store')
const { groupKeyPairFromPrf } = require('./passkey')
const { createGroupKeys } = require('./group-keys')
const { checkSeederUrl } = require('./seeder-url')
const { createDmEngine } = require('./dm')

const HEX64 = /^[0-9a-fA-F]{64}$/
const LOCKED_MESSAGE = 'diretório de dados em uso'
const CLOSED_MESSAGE = 'sessão encerrada'
const INTERNAL_MESSAGE = 'erro interno'
const NOT_SYNCED_MESSAGE = 'sincronize com o semeador antes de publicar'
const BAD_USERNAME_RECORD = 'registro de nome inválido'
const BAD_AGE_PROOF = 'comprovante de idade inválido'
const OLD_USERNAME_RECORD = 'registro de nome antigo'
const SELF_REPORT = 'não é possível denunciar a própria chave'
const BAD_REPORT = 'denúncia inválida'
const BAD_PUSH = 'inscrição de notificação inválida'
const GATE_LINE = 'sincronizando antes de publicar'
const PUSH_LINE = 'enviando ao semeador'
const DRAIN_WARNING = 'aviso: seguidos ainda não enviados'
const UPKEEP_WARNING = 'aviso: participação automática neste aparelho não concluída'
const BAD_MEDIA_ARGS = 'mídia inválida'
const GROUP_MEDIA_UNAVAILABLE = 'mídia indisponível'
const NO_SEEDER = 'sem conexão com o semeador'
const PEEK_BUSY = 'espiadinha já em andamento'
const NOTICES_BUSY = 'avisos já em andamento'
const DIARY_PEEK_BUSY = 'ocupado'
const BAD_PAGE = 'operação de página inválida'
const PAGE_FEED_BUSY = 'feed de página já em andamento'
const PAGE_REGISTER_CORE_ONLY = 'registro de página disponível só no nó core'
const NO_LOCAL_DATA = 'sem dados locais para este diário'
// page.read (docs/rpc.md 5.85): the bounded read of a page diary this node
// does not hold peeks blocks 1..3 and this many windows of PEEK_WINDOW seqs,
// newest first (288 >= PAGE_ROSTER_REFRESH_BLOCKS, so the roster the
// service refreshes every 256 blocks is always inside). The result's lists
// are capped as PAGE_READ_FOLLOWS_MAX / PAGE_READ_LINKS_MAX of @varanda/rpc.
const PAGE_READ_WINDOWS = 8
const PAGE_READ_HEAD = 3
const PAGE_READ_FOLLOWS_MAX = 64
const PAGE_READ_LINKS_MAX = 16 + 1
// A window is first asked for under this share of the peek deadline: a
// block the seeder cleared (its tombstone in the same window) never
// arrives, so only what the answer's tombstones leave missing is asked for
// again under the whole deadline.
const PAGE_READ_PROBE_SHARE = 8
// Direct messages (see the header): the sync loop pulls at most this often
// and checks the wallet on this tick; a dm-key lookup by peek reads at most
// this many windows of PEEK_WINDOW seqs, newest first.
const DM_PULL_EVERY_MS = 120000
const DM_TICK_MS = 60000
const DM_LOOKUP_WINDOWS = 8
const PEEK_WINDOW = 36
// diary.peek requests in flight at once.
const MAX_DIARY_PEEKS = 2
// One deadline for the internal catch-up and push runs.
const WRITE_GATE_TIMEOUT_MS = 15000
// The longest a read waits for a starting run to publish its cores
// (withCores) before it preempts the run instead.
const READER_WAIT_MS = 3000
const NOT_READY = Symbol('not ready')
// Failed drains retried from own-synced without a new follow change.
const MAX_DRAIN_RETRIES = 3
// The device upkeep (see the header): passes per arming, and the delay that
// coalesces a burst of triggers into one pass.
const MAX_UPKEEP_PASSES = 3
const UPKEEP_DELAY_MS = 1500
// Per arming, whatever progress or a 'settled' report granted since.
const MAX_UPKEEP_TOTAL = 3 * MAX_UPKEEP_PASSES
// Writer keys whose 'group-writer' armed the upkeep, per session.
const MAX_UPKEEP_WRITERS = 512
// The longest the upkeep trusts the precheck before planning in full again.
const UPKEEP_FULL_MAX_AGE_MS = 10 * 60 * 1000
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
  'sem permissão no grupo',
  'limite de grupos atingido',
  'limite do grupo atingido',
  'sem permissão na comunidade',
  'limite da comunidade atingido',
  'o grupo já está em outra comunidade',
  'o criador da comunidade já administra',
  'nada a alterar',
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
  'grupo não encontrado',
  'comunidade não encontrada',
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
  if (code === 'NOT_FOUND' && NOT_FOUND_MESSAGES.has(message)) return rpcError('NOT_FOUND', message)
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

// ---- pages (docs/rpc.md 5.84 and 5.85) ----

function hasOwn (o, k) {
  return Object.prototype.hasOwnProperty.call(o, k)
}

// Exactly `keys` as own keys of a plain object, else TypeError.
function exactOp (o, keys) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new TypeError('invalid page op')
  const own = Object.keys(o)
  if (own.length !== keys.length || !keys.every((k) => hasOwn(o, k))) throw new TypeError('invalid page op')
  return o
}

function copyList (v) {
  return Array.isArray(v) ? [...v] : v
}

// The association is the node's own (cfg.association): an op that names one
// at any depth is refused, as the RPC layer does for callers that skip it.
function namesAssociation (v) {
  if (Array.isArray(v)) return v.some(namesAssociation)
  if (v === null || typeof v !== 'object') return false
  return Object.keys(v).some((k) => k === 'association' || namesAssociation(v[k]))
}

// page.sign's result for the own key `own` (the pair's public key). The
// record builders (lib/page.js) check every field the signer covers and
// that the pair is the record's signer (owner or actor), so a roster for
// another owner or a malformed field is a TypeError, never a signature.
function pageSignResult ({ action, nonce, page, op }, own, keyPair, association) {
  if (namesAssociation(JSON.parse(canonicalOp(op)))) throw new TypeError('invalid page op')
  const statement = (o) => signPage({ action, nonce, member: own, page, association, opHash: pageOpHash(o) }, keyPair)
  const roster = (f) => ({ type: 'page-roster', ...f, signature: signRoster(f, keyPair) })
  switch (action) {
    case 'accept': {
      exactOp(op, ['gen', 'rosterSignature', 'at', 'nonce'])
      const f = { page, gen: op.gen, rosterSignature: op.rosterSignature, at: op.at, nonce: op.nonce, actor: own }
      return { record: { type: 'page-accept', ...f, signature: signAccept(f, keyPair) } }
    }
    case 'remove':
    case 'transfer-accept':
      exactOp(op, ['gen', 'owner', 'admins', 'prev', 'at', 'nonce'])
      return { record: roster({ page, gen: op.gen, owner: op.owner, admins: copyList(op.admins), prev: op.prev, at: op.at, nonce: op.nonce, association }) }
    case 'offer': {
      exactOp(op, ['to', 'exp', 'gen', 'at', 'nonce'])
      const f = { page, to: op.to, exp: op.exp, gen: op.gen, at: op.at, nonce: op.nonce, actor: own }
      return { record: { type: 'page-offer', ...f, signature: signOffer(f, keyPair) } }
    }
    case 'close': {
      exactOp(op, ['gen', 'at', 'nonce'])
      const f = { page, gen: op.gen, at: op.at, nonce: op.nonce, actor: own, association }
      return { record: { type: 'page-close', ...f, signature: signClose(f, keyPair) } }
    }
    case 'move': {
      exactOp(op, ['to', 'gen', 'fromSeq', 'owner', 'admins', 'at', 'nonce'])
      if (op.to === page) throw new TypeError('invalid page op')
      const moved = { page, to: op.to, gen: op.gen, at: op.at, nonce: op.nonce, actor: own, association }
      const origin = { page: op.to, from: page, fromSeq: op.fromSeq, gen: op.gen, owner: op.owner, admins: copyList(op.admins), at: op.at, nonce: op.nonce, actor: own, association }
      return {
        record: { type: 'page-moved', ...moved, signature: signMoved(moved, keyPair) },
        origin: { type: 'page-origin', ...origin, signature: signOrigin(origin, keyPair) },
        roster: roster({ page: op.to, gen: 1, owner: op.owner, admins: copyList(op.admins), prev: null, at: op.at, nonce: op.nonce, association })
      }
    }
    case 'create': {
      exactOp(op, ['username', 'name', 'bio', 'roster'])
      const r = exactOp(op.roster, ['gen', 'admins', 'prev', 'at', 'nonce'])
      if (r.gen !== 1 || r.prev !== null || !Array.isArray(r.admins) || r.admins.length !== 0) throw new TypeError('invalid page op')
      const record = roster({ page, gen: 1, owner: own, admins: [], prev: null, at: r.at, nonce: r.nonce, association })
      return { signature: statement(op), record }
    }
    case 'invite': {
      exactOp(op, ['member', 'gen', 'rosterSignature', 'roster'])
      const r = exactOp(op.roster, ['owner', 'admins', 'prev', 'at', 'nonce'])
      if (typeof op.rosterSignature !== 'string') throw new TypeError('invalid page op')
      const record = roster({ page, gen: op.gen, owner: r.owner, admins: copyList(r.admins), prev: r.prev, at: r.at, nonce: r.nonce, association })
      return { signature: statement({ ...op, rosterSignature: record.signature }), record }
    }
    default:
      if (!PAGE_STATEMENTS.includes(action)) throw new TypeError('invalid page action')
      return { signature: statement(op) }
  }
}

// The winning follow record's seq for each key of `follows`, newest first
// (@varanda/core lib/member.js pageFollows).
function pageFollows (entries, follows) {
  const wanted = new Set(follows)
  const winning = new Map()
  for (const entry of entries) {
    const copy = entry.record == null ? null : validRecordCopy(entry.record, entry.seq)
    if (copy === null || copy.type !== 'follow' || !wanted.has(copy.key)) continue
    const prev = winning.get(copy.key)
    if (prev === undefined || entry.seq > prev) winning.set(copy.key, entry.seq)
  }
  return [...winning].map(([key, seq]) => ({ key, seq })).sort((a, b) => (b.seq - a.seq) || (a.key < b.key ? -1 : 1))
}

// page.read's answer over RAW entries (never after applyDeletes, so a
// tombstone cannot undo a close, a move or a roster): the lifecycle first,
// then the roster over the blocks up to a close or a move. Follows are no
// page-* records, so their tombstones apply. The shape of the core node's
// (@varanda/core lib/member.js pageRead).
function pageReadResult ({ pageHex, entries, own, association, revokedIssuers, full, complete }) {
  const opts = { revokedIssuers }
  const lifecycle = pageLifecycle(entries, pageHex, association, opts)
  const cut = cutEntries(entries, lifecycle)
  const state = pageState(cut, pageHex, association, { revokedIssuers, full })
  // A page-origin after a terminal close or move does not count (as core).
  const origin = originOf(cut, pageHex, association, opts)
  const live = applyDeletes(cut)
  const follows = pageFollows(live, followSet(live, pageHex))
  const roster = state.page ? [state.owner, ...state.admins] : []
  const links = new Map()
  for (const link of lifecycle.links) {
    if (roster.includes(link.actor)) links.set(link.actor, link)
  }
  return {
    page: pageHex,
    owner: state.owner,
    admins: state.admins,
    gen: state.page ? state.gen : null,
    seq: state.seq,
    isOwner: state.page && state.owner === own,
    isAdmin: state.page && state.admins.includes(own),
    complete: complete(state),
    follows: follows.slice(0, PAGE_READ_FOLLOWS_MAX),
    followsCount: follows.length,
    followsTruncated: follows.length > PAGE_READ_FOLLOWS_MAX,
    closed: lifecycle.closed !== null,
    movedTo: lifecycle.movedTo === null ? null : { to: lifecycle.movedTo.to, seq: lifecycle.movedTo.seq },
    movedFrom: origin === null ? null : { from: origin.from, fromSeq: origin.fromSeq },
    links: [...links.values()].sort((a, b) => b.seq - a.seq).slice(0, PAGE_READ_LINKS_MAX)
      .map((l) => ({ actor: l.actor, diary: l.diary, seq: l.seq }))
  }
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

// A run's `ready`, or NOT_READY once ms passed first.
function readyWithin (ready, ms) {
  let timer = null
  const late = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms), NOT_READY) })
  return Promise.race([ready, late]).finally(() => clearTimeout(timer))
}

// ---- the session ----

// syncOptions: test-only overrides passed to runSync (limits and timings).
// limits: test-only overrides of the own diary limits.
// writeGate: the catch-up run before every diary write and the push run
// after it (test fixtures without a seeder pass false; the browser entry
// never passes it). writeGateTimeoutMs: their deadline (tests).
// readerWaitMs: how long a read waits for a starting run's cores (tests).
// peekTimeoutMs: the diary.peek deadline (tests; the contract's otherwise).
// leaseHoldMs: the lease (header); 0 = off. leaseGapMs, leaseMediaMaxMs:
// its gap and its media wait. noClear: keep the bytes of deleted blocks
// (the browser's VARANDA_NO_CLEAR kill switch; tombstones still hide them).
// upkeepDelayMs: the device upkeep's coalescing delay (tests).
// upkeepFullMaxAgeMs: the age after which it plans in full again (tests).
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
  readerWaitMs = READER_WAIT_MS,
  peekTimeoutMs = PEEK_TIMEOUT_MS,
  leaseHoldMs = 0,
  leaseGapMs = LEASE_GAP_MS,
  leaseMediaMaxMs = LEASE_MEDIA_MAX_MS,
  noClear = false,
  upkeepDelayMs = UPKEEP_DELAY_MS,
  upkeepFullMaxAgeMs = UPKEEP_FULL_MAX_AGE_MS,
  fetchMedia = (...args) => globalThis.fetch(...args)
} = {}) {
  const cfg = checkConfig({ storage, association, seederUrl, createSocket })
  const reportInternal = (err) => {
    try { onInternalError(err) } catch {}
  }

  function ctx () {
    const epoch = connection
    const generation = groupEpoch
    return {
      storage,
      association: cfg.association,
      keyPair,
      mediaKeyPair,
      groupKeyPair: keyPair !== null && groupPrf !== null ? (nonce) => deriveGroupKeyPair(nonce, epoch, generation) : null,
      groupKeys: boxKeys,
      limits,
      noClear: noClear === true
    }
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
  // append-only, so only `memberCert: true` is cached). certDate is the
  // verified certificate's date; null while certKnown came from a path that
  // did not see the certificate (own-recovered), so identity() reads once.
  let ownKey = null
  let certKnown = false
  let certDate = null
  // The cached certificate's issuer (null for a v1 certificate): node.info
  // checks it against the current revoked issuers on every call.
  let certIssuer = null
  // The stored age attestations (kv ageVerified / ageSince), re-verified
  // from storage once per identity (kv is device-owner writable) and then
  // cached like certDate: the age-verified date for the own key and the
  // age-since `since` and `date`, each null when absent or not verifying.
  // The age-since vouches only for certificates dated in [since, date] and
  // signed by its own issuer, so its issuer is cached beside them.
  let ageVerifiedDate = null
  let ageSinceDate = null
  let ageSinceUntil = null
  let ageSinceIssuer = null
  let ageChecked = false
  // The revoked issuers both attestations are checked against (as member
  // certificates and username records are), cached per stored blocklist
  // snapshot: a snapshot a sync run adopted after the first read drops the
  // age cache too, so a revoked issuer's attestation reads as null on the
  // next node.info.
  let ageSnapshotKey = null
  let ageRevoked = new Set()
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
  let groupPrf = null
  // The private-group box key pair and the epoch keys opened this session,
  // in memory only (./group-keys.js): locked with every identity change,
  // closed with the session.
  const boxKeys = createGroupKeys()
  let groupEpoch = 0
  let groupWriting = false
  const groupPairs = new Set()
  const groupUnpushed = new Map()
  // The length of each own group core when last read here (after a write or
  // before a write gate): a 'group-synced' at a shorter length is stale and
  // never lets a write append past what the seeder was compared with.
  const groupLengths = new Map()
  // The follow drain: at most one operation queued; drainWanted after a
  // failure (retried from own-synced, drainRetries times in a row).
  let drainQueued = false
  let drainWanted = false
  let drainRetries = 0
  // The device upkeep (header): a pass queued on the chain, one deferred by
  // a user's once run, armed, the own length it was armed for, passes since
  // the arming, whether a 'settled' report re-armed it already, the passes
  // since the arming that nothing resets (the absolute bound), and the
  // coalescing timer.
  let upkeepQueued = false
  let upkeepWanted = false
  let upkeepArmed = false
  let upkeepLength = null
  let upkeepPasses = 0
  let upkeepRearmed = false
  let upkeepTotal = 0
  let upkeepTimer = null
  const upkeepWriters = new Set()
  // Bumped by every arming: a pass disarms only the arming it ran for.
  let upkeepArming = 0
  // Whether a full plan (withStore) ran in this session, whether the next
  // pass must plan in full anyway (header), when the last full plan ran,
  // and whether the next pass is only the echo of a write made here.
  let shareChecked = false
  let upkeepFull = false
  let upkeepFullAt = 0
  let upkeepQuick = false
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
  // The one page.feed in flight (same rules as `peeking`).
  let pageFeeding = null
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

  // page.feed (docs/rpc.md 5.86): its own short-lived link, like the peeker.
  const pageFeeder = createPageFeeder({
    storage,
    association: cfg.association,
    seederUrl: cfg.seederUrl,
    createSocket,
    log: (text) => warning(safe(text)),
    limits: syncOptions.pageFeed
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

  const dmEngine = createDmEngine({
    storage,
    association: cfg.association,
    seederUrl: cfg.seederUrl,
    createSocket,
    log: (text) => warning(safe(text)),
    emit: (event, data) => send(event, data),
    fetch: fetchMedia,
    limits: syncOptions.dm
  })
  let dmLastPull = 0
  let dmRecheck = false
  let dmRecheckTries = 0
  const DM_RECHECK_TRIES = 3

  // The sync loop's direct message tick: while a continuous run lives and
  // the identity is unlocked with a published dm-key, a pull every
  // DM_PULL_EVERY_MS and a wallet check (the engine limits top-ups to one
  // per 10 minutes). Off the chain: it opens no storage core. Never throws.
  async function dmTick () {
    try {
      if (closed || keyPair === null || ownKey === null || !dmEngine.unlocked()) return
      if ((await store.readDmKey(storage)) === null) return
      const own = ownKey
      if (Date.now() - dmLastPull >= DM_PULL_EVERY_MS && !dmEngine.pulling) {
        dmLastPull = Date.now()
        await dmEngine.pull(own).catch(noop)
      }
      if (keyPair !== null) await dmEngine.topUp(keyPair)
    } catch {}
  }

  // ---- sync runs ----

  // internal: a gate or push run of the session itself (its line names it;
  // it never changes syncIntent). onOwnSynced: called on the run's first
  // own-synced. -> the run record.
  function startRun ({ once, timeoutMs, internal = false, label = null, onOwnSynced = noop, onGroupProgress = noop }) {
    lastRunId = lastRunId >= MAX_ID ? 1 : lastRunId + 1
    const runId = lastRunId
    const epoch = connection
    const { signal, abort } = createAbort()
    // leased: a user's continuous run under the lease; settled: its last
    // readiness report; leaseTimer: the hold.
    const r = { runId, once, internal, ownSynced: false, groupSynced: new Map(), groupBehind: new Set(), abort, reason: null, done: null, leased: !once && !internal && leaseHoldMs > 0, settled: false, leaseTimer: null, ready: null }
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
    if (!once && !internal) r.dmTimer = setInterval(() => { dmTick() }, DM_TICK_MS)
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
          followPage: syncOptions.followPage !== undefined ? syncOptions.followPage : followMovedPage,
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
                  try { onOwnSynced(r) } catch {}
                  if (!once && !internal) {
                    dmTick()
                    if (dmRecheck) {
                      dmRecheck = false
                      dmRefresh({ recheck: true }).catch(noop)
                    }
                  }
                  if (!once && drainWanted && drainRetries < MAX_DRAIN_RETRIES) scheduleDrain()
                }
                if (!once && !internal && Number.isSafeInteger(ev.length)) {
                  // Kept while locked too: the link reports each length once,
                  // so the unlock arms from it (setKeyPair).
                  r.ownLength = ev.length
                  if (ev.length !== upkeepLength) {
                    // The echo of a write made here may take the precheck,
                    // unless another trigger already queued a pass.
                    const pending = upkeepTimer !== null || upkeepQueued
                    armUpkeep(ev.length)
                    if (!pending && localLength !== null && ev.length === localLength) upkeepQuick = true
                  }
                }
                return
              case 'group-skipped':
                // The legacy sweep at sync start (protocol v1 cores purged).
                if (ev.reason === 'legacy') warning('aviso: grupo ' + key8(ev.key) + ' ignorado (legacy)', epoch)
                return
              case 'groups-changed':
                if (typeof ev.group === 'string' && HEX64.test(ev.group)) send('groups.changed', { group: ev.group }, epoch)
                // What a skipped root waited for may have arrived. A group
                // change can create share work the precheck cannot see, so
                // even the next echo of a local write plans in full.
                if (!once && !internal) upkeepFull = true
                if (!once && !internal && upkeepRoom()) scheduleUpkeep()
                return
              case 'group-writer':
                // A writer stored after the pass that planned on the own
                // length its join made (or another diary's entitled
                // writer): a fresh arming, once per writer key.
                if (!once && !internal && keyPair !== null && groupPrf !== null && typeof ev.writer === 'string' && HEX64.test(ev.writer) && !upkeepWriters.has(ev.writer) && upkeepWriters.size < MAX_UPKEEP_WRITERS) {
                  upkeepWriters.add(ev.writer)
                  armUpkeep(upkeepLength)
                } else if (typeof ev.writer === 'string' && HEX64.test(ev.writer) && !upkeepWriters.has(ev.writer)) {
                  // Not armed for (a once or internal run, the key cap,
                  // locked): a later echo still plans the shares in full.
                  upkeepFull = true
                }
                return
              case 'group-synced':
                if (!Number.isSafeInteger(ev.length) || ev.length < 0) return
                r.groupSynced.set(ev.key, ev.length)
                r.groupBehind.delete(ev.key)
                onGroupProgress(r)
                break
              case 'group-behind':
                r.groupSynced.delete(ev.key)
                r.groupBehind.add(ev.key)
                onGroupProgress(r)
                break
              case 'group-pushed':
                if (groupUnpushed.has(ev.key) && ev.length >= groupUnpushed.get(ev.key)) groupUnpushed.delete(ev.key)
                break
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
                // A run whose goals are met holds the roots a pass waited
                // for: one more arming, once per run and per arming.
                if (!once && !internal && ev.settled === true && !r.upkeepSettled) {
                  r.upkeepSettled = true
                  if (upkeepArmed && upkeepPasses >= MAX_UPKEEP_PASSES && !upkeepRearmed) {
                    upkeepRearmed = true
                    upkeepPasses = 0
                    scheduleUpkeep()
                  }
                }
                return
              case 'own-behind':
                synced = false
                r.ownSynced = false
                event('diário próprio atrasado (' + safe(String(ev.length)) + '/' + safe(String(ev.theirs)) + ')')
                return
              case 'link-closed':
                r.groupSynced.clear()
                r.groupBehind.clear()
                synced = false
                r.ownSynced = false
                return
              case 'own-recovered':
                certKnown = true
                event('certificado recuperado do semeador')
                return
              case 'newest':
                event('newest ' + safe(String(ev.key)) + ' ' + safe(String(ev.length)))
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
      if (r.dmTimer) clearInterval(r.dmTimer)
      clearLease(r)
      // A drain deferred by this user's once run is due now.
      if (once && !internal && drainWanted && drainRetries < MAX_DRAIN_RETRIES) scheduleDrain()
      if (once && !internal && upkeepWanted) scheduleUpkeep()
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
  // stopRun waits for every hold, ours included. A startup that has not
  // published the cores within readerWaitMs (slow or stuck storage) is
  // preempted too: every read, and whatever is queued behind it, would
  // otherwise wait on it with no limit.
  async function withCores (fn) {
    const r = run
    if (r === null) return withStore(fn)
    const api = await readyWithin(r.ready, readerWaitMs)
    if (api === NOT_READY) {
      warning('aviso: leitura sem esperar a partida da sincronização (' + readerWaitMs + ' ms)')
      return withStore(fn)
    }
    if (api === null || !api.hold()) {
      await r.done
      return withStore(fn)
    }
    try {
      return await fn({ ...ctx(), cores: { diary: api.diary, replica: api.replica, group: api.group } })
    } catch (err) {
      if (!member.isNeedsExclusive(err)) throw err
    } finally {
      api.release()
    }
    return withStore(fn)
  }

  // Whether the stored replica of `key` is forked, on the run's core when
  // c lends it (a read just served there), else on the storage's. A
  // borrowed read never opens it: the run may have stopped lending a core
  // it has not closed yet, and a second instance would corrupt it, so that
  // read reruns on the exclusive path.
  async function replicaForked (c, key) {
    const lent = c.cores ? c.cores.replica(key) : null
    if (lent !== null) return lent.fork !== 0
    if (!(await store.replicaExists(c.storage, key))) return false
    if (c.cores) throw member.needsExclusive()
    const core = await store.openReplica(c.storage, key)
    try {
      return core.fork !== 0
    } finally {
      await core.close()
    }
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
  async function ensureCaughtUp (epoch, groupKeys = [], generation = null) {
    kickLease() // a write redials, inside the lease's gap too
    if (!writeGate) return
    if (trackingOwn() && groupKeys.every((key) => groupCaughtUp(run, key))) return
    if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
    if (run !== null) await stopRun('preempted')
    if (generation !== null) checkGroupOperation(epoch, generation)
    const waited = []
    for (const key of groupKeys) {
      if (await refusedWriter(key)) {
        groupUnpushed.delete(key)
        continue
      }
      waited.push(key)
    }
    groupKeys = waited
    for (const key of groupKeys) await readGroupLength(key)
    if (generation !== null) checkGroupOperation(epoch, generation)
    const intent = syncIntent
    synced = false
    let ok = false
    let arrived
    const progress = (r) => {
      if (groupKeys.some((key) => r.groupBehind.has(key))) {
        ok = false
        return arrived()
      }
      if (r.ownSynced && groupKeys.every((key) => groupCaughtUp(r, key))) {
        ok = true
        arrived()
      }
    }
    const caughtUp = new Promise((resolve) => { arrived = resolve })
    const r = startRun({
      once: true,
      timeoutMs: writeGateTimeoutMs,
      internal: true,
      label: GATE_LINE,
      onOwnSynced: progress,
      onGroupProgress: progress
    })
    await Promise.race([caughtUp, r.done])
    await stopRun('preempted')
    if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
    if (generation !== null) checkGroupOperation(epoch, generation)
    syncIntent = intent
    if (!ok) throw new UsageError(NOT_SYNCED_MESSAGE)
  }

  // Whether run r reported own group core `key` in sync at no less than its
  // current length (not only the key's presence).
  function groupCaughtUp (r, key) {
    return r.groupSynced.has(key) && r.groupSynced.get(key) >= (groupLengths.get(key) || 0)
  }

  // Only while no run holds the core (one handle per core): whether own
  // writer `key` has no `box` while its group's held, verified root is
  // private (a join by key before the root arrived). No seeder admits it, so
  // nothing waits for its push; the next join replaces it with a boxed one.
  async function refusedWriter (key) {
    const header = async (k) => {
      const core = await store.openGroupCoreReadOnly(storage, k)
      if (core === null) return null
      try { return await store.readBlock0(core) } catch { return null } finally { await core.close() }
    }
    const w = await header(key)
    if (w === null || w.type !== 'group-writer' || w.box !== null || typeof w.group !== 'string' || w.group === key) return false
    const g = await header(w.group)
    return g !== null && g.type === 'group-header' && g.visibility === 'private'
  }

  // Only while no run holds the core (one handle per core).
  async function readGroupLength (key) {
    const core = await store.openGroupCoreReadOnly(storage, key)
    if (core === null) return
    try { groupLengths.set(key, core.length) } finally { await core.close() }
  }

  // After a diary write (or any write handler while the seeder is not known
  // to hold the current length): the seeder receives it. A continuous run
  // that the write preempted restarts afterwards (restartWhenIdle) and
  // pushes; else an internal once run does, awaited so the caller knows it
  // ended (its outcome is in the sync.stopped event; the write stays either
  // way, and an unconfirmed push is retried on the next write).
  async function pushAfterWrite () {
    kickLease()
    if (!writeGate || closed || (!unpushed && groupUnpushed.size === 0) || syncIntent === 'continuous') return
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
    return diaryPeekWithin(params, peekTimeoutMs)
  }

  // diary.peek under its own deadline (page.read's probe).
  function diaryPeekWithin (params, timeoutMs) {
    if (closed) return Promise.reject(rpcError('LOCKED', CLOSED_MESSAGE))
    if (diaryPeeksInFlight >= MAX_DIARY_PEEKS) return Promise.reject(rpcError('USAGE', DIARY_PEEK_BUSY))
    return borrow(() => diaryPeekWith(params, timeoutMs))
  }

  async function diaryPeekWith ({ author, seqs, profileSeq, usernameSeq }, timeoutMs) {
    diaryPeeksInFlight++
    try {
      const deadline = Date.now() + timeoutMs
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
      const generation = groupEpoch
      queued++
      const p = chain.then(async () => {
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        try {
          return await fn(params, epoch, generation)
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
    if (ownKey !== null && certKnown && certDate !== null) return { publicKey: ownKey, memberCert: true, memberCertDate: certDate, memberCertIssuer: certIssuer }
    // Only the date is missing (own-recovered saw no certificate): a read on
    // the live run's cores, so node.info never stops a sync for it.
    const read = ownKey !== null && certKnown ? withCores : withStore
    const r = await read((c) => member.identityState(c))
    if (r.publicKey !== null) ownKey = r.publicKey
    if (r.memberCert) {
      certKnown = true
      certDate = r.memberCertDate
      certIssuer = r.memberCertIssuer
    }
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

  // -> { ageVerifiedDate, ageSince, ageSinceUntil } for the own key `own`
  // (null: no identity, nothing cached). Kv reads only: never opens a store,
  // so it never preempts a sync. An object that does not verify reads as null.
  async function ageState (own) {
    if (own === null) return { ageVerifiedDate: null, ageSince: null, ageSinceUntil: null }
    const revokedIssuers = await ageRevokedIssuers()
    if (!ageChecked) {
      const verified = await store.readAgeVerified(storage)
      const since = await store.readAgeSince(storage)
      ageVerifiedDate = verified !== null && verifyAgeVerified(verified, own, cfg.association, { revokedIssuers }).ok ? verified.date : null
      const sinceOk = since !== null && verifyAgeSince(since, cfg.association, { revokedIssuers }).ok
      ageSinceDate = sinceOk ? since.since : null
      ageSinceUntil = sinceOk ? since.date : null
      ageSinceIssuer = sinceOk ? since.issuer.toLowerCase() : null
      ageChecked = true
    }
    // An issuer vouches only for its own certificates: the age-since counts
    // for the cached block-0 v2 certificate of the same issuer, never for one
    // of another issuer or a v1 certificate (certIssuer null).
    const bound = ageSinceIssuer !== null && certKnown && typeof certIssuer === 'string' && certIssuer.toLowerCase() === ageSinceIssuer
    return { ageVerifiedDate, ageSince: bound ? ageSinceDate : null, ageSinceUntil: bound ? ageSinceUntil : null }
  }

  // -> the stored snapshot's revoked issuers (empty when none verifies). The
  // cache key is the snapshot's identity (moderator, moderatorDate, seq and
  // signature: every adopted snapshot differs in one of them), so a large
  // snapshot is neither serialized nor verified on every read; a change
  // re-verifies the attestations on the next read.
  async function ageRevokedIssuers () {
    const data = await store.readBlocklist(storage)
    const sn = data === null ? null : data.snapshot
    const key = sn === null ? '' : [sn.moderator, sn.moderatorDate, sn.seq, sn.signature].map(String).join('|')
    if (key !== ageSnapshotKey) {
      ageRevoked = (await member.moderation(storage, cfg.association)).revokedIssuers
      ageSnapshotKey = key
      ageChecked = false
    }
    return ageRevoked
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

  function checkGroupOperation (epoch, generation) {
    if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
    if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
    if (generation !== groupEpoch || keyPair === null || groupPrf === null) throw new UsageError(store.LOCKED)
  }

  function cancelGroups () {
    groupEpoch++
    boxKeys.lock()
    if (groupWriting && run !== null && run.internal) run.abort()
  }

  async function deriveGroupKeyPair (nonce, epoch, generation) {
    checkGroupOperation(epoch, generation)
    const pair = await groupKeyPairFromPrf(groupPrf, nonce)
    try {
      checkGroupOperation(epoch, generation)
    } catch (err) {
      zeroPair(pair)
      throw err
    }
    groupPairs.add(pair)
    return pair
  }

  async function ownGroupKeys (group) {
    const entry = (await store.readGroupWriters(storage)).find((e) => e.group === group)
    if (!entry) return []
    return [...new Set([entry.key, ...(entry.rootNonce === null ? [] : [entry.group])])]
  }

  // The own cores a group write may touch (the write gate waits for each),
  // and the keys whose groups.changed it emits: `roots` lists the group or
  // community roots of the params, `changed` the keys after the write.
  const GROUP_ROOTS = (params) => [params.group]
  const GROUP_CHANGED = async (c, result, params) => [result.group || params.group]

  // A community write that changes who belongs or acts in C: C and every
  // local group whose header names C re-read (rpc.md section 6). It may
  // also append to the device's writers in those groups (a group-leave, or
  // key blocks of a rotation in a private group), so the gate waits for
  // them and their new lengths are pushed. Read under withStore: the group
  // roots are never opened beside a run's instance.
  const COMMUNITY_WIDE = {
    roots: async (params) => [params.community, ...await withStore((c) => member.communityGroups(c, { community: params.community }))],
    changed: async (c, result, params) => [params.community, ...await member.communityGroups(c, { community: params.community })]
  }

  // The community a group's held root header names, or null. Read under
  // withStore: the core is never opened beside a run's instance.
  function communityOfGroup (group) {
    return withStore((c) => member.groupCommunityOf(c, group))
  }

  // Moderation a community admin or creator may write through its
  // community writer (CW): the gate waits for that CW too, and its new
  // length is pushed.
  const GROUP_AND_COMMUNITY = {
    roots: async (params) => {
      const community = await communityOfGroup(params.group)
      return community === null ? [params.group] : [params.group, community]
    }
  }

  // Inside withStore, after a group write: the own cores of `roots` are due
  // a push at their new lengths. A join can create a writer after the
  // previous run took its snapshot; the next run opens every own writer
  // from the updated kv list.
  async function noteWrittenRoots (roots) {
    for (const group of new Set(roots.filter((k) => typeof k === 'string'))) {
      for (const key of await ownGroupKeys(group)) {
        if (await refusedWriter(key)) continue
        const core = await store.openGroupCoreReadOnly(storage, key)
        if (core === null) continue
        try {
          groupUnpushed.set(key, core.length)
          groupLengths.set(key, core.length)
        } finally { await core.close() }
      }
    }
  }

  function groupWrite (operation, { roots = GROUP_ROOTS, changed = GROUP_CHANGED } = {}) {
    return serial(async (params, epoch, generation) => {
      checkGroupOperation(epoch, generation)
      await requireUnlocked()
      groupWriting = true
      try {
        const rootKeys = await roots(params)
        const keys = []
        for (const root of rootKeys) keys.push(...await ownGroupKeys(root))
        checkGroupOperation(epoch, generation)
        await ensureCaughtUp(epoch, [...new Set(keys)], generation)
        const result = await withStore(async (c) => {
          checkGroupOperation(epoch, generation)
          const result = await operation(c, params)
          const groups = [...new Set(await changed(c, result, params))]
          await noteWrittenRoots([...rootKeys, result.group, result.community])
          await member.withIdentity(c, async ({ diary }) => { wrote(diary.length - 1) })
          for (const group of groups) send('groups.changed', { group }, epoch)
          return result
        })
        checkGroupOperation(epoch, generation)
        await pushAfterWrite()
        checkGroupOperation(epoch, generation)
        return result
      } finally {
        groupWriting = false
        for (const pair of groupPairs) zeroPair(pair)
        groupPairs.clear()
      }
    })
  }

  // ---- the device upkeep (see the header) ----

  // A new own length on a user's continuous run: fresh passes. While locked
  // nothing is armed; the unlock arms from the live run's last length
  // (setKeyPair), as does the next own-synced after a reload.
  function armUpkeep (length) {
    if (closed || keyPair === null || groupPrf === null) return
    upkeepArmed = true
    upkeepArming++
    upkeepLength = length
    upkeepPasses = 0
    upkeepTotal = 0
    upkeepRearmed = false
    scheduleUpkeep()
  }

  // Whether this arming may still run a pass.
  function upkeepRoom () {
    return upkeepArmed && upkeepPasses < MAX_UPKEEP_PASSES && upkeepTotal < MAX_UPKEEP_TOTAL
  }

  // Inside withStore: the length of each own core of `roots`.
  async function ownCoreLengths (roots) {
    const out = new Map()
    for (const group of new Set(roots)) {
      for (const key of await ownGroupKeys(group)) {
        const core = await store.openGroupCoreReadOnly(storage, key)
        if (core === null) continue
        try { out.set(key, core.length) } finally { await core.close() }
      }
    }
    return out
  }

  // One pass per timer: the delay turns a burst of triggers into one stop of
  // the continuous run.
  function scheduleUpkeep () {
    // Every trigger but an own write's echo (which sets it after) plans in full.
    upkeepQuick = false
    if (upkeepQueued || upkeepTimer !== null || closed || keyPair === null || groupPrf === null) return
    upkeepTimer = setTimeout(() => {
      upkeepTimer = null
      if (closed || upkeepQueued) return
      upkeepQueued = true
      upkeep({}).catch(noop)
    }, upkeepDelayMs)
  }

  function resetUpkeep () {
    if (upkeepTimer !== null) clearTimeout(upkeepTimer)
    upkeepTimer = null
    upkeepArmed = false
    upkeepLength = null
    upkeepPasses = 0
    upkeepTotal = 0
    upkeepRearmed = false
    upkeepWanted = false
    upkeepWriters.clear()
    shareChecked = false
    upkeepFull = false
    upkeepFullAt = 0
    upkeepQuick = false
  }

  // The pass never calls another serial handler and never runs inside
  // onEvent: it stops a run only through withStore / ensureCaughtUp, like
  // every write, and the chain's restartWhenIdle restarts it. It never
  // throws to anyone: a failure is a warning, and nothing is retried here
  // (a later pass of the same bounded arming plans again from storage, so
  // nothing is resent).
  const upkeep = serial(async (_, epoch, generation) => {
    upkeepQueued = false
    if (!upkeepRoom()) return
    try { checkGroupOperation(epoch, generation) } catch { return }
    if (!(await store.diaryExists(storage))) return
    // The app's recovery run must not be preempted; its end queues the pass.
    if (run !== null && run.once) {
      upkeepWanted = true
      return
    }
    upkeepWanted = false
    const arming = upkeepArming
    // The echo of a write made here, with every bound root served by a
    // writer of this device, has nothing a full plan would find: the run is
    // not stopped for it. A precheck that throws plans in full, which
    // reports the failure.
    const quick = upkeepQuick && shareChecked && !upkeepFull && Date.now() - upkeepFullAt < upkeepFullMaxAgeMs
    upkeepQuick = false
    if (!quick) {
      upkeepFull = false
    } else {
      let needed = true
      try { needed = await withCores((c) => member.deviceUpkeepNeeded(c)) } catch {}
      if (!needed) {
        // A full-plan trigger that arrived during the await keeps the arming
        // so its scheduled pass still runs.
        if (arming === upkeepArming && !upkeepFull) upkeepArmed = false
        return
      }
      try { checkGroupOperation(epoch, generation) } catch { return }
    }
    upkeepPasses++
    upkeepTotal++
    groupWriting = true
    const ownLength = (c) => member.withIdentity(c, async ({ diary }) => diary.length)
    const stale = () => closed || epoch !== connection || generation !== groupEpoch || keyPair === null
    try {
      const { plan, planLength } = await withCores(async (c) => ({ plan: await member.deviceUpkeepPlan(c), planLength: await ownLength(c) }))
      shareChecked = true
      upkeepFullAt = Date.now()
      // Only what a later sync can bring keeps the arming: a root skipped
      // for good (reserve, full, orphan, status) does not.
      let waiting = plan.skipped.filter((x) => x.transient === true).map((x) => x.root)
      // A transient skip may be a share (its root lists here, so the
      // precheck passes it): even an echo plans in full until it resolves.
      if (waiting.length > 0) upkeepFull = true
      let arrived = false
      let failed = 0
      if (plan.enrol.length > 0 || plan.share.length > 0) {
        const keys = [...new Set(plan.share.map((s) => s.writer))]
        const planned = [...plan.enrol.map((x) => x.root), ...plan.share.map((x) => x.group)]
        checkGroupOperation(epoch, generation)
        await ensureCaughtUp(epoch, keys, generation)
        let before = null
        let after = null
        let grew = false
        let failure = null
        let result = null
        try {
          result = await withStore(async (c) => {
            checkGroupOperation(epoch, generation)
            before = await ownLength(c)
            const lengths = await ownCoreLengths(planned)
            let r = null
            try {
              r = await member.deviceUpkeep(c, { enrol: plan.enrol, share: plan.share })
            } finally {
              // A step that threw may have written first: its roots are
              // pushed too, from the plan when the result is lost.
              after = await ownLength(c)
              if (after > before) wrote(after - 1)
              const now = await ownCoreLengths(planned)
              grew = after > before || [...now].some(([key, length]) => lengths.get(key) !== length)
              await noteWrittenRoots(r === null ? planned : [...r.changed, ...r.failed.map((f) => f.root)])
            }
            return r
          })
        } catch (err) {
          failure = err
        }
        const sent = result === null ? (grew ? planned : []) : result.changed
        for (const group of new Set(sent)) send('groups.changed', { group }, epoch)
        // The gate brought blocks of another device: roots this pass did
        // not plan may be bound now, so that length is no echo and the
        // arming stays.
        arrived = before !== null && before > planLength
        // The own-synced that echoes this write is no new length.
        if (!arrived && after !== null && after > before) upkeepLength = after
        if (failure !== null) {
          // What the step wrote before it threw is pushed all the same.
          if (grew && !stale()) {
            try { await pushAfterWrite() } catch {}
          }
          throw failure
        }
        // Each progress is a write, so fresh passes cannot loop: they serve
        // what it unblocked (a group after its community's writer), and
        // upkeepTotal bounds them.
        if (result.enrolled.length > 0 || result.shared.length > 0) upkeepPasses = 0
        const changed = new Set(result.changed)
        failed = result.failed.length
        waiting = waiting.filter((root) => !changed.has(root)).concat(result.failed.map((f) => f.root))
        if (failed > 0) {
          // A failed share is invisible to the precheck: even an echo
          // plans in full until a pass succeeds.
          upkeepFull = true
          warning(UPKEEP_WARNING, epoch)
        }
        checkGroupOperation(epoch, generation)
        await pushAfterWrite()
      }
      if (arrived) scheduleUpkeep()
      else if (failed > 0) {
        // A root that failed is tried again within the bound.
        if (upkeepRoom()) scheduleUpkeep()
      } else if (waiting.length === 0 && arming === upkeepArming) upkeepArmed = false
    } catch (err) {
      upkeepFull = true
      if (!stale()) {
        warning(UPKEEP_WARNING, epoch)
        // Still armed: another pass of this bounded arming tries again.
        if (upkeepRoom()) scheduleUpkeep()
      }
    } finally {
      groupWriting = false
      for (const pair of groupPairs) zeroPair(pair)
      groupPairs.clear()
    }
  })

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

  // ---- direct messages (docs/rpc.md 5.73 to 5.81) ----

  // The identity unlocked AND the dm keys derived (setKeyPair with a prf).
  async function requireDm () {
    const own = await requireUnlocked()
    if (!dmEngine.unlocked()) throw new UsageError(store.LOCKED)
    return own
  }

  // The newest dm-key of `member` -> { box, gen } (both null when none).
  // Local data on the chain; else a bounded newest-first scan through the
  // diary.peek path OFF the chain (a peek waits for the run, which the chain
  // would hold back). Never logs the key.
  async function dmLookupOf (memberKey) {
    const key = memberKey.toLowerCase()
    const localHit = await serial(() => withCores((c) => member.dmLookup(c, key)))({})
    if (localHit !== null) return localHit
    const first = await diaryPeek({ author: key, seqs: [1] })
    const found = first.entries.slice()
    let best = member.newestDmKey(found)
    let hi = first.length - 1
    for (let w = 0; best === null && hi > 1 && w < DM_LOOKUP_WINDOWS; w++) {
      const lo = Math.max(2, hi - PEEK_WINDOW + 1)
      const seqs = []
      for (let q = lo; q <= hi; q++) seqs.push(q)
      const r = await diaryPeek({ author: key, seqs })
      best = member.newestDmKey(r.entries)
      hi = lo - 1
    }
    return best === null ? { box: null, gen: null } : { box: best.box, gen: best.gen }
  }

  // Read the live run's cores so a current dm-key costs no write gate or
  // preemption. An append still goes through the gate; a check before
  // catch-up is confirmed once the continuous run first catches up.
  async function dmEnable (epoch) {
    await requireDm()
    const { box, gen } = dmEngine.boxHex()
    const state = await withCores(async (c) => {
      const length = await member.withIdentity(c, ({ diary }) => diary.length)
      if (length === 0) return 'empty'
      return await member.dmKeyStale(c, { box, gen }) ? 'stale' : 'current'
    })
    if (state === 'current') {
      if (!trackingOwn()) dmRecheck = true
      if ((await store.readDmKey(storage)) === null) await store.writeDmKey(storage, gen)
      // Only a write made in this session can still be waiting for its push
      // (an earlier dm.enable whose push failed); a fresh start pushes nothing.
      if (localLength !== null) await pushAfterWrite()
      return { box, gen, seq: null }
    }
    await ensureCaughtUp(epoch)
    const r = await withStore((c) => member.dmKeyEnsure(c, { box, gen }))
    if (r.seq !== null) wrote(r.seq)
    await store.writeDmKey(storage, gen)
    await pushAfterWrite()
    return r
  }

  // Read the live run's cores after unlock, and after the next catch-up
  // when dm.enable checked an unsynced diary, so a current key keeps the
  // run alive. A stale key still appends through dm.enable's write gate.
  // A failure is a warning; a failed check that came from a catch-up is armed
  // again for the next catch-up, at most DM_RECHECK_TRIES times per identity,
  // so a dropped link cannot leave the key outside readers' scan window.
  const dmRefresh = serial(async (params, epoch) => {
    const recheck = params !== null && typeof params === 'object' && params.recheck === true
    try {
      if (keyPair === null || !dmEngine.unlocked()) return
      const { box, gen } = dmEngine.boxHex()
      if (!(await withCores((c) => member.dmKeyStale(c, { box, gen })))) {
        // Judged on a diary that may be behind: confirm after the next catch-up.
        if (!trackingOwn()) dmRecheck = true
        return
      }
      await dmEnable(epoch)
    } catch {
      if (recheck && dmRecheckTries < DM_RECHECK_TRIES) {
        dmRecheckTries++
        dmRecheck = true
      }
      warning('aviso: chave de mensagens não renovada')
    }
  })

  // ---- handlers (docs/rpc.md section 5; params arrive validated) ----

  const handlers = {
    'node.info': serial(async () => {
      const { publicKey, memberCert, memberCertDate, memberCertIssuer } = await identity()
      restartWhenIdle(1)
      // The date vouches for the age policy, so a certificate whose issuer
      // was revoked after it was cached answers null (memberCert unchanged).
      const revoked = memberCertDate !== null && memberCertIssuer !== null && (await ageRevokedIssuers()).has(memberCertIssuer.toLowerCase())
      return {
        publicKey,
        memberCert,
        memberCertDate: revoked ? null : memberCertDate,
        ...(await ageState(publicKey)),
        followCount: (await store.readFollows(storage)).length,
        sync: syncState(),
        publicDht: false,
        groups: true
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
      // certAdd verified this certificate and block 0 now equals it.
      certDate = cert.date
      certIssuer = typeof cert.issuer === 'string' ? cert.issuer : null
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
    // An `anexo` (a group message only) is the attachment's hex SHA-256: it
    // switches the statement to report v3, and the bytes never reach here.
    'report.sign': serial(async ({ nonce, target, seq, reason, text, quote, writer, group, anexo }) => {
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
      if (writer !== undefined) fields.writer = writer
      if (group !== undefined) fields.group = group
      if (anexo !== undefined) fields.anexo = anexo
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

    // Signs a recovery-entry request with the in-memory key (docs/rpc.md
    // 5.90), exactly like terms.sign: not a diary write, no append, no
    // network, and the result never carries the payload, the blob or a key.
    // The session fills in member and association and hashes the blob
    // itself, so the caller can never sign a hash of something else. It uses
    // only the diary key pair, never the group PRF, which native installs do
    // not hold.
    'recovery.sign': serial(async ({ action, nonce, kind, lookupId, blob }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      const put = action === 'put'
      const list = action === 'list'
      const fields = {
        action,
        nonce,
        member: own,
        association: cfg.association,
        kind: list ? '' : kind,
        lookupId: list ? '' : lookupId,
        blobHash: put ? blobHashOf({ kind, lookupId, blob }) : ''
      }
      const signature = signRecovery(fields, keyPair)
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

    // Stores the account service's signed age attestations (docs/rpc.md
    // 5.83) after verifying them against the own key and the association.
    // Nothing is signed, so no unlock and no certificate (the age step runs
    // before the link). Both objects are verified before anything is
    // written, so a bad pair stores nothing.
    'age.proof': serial(async ({ verified, since }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      const revokedIssuers = await ageRevokedIssuers()
      if (verified !== undefined && !verifyAgeVerified(verified, own, cfg.association, { revokedIssuers }).ok) throw new UsageError(BAD_AGE_PROOF)
      if (since !== undefined && since !== null) {
        if (!verifyAgeSince(since, cfg.association, { revokedIssuers }).ok) throw new UsageError(BAD_AGE_PROOF)
        // Monotonic: a replayed older age-since never replaces a newer one
        // that still verifies, or certificates issued while the check was
        // off would vouch again.
        const stored = await store.readAgeSince(storage)
        if (stored !== null && verifyAgeSince(stored, cfg.association, { revokedIssuers }).ok && Date.parse(since.date) < Date.parse(stored.date)) throw new UsageError(BAD_AGE_PROOF)
      }
      // Dropped first (a failed write leaves no stale cache), then re-read
      // and re-verified against the snapshot stored now, which a sync may
      // have replaced since the check above.
      ageChecked = false
      if (verified !== undefined) await store.writeAgeVerified(storage, verified)
      if (since !== undefined) await store.writeAgeSince(storage, since)
      return await ageState(own)
    }),

    // Signs a page statement or a page record (docs/rpc.md 5.84) with the
    // in-memory key, exactly like age.sign: no append, no network, no
    // core opened while the key is known. The session fills in member,
    // actor (or owner) and association; the result never carries a key,
    // the payload or the operation hash.
    'page.sign': serial(async ({ action, nonce, page, op }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      try {
        return pageSignResult({ action, nonce, page, op }, own, keyPair, cfg.association)
      } catch (err) {
        if (err instanceof TypeError || err instanceof SyntaxError) throw new UsageError(BAD_PAGE)
        throw err
      }
    }),

    // A page's roster and lifecycle (docs/rpc.md 5.85), works locked. NOT
    // serial as a whole: a page diary this node holds is read on the chain
    // (withCores, served on a live run's cores); otherwise a bounded
    // newest-first diary.peek scan runs off it, as dm.lookup's does (a peek
    // waits for the run, which the chain would hold back).
    'page.read': async ({ key, full }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const pageHex = key.toLowerCase()
      const local = await serial(async () => {
        const own = await requireOwnKey()
        const mod = await member.moderation(storage, cfg.association)
        let held = null
        try {
          held = await withCores(async (c) => {
            const read = await member.logReadRaw(c, { author: pageHex })
            return { ...read, forked: pageHex !== own && await replicaForked(c, pageHex) }
          })
        } catch (err) {
          if (messageOf(err) !== NO_LOCAL_DATA) throw err
        }
        return { own, revokedIssuers: mod.revokedIssuers, held }
      })({})
      const base = { pageHex, own: local.own, association: cfg.association, revokedIssuers: local.revokedIssuers }
      // The bounded rule: the service refreshes the roster every
      // PAGE_ROSTER_REFRESH_BLOCKS blocks, so a verifying roster that new is
      // the current one; an older one may have been superseded unseen.
      const fresh = (length) => (state) => state.page && state.seq >= length - PAGE_ROSTER_REFRESH_BLOCKS
      // A held diary is read RAW: a tombstone a leaked page key appends
      // cannot reopen a close nor undo a move or a roster. Every stored block
      // counts (a followed diary downloads newest-first, its tail past a
      // gap); only a diary held whole is walked as a chain.
      if (local.held !== null) {
        // A forked replica answers as the core node's pageRead: no page.
        if (local.held.forked) throw rpcError('NOT_FOUND', NO_LOCAL_DATA)
        const { entries, length } = local.held
        if (entries.length === length) return pageReadResult({ ...base, entries, full: true, complete: () => true })
        return pageReadResult({ ...base, entries, full: false, complete: fresh(length) })
      }
      try {
        const first = await diaryPeek({ author: pageHex, seqs: [1, 2, 3] })
        const length = first.length
        const entries = first.entries.slice()
        const missing = first.missing.filter((s) => s < length)
        let skipped = false
        let hi = length - 1
        // The seqs of [lo, hi] no tombstone read so far deletes.
        const notGone = (lo, hi) => {
          const gone = deletedSeqs(entries.slice().sort((a, b) => a.seq - b.seq))
          const seqs = []
          for (let q = lo; q <= hi; q++) {
            if (gone.has(q)) skipped = true
            else seqs.push(q)
          }
          return seqs
        }
        for (let w = 0; hi > PAGE_READ_HEAD && w < PAGE_READ_WINDOWS; w++) {
          const lo = Math.max(PAGE_READ_HEAD + 1, hi - PEEK_WINDOW + 1)
          // A tombstone comes after its target, so the newer windows already
          // read hold it: the seeder clears the target, and asking for it
          // would only stall the window until the peek deadline.
          const seqs = notGone(lo, hi)
          hi = lo - 1
          if (seqs.length === 0) continue
          // Its tombstone may sit in this same window: the probe's answer
          // names it, and only the blocks still missing after it are waited
          // for. A probe that fails is the plain read.
          let probe = null
          try {
            probe = await diaryPeekWithin({ author: pageHex, seqs }, Math.max(1, Math.floor(peekTimeoutMs / PAGE_READ_PROBE_SHARE)))
          } catch {}
          let again = seqs
          if (probe !== null) {
            entries.push(...probe.entries)
            const gone = deletedSeqs(entries.slice().sort((a, b) => a.seq - b.seq))
            again = probe.missing.filter((q) => {
              if (!gone.has(q)) return true
              skipped = true
              return false
            })
          }
          if (again.length === 0) continue
          const r = await diaryPeek({ author: pageHex, seqs: again })
          entries.push(...r.entries)
          missing.push(...r.missing)
        }
        // A skipped block is not read, so the chain walk (full) is off.
        const whole = hi <= PAGE_READ_HEAD && missing.length === 0 && !skipped
        const bounded = fresh(length)
        return pageReadResult({
          ...base,
          entries,
          full: full === true && whole,
          complete: (state) => whole || bounded(state)
        })
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
    },

    // The newest rows of a page's follows (docs/rpc.md 5.86), works locked.
    // Shaped like peek.read: not serial, its own slot and its own link
    // (./page-feed.js); nothing is written anywhere.
    'page.feed': async ({ keys, limit }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      if (pageFeeding !== null) throw rpcError('USAGE', PAGE_FEED_BUSY)
      const p = pageFeeder.read({ keys, limit })
      pageFeeding = p
      unwinding.add(p)
      p.then(() => unwinding.delete(p), () => unwinding.delete(p))
      try {
        return await p
      } catch (err) {
        throw toRpcError(err, reportInternal)
      } finally {
        if (pageFeeding === p) pageFeeding = null
      }
    },

    // A browser identity is an Ed25519 key already: no delegate to register.
    'page.register': serial(async () => {
      throw new UsageError(PAGE_REGISTER_CORE_ONLY)
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
      // The window ends at `before` (exclusive), by seq: a followed diary's
      // entries skip the blocks not stored, the own diary's are dense (seq
      // = position), so there this is the slice clamped to the length.
      let end = all.length
      if (before !== undefined) {
        while (end > 0 && all[end - 1].seq >= before) end--
      }
      const start = Math.max(0, end - limit)
      const window = all.slice(start, end)
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
      return { key: r.key, entries, invalid, entriesTruncated: start }
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
    // and, on a v2 or v3 read, the own-diary read run on the chain.
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
      // Called by the noticer only on a v2 or v3 read: the own diary is read on
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

    'group.create': groupWrite(member.groupCreate, {
      roots: (params) => [params.community],
      changed: async (c, result, params) => [result.group, params.community]
    }),
    'group.join': groupWrite(member.groupJoin),
    'group.leave': groupWrite(member.groupLeave),
    'group.post': groupWrite(member.groupPost),
    'group.read': serial((params) => withCores((c) => member.groupRead(c, params))),
    'group.seen': serial((params) => withCores((c) => member.groupSeen(c, params))),
    'group.list': serial((params) => withCores((c) => member.groupList(c, params))),
    'group.info': serial((params) => withCores((c) => member.groupInfo(c, params))),
    'group.members': serial((params) => withCores((c) => member.groupMembers(c, params))),
    'group.requests': serial((params) => withCores((c) => member.groupRequests(c, params))),
    'group.admit': groupWrite(member.groupAdmit, GROUP_AND_COMMUNITY),
    'group.ban': groupWrite(member.groupBan, GROUP_AND_COMMUNITY),
    'group.admin': groupWrite(member.groupAdmin),
    'group.hide': groupWrite(member.groupHide, GROUP_AND_COMMUNITY),
    'group.meta': groupWrite(member.groupMeta),
    // Through the caller's CW when it acts for the community, as group.admit.
    'group.invitePolicy': groupWrite(member.groupInvitePolicy, GROUP_AND_COMMUNITY),
    'group.rekey': groupWrite(member.groupRekey),
    'community.create': groupWrite(member.communityCreate, {
      // A resume (kv communityCreate) appends to the roots it already made.
      roots: async () => {
        const plan = await store.readCommunityCreate(storage)
        return plan === null ? [] : [plan.community, plan.group]
      },
      changed: async (c, result) => [result.community, result.group]
    }),
    'community.join': groupWrite(member.communityJoin, {
      roots: (params) => [params.community],
      changed: async (c, result, params) => [params.community, ...(result.group ? [result.group] : [])]
    }),
    'community.leave': groupWrite(member.communityLeave, COMMUNITY_WIDE),
    'community.admit': groupWrite(member.communityAdmit, COMMUNITY_WIDE),
    'community.ban': groupWrite(member.communityBan, COMMUNITY_WIDE),
    'community.admin': groupWrite(member.communitySetAdmin, COMMUNITY_WIDE),
    'community.meta': groupWrite(member.communityMeta, {
      roots: (params) => [params.community],
      changed: async (c, result, params) => [params.community]
    }),
    'community.invitePolicy': groupWrite(member.communityInvitePolicy, {
      roots: (params) => [params.community],
      changed: async (c, result, params) => [params.community]
    }),
    'community.removeGroup': groupWrite(member.communityRemoveGroup, {
      roots: (params) => [params.community],
      changed: async (c, result, params) => [params.community, String(params.group).toLowerCase()]
    }),
    'community.members': serial((params) => withCores((c) => member.communityMembers(c, params))),
    'community.requests': serial((params) => withCores((c) => member.communityRequests(c, params))),
    'community.info': serial((params) => withCores((c) => member.communityInfo(c, params))),
    'community.list': serial(() => withCores((c) => member.communityList(c))),

    'dm.enable': serial(async (_, epoch) => {
      const r = await dmEnable(epoch)
      if (keyPair !== null) dmEngine.topUp(keyPair).catch(noop)
      return r
    }),

    // Reads public records only; works locked.
    'dm.lookup': async ({ member: memberKey }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      try {
        return await dmLookupOf(memberKey)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
    },

    // The recipient's key is looked up first (off the chain), then the send
    // runs on the chain. A send for an identity without a published dm-key
    // runs dm.enable first.
    'dm.send': async ({ to, text, replyTo, media }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      // Self and a blocked peer are refused before any lookup.
      await serial(async () => dmEngine.checkSend(await requireDm(), to))({})
      let recipient
      try {
        recipient = to === ownKey ? { box: null } : await dmLookupOf(to)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serial(async (_, epoch) => {
        const own = await requireDm()
        if ((await store.readDmKey(storage)) === null) await dmEnable(epoch)
        return dmEngine.send(own, keyPair, { to, text, replyTo: replyTo === undefined ? null : replyTo, media: media === undefined ? null : media }, recipient.box)
      })({})
    },

    // Not on the chain: it reads the pool over its own link and writes only
    // kv and the local store (one pull at a time, in the engine).
    'dm.pull': async () => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const own = await serial(() => requireDm())({})
      try {
        dmLastPull = Date.now()
        return await dmEngine.pull(own)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
    },

    'dm.list': serial(async (params) => dmEngine.list(await requireDm(), params)),
    'dm.thread': serial(async (params) => dmEngine.thread(await requireDm(), params)),
    'dm.set': serial(async ({ peer, state }) => dmEngine.set(await requireDm(), keyPair, { peer, state })),
    'dm.seen': serial(async ({ peer }) => dmEngine.seen(await requireDm(), peer)),

    // As report.sign: no diary opened, nothing appended, no network. The
    // `anexo` digest line (dm report v2) is added only when one was given.
    'dm.reportSign': serial(async ({ nonce, target, reason, text, quote, anexo }) => {
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
      const fields = { nonce, member: own, association: cfg.association, target, reason, text: text === undefined ? '' : text, quote }
      if (anexo !== undefined) fields.anexo = anexo
      let signature
      try {
        signature = signDmReport(fields, keyPair)
      } catch (err) {
        if (err instanceof TypeError) throw new UsageError(BAD_REPORT)
        throw err
      }
      return { signature }
    }),

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

  // All keys go together: a locked identity has no media key or group PRF. A
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
    if (groupPrf !== null) groupPrf.fill(0)
    groupPrf = null
    boxKeys.lock()
    dmEngine.lock()
    dmRecheck = false
    dmRecheckTries = 0
    for (const pair of groupPairs) zeroPair(pair)
    groupPairs.clear()
    // The next own-synced after an unlock (or a reload) arms afresh.
    resetUpkeep()
  }

  // A follow change happened: a drain is due, retries start afresh.
  function followChanged () {
    drainRetries = 0
    scheduleDrain()
  }

  // The running sync's follow of a moved page's new key: the signed kv
  // queue only (a follow.add would preempt the run that waits for it), and
  // the drain appends it after. Read at call time: a lock or another
  // identity since the run started counts as locked.
  async function followMovedPage (pageKey, runOwnHex) {
    if (keyPair === null || ownKey === null || (runOwnHex !== undefined && runOwnHex !== ownKey)) {
      throw new Error(store.LOCKED)
    }
    const r = await member.queueFollowChange(storage, ownKey, keyPair, pageKey, true)
    if (r.changed) followChanged()
    return r
  }

  // Unlocks the identity with the pair derived from the passkey, and this
  // device's media key pair when the page derived one (`media`; without it
  // uploads are refused as locked). The optional PRF derives group keys.
  // All are copied synchronously (the caller may zero its buffers right
  // away); any previous pair and PRF are
  // zero-filled. The cached identity is forgotten so a stored diary of
  // another key surfaces on the next operation as USAGE 'passkey não
  // corresponde ao diário guardado'. Nothing is written here; the follow
  // drain is scheduled right after.
  function setKeyPair (pair, { media, prf } = {}) {
    const copy = copyPair(pair)
    let mediaCopy = null
    let prfCopy = null
    try {
      if (prf !== undefined && prf !== null) prfCopy = copyKey(prf, 32)
      if (media !== undefined && media !== null) mediaCopy = copyPair(media)
    } catch (err) {
      zeroPair(copy)
      zeroPair(mediaCopy)
      if (prfCopy !== null) prfCopy.fill(0)
      throw err
    }
    cancelGroups()
    return identityChange(() => serial(async () => {
      // A peek in flight belongs to the previous identity.
      peeker.abort()
      peeking = null
      noticer.abort()
      noticing = null
      zeroKeyPair()
      keyPair = copy
      mediaKeyPair = mediaCopy
      groupPrf = prfCopy
      synced = false
      ownKey = null
      certKnown = false
      certDate = null
      certIssuer = null
      ageVerifiedDate = null
      ageSinceDate = null
      ageSinceUntil = null
      ageSinceIssuer = null
      ageChecked = false
      if (prfCopy !== null) {
        // Without the box pair private groups read as locked; the identity
        // itself is unlocked either way.
        try {
          await boxKeys.unlock(storage, prfCopy)
        } catch (err) {
          if (!(err instanceof UsageError)) reportInternal(err)
        }
        // The dm box pair and the local store key (docs/rpc.md 5.73); the
        // wallet is checked once after an unlock that has a dm-key.
        try {
          await dmEngine.unlock(prfCopy)
          if ((await store.readDmKey(storage)) !== null) {
            dmEngine.topUp(copy).catch(noop)
            dmRefresh({}).catch(noop)
          }
        } catch (err) {
          reportInternal(err)
        }
      }
      followChanged()
      // A live continuous run reported its own length while locked and will
      // not report it again.
      if (run !== null && !run.once && !run.internal && Number.isSafeInteger(run.ownLength)) armUpkeep(run.ownLength)
    })(), { abort: true }).catch((err) => {
      zeroPair(copy)
      zeroPair(mediaCopy)
      if (prfCopy !== null) prfCopy.fill(0)
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
  // `sealed: true` (a private group's photo, docs/rpc.md 5.56) seals the
  // image under a fresh key (group-media sealMedia), stores only the
  // ciphertext and returns the private item, the one place its key leaves
  // the node.
  // A voice note (group chats only) is { bytes, mime: 'audio/mp4', width: 0,
  // height: 0, ms, kind: 'voice', sealed? }: its bytes must pass audioBounds
  // (audio only, no video track) and the result is an audio descriptor, or
  // a private item with plainMime 'audio/mp4' when sealed.
  function mediaUpload ({ bytes, mime, width, height, ms, kind, sealed = false, onProgress } = {}) {
    if (sealed !== true && sealed !== false) throw new TypeError(BAD_MEDIA_ARGS)
    if (kind !== undefined || mime === AUDIO_MIME) return voiceUpload({ bytes, mime, width, height, ms, kind, sealed, onProgress })
    const maxBytes = sealed ? MAX_SEALED_MEDIA_PLAIN_BYTES : MAX_MEDIA_ITEM_BYTES
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw new TypeError(BAD_MEDIA_ARGS)
    if (typeof mime !== 'string' || !MEDIA_MIMES.includes(mime)) throw new TypeError(BAD_MEDIA_ARGS)
    if (!isIntIn(width, 1, MAX_MEDIA_DIMENSION) || !isIntIn(height, 1, MAX_MEDIA_DIMENSION)) throw new TypeError(BAD_MEDIA_ARGS)
    // Nobody but a member can look inside a sealed photo, so the node
    // checks it is the image it claims before sealing (readers check again).
    if (sealed && mediaBounds(bytes, mime) === null) throw new TypeError(BAD_MEDIA_ARGS)
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    const progress = typeof onProgress === 'function' ? (fraction) => { try { onProgress(fraction) } catch {} } : noop
    return serial(async (_, epoch) => {
      await requireUnlocked()
      if (mediaKeyPair === null) throw new UsageError(store.LOCKED)
      // The declaration needs block 0: checked before any byte is stored, so
      // a diary without its certificate gets no orphan media core.
      if (!(await identity()).memberCert) throw new Error(member.GENESIS_REQUIRED)
      if (sealed) return sealedUpload(copy, { mime, width, height, epoch, progress })
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

  // -> the voice note's container duration in ms, or null. The caller's ms
  // must be within AUDIO_MS_TOLERANCE of it; what gets stored is the
  // container's, so a file never claims another length. The bytes are the
  // sender's own recording, still with its udta and meta (stripAudioMetadata
  // removes them next), so only here is metadata tolerated.
  function voiceArgsMs ({ bytes, mime, width, height, ms, kind }) {
    if (!(kind === 'voice' && mime === AUDIO_MIME && width === 0 && height === 0 && isIntIn(ms, 1, MAX_AUDIO_MS) &&
      bytes instanceof Uint8Array && bytes.byteLength >= 1 && bytes.byteLength <= MAX_AUDIO_BYTES)) return null
    const audio = audioBounds(bytes, { metadata: true })
    return audio !== null && Math.abs(ms - audio.ms) <= AUDIO_MS_TOLERANCE ? audio.ms : null
  }

  // mediaUpload's voice note path, on the same chain and gate. What is
  // hashed, sealed and stored is the stripped copy: no recording time, no
  // device tags.
  function voiceUpload ({ bytes, mime, width, height, ms: given, kind, sealed, onProgress }) {
    const ms = voiceArgsMs({ bytes, mime, width, height, ms: given, kind })
    const copy = ms === null ? null : stripAudioMetadata(bytes)
    if (copy === null) throw new TypeError(BAD_MEDIA_ARGS)
    const progress = typeof onProgress === 'function' ? (fraction) => { try { onProgress(fraction) } catch {} } : noop
    return serial(async (_, epoch) => {
      await requireUnlocked()
      if (mediaKeyPair === null) throw new UsageError(store.LOCKED)
      if (!(await identity()).memberCert) throw new Error(member.GENESIS_REQUIRED)
      if (sealed) return sealedUpload(copy, { mime, width: 0, height: 0, ms, epoch, progress })
      const subtle = globalThis.crypto && globalThis.crypto.subtle
      if (!subtle) throw new Error('WebCrypto indisponível')
      const sha256 = b4a.toString(new Uint8Array(await subtle.digest('SHA-256', copy)), 'hex')
      progress(0.25)
      const blocks = []
      for (let at = 0; at < copy.byteLength; at += MEDIA_BLOCK_BYTES) {
        blocks.push(copy.subarray(at, Math.min(copy.byteLength, at + MEDIA_BLOCK_BYTES)))
      }
      const { core, declared } = await withStore((c) => member.mediaPrepare(c))
      if (!declared) {
        await ensureCaughtUp(epoch)
        const { seq } = await withStore((c) => member.declareMediaCore(c, core))
        wrote(seq)
        await pushAfterWrite()
      }
      const descriptor = await withStore((c) => member.mediaCommitAudio(c, { blocks, sha256, ms }))
      progress(0.75)
      progress(1)
      return descriptor
    })({})
  }

  // On mediaUpload's chain: the plaintext copy is wiped once sealed.
  async function sealedUpload (copy, { mime, width, height, ms = 0, epoch, progress }) {
    let sealedItem
    try {
      sealedItem = sealMedia(copy, { plainMime: mime, w: width, h: height, ms })
    } finally {
      copy.fill(0)
    }
    progress(0.25)
    const { core, declared } = await withStore((c) => member.mediaPrepare(c))
    if (!declared) {
      await ensureCaughtUp(epoch)
      const { seq } = await withStore((c) => member.declareMediaCore(c, core))
      wrote(seq)
      await pushAfterWrite()
    }
    const item = await withStore((c) => member.mediaCommitSealed(c, sealedItem))
    progress(0.75)
    progress(1)
    return item
  }

  // A chat photo for dm.send (docs/rpc.md 5.88): validated and copied
  // synchronously (TypeError), then off the chain, as dm.pull (it opens no
  // storage core): sealed and put on the anonymous blob channel by the dm
  // engine -> the media item. The native IPC dm.putMedia reads its cache
  // file and calls this same function. Nothing about the bytes is logged.
  // A voice note is { bytes, mime: 'audio/mp4', width: 0, height: 0, ms,
  // kind: 'voice' }, checked with audioBounds.
  function dmPutMedia ({ bytes, mime, width, height, ms, kind } = {}) {
    const voice = kind !== undefined || mime === AUDIO_MIME
    let copy
    if (voice) {
      ms = voiceArgsMs({ bytes, mime, width, height, ms, kind })
      // The note is sealed without its recording time or device tags.
      copy = ms === null ? null : stripAudioMetadata(bytes)
      if (copy === null) throw new TypeError(BAD_MEDIA_ARGS)
    } else {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_MEDIA_ITEM_BYTES) throw new TypeError(BAD_MEDIA_ARGS)
      if (typeof mime !== 'string' || !MEDIA_MIMES.includes(mime)) throw new TypeError(BAD_MEDIA_ARGS)
      if (!isIntIn(width, 1, MAX_MEDIA_DIMENSION) || !isIntIn(height, 1, MAX_MEDIA_DIMENSION)) throw new TypeError(BAD_MEDIA_ARGS)
      copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
    }
    return (async () => {
      try {
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        const own = await serial(() => requireDm())({})
        const pair = keyPair
        if (pair === null) throw new UsageError(store.LOCKED)
        return await dmEngine.putMedia(own, pair, voice ? { bytes: copy, mime, width: 0, height: 0, ms } : { bytes: copy, mime, width, height })
      } catch (err) {
        copy.fill(0)
        throw toRpcError(err, reportInternal)
      }
    })()
  }

  // The plaintext of item `index` of a kept message -> { bytes, mime }, for
  // the page only (never over RPC: a photo is far above MAX_MESSAGE).
  function dmReadMedia ({ from, id, index } = {}) {
    return (async () => {
      try {
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        const own = await serial(() => requireDm())({})
        return await dmEngine.readMedia(own, { from, id, index })
      } catch (err) {
        if (err instanceof TypeError) throw err
        throw toRpcError(err, reportInternal)
      }
    })()
  }

  // The image of a private group item -> { bytes, mime, w, h }, for the page
  // only. The ciphertext comes from this node's own seeder (its media route
  // on the HTTP origin of seederUrl, never another host) and must open under
  // the item's key; any failure is the same USAGE 'mídia indisponível', so
  // the answer never says why.
  function groupReadMedia ({ diary, item } = {}) {
    if (typeof diary !== 'string' || !HEX64.test(diary) || !validPrivateItem(item)) throw new TypeError(BAD_MEDIA_ARGS)
    const it = {}
    for (const k of PRIVATE_ITEM_KEYS) it[k] = item[k]
    const url = seederMediaUrl(diary.toLowerCase(), it)
    return (async () => {
      try {
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        const pair = await serial(async () => {
          await requireUnlocked()
          return keyPair
        })({})
        if (url === null) throw new UsageError(GROUP_MEDIA_UNAVAILABLE)
        let cipher = null
        try {
          const res = await fetchMedia(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
          cipher = await readExact(res, it.bytes)
        } catch {}
        // A lock (or a lock and a new unlock) while the download ran: the
        // image is never opened for the session that asked.
        if (closed || pair === null || keyPair !== pair) throw new UsageError(store.LOCKED)
        const plain = cipher !== null ? openMedia(cipher, it) : null
        if (plain === null) throw new UsageError(GROUP_MEDIA_UNAVAILABLE)
        // The bytes decide, not the item: a member could seal anything under
        // an image label, and the page decodes what it gets.
        const voice = it.plainMime === AUDIO_MIME
        const audio = voice && plain.byteLength <= MAX_AUDIO_BYTES ? audioBounds(plain) : null
        if (voice ? audio === null : mediaBounds(plain, it.plainMime) === null) {
          plain.fill(0)
          throw new UsageError(GROUP_MEDIA_UNAVAILABLE)
        }
        return voice ? { bytes: plain, mime: it.plainMime, w: 0, h: 0, ms: audio.ms } : { bytes: plain, mime: it.plainMime, w: it.w, h: it.h }
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
    })()
  }

  // The media route of this node's own seeder, or null: plain http only for
  // a loopback seeder (the hosted lab), as the blob channel allows.
  function seederMediaUrl (diary, it) {
    let ws
    try {
      ws = new URL(cfg.seederUrl)
    } catch {
      return null
    }
    const loopback = ws.hostname === '127.0.0.1' || ws.hostname === 'localhost' || ws.hostname === '[::1]'
    if (ws.protocol !== 'wss:' && !(ws.protocol === 'ws:' && loopback)) return null
    const origin = (ws.protocol === 'wss:' ? 'https://' : 'http://') + ws.host
    return origin + '/media/' + diary + '/' + it.core + '/' + it.start + '/' + it.blocks
  }

  // Exactly `size` bytes of a 200 answer, never buffering more: a declared
  // length other than `size` is refused before reading, a stream is cut off
  // past it, and a body without a stream is read only under that length.
  // Anything else (a non-200, a redirect, a short body) is null, and an
  // unread body is cancelled so it does not hold the seeder's slot.
  async function readExact (res, size) {
    const drop = () => { try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(noop) } catch {} }
    if (!res || res.status !== 200 || res.redirected === true) {
      drop()
      return null
    }
    const declared = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null
    if (declared !== null && declared !== String(size)) {
      drop()
      return null
    }
    const stream = res.body
    if (stream && typeof stream.getReader === 'function') {
      const reader = stream.getReader()
      const out = new Uint8Array(size)
      let n = 0
      for (;;) {
        const step = await reader.read()
        if (step.done) break
        const v = step.value
        if (!(v instanceof Uint8Array) || n + v.byteLength > size) {
          try { reader.cancel().catch(noop) } catch {}
          return null
        }
        out.set(v, n)
        n += v.byteLength
      }
      return n === size ? out : null
    }
    if (declared === null) return null
    const body = new Uint8Array(await res.arrayBuffer())
    return body.byteLength === size ? body : null
  }

  // Locks the identity: the pair is zero-filled and the chat media cache
  // deleted (lock and 'Sair' both come here). After close() it already is.
  function clearKeyPair () {
    if (closing !== null) return closing.then(noop)
    cancelGroups()
    return identityChange(() => serial(async () => {
      zeroKeyPair()
      // The identity is locked already; a storage failure while wiping the
      // media cache must not turn the lock into an error (the next unlock
      // under another key wipes it again).
      try {
        await dmEngine.wipeMedia()
      } catch {
        warning('aviso: cache de mídia não apagado')
      }
    })())
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
  // with them), every group core and binding replica (store.deleteGroupData),
  // the pending follow changes and the per-device migration
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
    // Dropped before any delete, so a failed reset never serves a cached
    // certificate date or age attestation for data it deleted.
    certKnown = false
    certDate = null
    certIssuer = null
    ageVerifiedDate = null
    ageSinceDate = null
    ageSinceUntil = null
    ageSinceIssuer = null
    ageChecked = false
    await storage.deleteCore(store.DIARY)
    store.forgetLegacy(storage)
    await store.deleteMediaCores(storage)
    await store.deleteGroupData(storage)
    await store.writeFollowsPending(storage, [])
    await store.clearFollowsMigrated(storage)
    zeroKeyPair()
    // A pull, send or top-up still unwinding must not see its store go.
    await dmEngine.idle()
    await store.deleteDmData(storage)
    await dmEngine.wipeMedia()
    await store.deleteAgeProofs(storage)
    ownKey = null
    diaryInfo = null
    synced = false
    unpushed = true
    localLength = null
    groupUnpushed.clear()
    groupLengths.clear()
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
    pageFeeder.abort()
    pageFeeding = null
    connection++
    emitter = null
    syncIntent = null
    // The next connection's first own-synced arms afresh.
    resetUpkeep()
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
    resetUpkeep()
    peeker.abort()
    peeking = null
    noticer.abort()
    noticing = null
    pageFeeder.abort()
    pageFeeding = null
    closing = (async () => {
      await stopRun('stopped')
      await chain
      // Every read still unwinding, also one a detach (node.close closes the
      // port first) already released the slot of.
      await Promise.allSettled([...unwinding])
      await stopRun('stopped')
      peeker.close()
      noticer.close()
      pageFeeder.close()
      zeroKeyPair()
      boxKeys.close()
      await dmEngine.close()
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
    dmPutMedia,
    dmReadMedia,
    groupReadMedia,
    borrow,
    legacyFollows: () => legacyFollows({}),
    confirmLegacyFollows,
    identityStatus: () => identityStatus({}),
    reset: () => {
      cancelGroups()
      return identityChange(() => resetChain({}), { abort: true })
    },
    // 'open' | 'closed'
    get state () {
      return closed ? 'closed' : 'open'
    }
  }
}

module.exports = { createBrowserSession, toRpcError, checkConfig, redactLogLine }
