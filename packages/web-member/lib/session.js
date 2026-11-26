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
//   none does. The own-diary writes (post.create, post.reply, post.quote,
//   profile.set, like.set, repost.set; #66) touch only the diary and the own
//   media cores, which ./node-store.js opens as sessions of the live
//   instance (openShared): they run beside the run (withOwnWrite), which
//   goes on with the same runId and replicates the new block. Only the
//   other writes, and reads the run cannot serve, preempt: a running sync
//   is aborted and awaited first; a continuous run is restarted afterwards
//   with a new runId (sync.stopped 'preempted', then sync.started).
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
// report.sign, appeal.sign, terms.sign, invite.sign, inviteCard.sign,
// push.sign, age.sign and phone.sign: the domain-separated account-link
// statement
// (@varanda/core lib/account-link.js, prefix 'varanda-account-link-v1'),
// report statement (@varanda/core lib/report.js, prefix
// 'varanda-report-v1'), appeal statement (@varanda/core lib/appeal.js,
// prefix 'varanda-appeal-v1'), terms-acceptance statement (@varanda/core
// lib/terms.js, prefix 'varanda-terms-v1'), signup-invite request
// (@varanda/core lib/invite.js, prefix 'varanda-invite-v1'), signup-invite
// card (@varanda/core lib/invite-card.js, prefix 'varanda-invite-card-v1'),
// push-subscription statement (@varanda/core lib/push-proof.js, prefix
// 'varanda-push-v1'), age-verification request (@varanda/core lib/age.js,
// prefix 'varanda-age-v1') and phone-verification request (@varanda/core
// lib/phone.js, prefix 'varanda-phone-v1'), whose member and association
// the session fills in
// itself, so a caller can never get
// arbitrary bytes, a certificate or a block signed. Each returns the
// signature only.
//
// Single writer (docs/app.md): the same passkey opens the same diary on
// every device, so before every diary write the session makes sure this
// device holds what the seeder holds (ensureCaughtUp: skipped only while a
// live, verified continuous run tracks the own diary; else an internal once
// run must receive the seeder's hello and reach its advertised length).
// post.reply alone waits on a live continuous run that has not reported
// own-synced yet instead of stopping it (writeGateRideMs, within the same
// deadline): same refusal, nothing written, and a refusal leaves the run
// running; a run that ends, or is still behind when writeGateRideMs runs
// out, hands over to the catch-up run with the time left. Then
// after the write it sends the diary to the seeder (an internal once run,
// or the continuous run that restarts). While a continuous run is wanted
// and a run lost its seeder link less than seederDownTtlMs ago (60 s, a
// seeder redeploy) with no own-synced or own-behind since, the write is
// refused at once with the same 'sincronize com o semeador antes de
// publicar' (the fast refusal): the live run is neither stopped nor
// replaced by a gate run against a seeder that is gone, so the reads queued
// behind the write are served on it. A gate run started while a continuous
// run is wanted ends, refused, at its first link loss. Both only refuse
// sooner than the gate run would, and neither uses up the retry bound of
// the follow drain or the device upkeep (they wait for the next own-synced)
// up to a bounded number of such refusals (MAX_DRAIN_REFUSALS,
// MAX_UPKEEP_REFUNDS), past which a refusal counts. The internal runs show as normal
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
// A full core rotates to a new one (storeMedia, rotateMediaCore, #129).
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
// run; a drain the write gate refused because the seeder is down, the fast
// refusal or a gate run that lost its link, tried nothing and does not
// count, up to MAX_DRAIN_REFUSALS such refusals until a drain succeeds or
// the follows change; past that a refusal counts like any failure, so a link
// that keeps reaching own-synced and dropping cannot repeat the drain
// without end). A drain never fails an RPC: an error is the warning 'aviso:
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
// arming by a 'settled' report after the passes ran out; a pass the write
// gate refused because the seeder is down (the fast refusal, or a gate run
// that lost its link) tried nothing: it counts toward neither bound and
// queues no timer, the next own-synced of a user's continuous run queues it
// again (upkeepRefused). At most MAX_UPKEEP_REFUNDS passes per arming are
// given back this way (a pass that enrols or shares resets the count, as it
// resets the passes); past that a refused pass counts toward both bounds
// like a failure, still without a timer, so a link that keeps reaching
// own-synced and dropping cannot repeat the pass without end; a failed pass or
// a failed root queues another within the bound; a 'group-writer' (a writer
// core stored for the first time, either in a PRIVATE group this device
// writes in, or bound by the own diary, i.e. another device's writer: the
// event says so; once per key and at most MAX_UPKEEP_WRITERS keys per
// session) arms afresh, so the distributor plans after the new device's
// writer arrived and a new device enrols once the account's writer it waited
// for is held. Any other writer (a public group or a foreign diary without an
// own writer there) has no keys to hand over and changes no plan, so it arms
// nothing. Where the event is not armed for (cap, locked, once run) a
// private group with an own writer still leaves upkeepFull set, and
// `private` is false while the root's visibility is unknown, which the
// 10-minute full-plan age (UPKEEP_FULL_MAX_AGE_MS) covers.
// A boxless writer of a root not held yet (a join before the root arrived;
// the root's visibility is unknown, so a public one too) stays a transient
// 'unheld' skip, so the arming lives until the root's 'groups-changed' plans
// the rebox; while armed, a
// 'groups-changed' (the root or writer a skipped root waited for) queues
// another pass. A timer (upkeepDelayMs) coalesces a burst into one pass, at
// most MAX_UPKEEP_PASSES per arming (refused passes given back aside, up to
// MAX_UPKEEP_REFUNDS), so a plan the run's cores cannot serve
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
// both shipped entries, the browser page and the app worklet, leave at 0):
// a seeder link that has nothing left to do is not held open. The sync reports 'settled { settled, mediaPending }'
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
// leaseUntil before the handler's finally restarts the run, the fast
// refusal of the write gate included), a diary.peek
// (awaitPeek clears it and queues its no-op; while the seeder is known
// down and no peek is published it answers SEEDER_UNAVAILABLE at once
// instead of waiting out the peek deadline), and sync.start, which starts
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
// dm.noticeKey hands the engine the account service's wake key, in memory,
// for the push notice after a send (./dm.js).
const { fitAlt } = require('@varanda/core/lib/post-alt')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { RpcError, PROTOCOL, MAX_MESSAGE, utf8ByteLength, isSafeMessage, capList, capSyncResult, clipText, MAX_LINE, MAX_ID, PEEK_TIMEOUT_MS, PEEK_SEQS_MAX, TESTIMONIAL_PENDING_MAX, TESTIMONIAL_KEPT_MAX, TESTIMONIAL_DECLINED_MAX, FEED_INCOMPLETE_MAX, mediaBounds, audioBounds, stripAudioMetadata, AUDIO_MS_TOLERANCE, videoBounds, stripVideoMetadata, VIDEO_MS_TOLERANCE, garden } = require('@varanda/rpc')
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
  MAX_AUDIO_BYTES,
  VIDEO_MIME,
  MAX_VIDEO_MS,
  MAX_MOMENT_VIDEO_MS,
  MAX_MOMENT_VIDEO_BYTES
} = require('@varanda/core/lib/records')
const { formatEvent, key8 } = require('@varanda/core/lib/sync-format')
const { safe } = require('@varanda/core/lib/safe')
const { UsageError } = require('@varanda/core/lib/errors')
const { visitDay } = require('@varanda/core/lib/visits')

const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signReport, signDmReport, signListingReport } = require('@varanda/core/lib/report')
const { signAppeal } = require('@varanda/core/lib/appeal')
const { signTerms } = require('@varanda/core/lib/terms')
const { signRecovery, blobHashOf } = require('@varanda/core/lib/recovery-proof')
const { signInvite } = require('@varanda/core/lib/invite')
const { signInviteCard, isInviteCardExpired } = require('@varanda/core/lib/invite-card')
const { strictVerifyInviteCard } = require('./invite-card')
const { signAge } = require('@varanda/core/lib/age')
const { signPhone } = require('@varanda/core/lib/phone')
const { signPush, endpointHash } = require('@varanda/core/lib/push-proof')
const { pushDevicePayload, tokenHash } = require('@varanda/core/lib/push-device-proof')
const { signPeerProof } = require('@varanda/core/lib/peer-proof')
const { verifyUsernameRecord } = require('@varanda/core/lib/cert')
const { verifyAgeVerified, verifyAgeSince } = require('@varanda/core/lib/age-proof')
const { verifyPhoneVerified, verifyPhoneSince } = require('@varanda/core/lib/phone-proof')
const { latestUsernameRecord } = require('@varanda/core/lib/username')
const { MAX_INVENTORY } = require('@varanda/core/lib/admission')
const { createRekeyGate, REKEY_CHECK_MS } = require('@varanda/core/lib/group-rekey')
const { exportHead, exportFollowsPage, exportDiaryPage } = require('@varanda/core/lib/export')
const { editsOf } = require('@varanda/core/lib/post-edit')
const member = require('./member-ops')
const { runSync, SEEDER_UNAVAILABLE, DIARY_UNAVAILABLE } = require('./sync')
const { verifyShow } = require('@varanda/core/lib/testimonials')
const { applyDecision, readRefs, splitRows } = require('@varanda/core/lib/testimonial-decision')
const { markMomentSeen, momentSeenRefs } = require('@varanda/core/lib/moment-seen')
const { createPeeker } = require('./peek')
const { peekGroupRoot } = require('./root-peek')
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
const { groupKeyPairFromPrf, mediaKeyPairFromPrf, outboxKeyFromPrf } = require('./passkey')
const { sealOutbox, openOutbox, WRONG_AUTHOR: OUTBOX_WRONG_AUTHOR } = require('./outbox-seal')
const { createGroupKeys } = require('./group-keys')
const { checkSeederUrl } = require('./seeder-url')
const { pickCount } = require('@varanda/core/lib/polls')
const { createDmEngine, MOMENT_PHOTO_GONE, BLOCKED: DM_BLOCKED, NO_PAGE_KEY, KEY_MISMATCH: DM_KEY_MISMATCH, USE_PAGE_DRAFT: DM_USE_PAGE_DRAFT } = require('./dm')
const { applyBlock, blockedKeys } = require('@varanda/core/lib/member-block')
const { applyMute, mutedKeys } = require('@varanda/core/lib/member-mute')
const { createSeenSync, groupApplier } = require('./seen-sync')
const { createPageGroupKeys, peekPageRoots } = require('./page-groups')

const HEX64 = /^[0-9a-fA-F]{64}$/
const TESTIMONIAL_SELF = 'não pode escrever um depoimento para si'
// The pointer answer is keys and seqs only: far below this.
const TESTIMONIAL_INDEX_MAX_CHARS = 256 * 1024
// Recados (docs/rpc.md): the wall check's refusals, and caps on the two
// seeder answers it reads (50 rows and 1000 hides fit in about 25 KB).
const SCRAP_SELF = 'não pode deixar recado para si'
const SCRAP_PAGE = 'páginas não recebem recados'
// Fas e Melhores amigos (docs/rpc.md): a page is neither fanned nor listed.
const FAN_SELF = 'não pode ser fã de si'
const TOP_SELF = 'não pode listar a si entre os melhores amigos'
const FAN_PAGE = 'páginas não têm fãs'
const TOP_PAGE = 'páginas não entram nos melhores amigos'
// Foruns e enquetes (docs/rpc.md): a vote names a live poll post and one of
// its options; topics and group polls live in public groups only.
const CHOICE_NOT_POLL = 'a publicação não é uma enquete'
const CHOICE_PICK_INVALID = 'opção inválida'
const FORUM_PUBLIC = 'fóruns e enquetes só em grupo público'
const SCRAP_FOLLOWING = 'esta pessoa só recebe recados de quem ela segue'
const SCRAP_NOBODY = 'esta pessoa não está recebendo recados'
const SCRAP_INDEX_MAX_CHARS = 64 * 1024
const FOLLOW_INDEX_MAX_CHARS = 1024
const VISIT_INDEX_MAX_CHARS = 16 * 1024
// Varandinha (docs/rpc.md 5.160): the help target's refusals, read off the
// chain from the owner's blocks. The index cap holds the seeder route's
// largest body (apps/cli/lib/seed-ws.js INDEX_MAX_BODY).
const GARDEN_PAGE = 'páginas não têm Varandinha'
const GARDEN_NOT_IN = 'esta pessoa não está na Varandinha'
const GARDEN_NO_PLANT = 'este vaso não tem planta para regar'
const GARDEN_INDEX_MAX_CHARS = 64 * 1024
// visits.set { on: true } without private messages enabled (no dm key): a
// switch on could neither queue a ping nor be pinged. Same text as the
// app's DMS_OFF_NOTICE (apps/app/src/visits.js).
const VISITS_DMS_OFF = 'Ative as mensagens privadas para registrar visitas.'

// A seeder index body read with a cap: a streamed body is cut off (and the
// stream cancelled) past `max` bytes, so a seeder cannot make the node buffer
// an endless answer; a response without a stream is read whole and checked,
// as before. Throws SEEDER_UNAVAILABLE.
async function boundedIndexText (res, max) {
  const stream = res.body
  if (!stream || typeof stream.getReader !== 'function') {
    const text = await res.text()
    if (typeof text !== 'string' || text.length > max) throw new Error(SEEDER_UNAVAILABLE)
    return text
  }
  const reader = stream.getReader()
  const chunks = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!(value instanceof Uint8Array) || n + value.byteLength > max) {
      try { reader.cancel().catch(() => {}) } catch {}
      throw new Error(SEEDER_UNAVAILABLE)
    }
    chunks.push(value)
    n += value.byteLength
  }
  return b4a.toString(b4a.concat(chunks), 'utf8')
}
const LOCKED_MESSAGE = 'diretório de dados em uso'
const CLOSED_MESSAGE = 'sessão encerrada'
const INTERNAL_MESSAGE = 'erro interno'
const NOT_SYNCED_MESSAGE = 'sincronize com o semeador antes de publicar'
const BAD_USERNAME_RECORD = 'registro de nome inválido'
const BAD_AGE_PROOF = 'comprovante de idade inválido'
const BAD_PHONE_PROOF = 'comprovante de celular inválido'
const OLD_USERNAME_RECORD = 'registro de nome antigo'
const SELF_REPORT = 'não é possível denunciar a própria chave'
const BAD_REPORT = 'denúncia inválida'
const BAD_APPEAL = 'recurso inválido'
const BAD_PUSH = 'inscrição de notificação inválida'
const BAD_INVITE_CARD = 'cartão de convite inválido'
const INVITE_CARD_EXPIRES = 'validade do cartão de convite fora do prazo'
// inviteCard.sign: expires may lag the clock by a day and lead it by eight
// (a signup invite lasts a week, plus a day of clock skew).
const INVITE_CARD_PAST = 24 * 60 * 60
const INVITE_CARD_AHEAD = 8 * 24 * 60 * 60
const GATE_LINE = 'sincronizando antes de publicar'
const PUSH_LINE = 'enviando ao semeador'
const DEVICE_LINE = 'atualizando os grupos antes de desconectar'
const RECONNECT_PASSKEY = 'para conectar de novo, entre com a passkey'
const LOCAL_LINE = 'diário próprio escrito neste aparelho'
const DRAIN_WARNING = 'aviso: seguidos ainda não enviados'
const UPKEEP_WARNING = 'aviso: participação automática neste aparelho não concluída'
const BAD_MEDIA_ARGS = 'mídia inválida'
// dm.send with a moment that is not showing here (docs/rpc.md 5.75).
const MOMENT_NOT_FOUND = 'momento não encontrado'
const GROUP_MEDIA_UNAVAILABLE = 'mídia indisponível'
const NO_SEEDER = 'sem conexão com o semeador'
const PEEK_BUSY = 'espiadinha já em andamento'
const SEEN_CHANGED_MS = 5000
const NOTICES_BUSY = 'avisos já em andamento'
const DIARY_PEEK_BUSY = 'ocupado'
const DIARY_HIDDEN = 'diário indisponível'
const NO_OFFER = 'oferta-ausente'
// listing.consent pages the rater's thread at most this far back.
const OFFER_PAGES = 20
const OFFER_PAGE = 100
// listing.ratings: one deadline for all its sequential peeks, under the
// client's request timeout.
const RATINGS_TIMEOUT_MS = 20000
// The race result that says a rater peek ran past the shared deadline.
const RATINGS_LATE = Symbol('late')
// testimonial.pending: one deadline from its arrival, the index fetch
// (itself at most PEEK_TIMEOUT_MS) included, for all its sequential peeks.
// With the grace below it leaves the opening step and the reply 9 s of the
// client's 30 s request timeout (DEFAULT_TIMEOUT_MS of @varanda/rpc, which
// the app's clients use).
const TESTIMONIAL_PENDING_TIMEOUT_MS = 20000
// A peek that waits out its own deadline (a cleared block never arrives on
// a temporary core, and is then `missing`) answers just after it: it is
// cut only this long past its deadline, so it is not lost.
const TESTIMONIAL_LATE_GRACE_MS = 1000
// The race result that says a testimonial peek ran past that deadline.
const TESTIMONIAL_LATE = Symbol('late')
// A decided-only block that full-budget peeks reported missing, or whose
// full-budget peek failed, this many calls in a row (a revoked block never
// arrives, an unserved writer never answers, and both cost the whole peek
// every time) is not read again for TESTIMONIAL_DEAD_REF_TTL_MS. One strike
// alone only moves it to the end, so a single slow read hides nothing; the
// TTL is short so two bad reads of a live block hide it only briefly.
const TESTIMONIAL_DEAD_REF_STRIKES = 2
const TESTIMONIAL_DEAD_REF_TTL_MS = 10 * 60 * 1000
// The memo of those blocks is bounded; the oldest strike goes first.
const TESTIMONIAL_DEAD_REF_MAX = 256
const BAD_PAGE = 'operação de página inválida'
const PAGE_FEED_BUSY = 'feed de página já em andamento'
const PAGE_REGISTER_CORE_ONLY = 'registro de página disponível só no nó core'
const ACTOR_BOX_CORE_ONLY = 'caixa de delegado disponível só no nó core'
const NO_LOCAL_DATA = 'sem dados locais para este diário'
// page.read (docs/rpc.md 5.85): the bounded read of a page diary this node
// does not hold peeks blocks 1..3 and this many windows of PEEK_WINDOW seqs,
// newest first (288 >= PAGE_ROSTER_REFRESH_BLOCKS, so the roster the
// service refreshes every 256 blocks is always inside). The result's lists
// are capped as PAGE_READ_FOLLOWS_MAX / PAGE_READ_LINKS_MAX of @varanda/rpc.
const PAGE_READ_WINDOWS = 8
// refreshRemotePageRoots' overall deadline.
const PAGE_ROOTS_PEEK_MS = 5000
const PAGE_READ_HEAD = 3
const PAGE_READ_FOLLOWS_MAX = 64
const PAGE_READ_LINKS_MAX = 16 + 1
// docs/protocol.md "Mudar de chave": a chain of moves stops here (as
// MAX_PAGE_MOVES in ./sync.js).
const PAGE_MOVE_HOPS_MAX = 4
// A window is first asked for under this share of the peek deadline: a
// block the seeder cleared (its tombstone in the same window) never
// arrives, so only what the answer's tombstones leave missing is asked for
// again under the whole deadline.
const PAGE_READ_PROBE_SHARE = 8
// Direct messages (see the header): the sync loop pulls at most this often
// and checks the wallet on this tick; a dm-key lookup by peek reads at most
// this many windows of PEEK_WINDOW seqs, newest first.
const DM_PULL_EVERY_MS = 120000
// The published dm-key checks after a pull (checkPageKeys), all pages at once.
const PAGE_KEY_CHECK_MS = 8000
const DM_TICK_MS = 60000
// How long the automatic history copy reuses a device view while the own
// diary keeps its length (copyKick).
const COPY_VIEW_MS = 600000
const DM_LOOKUP_WINDOWS = 8
// An internal wire window of the node's own peeks, not an rpc page cap.
const PEEK_WINDOW = 36
// diary.peek requests in flight at once.
const MAX_DIARY_PEEKS = 4
// How often refusePages looks for a free diary.peek slot.
const PEEK_SLOT_POLL_MS = 20
// One deadline for the internal catch-up and push runs.
const WRITE_GATE_TIMEOUT_MS = 15000
// The longest post.reply waits on a live continuous run for own-synced
// before it stops that run for a catch-up run (within the same deadline): a
// link can stay stuck before own-synced, and a fresh catch-up run recovers.
const RIDE_MS = 5000
// How long a dropped seeder link refuses gated writes at once while a
// continuous run is wanted (the write gate's fast refusal, see the header).
const SEEDER_DOWN_TTL_MS = 60000
// The longest a read waits for a starting run to publish its cores
// (withCores) before it preempts the run instead.
const READER_WAIT_MS = 3000
const NOT_READY = Symbol('not ready')
// Marks the write gate's refusal because the seeder is down: the fast
// refusal, or a gate run that lost its link. The follow drain and the device
// upkeep do not count it toward their retry bounds until MAX_DRAIN_REFUSALS
// or MAX_UPKEEP_REFUNDS such refusals; past that it counts like any failure.
const SEEDER_DOWN = Symbol('seeder down')
// Failed drains retried from own-synced without a new follow change.
const MAX_DRAIN_RETRIES = 3
// Drains refused because the seeder is down that do not count toward
// MAX_DRAIN_RETRIES, until a drain succeeds or the follows change. A seeder
// redeploy costs one or two refusals (the fast refusal, a gate run that
// lost its link); twice the retries leave room for a few redeploys or a
// short crash loop, while a link that keeps flapping stops after this plus
// MAX_DRAIN_RETRIES drains.
const MAX_DRAIN_REFUSALS = 2 * MAX_DRAIN_RETRIES
// The device upkeep (see the header): passes per arming, and the delay that
// coalesces a burst of triggers into one pass.
const MAX_UPKEEP_PASSES = 3
const UPKEEP_DELAY_MS = 1500
// Per arming, whatever progress or a 'settled' report granted since.
const MAX_UPKEEP_TOTAL = 3 * MAX_UPKEEP_PASSES
// Passes refused because the seeder is down that are given back (counted
// toward neither bound) per arming, or since a pass that enrolled or shared.
// Sized as MAX_DRAIN_REFUSALS: a redeploy costs one or two refused passes,
// and a link that keeps flapping stops after this plus the pass bounds.
const MAX_UPKEEP_REFUNDS = 2 * MAX_UPKEEP_PASSES
// Writer keys whose 'group-writer' armed the upkeep, per session: only a
// private group the device writes in arms it (sync.js tells which).
const MAX_UPKEEP_WRITERS = 64
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
  BAD_APPEAL,
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
  DIARY_UNAVAILABLE,
  MOMENT_PHOTO_GONE
])

// Opt-in thumbnails (docs/rpc.md 5.13, 5.22, 5.27): `result[field]` rows carry
// `thumbs` (a list, or null/absent). Lists are kept newest first (by the
// row's `at`, later rows first on a tie) only while the whole serialized
// response, envelope at MAX_ID included, stays within MAX_MESSAGE; the first
// list that does not fit ends it, and every other list is dropped from its
// row. Rows, their order and the cursors never change. -> the new rows.
function fitThumbs (result, field, atOf) {
  const rows = result[field]
  const bare = rows.map((row) => {
    const { thumbs, ...rest } = row
    return rest
  })
  const envelope = (r) => utf8ByteLength(JSON.stringify({ v: PROTOCOL, id: MAX_ID, ok: true, result: r }))
  let used = envelope({ ...result, [field]: bare })
  const order = rows.map((row, i) => i).filter((i) => Array.isArray(rows[i].thumbs))
    .sort((a, b) => {
      const ta = Date.parse(atOf(rows[a]))
      const tb = Date.parse(atOf(rows[b]))
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta) || b - a
    })
  const out = bare.slice()
  for (const i of order) {
    const cost = utf8ByteLength(',"thumbs":' + JSON.stringify(rows[i].thumbs))
    if (used + cost > MAX_MESSAGE) break
    used += cost
    out[i] = { ...bare[i], thumbs: rows[i].thumbs }
  }
  return out
}

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

