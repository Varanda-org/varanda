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
// Groups (docs/protocol.md section 10), on the SAME link (no connection per
// group, no group key in the admission inventory):
//   own cores    every core of kv 'groupWriters' (the writer and, for a
//                group this device created, its root) is opened read-only
//                and pushed like an own media core: replicated only on a
//                verified link, never announced, never downloaded into, and
//                confirmed with 'group-pushed { key, length }' once the
//                seeder HOLDS it: a page of this link lists the core at no
//                less than our length (the seeder's contiguous length), or
//                its replicator peer advertised that much. Blocks served on
//                the link do not count for a group core: the seeder may take
//                them on its quarantine channel and store none, and a once
//                run would end with the group behind. While a confirmation
//                is pending the pages are asked again (GROUP_PUSH_PAGE_MS).
//                A seeder from before groups keeps the media rule.
//   groups       the groups of kv 'groupWriters', plus each key of kv
//                'groupReplicas' with nothing stored yet (a root asked for
//                before a join: list it with store.addGroupReplica and the
//                next run fetches it through the writer pages).
//   pages        once the link verified, the writer set of every group is
//                asked page by page on 'varanda/groups/1' (the groups-net
//                member handle on this link's muxer), again every
//                groupPageMs in a continuous run; 'group-paged { group,
//                count }' after each full pass. A seeder from before groups
//                (`supported` false) counts as paged. Requests on a link
//                are spaced GROUP_REQUEST_MS (every group and re-page). A
//                page marked `incomplete` is gated but never completes the
//                pass nor confirms an own core (a once run asks again); a
//                pass counts only for the link it ran on.
//   gate         each foreign core of a page (a writer, or the root of a
//                group this device did not create) is gated before anything
//                is stored: block 0 through the link's in-memory core
//                (acquireLinkCore) must be the header naming the group and
//                the page's diary D; D's block 0 must carry a valid member
//                certificate (revoked issuers included) and D's block `seq`
//                the group-join binding exactly that core (on: true); D and
//                the group not blocked; the signed length within the quota.
//                Only then is the core opened in the storage ('group/<hex>',
//                lazy), live-downloaded, watched for fork and quota, and
//                listed in kv 'groupReplicas' once its local block 0 equals
//                the one gated. A join turned off later never removes it:
//                membership ends with a group-leave inside the writer, which
//                is the fold's business. A stored group core is purged only
//                when D or its group is blocked, D's issuer is revoked, on a
//                fork, or when its local block 0 differs. At most
//                MAX_GROUP_WRITERS_PER_DIARY cores per (diary, group) are
//                gated, the rest fail 'quota' (never purged); a gate refused
//                on the page item alone is tried again for another listing
//                of the key. Gates take
//                roots first, then a fair queue (fewest attempts, an
//                attempted core at the back), at most
//                MAX_GROUP_GATE_ATTEMPTS per core per run; 'group-unanswered
//                { key, group, attempts }' when one got no answer.
//   diaries      the binding diary D of every accepted foreign core is kept
//                as a replica (replicaName, listed in kv 'groupDiaries',
//                never in follows): downloaded up to its present length as
//                a followed replica (trackPresent: a deleted block is never
//                asked for and is cleared), fork and quota watched, a goal
//                of once runs up to its join, so local
//                reads find the join and the name of an unfollowed author.
//                Not for the own or a followed diary (its follow holds it).
//                Purged once no STORED core binds it (synced, at rest, or
//                failed without a purge). Revoked issuers (run start, and
//                each snapshot adding one): a diary binding a stored group
//                core or listed in kv groupDiaries whose stored block 0 has
//                a revoked issuer loses those cores and its replica
//                ('group-skipped' reason 'revoked-issuer').
//   timeouts     a timed-out page request ends only its channel: a new one
//                is attached after groupRetryMs (doubled per timeout, up to
//                GROUP_RETRY_MAX_FACTOR times) on the same link; any other
//                channel failure ends the pages of that link.
//   events       'groups-changed { group }' at most once per group per
//                growth burst (groupsChangedMs) of any foreign core of it,
//                also when no diary grew; 'group-skipped { key, group,
//                reason }'; and, for the write gate of group writes, after
//                each pass on a link: 'group-synced { key, length }' when the
//                seeder's page lists an own core at no more than we hold (or
//                not at all), else 'group-behind { key, length, theirs }';
//                once per length per link.
//   goals        every run: each group paged in full and each accepted
//                foreign core at the length its page advertises (as the
//                follows, G1); once runs also wait for every own group core
//                to be confirmed pushed. The settled report counts own group
//                cores with the media (mediaPending).
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
const { attachGroups, GROUPS_LIMIT_MAX } = require('@varanda/core/lib/groups-net')
const { validateGroupHeader, validateWriterHeader, groupJoinHistory, MAX_GROUP_WRITERS, MAX_GROUP_WRITERS_PER_DIARY } = require('@varanda/core/lib/group')
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
// Writer pages of one group are asked again this often in a continuous run.
const GROUP_PAGE_MS = 30000
// While an own group core waits for its push confirmation, the pages are
// asked again at most this often (the channel allows 2 messages a second).
const GROUP_PUSH_PAGE_MS = 1000
// Writer page requests on one link are spaced this much, all groups and
// every re-page together (the seeder refills 2 messages a second).
const GROUP_REQUEST_MS = 1000
// A timed-out page request: the channel is opened again after this, doubled
// on each new timeout of the link up to GROUP_RETRY_MAX_FACTOR times.
const GROUP_RETRY_MS = 30000
const GROUP_RETRY_MAX_FACTOR = 8
// Gates of one foreign group core per run; an attempted one goes to the back.
const MAX_GROUP_GATE_ATTEMPTS = 4
// Growth of a group's cores within this window makes one 'groups-changed'.
const GROUPS_CHANGED_MS = 50
// A group's root and writers together: at most MAX_GROUP_WRITERS cores.
// The communities a group root's community-link records name (on or off),
// in root order of first appearance, that a run pages: the same bound the
// group fold loads, since an earlier community's admin acts still count.
const MAX_LINKED_COMMUNITIES = 32
// The linked communities (not this device's own) one run pages at most,
// over every group root.
const MAX_SYNCED_COMMUNITIES = 32
const MAX_GROUP_PAGES = Math.ceil((MAX_GROUP_WRITERS + 1) / GROUPS_LIMIT_MAX) + 1

// Gate failures that depend on the page item (its group, diary or join
// seq), not on the core: another listing of the key is gated again, at most
// MAX_GATE_HINTS listings per key per run, so a seeder inventing listings
// cannot make this device gate one key without end nor grow its memory. A
// 'header-invalid' block 0 is no header whatever the listing says: never
// gated again.
const HINT_REASONS = new Set(['wrong-group', 'wrong-diary', 'unbound', 'diary-unavailable'])
const MAX_GATE_HINTS = 4

const HEX64 = /^[0-9a-f]{64}$/
const REPLICA_INDEX = 'replicas'
// diary.peek outcomes (the session maps both to NOT_FOUND).
const SEEDER_UNAVAILABLE = 'semeador indisponível'
const DIARY_UNAVAILABLE = 'diário indisponível'

function noop () {}

// The per-diary writer cap, as @varanda/core lib/group.js capPerDiary keeps
// the MAX_GROUP_WRITERS_PER_DIARY EARLIEST joins, not the first stored:
// held = the live accepted cores of (group, diary) besides the candidate,
// each { key, group, seq, proven }; seq = the candidate's proven join seq.
// -> { full, victim }: when full, the held writer with the highest PROVEN
// join seq above seq gives up its slot (never a root, never on an unproven
// seq), or null when the candidate is refused. Protects the fold from a
// seeder listing later writers first to push out the one holding a leave
// or moderation.
function capVictim (held, seq) {
  if (held.length < MAX_GROUP_WRITERS_PER_DIARY) return { full: false, victim: null }
  let victim = null
  for (const x of held) {
    if (!x.proven || x.key === x.group || !(x.seq > seq)) continue
    if (victim === null || x.seq > victim.seq) victim = x
  }
  return { full: true, victim }
}
// The join seq of a stored writer from its binding diary's entries: the
// earliest on:true group-join naming it for the group -> { seq, proven }.
// Without it a core stored in an earlier run could never give up its slot,
// and a seeder withholding a diary's earliest writer for one run would keep
// it out of every later one. A diary not stored proves nothing.
function storedJoinProof (entries, group, writer) {
  let seq = null
  if (Array.isArray(entries)) {
    for (const j of groupJoinHistory(entries, group)) {
      if (j.on === true && j.writer === writer && (seq === null || j.seq < seq)) seq = j.seq
    }
  }
  return seq === null ? { seq: 0, proven: false } : { seq, proven: true }
}

// A writer's join seq for the cap: the proven seq (a join the seeder named),
// lowered to the earliest on:true join the binding diary entries show.
function refineJoinSeq (seq, entries, group, writer) {
  const proof = storedJoinProof(entries, group, writer)
  return proof.proven && proof.seq < seq ? proof.seq : seq
}

// The stored cores ({ key, group, diary, seq, proven }) beyond the cap of
// their (group, diary): per pair, the earliest proven joins stay (a bound
// root is always one of them), the rest -> the returned Set.
function capExcess (live) {
  const excess = new Set()
  const byPair = new Map()
  for (const x of live) {
    if (x.key === x.group) continue
    const k = x.group + ':' + x.diary
    if (!byPair.has(k)) byPair.set(k, [])
    byPair.get(k).push(x)
  }
  for (const list of byPair.values()) {
    const { group, diary: d } = list[0]
    const room = MAX_GROUP_WRITERS_PER_DIARY - (live.some((r) => r.key === group && r.diary === d) ? 1 : 0)
    if (list.length <= room) continue
    list.sort((x, y) => (y.proven - x.proven) || (x.seq - y.seq) || (x.key < y.key ? -1 : 1))
    for (const x of list.slice(room)) excess.add(x)
  }
  return excess
}

// Whether a cap eviction purges its victim: a core in 'regate' is stored but
// not yet listed in kv groupReplicas, so kept it would be unknown to every
// later run (never folded, gated again or purged, even after a block).
// Only a listed core is kept, and a core stored or listed before this run
// (preStored) is never purged by an eviction: it is the device's own copy.
function evictionPurges (state, preStored = false) {
  return state === 'regate' && preStored !== true
}

