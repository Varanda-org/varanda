// Member sync (docs §6): gates every followed log on its block 0, replicates
// the own diary and the accepted replicas with peers and seeders, and in
// --once mode resolves when the goals G1/G2/G3 hold.
// TODO(phase1): push notifications when a followed log grows.
// The hosted Web Push relay (push-events.js) does not cover this case.
//
// Follow entry states:
//   pending  nothing stored; advertised with length 0; the remote (quarantine)
//            gate runs when a peer advertises the key with length >= 1
//   regate   remote gate passed and the replica is open in the main store, but
//            block 0 has not yet arrived there and passed the LOCAL gate; still
//            advertised with length 0, absent from downloaded, G1 unmet
//   active   local gate passed; live download, advertised with its present
//            length (lib/deletion.js: deleted holes do not stop it)
//   failing  gate failed or fork: its close + purge is in flight (completion
//            is blocked until the purge settles)
//   failed   skipped; excluded from every goal
//
// Moderation (B2, docs/protocol.md "Blocklist snapshot"): the run enforces
// the newest signed snapshot it holds (blocklist.json) and adopts newer ones
// from any peer over 'varanda/blocklist/1'. A blocked key other than our own
// is never fetched, opened or advertised, and its stored replica is purged
// whether it is followed or not (store.replicate serves every stored core to
// a peer that knows its discovery key); a followed one is skipped with reason
// 'blocked' and stays in follows.json, so an unblock needs no new follow. A
// diary whose v2 certificate comes from a revoked issuer is treated the same
// way with reason 'revoked-issuer'.
//
// Groups (docs/protocol.md section 10): the own writer cores listed in
// groups.json are opened and replicated (never in hello/have). Writer sets
// come from verified seeders over 'varanda/groups/1', a page at a time. Each
// foreign writer W is gated before the main store holds it: its block 0 must
// be a header naming the group and a diary D, D's block 0 must certify D and
// D's block at the join seq must be a group-join on:true naming W, all read
// through the quarantine on the same sockets (or from the main store when it
// already holds them). The join block only proves the binding: membership
// ends with a group-leave inside the writers (lib/group.js), so a later
// on:false never purges a writer here. A writer goes when D, W or the group
// is blocked, D's issuer is revoked, or it forks. --once adds the group
// goal: every writer page fetched with incomplete false, every admitted
// foreign writer (and the diary that binds it) at its advertised length, and
// every own writer listed by a seeder at its full length.
const process = require('#process')
const path = require('#path')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const {
  openStore,
  openDiary,
  openReplica,
  openQuarantine,
  removeQuarantine,
  purgeReplica,
  readConfig,
  readFollows,
  readBlocklist,
  writeBlocklist,
  replicaStored,
  openGroupWriter,
  openGroupReplica,
  readGroups,
  readAll,
  readJson,
  writeJsonAtomic
} = require('./store')
const { genesisCert, decodeBlock, validateRecord, validRecordCopy, MAX_LOG_BLOCKS, MAX_LOG_BYTES } = require('./records')
const { certForKey, seederCertForKey } = require('./cert')
const { createBlocklistState, verifySnapshot, compareSnapshots } = require('./blocklist')
const { attachBlocklist } = require('./blocklist-net')
const { validateGroupHeader, validateWriterHeader, MAX_GROUP_WRITERS, MAX_GROUPS_PER_DIARY, MAX_GROUP_WRITERS_PER_DIARY } = require('./group')
const { attachGroups, GROUPS_LIMIT_MAX, GROUPS_REQUEST_TIMEOUT_MS, MESSAGE_BURST: GROUPS_BURST, MESSAGE_RATE: GROUPS_RATE } = require('./groups-net')
const {
  presentState,
  presentLength,
  clearDeleted,
  downloadExcept
} = require('./deletion')
const {
  createSwarm,
  topicFor,
  joinAndFlush,
  startRediscovery,
  attachAdmission,
  refuseOverConnectionLimit,
  watchContiguous,
  watchPresent,
  watchFork,
  startQuarantineFetch,
  MAX_CONNECTIONS,
  MAX_INVENTORY,
  MESSAGE_BURST,
  MESSAGE_RATE
} = require('./net')

const GATE_TIMEOUT_MS = 15000
const GATE_MIN_TIMEOUT_MS = 250
const GATE_RETRY_MS = 15000
const GRACE_MS = 5000
const REDISCOVER_ONCE_MS = 1000
const REDISCOVER_LONG_MS = 10000
// Security audit S2 / H1: ONE run-level budget for unverified peers (anyone
// who is not a verified seeder). It starts at the first hello of such a peer
// in --once mode; once it expires, their length claims (G1), their interest
// in our diary (G3) and their incomplete inventories no longer affect the
// goals for the rest of the run, whatever their identity, number or progress.
const UNVERIFIED_BUDGET_MS = 5000
// Writer pages are fetched again after this pause: in --once mode until the
// group goal holds (an incomplete page is never retried in a tight loop),
// in long-running mode to learn new writers.
const PAGE_RETRY_ONCE_MS = 1000
const PAGE_RETRY_LONG_MS = 10000
// Long-running mode pages a group again after this long, or sooner when the
// seeder sent a `have` or a known writer of the group grew.
const PAGE_REFRESH_LONG_MS = 60000
const MAX_WRITER_PAGES = Math.ceil(MAX_GROUP_WRITERS / GROUPS_LIMIT_MAX)
// Writer page requests per connection: a burst of an eighth and half the
// refill rate of the seeder's bucket (groups-net.js), so paging never gets
// the socket dropped for 'message-rate' (that would cut diary replication).
const GROUP_REQUEST_BURST = Math.floor(GROUPS_BURST / 8)
const GROUP_REQUEST_RATE = GROUPS_RATE / 2
// Page items whose diary or join seq a gate disproved, per seeder, before
// this run stops paging that seeder.
const MAX_BAD_HINTS = 32
// Gates in flight per hinted (group, diary) beyond the per-diary cap: a
// gated writer takes a cap slot only once its gate proves its diary and join.
const MAX_CAP_CONTENDERS = 2
// Gate timeouts of one writer key per seeder in a --once run.
const MAX_GATE_TIMEOUTS = 2
// Gate timeouts of unstored writers one seeder's listings may cause in a
// --once run before that seeder is no longer paged.
const MAX_TIMEOUT_HINTS = 16
// Soft error strings one run keeps (the group-writer timeouts count as one),
// and the writer keys named in the group-writer timeout line.
const MAX_SOFT_ERRORS = 32
const MAX_SOFT_SAMPLE = 3
// Hard error strings one run keeps (group writer block-0 divergences count
// as one).
const MAX_HARD_ERRORS = 32

// Token bucket that reserves one request at a time: reserve() takes a token
// (the balance may go negative while requests queue) and returns how many
// ms to wait before sending.
function createRequestPacer ({ burst = GROUP_REQUEST_BURST, rate = GROUP_REQUEST_RATE, now = Date.now } = {}) {
  let tokens = burst
  let last = now()
  return {
    reserve () {
      const t = now()
      tokens = Math.min(burst, tokens + (t - last) * rate / 1000)
      last = t
      tokens -= 1
      return tokens >= 0 ? 0 : Math.ceil(-tokens * 1000 / rate)
    }
  }
}

const HEX64 = /^[0-9a-f]{64}$/
const NONCE = /^[0-9a-f]{32}$/
const MAX_BOUND_ROOTS = 256
// The community roots one group root makes the node follow: the same
// bound as member.js MAX_COMMUNITY_ROOTS (the roots a group fold reads).
const MAX_COMMUNITY_ROOTS = 32
const BYTES_HEX = /^(?:[0-9a-f]{2})+$/

// Roots this node saw bound by their creator's diary (its own fold or a
// gate that proved the creator's join), kept in bound-roots.json: once the
// creator's replica is gone, only this record lets a block of the creator
// take the root, and a root never seen bound is kept.
// Protecting every run from failing on a damaged record: an unreadable or
// malformed file reads as no record.
function readBoundRoots (dataDir) {
  let data = null
  try {
    data = readJson(path.join(dataDir, 'bound-roots.json'), null)
  } catch {}
  return data && data.v === 1 && Array.isArray(data.roots) ? data.roots.filter((r) => typeof r === 'string' && HEX64.test(r)) : []
}

function recordBoundRoot (dataDir, root) {
  if (typeof root !== 'string' || !HEX64.test(root)) return
  const roots = readBoundRoots(dataDir)
  if (roots.includes(root)) return
  roots.push(root)
  writeJsonAtomic(path.join(dataDir, 'bound-roots.json'), { v: 1, roots: roots.slice(-MAX_BOUND_ROOTS) }, 0o600)
}

// Block 0 (the certificate) of each binding diary whose foreign writer or
// root activated here, kept in group-certs.json, newest last, as kv
// groupCerts in the browser. Protecting the revocation of an issuer from a
// seeder that never served the binding diary to the main store: a restart
// still judges the writer by the certificate its gate verified.
// Protecting every run from failing on a damaged record: an unreadable or
// malformed file, or entry, reads as no record.
function readGroupCerts (dataDir) {
  let data = null
  try {
    data = readJson(path.join(dataDir, 'group-certs.json'), null)
  } catch {}
  const out = new Map()
  if (!data || data.v !== 1 || !Array.isArray(data.certs)) return out
  for (const e of data.certs) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !HEX64.test(e[0]) || typeof e[1] !== 'string' || !BYTES_HEX.test(e[1])) continue
    out.delete(e[0])
    out.set(e[0], b4a.from(e[1], 'hex'))
  }
  return out
}

function writeGroupCerts (dataDir, certs, limit) {
  const entries = [...certs].slice(-Math.max(1, limit)).map(([d, raw]) => [d, b4a.toString(raw, 'hex')])
  writeJsonAtomic(path.join(dataDir, 'group-certs.json'), { v: 1, certs: entries }, 0o600)
}

function noop () {}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

// Block-0 verdict (docs §5, identical in the seeder): null = accepted.
// `revokedIssuers` (the current snapshot's Set, or null) makes a v2
// certificate from a revoked issuer 'revoked-issuer' (cert.js).
function gateVerdict (raw, keyHex, associationHex, revokedIssuers = null) {
  try {
    const block0 = decodeBlock(raw)
    if (block0 === null || validateRecord(block0, 0) !== null) return 'not-in-log'
    const r = certForKey(block0.cert, keyHex, associationHex, { revokedIssuers })
    return r.ok ? null : r.reason
  } catch {
    return 'not-in-log'
  }
}

// Block-0 verdict of a group core `key` claimed for `group` and diary
// `diary` (same verdicts as the seeder): null = accepted. A root is judged
// by its own block 0 against a role fixed for the whole run, never against
// a link view that moves while it is gated: `linkedOnly` marks a `group`
// this node pages only because a group root's community-link names it
// (a community root wherever named; a group header there is this node's
// own verdict 'not-community'), else it is a group this node joined (a
// group header; a community has no writers to join with).
function groupHeaderVerdict (raw, key, group, diary, linkedOnly = false) {
  try {
    const header = decodeBlock(raw)
    if (header === null) return 'header-invalid'
    if (key === group) {
      // This version folds public groups only: a private root would be
      // joined and fetched but never folded.
      if (validateGroupHeader(header) !== null || header.visibility !== 'public') return 'header-invalid'
      if (linkedOnly && header.kind === 'group') return 'not-community'
      if (header.kind !== (linkedOnly ? 'community' : 'group')) return 'header-invalid'
    } else {
      if (validateWriterHeader(header) !== null) return 'header-invalid'
      if (header.group !== group) return 'wrong-group'
    }
    return header.diary === diary ? null : 'wrong-diary'
  } catch {
    return 'header-invalid'
  }
}

// The diary a group core's own block 0 names when it is a valid header for
// `group`, else null.
function headerDiary (raw, key, group, linkedOnly = false) {
  try {
    const header = decodeBlock(raw)
    if (header === null || typeof header.diary !== 'string') return null
    return groupHeaderVerdict(raw, key, group, header.diary, linkedOnly) === null ? header.diary : null
  } catch {
    return null
  }
}

// Verdicts that only say the page item's diary or join seq was wrong: they
// judge the hint, never the writer.
function hintMismatch (reason) {
  return reason === 'wrong-diary' || reason === 'wrong-group' || reason === 'unbound' || reason === 'not-in-log'
}

// The diary block at `seq` must be a group-join on:true naming the writer.
function joinVerdict (raw, seq, group, writer) {
  try {
    const record = decodeBlock(raw)
    if (record === null || validateRecord(record, seq) !== null || record.type !== 'group-join') return 'unbound'
    return record.group === group && record.writer === writer && record.on === true ? null : 'unbound'
  } catch {
    return 'unbound'
  }
}

async function localGate (core, keyHex, associationHex, revokedIssuers = null) {
  try {
    const raw = await core.get(0, { wait: false, raw: true })
    return gateVerdict(raw, keyHex, associationHex, revokedIssuers)
  } catch {
    return 'not-in-log'
  }
}

// Target seq of the valid tombstone at block seq, null for any other block
// or a read error (the same checks as tombstoneAt, read once).
async function tombstoneTarget (core, seq) {
  try {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq >= core.length || !(await core.has(seq))) return null
    const copy = validRecordCopy(decodeBlock(await core.get(seq, { wait: false, raw: true })), seq)
    return copy !== null && copy.type === 'delete' ? copy.seq : null
  } catch {
    return null
  }
}

// The deletion fold (lib/deletion.js) over tombstones already validated, as
// seq -> target: highest block first, a tombstone counts unless a counted
// one deleted it. Equal to deletedSeqs without copying every record again.
function foldTargets (tombs) {
  const deleted = new Set()
  for (const seq of [...tombs.keys()].sort((a, b) => b - a)) {
    if (!deleted.has(seq)) deleted.add(tombs.get(seq))
  }
  return deleted
}