// Plain kv values (string lists, group marks) compared by content.
function sameJson (a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
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
      exactOp(op, hasOwn(op, 'share') ? ['member', 'gen', 'rosterSignature', 'roster', 'share'] : ['member', 'gen', 'rosterSignature', 'roster'])
      const r = exactOp(op.roster, ['owner', 'admins', 'prev', 'at', 'nonce'])
      if (typeof op.rosterSignature !== 'string') throw new TypeError('invalid page op')
      if (hasOwn(op, 'share')) {
        const s = exactOp(op.share, ['sealed', 'sig'])
        if (typeof s.sealed !== 'string' || typeof s.sig !== 'string' || !/^[0-9a-f]{128}$/.test(s.sig)) throw new TypeError('invalid page op')
      }
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

// Whether err is the write gate's refusal because the seeder is down.
function seederDownError (err) {
  return err !== null && typeof err === 'object' && err[SEEDER_DOWN] === true
}

// ---- the session ----

// syncOptions: test-only overrides passed to runSync (limits and timings).
// limits: test-only overrides of the own diary limits.
// writeGate: the catch-up run before every diary write and the push run
// after it (test fixtures without a seeder pass false; the browser entry
// never passes it). writeGateTimeoutMs: their deadline (tests).
// writeGateRideMs: how long post.reply waits on a live continuous run
// before the catch-up run (tests; RIDE_MS).
// seederDownTtlMs: how long a dropped link refuses gated writes at once
// (the fast refusal, header); 0 = off, every write waits for its gate run.
// readerWaitMs: how long a read waits for a starting run's cores (tests).
// peekTimeoutMs: the diary.peek deadline (tests; the contract's otherwise).
// testimonialTimeoutMs: the testimonial.pending deadline (tests).
// dmKeyPeek: tests only, (memberKey) -> { box, gen } in place of the bounded
// diary.peek scan for a dm-key (the published page key check reads it).
// rootPeek: tests only, (groupKey) -> raw block 0 in place of the seeder
// read of a pending group.join's root (./root-peek.js).
// leaseHoldMs: the lease (header); 0 = off. leaseGapMs, leaseMediaMaxMs:
// its gap and its media wait. noClear: keep the bytes of deleted blocks
// (the browser's VARANDA_NO_CLEAR kill switch; tombstones still hide them).
// upkeepDelayMs: the device upkeep's coalescing delay (tests).
// upkeepFullMaxAgeMs: the age after which it plans in full again (tests).
// rekeyClock, rekeyRandom: the clock (ms) and random source of the
// periodic rotation of private groups' keys (tests).
// hkdf: the HKDF of passkey.js for every key derived from the PRF of
// setKeyPair (group box, group writer and direct message keys); absent, it
// is WebCrypto's. The Bare worklet passes its own: its WebCrypto has none.
// dmUnlockHook: tests only, (unlock, prf) -> promise around the direct
// message store unlock that setKeyPair starts off the chain; it must call
// unlock() at most once. Absent, the unlock runs as is.
// memoCheck: tests only, every group and community fold the memo returns is
// recomputed and compared (member-ops.js memoFold). groupMemo: tests only,
// the Map that memo lives in.
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
  writeGateRideMs = RIDE_MS,
  seederDownTtlMs = SEEDER_DOWN_TTL_MS,
  readerWaitMs = READER_WAIT_MS,
  peekTimeoutMs = PEEK_TIMEOUT_MS,
  testimonialTimeoutMs = TESTIMONIAL_PENDING_TIMEOUT_MS,
  dmKeyPeek = null,
  rootPeek = null,
  ratingsTimeoutMs = RATINGS_TIMEOUT_MS,
  leaseHoldMs = 0,
  leaseGapMs = LEASE_GAP_MS,
  leaseMediaMaxMs = LEASE_MEDIA_MAX_MS,
  noClear = false,
  upkeepDelayMs = UPKEEP_DELAY_MS,
  upkeepFullMaxAgeMs = UPKEEP_FULL_MAX_AGE_MS,
  rekeyClock = Date.now,
  rekeyRandom = Math.random,
  fetchMedia = (...args) => globalThis.fetch(...args),
  hkdf,
  dmUnlockHook = null,
  memoCheck = false,
  groupMemo: memoMap = null
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
      memo: groupMemo,
      memoCheck: memoCheck === true,
      limits,
      noClear: noClear === true,
      // The pending group.join with a hint checks it against the root's
      // block 0 read here (./root-peek.js), on a link of its own: the run is
      // stopped while a write holds the store.
      peekGroupRoot: (key) => {
        if (closed) return Promise.reject(new Error('sessão encerrada'))
        if (rootPeek !== null) return rootPeek(key)
        return peekGroupRoot({ seederUrl: cfg.seederUrl, createSocket, association: cfg.association, key, timeoutMs: peekTimeoutMs, log: (text) => warning(safe(text)) })
      }
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
  let syncStops = 0 // sync.stop calls: a one-shot start waiting for the unlock is cancelled by one
  // When a run last lost its seeder link (ms), null once a run reported the
  // own diary again or the user started or stopped a sync (the fast refusal,
  // header). downTtl: seederDownTtlMs, 0 when off or invalid.
  let seederDownAt = null
  const downTtl = Number.isFinite(seederDownTtlMs) && seederDownTtlMs > 0 ? seederDownTtlMs : 0
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
  // The stored phone attestations (kv phoneVerified / phoneSince), re-verified
  // and cached like the age ones against the same revoked issuers. Unlike
  // age-since, phone-since never vouches for a certificate, so no issuer is
  // kept.
  let phoneVerifiedDate = null
  let phoneSinceDate = null
  let phoneChecked = false
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
  // Whether the host unlocked keyPair from a passkey ceremony in this open
  // (setKeyPair's `fresh`), not from a kept session: device.reconnect needs
  // it.
  let keyFresh = false
  // The last `off` sent in devices.changed for the current key pair, and
  // the own length last checked for it.
  let deviceOffSent = false
  // The key pair of the unlock a run (once or continuous) caught the own
  // diary up for, or null: until then the history copy is not told this
  // device is on (feedDevice). The continuous run clears it when its link
  // drops or the own diary falls behind (holdCopyImports).
  let ownCaught = null
  let deviceCheckLength = null
  let mediaKeyPair = null
  let groupPrf = null
  // The outbox key (passkey.js outboxKeyFromPrf), derived from groupPrf on
  // the first outbox.seal / outbox.open and zero-filled with it; outboxGen
  // moves on every zeroing, so a derivation that straddles one is dropped.
  let outboxKey = null
  let outboxGen = 0
  // The direct message store unlock setKeyPair starts off the chain (it reads
  // and opens every local row): settles once that unlock is done or
  // superseded, never rejects, and is null when none is pending. Every
  // identity change bumps dmUnlockGen, which makes a pending one a no-op.
  let dmUnlocking = null
  let dmUnlockGen = 0
  // The same wait up to the moment that unlock installed its keys and read
  // the list summary (null when none is pending): dm.list may answer a
  // first page from the summary while the rows still load.
  let dmKeying = null
  // The dm engine calls withDmReady started OFF the chain and not settled
  // yet (dm.pull, dm.pageSecrets, dmReadMedia, the uploads, the visit and
  // testimonial reads) -> the identityTarget each started under. A new PRF
  // read of the same key waits for that identity's calls before it locks
  // the engine, so they end as chain steps would; a lock, a reset, another
  // key or close() never waits, and a call still running meets the lock.
  const dmCalls = new Map()
  // The waits for dmCalls (dmCallsDone), woken whenever identityTarget
  // moves or the session closes (wakeDmWaits).
  const dmWaitWakes = new Set()
  // The private answer of a dm.list chain step that must wait off the chain.
  const DM_LIST_MISS = Symbol('dm-list-miss')
  // The identity requests are issued for, moved synchronously when an
  // identity change is CALLED (its chain entry may run later): another key
  // (setKeyPair; the same key with a new PRF keeps it), a lock or a reset
  // (no key). A DM request reads identityTarget on arrival, before any wait,
  // and requires it unchanged after every wait and before every later step
  // (checkIdentity): queued then, it runs ahead of any later change.
  let identityTarget = 0
  let targetKey = null

  function retarget (hex) {
    if (hex === null || hex !== targetKey) {
      identityTarget++
      wakeDmWaits()
    }
    targetKey = hex
  }

  function wakeDmWaits () {
    for (const wake of dmWaitWakes) wake()
  }
  // The private-group box key pair and the epoch keys opened this session,
  // in memory only (./group-keys.js): locked with every identity change,
  // closed with the session.
  const boxKeys = createGroupKeys({ hkdf })
  // The group and community folds of member-ops.js, in memory only: a
  // private fold holds opened posts, so it goes with every key change.
  const groupMemo = memoMap instanceof Map ? memoMap : new Map()
  let groupEpoch = 0
  let groupWriting = false
  const groupPairs = new Set()
  const groupUnpushed = new Map()
  // The length of each own group core when last read here (after a write or
  // before a write gate): a 'group-synced' at a shorter length is stale and
  // never lets a write append past what the seeder was compared with.
  const groupLengths = new Map()
  // The follow drain: at most one operation queued; drainWanted after a
  // failure (retried from own-synced, drainRetries times in a row);
  // drainRefusals: the seeder-down refusals not counted in drainRetries.
  let drainQueued = false
  let drainWanted = false
  let drainRetries = 0
  let drainRefusals = 0
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
  // A pass the write gate refused because the seeder is down (seederDownError):
  // the next own-synced of a user's continuous run queues it again. Such a
  // pass is not counted, so a seeder redeploy does not use up the arming;
  // upkeepRefunds: the passes given back so (at most MAX_UPKEEP_REFUNDS).
  let upkeepRefused = false
  let upkeepRefunds = 0
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
  // The periodic rotation (periodicRekeyStep): the per-group check limit,
  // a limit on the groups-changed that start a rotation-only pass, the
  // timer that starts one when a group becomes due, and that pass's own
  // coalescing timer.
  const rekeyGate = createRekeyGate({ now: rekeyClock, random: rekeyRandom })
  const rekeyTriggers = createRekeyGate({ now: rekeyClock })
  let rekeyTimer = null
  let rekeyTimerAt = null
  let rekeyPassTimer = null
  let rekeyQueued = false
  const rekeyDeferred = new Set()
  let rekeyDeferTimer = null
  let rekeyDeferAt = Infinity
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
  // Own-diary writes running beside a run (withOwnWrite), and the last own
  // length a run reported: Hypercore may send the new block to the seeder
  // before append() resolves, so its echo can arrive before wrote().
  let ownAppends = 0
  let ownReported = null
  let localEchoed = null // the greatest local length already announced with LOCAL_LINE
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
    limits: syncOptions.dm,
    hkdf,
    // A queued visit ping's timer: the own switch is read before any send.
    visitsDue: () => {
      if (ownKey !== null) visitPull(ownKey, identityTarget, { pull: false })
    }
  })
  // The epoch keys of the pages' private groups (./page-groups.js), apart
  // from boxKeys: read and sealed with the page's group box only.
  const pageGroupKeys = createPageGroupKeys({ groupBoxOf: (page) => dmEngine.groupBoxOf(page) })
  // page -> the roots its last remote scan found (refreshRemotePageRoots).
  const remotePageRoots = new Map()
  // The seen-sync engine (docs/rpc.md 5.95, 5.96). Remote group marks go
  // through the group.seen path on the cores a run lends.
  const seenSync = createSeenSync({
    storage,
    association: cfg.association,
    log: (text) => warning(safe(text)),
    currentOwn: () => (keyPair === null ? null : b4a.toString(keyPair.publicKey, 'hex')),
    applyGroups: groupApplier({ storage, withCores: (fn) => withCores(fn) }),
    // Each conversation's read position stays in the synced window, so
    // another device opens it where reading stopped (dm.thread firstUnread).
    heads: (own) => dmEngine.seenHeads(own)
  })
  // 'seen.changed' at most once per SEEN_CHANGED_MS: a burst of marks (a
  // scroll through a group) asks the app for one sync, not one per mark.
  let seenChangedAt = 0
  let seenChangedTimer = null
  function seenChanged () {
    if (closed || seenChangedTimer !== null) return
    const wait = seenChangedAt + SEEN_CHANGED_MS - Date.now()
    if (wait <= 0) {
      seenChangedAt = Date.now()
      send('seen.changed', {})
      return
    }
    seenChangedTimer = setTimeout(() => {
      seenChangedTimer = null
      if (closed) return
      seenChangedAt = Date.now()
      send('seen.changed', {})
    }, wait)
  }

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
      // Paced from the last pull that started (the engine's clock): a manual
      // pull that was refused or joined one in flight delays nothing.
      if (Date.now() - dmEngine.lastPullAt >= DM_PULL_EVERY_MS && !dmEngine.pulling) {
        await dmEngine.pull(own).catch(noop)
        checkPageKeys().catch(noop)
        visitPull(own, identityTarget)
      }
      copyKick().catch(noop)
      if (keyPair !== null) await dmEngine.topUp(keyPair)
    } catch {}
  }

  // After a pull, never inside it, and never awaited by it: each held
  // page's newest published dm-key against the held gen and box, all pages
  // at once under one PAGE_KEY_CHECK_MS deadline (a page not answered by
  // then keeps its flag as it was). While either differs the page is
  // flagged and 'dm.pageKeyMismatch' goes out on every pull (an honest
  // service publishes the held gen with the held box, so an old box under a
  // new gen is flagged too). The seeder is always asked, since a stored
  // replica may not be syncing, and the higher gen of the two answers wins.
  // A seeder that finds no dm-key at all is a mismatch too. When the seeder
  // cannot be asked, only a stored replica at or past the held gen that
  // disagrees flags; anything else leaves the flag as it was. Harmless after
  // a lock (the engine holds no page then). Never throws.
  async function checkPageKeys () {
    const held = dmEngine.heldPageBoxes()
    if (held.length === 0) return
    let over = false
    let timer = null
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        over = true
        resolve()
      }, PAGE_KEY_CHECK_MS)
    })
    try {
      await Promise.race([Promise.allSettled(held.map((h) => checkPageKey(h, () => over))), deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  async function checkPageKey ({ page, box, gen }, late) {
    try {
      if (closed) return
      const local = await serial(() => withCores((c) => member.dmLookup(c, page)))({})
      let published
      try {
        published = await peekDmKey(page)
      } catch {
        if (local === null || local.gen === null || local.gen < gen || (local.box === box && local.gen === gen)) return
        published = local
      }
      if (closed || late()) return
      // The seeder answering with no dm-key at all is a mismatch, whatever
      // a stored replica says (an honest page refreshes its key in reach).
      if (published.gen !== null && local !== null && local.gen !== null && local.gen > published.gen) published = local
      const differs = published.box !== box || published.gen !== gen
      if (dmEngine.setPageMismatch(page, box, differs, gen) && differs) send('dm.pageKeyMismatch', { page })
    } catch {}
  }

  // ---- sync runs ----

  // internal: a gate or push run of the session itself (its line names it;
  // it never changes syncIntent). onOwnSynced: called on the run's first
  // own-synced. onLinkLost: called on each 'link-closed' of the run. -> the
  // run record.
  function startRun ({ once, timeoutMs, groups = true, internal = false, label = null, onOwnSynced = noop, onGroupProgress = noop, onLinkLost = noop }) {
    lastRunId = lastRunId >= MAX_ID ? 1 : lastRunId + 1
    const runId = lastRunId
    const epoch = connection
    const { signal, abort } = createAbort()
    // leased: a user's continuous run under the lease; settled: its last
    // readiness report; leaseTimer: the hold.
    const r = { runId, once, internal, ownSynced: false, groupSynced: new Map(), groupBehind: new Set(), abort, reason: null, done: null, leased: !once && !internal && leaseHoldMs > 0, settled: false, leaseTimer: null, ready: null, gateWake: null, gateLost: false }
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
        const pageRoots = await heldPageRoots()
        r.pageRoots = new Set(pageRoots)
        result = await runSync({
          ...syncOptions,
          pageRoots,
          noClear: noClear === true,
          storage,
          associationKey: cfg.association,
          seederUrl: cfg.seederUrl,
          createSocket,
          once,
          timeoutMs: once ? timeoutMs : undefined,
          groups: once ? groups !== false : true,
          peeker: diaryPeeker,
          reader,
          followPage: syncOptions.followPage !== undefined ? syncOptions.followPage : followMovedPage,
          // The own diary's `prove` on each link (./sync.js signProof), with
          // the in-memory key, for the own key the run opened.
          signProof: (noiseHex, own) => {
            if (keyPair === null) throw new UsageError(store.LOCKED)
            if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
            return signPeerProof({ noiseHex, keyHex: own, keyPair })
          },
          log: (text) => {
            const [clean, redacted] = redactLogLine(text)
            if (redacted) reportInternal(new Error(String(text)))
            warning(safe(clean), epoch)
          },
          onEvent: (ev) => {
            if (!ev) return
            let landing
            switch (ev.event) {
              case 'skipped':
                warning('aviso: diário ' + key8(ev.key) + ' ignorado (' + safe(ev.reason) + ')', epoch)
                return
              case 'own-synced':
                synced = true
                seederDownAt = null
                // The reader (the app) must not take the echo of a write
                // made here for a post from another device. Any length up
                // to localLength is already in the local core (a later
                // wrote() may move localLength before an earlier length
                // is reported, hence <=). Once per length keeps
                // Ajustes > Sincronização quiet when a new link reports
                // the same length again.
                landing = ownAppends > 0 && ownReported !== null && Number.isSafeInteger(ev.length) && ev.length > ownReported
                if (Number.isSafeInteger(ev.length)) ownReported = ev.length
                if ((landing || (localLength !== null && Number.isSafeInteger(ev.length) && ev.length <= localLength)) &&
                  (localEchoed === null || ev.length > localEchoed)) {
                  localEchoed = ev.length
                  event(LOCAL_LINE + ' (' + safe(String(ev.length)) + ')')
                }
                event('diário próprio sincronizado (' + safe(String(ev.length)) + ')')
                if (keyPair !== null && run === r) {
                  ownCaught = keyPair
                  dmEngine.holdImports(false)
                }
                if (!r.ownSynced) {
                  r.ownSynced = true
                  try { onOwnSynced(r) } catch {}
                  if (r.gateWake !== null) r.gateWake()
                  if (!once && !internal) {
                    refreshRemotePageRoots().catch(noop)
                    dmTick()
                    if (dmRecheck) {
                      dmRecheck = false
                      dmRefresh({ recheck: true }).catch(noop)
                    }
                  }
                  if (!once && drainWanted && drainRetries < MAX_DRAIN_RETRIES) scheduleDrain()
                }
                // A pass refused because the seeder was down runs again now
                // that the link reports the own diary (given back within
                // MAX_UPKEEP_REFUNDS, else counted: upkeepRoom decides).
                if (!once && !internal && upkeepRefused) {
                  upkeepRefused = false
                  if (upkeepRoom()) scheduleUpkeep()
                }
                if (!once && !internal && Number.isSafeInteger(ev.length)) {
                  // Kept while locked too: the link reports each length once,
                  // so the unlock arms from it (setKeyPair).
                  r.ownLength = ev.length
                  scheduleDeviceCheck(ev.length)
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
                // A grown group may make its epoch due (periodicRekeyStep):
                // a rotation-only pass, at most once an hour per group.
                if (!once && !internal && typeof ev.group === 'string') rekeyGrew(ev.group)
                return
              case 'group-writer':
                // A writer stored after the pass that planned on the own
                // length its join made (or another diary's entitled
                // writer): a fresh arming, once per writer key. Only a
                // private group this device writes in can have keys to
                // hand to it, and a writer the own diary binds (another
                // device of the account) is what a new device waits for to
                // enrol; anything else changes no plan.
                if ((ev.account === true || (ev.private === true && ev.own === true)) && typeof ev.writer === 'string' && HEX64.test(ev.writer) && !upkeepWriters.has(ev.writer)) {
                  if (!once && !internal && keyPair !== null && groupPrf !== null && upkeepWriters.size < MAX_UPKEEP_WRITERS) {
                    upkeepWriters.add(ev.writer)
                    armUpkeep(upkeepLength)
                  } else {
                    // Not armed for (a once or internal run, the key cap,
                    // locked): a later echo still plans the shares in full.
                    upkeepFull = true
                  }
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
                seederDownAt = null
                r.ownSynced = false
                holdCopyImports(r)
                event('diário próprio atrasado (' + safe(String(ev.length)) + '/' + safe(String(ev.theirs)) + ')')
                return
              case 'link-closed':
                r.groupSynced.clear()
                r.groupBehind.clear()
                synced = false
                r.ownSynced = false
                holdCopyImports(r)
                // A 'peer' or verified link does not clear it: the own
                // state is unknown until the inventory completes.
                seederDownAt = Date.now()
                try { onLinkLost(r) } catch {}
                if (downTtl > 0 && r.gateWake !== null) {
                  r.gateLost = true
                  r.gateWake()
                }
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
      if (r.gateWake !== null) r.gateWake()
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

  // An own-diary write (see the rules at the top): never stops the run. Its
  // diary is a keyed session of the run's (openShared), so the append is
  // the run's too and goes out on the live link. Hypercore may send the
  // block to the seeder before append() resolves, so a new own length the
  // live run reports while an append is in flight counts as made here
  // (ownAppends), and the length is marked as soon as the append resolves.
  function withOwnWrite (fn) {
    const appending = () => {
      ownAppends++
      let open = true
      return (seq) => {
        if (!open) return
        open = false
        ownAppends--
        if (seq !== null) wrote(seq)
      }
    }
    return fn({ ...ctx(), appending })
  }

  // A read that opens cores: while a run exists it is served on the run's
  // own cores (ctx.cores, held so teardown waits for it), never a second
  // instance and without stopping the run, the lease or its clocks; only a
  // read the run cannot serve (member-ops NEEDS_EXCLUSIVE) falls back to
  // withStore and preempts. The hold is released before that fallback:
  // stopRun waits for every hold, ours included. A startup that has not
  // published the cores within readerWaitMs (slow or stuck storage) is
  // preempted too: every read, and whatever is queued behind it, would
  // otherwise wait on it with no limit. The run publishes before its follow
  // pass, so a read that needs a core not lent yet waits for the follows
  // (opened) and then the startup sweeps (settled), all within the same
  // readerWaitMs from the read's start.
  async function withCores (fn) {
    const r = run
    if (r === null) return withStore(fn)
    const deadline = Date.now() + readerWaitMs
    const late = () => {
      warning('aviso: leitura sem esperar a partida da sincronização (' + readerWaitMs + ' ms)')
      return withStore(fn)
    }
    const api = await readyWithin(r.ready, readerWaitMs)
    if (api === NOT_READY) return late()
    if (api === null || !api.hold()) {
      await r.done
      return withStore(fn)
    }
    // A startup step past the deadline is a NEEDS_EXCLUSIVE, which every
    // read already passes on; `timedOut` tells it from a core the run
    // cannot serve (a borrowed read rewraps errors).
    let timedOut = false
    const step = (p) => p === undefined
      ? undefined
      : async () => {
        if ((await readyWithin(p, deadline - Date.now())) !== NOT_READY) return
        timedOut = true
        throw member.needsExclusive()
      }
    try {
      return await fn({ ...ctx(), cores: { diary: api.diary, replica: api.replica, group: api.group, opened: step(api.opened), settled: step(api.settled) } })
    } catch (err) {
      if (!member.isNeedsExclusive(err)) throw err
    } finally {
      api.release()
    }
    return timedOut ? late() : withStore(fn)
  }

  // Whether the stored replica of `key` is forked, on the run's core when
  // c lends it (a read just served there), else on the storage's. A
  // borrowed read never opens it: the run may have stopped lending a core
  // it has not closed yet, and a second instance would corrupt it, so that
  // read reruns on the exclusive path.
  async function replicaForked (c, key) {
    const lent = c.cores ? await member.lentCore(c.cores, () => c.cores.replica(key)) : null
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

  // The live continuous run tracks the own diary, or a run of this unlock
  // caught it up and no link loss or own-behind cleared that since
  // (holdCopyImports).
  function ownHeld () {
    return trackingOwn() || (keyPair !== null && ownCaught === keyPair)
  }

  // A run lost its seeder link less than downTtl ago and no run reported the
  // own diary since (the fast refusal).
  function seederDown () {
    if (downTtl <= 0 || seederDownAt === null) return false
    const age = Date.now() - seederDownAt
    return age >= 0 && age < downTtl
  }

  // Before a diary write: this device must hold what the seeder holds for
  // its key. Unless a continuous run tracks it, an internal once run must
  // receive the seeder's hello and reach the advertised length (own-synced
  // from THAT run); it is stopped as soon as that happened. The user's sync
  // intent is restored whatever the outcome.
  // While a continuous run is wanted, a write refuses at once when the link
  // dropped lately (seederDown), and a gate run ends at its first link loss:
  // neither waits out the deadline against a seeder that is gone (a
  // redeploy) nor holds the reads queued behind it. Both only refuse
  // sooner; nothing is written that the gate run would have refused.
  // epoch: the handler's connection epoch; a client that detached while the
  // gate ran gets 'conexão encerrada' and nothing is written, and the sync
  // intent is restored only when nothing (detach) changed it meanwhile.
  // ride (post.reply only): a live continuous run not yet own-synced is
  // waited on, not stopped, for up to writeGateRideMs of the same deadline.
  async function ensureCaughtUp (epoch, groupKeys = [], generation = null, { ride = false } = {}) {
    let gateMs = writeGateTimeoutMs
    kickLease() // a write redials, inside the lease's gap too
    if (!writeGate) return
    if (trackingOwn() && groupKeys.every((key) => groupCaughtUp(run, key))) return
    if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
    // The fast refusal: the live continuous run (or the restart it waits
    // for) is not stopped, so it keeps redialling and its reads go on.
    if (syncIntent === 'continuous' && (run === null || (!run.once && !run.internal)) && seederDown()) {
      const err = new UsageError(NOT_SYNCED_MESSAGE)
      err[SEEDER_DOWN] = true
      throw err
    }
    if (ride && groupKeys.length === 0 && generation === null && syncIntent === 'continuous' && run !== null && !run.once && !run.internal) {
      const r = run
      const now = Date.now()
      const deadline = now + writeGateTimeoutMs
      const rideEnd = now + Math.min(writeGateRideMs, writeGateTimeoutMs)
      r.gateLost = false
      const waiting = () => run === r && !r.ownSynced && !r.gateLost && Date.now() < rideEnd
      while (waiting()) {
        let timer = null
        try {
          await new Promise((resolve) => {
            r.gateWake = resolve
            timer = setTimeout(resolve, Math.max(1, rideEnd - Date.now()))
          })
        } finally {
          clearTimeout(timer)
          r.gateWake = null
        }
      }
      if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      // The fast path's own predicate, read now: a block is appended only in
      // the states in which the fast path appends.
      if (run === r && trackingOwn()) return
      // Still live but not in sync by the deadline, or its link dropped: the
      // run is left to redial and serve reads, as with the fast refusal.
      if (run === r && (r.gateLost || Date.now() >= deadline)) {
        const err = new UsageError(NOT_SYNCED_MESSAGE)
        if (r.gateLost) err[SEEDER_DOWN] = true
        throw err
      }
      // The run ended, or the ride's share ran out: the catch-up run gets
      // what is left of the one deadline.
      gateMs = Math.max(1, deadline - Date.now())
    }
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
    // A link loss while a continuous run is wanted ends the gate (refused,
    // marked as the fast refusal: the seeder is down here too).
    let lost = false
    const linkLost = intent === 'continuous' && downTtl > 0
      ? () => {
          ok = false
          lost = true
          arrived()
        }
      : noop
    const r = startRun({
      once: true,
      timeoutMs: gateMs,
      internal: true,
      label: GATE_LINE,
      onOwnSynced: progress,
      onGroupProgress: progress,
      onLinkLost: linkLost
    })
    await Promise.race([caughtUp, r.done])
    await stopRun('preempted')
    if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
    if (generation !== null) checkGroupOperation(epoch, generation)
    syncIntent = intent
    if (!ok) {
      const err = new UsageError(NOT_SYNCED_MESSAGE)
      if (lost) err[SEEDER_DOWN] = true
      throw err
    }
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
    // Already marked when the block landed (withOwnWrite): an echo since
    // then may have cleared `unpushed`.
    if (localLength === seq + 1) return
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
      drainRefusals = 0
      await pushAfterWrite()
    } catch (err) {
      drainWanted = true
      // Refused because the seeder is down: nothing was tried, so the
      // retries stay for real failures and the next own-synced drains.
      // Past MAX_DRAIN_REFUSALS a refusal counts, so a flapping link
      // cannot repeat the drain without end.
      if (seederDownError(err) && drainRefusals < MAX_DRAIN_REFUSALS) drainRefusals++
      else drainRetries++
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
    // The seeder is known down and no usable peek is published: fail at once
    // (the caller throws SEEDER_UNAVAILABLE); the kick and no-op above still
    // restart a wanted continuous run.
    if (seederDown()) return Promise.resolve(null)
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

  // diary.peek under its own deadline (page.read's probe). opts: internal
  // only (listing.ratings and the diary.peek method ask for the block-0
  // certificate date).
  function diaryPeekWithin (params, timeoutMs, opts = null) {
    if (closed) return Promise.reject(rpcError('LOCKED', CLOSED_MESSAGE))
    if (diaryPeeksInFlight >= MAX_DIARY_PEEKS) return Promise.reject(rpcError('USAGE', DIARY_PEEK_BUSY))
    return borrow(() => diaryPeekWith(params, timeoutMs, opts))
  }

  async function diaryPeekWith ({ author, seqs, profileSeq, usernameSeq }, timeoutMs, opts = null) {
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
          const r = await peek(key, seqs, profileSeq === undefined ? null : profileSeq, usernameSeq === undefined ? null : usernameSeq, deadline, opts)
          return await checkShows(peek, key, r, deadline)
        } catch (err) {
          if (messageOf(err) !== SEEDER_UNAVAILABLE || Date.now() >= deadline) throw err
          dropped = peek
        }
      }
      throw new Error(SEEDER_UNAVAILABLE)
    } catch (err) {
      const out = toRpcError(err, reportInternal)
      // Internal readers only: the unread-block-0 flag of ./sync.js.
      if (opts !== null && err !== null && typeof err === 'object' && err.unread === true) out.unread = true
      throw out
    } finally {
      diaryPeeksInFlight--
    }
  }

  // A testimonial-show stands only while its writer's block, read now on
  // the same link, commits to that text for this owner (verifyShow): any
  // other show, its writer block missing, revoked or mismatched included,
  // moves to `invalid`. A writer whose diary could not be read at all leaves
  // its shows `unverified` (docs/rpc.md 5.27): unknown, never proven bad. A
  // dropped link is the caller's retry.
  async function checkShows (peek, owner, r, deadline) {
    const shows = r.entries.filter((e) => e.record.type === 'testimonial-show')
    if (shows.length === 0) return r
    const byWriter = new Map()
    for (const { record } of shows) {
      if (!byWriter.has(record.from)) byWriter.set(record.from, new Set())
      byWriter.get(record.from).add(record.seq)
    }
    const writer = new Map()
    const unreadable = new Set()
    for (const [from, set] of byWriter) {
      if (from === owner) continue
      const all = [...set].sort((a, b) => a - b)
      for (let i = 0; i < all.length; i += PEEK_SEQS_MAX) {
        try {
          const w = await peek(from, all.slice(i, i + PEEK_SEQS_MAX), null, null, deadline)
          for (const e of w.entries) writer.set(from + ':' + e.seq, e.record)
        } catch (err) {
          if (messageOf(err) === SEEDER_UNAVAILABLE) throw err
          unreadable.add(from)
        }
      }
    }
    const bad = new Set()
    const unknown = new Set()
    for (const { seq, record } of shows) {
      const block = writer.get(record.from + ':' + record.seq) || null
      if (verifyShow(record, block, owner)) continue
      // A chunk that failed leaves the writer's other blocks unknown too.
      if (block === null && unreadable.has(record.from) && record.from !== owner) unknown.add(seq)
      else bad.add(seq)
    }
    const drop = (e) => !bad.has(e.seq) && !unknown.has(e.seq)
    return {
      ...r,
      entries: bad.size === 0 && unknown.size === 0 ? r.entries : r.entries.filter(drop),
      invalid: bad.size === 0 ? r.invalid : [...r.invalid, ...bad].sort((a, b) => a - b),
      unverified: [...unknown].sort((a, b) => a - b)
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

  // -> { phoneVerifiedDate, phoneSince } for the own key `own`, as ageState:
  // kv reads only, and an object that does not verify reads as null.
  async function phoneState (own) {
    if (own === null) return { phoneVerifiedDate: null, phoneSince: null }
    const revokedIssuers = await ageRevokedIssuers()
    if (!phoneChecked) {
      const verified = await store.readPhoneVerified(storage)
      const since = await store.readPhoneSince(storage)
      phoneVerifiedDate = verified !== null && verifyPhoneVerified(verified, own, cfg.association, { revokedIssuers }).ok ? verified.date : null
      phoneSinceDate = since !== null && verifyPhoneSince(since, cfg.association, { revokedIssuers }).ok ? since.since : null
      phoneChecked = true
    }
    return { phoneVerifiedDate, phoneSince: phoneSinceDate }
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
      phoneChecked = false
    }
    return ageRevoked
  }

  // The own key of a seen request (push.sign's lookup), unlocked and matching.
  async function seenOwn () {
    let own
    if (ownKey !== null) own = ownKey
    else if (diaryInfo !== null) own = diaryInfo.publicKey
    else {
      own = await requireOwnKey()
      restartWhenIdle(1)
    }
    if (keyPair === null) throw new UsageError(store.LOCKED)
    if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
    return own
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
    const r = await withOwnWrite((c) => toggle(c, { to: ref, on }))
    if (r.changed) wrote(r.seq)
    await pushAfterWrite()
    return { seq: r.seq, on: r.on, changed: r.changed }
  }

  // The outbox seal of the unlocked identity `author` (docs/rpc.md 5.124
  // and 5.125): fn(key) runs in the same tick as the last check, so a lock
  // can never hand it a zeroed key. Off the chain: it reads no storage.
  async function withOutboxKey (author, fn) {
    const check = () => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      if (keyPair === null || groupPrf === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== author) throw new UsageError(OUTBOX_WRONG_AUTHOR)
    }
    try {
      check()
      if (outboxKey === null) {
        const gen = outboxGen
        const key = await outboxKeyFromPrf(groupPrf, { hkdf })
        if (gen !== outboxGen) {
          key.fill(0)
          check()
          throw new UsageError(store.LOCKED)
        }
        if (outboxKey === null) outboxKey = key
        else key.fill(0)
        check()
      }
      return fn(outboxKey)
    } catch (err) {
      throw toRpcError(err, reportInternal)
    }
  }

  function checkGroupOperation (epoch, generation) {
    if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
    if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
    if (generation !== groupEpoch || keyPair === null || groupPrf === null) throw new UsageError(store.LOCKED)
  }

  function cancelGroups () {
    groupEpoch++
    boxKeys.lock()
    groupMemo.clear()
    if (groupWriting && run !== null && run.internal) run.abort()
  }

  async function deriveGroupKeyPair (nonce, epoch, generation) {
    checkGroupOperation(epoch, generation)
    const pair = await groupKeyPairFromPrf(groupPrf, nonce, { hkdf })
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
    upkeepRefunds = 0
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
    upkeepRefused = false
    upkeepRefunds = 0
    upkeepWanted = false
    upkeepWriters.clear()
    shareChecked = false
    upkeepFull = false
    upkeepFullAt = 0
    upkeepQuick = false
    clearRekeyTimer()
  }

  // ---- the periodic rotation of private groups' keys ----
  // (docs/protocol.md "Rotation", @varanda/core lib/group-rekey.js)

  function clearRekeyTimer () {
    if (rekeyTimer !== null) clearTimeout(rekeyTimer)
    if (rekeyPassTimer !== null) clearTimeout(rekeyPassTimer)
    if (rekeyDeferTimer !== null) clearTimeout(rekeyDeferTimer)
    rekeyTimer = null
    rekeyTimerAt = null
    rekeyPassTimer = null
    rekeyDeferTimer = null
    rekeyDeferAt = Infinity
    rekeyDeferred.clear()
  }

  // Runs a rotation-only pass when the earliest group not due yet becomes
  // due, never sooner than the check limit (a group checked now is skipped
  // until then).
  function armRekeyTimer (at) {
    const now = rekeyClock()
    const delay = Math.min(Math.max(at - now, REKEY_CHECK_MS), 0x7fffffff)
    if (closed || (rekeyTimerAt !== null && rekeyTimerAt <= now + delay)) return
    if (rekeyTimer !== null) clearTimeout(rekeyTimer)
    rekeyTimerAt = now + delay
    rekeyTimer = setTimeout(() => {
      rekeyTimer = null
      rekeyTimerAt = null
      scheduleRekey()
    }, delay)
  }

  // A group that grew starts a rotation-only pass at most once an hour;
  // growth inside its hour is kept and starts one when the hour ends, on a
  // single timer.
  function rekeyGrew (group) {
    if (closed || keyPair === null || groupPrf === null) return
    if (rekeyTriggers.ready(group)) {
      rekeyTriggers.checked(group)
      scheduleRekey()
      return
    }
    rekeyDeferred.add(group)
    const at = rekeyTriggers.readyAt(group)
    if (rekeyDeferTimer !== null && rekeyDeferAt <= at) return
    if (rekeyDeferTimer !== null) clearTimeout(rekeyDeferTimer)
    rekeyDeferAt = at
    rekeyDeferTimer = setTimeout(() => {
      rekeyDeferTimer = null
      rekeyDeferAt = Infinity
      const groups = [...rekeyDeferred]
      rekeyDeferred.clear()
      for (const g of groups) rekeyGrew(g)
    }, Math.min(Math.max(at - rekeyClock(), 0), 0x7fffffff))
  }

  // A rotation-only pass outside the upkeep's armings: it leaves their
  // bounds and disarming alone, and stops the run only to rotate.
  function scheduleRekey () {
    if (rekeyQueued || rekeyPassTimer !== null || closed || keyPair === null || groupPrf === null) return
    rekeyPassTimer = setTimeout(() => {
      rekeyPassTimer = null
      if (closed || rekeyQueued) return
      rekeyQueued = true
      rekeyOnly({}).catch(noop)
    }, upkeepDelayMs)
  }

  // withCores without its fallback: a plan the running sync cannot serve
  // from its own cores is skipped (null), so the rotation-only pass stops
  // the run only to write. The upkeep pass and the due timer check later.
  async function withLentCores (fn) {
    const r = run
    if (r === null) return withStore(fn)
    const api = await readyWithin(r.ready, readerWaitMs)
    if (api === NOT_READY || api === null || !api.hold()) return null
    try {
      return await fn({ ...ctx(), cores: { diary: api.diary, replica: api.replica, group: api.group } })
    } catch (err) {
      if (member.isNeedsExclusive(err)) return null
      throw err
    } finally {
      api.release()
    }
  }

  const rekeyOnly = serial(async (_, epoch, generation) => {
    rekeyQueued = false
    if (closed || keyPair === null || groupPrf === null) return
    try { checkGroupOperation(epoch, generation) } catch { return }
    // The app's recovery run is never preempted: the next trigger checks.
    if (run !== null && run.once) return
    if (!(await store.diaryExists(storage))) return
    groupWriting = true
    try {
      await periodicRekeyStep(epoch, generation, withLentCores)
    } finally {
      groupWriting = false
      for (const pair of groupPairs) zeroPair(pair)
      groupPairs.clear()
    }
  })

  // Inside an upkeep pass: plans on the run's cores which private groups
  // this device distributes in have a due epoch, then rotates them through
  // the write gate like the shares. Each group is checked at most once per
  // REKEY_CHECK_MS, whatever the outcome; a failure waits for the next check
  // and is never a warning: the group keeps its epoch, nothing is pending.
  async function periodicRekeyStep (epoch, generation, read = withCores) {
    try {
      const now = rekeyClock()
      const jitter = (group, kid) => rekeyGate.jitter(group, kid)
      const plan = await read((c) => member.periodicRekeyPlan(c, { now, ready: (group) => rekeyGate.ready(group), jitter }))
      if (plan === null) return
      for (const group of plan.checked) rekeyGate.checked(group)
      if (plan.next !== null) armRekeyTimer(plan.next)
      if (plan.rekey.length === 0) return
      const planned = plan.rekey.map((x) => x.group)
      checkGroupOperation(epoch, generation)
      await ensureCaughtUp(epoch, [...new Set(plan.rekey.map((x) => x.writer))], generation)
      // What a step wrote before it threw is announced and pushed too.
      let changed = []
      await withStore(async (c) => {
        checkGroupOperation(epoch, generation)
        const lengths = await ownCoreLengths(planned)
        try {
          await member.periodicRekey(c, { groups: planned, now, jitter })
        } finally {
          const after = await ownCoreLengths(planned)
          changed = plan.rekey.filter((x) => lengths.get(x.writer) !== after.get(x.writer)).map((x) => x.group)
          await noteWrittenRoots(changed)
        }
      }).catch(noop)
      for (const group of changed) send('groups.changed', { group }, epoch)
      if (changed.length > 0) {
        checkGroupOperation(epoch, generation)
        await pushAfterWrite()
      }
    } catch {}
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
      // Sent only on a change, so a pass of an off device never loops.
      if (plan.off === true && !stale()) noteDeviceOff(true, epoch)
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
        if (result.enrolled.length > 0 || result.shared.length > 0) {
          upkeepPasses = 0
          upkeepRefunds = 0
        }
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
      await periodicRekeyStep(epoch, generation)
      if (arrived) scheduleUpkeep()
      else if (failed > 0) {
        // A root that failed is tried again within the bound.
        if (upkeepRoom()) scheduleUpkeep()
      } else if (waiting.length === 0 && arming === upkeepArming) upkeepArmed = false
    } catch (err) {
      upkeepFull = true
      if (seederDownError(err)) {
        // The gate refused before any write because the seeder is down: the
        // pass is given back and no timer retries it against the seeder
        // that is gone; the next own-synced of a user's continuous run
        // queues it (upkeepRefused). Real failures keep both bounds, and so
        // does a refusal past MAX_UPKEEP_REFUNDS (a flapping link): it is
        // still queued by the next own-synced only while upkeepRoom().
        if (arming === upkeepArming && upkeepRefunds < MAX_UPKEEP_REFUNDS) {
          upkeepRefunds++
          upkeepPasses = Math.max(0, upkeepPasses - 1)
          upkeepTotal = Math.max(0, upkeepTotal - 1)
        }
        upkeepRefused = true
        if (!stale()) warning(UPKEEP_WARNING, epoch)
      } else if (!stale()) {
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

  // A listing reference -> { author, seq }, else 'referência inválida'.
  function listingRef (to) {
    const ref = parseRef(to)
    if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
    return ref
  }

  // post.delete / profile.delete: the post.reply path around member-ops'
  // tombstone writer (a target already deleted writes nothing).
  async function recordDelete (remove, { to, about }, epoch) {
    const ref = parseRef(to)
    if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
    await requireUnlocked()
    await ensureCaughtUp(epoch)
    let r
    try {
      r = await withStore((c) => remove(c, about === undefined ? { to: ref } : { to: ref, about }))
    } catch (err) {
      // Part of the tombstones landed (a chunked delete): count and push
      // them, never retry the rest, and answer the original error.
      if (err !== null && typeof err === 'object' && Number.isSafeInteger(err.written)) {
        wrote(err.written)
        try { await pushAfterWrite() } catch {}
      }
      throw err
    }
    if (r.changed) wrote(r.seq)
    await pushAfterWrite()
    return { seq: r.seq, ref: r.ref, changed: r.changed, deleted: r.deleted }
  }

  // profile.about / profile.mood: part of a write past one append may have
  // landed (earlier tombstone chunks); count and push it, never retry the
  // rest, and answer the original error.
  async function profileExtraWrite (write) {
    let r
    try {
      r = await withStore(write)
    } catch (err) {
      if (err !== null && typeof err === 'object' && Number.isSafeInteger(err.written)) {
        wrote(err.written)
        try { await pushAfterWrite() } catch {}
      }
      throw err
    }
    if (r.changed !== false) {
      wrote(r.seq)
      await pushAfterWrite()
    }
    return r
  }

  // post.share / post.unshare / post.cover (docs/rpc.md 5.122, 5.123,
  // 5.169): the recordDelete path. pushAfterWrite is called even when
  // nothing was written: it still pushes while the seeder has not confirmed
  // the local length. `extra`: the method's params besides `to`.
  async function shareWrite (write, to, epoch, extra = {}) {
    const ref = parseRef(to)
    if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
    await requireUnlocked()
    await ensureCaughtUp(epoch)
    let r
    try {
      r = await withStore((c) => write(c, { ...extra, to: ref }))
    } catch (err) {
      // Part of the append landed (post.unshare across chunks): count and
      // push it, never retry the rest, and answer the original error.
      if (err !== null && typeof err === 'object' && Number.isSafeInteger(err.written)) {
        wrote(err.written)
        try { await pushAfterWrite() } catch {}
      }
      throw err
    }
    if (r.written !== null) wrote(r.written)
    await pushAfterWrite()
    return r
  }

  // ---- connected devices (docs/rpc.md 5.152 to 5.155) ----

  // devices.changed (section 6): `off` for this device, sent when it differs
  // from the last one sent under the current key pair (none sent: false).
  function noteDeviceOff (off, epoch) {
    if (typeof off !== 'boolean' || off === deviceOffSent || keyPair === null) return
    deviceOffSent = off
    send('devices.changed', { off }, epoch)
  }

  // A new own length on a user's continuous run may bring another device's
  // off record or cut marks: a read on the run's cores, once per length.
  // It stays off the request chain and only borrows: a run that has not
  // lent its cores yet, cannot hold them or cannot serve the read skips
  // it (never waits for the run's end and never preempts it); the next
  // length, the upkeep or a device.* call reads again.
  // `deviceCheckLength` is the length last read for good. The link reports
  // each length once, so a skipped or failed read is not read again from
  // here until a new length: the upkeep pass (see upkeep) reads the device
  // state again and says off.
  let deviceChecking = false
  let deviceCheckNext = null
  async function deviceCheck (length) {
    if (deviceChecking) {
      deviceCheckNext = length
      return
    }
    deviceChecking = true
    try {
      for (let next = length; next !== null; next = deviceCheckNext) {
        deviceCheckNext = null
        const r = run
        if (closed || keyPair === null || r === null || r.once) return
        const epoch = connection
        const kp = keyPair
        const api = await readyWithin(r.ready, 0)
        if (api === NOT_READY || api === null || !api.hold()) continue
        let out = null
        try {
          out = await member.deviceOff({ ...ctx(), cores: { diary: api.diary, replica: api.replica, group: api.group, opened: undefined, settled: undefined } })
        } catch (err) {
          if (!member.isNeedsExclusive(err)) throw err
        } finally {
          api.release()
        }
        if (out === null || run !== r || keyPair !== kp || epoch !== connection) continue
        deviceCheckLength = next
        noteDeviceOff(out.off, epoch)
        // An off record only adds up, so off read on a diary still behind is
        // already true: the copy stops now, not when the run catches up.
        if (out.off === true) feedDevice({ self: null, off: true })
        copyKick().catch(noop)
      }
    } finally {
      deviceChecking = false
    }
  }

  // The automatic history copy (./dm-copy.js): this device's id, state and
  // copy targets read on the run's cores (borrowed as deviceCheck does: a run
  // that cannot lend them skips it, never preempted), then the engine's job.
  // Not awaited and not a dmCall: a same-key setKeyPair must not wait for a
  // copy that takes minutes; the engine's lock stops it. Never throws.
  // The last view read, reused while the own diary keeps its length: the
  // tick kicks every minute, and the view reads the whole own diary.
  // COPY_VIEW_MS bounds it so a target still leaves the window on time.
  let copyKicking = false
  let copyViewLast = null
  async function copyKick () {
    if (copyKicking) return
    copyKicking = true
    try {
      const r = run
      // Only on an own diary this run caught up: one that lags may still
      // show a disconnected device as on.
      if (closed || keyPair === null || ownKey === null || r === null || r.once || !r.ownSynced || !dmEngine.unlocked()) return
      if ((await store.readDmKey(storage)) === null) return
      const own = ownKey
      const kp = keyPair
      const api = await readyWithin(r.ready, 0)
      if (api === NOT_READY || api === null || !api.hold()) return
      let view = null
      try {
        const length = api.diary && Number.isSafeInteger(api.diary.length) ? api.diary.length : null
        const last = copyViewLast
        if (length !== null && last !== null && last.r === r && last.kp === kp && last.length === length && Date.now() - last.at < COPY_VIEW_MS) {
          view = last.view
        } else {
          view = await member.deviceCopyView({ ...ctx(), cores: { diary: api.diary, replica: api.replica, group: api.group, opened: undefined, settled: undefined } })
          copyViewLast = view === null || length === null ? null : { r, kp, length, at: Date.now(), view }
        }
      } catch (err) {
        if (!member.isNeedsExclusive(err)) throw err
      } finally {
        api.release()
      }
      if (view === null || closed || run !== r || !r.ownSynced || keyPair !== kp || ownKey !== own || !dmEngine.unlocked()) return
      dmEngine.setDevice(view)
      dmEngine.autoCopy(own, kp, view).catch(noop)
    } catch {
    } finally {
      copyKicking = false
    }
  }

  // This device's state for the history copy, from device.hello,
  // device.list or deviceCheck: off at once, on only once the own diary is
  // caught up, by a run of this unlock or by the live continuous run (one
  // read before that, as an app open after days offline reads it, may not
  // hold the record that turned this device off), so until then an import
  // waits. copyKick gives it with the targets later.
  function feedDevice (v) {
    if (v.off === true || ownHeld()) dmEngine.setDevice(v)
  }

  // The live continuous run lost its link or its own diary fell behind: a
  // record that turns this device off may be on the way, so the device state
  // the copy engine holds may be stale. Imports wait until the own diary is
  // caught up again (own-synced releases them); a copy this device makes
  // goes on, checked against its own targets.
  function holdCopyImports (r) {
    if (run !== r || r.once) return
    ownCaught = null
    dmEngine.holdImports(true)
  }

  function scheduleDeviceCheck (length) {
    if (closed || keyPair === null || length === deviceCheckLength) return
    deviceCheck(length).catch(noop)
  }

  // A device write: whatever reached the own diary (part of a disconnect
  // that failed half way too) is counted and pushed. Never retried.
  async function deviceWrite (write) {
    const length = (c) => member.withIdentity(c, async ({ diary }) => diary.length)
    let r
    try {
      r = await withStore(async (c) => {
        const before = await length(c)
        try {
          return await write(c)
        } finally {
          const after = await length(c)
          if (after > before) wrote(after - 1)
        }
      })
    } catch (err) {
      try { await pushAfterWrite() } catch {}
      throw err
    }
    await pushAfterWrite()
    return r
  }

  // device.disconnect: a once run of at most writeGateTimeoutMs brings the
  // held group cores (the other devices' writers included) up to what the
  // seeder serves, ending early once its goals are met; the cuts then mark
  // the contiguous length held. The user's sync intent is restored.
  async function refreshGroupCores (epoch) {
    kickLease()
    if (!writeGate) return
    if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
    if (run !== null) await stopRun('preempted')
    const intent = syncIntent
    const r = startRun({ once: true, timeoutMs: writeGateTimeoutMs, internal: true, label: DEVICE_LINE })
    await r.done
    if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
    syncIntent = intent
  }

  // ---- direct messages (docs/rpc.md 5.73 to 5.81) ----

  // The roots of the pages whose secrets are held (dm.pageForget or a lock
  // drops them from the next run), read before the run starts and outside
  // any tracked engine operation: no run lends cores yet, so the stored
  // page diaries are read on the exclusive path. A failure pages none.
  // A page whose diary is not stored here adds the roots its last remote
  // scan found (refreshRemotePageRoots): the peek is served by a run, so
  // it cannot be read before one starts.
  async function heldPageRoots () {
    const pages = dmEngine.heldPageBoxes().map((p) => p.page)
    const out = new Set()
    for (const page of pages) for (const key of remotePageRoots.get(page) || []) out.add(key)
    if (pages.length === 0) return []
    try {
      for (const key of await member.pageGroupRoots(ctx(), pages)) out.add(key)
    } catch {}
    return [...out]
  }

  // Once a user's continuous run is verified: the live group joins of each
  // held page whose diary is not stored here, through the bounded diary
  // peek (as page.read reads such a page), off the chain and off any
  // tracked engine operation, under PAGE_ROOTS_PEEK_MS overall. A failure
  // keeps no roots for that page. New roots reach the next run.
  let remoteRootsRefresh = null
  function refreshRemotePageRoots () {
    if (remoteRootsRefresh !== null || closed) return remoteRootsRefresh
    remoteRootsRefresh = (async () => {
      const deadline = Date.now() + PAGE_ROOTS_PEEK_MS
      const pages = dmEngine.heldPageBoxes().map((p) => p.page)
      for (const page of [...remotePageRoots.keys()]) if (!pages.includes(page)) remotePageRoots.delete(page)
      for (const page of pages) {
        try {
          if (await store.replicaExists(storage, page)) {
            remotePageRoots.delete(page)
            continue
          }
          const roots = await peekPageRoots((params, ms) => diaryPeekWithin(params, ms), page, deadline)
          if (dmEngine.heldPageBoxes().some((p) => p.page === page)) remotePageRoots.set(page, roots)
        } catch {
          remotePageRoots.delete(page)
        }
      }
      if (missingPageRoots()) scheduleRootsRestart()
    })().finally(() => { remoteRootsRefresh = null })
    return remoteRootsRefresh
  }

  // A remote root the live continuous run did not start with.
  function missingPageRoots () {
    if (run === null || run.once || !(run.pageRoots instanceof Set)) return false
    for (const roots of remotePageRoots.values()) {
      for (const key of roots) if (!run.pageRoots.has(key)) return true
    }
    return false
  }

  // Stops the continuous run once, as a fold restart does; the chain's
  // restartWhenIdle starts it again with the new roots, so the next check
  // finds none missing (never a loop).
  let rootsQueued = false
  const restartForRoots = serial(async () => {
    rootsQueued = false
    if (!missingPageRoots()) return
    await stopRun('preempted')
  })

  function scheduleRootsRestart () {
    if (rootsQueued || closed) return
    rootsQueued = true
    restartForRoots({}).catch(noop)
  }

  // After a DM unlock settles: the live continuous run may have started
  // while the store was locked, without the roots of the stored page
  // diaries. They are read on its cores, and one restart pages them in
  // this run's place (the next run reads them in heldPageRoots).
  const restartForHeldRoots = serial(async () => {
    const r = run
    if (r === null || r.once || !(r.pageRoots instanceof Set)) return
    const pages = dmEngine.heldPageBoxes().map((p) => p.page)
    if (pages.length === 0) return
    let roots
    try {
      roots = await withCores((c) => member.pageGroupRoots(c, pages))
    } catch {
      return
    }
    if (run === r && roots.some((key) => !r.pageRoots.has(key))) await stopRun('preempted')
  })

  // group.read and group.seal with `page` (docs/rpc.md 5.114): folded as
  // the page with its group box, never falling through to the own groups. A
  // root not held here is listed in kv groupReplicas, so the next sync run
  // fetches it with its writers and community (./sync.js "groups").
  // A read without the page's secrets still answers the root header's
  // visibility (state 'no-key'): the app picks a plain or sealed post from
  // the node, never from the service.
  async function pageGroupOp (operation, params) {
    await requireDm()
    const page = params.page.toLowerCase()
    let r
    if (pageGroupKeys.holds(page)) {
      const groupKeys = pageGroupKeys.holderFor(page)
      r = await withCores((c) => operation({ ...c, groupKeys }, params))
    } else if (operation === member.pageGroupRead) {
      r = await withCores((c) => member.pageGroupNoKey(c, params))
    } else {
      throw new UsageError(NO_PAGE_KEY)
    }
    if (r !== null) return r
    const group = params.group.toLowerCase()
    if (!(await store.readGroupReplicas(storage)).includes(group)) {
      await withStore((c) => store.addGroupReplica(c.storage, group))
    }
    throw new Error('grupo não encontrado')
  }

  // The identity unlocked AND the dm keys derived (setKeyPair with a prf).
  async function requireDm () {
    const own = await requireUnlocked()
    if (!dmEngine.unlocked()) throw new UsageError(store.LOCKED)
    return own
  }

  // A request that needs the dm keys waits OFF the chain for a pending store
  // unlock, so a public read queued after it never waits behind the unlock.
  // Again after each wait: a newer setKeyPair may have replaced it. Callers
  // loop inline and enqueue in the same tick as the last null check (never
  // `await dmReady()`, which yields even with nothing pending): an identity
  // change called right after must queue behind the request, not before it.
  async function dmReady () {
    for (let p = dmUnlocking; p !== null; p = dmUnlocking) await p
  }

  // serial(fn) for every chain step of a request that needs the dm keys
  // (requireDm, dmEngine.*), first and later stages alike: each step waits
  // for a pending store unlock and queues in the tick of the last check, so
  // no step meets an unlock started while the request was off the chain.
  // `ident`: the request's identityTarget, read on its arrival (a later
  // step passes the one its request read); checked when the step queues.
  function serialDm (fn) {
    const run = serial(fn)
    return (params, ident = identityTarget) => {
      if (dmUnlocking === null) {
        if (ident !== identityTarget) return Promise.reject(new UsageError(store.LOCKED))
        return run(params)
      }
      return (async () => {
        for (let p = dmUnlocking; p !== null; p = dmUnlocking) await p
        checkIdentity(ident)
        return run(params)
      })()
    }
  }

  // fn() for a dm-key use OFF the chain (after a step of a request already
  // returned): run in the tick no store unlock is pending, so one started
  // meanwhile (a setKeyPair while the request read or looked up) is waited
  // for instead of meeting a locked engine.
  // `ident` (identityTarget on the request's arrival) is checked in that
  // same tick: a request whose identity changed meanwhile is locked and
  // changes nothing. Once started, the call counts in dmCalls until it
  // settles (dmCallsDone).
  function withDmReady (ident, fn) {
    if (dmUnlocking === null) {
      checkIdentity(ident)
      return dmCall(ident, fn())
    }
    return (async () => {
      for (let p = dmUnlocking; p !== null; p = dmUnlocking) await p
      checkIdentity(ident)
      return dmCall(ident, fn())
    })()
  }

  function dmCall (ident, v) {
    if (v === null || typeof v !== 'object' || typeof v.then !== 'function') return v
    const p = Promise.resolve(v)
    dmCalls.set(p, ident)
    const done = () => { dmCalls.delete(p) }
    p.then(done, done)
    return p
  }

  // Settles once every dm-key use withDmReady started under `ident` has
  // settled, or as soon as another identity change is called (retarget) or
  // the session closes: those lock at once, so a sign-out or a close never
  // waits for a call to end (it meets the lock instead) and a read it
  // interrupts returns no plaintext. Awaited on the chain by a setKeyPair
  // of the same key before it locks the engine: no such call can start
  // while a change is pending (dmUnlocking is set when it is called), and
  // none waits on the chain (an engine call never does, see ./dm.js
  // idle()), so this always ends.
  async function dmCallsDone (ident) {
    while (true) {
      if (closed || ident !== identityTarget) return
      const running = []
      for (const [p, i] of dmCalls) if (i === ident) running.push(p)
      if (running.length === 0) return
      let wake = null
      const moved = new Promise((resolve) => { wake = resolve })
      dmWaitWakes.add(wake)
      try {
        await Promise.race([Promise.allSettled(running), moved])
      } finally {
        dmWaitWakes.delete(wake)
      }
    }
  }

  function checkIdentity (ident) {
    if (ident !== identityTarget) throw new UsageError(store.LOCKED)
  }

  // The identity unlocked AND the dm keys installed; the rows may still be
  // loading (dm.list from the summary).
  async function requireDmKey () {
    const own = await requireUnlocked()
    if (!dmEngine.keyReady()) throw new UsageError(store.LOCKED)
    return own
  }

  // serialDm for dm.list: it waits OFF the chain only for the keys when
  // the engine says the summary answers this page, else for the whole
  // unlock, so a read queued behind it never waits for the row load. Each
  // wait ends with the identity checked and, in that same tick, the step
  // queued.
  // fn returns DM_LIST_MISS when, on the chain, the summary no longer
  // answers and the rows still load (a step queued ahead changed follows or
  // seen): the request leaves the chain, waits for the rows off it and
  // queues again, so no chain step ever waits for the row load.
  function serialDmList (fn) {
    const run = serial(fn)
    return async (params) => {
      const ident = identityTarget
      // A page store whose row load keeps failing is opened afresh on each
      // entry: bounded, then locked as any failed unlock.
      for (let misses = 0; ; misses++) {
        if (misses > 2) throw new UsageError(store.LOCKED)
        for (let p = dmKeying; p !== null; p = dmKeying) await p
        checkIdentity(ident)
        let r
        if (dmUnlocking === null) {
          r = await run(params)
        } else if (await dmEngine.listReady(params).catch(() => false)) {
          if (dmKeying !== null) continue
          checkIdentity(ident)
          r = await run(params)
        } else {
          for (let p = dmUnlocking; p !== null; p = dmUnlocking) await p
          checkIdentity(ident)
          r = await run(params)
        }
        if (r !== DM_LIST_MISS) return r
        await dmEngine.listLoaded(params)
        for (let p = dmUnlocking; p !== null; p = dmUnlocking) await p
        checkIdentity(ident)
      }
    }
  }

  // The first chain step of a DM request of several steps -> own.
  const dmIdentity = serialDm(() => requireDm())

  // fn once no DM unlock is pending; `when` picks the requests that need the
  // dm keys (group.read only with a page).
  function afterDmUnlock (fn, when = null) {
    return async (params) => {
      if (when === null || when(params)) {
        const ident = identityTarget
        for (let p = dmUnlocking; p !== null; p = dmUnlocking) await p
        checkIdentity(ident)
      }
      return fn(params)
    }
  }

  // The DM store unlock of setKeyPair `gen`, started off the chain once the
  // identity is installed, so the reads queued behind it go first. `prf` is
  // this unlock's own copy, zero-filled here exactly once when it settles. A
  // newer identity change (dmUnlockGen) makes it a no-op; one under way is
  // stopped by the engine's own generation (the change's lock).
  // keyed() releases dmKeying once the keys are installed.
  async function runDmUnlock (gen, prf, keyed) {
    const current = () => gen === dmUnlockGen && !closed
    try {
      if (!current()) return
      // The engine's unlock settles at the key stage (dm.list may answer
      // from the summary then); this one settles with the row load, which
      // the other DM requests wait for.
      const unlock = async () => {
        if (!current()) return
        await dmEngine.unlock(prf)
        if (!dmEngine.keyReady()) return
        if (current()) keyed()
        await dmEngine.loaded()
      }
      await (dmUnlockHook === null ? unlock() : dmUnlockHook(unlock, prf))
    } catch (err) {
      // A superseded unlock can fail on the store its lock wiped: not an error.
      if (current()) reportInternal(err)
      return
    } finally {
      prf.fill(0)
    }
    if (!current() || !dmEngine.unlocked()) return
    // The dm box pair and the local store key (docs/rpc.md 5.73); the wallet
    // is checked once after an unlock that has a dm-key.
    try {
      if ((await store.readDmKey(storage)) !== null && current() && keyPair !== null) {
        dmEngine.topUp(keyPair).catch(noop)
        dmRefresh({}).catch(noop)
      }
    } catch (err) {
      reportInternal(err)
    }
    if (!current()) return
    // A continuous run verified while the store was locked: its dm tick and
    // remote page scan returned early then.
    const r = run
    if (r !== null && !r.once && !r.internal && r.ownSynced) {
      dmTick()
      refreshRemotePageRoots().catch(noop)
    }
    if (dmEngine.heldPageBoxes().length > 0) restartForHeldRoots({}).catch(noop)
  }

  // The newest dm-key of `member` -> { box, gen } (both null when none).
  // Local data on the chain; else a bounded newest-first scan through the
  // diary.peek path OFF the chain (a peek waits for the run, which the chain
  // would hold back). Never logs the key.
  async function dmLookupOf (memberKey) {
    const key = memberKey.toLowerCase()
    const localHit = await serial(() => withCores((c) => member.dmLookup(c, key)))({})
    if (localHit !== null) return localHit
    return peekDmKey(key)
  }

  async function peekDmKey (memberKey) {
    const key = memberKey.toLowerCase()
    if (dmKeyPeek !== null) {
      const r = await dmKeyPeek(key)
      return r === null ? { box: null, gen: null } : { box: r.box, gen: r.gen }
    }
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

  // ---- visitas (docs/rpc.md visits.*) ----

  // The day the own switch last went on (the newest `visits` record, when
  // it says on), or null: off, or a time that does not parse.
  function visitSince (state) {
    if (state === null || typeof state !== 'object' || state.on !== true) return null
    const ms = Date.parse(state.at)
    return Number.isFinite(ms) ? visitDay(ms) : null
  }

  // After a dm pull (pull), or when a queued ping is due (the engine's
  // visitsDue, no pull), never inside a pull and never awaited by one: the
  // own switch is read off the own diary first, so a switch turned off on
  // another device of the same passkey reaches this one. While it is on,
  // the visit pool is pulled (pings dated before the day the switch went on
  // are never filed) and the due pings go out. Off: the list and the pings
  // not sent yet are emptied here too, and nothing goes out. One at a
  // time. Never throws.
  let visitPullBusy = false
  function visitPull (own, ident, { pull = true } = {}) {
    if (visitPullBusy) return
    visitPullBusy = true
    ;(async () => {
      try {
        const state = await serialDm(async () => {
          await requireDm()
          return withCores((c) => member.visitsState(c))
        })({}, ident)
        if (state.on !== true) {
          await dmEngine.visitClear({ queue: true })
          return
        }
        const since = visitSince(state)
        if (since === null) return
        // A queue filed under an older on-record (off and on again on
        // another device) is wiped before anything goes out.
        await withDmReady(ident, () => dmEngine.visitAdopt(state.seq))
        if (pull) await withDmReady(ident, () => dmEngine.pullVisits(own, { since, on: state.seq }))
        await withDmReady(ident, () => dmEngine.flushVisits())
      } catch {} finally {
        visitPullBusy = false
      }
    })()
  }

  // Whether `key` takes visit pings now, from public evidence read off the
  // chain: the seeder names the newest `visits` block of `key`
  // (/index/profile), a pointer only, so the block is peeked and must say
  // on; blocks 1 and 2 tell a page from a person and a page takes none.
  // Fails closed: anything unread or unverified is false. RESIDUAL: the
  // seeder can point at an older 'on' block it still serves (it can
  // withhold any newer block); the ping then only reaches a person whose
  // own node drops it while their switch is off.
  async function visitTarget (key) {
    const deadline = Date.now() + peekTimeoutMs
    const left = Math.max(1, deadline - Date.now())
    const index = await seederIndexJson('/index/profile/' + key, VISIT_INDEX_MAX_CHARS, left)
    const seq = index.visits
    if (!isSeq(seq)) return false
    const r = await peekBefore(key, [...new Set([1, 2, seq])].sort((a, b) => a - b), deadline)
    if (r.entries.some((e) => e.seq <= 2 && e.record.type === 'page-roster')) return false
    if ([1, 2].some((q) => q < r.length && r.missing.includes(q))) return false
    const e = r.entries.find((x) => x.seq === seq)
    return e !== undefined && e.record.type === 'visits' && e.record.on === true
  }

  // ---- depoimentos (docs/rpc.md 5.100) ----

  // GET /index/testimonials/<owner> on this node's own seeder (the media
  // route's origin rule) -> { pointers: [{ from, seq }] deduped, at most
  // TESTIMONIAL_PENDING_MAX, incomplete }. Pointers only: every one is read
  // and verified before it counts. No answer, or one without a `pending`
  // list -> SEEDER_UNAVAILABLE, never an empty inbox. An index still
  // indexing or not complete marks the answer incomplete.
  async function testimonialPointers (owner) {
    let ws
    try {
      ws = new URL(cfg.seederUrl)
    } catch {
      throw new Error(SEEDER_UNAVAILABLE)
    }
    const loopback = ws.hostname === '127.0.0.1' || ws.hostname === 'localhost' || ws.hostname === '[::1]'
    if (ws.protocol !== 'wss:' && !(ws.protocol === 'ws:' && loopback)) throw new Error(SEEDER_UNAVAILABLE)
    const url = (ws.protocol === 'wss:' ? 'https://' : 'http://') + ws.host + '/index/testimonials/' + owner
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), peekTimeoutMs)
    let body
    try {
      const res = await fetchMedia(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: ctl.signal })
      if (!res || res.status !== 200 || res.redirected === true) throw new Error(SEEDER_UNAVAILABLE)
      body = JSON.parse(await boundedIndexText(res, TESTIMONIAL_INDEX_MAX_CHARS))
    } catch {
      throw new Error(SEEDER_UNAVAILABLE)
    } finally {
      clearTimeout(timer)
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.pending)) throw new Error(SEEDER_UNAVAILABLE)
    const pending = body.pending
    const incomplete = body.indexing === true || body.complete === false
    const out = []
    const seen = new Set()
    for (const p of pending) {
      if (out.length >= TESTIMONIAL_PENDING_MAX) break
      if (p === null || typeof p !== 'object' || typeof p.from !== 'string' || !/^[0-9a-f]{64}$/.test(p.from)) continue
      if (!Number.isSafeInteger(p.seq) || p.seq < 1 || p.from === owner) continue
      const id = p.from + ':' + p.seq
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ from: p.from, seq: p.seq })
    }
    return { pointers: out, incomplete }
  }

  // ---- recados (docs/rpc.md) ----

  // GET <path> on this node's own seeder (testimonialPointers' origin rule
  // and cap) -> the parsed JSON object. Anything else, a 404 for an owner
  // the seeder does not show included, is SEEDER_UNAVAILABLE.
  async function seederIndexJson (path, max, timeoutMs = peekTimeoutMs) {
    let ws
    try {
      ws = new URL(cfg.seederUrl)
    } catch {
      throw new Error(SEEDER_UNAVAILABLE)
    }
    const loopback = ws.hostname === '127.0.0.1' || ws.hostname === 'localhost' || ws.hostname === '[::1]'
    if (ws.protocol !== 'wss:' && !(ws.protocol === 'ws:' && loopback)) throw new Error(SEEDER_UNAVAILABLE)
    const url = (ws.protocol === 'wss:' ? 'https://' : 'http://') + ws.host + path
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), Math.max(1, timeoutMs))
    let body
    try {
      const res = await fetchMedia(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: ctl.signal })
      if (!res || res.status !== 200 || res.redirected === true) throw new Error(SEEDER_UNAVAILABLE)
      body = JSON.parse(await boundedIndexText(res, max))
    } catch {
      throw new Error(SEEDER_UNAVAILABLE)
    } finally {
      clearTimeout(timer)
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error(SEEDER_UNAVAILABLE)
    return body
  }

  const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
  // scrap.write's evidence deadline: 12 s with the default peek timeout.
  const scrapEvidenceMs = Math.min(12000, 2 * peekTimeoutMs)

  // Whether `owner`'s wall takes a scrap from `writer` now, with public
  // evidence only, read off the chain: the seeder names the owner's wall
  // block and (under 'following') the owner's follow block for the writer;
  // each is a pointer, peeked and checked here. Returns when admitted;
  // throws a USAGE refusal when the verified evidence excludes the writer,
  // and SEEDER_UNAVAILABLE (or the peek's own NOT_FOUND) when evidence
  // cannot be read or does not verify (a hostile seeder fails closed, never
  // open). The seeder can only withhold a newer wall, as it can withhold any
  // block; readers apply the wall again when they show the page.
  // reply: the parsed replyTo, already checked to name `owner`; it must be a
  // live scrap of the owner addressed to the writer, and under 'following'
  // it admits the writer (the reply exception). Whether the writer already
  // answered that original is not checked here: readers (lib/scraps.js and
  // the seeder) admit only the first reply per original.
  // The whole check runs under one deadline (scrapEvidenceMs, well under the
  // client's timeout): past it the answer is SEEDER_UNAVAILABLE and the
  // caller writes nothing; a late read is left to settle on its own.
  async function scrapAdmits (writer, owner, reply) {
    const deadline = Date.now() + scrapEvidenceMs
    let timer = null
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(SEEDER_UNAVAILABLE)), scrapEvidenceMs)
    })
    const work = scrapEvidence(writer, owner, reply, deadline)
    try {
      return await Promise.race([work, late])
    } finally {
      clearTimeout(timer)
      work.catch(() => {})
    }
  }

  async function scrapEvidence (writer, owner, reply, deadline) {
    const left = () => {
      const ms = deadline - Date.now()
      if (ms <= 0) throw new Error(SEEDER_UNAVAILABLE)
      return ms
    }
    const followPath = '/index/follow/' + owner + '/' + writer
    // Without a reply the follow pointer may be needed: asked beside the
    // wall, not after it.
    const early = reply === null ? seederIndexJson(followPath, FOLLOW_INDEX_MAX_CHARS, left()) : null
    if (early !== null) early.catch(() => {})
    const index = await seederIndexJson('/index/scraps/' + owner, SCRAP_INDEX_MAX_CHARS, left())
    const wallSeq = index.wall
    if (wallSeq !== null && !isSeq(wallSeq)) throw new Error(SEEDER_UNAVAILABLE)
    // Blocks 1 and 2 tell a page diary (a page-roster there) from a person's.
    const wanted = new Set([1, 2])
    if (wallSeq !== null) wanted.add(wallSeq)
    if (reply !== null) wanted.add(reply.seq)
    const r = await diaryPeekWithin({ author: owner, seqs: [...wanted].sort((a, b) => a - b) }, Math.min(peekTimeoutMs, left()))
    const at = (seq) => r.entries.find((e) => e.seq === seq)
    if (r.entries.some((e) => e.seq <= 2 && e.record.type === 'page-roster')) throw new UsageError(SCRAP_PAGE)
    // Fails closed: an unread block 1 or 2 inside the diary may be a page's
    // roster. RESIDUAL: a person whose block 1 or 2 is deleted and cleared
    // reads the same way, so writing to them answers unavailable.
    if ([1, 2].some((q) => q < r.length && r.missing.includes(q))) throw new Error(SEEDER_UNAVAILABLE)
    let who = 'following'
    if (wallSeq !== null) {
      const e = at(wallSeq)
      if (e === undefined || e.record.type !== 'scrap-wall') throw new Error(SEEDER_UNAVAILABLE)
      who = e.record.who
    }
    if (reply !== null) {
      const e = at(reply.seq)
      // Not a valid record: not a scrap. Missing or past the length read so
      // far (not replicated yet, not served in time, or deleted and
      // cleared) cannot be told apart from absent: unavailable.
      if (e === undefined && r.invalid.includes(reply.seq)) throw new UsageError('referência inválida')
      if (e === undefined) throw new Error(SEEDER_UNAVAILABLE)
      if (e.record.type !== 'scrap' || e.record.to !== writer) throw new UsageError('referência inválida')
    }
    if (who === 'nobody') throw new UsageError(SCRAP_NOBODY)
    if (who === 'everyone' || reply !== null) return
    const f = await (early !== null ? early : seederIndexJson(followPath, FOLLOW_INDEX_MAX_CHARS, left()))
    if (f.seq === null) {
      // A refusal never rests on an index still catching up.
      if (f.indexing === true) throw new Error(SEEDER_UNAVAILABLE)
      throw new UsageError(SCRAP_FOLLOWING)
    }
    if (!isSeq(f.seq)) throw new Error(SEEDER_UNAVAILABLE)
    const p = await diaryPeekWithin({ author: owner, seqs: [f.seq] }, Math.min(peekTimeoutMs, left()))
    const e = p.entries.find((x) => x.seq === f.seq)
    if (e === undefined || e.record.type !== 'follow' || e.record.key !== writer || e.record.on !== true) throw new Error(SEEDER_UNAVAILABLE)
  }

  // garden.help's and garden.give's evidence deadline (docs/rpc.md 5.160,
  // 5.164): scrap.write's.
  const gardenEvidenceMs = Math.min(12000, 2 * peekTimeoutMs)

  // Whether `owner`'s balcony takes the write now, with public evidence
  // only, read off the chain under ONE deadline as scrapAdmits: the seeder
  // names the owner's newest garden flag and garden-state, each a pointer,
  // peeked and checked here with blocks 1 and 2 (a page-roster there is a
  // page). judge(index, peek, now) is the verdict of member-ops (a help's
  // pot check, or a give's open balcony). Returns when the write may go
  // ahead; throws a USAGE refusal when the verified evidence excludes it,
  // and SEEDER_UNAVAILABLE (or the peek's own NOT_FOUND) when it cannot be
  // read or does not verify.
  // RESIDUAL: the seeder can point at an older live 'on' flag or an older
  // state it still serves (it can withhold any newer block); readers apply
  // foldHelps and drop a help that does not count, so a wrong write costs
  // one of the helper's daily helps and nothing else. For a give, the same
  // older live 'on' flag costs the giver one mimo and one save and nothing
  // else, since the recipient still has to accept it (garden.take).
  async function gardenTarget (owner, judge) {
    const deadline = Date.now() + gardenEvidenceMs
    let timer = null
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(SEEDER_UNAVAILABLE)), gardenEvidenceMs)
    })
    const work = gardenEvidence(owner, judge, deadline)
    try {
      return await Promise.race([work, late])
    } finally {
      clearTimeout(timer)
      work.catch(() => {})
    }
  }

  async function gardenEvidence (owner, judge, deadline) {
    const left = () => {
      const ms = deadline - Date.now()
      if (ms <= 0) throw new Error(SEEDER_UNAVAILABLE)
      return ms
    }
    const index = await seederIndexJson('/index/garden/' + owner, GARDEN_INDEX_MAX_CHARS, left())
    // A refusal never rests on an index still catching up.
    const seqs = member.gardenTargetSeqs(index)
    if (seqs === null) throw new Error(SEEDER_UNAVAILABLE)
    const r = await peekBefore(owner, seqs, deadline)
    const verdict = judge(index, r, Date.now())
    if (verdict === null) return
    if (verdict === 'page') throw new UsageError(GARDEN_PAGE)
    if (verdict === 'off') throw new UsageError(GARDEN_NOT_IN)
    if (verdict === 'no-plant') throw new UsageError(GARDEN_NO_PLANT)
    throw new Error(SEEDER_UNAVAILABLE)
  }

  // Refuses (USAGE `message`) a key whose diary is a page: blocks 1 and 2
  // tell a page diary (a page-roster there) from a person's, peeked as the
  // recados check does. Fails closed: an unread block 1 or 2 inside the
  // diary may be a page's roster, so it answers SEEDER_UNAVAILABLE (a
  // person whose block 1 or 2 is deleted and cleared reads the same way).
  // A diary with no block past 0 has no roster, so it is no page.
  async function refusePage (key, message) {
    return refusePages([key], message)
  }

  // The same check for several keys under ONE deadline (peekTimeoutMs for the
  // whole list, not per key): blocks 1 and 2 of every key are peeked one after
  // the other, each peek getting what is left of the deadline. A single worker
  // never holds more than one of the MAX_DIARY_PEEKS slots, and when the others
  // (the app's own diary.peek calls count) fill them it waits for a slot inside
  // the same deadline instead of failing 'ocupado'. Fails closed: a key that
  // cannot be ruled out (or the deadline reached first) fails the whole call
  // with SEEDER_UNAVAILABLE, and a page among them is refused with `message`.
  async function refusePages (keys, message) {
    const deadline = Date.now() + peekTimeoutMs
    const reads = []
    for (const key of keys) reads.push(await peekBefore(key, [1, 2], deadline))
    if (reads.some((r) => r.entries.some((e) => e.seq <= 2 && e.record.type === 'page-roster'))) throw new UsageError(message)
    if (reads.some((r) => [1, 2].some((q) => q < r.length && r.missing.includes(q)))) throw new Error(SEEDER_UNAVAILABLE)
  }

  // One diary.peek of `seqs` of `author` before `deadline`, waiting for a
  // free slot (the app's own peeks count) instead of failing 'ocupado';
  // SEEDER_UNAVAILABLE once the deadline is reached.
  async function peekBefore (author, seqs, deadline) {
    for (;;) {
      const ms = deadline - Date.now()
      if (ms <= 0) throw new Error(SEEDER_UNAVAILABLE)
      if (diaryPeeksInFlight >= MAX_DIARY_PEEKS) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(PEEK_SLOT_POLL_MS, ms)))
        continue
      }
      try {
        return await diaryPeekWithin({ author, seqs }, ms)
      } catch (err) {
        // A slot taken between the check and the peek: wait again.
        if (err === null || typeof err !== 'object' || err.code !== 'USAGE' || err.message !== DIARY_PEEK_BUSY) throw err
        await new Promise((resolve) => setTimeout(resolve, Math.min(PEEK_SLOT_POLL_MS, Math.max(1, deadline - Date.now()))))
      }
    }
  }

  // Enquetes: refuses a vote on a post the local fold knows deleted (the own
  // diary, a followed one or any replica held here, tombstones read raw as
  // page.read does): a peek of such a block is missing at once (readPeek), so
  // it would read as SEEDER_UNAVAILABLE. A diary not held here is left to
  // checkPoll. Runs on the chain (withCores).
  async function refuseDeletedPoll (to) {
    let read
    try {
      read = await withCores((c) => member.logReadRaw(c, { author: to.author }))
    } catch (err) {
      if (messageOf(err) === NO_LOCAL_DATA) return
      throw err
    }
    const entries = read.entries.slice().sort((a, b) => a.seq - b.seq)
    if (deletedSeqs(entries).has(to.seq)) throw new UsageError(CHOICE_NOT_POLL)
  }

  // Varandinha: whether block `seq` of `author` is a gift its giver withdrew,
  // by the tombstones of a copy of that diary held here (a follow or any
  // replica, read raw as refuseDeletedPoll does). A peek of a diary the run
  // does not track reads the seeder's bytes, so a stale or hostile seeder
  // can still serve a withdrawn gift; this local copy outranks it. A diary
  // not held here is false (garden.take's RESIDUAL). Runs on the chain.
  async function heldGiftDeleted (author, seq) {
    let read
    try {
      read = await withCores((c) => member.logReadRaw(c, { author }))
    } catch (err) {
      if (messageOf(err) === NO_LOCAL_DATA) return false
      throw err
    }
    const entries = read.entries.slice().sort((a, b) => a.seq - b.seq)
    return deletedSeqs(entries).has(seq)
  }

  // Enquetes: refuses a vote unless block `to.seq` of `to.author`, peeked,
  // is a poll post with an option `pick`, or an event post (Eventos: an RSVP,
  // pick 0 'vou' or 1 'talvez'). Fails closed: an unread block
  // inside the diary (a deleted one too) is SEEDER_UNAVAILABLE. RESIDUAL: a
  // deleted poll whose bytes the seeder still serves, of a diary not held
  // here (refuseDeletedPoll), passes; the seeder index and every reader
  // count no vote on a deleted post (protocol, "Seeder poll index").
  async function checkPoll (to, pick) {
    const p = await peekBefore(to.author, [to.seq], Date.now() + peekTimeoutMs)
    const e = p.entries.find((x) => x.seq === to.seq)
    if (e === undefined) {
      if (to.seq < p.length) throw new Error(SEEDER_UNAVAILABLE)
      throw new UsageError(CHOICE_NOT_POLL)
    }
    const count = pickCount(e.record, to.seq)
    if (count === null) throw new UsageError(CHOICE_NOT_POLL)
    if (!(pick < count)) throw new UsageError(CHOICE_PICK_INVALID)
  }

  // The DM engine opens each box with its in-memory pair; nothing else
  // sees the key.
  function openTestimonial (box, gen) {
    return dmEngine.openTestimonial(box, gen)
  }

  // testimonial.pending's decided-only blocks that full peeks reported
  // missing or failed to read: 'from:seq' -> { strikes, at }, oldest first,
  // for the own key testimonialDeadOwner. Never stored: a restart reads them
  // all again.
  const testimonialDead = new Map()
  let testimonialDeadOwner = null

  // Off the chain (each read is a diary.peek). -> { items, kept, incomplete }.
  // Every decided block, kept or declined alike, is read exactly like a
  // pointer, so the reads never tell the seeder or the writer what was
  // decided: which blocks are read, and in what order, depends on keys, seqs
  // and past reads only. The pointer seqs come first (by writer key, seqs
  // ascending) in chunks of their own, so a dead decided block never delays
  // them; then the decided-only seqs, the pointer writers' first, each group
  // by key. A decided-only block a full peek reported missing or failed to
  // read goes to the end (struck), and after TESTIMONIAL_DEAD_REF_STRIKES
  // calls is skipped for a while (omitted, as a revoked block is;
  // testimonialDead, in memory only), so an unserved writer cannot eat the
  // deadline on every call. All the peeks share one deadline
  // (TESTIMONIAL_PENDING_TIMEOUT_MS from the arrival), so a writer that
  // cannot be read cannot hold the answer past the client's timeout; the
  // chunks left when it passes are not read. incomplete, blind to the
  // decisions too (the app retries on it, which the seeder would see), when
  // the index is not complete or a pointer or not yet struck decided-only
  // chunk failed or was skipped. A struck chunk never sets it, so a revoked
  // or unserved block is not "Tentar de novo" forever; a missing or invalid
  // block is simply omitted. Nothing opened is stored: a kept row
  // is reopened and checked against the live writer block on every call, so
  // a tombstoned block, a hash mismatch or a box of another dm-key
  // generation simply drops out. The index answer comes first, as before:
  // while the seeder is down the kept rows are unavailable too (NOT_FOUND),
  // never an empty inbox.
  async function testimonialPending (own, ident) {
    const deadline = Date.now() + testimonialTimeoutMs
    const index = await testimonialPointers(own)
    const pointers = index.pointers
    let incomplete = index.incomplete
    const { shown, held } = await serial(async () => ({
      shown: await withCores((c) => member.testimonialShownKeys(c)),
      held: await store.readTestimonialDecisions(storage, own)
    }))({})
    // testimonial.decide refuses the own key; an entry a buggy device synced
    // would otherwise read the own diary on every call.
    const decisions = held.filter((e) => e.from !== own)
    const pointerIds = new Set(pointers.map((p) => p.from + ':' + p.seq))
    if (testimonialDeadOwner !== own) {
      testimonialDead.clear()
      testimonialDeadOwner = own
    }
    const now = Date.now()
    const pointerRefs = new Map()
    const decidedRefs = new Map()
    const struckRefs = new Map()
    const group = (groups, r) => {
      if (!groups.has(r.from)) groups.set(r.from, [])
      groups.get(r.from).push(r.seq)
    }
    for (const r of readRefs(pointers, decisions, shown)) {
      const id = r.from + ':' + r.seq
      if (pointerIds.has(id)) {
        group(pointerRefs, r)
        continue
      }
      const dead = testimonialDead.get(id)
      if (dead === undefined) group(decidedRefs, r)
      else if (dead.strikes < TESTIMONIAL_DEAD_REF_STRIKES || now - dead.at >= TESTIMONIAL_DEAD_REF_TTL_MS) group(struckRefs, r)
    }
    const pointed = new Set(pointers.map((p) => p.from))
    const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
    const chunks = []
    const chunked = (groups, decidedOnly, struck) => {
      const writers = [...groups.keys()].sort(byKey)
      for (const from of writers.filter((k) => pointed.has(k)).concat(writers.filter((k) => !pointed.has(k)))) {
        const all = groups.get(from).sort((a, b) => a - b)
        for (let i = 0; i < all.length; i += PEEK_SEQS_MAX) chunks.push({ from, seqs: all.slice(i, i + PEEK_SEQS_MAX), decidedOnly, struck })
      }
    }
    chunked(pointerRefs, false, false)
    chunked(decidedRefs, true, false)
    chunked(struckRefs, true, true)
    const blocks = []
    for (const { from, seqs, decidedOnly, struck } of chunks) {
      const left = Math.min(peekTimeoutMs, deadline - Date.now())
      const r = await testimonialPeek(from, seqs, left)
      if (r === null && !struck) incomplete = true
      if (decidedOnly) noteTestimonialPeek(from, seqs, r, left >= peekTimeoutMs)
      if (r === null) continue
      for (const e of r.entries) blocks.push({ from, seq: e.seq, record: e.record })
    }
    // Newest first, as the app lists them.
    blocks.sort((a, b) => (a.record.at < b.record.at ? 1 : a.record.at > b.record.at ? -1 : 0))
    const max = TESTIMONIAL_PENDING_MAX + TESTIMONIAL_KEPT_MAX + TESTIMONIAL_DECLINED_MAX
    const rows = await withDmReady(ident, () => member.testimonialPendingRows(own, blocks, shown, openTestimonial, max))
    const { items, kept } = splitRows(rows, pointerIds, decisions, { pendingMax: TESTIMONIAL_PENDING_MAX, keptMax: TESTIMONIAL_KEPT_MAX })
    return { items, kept, incomplete }
  }

  // A decided-only chunk's peek result r (null when it failed or was not
  // read): a block that arrived (valid or not) is alive again; one missing
  // below the core length strikes, and so does every seq of a failed peek
  // (an unserved writer), but only when the peek had its whole budget, so a
  // chunk cut short by the shared deadline never marks a live block dead.
  function noteTestimonialPeek (from, seqs, r, full) {
    if (r !== null) {
      for (const e of r.entries) testimonialDead.delete(from + ':' + e.seq)
      for (const seq of r.invalid || []) testimonialDead.delete(from + ':' + seq)
    }
    if (!full) return
    const struck = r === null ? seqs : (r.missing || []).filter((seq) => r.length > seq)
    const at = Date.now()
    for (const seq of struck) {
      const id = from + ':' + seq
      const prev = testimonialDead.get(id)
      testimonialDead.delete(id)
      testimonialDead.set(id, { strikes: Math.min(TESTIMONIAL_DEAD_REF_STRIKES, prev === undefined ? 1 : prev.strikes + 1), at })
      if (testimonialDead.size > TESTIMONIAL_DEAD_REF_MAX) testimonialDead.delete(testimonialDead.keys().next().value)
    }
  }

  // One chunk of testimonialPending under what is left of its deadline ->
  // the peek result, or null when it failed or was not read (no time left).
  // A followed writer's in-flight fetch can wait past `left` inside the
  // peek, so the deadline is enforced here too (as listing.ratings, with
  // TESTIMONIAL_LATE_GRACE_MS); the late peek is left to settle on its own
  // (its rejection is swallowed).
  async function testimonialPeek (author, seqs, left) {
    if (left <= 0) return null
    const peek = diaryPeekWithin({ author, seqs }, left)
    let timer = null
    const late = new Promise((resolve) => { timer = setTimeout(resolve, left + TESTIMONIAL_LATE_GRACE_MS, TESTIMONIAL_LATE) })
    try {
      const r = await Promise.race([peek, late])
      if (r !== TESTIMONIAL_LATE) return r
      peek.catch(() => {})
      return null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
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
      const held = await store.readDmKey(storage)
      if (held === null) await store.writeDmKey(storage, gen)
      // A write made in this session, or a dm-key append whose push the
      // seeder never confirmed (kv push, kept across sessions), still waits
      // for its push; any other fresh start pushes nothing.
      const marked = held !== null && held.push !== undefined
      if (localLength !== null || marked) await pushAfterWrite()
      if (marked && !unpushed) await store.writeDmKey(storage, held.gen)
      return { box, gen, seq: null }
    }
    await ensureCaughtUp(epoch)
    const r = await withStore((c) => member.dmKeyEnsure(c, { box, gen }))
    if (r.seq !== null) wrote(r.seq)
    const held = await store.readDmKey(storage)
    const push = r.seq !== null ? r.seq + 1 : (held !== null && held.push !== undefined ? held.push : null)
    // Marked before the push, so a push that fails or never ends leaves it
    // for the next dm.enable.
    await store.writeDmKey(storage, gen, push)
    await pushAfterWrite()
    if (push !== null && !unpushed) await store.writeDmKey(storage, gen)
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

  // The bounded rule: the service refreshes the roster every
  // PAGE_ROSTER_REFRESH_BLOCKS blocks, so a verifying roster that new is
  // the current one; an older one may have been superseded unseen.
  const pageRosterFresh = (length) => (state) => state.page && state.seq >= length - PAGE_ROSTER_REFRESH_BLOCKS

  // page.read from a diary held here, never the network: { base, result },
  // result null when the diary is not held.
  async function pageReadHeld (pageHex) {
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
    if (local.held === null) return { base, result: null }
    // A held diary is read RAW: a tombstone a leaked page key appends
    // cannot reopen a close nor undo a move or a roster. Every stored block
    // counts (a followed diary downloads newest-first, its tail past a
    // gap); only a diary held whole is walked as a chain.
    // A forked replica answers as the core node's pageRead: no page.
    if (local.held.forked) throw rpcError('NOT_FOUND', NO_LOCAL_DATA)
    const { entries, length } = local.held
    if (entries.length === length) return { base, result: pageReadResult({ ...base, entries, full: true, complete: () => true }) }
    return { base, result: pageReadResult({ ...base, entries, full: false, complete: pageRosterFresh(length) }) }
  }

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
        ...(await phoneState(publicKey)),
        followCount: (await store.readFollows(storage)).length,
        sync: syncState(),
        publicDht: false,
        groups: true,
        momentMusic: true,
        postEdit: true
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
    'report.sign': serial(async ({ nonce, target, seq, reason, text, quote, writer, group, anexo, kind }) => {
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
      // A Feira listing: its own statement (report v1 lines under the listing
      // prefix), so a moderator never reads it as a post report.
      if (kind === 'listing') {
        try {
          return { signature: signListingReport({ nonce, member: own, association: cfg.association, target, seq, reason, text, quote }, keyPair) }
        } catch (err) {
          if (err instanceof TypeError) throw new UsageError(BAD_REPORT)
          throw err
        }
      }
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

    // Signs the appeal statement with the in-memory key (docs/rpc.md 5.99),
    // exactly like terms.sign: not a diary write, no append, no network. The
    // session fills in member and association; the text enters the payload
    // hashed.
    'appeal.sign': serial(async ({ nonce, text }) => {
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
        signature = signAppeal({ nonce, member: own, association: cfg.association, text }, keyPair)
      } catch (err) {
        // A text the RPC layer lets through but the statement refuses (a
        // control character or a lone surrogate).
        if (err instanceof TypeError) throw new UsageError(BAD_APPEAL)
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

    // The app's outbox items (docs/rpc.md 5.124 and 5.125): target and text
    // sealed under the outbox key, bound to the readable fields. Neither
    // writes anything.
    'outbox.seal': ({ id, author, association, kind, to, text, writtenAt }) =>
      withOutboxKey(author, (key) => ({ box: sealOutbox(key, { id, author, association, kind, to, text, writtenAt }) })),

    'outbox.open': ({ box, id, author, association, kind, writtenAt }) =>
      withOutboxKey(author, (key) => openOutbox(key, box, { id, author, association, kind, writtenAt })),

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

    // Signs a signup-invite card with the in-memory key, exactly like
    // invite.sign. The session fills in member and association; name and
    // message enter the statement hashed.
    'inviteCard.sign': serial(async ({ code, design, name, message, expires }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      const now = Math.floor(Date.now() / 1000)
      if (expires < now - INVITE_CARD_PAST || expires > now + INVITE_CARD_AHEAD) throw new UsageError(INVITE_CARD_EXPIRES)
      let signature
      try {
        signature = signInviteCard({ code, design, name, message, expires, member: own, association: cfg.association }, keyPair)
      } catch (err) {
        if (err instanceof TypeError) throw new UsageError(BAD_INVITE_CARD)
        throw err
      }
      return { signature }
    }),

    // Checks a card someone else signed. Pure: works locked and with no
    // identity, and never touches the diary, the storage or the network.
    'inviteCard.verify': async ({ signature, ...fields }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const result = strictVerifyInviteCard({ ...fields, association: cfg.association }, signature)
      // A genuine card past its expiry (plus a day of skew) is refused here,
      // so no screen has to carry the clock check (docs/rpc.md 5.102).
      if (result.ok && isInviteCardExpired(fields.expires, Math.floor(Date.now() / 1000))) return { ok: false, reason: 'expired' }
      return result
    },

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

    // Signs the phone-verification request with the in-memory key
    // (docs/rpc.md 5.115), exactly like age.sign. The phone number and the
    // code never reach the node: they go from the client to the account
    // service beside this signature.
    'phone.sign': serial(async ({ action, nonce }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      const signature = signPhone({ action, nonce, member: own, association: cfg.association }, keyPair)
      return { signature }
    }),

    // Stores the account service's signed phone attestations (docs/rpc.md
    // 5.116) as age.proof does; null clears either one. Both are verified
    // before anything is written, so a bad pair stores nothing.
    'phone.proof': serial(async ({ verified, since }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      const revokedIssuers = await ageRevokedIssuers()
      if (verified !== undefined && verified !== null && !verifyPhoneVerified(verified, own, cfg.association, { revokedIssuers }).ok) throw new UsageError(BAD_PHONE_PROOF)
      if (since !== undefined && since !== null) {
        if (!verifyPhoneSince(since, cfg.association, { revokedIssuers }).ok) throw new UsageError(BAD_PHONE_PROOF)
        // Monotonic: a replayed older phone-since never replaces a newer one
        // that still verifies, or a since the association moved would come
        // back.
        const stored = await store.readPhoneSince(storage)
        if (stored !== null && verifyPhoneSince(stored, cfg.association, { revokedIssuers }).ok && Date.parse(since.date) < Date.parse(stored.date)) throw new UsageError(BAD_PHONE_PROOF)
      }
      phoneChecked = false
      if (verified !== undefined) await store.writePhoneVerified(storage, verified)
      if (since !== undefined) await store.writePhoneSince(storage, since)
      return await phoneState(own)
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
      const { base, result } = await pageReadHeld(pageHex)
      if (result !== null) return result
      const fresh = pageRosterFresh
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
    // Nor a delegate's box: dm.lookup finds this identity's own (5.161).
    'dm.actorBox': serial(async () => {
      throw new UsageError(ACTOR_BOX_CORE_ONLY)
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

    'pushDevice.sign': serial(async ({ nonce, action, transport, token, key }) => {
      let own
      if (ownKey !== null) own = ownKey
      else if (diaryInfo !== null) own = diaryInfo.publicKey
      else {
        own = await requireOwnKey()
        restartWhenIdle(1)
      }
      if (keyPair === null) throw new UsageError(store.LOCKED)
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      let payload
      try {
        payload = pushDevicePayload({ nonce, member: own, association: cfg.association, action, transport, tokenHash: tokenHash(transport, token), key })
      } catch (err) {
        if (err instanceof TypeError) throw new UsageError(BAD_PUSH)
        throw err
      }
      if (payload === null) throw new UsageError(BAD_PUSH)
      return { signature: b4a.toString(crypto.sign(payload, keyPair.secretKey), 'hex') }
    }),

    // The seen statement and the seen document (docs/rpc.md 5.95, 5.96):
    // own key as push.sign, no diary core opened; the engine fills member,
    // association and the hashes, so the caller never hands in bytes to sign.
    'seen.sign': serial(async ({ nonce, action }) => {
      const own = await seenOwn()
      return seenSync.sign({ nonce, action }, keyPair, own)
    }),

    'seen.merge': serial(async ({ blob, avisos, unchanged }) => {
      const own = await seenOwn()
      const r = await seenSync.merge({ blob, avisos, unchanged }, keyPair, own)
      if (r.dmChanged || r.groupChanged) seenChanged()
      return r
    }),

    // The key the app derives its once-marks with (docs/rpc.md 5.151): keyed
    // by the identity secret like the notice seen tokens, so a mark that
    // lands in this origin's storage cannot be matched to a Página or invite
    // by hashing public keys. Answered to the app only, never logged or kept.
    'seen.onceKey': serial(async () => {
      await seenOwn()
      const own = b4a.toString(keyPair.publicKey, 'hex')
      const digest = crypto.hash([
        b4a.from('varanda-once-key-v1\n'),
        keyPair.secretKey.subarray(0, 32),
        b4a.from(own)
      ])
      return { key: b4a.toString(digest, 'hex') }
    }),

    'profile.set': serial(async ({ name, bio, avatar }, epoch) => {
      const own = await requireUnlocked()
      await ensureCaughtUp(epoch)
      const { seq } = await withOwnWrite((c) => member.profileSet(c, { name, bio, avatar }))
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
    'post.create': serial(async ({ text, media, preview, poll, event, thumbs, alt }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withOwnWrite((c) => member.postCreate(c, { text, media, preview, poll, event, thumbs, alt }))
      wrote(r.last === undefined ? r.seq : r.last)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    'post.reply': serial(async ({ to, text, media, preview, thumbs, alt }, epoch) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      await requireUnlocked()
      await ensureCaughtUp(epoch, [], null, { ride: true })
      const r = await withOwnWrite((c) => member.postReply(c, { to: ref, text, media, preview, thumbs, alt }))
      wrote(r.last === undefined ? r.seq : r.last)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    // A quote: the post.reply path with a `quote` target.
    'post.quote': serial(async ({ to, text, media, preview, thumbs, alt }, epoch) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withOwnWrite((c) => member.postQuote(c, { to: ref, text, media, preview, thumbs, alt }))
      wrote(r.last === undefined ? r.seq : r.last)
      await pushAfterWrite()
      return { seq: r.seq }
    }),

    'post.delete': serial(async ({ to }, epoch) => recordDelete(member.postDelete, { to }, epoch)),

    // Local data only, works locked (as listing.mine): docs/rpc.md 5.121.
    'post.uncovered': serial(() => withCores((c) => member.postUncovered(c))),
    'post.shared': serial(async ({ to }) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      return withCores((c) => member.postShared(c, { to: ref }))
    }),

    'post.share': serial(async ({ to }, epoch) => {
      const r = await shareWrite(member.postShare, to, epoch)
      return { shareSeq: r.shareSeq, created: r.created }
    }),

    // docs/rpc.md, post.edit: the shareWrite path; nothing is written when
    // the text is the current one, but the push still runs.
    'post.edit': serial(async ({ to, text }, epoch) => {
      const r = await shareWrite(member.postEdit, to, epoch, { text })
      return { seq: r.seq, ref: r.ref, changed: r.changed }
    }),

    'post.cover': serial(async ({ to, image }, epoch) => {
      const r = await shareWrite(member.postCover, to, epoch, { image })
      return { coverSeq: r.coverSeq, created: r.created }
    }),

    'post.unshare': serial(async ({ to }, epoch) => {
      const r = await shareWrite(member.postUnshare, to, epoch)
      return { ok: true, changed: r.changed }
    }),

    'profile.delete': serial(async ({ to }, epoch) => recordDelete(member.profileDelete, { to }, epoch)),

    // ---- the Feira (docs/rpc.md, Feira): the post.create path ----

    'listing.create': serial(async ({ kind, title, text, price, unit, cat, place, media }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.listingCreate(c, { kind, title, text, price, unit, cat, place, media }))
      wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    'listing.edit': serial(async ({ to, expectedRevision, title, text, price, unit, cat, place, media }, epoch) => {
      const ref = listingRef(to)
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.listingEdit(c, { to: ref, expectedRevision, title, text, price, unit, cat, place, media }))
      wrote(r.last)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    'listing.status': serial(async ({ to, status }, epoch) => {
      const ref = listingRef(to)
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.listingStatus(c, { to: ref, status }))
      wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    'listing.delete': serial(async ({ to }, epoch) => recordDelete(member.listingDelete, { to }, epoch)),

    'listing.rate': serial(async ({ to, offer, consent, stars, text }, epoch) => {
      const ref = listingRef(to)
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.listingRate(c, { to: ref, offer, consent, stars, text }))
      wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    // Local data only, works locked.
    'listing.mine': serial(async ({ before, limit }) => {
      return withCores((c) => member.listingMine(c, { before: before === undefined ? null : before, limit }))
    }),

    // Signs the deal consent for an inbound proposta the local DM store
    // holds; appends nothing. The listing must be an own live root, and the
    // offer must be a message from `rater` naming exactly that listing.
    'listing.consent': serialDm(async ({ to, rater, offer }) => {
      const ref = listingRef(to)
      const own = await requireUnlocked()
      if (b4a.toString(keyPair.publicKey, 'hex') !== own) throw new Error(store.MISMATCH)
      await withCores((c) => member.listingLive(c, ref))
      const peer = rater.toLowerCase()
      // Without the DM keys the history cannot be read: locked, as dm.thread.
      if (!dmEngine.unlocked()) throw new UsageError(store.LOCKED)
      const want = { own, seq: ref.seq, rater: peer, offer }
      let before = null
      let found = false
      for (let i = 0; i < OFFER_PAGES && !found; i++) {
        const page = await dmEngine.thread(own, { peer, before, limit: OFFER_PAGE })
        found = member.offerReceived(page.messages, want)
        if (page.next === null) break
        before = page.next
      }
      if (!found) throw new UsageError(NO_OFFER)
      return { consent: member.signConsent(keyPair, want) }
    }),

    // Verified ratings of one listing (docs/rpc.md, Feira): each rater's
    // hinted blocks and block-0 certificate through the diary.peek path, one
    // rater at a time, OFF the chain (as dmLookupOf), under one deadline.
    // Stores nothing. A diary the gate refuses drops its refs; a read that
    // does not finish (busy, timeout, no seeder, the deadline) only marks
    // the answer incomplete with what was verified so far.
    'listing.ratings': async ({ author, seq, refs }) => {
      const key = author.toLowerCase()
      const wanted = refs.map((r) => ({ rater: r.rater.toLowerCase(), seq: r.seq }))
      const byRater = new Map()
      for (const r of wanted) {
        if (!byRater.has(r.rater)) byRater.set(r.rater, new Set())
        byRater.get(r.rater).add(r.seq)
      }
      const deadline = Date.now() + ratingsTimeoutMs
      const peeks = []
      for (const [rater, seqs] of byRater) {
        if (rater === key) continue
        const left = Math.min(peekTimeoutMs, deadline - Date.now())
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        if (left <= 0) {
          peeks.push({ rater, failed: true })
          continue
        }
        try {
          // A followed rater's in-flight fetch can wait past `left` inside the
          // peek, so the shared deadline is enforced here too; the late peek
          // is left to settle on its own (its rejection is swallowed).
          const peek = diaryPeekWithin({ author: rater, seqs: [...seqs].sort((a, b) => a - b) }, left, { cert: true })
          let timer = null
          const late = new Promise((resolve) => { timer = setTimeout(resolve, left, RATINGS_LATE) })
          let r
          try {
            r = await Promise.race([peek, late])
          } finally {
            clearTimeout(timer)
          }
          if (r === RATINGS_LATE) {
            peek.catch(() => {})
            peeks.push({ rater, failed: true })
            continue
          }
          peeks.push({ rater, entries: r.entries, invalid: r.invalid, missing: r.missing, certDate: r.certDate === undefined ? null : r.certDate })
        } catch (err) {
          if (closed) throw toRpcError(err, reportInternal)
          // Only a verified refusal drops the rater; an unread block 0 is a
          // timeout like any other.
          const refused = messageOf(err) === DIARY_UNAVAILABLE && err.unread !== true
          peeks.push(refused ? { rater, hidden: true } : { rater, failed: true })
        }
      }
      return member.ratingsOf({ author: key, seq: seq === undefined ? null : seq, refs: wanted, peeks })
    },

    // Idempotent toggles on the post.reply path: a state already held
    // writes nothing (changed: false) and only pushes an outstanding length.
    'like.set': serial(async ({ to, on }, epoch) => engagementSet(member.likeSet, { to, on }, epoch)),

    'repost.set': serial(async ({ to, on }, epoch) => engagementSet(member.repostSet, { to, on }, epoch)),

    // The recipient's dm-key is looked up off the chain (as dm.send), then
    // the write runs on the chain like post.create. Both chain steps run
    // for the identity of the request's arrival (identityTarget): one
    // installed while the lookup ran (a reset and another key) is locked,
    // never written for. Never retried.
    'testimonial.write': async ({ to, text }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const ident = identityTarget
      const key = to.toLowerCase()
      await serial(async () => {
        checkIdentity(ident)
        const own = await requireUnlocked()
        if (key === own) throw new UsageError(TESTIMONIAL_SELF)
      })({})
      let recipient
      try {
        recipient = await dmLookupOf(key)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serial(async (_, epoch) => {
        checkIdentity(ident)
        await requireUnlocked()
        await ensureCaughtUp(epoch)
        const r = await withStore((c) => member.testimonialWrite(c, { to: key, text, recipient }))
        wrote(r.seq)
        await pushAfterWrite()
        return { seq: r.seq, ref: r.ref }
      })({})
    },

    // Needs the DM key (the boxes are sealed to it), as the DM reads.
    'testimonial.pending': async () => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const ident = identityTarget
      const own = await dmIdentity({}, ident)
      try {
        return await testimonialPending(own, ident)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
    },

    // The writer block is read off the chain, then reopened and checked on
    // it; a block already shown answers its show. Never retried.
    'testimonial.show': async ({ from, seq }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const ident = identityTarget
      const key = from.toLowerCase()
      await dmIdentity({}, ident)
      let record = null
      try {
        const r = await diaryPeek({ author: key, seqs: [seq] })
        const e = r.entries.find((x) => x.seq === seq)
        if (e !== undefined) record = e.record
      } catch {}
      return serialDm(async (_, epoch) => {
        await requireDm()
        await ensureCaughtUp(epoch)
        const r = await withStore((c) => member.testimonialShow(c, { from: key, seq, record, open: openTestimonial }))
        if (r.changed) wrote(r.seq)
        await pushAfterWrite()
        return { seq: r.seq, ref: r.ref }
      })({}, ident)
    },

    // kv only, unlocked only (as block.set). The decision stays private to
    // the member's own devices (it syncs sealed in the seen document): no
    // core is opened, no record is written and no network call is made, so
    // neither the writer nor the seeder can learn it. Never retried.
    'testimonial.decide': serialDm(async ({ from, seq, state, ifNew = false }) => {
      const own = await requireUnlocked()
      const key = from.toLowerCase()
      if (key === own) throw new UsageError('referência inválida')
      const held = await store.readTestimonialDecisions(storage, own)
      const { entries, changed } = applyDecision(held, { from: key, seq, state }, Math.floor(Date.now() / 1000), { ifNew: ifNew === true })
      if (changed) {
        await store.writeTestimonialDecisions(storage, own, entries)
        seenChanged()
      }
      return { changed }
    }),

    // kv only, unlocked only, as testimonial.decide: the momentos the member
    // has seen sync sealed in the seen document. No core is opened, no record
    // is written and no network call is made, so no author learns who saw a
    // momento (momentos have no view counts).
    'moment.seen': serialDm(async ({ author, seq }) => {
      const own = await requireUnlocked()
      const held = await store.readMomentSeen(storage, own)
      const { entries, changed } = markMomentSeen(held, { author: author.toLowerCase(), seq }, Math.floor(Date.now() / 1000))
      if (changed) {
        await store.writeMomentSeen(storage, own, entries)
        seenChanged()
      }
      return { changed }
    }),
    'moments.seen': serial(async () => {
      const own = await requireUnlocked()
      return { refs: momentSeenRefs(await store.readMomentSeen(storage, own)) }
    }),

    'testimonial.delete': serial(async ({ to, about }, epoch) => {
      const r = await recordDelete(member.testimonialDelete, { to, about }, epoch)
      return { seq: r.seq, deleted: r.deleted }
    }),

    // Recados (docs/rpc.md): self, a person this member blocked and a bad
    // record are refused before any read; the owner's wall is then checked
    // off the chain (scrapAdmits), and the write runs on the chain like
    // post.create, refused again for self and a block. Never retried.
    'scrap.write': async ({ to, text, replyTo }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const key = to.toLowerCase()
      let reply = null
      if (replyTo !== undefined) {
        reply = parseRef(replyTo)
        if (reply === null || reply.seq < 1) throw new UsageError('referência inválida')
      }
      const refuse = async (own) => {
        if (key === own) throw new UsageError(SCRAP_SELF)
        if ((await member.memberBlocks(storage)).has(key)) throw new UsageError(DM_BLOCKED)
      }
      const writer = await serial(async () => {
        const own = await requireUnlocked()
        await refuse(own)
        return own
      })({})
      if (reply !== null && reply.author !== key) throw new UsageError('referência inválida')
      try {
        member.scrapDraft({ to: key, text, replyTo: reply })
        await scrapAdmits(writer, key, reply)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serial(async (_, epoch) => {
        await refuse(await requireUnlocked())
        await ensureCaughtUp(epoch)
        const r = await withStore((c) => member.scrapWrite(c, { to: key, text, replyTo: reply, writer }))
        wrote(r.seq)
        await pushAfterWrite()
        return { seq: r.seq, ref: r.ref }
      })({})
    },

    // The page owner's records: appended on the chain like post.create; one
    // already in effect answers it and writes nothing.
    'scrap.hide': serial(async ({ from, seq }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.scrapHide(c, { from, seq }))
      if (r.changed) wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    'scrap.wall': serial(async ({ who }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.scrapWall(c, { who }))
      if (r.changed) wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    // The testimonial.delete path and result: the own scrap, scrap-hide or
    // scrap-wall at `seq`.
    'scrap.delete': serial(async ({ seq }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.scrapDelete(c, { seq }))
      if (r.changed) wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, deleted: r.deleted }
    }),

    // The rich profile (docs/rpc.md): appended to the own diary with the
    // tombstones of every earlier live version (member.publishLatest), never
    // retried; the newest record wins on every reader.
    'profile.about': serial(async (params, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      return profileExtraWrite((c) => member.profileAbout(c, params))
    }),

    'profile.mood': serial(async ({ emoji, text }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      return profileExtraWrite((c) => member.moodSet(c, { emoji, text }))
    }),

    // Withdraws the rich profile record of `kind`: every live version is
    // tombstoned (member.profileExtraDelete), never retried.
    'profile.extra.delete': serial(async ({ kind }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.profileExtraDelete(c, { kind }))
      if (r.changed) wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, deleted: r.deleted }
    }),

    // Fas e Melhores amigos (docs/rpc.md). The record validator cannot see
    // the writer, so self, a person this member blocked and a page are
    // refused here before anything is written (a blocked or page `key`
    // only matters turning ON; withdrawing a fan mark never reads). The
    // page check reads the target's blocks off the chain and fails closed.
    // Appended like profile.about, never retried.
    'fan.set': async ({ key: rawKey, on }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const key = rawKey.toLowerCase()
      const refuse = async (own) => {
        if (key === own) throw new UsageError(FAN_SELF)
        if (on && (await member.memberBlocks(storage)).has(key)) throw new UsageError(DM_BLOCKED)
      }
      await serial(async () => { await refuse(await requireUnlocked()) })({})
      try {
        if (on) await refusePage(key, FAN_PAGE)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serial(async (_, epoch) => {
        await refuse(await requireUnlocked())
        await ensureCaughtUp(epoch)
        return profileExtraWrite((c) => member.fanSet(c, { key, on }))
      })({})
    },

    // Enquetes (docs/rpc.md): a public vote, a `choice` record in the own
    // diary. A pick peeks the poll post first (checkPoll: a live poll, pick
    // one of its options) and refuses a blocked author; a withdrawal (pick
    // null) needs no read, as fan.set off, so a vote on a poll deleted since
    // can still be withdrawn. Appended like fan.set, never retried. -> { seq }.
    'choice.set': async ({ to: rawTo, pick }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const parsed = parseRef(rawTo)
      if (parsed === null || parsed.seq < 1) throw new UsageError('referência inválida')
      const to = { author: parsed.author.toLowerCase(), seq: parsed.seq }
      const refuse = async () => {
        if (pick !== null && (await member.memberBlocks(storage)).has(to.author)) throw new UsageError(DM_BLOCKED)
      }
      await serial(async () => {
        await requireUnlocked()
        await refuse()
        if (pick !== null) await refuseDeletedPoll(to)
      })({})
      try {
        if (pick !== null) await checkPoll(to, pick)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serial(async (_, epoch) => {
        await requireUnlocked()
        await refuse()
        await ensureCaughtUp(epoch)
        const r = await profileExtraWrite((c) => member.choiceSet(c, { to, pick }))
        return { seq: r.seq }
      })({})
    },

    // The own live pick on a diary poll, from the own diary alone.
    'choice.mine': serial(({ to: rawTo }) => {
      const parsed = parseRef(rawTo)
      if (parsed === null || parsed.seq < 1) throw new UsageError('referência inválida')
      return withCores((c) => member.choiceMine(c, { to: { author: parsed.author.toLowerCase(), seq: parsed.seq } }))
    }),

    'top.set': async ({ keys: rawKeys }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const keys = rawKeys.map((k) => k.toLowerCase())
      if (new Set(keys).size !== keys.length) throw new UsageError('parâmetro inválido: keys')
      // A blocked key refuses only when it is new: one already in the list in
      // effect may stay (blocking someone listed must not lock every edit).
      // The page check runs on the new keys alone.
      const added = async (own, read) => {
        if (keys.includes(own)) throw new UsageError(TOP_SELF)
        const listed = new Set(await read((c) => member.ownTopKeys(c)))
        const fresh = keys.filter((k) => !listed.has(k))
        const blocked = await member.memberBlocks(storage)
        if (fresh.some((k) => blocked.has(k))) throw new UsageError(DM_BLOCKED)
        return fresh
      }
      const checked = await serial(async () => added(await requireUnlocked(), withCores))({})
      try {
        await refusePages(checked, TOP_PAGE)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serial(async (_, epoch) => {
        const fresh = await added(await requireUnlocked(), withCores)
        // The list moved since the page check: a key not checked then cannot
        // be ruled out now (the caller may retry).
        if (fresh.some((k) => !checked.includes(k))) throw toRpcError(new Error(SEEDER_UNAVAILABLE), reportInternal)
        await ensureCaughtUp(epoch)
        return profileExtraWrite((c) => member.topSet(c, { keys }))
      })({})
    },

    // Visitas (docs/rpc.md visits.*). The switch is a public `visits` record
    // in the own diary (published like profile.mood); turning it off first
    // empties the list and the pings not sent yet (needs no dm key), then
    // writes. Turning it on needs private messages enabled (a dm key). Mutual: pings go out and are filed only while it is on.
    'visits.set': async ({ on }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      return serial(async (_, epoch) => {
        await requireUnlocked()
        if (on === true && (await store.readDmKey(storage)) === null) throw new UsageError(VISITS_DMS_OFF)
        if (on !== true) await dmEngine.visitClear({ queue: true })
        await ensureCaughtUp(epoch)
        const current = await withCores((c) => member.visitsState(c))
        if (current.on !== (on === true)) await profileExtraWrite((c) => member.visitsSet(c, { on: on === true }))
        return { on: on === true }
      })({})
    },
    // sentToday: 0 while the dm keys are not installed (the log is sealed).
    'visits.state': serialDm(async () => {
      await requireUnlocked()
      const { on } = await withCores((c) => member.visitsState(c))
      const sentToday = dmEngine.unlocked() ? await dmEngine.visitSentToday(Date.now()) : 0
      return { on, sentToday }
    }),
    // Off (here or on another device of the same passkey): nothing is
    // listed and the stored list and queue are emptied. On: only the rows
    // dated from the day the switch last went on.
    'visits.list': serialDm(async () => {
      await requireUnlocked()
      const state = await withCores((c) => member.visitsState(c))
      if (state.on !== true) {
        await dmEngine.visitClear({ queue: true })
        return { visits: [] }
      }
      const since = visitSince(state)
      if (since === null) return { visits: [] }
      const own = await requireDm()
      return { visits: await dmEngine.visitList(own, Date.now(), { since, on: state.seq }) }
    }),
    'visits.clear': serial(async () => {
      await requireUnlocked()
      await dmEngine.visitClear({ queue: false })
      return { ok: true }
    }),

    // Aparelhos conectados (docs/rpc.md 5.152 to 5.155, member-ops). The
    // refusals and a hello with nothing to write are reads on the run's
    // cores; a write runs the write gate first (device.disconnect a bounded
    // group refresh before it). Never retried.
    'device.hello': serial(async ({ name }, epoch) => {
      await requireUnlocked()
      const quick = await withCores((c) => member.deviceHello(c, { name }, { write: false }))
      if (quick !== null) {
        noteDeviceOff(quick.off, epoch)
        feedDevice({ self: quick.id, off: quick.off })
        return quick
      }
      await ensureCaughtUp(epoch)
      const r = await deviceWrite((c) => member.deviceHello(c, { name }))
      noteDeviceOff(r.off, epoch)
      feedDevice({ self: r.id, off: r.off })
      return r
    }),
    'device.list': serial(async (_, epoch) => {
      await requireUnlocked()
      const r = await withCores((c) => member.deviceList(c))
      noteDeviceOff(r.off, epoch)
      feedDevice({ self: r.self, off: r.off })
      return r
    }),
    // The cuts need no group key; the rotation after them is best effort
    // and skipped without one.
    'device.disconnect': serial(async ({ id, previous }, epoch) => {
      await requireUnlocked()
      const params = { id: id === undefined ? null : id, previous: previous === true }
      const { pairs } = await withCores((c) => member.deviceDisconnect(c, params, { write: false }))
      groupWriting = true
      try {
        if (pairs > 0) await refreshGroupCores(epoch)
        await ensureCaughtUp(epoch)
        const r = await deviceWrite(async (c) => {
          if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
          const out = await member.deviceDisconnect(c, params)
          await noteWrittenRoots(out.groups)
          return out
        })
        for (const group of r.groups) send('groups.changed', { group }, epoch)
        return { cut: r.cut, empty: r.empty }
      } finally {
        groupWriting = false
        for (const pair of groupPairs) zeroPair(pair)
        groupPairs.clear()
      }
    }),
    'device.reconnect': serial(async ({ name }, epoch) => {
      await requireUnlocked()
      if (!keyFresh) throw new UsageError(RECONNECT_PASSKEY)
      await withCores((c) => member.deviceReconnect(c, { name }, { write: false }))
      await ensureCaughtUp(epoch)
      const r = await deviceWrite((c) => member.deviceReconnect(c, { name }))
      noteDeviceOff(false, epoch)
      return r
    }),
    // Queues a quiet ping to `key` only when the own switch is on, dms are
    // enabled, `key` is not self, a page or blocked, its own switch reads on
    // (visitTarget, off the chain) and the budgets allow; every check is
    // repeated on the chain before the queue. A ping that cannot go is
    // { queued: false }, never an error naming why.
    'visits.note': async ({ key: rawKey }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const key = rawKey.toLowerCase()
      const ident = identityTarget
      const check = async () => {
        const own = await requireDm()
        if (key === own || keyPair === null) return null
        if ((await store.readDmKey(storage)) === null) return null
        if ((await member.memberBlocks(storage)).has(key)) return null
        if (!(await withCores((c) => member.visitsState(c))).on) return null
        if (!(await dmEngine.visitAllowed(own, key, Date.now())).ok) return null
        return own
      }
      if ((await serialDm(check)({}, ident)) === null) return { queued: false }
      let box
      try {
        if (!(await visitTarget(key))) return { queued: false }
        box = (await dmLookupOf(key)).box
      } catch {
        return { queued: false }
      }
      if (typeof box !== 'string') return { queued: false }
      return serialDm(async () => {
        const own = await check()
        if (own === null) return { queued: false }
        return dmEngine.visitQueue(own, keyPair, { to: key, box, now: Date.now() })
      })({}, ident)
    },

    // Varandinha (docs/rpc.md 5.157 to 5.160). The game lives in public
    // records of the own diary, written like profile.mood and never retried;
    // a help is checked like scrap.write: the own checks on the chain, the
    // owner's balcony off it (gardenTarget, fail closed), then the checks
    // again and the write on the chain, so a help sent from another device
    // of the same passkey meanwhile is refused there.
    'garden.set': async ({ on }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      return serial(async (_, epoch) => {
        await requireUnlocked()
        await ensureCaughtUp(epoch)
        if (on === true) {
          const cur = await withCores((c) => member.gardenOwn(c, Date.now()))
          if (cur.on !== true) await profileExtraWrite((c) => member.gardenSet(c))
          return { on: true }
        }
        // A leave that finds nothing to do (null) writes and pushes nothing;
        // one cut short counts and pushes the blocks that landed (written).
        let r
        try {
          r = await withStore((c) => member.gardenLeave(c))
        } catch (err) {
          if (err !== null && typeof err === 'object' && Number.isSafeInteger(err.written)) {
            wrote(err.written)
            try { await pushAfterWrite() } catch {}
          }
          throw err
        }
        if (r !== null) {
          wrote(r.seq)
          await pushAfterWrite()
        }
        return { on: false }
      })({})
    },

    'groups.show': serial(async ({ on }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await profileExtraWrite((c) => member.groupsShow(c, { on }))
      if (r.changed === false) await pushAfterWrite()
      return r
    }),

    'search.show': serial(async ({ on }, epoch) => {
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await profileExtraWrite((c) => member.searchShow(c, { on }))
      if (r.changed === false) await pushAfterWrite()
      return r
    }),
    'search.state': serial(async () => {
      await requireUnlocked()
      return withCores((c) => member.searchState(c))
    }),

    // The own diary alone, as choice.mine: no key needed to read it. Unlocked,
    // a device that does not hold what the seeder holds for it (ownHeld)
    // first catches up as a write does: a copy behind another device of the
    // same passkey reads an empty or older balcony and invites a replant.
    'garden.state': serial(async (_, epoch) => {
      if (keyPair !== null && !ownHeld()) await ensureCaughtUp(epoch)
      return withCores((c) => member.gardenOwn(c, Date.now()))
    }),

    // Caught up first, so a second device of the same passkey plays on the
    // freshest state. Helps received are bounded generously (they live in
    // other diaries; readers fold them).
    'garden.play': async ({ acts }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      return serial(async (_, epoch) => {
        await requireUnlocked()
        await ensureCaughtUp(epoch)
        let state = null
        const r = await profileExtraWrite(async (c) => {
          const out = await member.gardenPlay(c, { acts, now: Date.now(), received: Array(garden.GARDEN_POTS).fill(garden.GARDEN_HELP_PER_POT) })
          state = out.state
          return out
        })
        return { seq: r.seq, ref: r.ref, state }
      })({})
    },

    'garden.help': async ({ to, pot }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const key = to.toLowerCase()
      const refuse = async (own) => {
        if (key === own) throw new UsageError(member.GARDEN_HELP_SELF)
        if ((await member.memberBlocks(storage)).has(key)) throw new UsageError(DM_BLOCKED)
      }
      const writer = await serial(async () => {
        const own = await requireUnlocked()
        await refuse(own)
        await withCores((c) => member.gardenHelpCheck(c, { to: key, writer: own, now: Date.now() }))
        return own
      })({})
      try {
        // No boosts in the pot check: the generous reading is the reader's.
        await gardenTarget(key, (index, r, now) => member.gardenTargetVerdict(index, r, pot, now))
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serial(async (_, epoch) => {
        await refuse(await requireUnlocked())
        await ensureCaughtUp(epoch)
        const r = await withStore((c) => member.gardenHelp(c, { to: key, pot, writer, now: Date.now() }))
        wrote(r.seq)
        await pushAfterWrite()
        return { seq: r.seq, ref: r.ref }
      })({})
    },

    // Enfeites and the Barraquinha (docs/rpc.md 5.162 to 5.166), hosted only
    // and never retried. A give is checked as a help, with the recipient's
    // open balcony as its evidence; a take reads the giver's block through
    // the sync run and no seeder index; a drop reads the own diary only.
    'garden.decor': async ({ items }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      return serial(async (_, epoch) => {
        await requireUnlocked()
        await ensureCaughtUp(epoch)
        let stored = null
        const r = await profileExtraWrite(async (c) => {
          const out = await member.gardenDecor(c, { items })
          stored = out.items
          return out
        })
        return { seq: r.seq, ref: r.ref, items: stored }
      })({})
    },

    // The own diary alone, caught up first as garden.state is: a copy behind
    // another device of the same passkey shows a stale stall and fresh
    // daily budgets that the next give or take would refuse.
    'garden.stall': serial(async (_, epoch) => {
      if (keyPair !== null && !ownHeld()) await ensureCaughtUp(epoch)
      return withCores((c) => member.gardenStallOwn(c, Date.now()))
    }),

    // Helps received are bounded as garden.play bounds them.
    'garden.give': async ({ to, pot }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const key = to.toLowerCase()
      const received = Array(garden.GARDEN_POTS).fill(garden.GARDEN_HELP_PER_POT)
      const refuse = async (own) => {
        if (key === own) throw new UsageError(member.GARDEN_GIFT_SELF)
        if ((await member.memberBlocks(storage)).has(key)) throw new UsageError(DM_BLOCKED)
      }
      const writer = await serial(async () => {
        const own = await requireUnlocked()
        await refuse(own)
        await withCores((c) => member.gardenGiveCheck(c, { to: key, pot, writer: own, now: Date.now(), received }))
        return own
      })({})
      try {
        await gardenTarget(key, (index, r, now) => member.gardenOpenVerdict(index, r, now))
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serial(async (_, epoch) => {
        await refuse(await requireUnlocked())
        await ensureCaughtUp(epoch)
        let state = null
        const r = await profileExtraWrite(async (c) => {
          const out = await member.gardenGive(c, { to: key, pot, writer, now: Date.now(), received })
          state = out.state
          return out
        })
        return { seq: r.seq, ref: r.ref, state }
      })({})
    },

    // As testimonial.show, with no seeder index read and no DM keys. Only an
    // answered peek proves a gift gone (a missing or deleted block is no
    // gift); a peek that fails says nothing about it, so it is unavailable
    // and nothing is written. A gift whose tombstone a copy of the giver's
    // diary held here carries is no gift, whatever the peek read
    // (heldGiftDeleted): the take goes on with none, so it is refused as gone
    // and a take already held still answers. RESIDUAL: a withdrawn gift whose
    // bytes the seeder still serves, of a giver not held here, passes; readers
    // holding the giver's diary drop such a take, and it costs the taker one
    // daily take.
    'garden.take': async ({ from, seq }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const key = from.toLowerCase()
      const refuse = async (own) => {
        if (key === own) throw new UsageError(member.GARDEN_GIFT_GONE)
        if ((await member.memberBlocks(storage)).has(key)) throw new UsageError(DM_BLOCKED)
      }
      await serial(async () => {
        await refuse(await requireUnlocked())
        const own = await withCores((c) => member.gardenOwn(c, Date.now()))
        if (own.on !== true) throw new UsageError(member.GARDEN_OFF_PLAY)
      })({})
      let record = null
      try {
        const r = await diaryPeek({ author: key, seqs: [seq] })
        const e = r.entries.find((x) => x.seq === seq)
        if (e !== undefined) record = e.record
      } catch (err) {
        const out = toRpcError(err, reportInternal)
        if (out.code === 'LOCKED') throw out
        throw rpcError('NOT_FOUND', SEEDER_UNAVAILABLE)
      }
      return serial(async (_, epoch) => {
        await refuse(await requireUnlocked())
        await ensureCaughtUp(epoch)
        if (record !== null && await heldGiftDeleted(key, seq)) record = null
        const r = await withStore((c) => member.gardenTake(c, { from: key, seq, record, now: Date.now() }))
        if (r.changed) {
          wrote(r.seq)
          await pushAfterWrite()
        }
        return { seq: r.seq, ref: r.ref, changed: r.changed }
      })({})
    },

    // The flag is not needed: a member can always take a mimo back.
    'garden.drop': async ({ kind, seq }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      return serial(async (_, epoch) => {
        await requireUnlocked()
        await ensureCaughtUp(epoch)
        const r = await withStore((c) => member.gardenDrop(c, { kind, seq }))
        wrote(r.seq)
        await pushAfterWrite()
        return { seq: r.seq, deleted: r.deleted }
      })({})
    },

    // Momentos (docs/rpc.md 5.113): the item must be one this node's
    // momentPutMedia answered in this unlock; published like post.create.
    // A published item is never offered for a second moment.
    'moment.create': serialDm(async ({ text, media, music }, epoch) => {
      await requireDm()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.momentCreate(c, { text, media, music, owned: (item) => dmEngine.isOwnPublicItem(item) }))
      dmEngine.forgetPublicItem(media)
      wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, ref: r.ref }
    }),

    // Local data only, works locked (as feed.read).
    'moments.read': serial(async () => withCores((c) => member.momentsRead(c, { now: Date.now() }))),

    // The momento a v5 reaction names, while it is showing (docs/rpc.md
    // 5.120): local data only, works locked. The record alone answers.
    'moment.lookup': serial(async ({ author, seq }) => withCores(async (c) => {
      // A read error propagates, so withCores can fall back (NEEDS_EXCLUSIVE)
      // instead of a live momento reading as gone.
      const shown = await member.momentLookup(c, { author, seq, now: Date.now() })
      if (shown === null) throw rpcError('NOT_FOUND', MOMENT_PHOTO_GONE)
      const { media, at } = shown
      return { mime: media.mime, w: media.w, h: media.h, ms: Number.isSafeInteger(media.ms) ? media.ms : 0, at }
    })),

    'moment.delete': serial(async ({ to }, epoch) => {
      const ref = parseRef(to)
      if (ref === null || ref.seq < 1) throw new UsageError('referência inválida')
      await requireUnlocked()
      await ensureCaughtUp(epoch)
      const r = await withStore((c) => member.momentDelete(c, { to: ref }))
      if (r.changed) wrote(r.seq)
      await pushAfterWrite()
      return { seq: r.seq, deleted: r.deleted }
    }),

    // Which of the refs the own diary likes / reposts; local data only,
    // works locked (as profile.read).
    'engagement.read': serial(async ({ refs }) => {
      const r = await withCores((c) => member.engagementRead(c, { refs }))
      return { liked: r.liked, reposted: r.reposted }
    }),

    // A key the member blocked reads as any unavailable diary, so every screen
    // built on this read (Busca, threads, quotes, profiles) drops it the same
    // way. profileOnly answers the name and @nome alone, for that key too: the
    // block can only be undone by a person the list can name.
    'diary.peek': async ({ profileOnly, thumbs, alt, ...params }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      let hidden
      try {
        hidden = (await member.memberBlocks(storage)).has(params.author.toLowerCase())
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      if (hidden && profileOnly !== true) throw rpcError('NOT_FOUND', DIARY_HIDDEN)
      let r
      try {
        r = await diaryPeekWithin(params, peekTimeoutMs, { cert: true, thumbs: thumbs === true && profileOnly !== true, alt: alt === true && profileOnly !== true })
      } catch (err) {
        // The unread flag is for internal readers, never the client.
        if (err !== null && typeof err === 'object') delete err.unread
        throw err
      }
      const certDate = hidden || typeof r.certDate !== 'string' ? null : r.certDate
      if (profileOnly === true) return { ...r, entries: [], invalid: [], missing: [], certDate }
      const answer = { ...r, certDate }
      if (alt === true) answer.entries = fitAlt(answer, 'entries', (e) => e.record.at)
      if (thumbs === true) answer.entries = fitThumbs(answer, 'entries', (e) => e.record.at)
      return answer
    },

    // The member's own block list (docs/rpc.md 5.111). The list is written
    // first, so the block holds even when the follow or the conversation step
    // fails: each only warns. Unlocked only, as follow.add. Nothing reaches the
    // other person: the unfollow is an ordinary follow record, and the
    // conversation op is sealed to the own box.
    'block.set': serialDm(async ({ key, on }, epoch) => {
      const own = await requireUnlocked()
      if (key === own) throw new UsageError('não é possível bloquear a própria chave')
      const r = applyBlock(await store.readMemberBlocks(storage), key, on, Math.floor(Date.now() / 1000))
      if (r.full) throw new UsageError('limite de bloqueios atingido')
      if (r.changed) {
        await store.writeMemberBlocks(storage, r.entries)
        seenChanged()
      }
      if (on && (await store.readFollows(storage)).includes(key)) {
        try {
          const f = await withStore((c) => member.followChange(c, key, false))
          if (f.changed) followChanged()
        } catch {
          warning('aviso: não deu para deixar de seguir quem você bloqueou', epoch)
        }
      }
      if (r.changed && dmEngine.unlocked()) {
        try {
          await dmEngine.set(own, keyPair, { peer: key, state: on ? 'blocked' : 'unblocked' })
        } catch {
          warning('aviso: bloqueio das mensagens ainda não enviado aos outros aparelhos', epoch)
        }
      }
      return { changed: r.changed, total: blockedKeys(r.entries).size }
    }),

    // kv only, works locked: the screens hide these keys at once.
    'block.list': serial(async () => ({ keys: [...await member.memberBlocks(storage)] })),

    // The applied moderation list's number and dates (docs/rpc.md 5.177):
    // kv only, works locked.
    'moderation.status': serial(async () => member.moderationStatus(storage, cfg.association)),
    // The member's own mute list (docs/rpc.md 5.178): kv only. It changes
    // what A Rua and Avisos show and nothing else: no follow, no message
    // state, nothing that reaches the other person. Unlocked only, as
    // block.set, so a signed-out browser cannot change the account's list.
    'mute.set': serial(async ({ key, on }) => {
      const own = await requireUnlocked()
      if (key === own) throw new UsageError('não é possível silenciar a própria chave')
      const r = applyMute(await store.readMemberMutes(storage), key, on, Math.floor(Date.now() / 1000))
      if (r.full) throw new UsageError('limite de pessoas silenciadas atingido')
      if (r.changed) {
        await store.writeMemberMutes(storage, r.entries)
        seenChanged()
      }
      return { changed: r.changed, total: mutedKeys(r.entries).size }
    }),

    // kv only, works locked, as block.list.
    'mute.list': serial(async () => ({ keys: [...await member.memberMutes(storage)] })),

    // Local-first, unlocked only (a change queued while signed out would be
    // signed into the diary at the next sign-in by whoever had the browser);
    // the diary write is the drain, scheduled and not awaited: its outcome
    // never fails this request.
    'follow.add': serial(async ({ key }) => {
      await requireUnlocked()
      if ((await member.memberBlocks(storage)).has(key)) throw new UsageError(DM_BLOCKED)
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
      // Folded over every held entry, before the window: an edit sits after
      // its post and may fall outside the page the post is in.
      const edits = editsOf(all)
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
        if (copy === null) {
          invalid.push({ seq, reason: validateRecord(record, seq) || 'malformed' })
          continue
        }
        const edit = copy.type === 'post' ? edits.get(seq) : undefined
        entries.push(edit === undefined ? { seq, record: copy } : { seq, record: edit.record, edited: true })
      }
      return { key: r.key, entries, invalid, entriesTruncated: start }
    }),

    // The own diary, paged for the data export (docs/rpc.md 5.180). Read like
    // log.read (withCores never preempts a run), stateless, works locked;
    // follows come from kv only, as follow.list.
    'export.read': serial(async ({ part, offset, until }) => {
      if (part === 'follows') {
        const { follows } = await member.followList(ctx())
        const page = exportFollowsPage(follows, offset, until)
        return { key: (await withCores((c) => member.exportBlocks(c))).key, head: null, follows: page.follows, entries: [], invalid: [], next: page.next }
      }
      const r = await withCores((c) => member.exportBlocks(c))
      if (part === 'diary') {
        const page = exportDiaryPage(r.entries, offset, until)
        return { key: r.key, head: null, follows: [], entries: page.entries, invalid: page.invalid, next: page.next }
      }
      const { follows } = await member.followList(ctx())
      const { head, next } = exportHead({
        association: cfg.association,
        length: r.length,
        entries: r.entries,
        follows,
        blocked: [...await member.memberBlocks(storage)],
        muted: [...await member.memberMutes(storage)]
      })
      return { key: r.key, head, follows: [], entries: [], invalid: [], next }
    }),

    'feed.read': serial(async ({ limit, before, thumbs, alt }) => {
      const r = await withCores((c) => member.feedRead(c, { limit, before: before === undefined ? null : before, thumbs: thumbs === true, alt: alt === true }))
      const skipped = capList(r.skipped)
      const future = capList(r.future)
      const incomplete = capList(r.incomplete, FEED_INCOMPLETE_MAX)
      const result = {
        items: r.items,
        skipped: skipped.list,
        skippedTruncated: skipped.truncated,
        future: future.list,
        futureTruncated: future.truncated,
        incomplete: incomplete.list,
        incompleteTruncated: incomplete.truncated
      }
      if (alt === true) result.items = fitAlt(result, 'items', (i) => i.at)
      if (thumbs === true) result.items = fitThumbs(result, 'items', (i) => i.at)
      return result
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
        const result = await p
        if (params.alt === true) result.items = fitAlt(result, 'items', (i) => i.at)
        return params.thumbs === true ? { ...result, items: fitThumbs(result, 'items', (i) => i.at) } : result
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

    // A standalone group (no `community`) touches no community root.
    'group.create': groupWrite(member.groupCreate, {
      roots: (params) => params.community === undefined ? [] : [params.community],
      changed: async (c, result, params) => params.community === undefined ? [result.group] : [result.group, params.community]
    }),
    'group.join': groupWrite(member.groupJoin),
    'group.leave': groupWrite(member.groupLeave),
    'group.post': groupWrite(member.groupPost),
    'group.read': serial((params) => {
      // A page's groups are private: no topics there.
      if (params.page !== undefined && (params.marks !== undefined || params.topic !== undefined)) throw new UsageError(FORUM_PUBLIC)
      if (params.page !== undefined) return pageGroupOp(member.pageGroupRead, params)
      return withCores((c) => member.groupRead(c, params))
    }),
    'group.seal': serialDm((params) => pageGroupOp(member.pageGroupSeal, params)),
    'group.seen': serial(async (params) => {
      const before = await store.readGroupSeen(storage)
      const r = await withCores((c) => member.groupSeen(c, params))
      if (!sameJson(before, await store.readGroupSeen(storage))) seenChanged()
      return r
    }),
    'group.list': serial((params) => withCores((c) => member.groupList(c, params))),
    'group.standalone': serial((params) => withCores((c) => member.groupStandalone(c, params))),
    'group.info': serial((params) => withCores((c) => member.groupInfo(c, params))),
    'group.members': serial((params) => withCores((c) => member.groupMembers(c, params))),
    'group.requests': serial((params) => withCores((c) => member.groupRequests(c, params))),
    'group.admit': groupWrite(member.groupAdmit, GROUP_AND_COMMUNITY),
    'group.ban': groupWrite(member.groupBan, GROUP_AND_COMMUNITY),
    'group.admin': groupWrite(member.groupAdmin),
    'group.hide': groupWrite(member.groupHide, GROUP_AND_COMMUNITY),
    'group.react': groupWrite(member.groupReact),
    'group.reactors': serial((params) => withCores((c) => member.groupReactors(c, params))),
    // Foruns e enquetes (docs/rpc.md): public groups only, so a page's
    // (private) groups list no topics.
    'group.choose': groupWrite(member.groupChoose),
    'group.topics': serial((params) => {
      if (params.page !== undefined) throw new UsageError(FORUM_PUBLIC)
      return withCores((c) => member.groupTopics(c, params))
    }),
    'group.voters': serial((params) => withCores((c) => member.groupVoters(c, params))),
    // Eventos (docs/rpc.md): public groups only, as the forum methods.
    'group.events': serial((params) => withCores((c) => member.groupEvents(c, params))),
    'group.meta': groupWrite(member.groupMeta),
    'group.image': groupWrite(member.groupImage),
    'group.about': groupWrite(member.groupAbout),
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
    'community.image': groupWrite(member.communityImage, {
      roots: (params) => [params.community],
      changed: async (c, result, params) => [params.community]
    }),
    'community.meta': groupWrite(member.communityMeta, {
      roots: (params) => [params.community],
      changed: async (c, result, params) => [params.community]
    }),
    'community.about': groupWrite(member.communityAbout, {
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

    'dm.enable': serialDm(async (_, epoch) => {
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

    // The account service's wake key for push notices (docs/rpc.md 5.167):
    // memory only, no identity needed; the next call replaces it.
    'dm.noticeKey': async ({ key }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      dmEngine.setNoticeKey(key)
      return {}
    },

    // The recipient's key is looked up first (off the chain), then the send
    // runs on the chain. A send for an identity without a published dm-key
    // runs dm.enable first.
    'dm.send': async ({ to, text, replyTo, media, card, fwd, moment }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const ident = identityTarget
      const fields = { to, text, fwd, card, replyTo: replyTo === undefined ? null : replyTo, media: media === undefined ? null : media, moment: moment === undefined ? null : moment }
      const momentShowing = async () => {
        if (moment !== undefined && (await withCores((c) => member.momentMedia(c, { author: to, seq: moment, now: Date.now() }))) === null) {
          throw new UsageError(MOMENT_NOT_FOUND)
        }
      }
      // Self and a blocked peer are refused before any lookup, and so is a
      // reaction to a momento of `to` not showing here: nothing signed or
      // stamped for it. Checked again on the chain right before a new send,
      // since the lookup awaits in between; a pending send (the user's
      // retry) re-puts its stamped drops without it.
      await serialDm(async () => {
        dmEngine.checkSend(await requireDm(), to)
        if ((await member.memberBlocks(storage)).has(to)) throw new UsageError(DM_BLOCKED)
        if (!dmEngine.sendPending(fields)) await momentShowing()
      })({}, ident)
      let recipient
      try {
        recipient = to === ownKey ? { box: null } : await dmLookupOf(to)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serialDm(async (_, epoch) => {
        const own = await requireDm()
        if ((await store.readDmKey(storage)) === null) await dmEnable(epoch)
        return dmEngine.send(own, keyPair, fields, recipient.box, { beforeNew: moment === undefined ? null : momentShowing })
      })({}, ident)
    },

    // A reaction travels as a message does (docs/rpc.md 5.119): the same
    // refusals, lookup and stamps as dm.send, to a person or a Página. A page
    // reacts with the page key: dm.pageDraft kind 'react', dm.pageSend.
    'dm.react': async ({ to, target, emoji }) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const ident = identityTarget
      await serialDm(async () => {
        dmEngine.checkSend(await requireDm(), to)
        if ((await member.memberBlocks(storage)).has(to)) throw new UsageError(DM_BLOCKED)
      })({}, ident)
      let recipient
      try {
        recipient = await dmLookupOf(to)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
      return serialDm(async (_, epoch) => {
        const own = await requireDm()
        if ((await store.readDmKey(storage)) === null) await dmEnable(epoch)
        return dmEngine.react(own, keyPair, { to, target, emoji }, recipient.box)
      })({}, ident)
    },

    // Not on the chain: it reads the pool over its own link and writes only
    // kv and the local store (one pull at a time, in the engine: a second
    // one waits for the pull in flight and gets its answer).
    'dm.pull': async () => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const ident = identityTarget
      const own = await dmIdentity({}, ident)
      try {
        return await withDmReady(ident, () => dmEngine.pull(own))
      } catch (err) {
        throw toRpcError(err, reportInternal)
      } finally {
        checkPageKeys().catch(noop)
        visitPull(own, ident)
      }
    },

    // With `page` (5.114) the page's conversations, held under its secrets;
    // the member's own blocks do not apply to them.
    'dm.list': serialDmList(async (params) => {
      const r = await dmEngine.list(await requireDmKey(), params, { wait: false })
      return r === null ? DM_LIST_MISS : r
    }),
    'dm.thread': serialDm(async (params) => {
      const r = await dmEngine.thread(await requireDm(), params)
      if (params.page !== undefined) return r
      return (await member.memberBlocks(storage)).has(params.peer) ? { ...r, blocked: true } : r
    }),
    // A page's ops are signed by the page key: dm.pageDraft, dm.pageSend.
    'dm.set': serialDm(async ({ peer, state, page }) => {
      if (page !== undefined) throw new UsageError(DM_USE_PAGE_DRAFT)
      return dmEngine.set(await requireDm(), keyPair, { peer, state })
    }),
    'dm.seen': serialDm(async ({ peer, page, upTo }) => {
      const own = await requireDm()
      if (page !== undefined) return dmEngine.seen(own, peer, page, upTo)
      const before = await store.readDmSeen(storage)
      const r = await dmEngine.seen(own, peer, undefined, upTo)
      if (!sameJson(before, await store.readDmSeen(storage))) seenChanged()
      return r
    }),

    // ---- Páginas de ponta a ponta (docs/rpc.md 5.114) ----

    'dm.pageGenerate': serialDm(async (params) => {
      const own = await requireDm()
      return dmEngine.pageGenerate(own, keyPair, params)
    }),
    'dm.pageShare': serialDm(async (params) => {
      await requireDm()
      return dmEngine.pageShare(keyPair, params)
    }),
    // The sharer must be the owner or an admin of the page's current roster,
    // read as page.read reads it (off the chain: a peek may wait for the run).
    // The roster is read first, never from inside the engine's tracked
    // operation: a reset waits for those, and page.read queues on the chain.
    'dm.pageSecrets': async (params) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const ident = identityTarget
      const own = await dmIdentity({}, ident)
      let roster
      try {
        const r = await handlers['page.read']({ key: params.page, full: true })
        roster = { owner: r.owner, admins: r.admins }
      } catch (err) {
        if (err && err.code === 'NOT_FOUND') throw rpcError('USAGE', DM_KEY_MISMATCH)
        throw err
      }
      try {
        return await withDmReady(ident, () => dmEngine.pageSecrets(own, roster, params))
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
    },
    // The recipient's key is looked up off the chain first, as dm.send's.
    // Its media and card are dm.send's: items put with dmPutMedia for `to`
    // and this `page`, their blobs acked with this identity's stamps before
    // the digest is answered.
    // A page's reaction (kind 'react', or a msg with `moment`) is drafted the
    // same way; a momento reaction needs that momento of `to` showing here.
    'dm.pageDraft': async (params) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const ident = identityTarget
      await dmIdentity({}, ident)
      if (params.moment !== undefined) {
        let shown
        try {
          shown = await serial(() => withCores((c) => member.momentMedia(c, { author: params.to, seq: params.moment, now: Date.now() })))({})
        } catch (err) {
          throw toRpcError(err, reportInternal)
        }
        if (shown === null) throw rpcError('USAGE', MOMENT_NOT_FOUND)
      }
      let box = null
      if (params.kind !== 'ctl' && params.to !== undefined && params.to !== params.page) {
        try {
          box = (await dmLookupOf(params.to)).box
        } catch (err) {
          throw toRpcError(err, reportInternal)
        }
      }
      return serialDm(async () => {
        await requireDm()
        return dmEngine.pageDraft(params, box, keyPair)
      })({}, ident)
    },
    'dm.pageSend': serialDm(async (params) => {
      await requireDm()
      return dmEngine.pageSend(params)
    }),
    // The legacy bundle (5.114) is imported after adoption: a held page only.
    // The page it moved from (a bundle carried over on a move names it) is
    // read first, off the engine's tracked operation, as dm.pageSecrets reads
    // the roster.
    'dm.pageLegacyChunk': async (params) => {
      if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
      const ident = identityTarget
      await dmIdentity({}, ident)
      // The chain of verified page-origin records, newest first.
      const movedFrom = []
      let at = typeof params.page === 'string' ? params.page : null
      while (at !== null && movedFrom.length < PAGE_MOVE_HOPS_MAX) {
        let r
        try {
          r = await handlers['page.read']({ key: at })
        } catch (err) {
          if (err && err.code === 'NOT_FOUND') break
          throw err
        }
        const from = r.movedFrom === null ? null : r.movedFrom.from
        if (from === null || from === params.page || movedFrom.includes(from)) break
        movedFrom.push(from)
        at = from
      }
      return serialDm(async () => {
        await requireDm()
        return dmEngine.pageLegacyChunk(params, movedFrom)
      })({}, ident)
    },
    'dm.pageLegacyBlocks': serialDm(async (params) => {
      await requireDm()
      return dmEngine.pageLegacyBlocks(params)
    }),
    'dm.pageForget': serialDm(async (params) => {
      await requireDm()
      return dmEngine.pageForget(params)
    }),

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

    'sync.start': serial(async ({ once, timeoutMs, groups }, epoch) => {
      if (groups === false && once !== true) throw rpcError('USAGE', 'groups: false só com once')
      const gone = () => epoch !== connection
      if (gone()) throw rpcError('USAGE', 'conexão encerrada')
      if (run !== null) throw rpcError('USAGE', 'sincronização já em andamento')
      const { publicKey } = await identity()
      if (gone()) throw rpcError('USAGE', 'conexão encerrada')
      if (publicKey === null) throw rpcError('NOT_FOUND', 'identidade não encontrada')
      if (run !== null) throw rpcError('USAGE', 'sincronização já em andamento')
      syncIntent = once ? null : 'continuous'
      seederDownAt = null
      kickLease() // an explicit start ignores the lease's gap
      const { runId } = startRun({ once, timeoutMs, groups })
      return { runId }
    }),

    'sync.stop': serial(async () => {
      syncStops++
      syncIntent = null
      seederDownAt = null
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

  // group.read with a page needs the dm keys (pageGroupOp); its own read
  // queues at once.
  handlers['group.read'] = afterDmUnlock(handlers['group.read'], (params) => params.page !== undefined)

  // A one-shot run reads its page roots once, at its start (heldPageRoots),
  // and restartForHeldRoots never restarts it for roots found later, so it
  // waits for a pending store unlock: the held pages' groups are then in it.
  // A continuous run starts at once and is restarted instead.
  // A stop or a disconnect while it waits cancels it: the start was asked
  // for before them, and running it afterwards would undo the stop.
  const syncStartNow = handlers['sync.start']
  handlers['sync.start'] = (params, ...rest) => {
    if (dmUnlocking === null || !(params && params.once === true)) return syncStartNow(params, ...rest)
    const epoch = connection
    const stops = syncStops
    return (async () => {
      for (let p = dmUnlocking; p !== null; p = dmUnlocking) await p
      if (epoch !== connection) throw rpcError('USAGE', 'conexão encerrada')
      if (stops !== syncStops) throw rpcError('USAGE', 'sincronização interrompida')
      return syncStartNow(params, ...rest)
    })()
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
    groupMemo.clear()
    noticer.abort()
    noticing = null
    noticeCtxCache = null
    zeroPair(keyPair)
    keyPair = null
    ownCaught = null
    keyFresh = false
    deviceOffSent = false
    deviceCheckLength = null
    zeroPair(mediaKeyPair)
    mediaKeyPair = null
    if (groupPrf !== null) groupPrf.fill(0)
    groupPrf = null
    outboxGen++
    if (outboxKey !== null) outboxKey.fill(0)
    outboxKey = null
    boxKeys.lock()
    dmEngine.lock()
    pageGroupKeys.lock()
    remotePageRoots.clear()
    seenSync.forget()
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
    drainRefusals = 0
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
  // `fresh: true` says the host ran a passkey ceremony for this unlock (not
  // a kept session); only then may device.reconnect register this device.
  // All are copied synchronously (the caller may zero its buffers right
  // away); any previous pair and PRF are
  // zero-filled. The cached identity is forgotten so a stored diary of
  // another key surfaces on the next operation as USAGE 'passkey não
  // corresponde ao diário guardado'. Nothing is written here; the follow
  // drain is scheduled right after.
  function setKeyPair (pair, { media, prf, fresh = false } = {}) {
    const copy = copyPair(pair)
    let mediaCopy = null
    let prfCopy = null
    let dmPrf = null
    try {
      if (prf !== undefined && prf !== null) {
        prfCopy = copyKey(prf, 32)
        dmPrf = copyKey(prf, 32)
      }
      if (media !== undefined && media !== null) mediaCopy = copyPair(media)
    } catch (err) {
      zeroPair(copy)
      zeroPair(mediaCopy)
      if (prfCopy !== null) prfCopy.fill(0)
      if (dmPrf !== null) dmPrf.fill(0)
      throw err
    }
    cancelGroups()
    // The same key again (a new PRF read) keeps the requests issued for it.
    const before = identityTarget
    retarget(b4a.toString(copy.publicKey, 'hex'))
    const ident = identityTarget
    const sameKey = ident === before
    const dm = supersedeDmUnlock()
    // The DM store unlock, once started, owns dmPrf; until then it is
    // dropped here (with the wait released) on any way out.
    let started = false
    const dropDm = () => {
      if (started) return
      started = true
      if (dmPrf !== null) dmPrf.fill(0)
      dm.release()
    }
    return identityChange(() => serial(async () => {
      // A peek in flight belongs to the previous identity.
      peeker.abort()
      peeking = null
      noticer.abort()
      noticing = null
      // A dm engine call issued ahead of a new PRF read of the same key ends
      // first; another key locks at once, as a lock does. The wait runs on
      // the chain: a slow pull or putMedia holds this re-read and every
      // request behind it until the call ends (bounded by the call's link
      // timeouts), the trade-off chosen so the call ends instead of answering
      // locked. A lock, a reset, another key or close() ends the wait.
      if (sameKey && dmCalls.size > 0) await dmCallsDone(ident)
      zeroKeyPair()
      // The lock above stops a previous unlock still under way; it settles
      // before this one may start, so its own lock never meets this unlock.
      await dm.previous
      keyPair = copy
      keyFresh = fresh === true
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
      phoneVerifiedDate = null
      phoneSinceDate = null
      phoneChecked = false
      if (prfCopy !== null) {
        // Without the box pair private groups read as locked; the identity
        // itself is unlocked either way.
        try {
          await boxKeys.unlock(storage, prfCopy)
        } catch (err) {
          if (!(err instanceof UsageError)) reportInternal(err)
        }
      }
      followChanged()
      // A live continuous run reported its own length while locked and will
      // not report it again.
      if (run !== null && !run.once && !run.internal && Number.isSafeInteger(run.ownLength)) armUpkeep(run.ownLength)
      if (dmPrf !== null) {
        // The DM store reads and opens every local row: on the next turn,
        // after this entry returns, while the DM requests wait for it.
        started = true
        const gen = dm.gen
        setTimeout(() => { runDmUnlock(gen, dmPrf, dm.keyed).finally(dm.release) }, 0)
      }
    })().finally(dropDm), { abort: true }).catch((err) => {
      dropDm()
      zeroPair(copy)
      zeroPair(mediaCopy)
      if (prfCopy !== null) prfCopy.fill(0)
      throw err
    })
  }

  // Every identity change: a pending DM unlock becomes a no-op, and a new
  // wait (the one DM requests now see) starts, released by the caller once
  // its own unlock settles or it has none. -> { gen, previous, release }:
  // previous settles with the superseded unlock (never rejects). A wait
  // also covers the one before it, so no unlock ever overlaps an older one,
  // even behind a change that failed before awaiting its previous.
  // keyed releases the dmKeying part early (release releases both).
  function supersedeDmUnlock () {
    const gen = ++dmUnlockGen
    const previous = dmUnlocking === null ? Promise.resolve() : dmUnlocking
    let full
    let keyed
    const unlocking = Promise.all([new Promise((resolve) => { full = resolve }), previous]).then(() => {
      if (dmUnlocking === unlocking) dmUnlocking = null
    })
    const keying = Promise.all([new Promise((resolve) => { keyed = resolve }), previous]).then(() => {
      if (dmKeying === keying) dmKeying = null
    })
    dmUnlocking = unlocking
    dmKeying = keying
    const release = () => {
      keyed()
      full()
    }
    return { gen, previous, release, keyed: () => keyed() }
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
  // A short video (the second item of a post's [JPEG poster, video] pair) is
  // { bytes, mime: 'video/mp4', width, height, ms, kind: 'video' }, never
  // sealed (videoUpload) -> a video descriptor.
  function mediaUpload ({ bytes, mime, width, height, ms, kind, sealed = false, onProgress } = {}) {
    if (sealed !== true && sealed !== false) throw new TypeError(BAD_MEDIA_ARGS)
    if (kind === 'video' || mime === VIDEO_MIME) return videoUpload({ bytes, mime, width, height, ms, kind, sealed, onProgress })
    if (kind !== undefined || mime === AUDIO_MIME) return voiceUpload({ bytes, mime, width, height, ms, kind, sealed, onProgress })
    const maxBytes = sealed ? MAX_SEALED_MEDIA_PLAIN_BYTES : MAX_MEDIA_ITEM_BYTES
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw new TypeError(BAD_MEDIA_ARGS)
    if (typeof mime !== 'string' || !MEDIA_MIMES.includes(mime)) throw new TypeError(BAD_MEDIA_ARGS)
    if (!isIntIn(width, 1, MAX_MEDIA_DIMENSION) || !isIntIn(height, 1, MAX_MEDIA_DIMENSION)) throw new TypeError(BAD_MEDIA_ARGS)
    // The node checks every photo is the image it claims before storing it
    // (readers check again): nobody but a member can look inside a sealed
    // one, and a public one goes to every reader of the diary or the group.
    if (mediaBounds(bytes, mime) === null) throw new TypeError(BAD_MEDIA_ARGS)
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
      const descriptor = await storeMedia(epoch, (c) => member.mediaCommit(c, { blocks, mime, width, height, sha256 }))
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
      const descriptor = await storeMedia(epoch, (c) => member.mediaCommitAudio(c, { blocks, sha256, ms }))
      progress(0.75)
      progress(1)
      return descriptor
    })({})
  }

  // -> { copy, ms } for a short video, or null: copy is the stripped copy
  // (no place, time or device tags) and ms its samples' duration. The
  // sender's own file may still carry its metadata, so only the pre-check
  // tolerates it; the copy must pass the strict check every reader makes.
  // The caller's sides must be the container's display size and its ms
  // within VIDEO_MS_TOLERANCE of it: what gets stored is the container's.
  // Synchronous, so the caller's buffer cannot change under it.
  function videoArgs ({ bytes, mime, width, height, ms, kind }, maxBytes, maxMs) {
    if (!(kind === 'video' && mime === VIDEO_MIME && isIntIn(ms, 1, maxMs) &&
      bytes instanceof Uint8Array && bytes.byteLength >= 1 && bytes.byteLength <= maxBytes)) return null
    const given = videoBounds(bytes, { maxMs, metadata: true })
    if (given === null || given.width !== width || given.height !== height || Math.abs(ms - given.ms) > VIDEO_MS_TOLERANCE) return null
    const copy = stripVideoMetadata(bytes)
    const strict = copy === null ? null : videoBounds(copy, { maxMs })
    if (strict === null || strict.width !== width || strict.height !== height || strict.ms !== given.ms) {
      if (copy !== null) copy.fill(0)
      return null
    }
    return { copy, ms: strict.ms }
  }

  // mediaUpload's short video path (a post's [poster, video] pair), on the
  // same chain and gate. What is hashed and stored is the stripped copy. A
  // video is never sealed: private groups take none.
  function videoUpload ({ bytes, mime, width, height, ms: given, kind, sealed, onProgress }) {
    if (sealed) throw new TypeError(BAD_MEDIA_ARGS)
    const video = videoArgs({ bytes, mime, width, height, ms: given, kind }, MAX_MEDIA_ITEM_BYTES, MAX_VIDEO_MS)
    if (video === null) throw new TypeError(BAD_MEDIA_ARGS)
    const { copy, ms } = video
    const progress = typeof onProgress === 'function' ? (fraction) => { try { onProgress(fraction) } catch {} } : noop
    return serial(async (_, epoch) => {
      await requireUnlocked()
      if (mediaKeyPair === null) throw new UsageError(store.LOCKED)
      if (!(await identity()).memberCert) throw new Error(member.GENESIS_REQUIRED)
      const subtle = globalThis.crypto && globalThis.crypto.subtle
      if (!subtle) throw new Error('WebCrypto indisponível')
      const sha256 = b4a.toString(new Uint8Array(await subtle.digest('SHA-256', copy)), 'hex')
      progress(0.25)
      const blocks = []
      for (let at = 0; at < copy.byteLength; at += MEDIA_BLOCK_BYTES) {
        blocks.push(copy.subarray(at, Math.min(copy.byteLength, at + MEDIA_BLOCK_BYTES)))
      }
      const descriptor = await storeMedia(epoch, (c) => member.mediaCommitVideo(c, { blocks, sha256, width, height, ms }))
      progress(0.75)
      progress(1)
      return descriptor
    })({})
  }

  // On mediaUpload's chain: readies this device's media core, declares it
  // the first time, then stores the item with commit(ctx). Declared BEFORE
  // storing: a declaration the gate refuses (seeder unreachable) rejects
  // with nothing appended, so a retry never fills the fixed-size core with
  // another copy of the item. A core too full for the item (MEDIA_FULL)
  // rotates once to a new core (rotateMediaCore) and the item goes there,
  // decided on a caught-up diary so another device's newer declaration
  // counts: a rotation never pushes a declared core out of the latest set.
  async function storeMedia (epoch, commit) {
    for (let rotated = false; ;) {
      const { core, declared } = await withStore((c) => member.mediaPrepare(c))
      if (!declared) {
        await ensureCaughtUp(epoch)
        const { seq } = await withStore((c) => member.declareMediaCore(c, core))
        wrote(seq)
        await pushAfterWrite()
      }
      try {
        return await withStore(commit)
      } catch (err) {
        if (rotated || !isMediaFull(err)) throw err
        await ensureCaughtUp(epoch)
        const { room } = await withStore((c) => member.mediaPrepare(c))
        if (!room) throw err
      }
      await rotateMediaCore()
      rotated = true
    }
  }

  function isMediaFull (err) {
    return err instanceof UsageError && err.message === store.MEDIA_FULL
  }

  // A new media core for this device (#129): a fresh nonce in kv
  // mediaDevice and the pair it derives from the passkey PRF, the same
  // derivation the page runs at unlock, so the next unlock opens the new
  // core. The full core stays in kv mediaCores, declared and readable.
  // Without the PRF (a host that never handed it in) the core stays full.
  // A lock while it derives drops the new pair.
  async function rotateMediaCore () {
    const prf = groupPrf
    const old = mediaKeyPair
    if (prf === null || old === null) throw new UsageError(store.MEDIA_FULL)
    const nonce = crypto.randomBytes(32)
    const pair = await mediaKeyPairFromPrf(prf, nonce, { hkdf })
    const live = () => mediaKeyPair === old && groupPrf === prf
    if (!live()) {
      zeroPair(pair)
      throw new UsageError(store.LOCKED)
    }
    try {
      await withStore((c) => store.writeMediaDevice(c.storage, b4a.toString(nonce, 'hex')))
    } catch (err) {
      zeroPair(pair)
      throw err
    }
    if (!live()) {
      zeroPair(pair)
      throw new UsageError(store.LOCKED)
    }
    zeroPair(old)
    mediaKeyPair = pair
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
    const item = await storeMedia(epoch, (c) => member.mediaCommitSealed(c, sealedItem))
    progress(0.75)
    progress(1)
    return item
  }

  // A Página's photo or voice note for one of its private groups (docs/rpc.md
  // 5.114): checked and copied synchronously as mediaUpload's sealed path
  // (TypeError), then sealed under a fresh key -> { cipher, item }. cipher
  // is the whole blocks the app sends with the page `media` action (op
  // `group`); item is the private item without the core and start the
  // service answers. Nothing is stored here and nothing about the bytes is
  // logged. Needs the page's secrets held, as group.seal: only a device that
  // can seal the post gets the item key, which leaves the node only in item.
  // No video: private groups take none.
  function pageSealMedia ({ page, bytes, mime, width, height, ms, kind } = {}) {
    if (typeof page !== 'string' || !/^[0-9a-f]{64}$/.test(page)) throw new TypeError(BAD_MEDIA_ARGS)
    if (kind === 'video' || mime === VIDEO_MIME) throw new TypeError(BAD_MEDIA_ARGS)
    let copy
    if (kind !== undefined || mime === AUDIO_MIME) {
      ms = voiceArgsMs({ bytes, mime, width, height, ms, kind })
      // Sealed without its recording time or device tags.
      copy = ms === null ? null : stripAudioMetadata(bytes)
      if (copy === null) throw new TypeError(BAD_MEDIA_ARGS)
      width = 0
      height = 0
    } else {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_SEALED_MEDIA_PLAIN_BYTES) throw new TypeError(BAD_MEDIA_ARGS)
      if (typeof mime !== 'string' || !MEDIA_MIMES.includes(mime)) throw new TypeError(BAD_MEDIA_ARGS)
      if (!isIntIn(width, 1, MAX_MEDIA_DIMENSION) || !isIntIn(height, 1, MAX_MEDIA_DIMENSION)) throw new TypeError(BAD_MEDIA_ARGS)
      // Nobody but a member can look inside a sealed photo: checked here.
      if (mediaBounds(bytes, mime) === null) throw new TypeError(BAD_MEDIA_ARGS)
      copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      ms = 0
    }
    return (async () => {
      try {
        return await pageSealRun({ page: page.toLowerCase(), copy, mime, width, height, ms })
      } finally {
        copy.fill(0)
      }
    })()
  }

  const pageSealRun = serialDm(async ({ page, copy, mime, width, height, ms }) => {
    await requireDm()
    if (!pageGroupKeys.holds(page)) throw new UsageError(NO_PAGE_KEY)
    return sealMedia(copy, { plainMime: mime, w: width, h: height, ms })
  })

  // A chat photo for dm.send (docs/rpc.md 5.88): validated and copied
  // synchronously (TypeError), then off the chain, as dm.pull (it opens no
  // storage core): sealed and put on the anonymous blob channel by the dm
  // engine -> the media item. The native IPC dm.putMedia reads its cache
  // file and calls this same function. Nothing about the bytes is logged.
  // A voice note is { bytes, mime: 'audio/mp4', width: 0, height: 0, ms,
  // kind: 'voice' }, checked with audioBounds. `to`, the destination's diary
  // key, is required: it keeps the same photo for two conversations in two
  // blobs, and dm.send refuses the item for any other destination (5.97).
  // `page`, optional: the Página the item is put for, whose secrets this
  // node must hold (as dm.pageDraft's); its draft refuses an item put
  // without it, and dm.send one put with it.
  function dmPutMedia ({ bytes, mime, width, height, ms, kind, to, page } = {}) {
    if (typeof to !== 'string' || !/^[0-9a-f]{64}$/.test(to)) throw new TypeError(BAD_MEDIA_ARGS)
    if (page !== undefined && (typeof page !== 'string' || !/^[0-9a-f]{64}$/.test(page))) throw new TypeError(BAD_MEDIA_ARGS)
    const voice = kind !== undefined || mime === AUDIO_MIME
    const dest = page === undefined ? { to } : { to, page }
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
        const ident = identityTarget
        const own = await dmIdentity({}, ident)
        // The pair is read in the tick the engine call starts: an identity
        // change zero-fills the one it replaces.
        return await withDmReady(ident, () => {
          const pair = keyPair
          if (pair === null) throw new UsageError(store.LOCKED)
          return dmEngine.putMedia(own, pair, voice ? { bytes: copy, mime, width: 0, height: 0, ms, ...dest } : { bytes: copy, mime, width, height, ...dest })
        })
      } catch (err) {
        copy.fill(0)
        throw toRpcError(err, reportInternal)
      }
    })()
  }

  // A momento's photo (docs/rpc.md 5.113): validated and copied
  // synchronously (TypeError), the caller's buffer wiped, then sealed into a
  // FRESH blob and put on the anonymous blob channel by the dm engine (the
  // stamps need the DM key) -> the moment media item. The native IPC
  // moment.putMedia reads its cache file and calls this same function.
  // Nothing about the bytes is logged. A short video is { bytes, mime:
  // 'video/mp4', width, height, ms, kind: 'video' }, checked as mediaUpload
  // checks a post's (videoArgs) with a momento's bounds: what is sealed is
  // the stripped copy. `ahead: true` (a Página's momento) uploads only with
  // stamps already in the wallet, else starts a fill and refuses 'envio em
  // preparo' (dm.js putPublicMedia).
  function momentPutMedia ({ bytes, mime, width, height, ms, kind, ahead } = {}) {
    if (ahead !== undefined && ahead !== true) throw new TypeError(BAD_MEDIA_ARGS)
    let copy
    let video = null
    if (kind === 'video' || mime === VIDEO_MIME) {
      video = videoArgs({ bytes, mime, width, height, ms, kind }, MAX_MOMENT_VIDEO_BYTES, MAX_MOMENT_VIDEO_MS)
      if (video === null) throw new TypeError(BAD_MEDIA_ARGS)
      copy = video.copy
    } else {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_MEDIA_ITEM_BYTES) throw new TypeError(BAD_MEDIA_ARGS)
      if (typeof mime !== 'string' || !MEDIA_MIMES.includes(mime)) throw new TypeError(BAD_MEDIA_ARGS)
      if (!isIntIn(width, 1, MAX_MEDIA_DIMENSION) || !isIntIn(height, 1, MAX_MEDIA_DIMENSION)) throw new TypeError(BAD_MEDIA_ARGS)
      copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
    }
    bytes.fill(0)
    return (async () => {
      try {
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        const ident = identityTarget
        const own = await dmIdentity({}, ident)
        return await withDmReady(ident, () => {
          const pair = keyPair
          if (pair === null) throw new UsageError(store.LOCKED)
          const opt = ahead === true ? { ahead } : {}
          return dmEngine.putPublicMedia(own, pair, video !== null ? { bytes: copy, mime, width, height, ms: video.ms, ...opt } : { bytes: copy, mime, width, height, ...opt })
        })
      } catch (err) {
        copy.fill(0)
        throw toRpcError(err, reportInternal)
      }
    })()
  }

  // The photo or video of the showing moment author:seq -> { bytes, mime, w,
  // h } (and ms for a video), for the page only (never over RPC). The record
  // is read on the chain from
  // local data; the blob is fetched off it (the public key and nonce of the
  // record open it, no DM key needed). Gone, expired or not verifying:
  // NOT_FOUND 'foto indisponível'.
  function momentReadMedia ({ author, seq } = {}) {
    if (typeof author !== 'string' || !HEX64.test(author) || !Number.isSafeInteger(seq) || seq < 1) throw new TypeError(BAD_MEDIA_ARGS)
    const key = author.toLowerCase()
    return (async () => {
      try {
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        const item = await serial(() => withCores((c) => member.momentMedia(c, { author: key, seq, now: Date.now() })))({})
        if (item === null) throw new Error(MOMENT_PHOTO_GONE)
        return await dmEngine.readPublicMedia(item)
      } catch (err) {
        throw toRpcError(err, reportInternal)
      }
    })()
  }

  // The plaintext of item `index` of a kept message -> { bytes, mime }, for
  // the page only (never over RPC: a photo is far above MAX_MESSAGE). page:
  // a message of that Página's conversations held on this device.
  function dmReadMedia ({ from, id, index, page } = {}) {
    return (async () => {
      try {
        if (closed) throw rpcError('LOCKED', CLOSED_MESSAGE)
        const ident = identityTarget
        const own = await dmIdentity({}, ident)
        return await withDmReady(ident, () => dmEngine.readMedia(own, { from, id, index, page }))
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

  // Locks the identity: the pair is zero-filled and, unless keepMedia, the
  // chat media cache deleted (lock and 'Sair' both come here). After close()
  // it already is.
  // keepMedia (a lock, never a sign-out or a failed unlock): the opened
  // direct message media and the list summaries stay, sealed under keys
  // derived from the local key, which an unlock under another key wipes.
  function clearKeyPair ({ keepMedia = false } = {}) {
    if (closing !== null) return closing.then(noop)
    cancelGroups()
    retarget(null)
    const dm = supersedeDmUnlock()
    return identityChange(() => serial(async () => {
      zeroKeyPair()
      // A pending DM unlock was stopped by the lock above; it settles before
      // the cache goes and before any later unlock starts.
      await dm.previous
      if (keepMedia === true) return
      // The identity is locked already; a storage failure while wiping the
      // media cache must not turn the lock into an error (the next unlock
      // under another key wipes it again).
      try {
        await dmEngine.wipeMedia()
      } catch {
        warning('aviso: cache de mídia não apagado')
      }
    })().finally(dm.release))
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
  // previous: the DM unlock this reset superseded (supersedeDmUnlock).
  const resetChain = serial(async ({ previous }) => {
    peeker.abort()
    peeking = null
    noticer.abort()
    noticing = null
    syncIntent = null
    seederDownAt = null
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
    phoneVerifiedDate = null
    phoneSinceDate = null
    phoneChecked = false
    await storage.deleteCore(store.DIARY)
    store.forgetLegacy(storage)
    await store.deleteMediaCores(storage)
    await store.deleteGroupData(storage)
    await store.writeFollowsPending(storage, [])
    await store.clearFollowsMigrated(storage)
    await store.writeMemberBlocks(storage, [])
    await store.writeMemberMutes(storage, [])
    await store.clearTestimonialDecisions(storage)
    await store.clearDeviceId(storage)
    await store.clearMomentSeen(storage)
    testimonialDead.clear()
    zeroKeyPair()
    // A superseded DM unlock (stopped by the lock above) settles before its
    // store goes, as a pull, send or top-up still unwinding.
    await previous
    await dmEngine.idle()
    await dmEngine.dropPageSummaries()
    await store.deleteDmData(storage)
    await dmEngine.visitClear({ all: true })
    await dmEngine.wipeMedia()
    await store.deleteAgeProofs(storage)
    await store.deletePhoneProofs(storage)
    ownKey = null
    diaryInfo = null
    synced = false
    unpushed = true
    localLength = null
    localEchoed = null
    ownReported = null
    groupUnpushed.clear()
    groupLengths.clear()
    drainWanted = false
    drainRetries = 0
    drainRefusals = 0
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
    seederDownAt = null
    // The next connection's first own-synced arms afresh.
    resetUpkeep()
    // The reader starts over with no lengths: the first own-synced it gets
    // must say again whether that length was written here.
    localEchoed = null
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
    // A same-key setKeyPair waiting for a dm call goes on to lock the engine
    // now, so that call meets the lock instead of holding the close.
    wakeDmWaits()
    syncIntent = null
    seederDownAt = null
    resetUpkeep()
    if (seenChangedTimer !== null) clearTimeout(seenChangedTimer)
    seenChangedTimer = null
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
      pageGroupKeys.close()
      groupMemo.clear()
      // A pending DM unlock (a no-op once closed) settles before the engine
      // closes.
      await dmReady()
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
    pageSealMedia,
    dmPutMedia,
    dmReadMedia,
    groupReadMedia,
    momentPutMedia,
    momentReadMedia,
    borrow,
    legacyFollows: () => legacyFollows({}),
    confirmLegacyFollows,
    identityStatus: () => identityStatus({}),
    reset: () => {
      cancelGroups()
      retarget(null)
      const dm = supersedeDmUnlock()
      return identityChange(() => resetChain({ previous: dm.previous }).finally(dm.release), { abort: true })
    },
    // 'open' | 'closed'
    get state () {
      return closed ? 'closed' : 'open'
    }
  }
}

module.exports = { pageSignResult, createBrowserSession, toRpcError, checkConfig, redactLogLine }