// The binding certificate of a gated core, checked again against the
// CURRENT blocklist (blocked keys, revoked issuers) before the core is
// stored and before it turns active: a seeder that delays the join block
// while a revoking snapshot arrives must not get the core stored.
// -> null when still valid, else the reason.
function bindingRecheck (diaryRaw0, diaryHex, ownHex, associationHex, opts, isBlocked) {
  if (isBlocked(diaryHex)) return 'blocked'
  if (diaryHex === ownHex) return null
  if (diaryRaw0 === null || diaryRaw0 === undefined) return 'not-in-log'
  return gateVerdict(diaryRaw0, diaryHex, associationHex, opts)
}

// A key leaves kv groupReplicas: it no longer counts as listed when the run
// started, so a later gate of it in this run is not taken for the device's
// own stored copy (which an eviction would keep, stored but unlisted).
function forgetListed (listed, key) {
  listed.delete(key)
  return key
}

// Adds the on:true group-joins of entries ({ seq, record }) to joins
// ({ group, writer, seq }): only group-join records are kept.
function addJoins (joins, entries) {
  for (const { seq, record } of entries) {
    const r = validRecordCopy(record, seq)
    if (r !== null && r.type === 'group-join' && r.on === true) joins.push({ group: r.group, writer: r.writer, seq })
  }
  return joins
}

// A writer's join seq for the cap, lowered to its earliest on:true join in
// joins (null: nothing known).
function earliestJoin (seq, joins, group, writer) {
  let out = seq
  for (const j of joins || []) if (j.group === group && j.writer === writer && j.seq < out) out = j.seq
  return out
}

// Whether an own group core's push is confirmed: the replication peer's
// evidence is required (peerHeld), and the page length agrees unless the
// seeder does not speak groups (pageLength null).
function groupPushHeld (peerHeld, pageLength, length) {
  return peerHeld === true && (pageLength === null || pageLength >= length)
}

// The write gate's verdict on an own group core: null (wait) until the
// seeder's replication peer on the link has synced, whatever its page says,
// so a device restored with the same keys never appends at a stale page
// length and forks its own writer or root. Then 'behind' when the seeder
// holds more than this device (the larger of page and peer), else 'synced'.
function ownGroupVerdict (length, pageLength, peerLength) {
  if (peerLength === null) return null
  const theirs = Math.max(pageLength === null ? 0 : pageLength, peerLength)
  return { theirs, behind: theirs > length }
}

// Listings of a full (group, diary) gated at once as contenders.
const MAX_CAP_CONTENDERS = 2

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

// Block 0 of group core `key` -> { group, diary } (a root names itself), or
// null when it is neither header.
function groupHeaderOf (raw, key) {
  try {
    const h = decodeBlock(raw)
    if (h === null) return null
    // This version folds only public groups and communities: a crafted
    // private root would be joined and stored but never fold. A community
    // root is paged and gated as a group root of its own key.
    if (validateGroupHeader(h) === null) return h.visibility === 'public' ? { group: key, diary: h.diary, community: h.kind === 'community' } : null
    if (validateWriterHeader(h) === null && h.group !== key) return { group: h.group, diary: h.diary }
    return null
  } catch {
    return null
  }
}