function sameSet (a, b) {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

// The download range of a followed diary. While nothing is deleted it is one
// linear range (Hypercore otherwise requests from a random offset, so a
// follower stores blocks out of order and readAll sees a gap until the end);
// from the first deletion on it is downloadExcept, which never asks a stale
// peer for a deleted block. Same { update, destroy, idle } as downloadExcept.
function followRange (core, deleted) {
  if (deleted.size > 0) return downloadExcept(core, deleted)
  const linear = core.download({ start: 0, end: -1, linear: true })
  let except = null
  let destroyed = false
  return {
    async update (next) {
      if (destroyed) return []
      if (except !== null) return except.update(next)
      linear.destroy()
      except = downloadExcept(core, next)
      return clearDeleted(core, next)
    },
    destroy () {
      if (destroyed) return
      destroyed = true
      if (except !== null) except.destroy()
      else linear.destroy()
    },
    idle () {
      return except !== null ? except.idle() : Promise.resolve()
    }
  }
}

// purgeHook(key, store) replaces purgeReplica for every purge of this run,
// regateHook(key) returns a verdict (string) that overrides the local re-gate
// of a replica opened after a remote pass (null/undefined = run the real
// gate) and joinHook(swarm, topics) replaces joinAndFlush. All three are
// test-only hooks, as are inspectHook (called once with { claimCount(),
// topicHasPeer(topic), lastClosedPeer(), recomputeCount(), groupTargetCount(),
// groupCoreCount(), swarmTopicCount(), createMemo(limit)
// (a gate memory of this run's mode), divergeDiary(key) (the verdict of a
// binding diary whose stored blocks differ from the gated ones),
// hardError(msg) and groupDiverged(key) (record a hard error, a group
// writer's block-0 divergence) }: the number
// of G1 claims held across every follow entry, the re-discovery predicate,
// the peer object of the last closed admission channel, the number of
// deletion recomputes run so far and the size of the group target map) and
// the injectable limits
// (unverifiedBudgetMs, maxLogBlocks, maxLogBytes, maxConnections,
// maxFetchSockets (the open sockets per gate fetch, default maxConnections),
// gateTimeoutMs, messageBurst, messageRate, maxGroupWriters (the foreign
// writer cores one group may hold, active or on disk), and for writer pages
// pageRetryMs, pageRefreshMs, groupRequestTimeoutMs), whose defaults are the
// protocol constants. releaseHook(key) is awaited by the release of a
// binding diary before its session closes (test-only).
async function runSync ({
  dataDir,
  associationKey = null,
  bootstrap,
  host,
  once = false,
  timeoutMs = 30000,
  log = noop,
  onEvent = noop,
  signal,
  purgeHook = null,
  regateHook = null,
  joinHook = null,
  unverifiedBudgetMs = UNVERIFIED_BUDGET_MS,
  maxLogBlocks = MAX_LOG_BLOCKS,
  maxLogBytes = MAX_LOG_BYTES,
  maxConnections = MAX_CONNECTIONS,
  maxFetchSockets = maxConnections,
  maxFollows = MAX_INVENTORY - 1,
  gateTimeoutMs = GATE_TIMEOUT_MS,
  maxGroupWriters = MAX_GROUP_WRITERS,
  messageBurst = MESSAGE_BURST,
  messageRate = MESSAGE_RATE,
  openHook = null,
  pageRetryMs = once ? PAGE_RETRY_ONCE_MS : PAGE_RETRY_LONG_MS,
  pageRefreshMs = PAGE_REFRESH_LONG_MS,
  groupRequestTimeoutMs = GROUPS_REQUEST_TIMEOUT_MS,
  inspectHook = null,
  releaseHook = null,
  // true (or VARANDA_NO_CLEAR=1, the rollout kill switch) keeps the bytes of
  // deleted blocks and every unfollowed replica, as before deletion existed;
  // deleted blocks still do not hold the present length back.
  noClear = false,
  // Forwarded as is to openStore and openQuarantine (lib/store.js: lock
  // mode, recover, suspend); undefined = their defaults.
  storeOptions
} = {}) {
  // The trust root is checked before anything touches the data dir.
  const config = readConfig(dataDir)
  if (!config || config.role !== 'member') throw new Error('identidade não encontrada')
  if (associationKey && associationKey.toLowerCase() !== config.association) {
    throw new Error('associação diferente da configurada')
  }
  const association = config.association
  const clearing = noClear !== true && (process.env || {}).VARANDA_NO_CLEAR !== '1'
  const started = Date.now()
  const deadline = started + timeoutMs

  let store = null
  let qstore = null
  let swarm = null
  let diary = null
  let ownHex = null
  let cert = null
  let stopDiaryWatch = null
  let stopRediscovery = null
  let graceTimer = null
  let deadlineTimer = null
  let graceDone = false
  let ending = false // finish() started: no new work, waiting for purges/gates
  let ended = false // result built
  let deadlineHit = false
  let fatal = null
  let result = null
  let settle
  const finished = new Promise((resolve) => { settle = resolve })
  const timers = new Set()
  const inflight = new Set() // quarantine fetches
  const settling = new Set() // purges and local re-gates finish() waits for
  const peers = new Set()
  let lastClosedPeer = null // test-only (inspectHook)
  let recomputes = 0 // test-only (inspectHook)
  const follows = new Map() // key -> entry
  const topicKeys = new Map() // topic hex -> key hex (own diary and follows)
  const skipped = []
  const errorsSoft = []
  // Group writers a gate timed out on: a count and a few keys, never one
  // string per writer.
  let groupTimeouts = 0
  const groupTimeoutSample = []
  const hardErrors = [] // make the result ok: false without ending the run
  // Group writers whose main-store block 0 was not the gated one: a count
  // and a few keys, never one string per writer.
  let groupDivergences = 0
  const groupDivergenceSample = []
  let rendezvousHex = null
  let liveConnections = 0 // open sockets (counted on connect, decremented on close)
  const topicConnections = new Map() // topic hex -> Set of open sockets discovered on it
  let admittedEver = false
  let rejectedReason = null
  let budgetStarted = false // the unverified-peer budget (H1) is running or over
  let budgetExpired = false
  let confirmedLength = -1 // diary.length when G2 last held with a verified seeder
  const signalHandlers = []
  let blocklist = null // createBlocklistState (blocklist.js), ready before any follow or peer
  let blocklistGen = 0 // bumped on every adoption: gates started earlier run again
  const blocklistHandles = new Set() // open 'varanda/blocklist/1' handles (fan-out, C4)
  const purgeChains = new Map() // key -> the last purge of that key (serialized per key)
  const releasing = new Map() // binding diary key -> its release (close and purge) in flight
  let warnedOwnBlocked = false
  let warnedOwnRevoked = false
  const groupList = [] // groups.json entries whose own writer opened: { group, writer, nonce }
  const groupSet = new Set() // the groups of groupList
  // Communities (docs/protocol.md section 10 "Communities"): own community
  // roots listed in groups.json, and every community root a held group
  // root's community-link records ever named, on or off (acts taken while
  // a community was linked stay valid after an unlink, so the fold needs
  // that root). Per group root at most MAX_COMMUNITY_ROOTS distinct keys in
  // root order of first appearance, the keys member.js folds; a key past
  // the cap is not followed and the fold reads as incomplete. Each is paged
  // like a group whose only core is its root, so a run holds at most
  // groupList.length * MAX_GROUP_WRITERS group cores plus
  // groupList.length * MAX_COMMUNITY_ROOTS community roots (coreLimit),
  // each community root with its one creator diary.
  const ownCommunities = new Set() // groups.json entries whose own root is a community header
  const linkedCommunities = new Map() // community key -> Set of groups whose root named it
  const linkScans = new Map() // group -> { core, length, named, run, again }
  let linksReady = false // own roots are scanned (and rescanned on growth) once startup reaches the scan
  const ownWriters = new Map() // own writer key -> { group, core }
  const groupCores = new Map() // foreign writer key -> entry (gating, active, failing, failed)
  const groupDiaries = new Map() // diary key -> { core, range, stopFork, stopQuota, want, failed }
  const qchains = new Map() // key -> the last group quarantine read of that key
  const revokedDiaries = new Set() // diaries purged in this run for a revoked issuer
  const forkedDiaries = new Set() // binding diaries that forked in this run
  const divergedDiaries = new Set() // binding diaries whose stored blocks were not the gated ones, in this run
  const groupTargets = new Map() // writer admitted in groupCores -> largest length (clamped) any seeder advertised in this run
  // Run-wide memories of the group gate (I3): bounded, expiring in
  // long-running mode.
  const gateLimit = coreLimit
  const failedHints = createMemo(gateLimit) // 'group:key:diary:seq' page items a gate disproved
  const localSkips = createMemo(gateLimit) // page items refused for this node's own verdict on the hinted diary (never charged)
  const refused = createMemo(gateLimit) // 'group:key' refused by the writer's own data
  const capRefused = createMemo(gateLimit) // 'group:key' refused for the per-diary cap whose skip was emitted
  const provenLater = createMemo(gateLimit) // 'group:key' -> verified diary whose cap its proven join lost
  const joinCache = new Map() // binding diary -> { core, length, joins } read for the per-diary cap
  const failedWriters = createMemo(gateLimit) // 'group:key' accepted, then failed (fork, quota): not gated again
  // Foreign writer key -> { group, diary } of a writer core on disk that
  // holds its per-diary cap slot for the run: stored when the run started,
  // or kept after a quota stop. Mirrors the disk, so it never expires; a
  // purge removes the key, and so does a refusal for the cap.
  const diskSlots = new Map()
  let groupCerts = new Map() // binding diary -> gate-verified block 0 (group-certs.json), mirrored on disk
  const rescanDue = new Set() // groups whose items were refused while groupCores was full
  // Stored foreign writer or root core -> the binding diary its block 0
  // names, and diary -> how many of them name it. A diary they name stays
  // stored (the group fold and the group-certs.json evidence read it).
  const storedNamer = new Map()
  const namedCount = new Map()
  const quotaListed = createMemo(gateLimit) // writers listed above the log quota whose skip was emitted

  // A bounded memory: when full the oldest entry goes; in long-running mode
  // an entry also expires after pageRefreshMs.
  function createMemo (limit) {
    const m = new Map()
    const fresh = (v) => once || Date.now() - v.at <= pageRefreshMs
    const prune = () => { for (const [k, v] of m) if (!fresh(v)) m.delete(k) }
    return {
      has (k) {
        const v = m.get(k)
        if (v === undefined) return false
        if (fresh(v)) return true
        m.delete(k)
        return false
      },
      value (k) {
        return this.has(k) ? m.get(k).value : undefined
      },
      add (k, value = true) {
        m.delete(k)
        if (m.size >= limit()) prune()
        while (m.size >= limit()) m.delete(m.keys().next().value)
        m.set(k, { at: Date.now(), value })
      },
      delete (k) {
        m.delete(k)
      },
      get size () {
        prune()
        return m.size
      },
      * entries () {
        prune()
        for (const [k, v] of m) yield [k, v.value]
      }
    }
  }

  const emit = (ev) => {
    try {
      onEvent(ev)
    } catch {}
  }
  // Protecting a long-running run from a peer that makes it fail on fresh
  // keys forever (memory, and the O(n) dedupe): the list is capped, and
  // group-writer timeouts aggregate into one counted line.
  const softError = (msg) => {
    if (errorsSoft.length >= MAX_SOFT_ERRORS - 1 || errorsSoft.includes(msg)) return
    errorsSoft.push(msg)
  }
  const groupTimeoutError = (key) => {
    groupTimeouts++
    const k = key8(key)
    if (groupTimeoutSample.length < MAX_SOFT_SAMPLE && !groupTimeoutSample.includes(k)) groupTimeoutSample.push(k)
  }
  const softErrors = () => {
    const out = errorsSoft.slice()
    if (groupTimeouts > 0) out.push('núcleos de grupo indisponíveis: ' + groupTimeouts + ' (' + groupTimeoutSample.join(', ') + ')')
    return out
  }
  // Protecting a long-running run from a peer that serves divergent cores
  // on fresh keys forever: the list is capped like the soft one.
  const hardError = (msg) => {
    if (hardErrors.length >= MAX_HARD_ERRORS - 1 || hardErrors.includes(msg)) return
    hardErrors.push(msg)
  }
  const groupDivergedError = (key) => {
    groupDivergences++
    const k = key8(key)
    if (groupDivergenceSample.length < MAX_SOFT_SAMPLE && !groupDivergenceSample.includes(k)) groupDivergenceSample.push(k)
  }
  const hardErrorList = () => {
    const out = hardErrors.slice()
    if (groupDivergences > 0) out.push('bloco 0 divergente em escritores de grupo: ' + groupDivergences + ' (' + groupDivergenceSample.join(', ') + ')')
    return out
  }

  // Purges of one key run one after the other: a moderation sweep may purge a
  // key whose follow purge is still in flight, and two concurrent purges of
  // the same core would race (hypercore purge closes every session). With
  // `ifStored` the purge is skipped when the main store holds no such core
  // (checked inside the chain, after any earlier purge of the key settled),
  // so no empty core is created just to be purged. A core this device
  // writes (the own diary, a group root or writer it created, listed in
  // groups.json or not) is never purged, whatever path asked for it.
  function purgeKey (key, { ifStored = false } = {}) {
    return serialized(key, async () => {
      if (ownKey(key)) return
      if (await replicaStored(store, key)) {
        if (await writableCore(key)) return
      } else if (ifStored) {
        return
      }
      await (purgeHook ? purgeHook(key, store) : purgeReplica(store, key))
      const slot = diskSlots.get(key)
      diskSlots.delete(key)
      if (slot) slotFreed(slot.group)
      const named = forgetNamer(key)
      if (named !== null) releaseDiary(named)
    })
  }

  function ownKey (key) {
    return key === ownHex || ownWriters.has(key)
  }

  // Whether a STORED core is ours to write (corestore knows its key pair).
  async function writableCore (key) {
    const probe = store.get({ key: b4a.from(key, 'hex'), active: false })
    try {
      await probe.ready()
      return probe.writable
    } finally {
      await probe.close().catch(noop)
    }
  }

  // Resolves once no release or purge of key is in flight. Not for use
  // inside serialized(key): it would wait on its own chain.
  async function releaseSettled (key) {
    while (releasing.has(key) || purgeChains.has(key)) {
      await (releasing.get(key) || purgeChains.get(key)).catch(noop)
    }
  }

  // Runs fn after every earlier serialized operation on key settled (the
  // per-key chain of purgeKey; the revoked-issuer sweep reads in it too).
  function serialized (key, fn) {
    const prev = purgeChains.get(key) || Promise.resolve()
    const p = prev.catch(noop).then(fn)
    purgeChains.set(key, p)
    const done = () => { if (purgeChains.get(key) === p) purgeChains.delete(key) }
    p.then(done, done)
    return p
  }

  // ---- moderation (B2) ----

  // A key other than our own that the current snapshot blocks. The own diary
  // is never blocked locally: it is still advertised (honest peers refuse
  // it) and never purged, which would not hide it anyway: store.replicate
  // serves every stored core to a peer that knows its discovery key
  // (docs/protocol.md:379), and the own diary is the one copy of it.
  function isBlockedKey (key) {
    return blocklist !== null && key !== ownHex && !ownWriters.has(key) && blocklist.blocked().has(key)
  }

  function revokedIssuers () {
    return blocklist === null ? null : blocklist.revokedIssuers()
  }

  // Every gate of the run: a blocked key fails before its block 0 is read.
  function verdictFor (key, raw) {
    return isBlockedKey(key) ? 'blocked' : gateVerdict(raw, key, association, revokedIssuers())
  }

  function gateLocal (core, key) {
    return isBlockedKey(key) ? Promise.resolve('blocked') : localGate(core, key, association, revokedIssuers())
  }

  // Moderation verdicts are not a divergent block 0 (regate below).
  function moderated (reason) {
    return reason === 'blocked' || reason === 'revoked-issuer'
  }

  // Logged once per run each.
  function warnOwn () {
    if (blocklist === null || ownHex === null) return
    if (!warnedOwnBlocked && blocklist.blocked().has(ownHex)) {
      warnedOwnBlocked = true
      log('aviso: sua identidade está bloqueada pela associação')
    }
    if (!warnedOwnRevoked && cert !== null && certForKey(cert, ownHex, association, { revokedIssuers: revokedIssuers() }).reason === 'revoked-issuer') {
      warnedOwnRevoked = true
      log('aviso: o emissor do seu certificado foi revogado pela associação')
    }
  }

  // Purges whatever the main store holds for key, after `after` (an
  // in-flight follow purge, never rejecting) settled. Tracked like every
  // purge: finish() waits for it and a failure makes the run fail.
  function purgeStored (key, after = null) {
    return track((async () => {
      if (after) await after
      await purgeKey(key, { ifStored: true })
    })(), noop, () => {
      if (!ended) purgeFailed(key)
      else log('aviso: falha ao limpar diário ' + key8(key))
    })
  }

  // C7: by storage, not by follow state. A followed key is skipped with
  // `reason` (unless it already is skipped) and whatever the store holds for
  // it is purged: failFollow returns at once for an entry already failing or
  // failed, and a quota failure keeps an active replica's blocks.
  // -> the tracked purge (callers that must not go on before it awaits it).
  function enforceBlock (key, reason) {
    if (ownKey(key)) return Promise.resolve()
    if (reason === 'revoked-issuer') revokedDiaries.add(key)
    const entry = follows.get(key)
    let after = null
    if (entry) {
      if (entry.state !== 'failing' && entry.state !== 'failed') failFollow(entry, reason, { purge: entry.core !== null })
      after = entry.purging || null
    }
    return purgeStored(key, after)
  }

  // A newly revoked issuer: every replica holding a v2 certificate from it
  // goes like a blocked author. A replica in regate whose block 0 has not
  // arrived yet is gated later with the new set (blocklistGen).
  function recheckRevoked (entry) {
    const core = entry.core
    if (!core) return
    track(localGate(core, entry.key, association, revokedIssuers()), (reason) => {
      if (reason !== 'revoked-issuer' || entry.core !== core) return
      if (entry.state !== 'active' && entry.state !== 'regate') return
      enforceBlock(entry.key, 'revoked-issuer')
    }, noop)
  }

  // Block-0 verdict of a core the main store holds, opened by discovery key
  // without creating anything: corestore 7.15 opens a discoveryKey-only
  // session through _preloadCheckIfExists, which throws STORAGE_EMPTY when
  // the core is absent (node_modules/corestore/index.js:636, :663-665), the
  // same kind of open its own purge uses (:405-423). Runs inside the key's
  // chain, so no purge of that key is in flight meanwhile. null = nothing to
  // judge: the core went meanwhile, or its block 0 is not stored locally
  // (wait: false). Such a core is left alone: a replica only enters the main
  // store after its block 0 passed the remote gate, and one still waiting
  // for block 0 is a follow in regate, gated again with the new set
  // (blocklistGen) when it arrives; without block 0 nothing certifies it.
  async function storedVerdict (dk, key) {
    if (!(await replicaStored(store, key))) return null
    const session = store.get({ discoveryKey: dk, active: false })
    try {
      await session.ready()
      const raw = await session.get(0, { wait: false, raw: true })
      if (!raw) return null
      return gateVerdict(raw, key, association, revokedIssuers())
    } finally {
      await session.close().catch(noop)
    }
  }

  // R4 by storage (P1 of the B2 review): a revocation must stop this node
  // distributing EVERY stored diary certified by the revoked issuer, not only
  // the active follows: an unfollowed replica (member.js unfollow does not
  // purge) or the leftover of a failed follow is still served on demand by
  // store.replicate to any peer that asks for its discovery key (corestore
  // _attachMaybe / ondiscoverykey, node_modules/corestore/index.js:487-524).
  // So every stored core other than the own diary is enumerated (store.list()
  // = the discovery keys of storage.createDiscoveryKeyStream, :382-384), its
  // key read from the stored auth record (store.getAuth, :386-388, nothing
  // opened) and its block 0 run through the local gate with the current
  // revokedIssuers; each 'revoked-issuer' goes like a blocked author
  // (enforceBlock: a followed key is skipped, the purge goes through the
  // serialized purgeKey). Blocked keys stay with the blocked sweep. Cost:
  // one auth read and one block read per stored core, and only while the
  // revoked set is non-empty (a node whose snapshot revokes no issuer pays
  // nothing at startup). Sweeps run one after the other and are tracked:
  // finish() and the store close wait for them.
  let sweepChain = Promise.resolve()

  function sweepRevoked () {
    const run = sweepChain.then(sweepRevokedOnce)
    sweepChain = run.catch(noop)
    return track(run, noop, () => {
      // Fail closed: a sweep that could not enumerate the store may leave a
      // revoked diary served.
      if (!ended) fail(['falha ao verificar emissores revogados'])
      else log('aviso: falha ao verificar emissores revogados')
    })
  }

  async function sweepRevokedOnce () {
    if (blocklist === null || blocklist.revokedIssuers().size === 0) return
    const dks = []
    for await (const dk of store.list()) {
      if (!b4a.equals(dk, diary.discoveryKey)) dks.push(dk)
    }
    // The purges are awaited: at startup replication begins only after the
    // sweep, so nothing it condemned is still there to be served.
    const purges = []
    for (const dk of dks) {
      if (ended) break
      const auth = await store.getAuth(dk)
      if (!auth || !auth.key) continue
      const key = b4a.toString(auth.key, 'hex')
      if (key === ownHex || isBlockedKey(key)) continue
      const reason = await sweepVerdict(dk, key)
      if (reason === 'revoked-issuer' && !ended) purges.push(enforceBlock(key, 'revoked-issuer'))
      else if (reason === 'unreadable' && !ended) purges.push(purgeStored(key))
    }
    await Promise.all(purges)
  }

  // The verdict of one stored core, read twice before giving up. A core that
  // is gone (closed or purged meanwhile) has nothing left to judge. One still
  // stored whose block 0 cannot be read is 'unreadable' and purged (fail
  // closed: it could be a revoked diary that would otherwise stay servable),
  // unless an active or regate follow holds it: recheckRevoked judges those
  // on their open core.
  async function sweepVerdict (dk, key) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await serialized(key, () => storedVerdict(dk, key))
      } catch {
        if (!(await replicaStored(store, key).catch(() => true))) return null
      }
    }
    const entry = follows.get(key)
    if (entry && (entry.state === 'active' || entry.state === 'regate')) return null
    return 'unreadable'
  }

  // Deletion by storage, at startup before anything is served: store.replicate
  // serves every stored core, so a replica this run does not sync would keep
  // serving blocks its author deleted. One no longer in follows.json is
  // purged (member.js unfollow leaves it stored); one listed past the follow
  // limit is not synced but still served, so its deleted blocks are cleared
  // here. Follows this run syncs are reconciled by watchEntry.
  async function sweepUnfollowed (listed) {
    try {
      const dks = []
      for await (const dk of store.list()) {
        if (!b4a.equals(dk, diary.discoveryKey)) dks.push(dk)
      }
      const purges = []
      for (const dk of dks) {
        if (ending) break
        const auth = await store.getAuth(dk)
        if (!auth || !auth.key) continue
        const key = b4a.toString(auth.key, 'hex')
        if (key === ownHex || follows.has(key)) continue
        // Group storage (loadDiskSlots ran first): a writer or root core
        // kept on disk is not a diary, and a binding diary stays stored for
        // the group, so it is cleared, never purged. Protecting deletions
        // from group membership: only a diary a stored writer or root names,
        // or one recorded in group-certs.json, is held for a group; any other
        // unfollowed diary goes, whatever groups this node belongs to.
        if (storedNamer.has(key) || groupCores.has(key) || ownWriters.has(key)) continue
        const groupHeld = namedCount.has(key) || groupDiaries.has(key) || groupCerts.has(key)
        if (listed.has(key) || groupHeld) await serialized(key, () => clearStored(dk, key))
        else if (!(await writableCore(key))) purges.push(purgeStored(key)) // a core of this device (a former writer) is never another's diary
      }
      await Promise.all(purges)
    } catch {
      log('aviso: falha ao limpar diários não seguidos')
    }
  }

  async function clearStored (dk, key) {
    if (!(await replicaStored(store, key))) return
    const session = store.get({ discoveryKey: dk, active: false })
    try {
      await session.ready()
      await clearDeleted(session, (await presentState(session)).deleted)
    } finally {
      await session.close().catch(noop)
    }
  }

  function onAdopted (r, origin) {
    blocklistGen++
    warnOwn()
    groupsAdopted(r)
    for (const key of r.added) enforceBlock(key, 'blocked')
    if (r.revokedAdded.size > 0) {
      for (const e of follows.values()) {
        if (e.state === 'active' || e.state === 'regate') recheckRevoked(e)
      }
      sweepRevoked()
    }
    // Fan-out (C4): every other peer hears the new key and, when it holds an
    // older snapshot, receives this one. No admission message is sent.
    for (const h of blocklistHandles) if (h !== origin) h.announce()
    evaluate()
  }

  // The offer of one connection (blocklist-net.js): adoption runs in the
  // state's single queue (re-checked against the then-current snapshot,
  // saved, then swapped); the enforcement follows at once.
  async function offerSnapshot (snapshot, origin) {
    if (ending) return { adopted: false, reason: 'ending' }
    const p = blocklist.offer(snapshot)
    track(p, noop, noop) // the store stays open until the save settled
    const r = await p
    if (r.adopted && !ended) onAdopted(r, origin)
    return r
  }

  // Right after store.replicate (C2): the blocklist channel is opened before
  // the admission hello, so whichever side opens first is paired.
  function attachModeration (socket) {
    let handle = null
    try {
      handle = attachBlocklist(socket, {
        current: blocklist.current,
        offer: (snapshot) => offerSnapshot(snapshot, handle),
        compare: compareSnapshots,
        log: (ev) => {
          if (ev && ev.event === 'peer-dropped') onPeerDropped(ev)
          else if (ev && ev.event === 'blocklist-offer-failed') log('aviso: falha ao gravar a lista de bloqueio')
        }
      })
    } catch (err) {
      log('aviso: canal de bloqueio: ' + err.message)
      return
    }
    blocklistHandles.add(handle)
    socket.once('close', () => blocklistHandles.delete(handle))
  }

  // Registers a promise finish() must wait for; the callbacks run on settle.
  function track (p, onOk, onErr) {
    const wrapped = p.then(onOk, onErr).catch(noop)
    settling.add(wrapped)
    wrapped.finally(() => settling.delete(wrapped)).catch(noop)
    return wrapped
  }

  function inventory () {
    const have = [{ key: ownHex, length: diary.length }]
    for (const e of follows.values()) {
      if (isBlockedKey(e.key)) continue // never advertised, whatever its state
      if (e.state === 'active') have.push({ key: e.key, length: e.present })
      else if (e.state === 'pending' || e.state === 'regate') have.push({ key: e.key, length: 0 })
    }
    return have
  }

  function broadcast (msg) {
    for (const p of peers) p.send(msg)
  }

  function helloPeers () {
    return [...peers].filter((p) => p.gotHello)
  }

  // Max length advertised for key by any inventory-complete peer (undefined
  // when nobody advertises it): starts gates and reports `unadvertised`; it
  // is NOT the G1 target of an accepted follow (see target).
  function theirs (key) {
    let best
    for (const p of helloPeers()) {
      if (!p.inventoryComplete || !p.remoteHave.has(key)) continue
      const len = p.remoteHave.get(key)
      if (best === undefined || len > best) best = len
    }
    return best
  }

  // Max length advertised for a PENDING key by the peers that still hold it
  // (H2, cycle 3): verified seeders always; any other peer only while no
  // quarantine fetch that included its socket failed for the key in this run
  // and, with `budget`, only while the unverified budget runs. undefined
  // when nobody holds it at length >= 1.
  function pendingTheirs (entry, { budget }) {
    let best
    for (const p of helloPeers()) {
      if (!p.inventoryComplete || !p.remoteHave.has(entry.key)) continue
      const len = p.remoteHave.get(entry.key)
      if (len < 1) continue
      if (!p.verifiedSeeder) {
        if (entry.failedSockets.has(p.socket)) continue
        if (budget && budgetExpired) continue
      }
      if (best === undefined || len > best) best = len
    }
    return best
  }

  // G1 target of an ACTIVE follow (S2, H1): the max of the signed length the
  // replica already knows (authenticated by the author's signature through
  // replication), the lengths advertised by verified seeders and, while the
  // unverified budget runs, the claims of every other peer (noteClaim).
  function target (entry) {
    let best = entry.core.length
    pruneClaims(entry)
    for (const p of helloPeers()) {
      if (!p.inventoryComplete || !p.remoteHave.has(entry.key)) continue
      const len = p.remoteHave.get(entry.key)
      if (len <= best) continue
      if (p.verifiedSeeder) {
        best = len
        continue
      }
      if (budgetExpired) continue
      const claim = entry.claims.get(p.peerKey)
      if (claim && claim.length === len) best = len
    }
    return best
  }

  // G1 claims (H1, H2): kept only in --once mode and only while the budget
  // runs, once the replica is open (pending keys have no signed length to
  // compare); a claim at or below core.length is dropped. At most
  // maxConnections claims per entry; a peer's claims go when it disconnects.
  function noteClaim (entry, peer, length) {
    if (!once || peer.verifiedSeeder || peer.peerKey === null || !entry.core) return
    if (budgetExpired) {
      if (length > entry.core.length) ignoreClaim(entry, peer, length)
      return
    }
    if (length <= entry.core.length) {
      entry.claims.delete(peer.peerKey)
      return
    }
    const claim = entry.claims.get(peer.peerKey)
    if (claim) {
      claim.length = length
      return
    }
    if (entry.claims.size >= maxConnections) return
    entry.claims.set(peer.peerKey, { length })
  }

  // Claims the signed length caught up with are dropped.
  function pruneClaims (entry) {
    for (const [peerKey, claim] of entry.claims) {
      if (claim.length <= entry.core.length) entry.claims.delete(peerKey)
    }
  }

  function dropClaims (peer) {
    if (peer.peerKey === null) return
    for (const p of peers) if (p.peerKey === peer.peerKey) return // still connected
    for (const e of follows.values()) e.claims.delete(peer.peerKey)
  }

  function failedSocketCount () {
    let n = 0
    for (const e of follows.values()) n += e.failedSockets.size
    return n
  }

  function claimCount () {
    let n = 0
    for (const e of follows.values()) n += e.claims.size
    return n
  }

  // The budget starts at the first hello of an unverified peer (--once only).
  function startBudget () {
    if (!once || budgetStarted) return
    budgetStarted = true
    later(expireBudget, unverifiedBudgetMs)
  }

  // Budget over: the claims are dropped, and every unverified claim above
  // core.length and every unverified peer still below diary.length (now or
  // later in the run) is reported once per peer and key; the dedupe state
  // lives on the peer object and goes with it.
  function expireBudget () {
    if (ending) return
    budgetExpired = true
    for (const e of follows.values()) e.claims.clear()
    for (const p of helloPeers()) {
      if (p.verifiedSeeder) continue
      for (const [key, length] of p.remoteHave) {
        if (key === ownHex) noteInterest(p, length)
        else if (follows.has(key)) noteClaim(follows.get(key), p, length)
      }
    }
    evaluate()
  }

  function ignoreClaim (entry, peer, length) {
    if (!peer.ignoredClaims) peer.ignoredClaims = new Set()
    if (peer.ignoredClaims.has(entry.key)) return
    peer.ignoredClaims.add(entry.key)
    emit({ event: 'claim-ignored', key: entry.key, peerKey: peer.peerKey, length })
  }

  function noteInterest (peer, length) {
    if (!once || !budgetExpired || peer.verifiedSeeder || peer.ignoredInterest) return
    if (length >= diary.length) return
    peer.ignoredInterest = true
    emit({ event: 'peer-ignored', peerKey: peer.peerKey })
  }

  // A peer that may hold the run: verified seeders always, others only while
  // the unverified budget runs.
  function counts (p) {
    return p.verifiedSeeder || !budgetExpired
  }

  // G3 (S2, H1): peers interested in our diary that still count.
  function interestedPeers () {
    const out = []
    for (const p of helloPeers()) {
      if (p.verifiedSeeder && p.admittedOwn) {
        out.push(p)
        continue
      }
      if (p.remoteHave.has(ownHex) && counts(p)) out.push(p)
    }
    return out
  }

  function verifiedSeeders () {
    return helloPeers().filter((p) => p.verifiedSeeder)
  }

  function anyFailing () {
    for (const e of follows.values()) if (e.state === 'failing') return true
    for (const e of groupCores.values()) if (e.state === 'failing') return true
    return false
  }

  function unmetGoals () {
    const unmet = []
    // G1
    for (const e of follows.values()) {
      if (e.state === 'failed' || e.state === 'failing') continue
      const t = theirs(e.key)
      if (e.state === 'pending') {
        // H2: unmet while a fetch is in flight (bounded by the deadline), or
        // while a peer that still holds the key advertises it at >= 1.
        // A fetch cut by the deadline (item 4) and a replica discarded from
        // regate at the end (item 5) keep the key unmet whatever the budget.
        const held = pendingTheirs(e, { budget: true })
        if (held !== undefined) unmet.push(e.key + ':0/' + held)
        else if (e.fetching || e.cutByDeadline || e.discardedRegate) unmet.push(e.key + ':0/' + (t === undefined ? 0 : t))
      } else if (e.state === 'regate') {
        // Unmet until block 0 is in the main store and passed the local gate.
        unmet.push(e.key + ':0/' + (t === undefined ? 0 : t))
      } else {
        const ours = e.present
        const want = target(e)
        if (ours < want) unmet.push(e.key + ':' + ours + '/' + want)
      }
    }
    // G2
    const seeders = verifiedSeeders()
    if (cert && seeders.length >= 1) {
      const met = seederHolds()
      if (!met) {
        let best = 0
        for (const p of seeders) best = Math.max(best, p.remoteHave.get(ownHex) || 0)
        unmet.push(ownHex + ':' + diary.length + '/' + best)
      }
    }
    // G3
    for (const p of interestedPeers()) {
      const len = p.remoteHave.get(ownHex) || 0
      if (len < diary.length) unmet.push(ownHex + ':' + diary.length + '/' + len)
    }
    unmet.push(...groupUnmet())
    return [...new Set(unmet)]
  }

  // G2 holds with >= 1 verified seeder that admitted our diary and
  // advertises its full length; remembered for seederConfirmed (H1 c).
  function seederHolds () {
    const met = cert !== null && verifiedSeeders().some((p) => p.admittedOwn && (p.remoteHave.get(ownHex) || 0) >= diary.length)
    if (met) confirmedLength = diary.length
    return met
  }

  function buildResult (ok, errors) {
    const downloaded = {}
    const unadvertised = []
    for (const e of follows.values()) {
      if (e.state === 'failed' || e.state === 'failing') continue
      if (e.state === 'active') {
        const t = theirs(e.key)
        downloaded[e.key] = e.present
        if (t === undefined || t < 1) unadvertised.push(e.key) // D4
      } else if (e.state === 'pending') {
        // H2: advertisers whose fetch failed no longer count.
        if (pendingTheirs(e, { budget: false }) === undefined) unadvertised.push(e.key)
      } else {
        const t = theirs(e.key)
        if (t === undefined || t < 1) unadvertised.push(e.key)
      }
    }
    return {
      ok,
      peers: helloPeers().length,
      seeders: verifiedSeeders().length,
      admitted: admittedEver,
      rejected: rejectedReason,
      downloaded,
      unadvertised,
      skipped: skipped.slice(),
      errors,
      errorsSoft: softErrors(),
      seederConfirmed: seederHolds() || confirmedLength >= diary.length
    }
  }

  // outcome() -> [ok, errors], evaluated only after every pending purge and
  // local re-gate settled, so the result reflects them; a purge failure
  // (fatal) or a hard error observed at any point makes ok false.
  function finish (outcome) {
    if (ending) return
    ending = true
    discardRegate()
    discardEmptyGroupCores()
    ;(async () => {
      while (settling.size > 0) await Promise.allSettled([...settling])
      ended = true
      let [ok, errors] = outcome()
      if (fatal) {
        ok = false
        errors = fatal.slice()
      } else if (hardErrors.length > 0 || groupDivergences > 0) {
        const hard = hardErrorList()
        ok = false
        errors = [...hard, ...errors.filter((e) => !hard.includes(e))]
      }
      result = buildResult(ok, errors)
      settle()
    })()
  }

  // A replica still in regate never passed the local gate in this run: on
  // ending it is closed and purged (tracked, so finish() and the store close
  // wait for it; a failure follows purgeFailed). It is reported as pending.
  function discardRegate () {
    for (const e of follows.values()) {
      if (e.state !== 'regate') continue
      stopEntry(e)
      e.state = 'pending'
      e.discardedRegate = true // still unmet for the outcome (item 5)
      const core = e.core
      e.core = null
      track((async () => {
        await core.close()
        await purgeKey(e.key)
      })(), noop, () => {
        if (!ended) purgeFailed(e.key)
        else log('aviso: falha ao limpar diário ' + key8(e.key))
      })
    }
  }

  function fail (errors) {
    if (!fatal) fatal = errors
    finish(() => [false, errors])
  }

  function purgeFailed (key) {
    fail(['falha ao limpar diário rejeitado: ' + key8(key)])
  }

  function evaluate () {
    if (ending || !once || !graceDone || deadlineHit) return
    const ps = helloPeers()
    if (ps.length === 0) return
    // An unverified peer's incomplete inventory waits only within the budget.
    if (ps.some((p) => !p.inventoryComplete && counts(p))) return
    if (anyFailing()) return
    if (unmetGoals().length === 0) finish(() => [true, []])
  }

  function checkGrace () {
    if (graceDone || graceTimer === null) return
    if ([...peers].every((p) => p.gotHello)) {
      clearTimeout(graceTimer)
      graceTimer = null
      graceDone = true
    }
  }

  function later (fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
    return timer
  }

  function leaveTopic (entry) {
    if (!swarm) return
    swarm.leave(entry.topic).catch(noop)
  }

  // Gate failure or fork: skip, withdraw, and (when a replica exists in the
  // main store) close + purge it; the purge is tracked and awaited by finish().
  function failFollow (entry, reason, { purge }) {
    if (entry.state === 'failing' || entry.state === 'failed') return
    stopEntry(entry)
    skipped.push({ key: entry.key, reason })
    emit({ event: 'skipped', key: entry.key, reason })
    broadcast({ type: 'rejected', key: entry.key, reason })
    leaveTopic(entry)
    if (!purge) {
      entry.state = 'failed'
      evaluate()
      return
    }
    entry.state = 'failing'
    const core = entry.core
    entry.core = null
    const p = (async () => {
      if (core) await core.close()
      await purgeKey(entry.key)
    })()
    entry.purging = track(p, () => {
      entry.state = 'failed'
      evaluate()
    }, () => {
      entry.state = 'failed'
      purgeFailed(entry.key)
    })
  }

  function stopEntry (entry) {
    if (entry.stopGrow) entry.stopGrow()
    if (entry.stopFork) entry.stopFork()
    if (entry.stopQuota) entry.stopQuota()
    if (entry.stopScan) entry.stopScan()
    if (entry.range) {
      entry.range.destroy()
      // Clears of blocks a destroyed range still received: the store stays
      // open until they settled (a plain range under the kill switch has none).
      if (entry.range.idle) track(entry.range.idle(), noop, noop)
    }
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer)
      timers.delete(entry.retryTimer)
    }
    entry.stopGrow = entry.stopFork = entry.stopQuota = entry.stopScan = entry.range = entry.retryTimer = null
  }

  // Log quota (S3): the signed length and byteLength advance on the upgrade
  // proof ('append' fires) before the blocks arrive, so a log over the quota
  // stops its download range before it is fetched. Chosen outcome: the
  // follow is skipped with reason 'quota' and its range destroyed; an ACTIVE
  // replica keeps the blocks already verified (no purge), so the next run
  // re-gates it at startup, hits the quota again and skips it again; a
  // replica still in regate holds nothing verified and is purged (an empty
  // core must not stay in the main store).
  function overQuota (core) {
    return core.length > maxLogBlocks || core.byteLength > maxLogBytes
  }

  // Returns true when the entry was failed for quota.
  function checkQuota (entry) {
    const core = entry.core
    if (ended || !core) return false
    if (entry.state !== 'active' && entry.state !== 'regate') return false
    if (!overQuota(core)) return false
    failFollow(entry, 'quota', { purge: entry.state === 'regate' })
    return true
  }

  // The quota listener is registered BEFORE the growth watcher (listeners
  // run in registration order) and onGrow checks again, so nothing past the
  // limit is ever advertised or reported downloaded.
  //
  // Deletion: the tombstones this replica already holds are folded and the
  // blocks they delete cleared BEFORE anything is downloaded, so a deleted
  // block is neither served nor fetched again from a stale peer. Every block
  // that arrives later is checked for a tombstone (scanArrived), whatever
  // the prefix progress: a fresh replica learns of a deletion even above a
  // hole nobody serves any more, and clears what it fetched meanwhile.
  async function watchEntry (entry, core) {
    entry.core = core
    const check = () => { if (entry.core === core) checkQuota(entry) }
    core.on('append', check)
    entry.stopQuota = () => core.off('append', check)
    entry.stopFork = watchFork(core, () => { onFork(entry) })
    let s = null
    try {
      s = await presentState(core)
      if (clearing && entry.core === core && !ended) await clearDeleted(core, s.deleted)
    } catch {}
    if (entry.core !== core || ended) return
    entry.tombs = new Map()
    entry.recompute = { core, running: null, again: false }
    if (s !== null) {
      for (const r of s.raw) {
        if (r.record === null || r.record.type !== 'delete') continue
        const copy = validRecordCopy(r.record, r.seq)
        if (copy !== null && copy.type === 'delete') entry.tombs.set(r.seq, copy.seq)
      }
    }
    entry.deleted = s !== null ? s.deleted : new Set()
    entry.present = s !== null ? s.present : 0
    const onDownload = (index) => {
      if (entry.core !== core || entry.tombs.has(index)) return
      track(scanArrived(entry, core, index), noop, noop)
    }
    core.on('download', onDownload)
    entry.stopScan = () => core.off('download', onDownload)
    entry.range = clearing ? followRange(core, entry.deleted) : core.download({ start: 0, end: -1, linear: true })
    // A block can land without a 'download' event on this session (seen when
    // it comes with the upgrade of an existing replica), so every block the
    // present length passes is scanned too; tracked before onGrow, so a run
    // that ends on this growth waits for the scans.
    let scanTo = entry.present
    entry.stopGrow = watchPresent(core, () => entry.deleted, (length) => {
      for (let i = scanTo; i < length; i++) {
        if (!entry.tombs.has(i)) track(scanArrived(entry, core, i), noop, noop)
      }
      if (length > scanTo) scanTo = length
      onGrow(entry, length)
    })
    checkQuota(entry)
  }

  // A block that arrived: a new tombstone joins entry.tombs, validated once,
  // and asks for a recompute. Resolves once a recompute that saw it is done.
  async function scanArrived (entry, core, index) {
    const target = await tombstoneTarget(core, index)
    if (target === null || entry.core !== core || entry.tombs.has(index)) return
    entry.tombs.set(index, target)
    await scheduleRecompute(entry, core)
  }

  // A recompute refolds, replaces the ranges and walks the present length,
  // so one per arriving tombstone would cost O(T x (T + L)) on a diary with
  // T tombstones. At most one runs per entry; requests made meanwhile merge
  // into a single further pass, which sees every tombstone held by then.
  function scheduleRecompute (entry, core) {
    const state = entry.recompute
    if (state === null || state.core !== core) return Promise.resolve()
    if (state.running !== null) {
      state.again = true
      return state.running
    }
    state.running = (async () => {
      try {
        for (;;) {
          state.again = false
          await recompute(entry, core)
          if (!state.again || entry.core !== core || ended) break
        }
      } finally {
        state.running = null
      }
    })()
    return state.running
  }

  // The ranges skip what the fold deletes and the deleted blocks still local
  // are cleared. A larger deleted set only moves the present length forward,
  // so the walk resumes from it unless a seq left the set, and the targets
  // already held replace the scan above each hole.
  async function recompute (entry, core) {
    recomputes++
    const deleted = foldTargets(entry.tombs)
    let revived = false
    if (!sameSet(deleted, entry.deleted)) {
      for (const seq of entry.deleted) {
        if (!deleted.has(seq)) {
          revived = true
          break
        }
      }
      entry.deleted = deleted
      if (clearing && entry.range) await entry.range.update(deleted)
      if (entry.core !== core) return
    }
    // A tombstone that changes nothing in the fold can still target a hole
    // the present length stopped at, so the walk runs either way.
    const targets = new Set(entry.tombs.values())
    const length = await presentLength(core, deleted, revived ? 0 : entry.present, targets)
    if (entry.onPresent) entry.onPresent(length)
    else onGrow(entry, length)
  }

  // Block 0 already passed the local gate (startup).
  async function activate (entry, core) {
    entry.state = 'active'
    await watchEntry(entry, core)
  }

  // Remote gate passed: the replica is open in the main store but nothing it
  // holds counts until block 0 arrives there and passes the local gate.
  async function enterRegate (entry, core) {
    entry.state = 'regate'
    await watchEntry(entry, core)
    if (entry.core !== core) return
    // The claims advertised while the key was pending are recorded now.
    for (const p of helloPeers()) {
      if (p.remoteHave.has(entry.key)) noteClaim(entry, p, p.remoteHave.get(entry.key))
    }
    if (entry.state === 'regate' && entry.present > 0) regate(entry)
  }

  // Growth comes from watchPresent and from scanArrived, possibly out of
  // order: an active follow only reports a length above the last one.
  function onGrow (entry, length) {
    if (ended) return
    if (checkQuota(entry)) return
    if (entry.state !== 'active' && entry.state !== 'regate') return
    if (length <= entry.present && entry.state === 'active') return
    if (length > entry.present) entry.present = length
    if (entry.state === 'regate') {
      // A tombstone can arrive before block 0: nothing to gate yet.
      if (entry.present > 0) regate(entry)
      return
    }
    broadcast({ type: 'have', key: entry.key, length })
    emit({ event: 'downloaded', key: entry.key, length })
    evaluate()
  }

  function regate (entry) {
    if (entry.gating || entry.state !== 'regate') return
    entry.gating = true
    const core = entry.core
    const gen = blocklistGen
    const p = (async () => {
      let reason = regateHook ? await regateHook(entry.key) : null
      if (reason === null || reason === undefined) reason = await gateLocal(core, entry.key)
      return reason
    })()
    track(p, (reason) => {
      entry.gating = false
      if (entry.state !== 'regate') return
      // A snapshot adopted while the gate ran: gate again with the new one.
      if (!reason && gen !== blocklistGen) {
        regate(entry)
        return
      }
      if (moderated(reason)) {
        // Blocked or revoked meanwhile: not a divergent block 0.
        enforceBlock(entry.key, reason)
        return
      }
      if (reason) {
        // The advertiser served a different block 0 to the main store than
        // to the quarantine: skip and purge, and the run cannot be ok.
        hardError('bloco 0 divergente: ' + key8(entry.key) + ' (' + reason + ')')
        failFollow(entry, reason, { purge: true })
        return
      }
      entry.state = 'active'
      const length = entry.present
      broadcast({ type: 'have', key: entry.key, length })
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
    condemnForkedWriters(entry.key)
  }

  // Sockets of connected peers whose latest advertisement of key is >= 1.
  // In --once mode an unverified peer whose socket was in a failed fetch for
  // the key is not asked again (H2: re-advertising must not keep a fetch,
  // and so the key, in flight); long-running mode retries everyone.
  function advertisers (entry) {
    return helloPeers().filter((p) => {
      if ((p.remoteHave.get(entry.key) || 0) < 1) return false
      return !once || p.verifiedSeeder || !entry.failedSockets.has(p.socket)
    }).map((p) => p.socket)
  }

  // A late advertiser (a peer that advertises the key with length >= 1 while
  // a quarantine fetch for it is in flight) joins that fetch, so it can still
  // supply block 0 before the deadline.
  function noteAdvertisement (key, length, peer) {
    if (key === ownHex) {
      noteInterest(peer, length) // G3 itself reads remoteHave
      return
    }
    const entry = follows.get(key)
    if (!entry || isBlockedKey(key)) return
    noteClaim(entry, peer, length)
    if (entry.state !== 'pending' || length < 1) return
    entry.advSeq++
    if (entry.fetch && peer && peer.gotHello && advertisers(entry).includes(peer.socket)) entry.fetch.addSocket(peer.socket)
    maybeFetch(entry)
  }

  function maybeFetch (entry) {
    if (ending || deadlineHit || entry.state !== 'pending' || entry.fetching) return
    if (isBlockedKey(entry.key)) return
    if (entry.advSeq <= entry.fetchedAdv) return
    // Open sockets only (item 2): a closed one neither starts a fetch nor
    // takes one of its slots.
    const sockets = advertisers(entry).filter((s) => !s.destroyed)
    if (sockets.length === 0) return
    // In --once mode a fetch is bounded by the gate timeout AND the run's
    // deadline (H2): a fetch that fails before the deadline releases the
    // unverified advertisers it included from completion.
    let fetchTimeout = gateTimeoutMs
    let deadlineBound = false // this fetch ends with the run, not before it
    if (once) {
      const left = deadline - Date.now()
      if (left < GATE_MIN_TIMEOUT_MS) return
      deadlineBound = left <= gateTimeoutMs
      fetchTimeout = Math.min(gateTimeoutMs, left)
    }
    entry.fetching = true
    entry.cutByDeadline = false
    entry.fetchedAdv = entry.advSeq
    const p = fetchGate(entry, sockets, fetchTimeout, deadlineBound).finally(() => {
      entry.fetching = false
      entry.fetch = null
      inflight.delete(p)
      // A fetch in flight holds a pending key (H2): re-check once it ended.
      evaluate()
    })
    inflight.add(p)
  }

  async function fetchGate (entry, sockets, fetchTimeout, deadlineBound) {
    let r
    // Every socket attached to this fetch, at most maxFetchSockets OPEN ones
    // (item 2): a socket that closed no longer takes a slot, so short-lived
    // advertisers cannot lock a later one out of the fetch, and a slot it
    // frees goes to an advertiser refused while the fetch was full.
    const first = sockets.slice(0, maxFetchSockets)
    const included = new Set(first)
    try {
      const fetch = startQuarantineFetch(qstore, entry.key, first, fetchTimeout)
      const addSocket = (socket) => {
        for (const s of included) if (s.destroyed) included.delete(s)
        if (included.size >= maxFetchSockets) return false
        const added = fetch.addSocket(socket)
        if (added) included.add(socket)
        return added
      }
      entry.fetch = {
        promise: fetch.promise,
        addSocket,
        // A socket closed: if it held a slot, offer the freed slot(s) to the
        // connected advertisers not yet included (same eligibility as
        // maybeFetch), within the cap.
        release (socket) {
          if (!included.delete(socket)) return
          for (const s of advertisers(entry)) {
            if (included.size >= maxFetchSockets) break
            if (!s.destroyed && !included.has(s)) addSocket(s)
          }
        }
      }
      r = await fetch.promise
    } catch {
      if (!ended) purgeFailed(entry.key)
      return
    }
    if (entry.state !== 'pending') return
    if (r.error) {
      softError('bloco 0 indisponível: ' + key8(entry.key))
      // H2: the peers in a fetch that failed before the deadline no longer
      // hold the key for completion. A fetch bounded by the deadline (it
      // fails with the run, racing the deadline timer) keeps the key unmet:
      // 'tempo esgotado', as before, but only while one of its sockets is
      // still open: when every advertiser left, nobody holds the key any
      // more and it is reported unadvertised, as a departure before the
      // fetch became deadline-bound is.
      // Recorded in --once mode only, and only for sockets still open (a
      // closed socket is never pinned here: item 2).
      const anyOpen = [...included].some((s) => !s.destroyed)
      if ((deadlineBound || deadlineHit) && anyOpen) entry.cutByDeadline = true
      else if (once) for (const s of included) if (!s.destroyed) entry.failedSockets.add(s)
      if (ending) return
      if (!once) {
        entry.retryTimer = later(() => {
          entry.retryTimer = null
          entry.fetchedAdv = -1
          maybeFetch(entry)
        }, GATE_RETRY_MS)
      }
      // A new advertisement during the fetch triggers a new attempt.
      setImmediate(() => maybeFetch(entry))
      evaluate()
      return
    }
    if (ending) return
    const reason = verdictFor(entry.key, r.raw)
    if (reason) {
      failFollow(entry, reason, { purge: false })
      return
    }
    // D2: the signed length/byteLength the quarantine learned with block 0
    // are checked against the quota before anything opens in the main store.
    if (overQuota(r)) {
      failFollow(entry, 'quota', { purge: false })
      return
    }
    let core
    try {
      if (openHook) await openHook(entry.key) // test-only
      core = await openReplica(store, entry.key)
    } catch (err) {
      if (!ended) log('aviso: falha ao abrir réplica ' + key8(entry.key) + ': ' + err.message)
      return
    }
    // A snapshot adopted while the replica opened: the remote gate is repeated
    // with it (a blocked key already left 'pending' through enforceBlock).
    const late = entry.state === 'pending' && !ending ? verdictFor(entry.key, r.raw) : null
    if (late) failFollow(entry, late, { purge: false })
    if (ending || entry.state !== 'pending') {
      // The main store already holds the core (servable): purge it (item 8).
      // finish() awaits tracked purges; after the result the finally still
      // waits for it before the store closes.
      await core.close().catch(noop)
      track(purgeKey(entry.key), noop, () => {
        if (!ended) purgeFailed(entry.key)
        else log('aviso: falha ao limpar diário ' + key8(entry.key))
      })
      return
    }
    await enterRegate(entry, core)
    evaluate()
  }

  // ---- groups (header comment) ----

  // groups.json is our own file, but each entry's writer must be the core its
  // nonce opens; at most MAX_GROUPS_PER_DIARY groups, the earliest first.
  async function openOwnWriters () {
    const seen = new Set()
    for (const g of readGroups(dataDir)) {
      if (groupList.length >= MAX_GROUPS_PER_DIARY) break
      if (!g || typeof g !== 'object' || !HEX64.test(g.group) || !HEX64.test(g.writer) ||
        typeof g.nonce !== 'string' || !NONCE.test(g.nonce) || seen.has(g.group) || ownWriters.has(g.writer)) {
        log('aviso: grupo inválido ignorado')
        continue
      }
      const core = await openGroupWriter(store, g.nonce)
      if (b4a.toString(core.key, 'hex') !== g.writer) {
        await core.close().catch(noop)
        log('aviso: grupo inválido ignorado')
        continue
      }
      seen.add(g.group)
      ownWriters.set(g.writer, { group: g.group, core })
      groupList.push({ group: g.group, writer: g.writer, nonce: g.nonce })
      groupSet.add(g.group)
      if (g.writer === g.group) {
        if (await ownRootKind(core) === 'community') ownCommunities.add(g.group)
        // An own root also grows by replication (a peer holding the same
        // root key, restored storage): its new blocks are scanned too.
        const grown = () => { if (linksReady) scanLinks(g.group, core) }
        core.on('append', grown)
        core.on('download', grown)
      }
    }
  }

  async function ownRootKind (core) {
    if (core.length === 0) return null
    try {
      const header = decodeBlock(await core.get(0, { wait: false, raw: true }))
      return header !== null && validateGroupHeader(header) === null ? header.kind : null
    } catch {
      return null
    }
  }

  // A key paged as a community: an own community root, or one a held group
  // root links to that this node does not list as a group of its own.
  function isCommunity (key) {
    return ownCommunities.has(key) || (linkedCommunities.has(key) && !groupSet.has(key))
  }

  // Everything paged: groupList, then the linked communities (no own writer).
  function pagedList () {
    const out = groupList.slice()
    for (const c of linkedCommunities.keys()) if (!groupSet.has(c)) out.push({ group: c, writer: null })
    return out
  }

  function linkedOnlyCount () {
    let n = 0
    for (const c of linkedCommunities.keys()) if (!groupSet.has(c)) n++
    return n
  }

  // A linked community is a single root core: it raises the run-wide core
  // bounds by one, never by a group's worth of writers.
  function coreLimit () {
    return Math.max(1, groupList.length) * MAX_GROUP_WRITERS + linkedOnlyCount()
  }

  // Reads the community-link records a group root gained since the last
  // scan (held blocks only, at most maxLogBlocks) and follows every
  // community they name, up to MAX_COMMUNITY_ROOTS. Own community roots
  // carry no community-link.
  function scanLinks (group, core) {
    if (ending || !groupSet.has(group) || ownCommunities.has(group) || !core) return
    let st = linkScans.get(group)
    if (!st || st.core !== core) {
      st = { core, length: 1, named: [], run: null, again: false }
      linkScans.set(group, st)
    }
    if (st.run) {
      st.again = true
      return
    }
    const s = st
    s.run = (async () => {
      const live = () => !ending && linkScans.get(group) === s
      do {
        s.again = false
        const end = Math.min(core.contiguousLength, maxLogBlocks)
        while (s.length < end && s.named.length < MAX_COMMUNITY_ROOTS && live()) {
          const seq = s.length
          const raw = await readLocal(core, seq)
          // A failed read leaves the cursor on seq: the next scan (on the
          // root's next growth) reads it again, so no block is skipped.
          if (raw === null) break
          s.length = seq + 1
          let record = null
          try {
            record = decodeBlock(raw)
          } catch {}
          // The same keys member.js linkedKeys folds, in the same order.
          if (record === null || typeof record !== 'object' || record.type !== 'community-link' ||
            typeof record.community !== 'string' || !/^[0-9a-fA-F]{64}$/.test(record.community)) continue
          const key = record.community.toLowerCase()
          if (!s.named.includes(key)) s.named.push(key)
        }
      } while (s.again && live())
      if (live()) setLinks(group, s.named)
    })().catch(noop).finally(() => {
      s.run = null
      evaluate()
    })
  }

  function setLinks (group, named) {
    const keep = new Set(named)
    for (const [c, groups] of linkedCommunities) {
      if (keep.has(c) || !groups.has(group)) continue
      groups.delete(group)
      if (groups.size === 0) linkedCommunities.delete(c)
    }
    for (const community of named) {
      if (community === group) continue
      let groups = linkedCommunities.get(community)
      if (groups && groups.has(group)) continue
      const fresh = !groups
      if (fresh) {
        groups = new Set()
        linkedCommunities.set(community, groups)
      }
      groups.add(group)
      if (fresh && !groupSet.has(community)) {
        emit({ event: 'community-linked', key: community, group })
        if (!once) markGroupsDirty(community)
      }
    }
  }

  // A root blocked by the association is not paged and its foreign writers
  // go, our own root included: the own-core exemption only keeps the cores
  // this device writes from being purged.
  function groupBlocked (group) {
    return blocklist !== null && blocklist.blocked().has(group)
  }

  function attachGroupChannel (socket) {
    if (groupList.length === 0) return null
    try {
      return attachGroups(socket, {
        role: 'member',
        messageBurst,
        messageRate,
        requestTimeoutMs: groupRequestTimeoutMs,
        log: (ev) => { if (ev && ev.event === 'peer-dropped') onPeerDropped(ev) }
      })
    } catch (err) {
      log('aviso: canal de grupos: ' + err.message)
      return null
    }
  }

  // One pass over the groups that are due, at a time per verified seeder,
  // then a pause (pageRetryMs). In --once mode every group is due on every
  // pass; in long-running mode a group is due after pageRefreshMs or once a
  // hint marked it (markGroupsDirty). Requests go through the connection's
  // pacer. A request failure (timeout, closed channel) ends the paging of
  // that peer: the handle is single-use.
  function maybePage (peer) {
    if (ending || !peer.verifiedSeeder || peer.groupSupported !== true || peer.groupClosed || peer.groupPaging) return
    if (!peers.has(peer)) return
    if (suspended(peer)) {
      later(() => maybePage(peer), peer.groupSuspendedUntil - Date.now())
      return
    }
    peer.groupPaging = true
    pagePass(peer, dueGroups(peer)).catch(noop).then(() => {
      peer.groupPaging = false
      evaluate()
      if (ending || peer.groupClosed || !peers.has(peer)) return
      later(() => maybePage(peer), pageRetryMs)
    })
  }

  function dueGroups (peer) {
    if (once) return pagedList()
    const now = Date.now()
    return pagedList().filter((g) => peer.groupDirty.has(g.group) || (peer.groupNext.get(g.group) || 0) <= now)
  }

  function markGroupsDirty (group) {
    for (const p of peers) if (p.groupDirty) p.groupDirty.add(group)
  }

  function pause (ms) {
    return new Promise((resolve) => later(resolve, ms))
  }

  async function pagePass (peer, groups) {
    for (const g of groups) {
      if (ending || peer.groupClosed || suspended(peer)) return
      if (groupBlocked(g.group)) continue
      peer.groupDirty.delete(g.group)
      peer.groupNext.set(g.group, Date.now() + pageRefreshMs)
      const pass = { complete: true, items: new Map() }
      peer.groupCurrent.set(g.group, pass)
      let after = null
      for (let i = 0; i < MAX_WRITER_PAGES; i++) {
        const wait = peer.groupPacer.reserve()
        if (wait > 0) await pause(wait)
        if (ending || peer.groupClosed || suspended(peer)) {
          peer.groupCurrent.delete(g.group)
          return
        }
        let r
        try {
          r = await peer.groupHandle.requestWriters({ group: g.group, after, limit: GROUPS_LIMIT_MAX })
        } catch {
          peer.groupClosed = true
          // The writers admitted so far keep their goals and advertised
          // lengths, merged into the last pass.
          const prev = peer.groupPasses.get(g.group)
          const items = new Map(prev ? prev.items : [])
          for (const [key, it] of pass.items) {
            const old = items.get(key)
            items.set(key, old && old.length > it.length ? old : it)
          }
          peer.groupPasses.set(g.group, { complete: prev ? prev.complete : false, items })
          peer.groupCurrent.delete(g.group)
          return
        }
        if (ending) return
        if (r.incomplete) pass.complete = false
        for (const item of r.items) {
          if (pass.items.size >= MAX_GROUP_WRITERS) break
          if (after !== null && item.key <= after) continue
          pass.items.set(item.key, item)
          if (peer.groupClosed || suspended(peer)) break
          admitGroupItem(peer, g.group, item)
          if (peer.groupClosed || suspended(peer)) break
        }
        if (r.next === null) break
        // A cursor that does not advance would page forever.
        if (after !== null && r.next <= after) {
          pass.complete = false
          break
        }
        after = r.next
      }
      peer.groupPasses.set(g.group, pass)
      peer.groupCurrent.delete(g.group)
    }
  }

  // The group goal (--once, header comment). The page and own-writer goals
  // apply while a verified seeder has answered writer pages or may still
  // answer them, as G2 does; the page goal waits only on channels still
  // open. A foreign writer listed in this run keeps its download goal until
  // the end, whichever seeder listed it and whether or not that seeder is
  // still connected: met at the largest advertised or signed length, or
  // dropped when it fails.
  function groupUnmet () {
    if (groupList.length === 0) return []
    const unmet = []
    for (const [g, st] of linkScans) if (st.run) unmet.push(g + ':vínculos')
    const seeders = verifiedSeeders().filter((p) => !p.groupClosed || p.groupPasses.size > 0)
    const live = seeders.some((p) => !p.groupClosed)
    for (const g of pagedList()) {
      if (groupBlocked(g.group) || seeders.length === 0) continue
      const passes = []
      for (const p of seeders) if (p.groupPasses.has(g.group)) passes.push(p.groupPasses.get(g.group))
      if (live && !passes.some((x) => x.complete)) unmet.push(g.group + ':páginas')
      if (g.writer === null) continue
      let pushed = 0
      for (const x of passes) {
        const it = x.items.get(g.writer)
        if (it && it.length > pushed) pushed = it.length
      }
      const own = ownWriters.get(g.writer)
      if (own.core.length > pushed) unmet.push(g.writer + ':' + own.core.length + '/' + pushed)
    }
    for (const [key, advertised] of groupTargets) {
      if (ownWriters.has(key)) continue
      const e = groupCores.get(key)
      if (e && (e.state === 'failed' || e.state === 'failing') && !e.discardedEmpty) continue
      if (e && groupBlocked(e.group)) continue
      const active = e && e.state === 'active'
      const ours = active ? e.core.contiguousLength : 0
      const want = active ? Math.max(advertised, e.core.length) : advertised
      // Until the main store's block 0 is compared with the gated one, ending
      // the run would skip that comparison and the growth it reports.
      if (!active || ours < want || e.expected !== null) unmet.push(key + ':' + ours + '/' + want)
      if (active) {
        const d = groupDiaries.get(e.diary)
        if (d && !d.failed && (d.present < d.want || d.expected !== null)) unmet.push(e.diary + ':' + d.present + '/' + d.want)
      }
    }
    return unmet
  }

  function groupSockets (peer) {
    const out = []
    if (!peer.socket.destroyed) out.push(peer.socket)
    for (const p of verifiedSeeders()) {
      if (out.length >= maxFetchSockets) break
      if (!p.socket.destroyed && !out.includes(p.socket)) out.push(p.socket)
    }
    return out
  }

  // The group gate keeps four invariants:
  // I1. Whatever keeps a writer out for longer than one gate (refused, the
  //     per-diary cap slot, an eviction, provenLater, capRefused) comes only
  //     from data this node verified: the writer's block 0 (its group and
  //     diary) and the binding diary's join block, never from a page item's
  //     diary or seq alone.
  // I2. A verdict that depends only on the page item (diary, seq, length)
  //     discards THAT hint: remembered per (group, key, diary, seq), charged
  //     once to the listing seeder, then a rescan that skips that seeder for
  //     that key.
  // I3. Every run-wide or per-peer memory is bounded and, in long-running
  //     mode, expires (oldest first when full, by age after pageRefreshMs),
  //     so a full map never stops remembering. A seeder cut off for wrong or
  //     unservable hints is suspended for pageRefreshMs in long-running mode
  //     and only closed for good in --once.
  // I4. A core already stored that is listed under a group it does not
  //     write in leaves the admission table (its blocks stay), so the honest
  //     listing under its own group proceeds.

  // A hint names its group: a wrong listing under one group never judges an
  // honest listing of the same writer under another.
  const hintId = (group, key, diary, seq) => group + ':' + key + ':' + diary + ':' + seq
  const groupKey = (group, key) => group + ':' + key

  // Protecting the run's memory from a seeder listing endless writer keys:
  // a target exists only for a writer held in the bounded groupCores table.
  function noteTarget (item) {
    if (!groupCores.has(item.key) || ownWriters.has(item.key)) return
    if (!groupTargets.has(item.key) && groupTargets.size >= coreLimit()) return
    groupTargets.set(item.key, Math.max(groupTargets.get(item.key) || 0, Math.min(item.length, maxLogBlocks)))
  }

  // A slot of the table or of a (group, diary) freed: items held back are
  // gated now (later, never inside the caller's own walk of the table).
  function slotFreed (group) {
    if (!rescanDue.has(group)) return
    rescanDue.delete(group)
    later(() => { if (!ending) rescanGroup(group, null, null) }, 0)
  }

  function dropGroupCore (key) {
    const e = groupCores.get(key)
    groupCores.delete(key)
    groupTargets.delete(key)
    if (e) {
      slotFreed(e.group)
      noteLeft(e)
    }
  }

  function noteNamer (key, diaryKey) {
    if (storedNamer.get(key) === diaryKey) return
    forgetNamer(key)
    storedNamer.set(key, diaryKey)
    namedCount.set(diaryKey, (namedCount.get(diaryKey) || 0) + 1)
  }

  // -> the diary `key` named, or null.
  function forgetNamer (key) {
    const d = storedNamer.get(key)
    if (d === undefined) return null
    storedNamer.delete(key)
    const n = namedCount.get(d) - 1
    if (n > 0) namedCount.set(d, n)
    else namedCount.delete(d)
    return d
  }

  // A writer that left the table and still has its blocks on disk (a quota
  // stop, a refusal for the cap, I4) keeps the diary its stored block 0
  // names, read after every earlier purge of the key settled.
  function noteLeft (e) {
    if (ending || ownKey(e.key)) return
    const key = e.key
    track(serialized(key, async () => {
      const raw = await storedBlock0(Hypercore.discoveryKey(b4a.from(key, 'hex')), key)
      let h = null
      try {
        h = raw === null ? null : decodeBlock(raw)
      } catch {}
      if (h !== null && (validateWriterHeader(h) === null || validateGroupHeader(h) === null)) return noteNamer(key, h.diary)
      const named = forgetNamer(key)
      if (named !== null) releaseDiary(named)
    }), () => releaseDiary(e.diary), noop)
  }

  // A binding diary is held while a follow holds it, an entry of the table
  // names it or a stored writer or root names it.
  function diaryNeeded (key) {
    if (key === ownHex || followHolds(key) || namedCount.has(key)) return true
    for (const e of groupCores.values()) if (e.diary === key) return true
    return false
  }

  // Protecting the disk from writers admitted and then purged with fresh
  // certified identities: a binding diary nothing needs any more stops
  // downloading and goes, outside the group's writer limit otherwise (each
  // up to the per-diary log quota). A follow that holds it keeps its blocks.
  function releaseDiary (key) {
    if (ending) return
    const d = groupDiaries.get(key)
    if (!d || diaryNeeded(key)) return
    d.failed = true
    stopGroupDiary(d)
    groupDiaries.delete(key)
    joinCache.delete(key)
    const core = d.core
    // Visible to gates before the first await: a gate that found no held
    // entry would otherwise reopen the diary from the store in the window
    // before purgeKey enters the per-key chain, and keep a session the purge
    // then closes.
    const p = (async () => {
      if (releaseHook) await releaseHook(key) // test-only
      await core.close()
      if (!followHolds(key)) await purgeKey(key, { ifStored: true })
    })()
    releasing.set(key, p)
    const done = () => { if (releasing.get(key) === p) releasing.delete(key) }
    p.then(done, done)
    track(p, () => evaluate(), () => {
      if (!ended) purgeFailed(key)
      else log('aviso: falha ao limpar diário ' + key8(key))
    })
  }

  // Writers of (group, diary) holding a verified cap slot: active, or past
  // their gate and opening (I1: the diary is the one block 0 names), and
  // writer cores on disk (diskSlots, never evicted: state 'held').
  // Protecting the cap from a diary whose writers stop for quota one after
  // the other: a stopped writer's blocks stay, so its slot does too.
  // Protecting the disk from stored writers piling up across runs: a stored
  // writer's own gate counts the other keys on disk too (othersHolding).
  function capHolders (group, diary) {
    const out = []
    const keys = new Set()
    for (const e of groupCores.values()) {
      if (e.group === group && e.diary === diary && (e.state === 'active' || (e.state === 'gating' && e.slot))) {
        out.push(e)
        keys.add(e.key)
      }
    }
    for (const [key, s] of diskSlots) {
      if (s.group === group && s.diary === diary && !keys.has(key)) out.push({ key, group, diary, state: 'held' })
    }
    return out
  }

  // Every holder of (group, diary) but `key` itself.
  function othersHolding (group, diary, key) {
    return capHolders(group, diary).filter((x) => x.key !== key)
  }

  function holdDiskSlot (e) {
    if (e.key !== e.group && !ownWriters.has(e.key)) diskSlots.set(e.key, { group: e.group, diary: e.diary })
  }

  // Bounded by the stored writer table: an entry pushed out only makes its
  // writers fail closed at the next start while an issuer is revoked.
  function noteGroupCert (diaryKey, raw0) {
    if (!raw0 || raw0.length === 0) return
    const had = groupCerts.get(diaryKey)
    if (had && b4a.equals(had, raw0)) return
    groupCerts.delete(diaryKey)
    groupCerts.set(diaryKey, raw0)
    while (groupCerts.size > gateLimit()) groupCerts.delete(groupCerts.keys().next().value)
    try {
      writeGroupCerts(dataDir, groupCerts, gateLimit())
    } catch (err) {
      log('aviso: falha ao registrar certificado de grupo: ' + err.message)
    }
  }

  // Keeps only the records of diaries a stored writer or root still names.
  function pruneGroupCerts (named) {
    let changed = false
    for (const d of [...groupCerts.keys()]) {
      if (named.has(d)) continue
      groupCerts.delete(d)
      changed = true
    }
    if (!changed) return
    try {
      writeGroupCerts(dataDir, groupCerts, gateLimit())
    } catch (err) {
      log('aviso: falha ao registrar certificado de grupo: ' + err.message)
    }
  }

  // At run start: stored writer cores of the listed groups count toward
  // their (group, diary) cap, so a restart does not reopen the slots of
  // writers kept on disk after a quota stop.
  async function loadDiskSlots () {
    const listed = new Set(groupList.map((g) => g.group))
    // Protecting the group cores of a node that left its last group from
    // sweepUnfollowed: it tells them from unfollowed diaries only through
    // this census, so the census runs whenever that sweep does.
    if (listed.size === 0 && groupCerts.size === 0 && !clearing) return
    const named = new Set()
    const dks = []
    for await (const dk of store.list()) {
      if (!b4a.equals(dk, diary.discoveryKey)) dks.push(dk)
    }
    for (const dk of dks) {
      if (ending) break
      const auth = await store.getAuth(dk)
      if (!auth || !auth.key) continue
      const key = b4a.toString(auth.key, 'hex')
      if (ownKey(key)) continue
      const raw = await serialized(key, () => storedBlock0(dk, key))
      let header = null
      try {
        header = raw === null ? null : decodeBlock(raw)
      } catch {}
      if (header === null) continue
      if (validateWriterHeader(header) !== null) {
        if (validateGroupHeader(header) === null) {
          named.add(header.diary)
          noteNamer(key, header.diary)
        }
        continue
      }
      named.add(header.diary)
      noteNamer(key, header.diary)
      if (!listed.has(header.group)) continue
      diskSlots.set(key, { group: header.group, diary: header.diary })
    }
    if (ending) return
    // A binding diary recorded in an earlier run that no stored core names
    // any more (its writers were purged) goes, unless it is followed.
    const followed = new Set(readFollows(dataDir))
    const orphans = [...groupCerts.keys()].filter((d) => !named.has(d) && d !== ownHex && !followed.has(d))
    pruneGroupCerts(named)
    for (const d of orphans) {
      if (ending) break
      await purgeStored(d)
    }
  }

  // Foreign writer cores of `group` in the table or on disk.
  // Protecting the disk from one group's stored writers growing past
  // maxGroupWriters with fresh certified identities: a writer stopped for
  // quota leaves the table but its blocks stay, so it keeps its place.
  function groupHeld (group) {
    let n = 0
    for (const e of groupCores.values()) if (e.group === group) n++
    for (const [key, s] of diskSlots) {
      const e = groupCores.get(key)
      if (s.group === group && !(e && e.group === group)) n++
    }
    return n
  }

  // Gates in flight for a hinted (group, diary): bounded, so listings
  // naming one diary cannot run unlimited gates at once. Held-back items
  // only wait for a free gate (rescanDue), nothing about them is decided.
  function gatesInFlight (group, hintDiary) {
    let n = 0
    for (const e of groupCores.values()) {
      if (e.group === group && e.hintDiary === hintDiary && e.state === 'gating' && !e.slot) n++
    }
    return n
  }

  function refuseForCap (group, key) {
    const gk = groupKey(group, key)
    if (capRefused.has(gk)) return
    capRefused.add(gk)
    emit({ event: 'group-skipped', key, reason: 'quota' })
  }

  function admitGroupItem (peer, group, item) {
    if (ending || deadlineHit) return
    if (ownWriters.has(item.key)) return
    const hint = hintId(group, item.key, item.diary, item.seq)
    // Protecting admitted writers from a seeder advertising lengths past the
    // log quota: the item is ignored (the quota is enforced on the core's
    // signed length), never touches a held entry or its target, and counts
    // as a bad hint of that seeder.
    if (item.length > maxLogBlocks) {
      if (!groupCores.has(item.key) && !quotaListed.has(item.key)) {
        quotaListed.add(item.key)
        emit({ event: 'group-skipped', key: item.key, reason: 'quota' })
      }
      badHint(peer, 'quota:' + hint, false)
      return
    }
    // A community has no writers: only its root is ever gated under it.
    // Protecting an honest seeder from this node's own view of which keys
    // are communities (a key a community-link names may be a group root to
    // the seeder): the listing is ignored, never charged.
    if (item.key !== group && isCommunity(group)) return
    if (groupCores.has(item.key)) {
      noteTarget(item)
      return
    }
    const gk = groupKey(group, item.key)
    if (refused.has(gk) || failedWriters.has(gk)) return
    // A seeder that listed this exact (key, diary, seq) had it disproved:
    // only a listing with another diary or seq is gated again.
    if (failedHints.has(hint)) {
      badHint(peer, hint)
      return
    }
    // Protecting a --once run from regating, on every page, listings this
    // node already refused for its own verdict on the hinted diary; a
    // lifted block lets the listing through again.
    if (localSkips.has(hint)) {
      if (localVerdict(item.diary)) return
      localSkips.delete(hint)
    }
    // This seeder's listing already timed out in this --once run, or this
    // seeder reached the timeout limit for the writer.
    if (once && (peer.timedOut.has(hint) || (peer.keyTimeouts.value(gk) || 0) >= MAX_GATE_TIMEOUTS)) return
    // A writer whose proven join lost the cap of its verified diary stays
    // out while that diary is still full.
    if (provenLater.has(gk)) {
      if (othersHolding(group, provenLater.value(gk), item.key).length >= MAX_GROUP_WRITERS_PER_DIARY) {
        refuseForCap(group, item.key)
        return
      }
      provenLater.delete(gk)
    }
    // A writer already on disk holds its place; a new key waits for one.
    // Protecting a group whose writers fill the cap from never fetching its
    // root: the root is no writer slot and is always gated.
    if (item.key !== group && !diskSlots.has(item.key) && groupHeld(group) >= maxGroupWriters) {
      rescanDue.add(group)
      refuseForCap(group, item.key)
      return
    }
    if (groupCores.size >= coreLimit() ||
        gatesInFlight(group, item.diary) >= MAX_GROUP_WRITERS_PER_DIARY + MAX_CAP_CONTENDERS) {
      rescanDue.add(group)
      return
    }
    let timeoutMs = gateTimeoutMs
    if (once) {
      const left = deadline - Date.now()
      if (left < GATE_MIN_TIMEOUT_MS) return
      timeoutMs = Math.min(gateTimeoutMs, left)
    }
    const e = {
      key: item.key,
      group,
      diary: item.diary, // the hint until block 0 names it
      hintDiary: item.diary,
      seq: item.seq,
      hint, // the page item as listed
      peer, // the seeder whose listing is being gated
      slot: false, // holds a verified cap slot (set after the gate)
      state: 'gating',
      core: null,
      range: null,
      stopGrow: null,
      stopFork: null,
      stopQuota: null,
      expected: null, // block 0 read through the quarantine, checked again in the main store
      confirming: false,
      diaryRaw: null, // D's block 0, judged again when an issuer is revoked
      wasStored: false,
      purging: null,
      accepted: false // gated as a writer of this group (now or in an earlier run)
    }
    groupCores.set(item.key, e)
    noteTarget(item)
    const sockets = groupSockets(peer)
    const p = (async () => {
      let r
      try {
        r = await gateGroupCore(e, sockets, timeoutMs)
      } catch {
        r = { reason: 'timeout' }
      }
      await onGroupGate(e, r)
    })().catch(noop)
    inflight.add(p)
    p.finally(() => {
      inflight.delete(p)
      evaluate()
    })
  }

  function suspended (peer) {
    return !once && peer.groupSuspendedUntil > Date.now()
  }

  // Protecting the gates from a seeder listing wrong or unservable hints:
  // --once stops paging it; long-running mode suspends it for
  // pageRefreshMs, then pages it again with a clean slate.
  function cutOff (peer, why) {
    log('aviso: semeador ' + key8(peer.peerKey || '') + ' ' + why)
    if (once) {
      peer.groupClosed = true
      peer.groupCutOff = true
      return
    }
    peer.groupSuspendedUntil = Date.now() + pageRefreshMs
    peer.badHints = createMemo(() => MAX_BAD_HINTS)
    peer.timeoutHints = createMemo(() => MAX_TIMEOUT_HINTS)
  }

  // A page item a gate disproved (I2): remembered, and charged once to the
  // seeder that listed it.
  function badHint (peer, hint, remember = true) {
    if (remember) failedHints.add(hint)
    if (!peer || peer.badHints.has(hint)) return
    peer.badHints.add(hint)
    if (peer.badHints.size >= MAX_BAD_HINTS) cutOff(peer, 'listou escritores errados demais')
  }

  function chargeTimeout (peer, hint) {
    if (peer.timeoutHints.has(hint)) return
    peer.timeoutHints.add(hint)
    if (peer.timeoutHints.size >= MAX_TIMEOUT_HINTS) cutOff(peer, 'listou escritores indisponíveis demais')
  }

  // Room freed in (group, diary), or a hint for `key` was discarded: any
  // other seeder's listing of that writer, or of another writer of that
  // diary, is gated now, so a wrong hint never hides a real writer (in
  // --once mode it stays a goal until gated). The seeder whose listing just
  // failed never gets the writer back in this rescan (I2).
  function rescanGroup (group, key, diary, skip = null) {
    for (const p of verifiedSeeders()) {
      if (p.groupCutOff || suspended(p)) continue
      for (const pass of [p.groupPasses.get(group), p.groupCurrent.get(group)]) {
        if (!pass) continue
        for (const item of pass.items.values()) {
          if (groupCores.has(item.key) || (key !== null && item.key !== key && item.diary !== diary)) continue
          if (skip !== null && p === skip.peer && item.key === skip.key) continue
          admitGroupItem(p, group, item)
        }
      }
    }
  }

  // Discards the page item an entry was gated for (I2).
  function discardHint (e, reason, { charge = true } = {}) {
    emit({ event: 'group-skipped', key: e.key, reason })
    e.state = 'failed'
    dropGroupCore(e.key)
    if (charge) badHint(e.peer, e.hint)
    else localSkips.add(e.hint)
    rescanGroup(e.group, e.key, e.hintDiary, { peer: e.peer, key: e.key })
  }

  // This node's own verdict on a hinted diary, whoever listed it.
  function localVerdict (d) {
    return isBlockedKey(d) || forkedDiaries.has(d) || divergedDiaries.has(d)
  }

  // Blocks of `key` read through the quarantine store over `sockets`, one
  // read of a key at a time (a settled read purges the quarantine core). A
  // follow's block-0 fetch of the same key in flight is waited for first.
  // -> { raws, length, byteLength } or null (unavailable before `until`).
  function quarantineBlocks (key, sockets, seqs, until) {
    const prev = qchains.get(key) || Promise.resolve()
    const run = prev.catch(noop).then(async () => {
      const entry = follows.get(key)
      if (entry && entry.fetch) await entry.fetch.promise.catch(noop)
      if (ending) return null
      const core = qstore.get({ key: b4a.from(key, 'hex') })
      try {
        await core.ready()
        for (const s of sockets) if (!s.destroyed) core.replicate(s)
        const raws = []
        for (const seq of seqs) {
          const left = until - Date.now()
          if (left <= 0) return null
          let raw = null
          try {
            raw = await core.get(seq, { raw: true, timeout: left })
          } catch {
            return null
          }
          if (raw === null) return null
          raws.push(raw)
        }
        return { raws, length: core.length, byteLength: core.byteLength }
      } finally {
        await core.purge().catch(noop)
        reattachMain(key, sockets)
      }
    })
    qchains.set(key, run)
    const done = () => { if (qchains.get(key) === run) qchains.delete(key) }
    run.then(done, done)
    return run
  }

  // Protecting a main-store replica of `key` from a quarantine read of the
  // same key on the same connection: Hypercore opens one channel per key and
  // connection, and the quarantine's pairing replaces the main one, so a
  // replica opened while the quarantine held the channel never replicates
  // there (corestore counts it attached). Once the quarantine channel is
  // closed the replica is attached again.
  function reattachMain (key, sockets) {
    const f = follows.get(key)
    const d = groupDiaries.get(key)
    const w = groupCores.get(key)
    const core = (d && !d.failed && d.core) || (f && f.core) || (w && w.core) || null
    if (!core || !core.opened || core.closing || core.closed) return
    for (const s of sockets) {
      const mux = s.userData
      if (s.destroyed || !mux || typeof mux.pair !== 'function' || typeof mux.opened !== 'function') continue
      if (mux.opened({ protocol: 'hypercore/alpha', id: core.discoveryKey })) continue
      core.replicate(mux)
    }
  }

  async function readLocal (core, seq) {
    try {
      return await core.get(seq, { wait: false, raw: true })
    } catch {
      return null
    }
  }

  // A block through a replica of the main store (replicated on every
  // connection already), waiting for it until `until`.
  async function readHeld (core, seq, until) {
    const left = until - Date.now()
    try {
      return await core.get(seq, left > 0 ? { raw: true, timeout: left } : { raw: true, wait: false })
    } catch {
      return null
    }
  }

  // The gate (header comment). A core the main store holds (the writer
  // itself, or the own, a followed or a stored binding diary) is read there,
  // waiting for missing blocks through that replica: the main store already
  // owns its replication channel and Hypercore refuses a second one from the
  // quarantine. Only a core absent from the main store goes through the
  // quarantine.
  // -> { reason } or { reason: null, expected, diaryRaw, want, core, dcore }
  // A verdict marked `own` comes from the writer's own data (its key, its
  // block 0, its group): it judges the writer. Every other verdict depends
  // on the page item's hinted diary and judges only the hint.
  async function gateGroupCore (e, sockets, timeoutMs) {
    if (isBlockedKey(e.key) || groupBlocked(e.group)) return { reason: 'blocked', own: true }
    // Judged on the hinted diary alone, refused at once as a hint, unless
    // the core is stored: its own header then decides, so a stored writer of
    // a blocked or forked diary is condemned.
    const storedHere = await replicaStored(store, e.key)
    if (!storedHere && isBlockedKey(e.diary)) return { reason: 'blocked', local: true }
    if (!storedHere && forkedDiaries.has(e.diary)) return { reason: 'fork', local: true }
    if (!storedHere && divergedDiaries.has(e.diary)) return { reason: 'not-in-log', local: true }
    const until = Date.now() + timeoutMs
    let core = null
    let dcore = null // opened here: handed to onGroupGate, or closed on failure
    // The stored core is a writer of THIS group (its own block 0 says so):
    // only then may a failure purge it. A page item is only a hint, so a
    // stored core of any other kind (a followed or binding diary, a media
    // core, a writer of another group) is never touched by its gate.
    let writerHere = false
    // `local`: a verdict of this node (its blocklist, a fork or divergence
    // it saw in this run), never charged to the seeder that listed it.
    const fail = async (reason, own = false, local = false) => {
      if (core) await core.close().catch(noop)
      if (dcore) await dcore.close().catch(noop)
      return { reason, writerHere, own, local }
    }
    const ownVerdict = (reason) => reason === 'header-invalid' || reason === 'wrong-group' || reason === 'not-community'
    try {
      let expected = null
      let raw0
      if (storedHere) {
        e.wasStored = true
        core = await openGroupReplica(store, e.key)
        raw0 = await readHeld(core, 0, until)
        if (raw0 === null) return fail('timeout')
        // A stored writer's own validated block 0 names its diary: the page
        // item is only a hint.
        const own = headerDiary(raw0, e.key, e.group, !groupSet.has(e.group))
        if (own !== null) e.diary = own
        const header = groupHeaderVerdict(raw0, e.key, e.group, e.diary, !groupSet.has(e.group))
        if (header) return fail(header, ownVerdict(header))
        writerHere = true
        if (core.fork !== 0) return fail('fork', true)
        if (overQuota(core)) return fail('quota', true)
      } else {
        if (sockets.length === 0) return { reason: 'timeout' }
        const w = await quarantineBlocks(e.key, sockets, [0], until)
        if (w === null) return { reason: 'timeout' }
        if (overQuota(w)) return { reason: 'quota', own: true }
        raw0 = expected = w.raws[0]
      }
      // The hinted diary is judged against the diary the header names
      // ('wrong-diary') before anything about that diary is believed.
      const reason = groupHeaderVerdict(raw0, e.key, e.group, e.diary, !groupSet.has(e.group))
      if (reason) return fail(reason, ownVerdict(reason))
      if (openHook && writerHere) await openHook(e.diary) // test-only
      if (isBlockedKey(e.diary)) return fail('blocked', false, true)
      if (forkedDiaries.has(e.diary)) return fail('fork', false, true)
      if (divergedDiaries.has(e.diary)) return fail('not-in-log', false, true)
      // A diary released while this gate ran is read once its purge settled.
      await releaseSettled(e.diary)
      let diaryRaws
      let want = 0
      let held = null
      let diaryExpected = null // the quarantined diary blocks the main store must match
      if (e.diary === ownHex) {
        // A join block of the own diary not stored yet is a timeout, never
        // a hint disproved and charged to the seeder that listed it.
        diaryRaws = [await readHeld(diary, 0, until), await readHeld(diary, e.seq, until)]
        if (diaryRaws[0] === null || diaryRaws[1] === null) return fail('timeout')
      } else if (followHolds(e.diary)) {
        held = follows.get(e.diary).core
      } else if (groupDiaries.has(e.diary) && !groupDiaries.get(e.diary).failed) {
        held = groupDiaries.get(e.diary).core
      } else if (await replicaStored(store, e.diary)) {
        dcore = await openReplica(store, e.diary)
        held = dcore
      } else {
        // A seq past the length learned with block 0 (perhaps from a seeder
        // behind) is waited for until the deadline: a miss is a timeout,
        // never a disproved hint.
        const d = await quarantineBlocks(e.diary, sockets, [0, e.seq], until)
        if (d === null) return fail('timeout')
        if (overQuota(d)) return fail('quota')
        diaryRaws = d.raws
        want = d.length
        diaryExpected = { seq: e.seq, raw0: d.raws[0], rawSeq: d.raws[1] }
      }
      if (held) {
        // Protecting the run from a join its author deleted: the block is
        // cleared and never fetched again, so waiting for it would hold the
        // goal until the deadline. The listing is withdrawn, never charged.
        if (e.seq > 0 && !(await held.has(e.seq)) && (joinDeleted(e.diary, e.seq) || (held === dcore && (await presentState(held)).deleted.has(e.seq)))) {
          return fail('withdrawn', false, true)
        }
        diaryRaws = [await readHeld(held, 0, until), await readHeld(held, e.seq, until)]
        if (diaryRaws[0] === null || diaryRaws[1] === null) return fail('timeout')
        if (held.fork !== 0) return fail('fork')
        want = held.length
      }
      const verdict = diaryVerdict(e, diaryRaws)
      if (verdict) return fail(verdict)
      return { reason: null, expected, gatedRaw: raw0, diaryRaw: diaryRaws[0], diaryExpected, want, core, dcore }
    } catch (err) {
      await fail(null)
      throw err
    }
  }

  // The binding diary's replica this node already holds, if any.
  function heldBinding (d, dcore) {
    if (d === ownHex) return diary
    if (followHolds(d)) return follows.get(d).core
    const gd = groupDiaries.get(d)
    if (gd && !gd.failed && gd.core) return gd.core
    return dcore || null
  }

  // Per binding diary, the on:true group-joins of the listed groups read so
  // far: each gate decodes only the blocks that arrived since. Only blocks
  // held locally count (each one verified by the replica), so a join seq is
  // only ever lowered to one this node proved.
  async function diaryJoins (d, dcore) {
    const core = heldBinding(d, dcore)
    if (core === null || core.fork !== 0) return null
    let st = joinCache.get(d)
    if (st === undefined || st.core !== core) {
      joinCache.delete(d)
      if (joinCache.size >= gateLimit()) joinCache.delete(joinCache.keys().next().value)
      st = { core, length: 0, joins: [] }
      joinCache.set(d, st)
    }
    const listed = new Set(groupList.map((g) => g.group))
    // The present length, not contiguousLength: a block its author deleted
    // and this node cleared never hides the joins after it. Every hole below
    // it is a tombstone target, so it is passed over.
    const end = await presentLength(core, null, st.length)
    while (st.length < end) {
      const seq = st.length
      const raw = await readLocal(core, seq)
      if (st.length !== seq) break
      st.length = seq + 1
      if (raw === null) continue
      let record = null
      try {
        record = decodeBlock(raw)
      } catch {}
      if (record === null || validateRecord(record, seq) !== null) continue
      if (record.type === 'group-join' && record.on === true && listed.has(record.group)) {
        st.joins.push({ group: record.group, writer: record.writer, seq })
      }
    }
    return st.joins
  }

  // The fold keeps each writer's EARLIEST on:true join (group.js readJoins):
  // the per-diary cap compares the same seq, for the gated entry and the
  // active holders it may evict.
  async function refineJoinSeqs (e, dcore) {
    let joins = null
    try {
      joins = await diaryJoins(e.diary, dcore)
    } catch {}
    if (joins === null) return null
    const earliest = (x) => {
      for (const j of joins) if (j.group === x.group && j.writer === x.key && j.seq < x.seq) x.seq = j.seq
    }
    earliest(e)
    for (const x of groupCores.values()) {
      if (x !== e && x.group === e.group && x.diary === e.diary && x.state === 'active') earliest(x)
    }
    return joins
  }

  // The earliest join the binding diary proved for a writer held on disk
  // without an active entry, or null when none is held locally.
  function heldJoinSeq (joins, x) {
    let seq = null
    if (joins === null) return seq
    for (const j of joins) if (j.group === x.group && j.writer === x.key && (seq === null || j.seq < seq)) seq = j.seq
    return seq
  }

  function diaryVerdict (e, diaryRaws) {
    if (!diaryRaws[0]) return 'not-in-log'
    return verdictFor(e.diary, diaryRaws[0]) || (diaryRaws[1] ? joinVerdict(diaryRaws[1], e.seq, e.group, e.key) : 'unbound')
  }

  function condemning (reason) {
    return reason === 'blocked' || reason === 'revoked-issuer' || reason === 'fork'
  }

  // Nothing was judged: the blocks did not arrive in time.
  function transient (reason) {
    return reason === 'timeout'
  }

  async function onGroupGate (e, r) {
    const closeOpened = async () => {
      if (r.core) await r.core.close().catch(noop)
      if (r.dcore) await r.dcore.close().catch(noop)
    }
    if (e.state !== 'gating' || ended) {
      await closeOpened()
      return
    }
    // Protecting an honest seeder from this node's own link view: a root
    // paged only as a linked community that no held group root names any
    // more when its verdict lands is dropped here, never charged nor
    // remembered as refused.
    if (!e.accepted && e.key === e.group && !groupSet.has(e.group) && !linkedCommunities.has(e.group)) {
      await closeOpened()
      emit({ event: 'group-skipped', key: e.key, reason: 'unwanted' })
      e.state = 'failed'
      dropGroupCore(e.key)
      return
    }
    if (r.reason) {
      if (transient(r.reason)) {
        groupTimeoutError(e.key)
        const unstored = r.writerHere !== true && !e.wasStored
        // Long-running mode tries again on the next pass. Protecting the run
        // from a seeder relisting a writer with unservable hints: the
        // timeout of an unstored writer is charged to it, and another
        // listing of the writer is gated now.
        if (!once) {
          e.state = 'failed'
          dropGroupCore(e.key)
          if (e.peer && unstored) chargeTimeout(e.peer, e.hint)
          rescanGroup(e.group, e.key, e.hintDiary, { peer: e.peer, key: e.key })
          return
        }
        // --once: the entry goes (no slot stays pinned) and another seeder's
        // listing is gated, so the writer stays a goal. The limit counts per
        // seeder: one seeder's bogus hints never exclude a writer another
        // seeder lists.
        if (!e.accepted) {
          const gk = groupKey(e.group, e.key)
          if (e.peer) {
            e.peer.keyTimeouts.add(gk, (e.peer.keyTimeouts.value(gk) || 0) + 1)
            e.peer.timedOut.add(e.hint)
            if (unstored) chargeTimeout(e.peer, e.hint)
          }
          emit({ event: 'group-skipped', key: e.key, reason: r.reason })
          e.state = 'failed'
          dropGroupCore(e.key)
          rescanGroup(e.group, e.key, e.hintDiary, { peer: e.peer, key: e.key })
          return
        }
      }
      // A wrong diary or join seq in the page item judges the hint, not the
      // writer: the entry goes (nothing is purged), and another listing of
      // the writer, from any other seeder, is gated.
      // Protecting an honest seeder from this node's own verdicts (its
      // blocklist, a fork or divergence seen here): only verdicts drawn from
      // blocks the seeder served are charged to it.
      // Protecting the store from a stored writer of this group whose
      // binding diary diverged while it was gated (divergeDiary and the
      // sweep skip gating entries): it goes like one bound by a forked
      // diary. The divergence is this node's verdict, so no hint is judged
      // and nothing is charged to the seeder.
      if (r.reason === 'not-in-log' && r.local === true && r.writerHere === true) {
        e.accepted = true
        failGroupCore(e, r.reason, { purge: true })
        return
      }
      if (hintMismatch(r.reason) && r.own !== true) {
        discardHint(e, r.reason, { charge: r.local !== true })
        return
      }
      if (!e.accepted && r.writerHere !== true) {
        // Protecting the table from listings of cores that are no writers
        // of the group: a never admitted entry goes, stored or not (I4: the
        // blocks of a stored core stay, and its honest listing under its
        // own group proceeds). Only a verdict from the writer's own data
        // refuses its key under this group (I1), and a header that is no
        // writer of the group is charged to the seeder.
        if (r.own === true) {
          emit({ event: 'group-skipped', key: e.key, reason: r.reason })
          e.state = 'failed'
          refused.add(groupKey(e.group, e.key))
          dropGroupCore(e.key)
          if (r.reason === 'header-invalid' || r.reason === 'wrong-group') badHint(e.peer, e.hint)
          return
        }
        // A verdict about the hinted diary judges the hint alone (I2).
        discardHint(e, r.reason, { charge: r.local !== true })
        return
      }
      // Purged only when it is a stored writer of this group that is now
      // condemned; a quota failure keeps its blocks.
      e.accepted = r.writerHere === true
      failGroupCore(e, r.reason, { purge: e.accepted && condemning(r.reason) })
      return
    }
    if (ending) {
      await closeOpened()
      return
    }
    let joins = null
    if (e.key !== e.group) {
      joins = await refineJoinSeqs(e, r.dcore)
      if (e.state !== 'gating' || ending) {
        await closeOpened()
        return
      }
    }
    // The per-diary cap, against the diary block 0 named and the join seq
    // the binding diary proved (I1), for every entry before it activates.
    // The root is one of its creator's writers and never gives way.
    if (e.key !== e.group) {
      const held = othersHolding(e.group, e.diary, e.key)
      if (held.length >= MAX_GROUP_WRITERS_PER_DIARY) {
        // Protecting the cap from a seeder's one-time listing order: a
        // writer stored in an earlier run, active or only held on disk,
        // gives way to an earlier proven join as one stored in this run
        // does, so the node converges on the fold's earliest joins. A holder
        // whose join this node has not proved never gives way.
        let top = null
        let topSeq = null
        for (const x of held) {
          if (x.key === x.group) continue
          const seq = x.state === 'active' ? x.seq : x.state === 'held' ? heldJoinSeq(joins, x) : null
          if (seq !== null && (top === null || seq > topSeq)) {
            top = x
            topSeq = seq
          }
        }
        if (top === null || !(e.seq < topSeq)) {
          await closeOpened()
          provenLater.add(groupKey(e.group, e.key), e.diary)
          refuseForCap(e.group, e.key)
          e.state = 'failed'
          dropGroupCore(e.key)
          // A refused stored writer keeps its blocks but no slot, so the
          // excess of an earlier run never starves the diary's other writers.
          diskSlots.delete(e.key)
          return
        }
        // Both joins are proven: the later one gives way and is purged, so
        // the stored writers of (group, diary) stay at the cap.
        provenLater.add(groupKey(top.group, top.key), top.diary)
        if (top.state === 'active') {
          failGroupCore(top, 'quota', { purge: true })
          dropGroupCore(top.key)
        } else {
          diskSlots.delete(top.key)
          condemnGroupCore(top.key, 'quota')
        }
      }
    }
    e.slot = true
    slotFreed(e.group)
    if (e.key === e.group) {
      try {
        recordBoundRoot(dataDir, e.key)
      } catch (err) {
        log('aviso: falha ao registrar raiz de grupo: ' + err.message)
      }
    }
    let core = r.core
    let dcore = r.dcore
    try {
      if (!core) {
        e.wasStored = await replicaStored(store, e.key)
        if (openHook) await openHook(e.key) // test-only
        core = await openGroupReplica(store, e.key)
      }
      if (!dcore && e.diary !== ownHex && !groupDiaries.has(e.diary) && !followHolds(e.diary)) {
        await releaseSettled(e.diary)
        dcore = await openReplica(store, e.diary)
      }
    } catch (err) {
      if (core && core !== r.core) await core.close().catch(noop)
      if (!ended) log('aviso: falha ao abrir núcleo de grupo ' + key8(e.key) + ': ' + err.message)
      dropGroupCore(e.key)
      return
    }
    e.core = core
    e.expected = r.expected
    e.diaryRaw = r.diaryRaw
    // A block or revocation that arrived while the gate or the opens above
    // were awaited is enforced now, against the current snapshot: its
    // enforcement may have run before this path opened the binding diary,
    // so a diary opened here goes too (the own diary and a followed one are
    // left to their own paths).
    // A stored writer has no fork watcher until activation: a fork while the
    // binding diary was read shows as a new fork id or a different block 0.
    let forkedNow = core.fork !== 0
    if (!forkedNow && r.core) {
      const now0 = await readLocal(core, 0)
      forkedNow = now0 === null || !b4a.equals(now0, r.gatedRaw) || core.fork !== 0
    }
    let diaryLate = null
    if (e.diary !== ownHex) {
      if (isBlockedKey(e.diary)) diaryLate = 'blocked'
      else if (verdictFor(e.diary, e.diaryRaw) === 'revoked-issuer') diaryLate = 'revoked-issuer'
    }
    let late = isBlockedKey(e.key) || groupBlocked(e.group) ? 'blocked' : diaryLate
    if (!late && (forkedNow || forkedDiaries.has(e.diary))) late = 'fork'
    // Protecting the run from a writer bound by a diary that diverged while
    // this gate ran: it would activate with no binding diary held.
    if (!late && divergedDiaries.has(e.diary)) late = 'not-in-log'
    if (late) {
      if (dcore) {
        const closed = dcore.close().catch(noop)
        if (diaryLate && !followHolds(e.diary)) purgeStored(e.diary, closed)
        else track(closed, noop, noop)
      }
      failGroupCore(e, late, { purge: true })
      return
    }
    if (!retainDiary(e.diary, dcore, r.want, r.diaryExpected)) {
      failGroupCore(e, 'timeout', { purge: false })
      return
    }
    if (e.diary !== ownHex) noteGroupCert(e.diary, e.diaryRaw)
    // A join deleted while the gate ran admits nothing (watchGroupDiary
    // withdraws only writers already active).
    if (e.key !== e.group && joinDeleted(e.diary, e.seq)) {
      failGroupCore(e, 'withdrawn', { purge: false })
      return
    }
    // Ended meanwhile: a core this run created goes (it may hold nothing).
    if (ending) {
      e.state = 'failed'
      e.core = null
      track((async () => {
        await core.close()
        if (!e.wasStored) await purgeKey(e.key)
      })(), noop, () => { if (!ended) purgeFailed(e.key) })
      return
    }
    activateGroupCore(e, core)
  }

  function followHolds (key) {
    const f = follows.get(key)
    return !!f && (f.state === 'active' || f.state === 'regate')
  }

  // The diary binding a foreign writer, kept with a live download so the
  // group can be folded from its joins (lib/member.js loadGroup). A followed
  // or own diary needs nothing more.
  // Protecting the node from a diary that passed the gate through the
  // quarantine and then serves other blocks to the main store: until its
  // stored block 0 and join block equal the quarantined ones the diary is
  // unverified (its download is unmet); a mismatch is a divergence that
  // purges it and every writer it binds here.
  // Protecting later writers of the diary from a dead binding session (a
  // purge closes every session of the core): a closing or closed dcore is
  // refused (false) and never held.
  function retainDiary (key, dcore, want, expected = null) {
    const held = groupDiaries.get(key)
    if (held) {
      held.want = Math.max(held.want, want)
      if (dcore && dcore !== held.core) dcore.close().catch(noop)
      return true
    }
    if (!dcore) return true
    if (followHolds(key)) {
      dcore.close().catch(noop)
      return true
    }
    if (dcore.closing || dcore.closed) return false
    const d = { core: dcore, range: null, stopFork: null, stopQuota: null, stopGrow: null, stopScan: null, want, failed: false, stopped: false, expected, verifying: false, tombs: new Map(), recompute: null, deleted: new Set(), present: 0, onPresent: null }
    groupDiaries.set(key, d)
    const fail = () => {
      if (d.failed) return
      d.failed = true
      stopGroupDiary(d)
      evaluate()
    }
    const verify = () => {
      if (d.failed || d.expected === null || d.verifying || d.present <= d.expected.seq) return
      d.verifying = true
      const exp = d.expected
      track(Promise.all([readLocal(dcore, 0), readLocal(dcore, exp.seq)]), ([raw0, rawSeq]) => {
        d.verifying = false
        if (d.failed || d.expected !== exp) return
        if (raw0 === null || rawSeq === null) return
        if (!b4a.equals(raw0, exp.raw0) || !b4a.equals(rawSeq, exp.rawSeq)) {
          hardError('bloco divergente: ' + key8(key) + ' (diário de grupo)')
          divergeDiary(key, d)
          return
        }
        d.expected = null
        evaluate()
      }, () => { d.verifying = false })
    }
    const check = () => { if (overQuota(dcore)) fail() }
    dcore.on('append', check)
    d.stopQuota = () => dcore.off('append', check)
    d.stopFork = watchFork(dcore, () => forkDiary(key, d))
    check()
    track(watchGroupDiary(d, dcore, () => {
      withdrawDeletedJoins(key, d)
      verify()
      evaluate()
    }), noop, noop)
    if (swarm) reattachMain(key, swarm.connections)
    return true
  }

  // Whether the binding diary this node holds deletes its block at seq.
  function joinDeleted (key, seq) {
    const d = groupDiaries.get(key)
    if (d && !d.failed && d.deleted.has(seq)) return true
    const f = follows.get(key)
    return followHolds(key) && !!f.deleted && f.deleted.has(seq)
  }

  // Protecting the run from a member who deletes the join that admitted a
  // writer: the fold clears that block, so the divergence check could never
  // read it again (its goal would stay unmet until the deadline) and the
  // writer would stay bound by a join that no longer exists. The join is
  // withdrawn: writers it binds go without condemning their blocks and are
  // not gated again in this run (failedWriters), while block 0 is still
  // compared with the gated one.
  function withdrawDeletedJoins (key, d) {
    if (ended || d.failed) return
    if (d.expected !== null && d.expected.seq > 0 && d.deleted.has(d.expected.seq)) {
      d.expected = { seq: 0, raw0: d.expected.raw0, rawSeq: d.expected.raw0 }
    }
    for (const e of [...groupCores.values()]) {
      if (e.diary === key && e.key !== e.group && e.state === 'active' && d.deleted.has(e.seq)) {
        failGroupCore(e, 'withdrawn', { purge: false })
      }
    }
  }

  // Protecting deletions from a member who holds the author's diary only for
  // a group binding: the same fold as a followed replica (watchEntry), so a
  // deleted block is cleared before anything is downloaded, never fetched
  // again from a stale peer, and a tombstone that arrives later clears what
  // it targets. Completion and growth are judged on the present length, so
  // a cleared block never holds a goal open nor hides the joins after it.
  // Block 0 is never a deletion target, so the divergence check still reads
  // it; a deleted join block is withdrawn (withdrawDeletedJoins).
  async function watchGroupDiary (d, dcore, changed) {
    const live = () => !d.failed && !d.stopped && !ended
    // Listening before the fold: a block that lands while presentState walks
    // (a late answer to a read the gate issued) would otherwise be seen by
    // neither the walk nor a listener, and watchPresent's first pass records
    // the length without scanning it.
    let early = []
    const onDownload = (index) => {
      if (!live() || d.tombs.has(index)) return
      if (early !== null) early.push(index)
      else track(scanArrived(d, dcore, index), noop, noop)
    }
    dcore.on('download', onDownload)
    d.stopScan = () => dcore.off('download', onDownload)
    let s = null
    try {
      s = await presentState(dcore)
      if (clearing && live()) await clearDeleted(dcore, s.deleted)
    } catch {}
    if (!live()) {
      dcore.off('download', onDownload)
      return
    }
    if (s !== null) {
      for (const r of s.raw) {
        if (r.record === null || r.record.type !== 'delete') continue
        const copy = validRecordCopy(r.record, r.seq)
        if (copy !== null && copy.type === 'delete') d.tombs.set(r.seq, copy.seq)
      }
      d.deleted = s.deleted
      d.present = s.present
    }
    d.recompute = { core: dcore, running: null, again: false }
    // Called after every refold: a tombstone can change d.deleted without
    // moving the present length (watchPresent saw its block first).
    d.onPresent = (length) => {
      if (!live()) return
      if (length > d.present) d.present = length
      changed()
    }
    // One sequential pass, so a large signed length never allocates a
    // promise per index. The tail past the walk is scanned as well: a block
    // can become local without a 'download' event on this session (the
    // upgrade of an existing replica).
    const pending = early
    early = null
    const tail = s !== null ? s.raw.length : 0
    track((async () => {
      for (const i of pending) {
        if (!live()) return
        if (!d.tombs.has(i)) await scanArrived(d, dcore, i)
      }
      for (let i = tail; i < Math.min(dcore.length, MAX_LOG_BLOCKS); i++) {
        if (!live()) return
        if (!d.tombs.has(i)) await scanArrived(d, dcore, i)
      }
    })(), noop, noop)
    d.range = clearing ? followRange(dcore, d.deleted) : dcore.download({ start: 0, end: -1, linear: true })
    let scanTo = d.present
    d.stopGrow = watchPresent(dcore, () => d.deleted, (length) => {
      if (!live()) return
      for (let i = scanTo; i < length; i++) {
        if (!d.tombs.has(i)) track(scanArrived(d, dcore, i), noop, noop)
      }
      if (length > scanTo) scanTo = length
      if (length > d.present) d.present = length
      changed()
    })
    changed()
  }

  // A binding diary whose stored blocks are not the gated ones: it and the
  // writers it binds go (the diary unless a follow holds it). Protecting
  // the run from a later writer bound by it: the diary is refused for the
  // rest of the run and its entry leaves groupDiaries, so no gate reads or
  // retains the failed entry. Protecting the store from writers it bound
  // that left the table with their blocks (a quota stop, a stored writer
  // refused for the cap): they go as well, as on a fork.
  function divergeDiary (key, d) {
    if (ended || d.failed) return
    d.failed = true
    divergedDiaries.add(key)
    stopGroupDiary(d)
    if (groupDiaries.get(key) === d) groupDiaries.delete(key)
    for (const e of groupCores.values()) {
      if (e.diary === key && e.state !== 'gating') condemnGroupCore(e.key, 'not-in-log')
    }
    track(sweepBoundWriters(key, 'not-in-log'), noop, () => { if (!ended) fail(['falha ao verificar núcleos de grupo de um diário divergente']) })
    if (!followHolds(key)) {
      const core = d.core
      track((async () => {
        await core.close()
        await purgeKey(key, { ifStored: true })
      })(), () => evaluate(), () => {
        if (!ended) purgeFailed(key)
        else log('aviso: falha ao limpar diário ' + key8(key))
      })
    }
    evaluate()
  }

  // A binding diary that forked goes like a blocked one: every writer it
  // binds is purged with reason 'fork', and so is the diary itself unless a
  // follow holds it (the follow handles its own fork).
  function forkDiary (key, d) {
    if (ended || d.failed) return
    d.failed = true
    stopGroupDiary(d)
    condemnForkedWriters(key)
    if (!followHolds(key)) {
      const core = d.core
      track((async () => {
        await core.close()
        await purgeKey(key, { ifStored: true })
      })(), () => evaluate(), () => {
        if (!ended) purgeFailed(key)
        else log('aviso: falha ao limpar diário ' + key8(key))
      })
    }
    evaluate()
  }

  // Any diary that forked, followed or not: the writers it binds go with
  // reason 'fork'. One still gating is refused when its gate ends.
  function condemnForkedWriters (key) {
    forkedDiaries.add(key)
    for (const e of groupCores.values()) {
      if (e.diary === key && e.accepted && e.state !== 'gating') condemnGroupCore(e.key, 'fork')
    }
    // Any stored writer whose own block 0 names the forked diary goes too,
    // whether or not this run still has an entry for it.
    track(sweepBoundWriters(key, 'fork'), noop, () => { if (!ended) fail(['falha ao verificar núcleos de grupo de um diário bifurcado']) })
  }

  // Stored writers (and roots it bound) of the condemned binding diary `key`
  // that this run holds no entry for go with `reason`.
  async function sweepBoundWriters (key, reason) {
    const dks = []
    for await (const dk of store.list()) {
      if (!b4a.equals(dk, diary.discoveryKey)) dks.push(dk)
    }
    const purges = []
    for (const dk of dks) {
      if (ended) break
      const auth = await store.getAuth(dk)
      if (!auth || !auth.key) continue
      const w = b4a.toString(auth.key, 'hex')
      if (ownKey(w) || groupCores.has(w)) continue
      const raw = await serialized(w, () => storedBlock0(dk, w))
      const header = raw === null ? null : decodeBlock(raw)
      if (header === null || header.diary !== key) continue
      if (validateWriterHeader(header) === null) {
        purges.push(condemnGroupCore(w, reason))
      } else if (validateGroupHeader(header) === null && await rootBoundBy(key, w)) {
        // A root its condemned creator diary bound goes as well.
        purges.push(condemnGroupCore(w, reason))
      }
    }
    await Promise.all(purges)
  }

  // At startup: every stored diary that forked condemns what it binds
  // before it goes (a follow purges its own forked replica afterwards).
  async function sweepForkedDiaries () {
    const dks = []
    for await (const dk of store.list()) {
      if (!b4a.equals(dk, diary.discoveryKey)) dks.push(dk)
    }
    for (const dk of dks) {
      if (ended) break
      const auth = await store.getAuth(dk)
      if (!auth || !auth.key) continue
      const key = b4a.toString(auth.key, 'hex')
      if (ownKey(key)) continue
      const raw = await serialized(key, () => storedBlock0(dk, key))
      if (raw === null) continue
      let h = null
      try {
        h = decodeBlock(raw)
      } catch {}
      if (h === null || validateRecord(h, 0) !== null) continue
      const core = store.get({ discoveryKey: dk, active: false })
      let forked = false
      try {
        await core.ready()
        forked = core.fork !== 0
      } finally {
        await core.close().catch(noop)
      }
      if (!forked) continue
      forkedDiaries.add(key)
      await sweepBoundWriters(key, 'fork')
    }
  }

  function stopGroupDiary (d) {
    d.stopped = true
    d.recompute = null
    if (d.stopQuota) d.stopQuota()
    if (d.stopFork) d.stopFork()
    if (d.stopGrow) d.stopGrow()
    if (d.stopScan) d.stopScan()
    try {
      if (d.range) d.range.destroy()
    } catch {}
    d.stopQuota = d.stopFork = d.stopGrow = d.stopScan = d.range = null
  }

  function stopGroupCore (e) {
    // The writer's own DHT session goes with it (a root's topic is left
    // alone: other parts of the node may announce it).
    if (e.discovery) {
      const session = e.discovery
      e.discovery = null
      track(Promise.resolve().then(() => session.destroy()), noop, noop)
    }
    if (e.stopGrow) e.stopGrow()
    if (e.stopFork) e.stopFork()
    if (e.stopQuota) e.stopQuota()
    try {
      if (e.range) e.range.destroy()
    } catch {}
    e.stopGrow = e.stopFork = e.stopQuota = e.range = null
  }

  // Protecting the node from a writer that passed the gate with a short
  // history and then serves another, over-quota block 0: its blocks are
  // kept for quota only once the main store's block 0 is the one the gate
  // judged; before that, an over-quota core is a divergence and goes.
  function checkGroupQuota (e) {
    if (ended || !e.core || e.state !== 'active' || !overQuota(e.core)) return false
    if (e.expected === null) {
      holdDiskSlot(e)
      failGroupCore(e, 'quota', { purge: false })
      return true
    }
    if (e.quotaCheck) return true
    e.quotaCheck = true
    const core = e.core
    track(readLocal(core, 0), (raw) => {
      e.quotaCheck = false
      if (e.core !== core || e.state !== 'active') return
      if (raw === null || !b4a.equals(raw, e.expected)) {
        groupDivergedError(e.key)
        failGroupCore(e, 'not-in-log', { purge: true })
        return
      }
      e.expected = null
      holdDiskSlot(e)
      failGroupCore(e, 'quota', { purge: false })
    }, noop)
    return true
  }

  function activateGroupCore (e, core) {
    e.state = 'active'
    e.accepted = true
    const check = () => { if (e.core === core) checkGroupQuota(e) }
    core.on('append', check)
    e.stopQuota = () => core.off('append', check)
    e.stopFork = watchFork(core, () => {
      if (!ended && e.core === core) failGroupCore(e, 'fork', { purge: true })
    })
    e.range = core.download({ start: 0, end: -1 })
    e.stopGrow = watchContiguous(core, (length) => onGroupGrow(e, length))
    if (checkGroupQuota(e)) return
    if (swarm) {
      try {
        const session = swarm.join(core.discoveryKey, { server: true, client: true })
        if (e.key !== e.group) e.discovery = session
      } catch {}
    }
    if (core.contiguousLength > 0) onGroupGrow(e, core.contiguousLength)
    evaluate()
  }

  // The block 0 the main store received must be the one the quarantine
  // judged (anything else is a fork served to us): checked once, before the
  // first growth is reported.
  function onGroupGrow (e, length) {
    if (ended || e.state !== 'active') return
    if (checkGroupQuota(e)) return
    if (e.expected === null) {
      emit({ event: 'group-downloaded', key: e.key, group: e.group, length })
      if (e.key === e.group) scanLinks(e.group, e.core)
      if (!once) markGroupsDirty(e.group)
      evaluate()
      return
    }
    if (e.confirming) return
    e.confirming = true
    const core = e.core
    track(readLocal(core, 0), (raw) => {
      e.confirming = false
      if (e.core !== core || e.state !== 'active' || raw === null) return
      if (!b4a.equals(raw, e.expected)) {
        groupDivergedError(e.key)
        failGroupCore(e, 'not-in-log', { purge: true })
        return
      }
      e.expected = null
      onGroupGrow(e, core.contiguousLength)
    }, noop)
  }

  // Skips a foreign group core; with `purge` whatever the main store holds
  // for it goes (tracked: a failure makes the run fail).
  function failGroupCore (e, reason, { purge }) {
    if (e.state === 'failing' || e.state === 'failed') return
    stopGroupCore(e)
    emit({ event: 'group-skipped', key: e.key, reason })
    // A failed group root no longer names a community this node follows.
    if (e.key === e.group && linkScans.has(e.group)) {
      linkScans.delete(e.group)
      setLinks(e.group, [])
    }
    const core = e.core
    e.core = null
    // A writer that fails, activated or not, leaves the table once the
    // failure settles (its slot frees) and
    // is not gated again in this run.
    const retire = () => {
      if (groupCores.get(e.key) !== e) return
      failedWriters.add(groupKey(e.group, e.key))
      dropGroupCore(e.key)
    }
    if (!purge) {
      e.state = 'failed'
      if (core) track(core.close(), noop, noop)
      retire()
      evaluate()
      return
    }
    e.state = 'failing'
    e.purging = track((async () => {
      if (core) await core.close()
      await purgeKey(e.key, { ifStored: true })
    })(), () => {
      e.state = 'failed'
      groupTargets.delete(e.key)
      retire()
      evaluate()
    }, () => {
      e.state = 'failed'
      if (!ended) purgeFailed(e.key)
      else log('aviso: falha ao limpar núcleo de grupo ' + key8(e.key))
    })
  }

  // A writer this run created that still holds nothing when it ends goes,
  // as a follow discarded from regate does.
  function discardEmptyGroupCores () {
    for (const e of groupCores.values()) {
      if (e.state !== 'active' || e.wasStored || !e.core || e.core.contiguousLength > 0) continue
      stopGroupCore(e)
      e.state = 'failed'
      e.discardedEmpty = true // still unmet for the outcome
      const core = e.core
      e.core = null
      track((async () => {
        await core.close()
        await purgeKey(e.key)
      })(), noop, () => {
        if (!ended) purgeFailed(e.key)
        else log('aviso: falha ao limpar núcleo de grupo ' + key8(e.key))
      })
    }
  }

  // A new snapshot: writers whose key, diary or group it blocks go, and so
  // do writers bound by a diary of a newly revoked issuer, whatever their
  // state (a writer skipped for quota still holds its blocks). One still
  // gating is judged again when its gate ends (blocklistGen).
  function groupsAdopted (r) {
    for (const e of groupCores.values()) {
      if (e.state === 'gating' || !e.accepted) continue
      if (isBlockedKey(e.key) || isBlockedKey(e.diary) || groupBlocked(e.group)) {
        condemnGroupCore(e.key, 'blocked')
      } else if (r.revokedAdded.size > 0 && e.diaryRaw && e.diary !== ownHex && verdictFor(e.diary, e.diaryRaw) === 'revoked-issuer') {
        condemnGroupCore(e.key, 'revoked-issuer')
      }
    }
    for (const [key, d] of groupDiaries) {
      if (isBlockedKey(key) && !d.failed) {
        d.failed = true
        stopGroupDiary(d)
      }
    }
    if (r.added.size > 0 || r.revokedAdded.size > 0) sweepGroupBlocked()
  }

  // Purges a stored group core for `reason` whatever its entry's state.
  // -> the tracked purge.
  function condemnGroupCore (key, reason) {
    const e = groupCores.get(key)
    if (e && e.state === 'active') {
      failGroupCore(e, reason, { purge: true })
      return e.purging
    }
    if (e && e.state === 'failing') return purgeStored(key, e.purging)
    if (!e || e.state === 'gating') emit({ event: 'group-skipped', key, reason })
    return purgeStored(key)
  }

  // Stored group cores, not only the ones this run gated, whose header names
  // a blocked diary or group, or a diary certified by a revoked issuer, are
  // purged like a blocked author. Runs only while the snapshot blocks or
  // revokes something; own writers are never touched.
  // Protecting a revocation from a writer stored before its binding was
  // recorded: at start, while the snapshot revokes any issuer, a foreign
  // writer whose binding diary has neither a stored block 0 nor a record
  // goes ('not-in-log'); a later gate fetches it again.
  let groupSweepChain = Promise.resolve()

  function sweepGroupBlocked ({ atStart = false } = {}) {
    const run = groupSweepChain.then(() => sweepGroupBlockedOnce(atStart))
    groupSweepChain = run.catch(noop)
    return track(run, noop, () => {
      if (!ended) fail(['falha ao verificar núcleos de grupo bloqueados'])
      else log('aviso: falha ao verificar núcleos de grupo bloqueados')
    })
  }

  async function sweepGroupBlockedOnce (atStart) {
    if (blocklist === null || (blocklist.blocked().size === 0 && blocklist.revokedIssuers().size === 0)) return
    const dks = []
    for await (const dk of store.list()) {
      if (!b4a.equals(dk, diary.discoveryKey)) dks.push(dk)
    }
    const revoked = new Map() // diary -> whether its issuer is revoked
    const raws = new Map() // diary -> its block 0 (stored or recorded), or null
    const purges = []
    for (const dk of dks) {
      if (ended) break
      const auth = await store.getAuth(dk)
      if (!auth || !auth.key) continue
      const key = b4a.toString(auth.key, 'hex')
      if (ownKey(key) || isBlockedKey(key)) continue
      const raw = await serialized(key, () => storedBlock0(dk, key))
      const header = raw === null ? null : decodeBlock(raw)
      if (header === null) continue
      let reason = null
      const writer = validateWriterHeader(header) === null
      if (writer) {
        if (isBlockedKey(header.diary) || groupBlocked(header.group)) reason = 'blocked'
      } else if (validateGroupHeader(header) === null) {
        // Protecting a root from a header that names a blocked diary which
        // never bound it: only a root its creator's diary bound goes, as at
        // the seeder.
        if (isBlockedKey(header.diary) && await rootBoundBy(header.diary, key)) reason = 'blocked'
      } else {
        continue
      }
      if (reason === null && header.diary !== ownHex && await diaryRevoked(header.diary, revoked, raws)) reason = 'revoked-issuer'
      if (reason === null && atStart && writer && header.diary !== ownHex && blocklist.revokedIssuers().size > 0 &&
        await bindingBlock0(header.diary, raws) === null) reason = 'not-in-log'
      if (reason === null || ended) continue
      purges.push(condemnGroupCore(key, reason))
    }
    await Promise.all(purges)
  }

  // Whether `diaryKey` bound `root`: proven by its stored replica, or a root
  // this node recorded as bound (a root naming a diary that never bound it
  // is kept). Protecting the record from a partial or unreadable replica:
  // a replica that does not prove the join never hides the record.
  async function rootBoundBy (diaryKey, root) {
    if (await diaryBindsRoot(diaryKey, root)) return true
    return readBoundRoots(dataDir).includes(root)
  }

  // Whether the stored replica of `diaryKey` holds an on:true group-join of
  // `root` for itself. A diary not held proves nothing.
  async function diaryBindsRoot (diaryKey, root) {
    if (!(await replicaStored(store, diaryKey))) return false
    return serialized(diaryKey, async () => {
      const core = await openReplica(store, diaryKey)
      try {
        for (const { record } of await readAll(core)) {
          if (record && record.type === 'group-join' && record.group === root && record.writer === root && record.on === true) return true
        }
        return false
      } catch {
        return false
      } finally {
        await core.close().catch(noop)
      }
    })
  }

  // A diary purged in this run for a revoked issuer, or one whose block 0
  // (stored, else the one its writer's gate verified) names a revoked issuer.
  async function diaryRevoked (key, memo, raws) {
    if (memo.has(key)) return memo.get(key)
    let out = revokedDiaries.has(key)
    if (!out && blocklist.revokedIssuers().size > 0) {
      const raw = await bindingBlock0(key, raws)
      out = revokedDiaries.has(key) || (raw !== null && gateVerdict(raw, key, association, revokedIssuers()) === 'revoked-issuer')
    }
    memo.set(key, out)
    return out
  }

  // Protecting the verdict from a partial replica: a stored diary without
  // block 0 falls back to the recorded certificate. -> raw or null.
  async function bindingBlock0 (key, raws) {
    if (raws.has(key)) return raws.get(key)
    let raw = await serialized(key, () => storedBlock0(Hypercore.discoveryKey(b4a.from(key, 'hex')), key))
    if (raw === null) raw = groupCerts.get(key) || null
    raws.set(key, raw)
    return raw
  }

  // Block 0 of a stored core, opened by discovery key without creating
  // anything (as storedVerdict); null when absent.
  async function storedBlock0 (dk, key) {
    if (!(await replicaStored(store, key))) return null
    const session = store.get({ discoveryKey: dk, active: false })
    try {
      await session.ready()
      return await session.get(0, { wait: false, raw: true })
    } catch {
      return null
    } finally {
      await session.close().catch(noop)
    }
  }

  function onMessage (msg, peer) {
    if (ending) return
    switch (msg.type) {
      case 'hello': {
        peer.verifiedSeeder = msg.role === 'seeder' &&
          peer.peerKey !== null &&
          seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
        if (!peer.verifiedSeeder) startBudget()
        if (!peer.gotHello) {
          peer.gotHello = true
          emit({ event: 'peer', role: peer.remoteRole, peerKey: peer.peerKey, verified: peer.verifiedSeeder })
          checkGrace()
        }
        maybePage(peer)
        for (const [key, length] of peer.remoteHave) {
          if (relevant(key)) {
            peer.lastAdv.set(key, length)
            peer.emittedHave.set(key, length)
          }
          noteAdvertisement(key, length, peer)
        }
        break
      }
      case 'have': {
        // Any growth the seeder reports may come with new writers.
        if (peer.verifiedSeeder && !once && peer.groupDirty) for (const g of pagedList()) peer.groupDirty.add(g.group)
        // H1 (cycle 3): only our own key or a followed key, and only when
        // the length this peer advertises for it changed; a repeat does no
        // work at all (no event, no evaluate).
        if (!relevant(msg.key)) return
        if (peer.lastAdv.get(msg.key) === msg.length) return
        peer.lastAdv.set(msg.key, msg.length)
        if (peer.emittedHave.get(msg.key) !== msg.length) {
          peer.emittedHave.set(msg.key, msg.length)
          emit({ event: 'have', key: msg.key, length: msg.length })
        }
        noteAdvertisement(msg.key, msg.length, peer)
        break
      }
      case 'admitted':
        if (relevant(msg.key)) peer.lastAdv.set(msg.key, msg.length)
        if (msg.key === ownHex && peer.verifiedSeeder) {
          peer.admittedOwn = true
          admittedEver = true
          emit({ event: 'admitted', key: msg.key, length: msg.length })
        }
        noteAdvertisement(msg.key, msg.length, peer)
        break
      case 'rejected':
        peer.lastAdv.delete(msg.key) // the advertisement is gone (remoteHave too)
        if (msg.key === ownHex) {
          if (!peer.verifiedSeeder) {
            // At most once per peer (H1, cycle 3).
            if (!peer.withdrawnOwn) {
              peer.withdrawnOwn = true
              emit({ event: 'withdrawn', key: msg.key, peerKey: peer.peerKey, reason: msg.reason })
            }
          } else if (msg.reason === 'timeout') {
            peer.admittedOwn = false
            emit({ event: 'rejected', key: msg.key, reason: msg.reason })
            softError('rejeitado: timeout (' + key8(peer.peerKey) + ')')
          } else {
            peer.admittedOwn = false
            emit({ event: 'rejected', key: msg.key, reason: msg.reason })
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

  // Keys whose advertisements matter to this run: our own and the follows
  // that are not blocked (a blocked author's advertisements are ignored).
  function relevant (key) {
    return key === ownHex || (follows.has(key) && !isBlockedKey(key))
  }

  function onPeerDropped (ev) {
    log('aviso: par descartado (' + key8(ev.peerKey) + '): ' + ev.reason)
    emit(ev)
  }

  function onConnection (socket, info) {
    socket.on('error', noop)
    if (ending) {
      socket.destroy()
      return
    }
    // Connection cap (S1), before the store replicates the socket.
    if (refuseOverConnectionLimit(swarm, socket, { limit: maxConnections, log: onPeerDropped })) return
    // Live connections per topic (re-discovery resumes when the last one of a
    // topic goes away); info.topics is known for client-side connections only.
    liveConnections++
    const topicsOf = []
    if (info && Array.isArray(info.topics)) {
      for (const t of info.topics) topicsOf.push(b4a.toString(t, 'hex'))
    }
    for (const hex of topicsOf) {
      if (!topicConnections.has(hex)) topicConnections.set(hex, new Set())
      topicConnections.get(hex).add(socket)
    }
    socket.once('close', () => {
      liveConnections--
      for (const hex of topicsOf) {
        const set = topicConnections.get(hex)
        if (!set) continue
        set.delete(socket)
        if (set.size === 0) topicConnections.delete(hex)
      }
      for (const e of follows.values()) {
        e.failedSockets.delete(socket)
        if (e.fetch && !ending) e.fetch.release(socket)
      }
    })
    store.replicate(socket)
    attachModeration(socket)
    const groupHandle = attachGroupChannel(socket)
    let peer
    try {
      // The peer's opened/hello promises may resolve false/null on close;
      // this module tracks hello through gotHello/onmessage instead.
      peer = attachAdmission(socket, {
        role: 'member',
        have: inventory(),
        onmessage: onMessage,
        onclose: (p) => {
          peers.delete(p)
          p.groupClosed = true
          dropClaims(p)
          checkGrace()
          evaluate()
          // Per-connection advertisement state goes with the connection.
          p.lastAdv = new Map()
          p.emittedHave = new Map()
          if (inspectHook) lastClosedPeer = p // test-only
        },
        oninventory: () => evaluate(),
        messageBurst,
        messageRate,
        log: (ev) => {
          if (ev && ev.event === 'inventory-timeout') log('aviso: inventário incompleto (' + key8(ev.peerKey) + ')')
          else if (ev && ev.event === 'peer-dropped') onPeerDropped(ev)
        }
      })
    } catch (err) {
      log('aviso: canal de admissão: ' + err.message)
      return
    }
    peer.gotHello = false
    peer.verifiedSeeder = false
    peer.admittedOwn = false
    peer.ignoredClaims = null // keys whose claim-ignored was emitted (H1)
    peer.ignoredInterest = false // peer-ignored emitted (H1)
    peer.lastAdv = new Map() // key -> last length processed (own + follows only)
    peer.emittedHave = new Map() // key -> last length reported as a 'have' event
    peer.withdrawnOwn = false // 'withdrawn' emitted for our diary
    peer.groupHandle = groupHandle
    peer.groupSupported = groupHandle ? null : false // the seeder speaks 'varanda/groups/1'
    peer.groupClosed = !groupHandle // no more pages from this peer (closed, timed out, gone)
    peer.groupPaging = false
    peer.groupPasses = new Map() // group -> { complete, items: Map key -> item } of the last full pass
    peer.groupCurrent = new Map() // group -> the pass in progress
    peer.badHints = createMemo(() => MAX_BAD_HINTS) // page items of this seeder a gate disproved
    peer.timedOut = createMemo(gateLimit) // page items of this seeder whose gate timed out (--once)
    peer.timeoutHints = createMemo(() => MAX_TIMEOUT_HINTS) // gate timeouts of unstored writers this seeder listed
    peer.keyTimeouts = createMemo(gateLimit) // 'group:key' -> gate timeouts of this seeder's listings (--once)
    peer.groupSuspendedUntil = 0 // long-running: not paged before this time (cut off for hints)
    peer.groupCutOff = false // --once: cut off for hints for the run
    peer.groupPacer = createRequestPacer({ now: () => Date.now() })
    peer.groupDirty = new Set() // groups a hint asks to page again (long-running mode)
    peer.groupNext = new Map() // group -> when it is due again (long-running mode)
    peers.add(peer)
    if (groupHandle) {
      groupHandle.supported.then((ok) => {
        peer.groupSupported = ok
        if (!ok) peer.groupClosed = true
        maybePage(peer)
        evaluate()
      }, noop)
    }
    // send() queues until the channel opens, right after hello.
    if (cert) peer.send({ type: 'announce', key: ownHex, cert })
  }

  // Reflects CURRENT live connections only: a topic whose last peer left is
  // looked up again by startRediscovery.
  function topicHasPeer (topic) {
    if (ending) return true
    const hex = b4a.toString(topic, 'hex')
    if (hex === rendezvousHex) return liveConnections > 0
    const key = topicKeys.get(hex)
    if (!key) return true
    if (isBlockedKey(key)) return true // nobody is looked up for a blocked author
    // Item 6: a connection discovered on the topic counts only while its
    // peer has not sent hello yet, is a verified seeder, or advertises the
    // key at >= 1 (an empty follower must not stop re-discovery).
    for (const socket of topicConnections.get(hex) || []) {
      const p = socket._varandaPeer
      if (!p || !p.gotHello || p.verifiedSeeder) return true
      if ((p.remoteHave.get(key) || 0) >= 1) return true
    }
    // D1: a peer advertising the key at 0 (a follower of a pending key) holds
    // nothing for us, so it does not stop the topic's re-discovery.
    for (const p of peers) if ((p.remoteHave.get(key) || 0) >= 1) return true
    return false
  }

  function onAbort () {
    if (ending) return
    if (once) finish(timeoutOutcome)
    else finish(() => [true, []])
  }

  function timeoutOutcome () {
    const ps = helloPeers()
    if (ps.length === 0) return [false, ['sem pares']]
    const unmet = unmetGoals()
    // The deadline may have hit while a purge was in flight; if everything
    // holds once it settled, the run succeeded.
    if (unmet.length === 0 && ps.every((p) => p.inventoryComplete || !counts(p))) return [true, []]
    return [false, ['tempo esgotado: ' + unmet.join(', ')]]
  }

  function onDeadline () {
    deadlineTimer = null
    if (ending) return
    deadlineHit = true
    // Gate fetches never run past the deadline: let them report first.
    Promise.allSettled([...inflight]).then(() => finish(timeoutOutcome))
  }

  try {
    store = await openStore(dataDir, storeOptions)
    // R6.2: the main store holds the RocksDB lock before the quarantine is wiped.
    diary = await openDiary(store)
    ownHex = b4a.toString(diary.key, 'hex')
    // D3: only block 0 is read (same semantics as genesisCert(readAll)).
    const g = genesisCert(diary.contiguousLength > 0
      ? [{ seq: 0, record: decodeBlock(await diary.get(0, { wait: false, raw: true })) }]
      : [])
    if (g && certForKey(g, ownHex, association).ok) cert = g
    else log('sem certificado válido no bloco 0: o diário não será anunciado')
    // Own writers before the blocklist: they are never purged here, like the
    // own diary (isBlockedKey).
    await openOwnWriters()
    groupCerts = readGroupCerts(dataDir)

    // The moderation snapshot, read with the data-dir lock held. A stored
    // snapshot that no longer verifies is ignored; a read failure stops the
    // run (fail closed: never serve or fetch without knowing what is blocked).
    blocklist = createBlocklistState({
      association,
      load: () => {
        const stored = readBlocklist(dataDir, {
          onUnreadable: (aside, restored) => log(aside === null
            ? 'aviso: lista de bloqueio ausente; usando a cópia anterior'
            : 'aviso: lista de bloqueio ilegível guardada como ' + aside + (restored ? '; usando a cópia anterior' : '; pedindo a lista a um par'))
        })
        if (stored === null) return null
        if (!verifySnapshot(stored.snapshot, association).ok) {
          log('aviso: lista de bloqueio inválida ignorada')
          return null
        }
        return stored.snapshot
      },
      save: (snapshot) => writeBlocklist(dataDir, snapshot)
    })
    try {
      await blocklist.ready()
    } catch {
      throw new Error('falha ao ler a lista de bloqueio')
    }
    warnOwn()
    // Every stored group core whose diary or group is blocked goes first:
    // whether a blocked diary bound a root is read from that diary's
    // replica, so it must still be there.
    if (!ending) await sweepGroupBlocked({ atStart: true })
    // Every stored replica of a blocked key goes before anything is served,
    // followed or not (an unfollowed replica is still served by
    // store.replicate); the own diary is never purged (isBlockedKey).
    for (const key of blocklist.blocked()) {
      if (ending) break
      if (isBlockedKey(key)) await purgeStored(key)
    }
    // Likewise every stored diary certified by a revoked issuer (no follow
    // entry exists yet, so each one is purged directly).
    if (!ending) await sweepRevoked()
    // And every stored diary that forked, with what it binds.
    if (!ending) await sweepForkedDiaries()
    if (!ending) await loadDiskSlots()
    // Growth while a scan runs marks it to go again (scanLinks `again`).
    linksReady = true
    for (const g of groupList) if (g.writer === g.group) scanLinks(g.group, ownWriters.get(g.writer).core)

    qstore = await openQuarantine(dataDir, storeOptions)
    if (inspectHook) inspectHook({ claimCount, topicHasPeer, failedSocketCount, lastClosedPeer: () => lastClosedPeer, recomputeCount: () => recomputes, groupTargetCount: () => groupTargets.size, groupCoreCount: () => groupCores.size, groupDiaryKeys: () => [...groupDiaries.keys()], swarmTopicCount: () => swarm ? [...swarm.topics()].length : 0, createMemo: (limit) => createMemo(() => limit), hardError, groupDiverged: groupDivergedError, divergeDiary: (key) => divergeDiary(key, groupDiaries.get(key) || { core: { close: async () => {} }, failed: false }) }) // test-only

    // One deadline (item 7): the completion timer and the gate fetches share
    // `deadline`, computed before the startup I/O.
    if (once) deadlineTimer = setTimeout(onDeadline, Math.max(0, deadline - Date.now()))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    } else if (!once) {
      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.once(sig, onAbort)
        signalHandlers.push(sig)
      }
    }

    // Follow gate at start (R5.8 a), before any swarm.
    // The inventory (own diary + follows) must fit a hello (item 4c): a
    // hand-edited follows.json over the limit uses the first maxFollows.
    let followList = readFollows(dataDir)
    const listed = new Set(followList.map((k) => typeof k === 'string' ? k.toLowerCase() : ''))
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
        topic: Hypercore.discoveryKey(b4a.from(key, 'hex')),
        range: null,
        stopGrow: null,
        stopFork: null,
        retryTimer: null,
        fetching: false,
        fetch: null, // the in-flight quarantine fetch handle ({ promise, addSocket })
        gating: false,
        advSeq: 0,
        fetchedAdv: 0,
        stopQuota: null,
        stopScan: null,
        present: 0, // present length (lib/deletion.js) of an open replica
        deleted: new Set(), // the fold over the tombstones it holds
        tombs: new Map(), // seq -> target of each valid tombstone held locally
        recompute: null, // { core, running, again }: the one pending deletion recompute
        claims: new Map(), // peerKey -> { length } (G1 claims, --once only)
        failedSockets: new Set(), // open sockets of failed fetches for this key (H2, --once)
        cutByDeadline: false, // the last fetch ended with the deadline (item 4)
        discardedRegate: false // purged from regate when the run ended (item 5)
      }
      follows.set(key, entry)
      // A blocked author stays in follows.json but is never opened (its
      // replica was purged above).
      if (isBlockedKey(key)) {
        entry.state = 'failed'
        skipped.push({ key, reason: 'blocked' })
        emit({ event: 'skipped', key, reason: 'blocked' })
        continue
      }
      const core = await openReplica(store, key)
      let reason = null
      // has(0), not contiguousLength: a cleared block may pull the latter
      // back, and block 0 is never cleared.
      const held = core.length > 0 && await core.has(0)
      if (core.fork !== 0) reason = 'fork'
      else if (held) reason = await gateLocal(core, key)
      if (held && reason === null) {
        await activate(entry, core)
        continue
      }
      // Tracked like the runtime purges: an abort during it still waits for
      // it, and a failure makes the result ok: false.
      let purged = true
      await track((async () => {
        await core.close()
        await purgeKey(key)
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

    if (!ending && clearing) await sweepUnfollowed(listed)

    if (!ending) {
      swarm = createSwarm({ bootstrap, host })
      swarm.on('connection', onConnection)
      const rendezvous = topicFor(association)
      rendezvousHex = b4a.toString(rendezvous, 'hex')
      const topics = [rendezvous, diary.discoveryKey]
      topicKeys.set(b4a.toString(diary.discoveryKey, 'hex'), ownHex)
      for (const e of follows.values()) {
        if (e.state === 'failed') continue
        topics.push(e.topic)
        topicKeys.set(b4a.toString(e.topic, 'hex'), e.key)
      }
      for (const g of groupList) {
        topics.push(Hypercore.discoveryKey(b4a.from(g.group, 'hex')))
        if (g.writer !== g.group) topics.push(ownWriters.get(g.writer).core.discoveryKey)
      }
      stopDiaryWatch = watchContiguous(diary, (length) => {
        broadcast({ type: 'have', key: ownHex, length })
        evaluate()
      })
      // The deadline and an abort interrupt network startup: the join is
      // raced against the run's completion; when that wins, the swarm is
      // destroyed in the finally below and the timeout/abort result stands.
      const done = store.findingPeers()
      try {
        await Promise.race([(joinHook || joinAndFlush)(swarm, topics), finished])
      } finally {
        done()
      }
      if (!ending) {
        emit({ event: 'ready', topic: rendezvousHex })
        stopRediscovery = startRediscovery(swarm, topics, {
          intervalMs: once ? REDISCOVER_ONCE_MS : REDISCOVER_LONG_MS,
          hasPeer: topicHasPeer,
          log: (ev) => log('aviso: redescoberta: ' + (ev && ev.error))
        })
        graceTimer = setTimeout(() => {
          graceTimer = null
          graceDone = true
          evaluate()
        }, GRACE_MS)
        checkGrace()
        evaluate()
      }
    }

    await finished
    return result
  } finally {
    ending = true
    ended = true
    if (deadlineTimer) clearTimeout(deadlineTimer)
    if (graceTimer) clearTimeout(graceTimer)
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (signal) signal.removeEventListener('abort', onAbort)
    for (const sig of signalHandlers) process.removeListener(sig, onAbort)
    if (stopRediscovery) stopRediscovery()
    if (stopDiaryWatch) stopDiaryWatch()
    discardRegate() // a throw may have skipped finish()
    discardEmptyGroupCores()
    for (const e of follows.values()) stopEntry(e)
    for (const e of groupCores.values()) stopGroupCore(e)
    for (const d of groupDiaries.values()) stopGroupDiary(d)
    if (swarm) await swarm.destroy().catch(noop)
    // The quarantine is closed and removed, and every in-flight fetch and
    // purge has settled, BEFORE the main store closes: store.close releases
    // the data-dir lock, so a run that takes the lock right after this one
    // (and wipes/recreates the quarantine) never has it removed under it.
    if (qstore) {
      await qstore.close().catch(noop)
      await Promise.allSettled([...inflight])
      removeQuarantine(dataDir)
    }
    // A throw before `finished` may leave purges in flight: never close the
    // store underneath them.
    while (settling.size > 0) await Promise.allSettled([...settling])
    if (store) await store.close().catch(noop)
  }
}

module.exports = {
  readBoundRoots,
  recordBoundRoot,
  runSync,
  createRequestPacer,
  GATE_TIMEOUT_MS,
  GATE_MIN_TIMEOUT_MS,
  GATE_RETRY_MS,
  UNVERIFIED_BUDGET_MS,
  GROUP_REQUEST_BURST,
  GROUP_REQUEST_RATE
}