// Block-0 verdict of group core `key` listed for `group` under diary D, as
// the seeder's: null = accepted. `linkedOnly` marks a `group` paged only
// because a group root names it as a community: its root must be a
// community header (a group header there is this device's own verdict
// 'not-community'); any other paged root must be a group header.
function groupVerdict (raw, key, group, diary, linkedOnly = false) {
  const h = groupHeaderOf(raw, key)
  if (h === null) return 'header-invalid'
  if (h.group !== group) return key === group ? 'header-invalid' : 'wrong-group'
  if (key === group) {
    if (linkedOnly && !h.community) return 'not-community'
    if (h.community !== linkedOnly) return 'header-invalid'
  }
  return h.diary === diary ? null : 'wrong-diary'
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
// A stored run above the prefix (an earlier window) at most TAIL_MAX blocks
// below the signed length gets the whole new tail instead of the newest
// window: the reader shows a run only while it reaches the signed length,
// so the tail reconnects what is already on screen.
const TAIL_MAX = 256

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
// initial scan fails (the tracker then stops, with present 0);
// onNewest(length) when the head finds the newest window below the signed
// `length` all stored or deleted (the present length does not move then).
//
// newest > 0 (followed diaries in the browser) downloads in two strict
// phases, never both at once: Hypercore 10.38.2 picks among a core's open
// ranges at random, so a newest range open next to the history range would
// get about half of the requests. The HEAD asks for block 0..HEAD_LOW-1
// (only those while block 0 is missing), waits for the signed length when
// expect(length) announced more than the core knows (nothing is requested
// past the signed length), then asks for the newest `newest` blocks below
// it, split around deleted seqs; when blocks are stored above the present
// length (the scan's highest, or the last window completed) at most tailMax
// blocks below the signed length, the window starts right above them
// instead (the whole new tail).
// The BODY is the linear download above,
// from block 0. The body runs when the newest window already reaches the
// prefix (a small diary: newest 0 behaves exactly so), once the window is
// all stored or deleted, or when it brought no block for stallMs (the
// seeder may lack it); a target that grows past that and leaves the
// history more than `newest` blocks behind runs the head again. The
// reported length stays the present length on both phases.
// -> also expect(length), the length a seeder advertised (a hint only).
function trackPresent (core, { noClear = false, download = true, newest = 0, tailMax = TAIL_MAX, stallMs = HEAD_STALL_MS, onScan = noop, onReady = noop, onGrow = noop, onDeleted = noop, onError = noop, onNewest = noop }) {
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
  // Where the stored run the reader shows ends: one past the highest block
  // the scan found, then the end of each window completed. Blocks of a
  // window still downloading never move it (the run is not connected yet).
  let top = 0
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
        let ws = Math.max(HEAD_LOW, len - newest)
        if (top > present && top < ws && len - top <= tailMax) ws = top
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
      top = len
      onNewest(len)
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
    top = Math.max(top, state.raw.length)
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

// Growth of a group core, which holds no delete records (diaries, followed
// or binding, use trackPresent instead).
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
  groupPageMs = GROUP_PAGE_MS,
  groupRetryMs = GROUP_RETRY_MS,
  groupRequestTimeoutMs,
  groupRequestMs = GROUP_REQUEST_MS,
  groupsChangedMs = GROUPS_CHANGED_MS,
  socketCloseMs = SOCKET_CLOSE_MS,
  blocklistMinIntervalMs, // test-only: blocklist-net.js minIntervalMs
  newestBlocks = NEWEST_BLOCKS, // followed diaries: trackPresent `newest`
  tailBlocks = TAIL_MAX, // followed diaries: trackPresent `tailMax`
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
  const media = [] // own media cores: { key, core, pushed, stop, uploaded, event, revoked }
  let mediaRevoke = Promise.resolve() // the last revokeOwnMedia pass
  let mediaTimer = null
  const groupOwn = [] // own group cores: the media shape plus { group, synced }
  const ownGroupKeys = new Set()
  const groups = new Map() // group -> { group, paged, items } (see the header)
  const groupCores = new Map() // foreign group core key -> entry (newGroupEntry)
  const groupDiaries = new Map() // binding diary hex -> entry (ensureGroupDiary)
  const restingCores = new Map() // stored group core not synced this run -> { group, diary }
  const listedAtStart = new Set() // kv groupReplicas keys when the run started
  const joinCache = new Map() // binding diary -> { core, length, joins } (diaryJoins)
  const bindingCerts = new Map() // binding diary -> block 0 its accepted core was gated with (kv groupCerts)
  // Diaries the follow path refused or purged as 'revoked-issuer' this run:
  // their replica may be gone, their group cores still have to go.
  const revokedDiaries = new Set()
  let groupGating = 0
  let gateOrder = 0 // the fair queue of group gates (lastAttempt)
  let groupKvChain = Promise.resolve() // kv groupReplicas changes, one at a time
  const changedGroups = new Set()
  const linkedGroups = new Map() // community -> Set of groups whose root links it
  const linkedCommunities = new Set() // communities paged because a group root links them
  const ownCommunities = new Set() // communities whose root this device holds
  const notCommunities = new Set() // linked keys whose root is a group header: never paged again this run
  let changedTimer = null
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
      pushPagedAt: 0, // when a pending own group push last asked the pages
      nextGroupRequestAt: 0, // the earliest next writer page request
      timer: null,
      blocklist: null, // the 'varanda/blocklist/1' handle on this link
      blocklistUnsupported: false, // the seeder does not speak it (pre-B2)
      blocklistOffers: 0, // offers from this link in flight
      blocklistOfferedHave: null, // ordering key of the newest offer from this link that resolved
      groups: null, // the 'varanda/groups/1' member handle on this link
      groupsUnsupported: false, // the seeder does not speak it
      groupsBroken: false, // the channel failed for good: no more pages on this link
      groupsTimeouts: 0, // page requests of this link that timed out (the backoff)
      groupsRetryTimer: null, // the channel opens again (retryGroupsLater)
      paging: false,
      pageAgain: false,
      pageTimer: null,
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
      attachLinkGroups(l)
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
    clearLater(l.pageTimer)
    l.pageTimer = null
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
    for (const m of pushCores()) m.pushed = -1
    for (const m of groupOwn) m.synced = null
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
    for (const m of pushCores()) m.core.replicate(l.noise)
    for (const e of follows.values()) {
      if ((e.state === 'active' || e.state === 'regate') && e.core) e.core.replicate(l.noise)
    }
    for (const ge of groupCores.values()) {
      if ((ge.state === 'active' || ge.state === 'regate') && ge.core) ge.core.replicate(l.noise)
    }
    for (const gd of groupDiaries.values()) if (gd.core !== null) attachGroupDiary(gd, l)
    pollMedia()
    // send() queues until the channel opens, right after hello.
    announceOwn()
    // Snapshots held since the channel opened may now be offered, and our
    // have goes out again so the seeder sends anything newer (C2).
    l.passVerified()
    if (l.blocklist !== null) l.blocklist.announce()
    if (l.groupsUnsupported) reportOwnGroups(l, null)
    pageGroups(l)
    pumpGroupGates()
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
    // Groups (see the header): own pushes only for a once run, the settled
    // report counts them with the media.
    unmet.push(...unmetGroupGoals(once))
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
    const mediaPending = settled && pushPending()
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
    // Growth already seen is reported even when the run ends inside the
    // coalescing window (a once run met right after the last block).
    flushGroupsChanged()
    ending = true
    if (link !== null) withdrawPeek(link)
    discardRegate()
    discardGroupRegate()
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
    if (reason === 'revoked-issuer') revokedDiaries.add(entry.key)
    stopEntry(entry)
    skipped.push({ key: entry.key, reason })
    emit({ event: 'skipped', key: entry.key, reason })
    send({ type: 'rejected', key: entry.key, reason })
    if (reason === 'blocked' || reason === 'revoked-issuer') dropGroupsOfDiary(entry.key, reason)
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
      tailMax: tailBlocks,
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
      onNewest: (length) => {
        if (entry.core === core) onNewest(entry, length)
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

  // The newest window is on the device ahead of the history: a hint for the
  // reader (docs/rpc.md §6 `newest`), once per length. Nothing advertised or
  // measured changes: those stay on the present length.
  // A replica still in regate holds it until its block 0 passes the gate.
  function onNewest (entry, length) {
    if (ended) return
    if (entry.state === 'regate') {
      entry.newestHeld = length
      return
    }
    if (entry.state !== 'active') return
    if (checkQuota(entry)) return
    if (entry.newestSent.has(length)) return
    entry.newestSent.add(length)
    emit({ event: 'newest', key: entry.key, length })
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
      if (entry.newestHeld > 0) onNewest(entry, entry.newestHeld)
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
    // A group core is never doubled on the link either; it is no diary.
    if (ownGroupKeys.has(key) || groupCores.has(key)) throw hidden()
    const gd = groupDiaries.get(key)
    if (gd !== undefined) {
      // A stored binding diary is the run's: never doubled on the link.
      await gd.opening
      if (ending || link !== l) throw unavailable()
      if (gd.core !== null && groupDiaries.get(key) === gd) return { core: gd.core, release: noop, closed: null }
      throw hidden()
    }
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
    // A lent binding diary: another member's deleted post is never fetched
    // and stored again through a peek.
    for (const gd of groupDiaries.values()) {
      if (gd.core === core && gd.tracker) return gd.tracker.deleted()
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
    // A seq the local fold of the own diary, of a followed core or of a
    // binding diary knows deleted is never asked for (its bytes are cleared everywhere): it is
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
      track(sweepRevokedGroups(), noop, noop)
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
      purgeGroupCoresOf(key, 'blocked')
      stopBlockedGroup(key)
      const gd = groupDiaries.get(key)
      if (gd !== undefined) {
        // Closed here, purged by this sweep below like any blocked replica.
        const c = detachGroupDiary(gd)
        if (c !== null) cores.push(c)
      }
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
        dropRevokedDiary(entry.key)
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
    // An open binding diary is sweepRevokedGroups' (it reuses that core).
    for (const key of unfollowedReplicas) {
      if (key !== ownHex && !follows.has(key) && !isBlockedKey(key) && !groupDiaries.has(key)) keys.push(key)
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
        // Inside the group kv chain, where binding diaries open: never a
        // second handle on a key (memoryNodeStorage shares the files, and
        // closing one closes them for the other).
        const revoked = await groupKv(async () => {
          if (groupDiaries.has(key) || !(await store.replicaExists(storage, key))) return false
          const core = await store.openReplica(storage, key)
          let reason
          try {
            reason = await localGate(core, key, association, gateOpts())
          } finally {
            await core.close()
          }
          if (reason !== 'revoked-issuer') return false
          await store.purgeReplica(storage, key)
          return true
        })
        if (revoked) {
          revokedDiaries.add(key)
          dropRevokedDiary(key)
        }
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
  // sweepUnfollowed under the kill switch), nor a binding diary of a stored
  // group core: the key stays indexed.
  async function updateReplicaIndex () {
    try {
      const previous = await readReplicaIndex(storage)
      const next = new Set()
      for (const key of previous) {
        if (key === ownHex || follows.has(key)) continue
        if (!(await store.replicaExists(storage, key))) continue
        // Over the follow limit is still followed, only not synced now. A
        // binding diary is open or kept for a stored group core: purging it
        // would delete storage under that core and lose the join evidence;
        // an open one's tracker clears what its author deleted.
        if (stillFollowed.has(key) || noClear || groupDiaries.has(key) || groupDiaryBound(key)) {
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
      media.push(pushEntry(key, core, 'media-pushed'))
    }
  }

  // A core of ours to push and confirm (see the header). uploaded:
  // replicator Peer -> the block indexes served to it. revoked: block
  // indexes a tombstone of the own diary deleted (media only; a group core
  // keeps it empty, seederHoldsMedia reads it for both).
  function pushEntry (key, core, event) {
    const m = { key, core, pushed: -1, stop: null, uploaded: new WeakMap(), event, revoked: new Set() }
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
    return m
  }

  function pushCores () {
    return media.concat(groupOwn)
  }

  function pushPending () {
    return pushCores().some((m) => m.core.length > 0 && m.pushed !== m.core.length && !(m.group && isBlockedKey(m.group)))
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

  // Whether the seeder holds blocks 0..length-1 of an own group core (see
  // the header): the page of this link, or what its peer advertised.
  // A push is confirmed only with the replication peer's evidence (what it
  // advertised or was served on this link, as for media): a page item is
  // the seeder's word, not its blocks. The page must agree too, when the
  // seeder speaks groups: a block served is not yet a block it kept.
  function seederHoldsGroup (m, l, length) {
    const g = groups.get(m.group)
    const it = g === undefined || g.pagedOn !== l ? undefined : g.items.get(m.key)
    return groupPushHeld(seederHoldsMedia(m, l, length), l.groupsUnsupported ? null : (it === undefined ? 0 : it.length), length)
  }

  // The length the seeder's peer on link l reports for own core m, once it
  // has synced (null before): the larger of its contiguous and signed length.
  function seederPeerLength (m, l) {
    for (const peer of m.core.peers) {
      if (peer.stream !== l.noise || peer.remoteSynced !== true) continue
      return Math.max(peer.remoteContiguousLength, peer.remoteLength || 0)
    }
    return null
  }

  // A pending own group push asks the pages again, at most every
  // GROUP_PUSH_PAGE_MS per link.
  function repageForPushes (l) {
    if (l.groups === null || l.groupsUnsupported || l.groupsBroken || ending) return
    if (!groupOwn.some((m) => m.core.length > 0 && m.pushed !== m.core.length && !isBlockedKey(m.group))) return
    const now = Date.now()
    if (now - l.pushPagedAt < Math.max(mediaPollMs, GROUP_PUSH_PAGE_MS)) return
    l.pushPagedAt = now
    pageGroups(l)
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
    for (const m of pushCores()) {
      const length = m.core.length
      if (length < 1 || m.pushed === length) continue
      if (m.group ? seederHoldsGroup(m, l, length) : seederHoldsMedia(m, l, length)) {
        m.pushed = length
        emit({ event: m.event, key: m.key, length })
      }
    }
    repageForPushes(l)
    reportOwnGroups(l, null)
    // A once run may be waiting for a group push (its goals).
    evaluate()
  }

  // The light poll runs only while the link is verified and some core is
  // not yet confirmed at its length.
  function pollMedia () {
    if (mediaTimer !== null || ending) return
    if (seederLink() === null) return
    if (!pushPending() && !groupOwn.some((m) => m.awaitingPeer)) return
    mediaTimer = later(() => {
      mediaTimer = null
      checkMedia()
      pollMedia()
    }, mediaPollMs)
  }

  // ---- groups (see the header) ----

  function ensureGroup (group) {
    if (!groups.has(group)) groups.set(group, { group, pagedOn: null, items: new Map() })
  }

  function newGroupEntry (key, group, diary, seq) {
    return {
      key,
      group,
      diary,
      seq,
      state: 'pending', // pending | regate | active | failing | failed
      core: null,
      attempts: 0, // gates started this run (MAX_GROUP_GATE_ATTEMPTS)
      lastAttempt: 0, // order of the last one (the fair queue)
      raw0: null, // the block 0 the gate accepted
      gating: false,
      waiting: false, // a retry of a gate that got no answer is scheduled
      range: null,
      stopGrow: null,
      stopFork: null,
      stopQuota: null,
      retryTimer: null,
      reason: null, // why it failed
      scanning: false, // a scan of a root's community links runs
      rescan: false,
      hints: new Set() // 'group:diary:seq' listings whose gate failed on the hint
    }
  }

  function groupKv (fn) {
    const p = groupKvChain.then(fn)
    groupKvChain = p.catch(noop)
    return p
  }

  // The stored own group cores and foreign group cores, before any
  // connection. Groups never fail a run: a read error leaves them out.
  async function openGroups () {
    let writers
    let replicas
    try {
      writers = await store.readGroupWriters(storage)
      replicas = await store.readGroupReplicas(storage)
      for (const key of replicas) listedAtStart.add(key)
      for (const [d, raw] of await store.readGroupCerts(storage)) bindingCerts.set(d, raw)
    } catch {
      log('aviso: falha ao ler os grupos')
      return
    }
    let boundRoots
    try {
      boundRoots = new Set(await store.readBoundRoots(storage))
    } catch {
      boundRoots = new Set()
    }
    for (const e of writers) {
      if (ending) return
      if (e.kind === 'community') ownCommunities.add(e.group)
      if (!isBlockedKey(e.group)) ensureGroup(e.group)
      await openOwnGroupCore(e.key, e.group)
      if (e.rootNonce !== null) await openOwnGroupCore(e.group, e.group)
    }
    const stored = []
    for (const key of replicas) {
      if (ending) break
      if (ownGroupKeys.has(key)) continue
      let core = null
      try {
        core = await store.openGroupCoreReadOnly(storage, key)
      } catch {
        log('aviso: falha ao abrir o núcleo de grupo ' + key8(key))
        continue
      }
      if (core === null || core.contiguousLength === 0) {
        if (core !== null) await core.close().catch(noop)
        if (!isBlockedKey(key)) {
          ensureGroup(key)
          // Not a group of kv groupWriters (a root asked for before a join,
          // or a writer key a run left listed): unlisted after a complete
          // pass whose pages hold no root of that key, so a stray key is
          // never paged forever nor keeps once runs unmet.
          if (!writers.some((e) => e.group === key)) groups.get(key).probe = true
        }
        continue
      }
      let raw = null
      try {
        raw = await core.get(0, { wait: false, raw: true })
      } catch {}
      const h = raw === null ? null : groupHeaderOf(raw, key)
      if (h === null || core.fork !== 0) {
        await core.close().catch(noop)
        purgeGroupKey(key, h === null ? 'header-invalid' : 'fork')
        continue
      }
      stored.push({ key, core, raw, ...h })
    }
    for (const e of writers) {
      if (e.rootNonce === null || e.kind === 'community') continue
      const m = groupOwn.find((x) => x.key === e.group)
      if (m !== undefined) await scanCommunityLinks(e.group, m.core)
    }
    for (const s of stored) {
      if (s.key === s.group && !s.community && groups.has(s.group) && !linkedCommunities.has(s.group)) await scanCommunityLinks(s.group, s.core)
    }
    // The role of each paged key holds for stored cores too: under a
    // linked-only community only its community root is restored, and a
    // joined group's root must be a group header, as at the gate.
    for (const s of stored) {
      const linkedOnly = linkedCommunities.has(s.group)
      if (linkedOnly && s.key === s.group && !s.community) {
        emit({ event: 'group-skipped', key: s.key, group: s.group, reason: 'not-community' })
        notCommunities.add(s.group)
        groups.delete(s.group)
      } else if (!linkedOnly && s.key === s.group && s.community && groups.has(s.group) && !ownCommunities.has(s.group)) {
        s.invalid = true
      } else if (linkedOnly && s.key !== s.group) {
        s.rest = true
      }
    }
    const bindings = new Map()
    const live = []
    for (const s of stored) {
      // A root goes with its header's diary only when that diary bound it
      // (anyone can name any diary in a header, and a blocked stranger must
      // not take down a group it never created); an unbound root stays.
      // Bound also when an earlier gate proved it (boundRoots) and the join
      // block is not stored yet: a restart never frees it from its creator.
      s.rootBound = s.key === s.group && (boundRoots.has(s.key) || storedJoinProof(await bindingEntries(s.diary, bindings), s.group, s.group).proven)
      const unboundRoot = s.key === s.group && !s.rootBound
      if (s.invalid === true) {
        await s.core.close().catch(noop)
        if (!ending) purgeGroupKey(s.key, 'header-invalid')
        continue
      }
      if (ending || (isBlockedKey(s.diary) && !unboundRoot) || isBlockedKey(s.group)) {
        await s.core.close().catch(noop)
        if (!ending) purgeGroupKey(s.key, 'blocked')
        continue
      }
      // A group no longer synced keeps its cores at rest.
      if (s.rest === true || !groups.has(s.group) || isBlockedKey(s.group) || isBlockedKey(s.diary)) {
        await s.core.close().catch(noop)
        restingCores.set(s.key, { group: s.group, diary: s.diary, rootBound: s.rootBound })
        continue
      }
      if (groupCores.size + live.length >= store.MAX_GROUP_REPLICAS) {
        await s.core.close().catch(noop)
        restingCores.set(s.key, { group: s.group, diary: s.diary, rootBound: s.rootBound })
        continue
      }
      s.seq = 0
      s.proven = false
      if (s.key !== s.group) Object.assign(s, storedJoinProof(await bindingEntries(s.diary, bindings), s.group, s.key))
      live.push(s)
    }
    // Kept victims of an earlier run come back from the storage: the cap
    // holds across runs only if at most MAX_GROUP_WRITERS_PER_DIARY of a
    // (group, diary) go live, the earliest proven joins (a bound root is one
    // of them), the rest at rest.
    const excess = capExcess(live)
    for (const x of live) {
      if (excess.has(x)) {
        await x.core.close().catch(noop)
        restingCores.set(x.key, { group: x.group, diary: x.diary, rootBound: x.rootBound })
        continue
      }
      const ge = newGroupEntry(x.key, x.group, x.diary, x.seq)
      ge.raw0 = x.raw
      ge.state = 'active'
      ge.proven = x.proven
      ge.rootBound = x.rootBound
      // The binding certificate, from the stored diary or the one kept when
      // the core was accepted: a later revocation re-judges it.
      if (x.diary !== ownHex) {
        const entries = await bindingEntries(x.diary, bindings)
        ge.diaryRaw0 = (entries && entries.raw0) || bindingCerts.get(x.diary) || null
      }
      groupCores.set(x.key, ge)
      watchGroupEntry(ge, x.core)
    }
  }

  // The stored entries of binding diary d (the own diary, or a stored
  // replica: followed or kv groupDiaries), read once per run start; null
  // when not stored or unreadable.
  async function bindingEntries (d, cache) {
    if (cache.has(d)) return cache.get(d)
    let entries = null
    try {
      if (d === ownHex) {
        entries = await store.readAll(diary)
      } else if (await store.replicaExists(storage, d)) {
        const core = await store.openReplica(storage, d)
        try {
          entries = await store.readAll(core)
          entries.raw0 = core.contiguousLength > 0 ? await core.get(0, { wait: false, raw: true }) : null
        } finally {
          await core.close().catch(noop)
        }
      }
    } catch {
      entries = null
    }
    cache.set(d, entries)
    return entries
  }

  // ---- groups: the binding diaries (see the header) ----

  // A diary binds while some accepted group core of it is held: synced this
  // run (active or regate) or at rest in the storage.
  function groupDiaryBound (d) {
    for (const r of restingCores.values()) if (r.diary === d) return true
    for (const ge of groupCores.values()) {
      if (ge.diary === d && groupCoreStored(ge)) return true
    }
    return false
  }

  // A foreign core whose blocks this device keeps: synced, or failed without
  // a purge (quota, a blocked group), whose posts still read.
  function groupCoreStored (ge) {
    return ge.state === 'active' || ge.state === 'regate' || (ge.state === 'failed' && ge.kept === true)
  }

  // The binding diary D of an accepted foreign core is stored as a replica,
  // listed in kv groupDiaries (never in follows), downloaded in full and
  // watched for fork and quota, unless it is the own diary, followed (its
  // follow holds it) or blocked. `want`: the length its join needs.
  function ensureGroupDiary (d, want = 0) {
    if (ending || d === ownHex || follows.has(d) || isBlockedKey(d)) return
    const known = groupDiaries.get(d)
    if (known !== undefined) {
      known.want = Math.max(known.want, want)
      return
    }
    const gd = { key: d, core: null, want, attachedTo: null, tracker: null, stopFork: noop, stopQuota: noop, stopGrow: noop, dropped: false, opening: null }
    groupDiaries.set(d, gd)
    // Opened inside the kv chain: the revocation sweep's look at a stored
    // replica nobody holds (diaryRevoked) never doubles it.
    gd.opening = groupKv(async () => {
      await store.addGroupDiary(storage, d)
      return store.openReplica(storage, d)
    }).then((core) => {
      if (gd.dropped || ending) {
        core.close().catch(noop)
        return null
      }
      watchGroupDiary(gd, core)
      return core
    }, () => {
      if (groupDiaries.get(d) === gd) groupDiaries.delete(d)
      gd.dropped = true
      if (!ended) log('aviso: falha ao abrir o diário ' + key8(d))
      return null
    })
    track(gd.opening, noop, noop)
  }

  function watchGroupDiary (gd, core) {
    gd.core = core
    if (core.fork !== 0) return dropGroupDiary(gd)
    const check = () => {
      if (gd.core === core && overQuota(core)) dropGroupDiary(gd)
      else checkSettled()
    }
    core.on('append', check)
    gd.stopQuota = () => core.off('append', check)
    gd.stopFork = watchFork(core, () => dropGroupDiary(gd))
    // Its block 0 is judged against the current revocations as soon as it
    // is here: a revoked member's cores go even when no snapshot arrives.
    const judge = () => {
      if (gd.judged || gd.core !== core || gd.tracker === null || gd.tracker.present() < 1) return
      gd.judged = true
      track(localGate(core, gd.key, association, gateOpts()), (r) => {
        if (r === 'revoked-issuer' && !ending) dropRevokedDiary(gd.key)
      }, noop)
    }
    // A post its author deleted is neither fetched again nor kept and served
    // back, and its hole never pins the goal below the joins after it: the
    // same present length as a followed replica.
    const tracker = trackPresent(core, {
      noClear,
      onReady: () => {
        if (gd.core !== core) return
        judge()
        evaluate()
      },
      // Joins and names live there: the groups it binds read anew.
      onGrow: () => {
        if (gd.core !== core) return
        judge()
        for (const ge of groupCores.values()) {
          if (ge.diary === gd.key && ge.state === 'active') markGroupChanged(ge.group)
        }
        evaluate()
      },
      // Fail closed: no present length, so the goal stays unmet.
      onError: () => {
        if (ended || gd.core !== core) return
        log('aviso: falha ao ler o diário ' + key8(gd.key))
        evaluate()
      }
    })
    gd.tracker = tracker
    gd.stopGrow = () => tracker.destroy()
    const l = seederLink()
    if (l !== null) attachGroupDiary(gd, l)
    if (overQuota(core)) dropGroupDiary(gd)
  }

  // Attaches a stored binding diary to link l once no in-memory core of its
  // key is on the stream: a gate or a peek may still hold one (lendCore),
  // and Hypercore ignores a second channel for a discovery key, so the
  // stored core would never get a peer. New borrowers get the stored core.
  function attachGroupDiary (gd, l) {
    track((async () => {
      for (;;) {
        const shared = l.peeks.get(gd.key)
        if (shared === undefined) break
        await shared.closed
      }
      if (gd.dropped || gd.core === null || ending || link !== l || l.noise.destroyed) return
      if (gd.attachedTo === l) return
      gd.attachedTo = l
      gd.core.replicate(l.noise)
    })(), noop, noop)
  }

  // Stops and forgets an entry -> its core (the caller closes it), or null.
  // `unlist` also removes it from kv groupDiaries.
  function detachGroupDiary (gd, { unlist = true } = {}) {
    if (gd.dropped) return null
    gd.dropped = true
    if (groupDiaries.get(gd.key) === gd) groupDiaries.delete(gd.key)
    gd.stopGrow()
    gd.stopFork()
    gd.stopQuota()
    gd.tracker = null
    const core = gd.core
    gd.core = null
    if (unlist) track(groupKv(() => store.removeGroupDiary(storage, gd.key)), noop, noop)
    return core
  }

  // Closed, purged (never a followed or the own diary's replica) and unlisted.
  function dropGroupDiary (gd) {
    const opening = gd.opening
    const core = detachGroupDiary(gd, { unlist: false })
    const key = gd.key
    return track(groupKv(async () => {
      const c = core || await opening
      if (c) await c.close()
      if (key !== ownHex && !follows.has(key) && await store.replicaExists(storage, key)) await store.purgeReplica(storage, key)
      await store.removeGroupDiary(storage, key)
    }), () => evaluate(), () => log('aviso: falha ao limpar diário de grupo ' + key8(key)))
  }

  // Revoked issuers over the group side (run start, and each adopted
  // snapshot that adds one): every diary that binds a stored group core or
  // is listed in kv groupDiaries is checked through its stored block 0; one
  // certified by a revoked issuer loses every stored group core of it and
  // its binding replica ('group-skipped' reason 'revoked-issuer'). Never
  // the own diary or own cores; a followed diary's replica is its follow's
  // (regateRevoked).
  async function sweepRevokedGroups () {
    if (blocklist.revokedIssuers().size === 0) return
    // Every core carries the certificate its gate verified (or the one kept
    // since): a revocation stops it whether it is gating, in regate or
    // active, also when its binding diary is not stored here.
    for (const ge of groupCores.values()) {
      if ((ge.state !== 'pending' && ge.state !== 'regate' && ge.state !== 'active') || !ge.diaryRaw0) continue
      const reason = bindingRecheck(ge.diaryRaw0, ge.diary, ownHex, association, gateOpts(), isBlockedKey)
      if (reason !== null) failGroupEntry(ge, reason, { purge: ge.state !== 'pending' })
    }
    const diaries = new Set(groupDiaries.keys())
    for (const r of restingCores.values()) diaries.add(r.diary)
    for (const ge of groupCores.values()) if (groupCoreStored(ge)) diaries.add(ge.diary)
    try {
      for (const d of await store.readGroupDiaries(storage)) diaries.add(d)
    } catch {}
    diaries.delete(ownHex)
    for (const d of diaries) {
      if (ending) return
      let revoked = false
      try {
        revoked = await diaryRevoked(d)
      } catch {}
      if (revoked && !ending) dropRevokedDiary(d)
    }
  }

  // Whether the stored block 0 of diary d carries a certificate from a
  // revoked issuer (false when nothing of it is stored).
  async function diaryRevoked (d) {
    if (revokedDiaries.has(d)) return true
    // A core without block 0 (empty or partial) proves nothing: it never
    // hides the certificate a core of d was gated with.
    const verdict = async (core) => {
      let raw = null
      try {
        raw = await core.get(0, { wait: false, raw: true })
      } catch {}
      if (raw === null) return retainedRevoked(d)
      return gateVerdict(raw, d, association, gateOpts()) === 'revoked-issuer'
    }
    const f = follows.get(d)
    if (f !== undefined) return f.core ? verdict(f.core) : retainedRevoked(d)
    const gd = groupDiaries.get(d)
    if (gd !== undefined) {
      const core = await gd.opening
      return core && !gd.dropped ? verdict(core) : retainedRevoked(d)
    }
    return groupKv(async () => {
      if (groupDiaries.has(d) || !(await store.replicaExists(storage, d))) return retainedRevoked(d)
      const core = await store.openReplica(storage, d)
      try {
        return await verdict(core)
      } finally {
        await core.close().catch(noop)
      }
    })
  }

  // A diary with no core here (a follow not fetched yet, a replica gone)
  // is judged from the block 0 a core of it was gated with.
  function retainedRevoked (d) {
    let raw = bindingCerts.get(d) || null
    for (const ge of groupCores.values()) if (ge.diary === d && ge.diaryRaw0) raw = ge.diaryRaw0
    return raw !== null && gateVerdict(raw, d, association, gateOpts()) === 'revoked-issuer'
  }

  function dropRevokedDiary (d) {
    if (d === ownHex) return
    const reason = 'revoked-issuer'
    purgeGroupCoresOf(d, reason)
    const gd = groupDiaries.get(d)
    if (gd !== undefined) {
      dropGroupDiary(gd)
      return
    }
    track(groupKv(async () => {
      if (!follows.has(d) && !groupDiaries.has(d) && await store.replicaExists(storage, d)) await store.purgeReplica(storage, d)
      await store.removeGroupDiary(storage, d)
    }), noop, () => log('aviso: falha ao limpar diário de grupo ' + key8(d)))
  }

  // Every stored foreign group core of diary d goes, whatever its state:
  // synced or pending (dropGroupsOfDiary), failed but kept, or at rest.
  // Own cores are never in these maps.
  // A root counts as d's only when d bound it (see openGroups).
  function purgeGroupCoresOf (d, reason) {
    dropGroupsOfDiary(d, reason)
    purgeKeptGroupCores((x) => x.diary === d && (x.key !== x.group || x.rootBound === true), reason)
  }

  // Failed-but-kept and resting foreign cores matching `match`.
  function purgeKeptGroupCores (match, reason) {
    for (const ge of groupCores.values()) {
      if (!match(ge) || ge.state !== 'failed' || ge.kept !== true) continue
      ge.kept = false
      const core = ge.core
      ge.core = null
      emit({ event: 'group-skipped', key: ge.key, group: ge.group, reason })
      purgeGroupKey(ge.key, reason, core)
      markGroupChanged(ge.group)
    }
    for (const [key, r] of [...restingCores]) {
      if (!match({ key, ...r })) continue
      restingCores.delete(key)
      emit({ event: 'group-skipped', key, group: r.group, reason })
      purgeGroupKey(key, reason)
    }
  }

  function reconcileGroupDiaries () {
    if (ending) return
    for (const gd of [...groupDiaries.values()]) {
      if (!groupDiaryBound(gd.key)) dropGroupDiary(gd)
    }
  }

  // Run start, after the follows: the diaries of the synced stored cores
  // are opened; a listed one nothing binds any more is purged (a followed
  // one is only unlisted: its follow keeps the replica).
  async function startGroupDiaries () {
    let listed
    try {
      listed = await store.readGroupDiaries(storage)
    } catch {
      listed = []
    }
    for (const ge of groupCores.values()) {
      if (ge.state === 'active') ensureGroupDiary(ge.diary, 0)
    }
    for (const d of listed) {
      if (groupDiaries.has(d) || groupDiaryBound(d) || isBlockedKey(d)) continue
      await track(groupKv(async () => {
        if (d !== ownHex && !follows.has(d) && await store.replicaExists(storage, d)) await store.purgeReplica(storage, d)
        await store.removeGroupDiary(storage, d)
      }), noop, () => log('aviso: falha ao limpar diário de grupo ' + key8(d)))
    }
  }

  async function openOwnGroupCore (key, group) {
    if (ownGroupKeys.has(key)) return
    ownGroupKeys.add(key)
    let core = null
    try {
      core = await store.openGroupCoreReadOnly(storage, key)
    } catch {
      log('aviso: falha ao abrir o núcleo de grupo ' + key8(key))
      return
    }
    if (core === null) return
    const m = pushEntry(key, core, 'group-pushed')
    m.group = group
    m.synced = null // the 'length/theirs' last reported on this link
    groupOwn.push(m)
  }

  // A stored group core that must go (tracked): closed (`core`, or by the
  // caller), then purged and un-listed. A blocked author's that cannot be
  // purged fails the run, as for a diary.
  function purgeGroupKey (key, reason, core = null) {
    return track(groupKv(async () => {
      if (core !== null) await core.close()
      await store.purgeGroupCore(storage, key)
      await store.removeGroupReplica(storage, forgetListed(listedAtStart, key))
    }), noop, () => {
      if (!ended && (reason === 'blocked' || reason === 'revoked-issuer')) fail(['falha ao limpar núcleo de grupo bloqueado: ' + key8(key)])
      else log('aviso: falha ao limpar núcleo de grupo ' + key8(key))
    })
  }

  function stopGroupEntry (ge) {
    if (ge.stopGrow) ge.stopGrow()
    if (ge.stopFork) ge.stopFork()
    if (ge.stopQuota) ge.stopQuota()
    if (ge.range) ge.range.destroy()
    clearLater(ge.retryTimer)
    ge.stopGrow = ge.stopFork = ge.stopQuota = ge.range = ge.retryTimer = null
  }

  function failGroupEntry (ge, reason, { purge }) {
    if (ge.state === 'failing' || ge.state === 'failed') return
    const stored = ge.state === 'active' || ge.state === 'regate'
    stopGroupEntry(ge)
    ge.reason = reason
    ge.reserved = false
    ge.hints.add(ge.group + ':' + ge.diary + ':' + ge.seq)
    log('aviso: núcleo de grupo ' + key8(ge.key) + ' ignorado (' + reason + ')')
    emit({ event: 'group-skipped', key: ge.key, group: ge.group, reason })
    const core = ge.core
    if (!purge || !stored) {
      ge.state = 'failed'
      ge.kept = stored
      if (stored) markGroupChanged(ge.group)
      reconcileGroupDiaries()
      evaluate()
      return
    }
    ge.core = null
    ge.state = 'failing'
    checkSettled()
    purgeGroupKey(ge.key, reason, core).then(() => {
      ge.state = 'failed'
      markGroupChanged(ge.group)
      reconcileGroupDiaries()
      evaluate()
    })
  }

  // Every foreign group core of diary D (a blocked author or one from a
  // revoked issuer) is purged; a core still being gated fails at its end.
  function dropGroupsOfDiary (diaryKey, reason) {
    for (const ge of groupCores.values()) {
      if (ge.diary !== diaryKey) continue
      // An unbound stored root stays; one still gating fails (never stored).
      if (ge.key === ge.group && ge.rootBound !== true && ge.state !== 'pending') continue
      failGroupEntry(ge, reason, { purge: true })
    }
  }

  // A blocked root: every accepted foreign core of its group goes, as in the
  // core node (protecting the device from keeping and re-serving a group the
  // association blocked). Own cores are never in these maps; a core never
  // accepted is never purged.
  function stopBlockedGroup (key) {
    for (const ge of groupCores.values()) {
      if (ge.group === key) failGroupEntry(ge, 'blocked', { purge: true })
    }
    purgeKeptGroupCores((x) => x.group === key, 'blocked')
  }

  // A group core in regate on ending never passed its local check: closed
  // and purged (tracked; it was never listed).
  function discardGroupRegate () {
    for (const ge of groupCores.values()) {
      if (ge.state !== 'regate') continue
      stopGroupEntry(ge)
      ge.state = 'pending'
      const core = ge.core
      ge.core = null
      // Unlisted too: a listed key with no core would read as a group to
      // page at the next start.
      const preStored = ge.preStored === true
      track(groupKv(async () => {
        await core.close()
        if (preStored) return
        await store.purgeGroupCore(storage, ge.key)
        await store.removeGroupReplica(storage, forgetListed(listedAtStart, ge.key))
      }), noop, () => log('aviso: falha ao limpar núcleo de grupo ' + key8(ge.key)))
    }
  }

  function checkGroupQuota (ge) {
    const core = ge.core
    if (ended || !core) return false
    if (ge.state !== 'active' && ge.state !== 'regate') return false
    if (!overQuota(core)) return false
    failGroupEntry(ge, 'quota', { purge: ge.state === 'regate' })
    return true
  }

  // Live download, fork watcher and quota, as watchEntry for a follow.
  function watchGroupEntry (ge, core) {
    ge.core = core
    const check = () => {
      if (ge.core !== core) return
      if (!checkGroupQuota(ge)) checkSettled()
    }
    core.on('append', check)
    ge.stopQuota = () => core.off('append', check)
    ge.stopFork = watchFork(core, () => {
      if (ended || (ge.state !== 'active' && ge.state !== 'regate')) return
      failGroupEntry(ge, 'fork', { purge: true })
    })
    ge.range = core.download({ start: 0, end: -1 })
    ge.stopGrow = watchContiguous(core, () => onGroupGrow(ge))
    if (checkGroupQuota(ge)) return
    const l = seederLink()
    if (l !== null) core.replicate(l.noise)
    if (ge.state === 'regate' && core.contiguousLength > 0) regateGroup(ge)
  }

  function onGroupGrow (ge) {
    if (ended || checkGroupQuota(ge)) return
    if (ge.state === 'regate') {
      regateGroup(ge)
      return
    }
    if (ge.state !== 'active') return
    if (ge.key === ge.group) rescanCommunityLinks(ge)
    markGroupChanged(ge.group)
    evaluate()
  }

  // ---- groups: the communities linked from group roots ----

  // The communities named by the community-link records of group root
  // `core` (root order of first appearance, at most MAX_LINKED_COMMUNITIES)
  // are paged as
  // roots of their own key, through the same gate, caps and probe as a
  // root asked for before a join: unlisted after a complete pass whose
  // pages hold no root of that key. Never throws.
  async function scanCommunityLinks (group, core) {
    const keys = []
    try {
      const h = decodeBlock(await core.get(0, { wait: false, raw: true }))
      if (validateGroupHeader(h) !== null || h.kind !== 'group') return
      for (let i = 1; i < core.contiguousLength && keys.length < MAX_LINKED_COMMUNITIES; i++) {
        const r = decodeBlock(await core.get(i, { wait: false, raw: true }))
        if (r === null || typeof r !== 'object' || r.type !== 'community-link' || typeof r.community !== 'string' || !HEX64.test(r.community)) continue
        const key = r.community.toLowerCase()
        if (!keys.includes(key)) keys.push(key)
      }
    } catch {
      return
    }
    linkCommunities(group, keys)
  }

  // A linked key whose root is a group header: this device's own view of
  // which keys are communities, so nothing under it is gated or stored and
  // the key is not paged again this run.
  function refuseNotCommunity (ge) {
    failGroupEntry(ge, 'not-community', { purge: false })
    dropNotCommunity(ge.group)
  }

  function dropNotCommunity (c) {
    notCommunities.add(c)
    if (!groups.delete(c)) return
    track(groupKv(() => store.removeGroupReplica(storage, forgetListed(listedAtStart, c))), noop, noop)
    evaluate()
  }

  function rescanCommunityLinks (ge) {
    if (ge.scanning) {
      ge.rescan = true
      return
    }
    ge.scanning = true
    const core = ge.core
    track(scanCommunityLinks(ge.group, core), () => {
      ge.scanning = false
      if (ge.rescan && !ending && ge.core === core) {
        ge.rescan = false
        rescanCommunityLinks(ge)
      }
    }, () => { ge.scanning = false })
  }

  function linkCommunities (group, keys) {
    let added = false
    for (const c of keys) {
      if (ending || c === group || isBlockedKey(c)) continue
      if (!linkedGroups.has(c)) linkedGroups.set(c, new Set())
      linkedGroups.get(c).add(group)
      // A key asked for before a join (probe, no own writer) has no role
      // yet: named as a community, it is paged as one, as the core node does.
      const g0 = groups.get(c)
      if (notCommunities.has(c) || ownCommunities.has(c) || (g0 !== undefined && (g0.probe !== true || linkedCommunities.has(c)))) continue
      if (linkedCommunities.size >= MAX_SYNCED_COMMUNITIES) continue
      linkedCommunities.add(c)
      ensureGroup(c)
      groups.get(c).probe = true
      added = true
    }
    const l = seederLink()
    if (added && l !== null && l.groups !== null) pageGroups(l)
  }

  // Block 0 arrived in the storage: it must be the one the gate accepted.
  // Only then is the core listed in kv groupReplicas.
  function regateGroup (ge) {
    if (ge.gating || ge.state !== 'regate') return
    ge.gating = true
    const core = ge.core
    track((async () => {
      const raw = await core.get(0, { wait: false, raw: true })
      if (raw === null || !b4a.equals(raw, ge.raw0)) return false
      await groupKv(() => store.addGroupReplica(storage, ge.key))
      return true
    })(), (ok) => {
      ge.gating = false
      if (ge.state !== 'regate' || ge.core !== core) {
        // The entry moved on while its listing was written: a kept core
        // stays listed, anything else is unlisted.
        if (ok && !(ge.state === 'failed' && ge.kept === true)) track(groupKv(() => store.removeGroupReplica(storage, forgetListed(listedAtStart, ge.key))), noop, noop)
        return
      }
      if (!ok) {
        failGroupEntry(ge, 'header-invalid', { purge: true })
        return
      }
      const recheck = bindingRecheck(ge.diaryRaw0, ge.diary, ownHex, association, gateOpts(), isBlockedKey)
      if (recheck !== null) {
        failGroupEntry(ge, recheck, { purge: true })
        return
      }
      ge.state = 'active'
      if (ge.diary !== ownHex && ge.diaryRaw0) {
        bindingCerts.set(ge.diary, ge.diaryRaw0)
        track(groupKv(() => store.putGroupCert(storage, ge.diary, ge.diaryRaw0)), noop, noop)
      }
      ensureGroupDiary(ge.diary, ge.seq + 1)
      if (ge.key === ge.group) rescanCommunityLinks(ge)
      markGroupChanged(ge.group)
      evaluate()
    }, () => {
      ge.gating = false
      if (ge.state !== 'regate' || ge.core !== core) return
      failGroupEntry(ge, 'header-invalid', { purge: true })
    })
  }

  // A page item's advertised length, never trusted past the log quota: an
  // item above it fails 'quota' (kept, never purged: nothing is fetched
  // for it) and every goal or report reads the clamped value. Nothing is
  // ever iterated or allocated per advertised block.
  function advertisedLength (it) {
    return it === undefined ? 0 : Math.min(it.length, maxLogBlocks)
  }

  // An over-quota listing only skips a core not held yet: a held core's
  // quota is its own length (overQuota), so a lying seeder cannot silence
  // an admitted writer for the run by advertising it too long.
  function noteAdvertised (g, it) {
    noteGroupItem(g, it)
    if (it.length <= maxLogBlocks) return
    const ge = groupCores.get(it.key)
    if (ge !== undefined && ge.state === 'pending') failGroupEntry(ge, 'quota', { purge: false })
  }

  // 'groups-changed' coalesced per group over groupsChangedMs.
  function markGroupChanged (group) {
    if (ending) return
    changedGroups.add(group)
    // A community root changed: every group linking it re-reads its admins.
    const linked = linkedGroups.get(group)
    if (linked !== undefined) for (const g of linked) changedGroups.add(g)
    if (changedTimer !== null) return
    changedTimer = later(() => {
      changedTimer = null
      if (ending) return
      flushGroupsChanged()
    }, groupsChangedMs)
  }

  function flushGroupsChanged () {
    clearLater(changedTimer)
    changedTimer = null
    const list = [...changedGroups]
    changedGroups.clear()
    for (const g of list) emit({ event: 'groups-changed', group: g })
  }

  // ---- groups: the writer pages on the link ----

  function attachLinkGroups (l) {
    try {
      l.groups = attachGroups(l.noise, {
        role: 'member',
        ...(groupRequestTimeoutMs > 0 ? { requestTimeoutMs: groupRequestTimeoutMs } : {}),
        log: (ev) => {
          if (ev && ev.event === 'peer-dropped') log('aviso: par descartado (' + key8(ev.peerKey) + '): ' + ev.reason)
        }
      })
    } catch {
      l.groups = null
      l.groupsUnsupported = true
      return
    }
    l.groups.supported.then((ok) => {
      if (ok || link !== l) return
      // An older seeder: nothing to page, and it holds no group core of ours.
      l.groupsUnsupported = true
      if (l.verified) reportOwnGroups(l, null)
      evaluate()
    }, noop)
  }

  // A timed-out page request (see pageGroup): the handle is single-use, so
  // a new one is attached after groupRetryMs, doubled per timeout of the
  // link up to GROUP_RETRY_MAX_FACTOR times, and the pages are asked again
  // through the pacer.
  function retryGroupsLater (l) {
    if (l.groupsRetryTimer !== null) return
    l.groups = null
    const ms = groupRetryMs * Math.min(GROUP_RETRY_MAX_FACTOR, 2 ** l.groupsTimeouts)
    l.groupsTimeouts++
    log('aviso: páginas de grupo sem resposta; nova tentativa em ' + Math.ceil(ms / 1000) + ' s')
    l.groupsRetryTimer = later(() => {
      l.groupsRetryTimer = null
      if (ending || link !== l || l.noise.destroyed || l.groupsBroken) return
      attachLinkGroups(l)
      pageGroups(l)
    }, ms)
  }

  // Paces the writer page requests of link l: one every groupRequestMs at
  // most, across every group and every re-page.
  function groupRequestSlot (l) {
    const now = Date.now()
    const at = Math.max(now, l.nextGroupRequestAt)
    l.nextGroupRequestAt = at + groupRequestMs
    if (at <= now) return Promise.resolve()
    return new Promise((resolve) => { later(resolve, at - now) })
  }

  // One full pass over every synced group, one request at a time (the
  // channel allows one in flight); a pass asked for meanwhile runs after.
  async function pageGroups (l) {
    if (l.groups === null || l.groupsUnsupported) return
    if (l.paging) {
      l.pageAgain = true
      return
    }
    l.paging = true
    try {
      let again = true
      while (again) {
        l.pageAgain = false
        for (const g of [...groups.values()]) {
          if (ending || link !== l || l.groupsBroken || l.groupsUnsupported || l.groups === null) return
          if (isBlockedKey(g.group)) continue
          await pageGroup(l, g)
        }
        again = l.pageAgain
      }
    } finally {
      l.paging = false
    }
    if (!once && !ending && link === l && !l.groupsBroken) {
      clearLater(l.pageTimer)
      l.pageTimer = later(() => {
        l.pageTimer = null
        pageGroups(l)
      }, groupPageMs)
    }
  }

  async function pageGroup (l, g) {
    const community = ownCommunities.has(g.group) || linkedCommunities.has(g.group)
    const items = new Map()
    let after = null
    let incomplete = false
    for (let n = 0; n < MAX_GROUP_PAGES; n++) {
      let page
      await groupRequestSlot(l)
      if (ending || link !== l || l.groupsBroken || l.groups === null) return
      try {
        page = await l.groups.requestWriters({ group: g.group, after, limit: GROUPS_LIMIT_MAX })
      } catch (err) {
        if (link !== l || ending || l.groupsUnsupported) return
        // A timeout ends only that channel: it opens again later on this
        // link. Any other failure (a closed channel, a dropped peer) ends
        // the pages of the link; the next link pages again.
        if (err && err.message === 'groups request timed out') {
          retryGroupsLater(l)
          return
        }
        l.groupsBroken = true
        softError('páginas de grupo indisponíveis')
        evaluate()
        return
      }
      if (ending || link !== l) return
      if (page.incomplete) incomplete = true
      for (const it of page.items) {
        // A community has no writers: only its root is ever gated under it,
        // and another listing is ignored before it can take a slot.
        if (community && it.key !== g.group) continue
        if (items.size >= MAX_GROUP_WRITERS) break
        if (!items.has(it.key)) items.set(it.key, it)
      }
      // A cursor that does not advance ends the pass with what came.
      if (page.next === null || (after !== null && page.next <= after)) break
      after = page.next
    }
    if (incomplete) {
      // The seeder does not know the whole set yet: what came is gated, but
      // the pass neither completes the goal nor confirms an own core (an
      // own writer missing from it is not 'synced'). A once run asks again.
      for (const it of items.values()) noteAdvertised(g, it)
      if (once) l.pageAgain = true
      pumpGroupGates()
      evaluate()
      return
    }
    if (g.probe === true && !items.has(g.group)) {
      groups.delete(g.group)
      track(groupKv(() => store.removeGroupReplica(storage, forgetListed(listedAtStart, g.group))), noop, noop)
      evaluate()
      return
    }
    g.items = items
    g.pagedOn = l
    for (const it of items.values()) noteAdvertised(g, it)
    emit({ event: 'group-paged', group: g.group, count: items.size })
    reportOwnGroups(l, g)
    checkMedia()
    pumpGroupGates()
    evaluate()
  }

  // The write gate of group writes: what the seeder's page says it holds of
  // each own core of group g (all groups when g is null: an older seeder).
  // What the seeder holds of an own group core: the larger of its page item
  // and what its replication peer on this link reports. Neither a missing
  // item (or an older seeder) nor a listed one is enough: until the peer has
  // synced, nothing is reported (ownGroupVerdict), so a device behind the
  // seeder never appends at a stale length and forks its own writer or root.
  function reportOwnGroups (l, g) {
    if (ending || link !== l) return
    for (const m of groupOwn) {
      if (g !== null && m.group !== g.group) continue
      const paged = groups.get(m.group)
      const it = paged !== undefined && paged.pagedOn === l ? paged.items.get(m.key) : undefined
      const length = m.core.length
      const verdict = ownGroupVerdict(length, it === undefined ? null : advertisedLength(it), seederPeerLength(m, l))
      if (verdict === null) {
        m.awaitingPeer = true
        continue
      }
      m.awaitingPeer = false
      const { theirs } = verdict
      const mark = length + '/' + theirs
      if (m.synced === mark) continue
      m.synced = mark
      if (verdict.behind) emit({ event: 'group-behind', key: m.key, length, theirs })
      else emit({ event: 'group-synced', key: m.key, length })
    }
  }

  // A writer page item: a foreign core not seen in this run gets an entry
  // and waits for its gate.
  function noteGroupItem (g, it) {
    if (ownGroupKeys.has(it.key)) return
    if (isBlockedKey(it.diary) || isBlockedKey(g.group)) return
    if (it.key === ownHex || follows.has(it.key)) return
    const known = groupCores.get(it.key)
    let hints = null
    if (known !== undefined) {
      // A hostile listing seen first must not hide the key for the run: a
      // gate refused on the hint alone (never stored, never purged) lets a
      // listing with another group, diary or seq be gated again, once each.
      const hint = g.group + ':' + it.diary + ':' + it.seq
      if (known.state !== 'failed' || known.kept === true || !HINT_REASONS.has(known.reason) || known.hints.has(hint) || known.hints.size >= MAX_GATE_HINTS) return
      groupCores.delete(it.key)
      hints = known.hints
    } else if (groupCores.size >= store.MAX_GROUP_REPLICAS) {
      return
    }
    const ge = newGroupEntry(it.key, g.group, it.diary, it.seq)
    // Stored or listed before this run's gate (a resting core gated again):
    // an eviction or an abandoned gate never purges it.
    ge.preStored = restingCores.has(it.key) || listedAtStart.has(it.key)
    if (hints !== null) ge.hints = hints
    groupCores.set(it.key, ge)
    if (ge.key === ge.group) return
    // A full (group, diary) still gates a listing with an earlier join than
    // a held writer, as a contender that takes no slot until proven.
    const { full, victim } = capVictim(heldWriters(ge), it.seq)
    if (!full) return
    if (victim === null || contenders(ge) >= MAX_CAP_CONTENDERS) failGroupEntry(ge, 'quota', { purge: false })
    else ge.contender = true
  }

  // The live accepted cores of ge's (group, diary) besides ge: only
  // accepted cores count, a listing nobody can prove takes no slot.
  function heldWriters (ge) {
    const out = []
    for (const x of groupCores.values()) {
      if (x !== ge && x.group === ge.group && x.diary === ge.diary && (x.state === 'active' || x.state === 'regate' || (x.state === 'pending' && x.reserved))) out.push(x)
    }
    return out
  }

  // The binding diary of `d` when this run already holds it open (the own
  // diary, a follow or a binding diary): never a second handle.
  function openBinding (d) {
    if (d === ownHex) return diary
    const f = follows.get(d)
    if (f !== undefined && f.core) return f.core
    const gd = groupDiaries.get(d)
    return gd !== undefined && gd.core ? gd.core : null
  }

  // The present length of a binding diary this run holds open: a deleted
  // post below a join never hides that join.
  function bindingPresent (d, core) {
    if (d === ownHex) return ownPresent()
    const f = follows.get(d)
    if (f !== undefined && f.core === core) return entryPresent(f)
    const gd = groupDiaries.get(d)
    return gd !== undefined && gd.core === core && gd.tracker ? gd.tracker.present() : 0
  }

  // Per binding diary, the on:true group-joins read so far this run: each
  // gate scans only the blocks that arrived since, never the whole diary
  // again (a long diary must not cost a full decode per gate).
  async function diaryJoins (d) {
    const core = openBinding(d)
    if (core === null) return null
    let state = joinCache.get(d)
    if (state === undefined || state.core !== core) {
      state = { core, length: 0, joins: [] }
      joinCache.set(d, state)
    }
    const end = Math.max(core.contiguousLength, bindingPresent(d, core))
    const fresh = []
    for (let seq = state.length; seq < end; seq++) {
      fresh.push({ seq, record: decodeBlock(await core.get(seq, { wait: false, raw: true })) })
    }
    state.length = Math.max(state.length, end)
    addJoins(state.joins, fresh)
    return state.joins
  }

  async function refineJoinSeqs (list) {
    for (const x of list) {
      if (!x.proven) continue
      let joins = null
      try {
        joins = await diaryJoins(x.diary)
      } catch {}
      x.seq = earliestJoin(x.seq, joins, x.group, x.key)
    }
  }

  function contenders (ge) {
    let n = 0
    for (const x of groupCores.values()) {
      if (x !== ge && x.contender && x.state === 'pending' && x.group === ge.group && x.diary === ge.diary) n++
    }
    return n
  }

  function pumpGroupGates () {
    if (ending || deadlineHit) return
    const l = seederLink()
    if (l === null) return
    // Roots first (a group's header and posts come before its many
    // writers), then the fewest attempts, an attempted core at the back.
    const order = [...groupCores.values()].sort((x, y) =>
      ((y.key === y.group) - (x.key === x.group)) || (x.attempts - y.attempts) || (x.lastAttempt - y.lastAttempt))
    for (const ge of order) {
      if (groupGating >= MAX_PARALLEL_GATES) return
      if (ge.state !== 'pending' || ge.gating || ge.waiting) continue
      if (ge.attempts >= MAX_GROUP_GATE_ATTEMPTS) continue
      let timeout = gateTimeoutMs
      if (once) {
        const left = deadline - Date.now()
        if (left < GATE_MIN_TIMEOUT_MS) return
        timeout = Math.min(gateTimeoutMs, left)
      }
      ge.gating = true
      ge.attempts++
      ge.lastAttempt = ++gateOrder
      groupGating++
      const p = gateGroupEntry(ge, l, timeout).catch(noop).finally(() => {
        ge.gating = false
        groupGating--
        inflight.delete(p)
        pumpGroupGates()
        evaluate()
      })
      inflight.add(p)
    }
  }

  // -> { raw, length, byteLength } of block 0 through the link's in-memory
  // core, or null when it did not come.
  async function probeGroupCore (l, key, timeout) {
    let held
    try {
      held = await acquireLinkCore(l, key)
    } catch {
      return null
    }
    try {
      if (l.noise.destroyed) return null
      let raw = null
      try {
        raw = await held.core.get(0, { raw: true, timeout })
      } catch {}
      return raw === null ? null : { raw, length: held.core.length, byteLength: held.core.byteLength }
    } finally {
      held.release()
      await held.closed
    }
  }

  // The binding in D: D's block 0 (certificate) and the join block the page
  // named. -> null when proven, a reason when refused, undefined when the
  // blocks did not come.
  async function proveGroupJoin (l, ge, timeout) {
    let lent
    try {
      lent = await lendCore(l, ge.diary)
    } catch (err) {
      return err && err.message === DIARY_UNAVAILABLE ? 'diary-unavailable' : undefined
    }
    try {
      let raw0 = null
      try {
        raw0 = await lent.core.get(0, { raw: true, timeout })
      } catch {}
      if (raw0 === null) return undefined
      if (ge.diary !== ownHex) {
        const reason = gateVerdict(raw0, ge.diary, association, gateOpts())
        if (reason) return reason
      }
      ge.diaryRaw0 = raw0
      let rawJ = null
      try {
        rawJ = await lent.core.get(ge.seq, { raw: true, timeout })
      } catch {}
      if (rawJ === null) return undefined
      let j = null
      try {
        j = validRecordCopy(decodeBlock(rawJ), ge.seq)
      } catch {}
      if (j === null || j.type !== 'group-join' || j.group !== ge.group || j.writer !== ge.key || j.on !== true) return 'unbound'
      return null
    } finally {
      lent.release()
    }
  }

  async function gateGroupEntry (ge, l, timeout) {
    const probe = await probeGroupCore(l, ge.key, timeout)
    if (ge.state !== 'pending' || ending) return
    if (probe === null) return gateUnanswered(ge)
    const verdict = groupVerdict(probe.raw, ge.key, ge.group, ge.diary, linkedCommunities.has(ge.group))
    if (verdict === 'not-community') return refuseNotCommunity(ge)
    if (verdict !== null) return failGroupEntry(ge, verdict, { purge: false })
    const proof = await proveGroupJoin(l, ge, timeout)
    if (ge.state !== 'pending' || ending) return
    if (proof === undefined) return gateUnanswered(ge)
    if (proof !== null) return failGroupEntry(ge, proof, { purge: false })
    ge.proven = true
    if (isBlockedKey(ge.diary)) return failGroupEntry(ge, 'blocked', { purge: false })
    if (isBlockedKey(ge.group)) return failGroupEntry(ge, 'blocked', { purge: false })
    if (overQuota(probe)) return failGroupEntry(ge, 'quota', { purge: false })
    if (ge.key !== ge.group) {
      // The earliest join the held binding diaries show, for the candidate
      // and every held writer: a later duplicate join named by the seeder
      // must never make an earlier writer look later and lose its slot.
      await refineJoinSeqs([ge, ...heldWriters(ge)])
      if (ge.state !== 'pending' || ending) return
      const { full, victim } = capVictim(heldWriters(ge), ge.seq)
      if (full && victim === null) return failGroupEntry(ge, 'quota', { purge: false })
      // Kept, not purged, as the core node does, unless still in regate.
      if (full) failGroupEntry(victim, 'quota', { purge: evictionPurges(victim.state, victim.preStored) })
      // The slot is taken at once: two contenders gated together must not
      // both pass the cap after one eviction.
      ge.reserved = true
    }
    const recheck = bindingRecheck(ge.diaryRaw0, ge.diary, ownHex, association, gateOpts(), isBlockedKey)
    if (recheck !== null) return failGroupEntry(ge, recheck, { purge: false })
    if (ge.key === ge.group) {
      ge.rootBound = true
      track(groupKv(() => store.addBoundRoot(storage, ge.key)), noop, () => log('aviso: falha ao gravar o grupo ' + key8(ge.key)))
    }
    let core
    try {
      core = await store.openGroupReplica(storage, ge.key)
    } catch {
      ge.reserved = false
      if (!ended) log('aviso: falha ao abrir o núcleo de grupo ' + key8(ge.key))
      return gateUnanswered(ge)
    }
    ge.reserved = false
    if (ending || ge.state !== 'pending' || link !== l) {
      // A core stored before this gate stays; a new one goes, inside the
      // kv chain like every other group purge.
      track(groupKv(async () => {
        await core.close().catch(noop)
        if (!ge.preStored) await store.purgeGroupCore(storage, ge.key)
      }), noop, () => log('aviso: falha ao limpar núcleo de grupo ' + key8(ge.key)))
      return
    }
    ge.raw0 = probe.raw
    ge.state = 'regate'
    watchGroupEntry(ge, core)
  }

  // Nothing came within the timeout: a continuous run asks again later; a
  // once run keeps the core as an unmet goal.
  function gateUnanswered (ge) {
    if (ending) return
    emit({ event: 'group-unanswered', key: ge.key, group: ge.group, attempts: ge.attempts })
    if (once) return
    ge.waiting = true
    ge.retryTimer = later(() => {
      ge.retryTimer = null
      ge.waiting = false
      pumpGroupGates()
    }, GATE_RETRY_MS)
  }

  function unmetGroupGoals (withPushes) {
    const unmet = []
    const l = seederLink()
    const paging = l === null || !l.groupsUnsupported
    for (const g of groups.values()) {
      if (isBlockedKey(g.group)) continue
      if (paging && (l === null || g.pagedOn !== l)) unmet.push(g.group + ':pages')
    }
    for (const ge of groupCores.values()) {
      if (ge.state === 'failed' || ge.state === 'failing') continue
      if (!groups.has(ge.group) || isBlockedKey(ge.group)) continue
      const g = groups.get(ge.group)
      const it = g.items.get(ge.key)
      // An over-quota listing sets no goal for a held core.
      const advertised = it !== undefined && it.length > maxLogBlocks ? 0 : advertisedLength(it)
      if (ge.state === 'pending' || ge.state === 'regate') {
        unmet.push(ge.key + ':0/' + advertised)
        continue
      }
      const want = Math.max(ge.core.length, advertised)
      if (ge.core.contiguousLength < want) unmet.push(ge.key + ':' + ge.core.contiguousLength + '/' + want)
    }
    // A binding diary is a goal from ensureGroupDiary on: still opening,
    // waiting to attach, or downloading up to its join.
    for (const gd of groupDiaries.values()) {
      if (gd.core === null) {
        unmet.push(gd.key + ':0/' + gd.want)
        continue
      }
      const want = Math.max(gd.core.length, gd.want)
      const ours = gd.tracker ? gd.tracker.present() : 0
      if (ours < want) unmet.push(gd.key + ':' + ours + '/' + want)
    }
    // A seeder from before groups never opens a peer for an own group core:
    // waiting for its push would hold a once run to the deadline.
    if (withPushes && !(l !== null && l.groupsUnsupported)) {
      for (const m of groupOwn) {
        if (isBlockedKey(m.group) || m.core.length < 1 || m.pushed === m.core.length) continue
        unmet.push(m.key + ':push ' + m.core.length)
      }
    }
    return unmet
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
    await openGroups()
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
    let stopOpens = false // pass 3 is over: no new opens (a failed purge, a throw)
    const workers = []
    for (let w = 0; w < Math.min(MAX_PARALLEL_OPENS, items.length); w++) {
      workers.push((async () => {
        while (nextOpen < items.length) {
          if (stopOpens) break
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
          discardedRegate: false,
          newestSent: new Set(), // lengths whose `newest` line was emitted
          newestHeld: 0 // a `newest` length seen in regate
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
          if (reason === 'revoked-issuer') revokedDiaries.add(key)
          skipped.push({ key, reason })
          emit({ event: 'skipped', key, reason })
        }
      }
    } finally {
      stopOpens = true
      await Promise.all(workers)
      for (const slot of slots) {
        if (slot === null || slot.core === null) continue
        const core = slot.core
        slot.core = null
        await core.close().catch(noop)
      }
    }

    // Binding diaries only once the follows hold their replicas (a followed
    // diary is never opened twice).
    if (!ending) await startGroupDiaries()
    if (!ending) await updateReplicaIndex()
    // Stored replicas of blocked keys, and unfollowed ones from a revoked
    // issuer, go before any connection.
    if (!ending) await sweepBlocked()
    if (!ending && blocklist.revokedIssuers().size > 0) await sweepRevoked()
    // The stored group cores accepted again at start: their authors'
    // issuers are checked against the stored snapshot.
    if (!ending && blocklist.revokedIssuers().size > 0) await sweepRevokedGroups()

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
    discardGroupRegate()
    await Promise.allSettled([...inflight])
    clearReader(reader)
    await drained
    for (const ge of groupCores.values()) {
      stopGroupEntry(ge)
      if (ge.core) {
        const core = ge.core
        ge.core = null
        await core.close().catch(noop)
      }
    }
    for (const e of follows.values()) {
      stopEntry(e)
      if (e.core) {
        const core = e.core
        e.core = null
        await core.close().catch(noop)
      }
    }
    for (const gd of [...groupDiaries.values()]) {
      await gd.opening
      const c = detachGroupDiary(gd, { unlist: false })
      if (c !== null) await c.close().catch(noop)
    }
    while (settling.size > 0) await Promise.allSettled([...settling])
    mediaTimer = null
    for (const m of [...media.splice(0), ...groupOwn.splice(0)]) {
      m.stop()
      await m.core.close().catch(noop)
    }
    if (diary) await diary.close().catch(noop)
  }
}

module.exports = { runSync, addJoins, earliestJoin, groupPushHeld, ownGroupVerdict, bindingRecheck, forgetListed, evictionPurges, capVictim, capExcess, storedJoinProof, refineJoinSeq, gateVerdict, trackPresent, linearExcept, MAX_RANGES, NEWEST_BLOCKS, TAIL_MAX, HEAD_LOW, HEAD_STALL_MS, GATE_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_PARALLEL_GATES, MAX_PARALLEL_OPENS, SEEDER_UNAVAILABLE, DIARY_UNAVAILABLE }
