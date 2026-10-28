// Seeder: an always-on, certificate-gated replicator (docs/protocol.md
// sections 1, 3, 4 and 5). A log is kept only when its block 0 is a valid
// member certificate for the trusted association; until then its block 0 is
// fetched through the quarantine store and never opened in the main store.
//
// Media cores (lib/media.js) ride on the same invariants through a TWO-WAY
// binding: a media core K is kept only while (1) an admitted, gated,
// non-blocked diary D names K in one of its latest MAX_MEDIA_CORES
// `media-core` records (the seeder scans D's own blocks for them, never
// trusting a peer's word) AND (2) K's block 0 is a valid media header naming
// that same D (fetched through the quarantine like a diary's block 0). Either
// side alone admits nothing: a diary cannot pull in a core it does not own,
// and a core cannot attach itself to a diary that never declared it. Every
// stored media core is listed in admitted.json (`media: { K: { diary, seq } }`,
// written by the same serialized writer) and purged exactly like a diary:
// persisted before it is opened in the main store, purged before it leaves
// the file, dropped with its diary, on a fork, over the media quota, or when
// it falls out of the diary's latest set. Media keys NEVER travel on the
// admission channel ('varanda/admission/1'): no announce, no `have`, no new
// message type. A new type would be a bad message for every peer from before
// this change (they disconnect on it) and the `have` inventory is capped at
// MAX_INVENTORY entries that members read as diaries; readers fetch media
// over HTTP (apps/cli/lib/seed-ws.js) through mediaRead, and the swarm serves
// K's discovery key like any other admitted core.
//
// Engagement index (lib/engagement-index.js): an IN-MEMORY index of replies,
// quotes, likes, reposts, post lists and profile/username seq hints, rebuilt
// at every start and on re-admission after incoming edges were removed,
// from the served diaries by a scan of their own blocks (the
// seeder never trusts a peer's word about what a diary says). It runs on its
// OWN cursor and queue (`indexed`, _indexQueue), separate from the media-core
// scan, so indexing never delays media admission. The index is bounded
// (records, targets and per-diary quotas): at a cap a diary's cursor PAUSES
// at the refused seq, never skipping, and resumes when a drop frees room.
// Every answer carries `indexing` (the startup or rebuild pass has not
// finished) and `complete` (no cursor behind or paused), so a reader
// never mistakes a partial index for the whole truth. A dropped, purged or
// blocked diary leaves the index the moment its drop starts, and reads filter
// out any author that is not served, gated and unblocked. Trust model: the
// index only says WHERE TO LOOK (refs, seq hints, counts); nodes fetch and
// verify the content from the diaries themselves (indexPost, indexCounts,
// indexMember back the /index routes of apps/cli/lib/seed-ws.js).
//
// Name index (lib/name-index.js): fed by the same scan, the folded tokens of
// each served author's newest display name and its verified @nome. Like the
// engagement index it only says WHERE TO LOOK: a member re-reads and
// verifies every name from the diary at the returned seq hints. The @nome's
// signature and issuer delegation are verified once per index pass (never
// per record, never at query time); the @nome issuer's revocation is checked
// at every query against the current snapshot, so a revoked issuer stops
// matching without a rescan, and a diary whose re-gate after a newly revoked
// issuer is still pending (block 0's verdict) is held out of results. Its
// cap refuses a new author like the engagement caps: the cursor pauses and
// resumes when a drop frees room. indexSearch backs /index/search.
// Topic search index (lib/topic-index.js, issue #81): which public posts
// contain which whole words, in memory only and rebuilt like the engagement
// index, but on ITS OWN cursor and queue (`topicIndexed`, _topicQueue).
// It is not folded into _runIndex because the engagement add is NOT
// idempotent (engagement-index.js counts every accepted call, so re-reading a
// block paused for search would double count), and docs/protocol.md already
// separates scans so one cannot stall another. So a search pause never sets
// entry.indexPaused, never changes indexPost/indexCounts/indexMember or the
// engagement `complete` flag, and an engagement rebuild never rescans search
// (a search posting has no edge from another diary). The search cursor
// pauses at a capacity refusal like the engagement one and resumes when a
// drop frees room. A dropped diary leaves the search index synchronously in
// _drop, before its purge starts (the removal deadline of "conteúdo listado
// sai do índice"). Same trust model: a hit is a hint `<author>:<seq>`, the
// node reads and verifies the post itself (indexTopic backs the
// /index/topic route of apps/cli/lib/seed-ws.js).
const fs = require('#fs')
const path = require('#path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  normalizeHex,
  certForKey,
  loadKeyPairFile,
  saveKeyPairFile,
  seederCertForKey
} = require('./cert')
// Called through the module object (not destructured) so tests can count the
// username verifications (as lib/username.js).
const cert = require('./cert')
const {
  topicFor,
  generateNoiseKeyPair,
  createSwarm,
  joinAndFlush,
  startRediscovery,
  attachAdmission,
  refuseOverConnectionLimit,
  watchContiguous,
  watchFork,
  startQuarantineFetch,
  MAX_CONNECTIONS,
  MAX_INVENTORY
} = require('./net')
const {
  openStore,
  lockHeld,
  openReplica,
  openMediaReplica,
  openQuarantine,
  removeQuarantine,
  purgeReplica,
  readConfig,
  writeConfig,
  readJson,
  writeJsonAtomic,
  readBlocklist,
  hasUnreadableBlocklist,
  writeBlocklist
} = require('./store')
const { createBlocklistState, verifySnapshot, compareSnapshots } = require('./blocklist')
const { attachBlocklist } = require('./blocklist-net')
const { createNoticeIndex } = require('./notices')
const { noteGrowth, countActive } = require('./activity')
const { attachNotices } = require('./notices-net')
const {
  validateRecord,
  validRecordCopy,
  decodeBlock,
  MAX_LOG_BLOCKS,
  MAX_LOG_BYTES,
  MAX_MEDIA_BLOCKS,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_CORES
} = require('./records')
const { validateMediaHeader, latestMediaCores } = require('./media')
const { createEngagementIndex } = require('./engagement-index')
const { createNameIndex } = require('./name-index')
const { parseQuery } = require('./search-text')
const { createTopicIndex, QUERY_RE } = require('./topic-index')
const { UsageError } = require('./errors')
const clock = require('./clock')
const {
  FrameGuard,
  frameDeadlineFor,
  MAX_HANDSHAKE_FRAME,
  MAX_HANDSHAKE_BYTES,
  MAX_EXTERNAL_FRAME,
  FRAME_DEADLINE_CAP_MS,
  FRAME_DEADLINE_BASE_MS,
  FRAME_MIN_BYTES_PER_S,
  MAX_FRAME_MEMORY,
  SMALL_FRAME_BYTES,
  FRAME_EVICT_MIN_AGE_MS
} = require('./frame-guard')

const GATE_TIMEOUT_MS = 15000
const REDISCOVER_MS = 10000
// A diary scan whose block read fails is retried after this delay, at most
// this many times in a row (a successful read resets the count): without
// it a fully contiguous log (no further growth to re-queue the scan) would
// stay pending, and its pages incomplete, for the life of the process.
const SCAN_RETRY_MS = 2000
const SCAN_RETRIES_MAX = 8
const KEY_FILE = 'seeder-key.json'
const CERT_FILE = 'seeder-cert.json'
const ADMITTED_FILE = 'admitted.json'
// Per-peer announce limits (H3): a token bucket (ANNOUNCE_RATE per second,
// ANNOUNCE_BURST tokens) checked before any signature is verified, and a cap
// on announces whose certificate fails (MAX_BAD_ANNOUNCES).
const ANNOUNCE_RATE = 10
const ANNOUNCE_BURST = 20
const MAX_BAD_ANNOUNCES = 16

const HEX64 = /^[0-9a-f]{64}$/
// Record types the engagement index reads from a diary's blocks.
const INDEX_TYPES = new Set(['post', 'like', 'repost', 'profile', 'username'])

// Frame guard for external streams (acceptStream): see lib/frame-guard.js
// for the limits, how they were measured, the frame deadlines and the
// frame memory budget. The seeder is the Noise XX responder, so the guard
// keeps its responder defaults (2 handshake frames of at most
// MAX_HANDSHAKE_FRAME, then frames of at most MAX_EXTERNAL_FRAME) and gets
// the seeder-wide budget below (_frameBudget).

// An external socket with no incoming data for this long after the handshake
// is dropped (Hypercore keep-alives every 5 s keep a live peer well inside it).
const EXTERNAL_IDLE_MS = 30000

function noop () {}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

// Block-0 verdict on a raw block (identical to lib/sync.js): null when block 0
// is a valid member certificate for keyHex under the trusted association.
// opts = { revokedIssuers } of the current blocklist snapshot: a v2
// certificate from a revoked issuer answers 'revoked-issuer' (cert.js
// verifyIssued).
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

// LOCAL gate: block 0 already in the main store. Any error is 'not-in-log',
// so a failure can never skip the purge.
async function localVerdict (core, keyHex, associationHex, opts) {
  try {
    const raw = await core.get(0, { wait: false, raw: true })
    return gateVerdict(raw, keyHex, associationHex, opts)
  } catch {
    return 'not-in-log'
  }
}

function givenAssociation (associationKey) {
  if (associationKey === null || associationKey === undefined) return null
  const given = normalizeHex(associationKey)
  if (given === null || given.length !== 64) throw new UsageError('chave da associação inválida')
  return given
}

function configuredAssociation (config, given) {
  if (!isPlainObject(config) || config.role !== 'seeder') throw new Error('diretório não é de um semeador')
  if (typeof config.association !== 'string' || !HEX64.test(config.association)) {
    throw new Error('diretório não é de um semeador')
  }
  if (given !== null && given !== config.association) throw new Error('associação diferente da configurada')
  return config.association
}

// admitted.json as the operator commands read it: the listed entries (any
// key; the caller filters hex64), never throwing on a malformed shape.
function readAdmitted (dataDir) {
  return readAdmittedFile(dataDir).admitted
}

// A persisted media binding { diary, seq } as written by _persist, or null
// for any other shape: a listed core with no usable binding is still a
// stored core to purge at start (reason 'unbound'), never one to serve.
function mediaBinding (value) {
  if (!isPlainObject(value)) return null
  const { diary, seq } = value
  if (typeof diary !== 'string' || !HEX64.test(diary)) return null
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  return { diary, seq }
}

// Both maps of admitted.json: `admitted` (diaries) and `media` (media cores,
// values normalized through mediaBinding; absent before this version).
function readAdmittedFile (dataDir) {
  const data = readJson(path.join(dataDir, ADMITTED_FILE), { v: 1, admitted: {} })
  const admitted = isPlainObject(data) && isPlainObject(data.admitted) ? data.admitted : {}
  const media = {}
  if (isPlainObject(data) && isPlainObject(data.media)) {
    for (const [key, value] of Object.entries(data.media)) media[key] = mediaBinding(value)
  }
  return { admitted, media }
}

// Block-0 verdict of a media core (lib/media.js): null when the raw block is
// a valid media header naming diaryHex, else 'header-invalid' (not a header,
// or oversized: decodeBlock refuses it) or 'wrong-diary'.
function mediaVerdict (raw, diaryHex) {
  try {
    const header = decodeBlock(raw)
    if (header === null || validateMediaHeader(header) !== null) return 'header-invalid'
    return header.diary === diaryHex ? null : 'wrong-diary'
  } catch {
    return 'header-invalid'
  }
}

// LOCAL media gate (block 0 already in the main store); any error is
// 'header-invalid', so a failure can never skip the purge.
async function localMediaVerdict (core, diaryHex) {
  try {
    const raw = await core.get(0, { wait: false, raw: true })
    return mediaVerdict(raw, diaryHex)
  } catch {
    return 'header-invalid'
  }
}

// blocklist.json as stored, unwrapped ({ v: 1, snapshot }: store.js
// writeBlocklist), or null.
function readSnapshot (dataDir, options) {
  const data = readBlocklist(dataDir, options)
  return data === null ? null : data.snapshot
}

function storedCore (store, key) {
  return store.storage.hasCore(crypto.discoveryKey(b4a.from(key, 'hex')))
}

function loadSeederKey (dataDir) {
  try {
    return loadKeyPairFile(path.join(dataDir, KEY_FILE))
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('chave do semeador não encontrada (use seed key)')
    throw err
  }
}

function loadSeederCert (dataDir) {
  let cert
  try {
    cert = readJson(path.join(dataDir, CERT_FILE), null)
  } catch {
    throw new Error('certificado do semeador inválido (malformed)')
  }
  if (cert === null) throw new Error('certificado do semeador não encontrado (use seed cert add)')
  return cert
}

function checkSeederCert (cert, keyPair, associationHex) {
  const r = seederCertForKey(cert, b4a.toString(keyPair.publicKey, 'hex'), associationHex)
  if (!r.ok) throw new Error('certificado do semeador inválido (' + r.reason + ')')
}

class Seeder {
  // purgeHook(core), gateHook(key), admitHook(key, step) ('persist' |
  // 'open', awaited right before that admission step; a throw simulates the
  // step failing), regateHook(key, reason) (awaited after a served replica's
  // local block-0 verdict is computed and before it is applied, _gate) and
  // storeHook() (awaited right after the main store, and
  // its data-dir lock, is acquired) are test-only hooks, as are the injectable limits
  // (maxLogBlocks, maxLogBytes, maxConnections, maxExternal, maxServed,
  // maxAnnounces, announceRate, announceBurst, maxBadAnnounces, maxMedia,
  // maxMediaBlocks, maxMediaBytes; defaults = the constants, maxExternal =
  // half of maxConnections, at least 1, maxMedia = maxServed; maxFrameMemory
  // = MAX_FRAME_MEMORY; frameDeadlineBaseMs and frameDeadlineCapMs = the
  // FRAME_DEADLINE_* constants; frameSmallBytes = SMALL_FRAME_BYTES;
  // frameEvictAgeMs = FRAME_EVICT_MIN_AGE_MS). admitHook and
  // purgeHook also see media keys (admission steps 'persist' / 'open').
  // indexMaxRecords, indexMaxTargets and indexPerAuthorMax bound the
  // engagement index (defaults in engagement-index.js). topicMaxPosts,
  // topicPerAuthorMax, topicMaxTerms and topicMaxPostings bound the topic
  // search index; topicPerAuthorPostingsMax and topicPerAuthorTermsMax are
  // each diary's share of the posting and term budgets, so one diary cannot
  // fill them for everyone (defaults in topic-index.js; no CLI flags).
  constructor ({
    dataDir,
    associationKey = null,
    bootstrap,
    host,
    log = noop,
    purgeHook = null,
    gateHook = null,
    admitHook = null,
    regateHook = null,
    storeHook = null,
    maxLogBlocks = MAX_LOG_BLOCKS,
    maxLogBytes = MAX_LOG_BYTES,
    maxConnections = MAX_CONNECTIONS,
    maxExternal = null,
    externalIdleMs = EXTERNAL_IDLE_MS,
    maxFrameMemory = MAX_FRAME_MEMORY,
    frameDeadlineBaseMs = FRAME_DEADLINE_BASE_MS,
    frameDeadlineCapMs = FRAME_DEADLINE_CAP_MS,
    frameSmallBytes = SMALL_FRAME_BYTES,
    frameEvictAgeMs = FRAME_EVICT_MIN_AGE_MS,
    maxServed = MAX_INVENTORY,
    maxAnnounces = MAX_INVENTORY,
    announceRate = ANNOUNCE_RATE,
    announceBurst = ANNOUNCE_BURST,
    maxBadAnnounces = MAX_BAD_ANNOUNCES,
    maxMedia = null,
    maxMediaBlocks = MAX_MEDIA_BLOCKS,
    maxMediaBytes = MAX_MEDIA_BYTES,
    indexMaxRecords = undefined,
    indexMaxTargets = undefined,
    indexPerAuthorMax = undefined,
    topicMaxPosts = undefined,
    topicPerAuthorMax = undefined,
    topicMaxTerms = undefined,
    topicMaxPostings = undefined,
    topicPerAuthorPostingsMax = undefined,
    topicPerAuthorTermsMax = undefined
  } = {}) {
    this.maxServed = maxServed
    this.maxMedia = maxMedia === null ? maxServed : maxMedia
    this.maxMediaBlocks = maxMediaBlocks
    this.maxMediaBytes = maxMediaBytes
    this.maxAnnounces = maxAnnounces
    this.announceRate = announceRate
    this.announceBurst = announceBurst
    this.maxBadAnnounces = maxBadAnnounces
    this.dataDir = dataDir
    this.associationKey = associationKey
    this.bootstrap = bootstrap
    this.host = host
    this.log = log
    this.purgeHook = purgeHook
    this.gateHook = gateHook
    this.admitHook = admitHook
    this.regateHook = regateHook
    this.storeHook = storeHook
    this.maxLogBlocks = maxLogBlocks
    this.maxLogBytes = maxLogBytes
    // Two independent caps: maxConnections bounds swarm sockets only and
    // maxExternal bounds external sockets (acceptStream, in-flight handshakes
    // included) only, so neither kind can starve the other.
    this.maxConnections = maxConnections
    if (maxExternal !== null && (!Number.isInteger(maxExternal) || maxExternal < 1)) {
      throw new TypeError('maxExternal must be an integer >= 1')
    }
    this.maxExternal = maxExternal === null ? Math.max(1, Math.floor(maxConnections / 2)) : maxExternal
    // Seeder-wide budget of the bytes declared by charged (large,
    // incomplete) frames of external sockets (see FrameGuard), the guards
    // holding a reservation, and the frame deadline parameters.
    this.maxFrameMemory = maxFrameMemory
    this.frameDeadlineBaseMs = frameDeadlineBaseMs
    this.frameDeadlineCapMs = frameDeadlineCapMs
    this.frameSmallBytes = frameSmallBytes
    this.frameEvictAgeMs = frameEvictAgeMs
    this._frameMemory = 0
    this._frameGuards = new Set()
    this._frameBudget = {
      // A reservation that does not fit evicts the slowest charged guard
      // whose reservation is old enough, then retries once.
      reserve: (n, guard) => {
        if (this._frameMemory + n > this.maxFrameMemory) {
          const victim = this._frameVictim()
          if (victim === null) return false
          victim.evict()
          if (this._frameMemory + n > this.maxFrameMemory) return false
        }
        this._frameMemory += n
        this._frameGuards.add(guard)
        return true
      },
      release: (n, guard) => {
        this._frameMemory -= n
        this._frameGuards.delete(guard)
      }
    }
    // Inactivity deadline for external sockets once the handshake completed:
    // a peer that goes silent (no frame at all) would otherwise keep a
    // WebSocket slot for good. Live peers send Hypercore keep-alives every 5 s.
    this.externalIdleMs = externalIdleMs

    this.association = null
    this.topic = null
    this.store = null
    this.qstore = null
    this.swarm = null
    this.fatal = false

    // Source of truth after start(): admitted (served) and dropping (being
    // purged); admitted.json is always the union of both (R6.1).
    this._admitted = new Map()
    this._dropping = new Map()
    this._served = new Map() // key -> { core, download, stopFork, stopGrow, gated, gating, dropped }
    this._chains = new Map() // key -> per-key announce chain (R4.7)
    this._inflight = new Map() // key -> the admission step currently running
    this._reserved = new Set() // keys holding a capacity slot mid-admission (M1)
    this._drops = new Map() // key -> promise of the drop (purge) in progress
    // Media cores (header comment): bound (served) and dropping bindings,
    // key -> { diary, seq }; admitted.json `media` is the union of both.
    // Admission steps and drops of media keys share _inflight and _drops
    // (a diary key and a media key are never the same core), so close()
    // and the per-key waits cover both kinds alike.
    this._media = new Map()
    this._mediaDropping = new Map()
    this._mediaServed = new Map() // key -> { core, diary, download, stopFork, stopGrow, stopQuota, dropped }
    this._mediaReserved = new Set() // media keys holding a media slot mid-admission
    this._mediaFetches = new Map() // media key -> quarantine fetch in flight (new peers are attached to it)
    this._scanQueue = Promise.resolve() // diary scans for media-core records run one at a time
    // Engagement index (header comment): its own scan queue (one diary at a
    // time, never the media scan's), and the keys served at start whose
    // first index pass has not finished yet (null until step 4 of start():
    // `indexing`; set before any entry is served, so a pass queued by
    // growth during start is accounted for).
    this._index = createEngagementIndex({ maxRecords: indexMaxRecords, maxTargets: indexMaxTargets, perAuthorMax: indexPerAuthorMax, onFreed: () => this._scheduleIndexResume() })
    // Name index (header comment): fed by the same scan, same queue.
    this._names = this._createNameIndex()
    this._indexResumeQueued = false
    this._indexQueue = Promise.resolve()
    this._indexStartup = null
    this._indexDropped = new Set()
    this._indexRebuildQueued = false
    // Topic search index (header comment): its own queue and startup set,
    // independent of the engagement index's.
    this._topics = createTopicIndex({ maxPosts: topicMaxPosts, perAuthorMax: topicPerAuthorMax, maxTerms: topicMaxTerms, maxPostings: topicMaxPostings, perAuthorPostingsMax: topicPerAuthorPostingsMax, perAuthorTermsMax: topicPerAuthorTermsMax, onFreed: () => this._scheduleTopicResume() })
    this._topicQueue = Promise.resolve()
    this._topicStartup = null
    this._topicResumeQueued = false
    this._writeQueue = Promise.resolve()
    // The signed moderation snapshot (blocklist.js createBlocklistState),
    // created in start() once the data-dir lock is held, and the open
    // blocklist channel of every connection (for the C4 fan-out).
    this._blocklist = null
    this._blocklistHandles = new Set()
    // True from a start whose blocklist.json was unreadable or missing with no
    // usable copy to fall back to (a list existed and is lost) until a
    // verified snapshot is adopted: new admissions are refused meanwhile. A
    // later start with the torn file still kept aside and no list holds again. In memory only: a restart
    // before a snapshot arrives reads a plain absent file.
    this._blocklistHeld = false
    // Follow notices (notices.js): the follower index is in memory only,
    // rebuilt from block 1 by the diary scan on every serve and never
    // persisted; the open notices channel of every connection.
    // isMember reads the live sets (both created above); a follow of a key
    // admitted later is picked up on that author's next serve or restart.
    this._notices = createNoticeIndex({ isMember: (k) => this._admitted.has(k) || this._served.has(k) })
    this._noticeHandles = new Set()
    // Moderation generation: bumped on every adoption that blocks a key or
    // revokes an issuer. A block-0 verdict computed across an await under an
    // older generation is never applied as a pass (_gate re-runs it).
    this._moderationGen = 0
    this._peers = new Set()
    this._external = new Set() // NoiseSecretStreams from acceptStream (not in swarm.connections)
    this._keyPair = null
    this._cert = null
    this._started = false
    this._ready = false
    this._closing = null
    this._stopRediscovery = null
    this.closed = new Promise((resolve) => { this._resolveClosed = resolve })
  }

  // Shared by `seed key`, `seed cert add` and `seed`: the first of them fixes
  // the seeder's trust root in config.json.
  static ensureConfig (dataDir, associationKey) {
    const given = givenAssociation(associationKey)
    const config = readConfig(dataDir)
    if (config !== null) return configuredAssociation(config, given)
    if (given === null) throw new UsageError('informe --association ou VARANDA_ASSOCIATION')
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeConfig(dataDir, { v: 1, role: 'seeder', association: given })
    return given
  }

  // The read-only twin of ensureConfig, for the operator commands (`seed
  // status`, `seed list`, `seed drop`): they never write config.json, so a
  // missing one is not a seeder dir.
  static checkConfig (dataDir, associationKey) {
    const given = givenAssociation(associationKey)
    const config = readConfig(dataDir)
    if (config === null) throw new Error('diretório não é de um semeador')
    return configuredAssociation(config, given)
  }

  // `seed status`: what a start would find, read without the data-dir lock
  // and without opening a store, so it also answers while `seed` runs and
  // writes nothing. `certificate` is 'ok', 'missing' or the reason of
  // seederCertForKey; `running` is whether a live process holds the lock.
  static status (dataDir, associationKey) {
    const association = Seeder.checkConfig(dataDir, associationKey)
    let publicKey = null
    try {
      publicKey = b4a.toString(loadKeyPairFile(path.join(dataDir, KEY_FILE)).publicKey, 'hex')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    let certificate
    try {
      const cert = readJson(path.join(dataDir, CERT_FILE), null)
      certificate = cert === null ? 'missing' : seederCertForKey(cert, publicKey, association).reason || 'ok'
    } catch {
      certificate = 'malformed'
    }
    const admitted = Object.keys(readAdmitted(dataDir)).filter((key) => HEX64.test(key)).length
    // The stored moderation snapshot, only when it verifies for the
    // association (a start would ignore anything else). Never throws.
    let blocklist = null
    try {
      const snapshot = readSnapshot(dataDir)
      if (snapshot !== null && verifySnapshot(snapshot, association).ok) blocklist = { seq: snapshot.seq, date: snapshot.date }
    } catch {}
    // Whether a start would hold admissions: no usable list and a torn one kept aside.
    let blocklistHeld = false
    try {
      blocklistHeld = blocklist === null && hasUnreadableBlocklist(dataDir)
    } catch {}
    return { association, publicKey, certificate, admitted, blocklist, blocklistHeld, running: lockHeld(dataDir) }
  }

  // `seed list`: the admitted logs and their signed sizes, each with the
  // media cores bound to it (`media: [{ key, length, byteLength }]`). It
  // takes the data-dir lock (opens the main store) before reading
  // admitted.json, as start() does, so it runs only while the seeder is
  // stopped. A listed key with no stored core is reported empty and never
  // opened: listing creates no core in the main store. A listed media core
  // whose diary is not listed is not shown (the next start purges it).
  static async list (dataDir, associationKey) {
    Seeder.checkConfig(dataDir, associationKey)
    const store = await openStore(dataDir)
    const sizes = async (key, open) => {
      const entry = { key, length: 0, byteLength: 0 }
      if (await storedCore(store, key)) {
        const core = await open(store, key)
        entry.length = core.length
        entry.byteLength = core.byteLength
        await core.close()
      }
      return entry
    }
    try {
      const file = readAdmittedFile(dataDir)
      const admitted = []
      for (const key of Object.keys(file.admitted)) {
        if (!HEX64.test(key)) continue
        const entry = await sizes(key, openReplica)
        entry.media = []
        for (const [k, binding] of Object.entries(file.media)) {
          if (!HEX64.test(k) || binding === null || binding.diary !== key) continue
          entry.media.push(await sizes(k, openMediaReplica))
        }
        admitted.push(entry)
      }
      return { admitted }
    } finally {
      await store.close()
    }
  }

  // `seed drop <key>`: removes one log while the seeder is stopped (under
  // the data-dir lock), in the startup-drop order of R6.1: the replica is
  // purged FIRST, and only then the key leaves admitted.json, so every core
  // in the main store stays listed. A diary's media cores go first, the same
  // way (purge, then un-list); a media key itself may also be dropped. A
  // purge failure throws and leaves the file untouched. It is not a block:
  // the author's next announce runs the full gate again (to keep an author
  // out, block the key with `mod block`), and a dropped media core is bound
  // again by the next scan of its diary.
  static async drop (dataDir, associationKey, key) {
    Seeder.checkConfig(dataDir, associationKey)
    if (typeof key !== 'string' || !HEX64.test(key)) throw new UsageError('chave inválida')
    const store = await openStore(dataDir)
    try {
      const { admitted, media } = readAdmittedFile(dataDir)
      const listed = Object.prototype.hasOwnProperty.call(admitted, key)
      const listedMedia = Object.prototype.hasOwnProperty.call(media, key)
      const stored = await storedCore(store, key)
      if (!listed && !listedMedia && !stored) throw new Error('diário não está no semeador')
      const gone = new Set([key])
      for (const [k, binding] of Object.entries(media)) {
        if (HEX64.test(k) && binding !== null && binding.diary === key) gone.add(k)
      }
      for (const k of gone) {
        if (k !== key && await storedCore(store, k)) await purgeReplica(store, k)
      }
      if (stored) await purgeReplica(store, key)
      if (listed || listedMedia || gone.size > 1) {
        const rest = {}
        for (const [k, cert] of Object.entries(admitted)) if (k !== key) rest[k] = cert
        const restMedia = {}
        for (const [k, binding] of Object.entries(media)) if (!gone.has(k)) restMedia[k] = binding
        writeJsonAtomic(path.join(dataDir, ADMITTED_FILE), { v: 1, admitted: rest, media: restMedia })
      }
      return { key }
    } finally {
      await store.close()
    }
  }

  // Idempotent: an existing key file is returned as is (never overwritten).
  static createKey (dataDir) {
    const file = path.join(dataDir, KEY_FILE)
    try {
      return { publicKey: b4a.toString(loadKeyPairFile(file).publicKey, 'hex') }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    const kp = generateNoiseKeyPair()
    try {
      saveKeyPairFile(file, kp)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      return { publicKey: b4a.toString(loadKeyPairFile(file).publicKey, 'hex') }
    }
    return { publicKey: b4a.toString(kp.publicKey, 'hex') }
  }

  static addCert (dataDir, certFile, associationHex) {
    let cert
    try {
      cert = JSON.parse(fs.readFileSync(certFile, 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('arquivo não encontrado: ' + certFile)
      throw new Error('certificado do semeador inválido (malformed)')
    }
    const keyPair = loadSeederKey(dataDir)
    checkSeederCert(cert, keyPair, associationHex)
    writeJsonAtomic(path.join(dataDir, CERT_FILE), cert, 0o600)
    return { seeder: cert.seeder }
  }

  admittedKeys () {
    return [...this._admitted.keys()]
  }

  async start () {
    if (this._started) throw new Error('semeador já iniciado')
    this._started = true

    // Step 1: trust root, Noise key pair and seeder certificate.
    this.association = Seeder.ensureConfig(this.dataDir, this.associationKey)
    this._keyPair = loadSeederKey(this.dataDir)
    this._cert = loadSeederCert(this.dataDir)
    checkSeederCert(this._cert, this._keyPair, this.association)

    // Step 2: the main store (data-dir lock) FIRST, then the state: a
    // previous seeder process may write admitted.json until it releases the
    // lock, so it is read only once the lock is held. The main store opens
    // BEFORE the quarantine is wiped (R6.2).
    this.store = await openStore(this.dataDir)

    try {
      if (this.storeHook) await this.storeHook()
      const file = readAdmittedFile(this.dataDir)
      for (const [key, cert] of Object.entries(file.admitted)) {
        if (HEX64.test(key)) this._admitted.set(key, cert)
      }
      // Media bindings (null for an unusable one: purged below as 'unbound').
      for (const [key, binding] of Object.entries(file.media)) {
        if (HEX64.test(key) && !this._admitted.has(key)) this._media.set(key, binding)
      }
      // The stored moderation snapshot, read under the lock like
      // admitted.json and kept only when it verifies for the association
      // (createBlocklistState ignores anything else). An unreadable file is
      // read from the copy writeBlocklist keeps; with no copy, new admissions
      // are held until a verified snapshot arrives (serving without knowing
      // what is blocked could hand out a blocked diary). If it cannot be
      // moved aside the start fails.
      let unreadable = false
      const state = createBlocklistState({
        association: this.association,
        load: () => readSnapshot(this.dataDir, {
          onUnreadable: (aside, restored) => {
            unreadable = true
            this.log({ event: 'warning', reason: aside === null ? 'blocklist-missing' : 'blocklist-unreadable', aside, restored })
          }
        }),
        save: (snapshot) => this._saveBlocklist(snapshot)
      })
      try {
        await state.ready()
      } catch {
        throw new Error('lista de bloqueio ilegível')
      }
      // Decided once the state is loaded: a copy that does not verify leaves
      // no list either, and a torn file kept aside by an earlier start
      // still says a list existed.
      this._blocklistHeld = (unreadable || hasUnreadableBlocklist(this.dataDir)) && state.current() === null
      this._blocklist = state
      this.qstore = await openQuarantine(this.dataDir)

      // Step 3: re-gate every stored replica before anything can serve it.
      const survivors = []
      for (const key of [...this._admitted.keys()]) {
        const core = await openReplica(this.store, key)
        let reason = null
        // A blocked author takes the fork path (rejected, purged, un-listed),
        // never _drop: _drop returns for a key not in _served (it is only
        // filled in step 4). A revoked issuer surfaces through localVerdict.
        if (this._isBlocked(key)) reason = 'blocked'
        else if (core.fork !== 0) reason = 'fork'
        else if (core.contiguousLength === 0) reason = 'no-cert'
        else if (this._overQuota(core)) reason = 'quota' // item 5: before any serve/join
        else reason = await localVerdict(core, key, this.association, this._certOpts())
        if (reason === null && survivors.length < this.maxServed) {
          survivors.push([key, core])
          continue
        }
        // Capacity (M1): a listed log beyond maxServed is purged through the
        // same path, so a restart always comes back under the cap.
        if (reason === null) this.log({ event: 'warning', key, reason: 'seeder-full' })
        else this.log({ event: 'rejected', key, reason })
        try {
          await this._purge(key)
        } catch {
          throw new Error('falha ao limpar diário rejeitado: ' + key8(key))
        }
        this._admitted.delete(key)
        await this._persist()
      }

      // Step 3b: re-gate every listed media core the same way, once the
      // diaries are settled: its diary must have survived (else 'unbound'),
      // the core must not be forked, must hold its header, be within the
      // media quota and its block 0 must be a header naming that diary.
      // Failures are purged BEFORE they leave the file (R6.1 order).
      const mediaSurvivors = []
      const kept = new Set(survivors.map(([key]) => key))
      for (const [key, binding] of [...this._media]) {
        const diary = binding === null ? null : binding.diary
        let reason = null
        let core = null
        if (diary === null || !kept.has(diary)) reason = 'unbound'
        else {
          core = await openMediaReplica(this.store, key)
          if (core.fork !== 0) reason = 'fork'
          else if (core.contiguousLength === 0) reason = 'no-header'
          else if (this._overMediaQuota(core)) reason = 'quota'
          else reason = await localMediaVerdict(core, diary)
        }
        if (reason === null && mediaSurvivors.length < this.maxMedia) {
          mediaSurvivors.push([key, diary, core])
          continue
        }
        if (reason === null) this.log({ event: 'warning', key, reason: 'media-full' })
        else this.log({ event: 'media-rejected', key, diary, reason })
        try {
          await this._purge(key)
        } catch {
          throw new Error('falha ao limpar mídia rejeitada: ' + key8(key))
        }
        this._media.delete(key)
        await this._persist()
      }

      // Step 4: watchers and live downloads (no swarm yet). A persisted
      // binding is served right away: the scan of its diary (after ready)
      // only confirms or drops it, it never has to rediscover it. The
      // startup set of the engagement index exists BEFORE anything is
      // served: growth during step 5 may already queue an index pass, and
      // a pass that pauses at the cap must still count as covered.
      this._indexStartup = new Set(survivors.map(([key]) => key))
      this._topicStartup = new Set(survivors.map(([key]) => key))
      for (const [key, core] of survivors) this._serve(key, core, { regate: false })
      for (const [key, diary, core] of mediaSurvivors) this._serveMedia(key, diary, core, { headerOk: true })

      // Step 5: the swarm, with the seeder's Noise key pair.
      this.topic = topicFor(this.association)
      this.swarm = createSwarm({ bootstrap: this.bootstrap, keyPair: this._keyPair, host: this.host })
      this.swarm.on('connection', (socket) => this._onConnection(socket))
      const topics = [
        this.topic,
        ...survivors.map(([, core]) => core.discoveryKey),
        ...mediaSurvivors.filter(([key]) => this._mediaServed.has(key)).map(([, , core]) => core.discoveryKey)
      ]
      const done = this.store.findingPeers()
      try {
        await joinAndFlush(this.swarm, topics)
      } finally {
        done()
      }
      if (this._closing) throw new Error('semeador encerrado')
      this._stopRediscovery = startRediscovery(this.swarm, [this.topic], {
        intervalMs: REDISCOVER_MS,
        hasPeer: () => this.swarm.connections.size > 0
      })
    } catch (err) {
      await this.close()
      throw err
    }

    const topic = b4a.toString(this.topic, 'hex')
    const admitted = this.admittedKeys()
    this._ready = true
    this.log({ event: 'ready', topic, admitted })
    // Background pass (never inside start()): scan every served diary for
    // media-core records, one diary at a time (_scanQueue), and index it on
    // the separate index queue (`indexing` stays true until every diary
    // served at ready had its first index pass).
    for (const [key, entry] of this._served) {
      this._scanDiary(key, entry)
      this._indexDiary(key, entry)
      this._topicDiary(key, entry)
    }
    return { topic, admitted }
  }

  mediaKeys () {
    return [...this._media.keys()]
  }

  // Aggregate state for the health endpoint: counts and sizes only, never a
  // key, a certificate, an address or a block. status is 'starting' until
  // start() completes, 'ok' while serving and 'closing' from close() on.
  // activeDay/activeWeek (lib/activity.js) are approximate: a diary first
  // admitted in this run counts once its signed length arrives, a dropped
  // diary leaves the counts at once and a restart zeroes them.
  stats () {
    let blocks = 0
    let bytes = 0
    for (const entry of this._served.values()) {
      blocks += entry.core.contiguousLength
      bytes += entry.core.byteLength
    }
    let mediaBytes = 0
    for (const entry of this._mediaServed.values()) mediaBytes += entry.core.byteLength
    const swarm = this.swarm ? this.swarm.connections.size : 0
    return {
      status: this._closing ? 'closing' : (this._ready ? 'ok' : 'starting'),
      admitted: this._admitted.size,
      dropping: this._dropping.size,
      ...countActive(this._served.values(), Date.now()),
      blocks,
      bytes,
      connections: swarm + this._external.size,
      swarm,
      external: this._external.size,
      maxConnections: this.maxConnections,
      maxExternal: this.maxExternal,
      peers: this._peers.size,
      firewalled: this.swarm ? this.swarm.dht.firewalled : null,
      blocked: this._blocklist ? this._blocklist.blocked().size : 0,
      blocklistSeq: this._blocklist && this._blocklist.current() ? this._blocklist.current().seq : 0,
      blocklistHeld: this._blocklistHeld,
      mediaCores: this._media.size,
      mediaBytes,
      indexRecords: this._index.stats().records,
      indexSaturated: this._index.stats().saturated,
      topicPosts: this._topics.stats().posts,
      topicSaturated: this._topics.stats().saturated
    }
  }

  // (a) The announced certificate is checked synchronously BEFORE anything
  // is queued (review item 1), so a flood of announces never grows memory.
  // The per-peer rate limit runs before the signature check, and a peer
  // whose certificates keep failing is dropped (H3), so a dropped peer
  // costs no further verify.
  admit (key, cert, peer) {
    if (this._closing || peer.seederDropped) return Promise.resolve()
    if (!this._takeAnnounceToken(peer)) {
      this._dropPeer(peer, 'announce-rate')
      return Promise.resolve()
    }
    if (typeof key !== 'string' || !HEX64.test(key)) {
      this._reject(peer, String(key), 'malformed')
      this._badAnnounce(peer)
      return Promise.resolve()
    }
    const r = certForKey(cert, key, this.association, this._certOpts())
    if (!r.ok) {
      this._reject(peer, key, r.reason)
      // A certificate from a revoked issuer is a moderation outcome, like a
      // blocked author: an honest member re-announcing it is not misbehaving.
      if (r.reason !== 'revoked-issuer') this._badAnnounce(peer)
      return Promise.resolve()
    }
    // A blocked author is refused before anything is queued or fetched (no
    // quarantine core is opened for it).
    if (this._isBlocked(key)) {
      this._reject(peer, key, 'blocked')
      return Promise.resolve()
    }
    return this._enqueue(key, cert, peer)
  }

  // Token bucket per peer: announceBurst tokens, refilled at announceRate/s.
  _takeAnnounceToken (peer) {
    const now = clock.now() // monotonic: a wall-clock step must not drain the bucket
    if (!peer.announceBucket) peer.announceBucket = { tokens: this.announceBurst, at: now }
    const b = peer.announceBucket
    b.tokens = Math.min(this.announceBurst, b.tokens + (now - b.at) * this.announceRate / 1000)
    b.at = now
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  _badAnnounce (peer) {
    peer.badAnnounces = (peer.badAnnounces || 0) + 1
    if (peer.badAnnounces >= this.maxBadAnnounces) this._dropPeer(peer, 'bad-announces')
  }

  _dropPeer (peer, reason) {
    if (peer.seederDropped) return
    peer.seederDropped = true
    this.log({ event: 'peer-dropped', peerKey: peer.peerKey, reason })
    peer.socket.destroy()
  }

  async _admitNow (key, cert, peer, onFetch = noop) {
    if (this._closing) return

    // A drop in progress wins over this announce: its purge completes (and
    // the key leaves dropping) before the key is looked at again, and then
    // only through the full quarantine gate.
    while (this._drops.has(key)) await this._drops.get(key)
    if (this._closing) return

    // The admission step itself is tracked so a drop that starts meanwhile
    // waits for it (and only for it, never for queued announces).
    const work = this._admitGated(key, cert, peer, onFetch)
    this._inflight.set(key, work)
    try {
      return await work
    } finally {
      if (this._inflight.get(key) === work) this._inflight.delete(key)
    }
  }

  // Outcomes marked `shared` do not depend on the announcer's socket, so the
  // per-key queue may hand them to waiters (M2): admitted, and a rejection
  // of a certificate found in block 0.
  async _admitGated (key, cert, peer, onFetch) {
    // (b) already admitted: idempotent answer.
    const served = this._served.get(key)
    if (this._admitted.has(key) && served) {
      const length = served.core.contiguousLength
      peer.send({ type: 'admitted', key, length })
      return { type: 'admitted', length, shared: true }
    }
    // The list was lost: nothing new is admitted until a verified one arrives.
    // After (b) on purpose: a diary already served is re-announced by its
    // member on every connection, and a rejection would end that sync.
    if (this._blocklistHeld) return this._reject(peer, key, 'blocklist-pending')
    // Being purged with no drop to wait on: the purge failed and the seeder
    // is closing (fatal); never re-admit over it.
    if (this._dropping.has(key) || this._admitted.has(key)) return
    // A bound (or binding) media core is never a diary: its block 0 is a
    // media header, not a certificate. Refusing here (instead of letting the
    // gate find out) keeps the two admission paths from fetching the same
    // key through the quarantine at once (_admitMedia checks the reverse).
    if (this._media.has(key) || this._mediaDropping.has(key) || this._mediaReserved.has(key)) {
      return this._reject(peer, key, 'not-in-log')
    }
    if (!this._peers.has(peer)) return
    // Inventory cap (review item 4a): a seeder serving MAX_INVENTORY logs
    // could no longer send a valid hello, so it refuses further admissions.
    // The slot is reserved synchronously, before the first await (M1), so
    // concurrent admissions for different keys never overshoot the cap.
    if (this._served.size + this._reserved.size >= this.maxServed) return this._reject(peer, key, 'seeder-full')
    this._reserved.add(key)
    try {
      return await this._admitReserved(key, cert, peer, onFetch)
    } finally {
      this._reserved.delete(key)
    }
  }

  async _admitReserved (key, cert, peer, onFetch) {
    // (c) remote gate through the quarantine store, attached to P and to
    // every other announcer of the key queued meanwhile (onFetch, M2), so
    // any honest announcer can supply block 0.
    let res
    try {
      const fetch = startQuarantineFetch(this.qstore, key, [peer.socket], GATE_TIMEOUT_MS)
      onFetch(fetch)
      try {
        res = await fetch.promise
      } finally {
        onFetch(null)
      }
    } catch {
      if (!this._closing) this._fatal(key)
      return
    }
    if (this.gateHook) await this.gateHook(key)
    if (this._closing) return
    if (res.error) return this._reject(peer, key, 'timeout')
    // A snapshot adopted while the fetch ran (C6): _drop cannot reach a key
    // that is not served yet, so every await below is followed by a re-check.
    if (this._isBlocked(key)) return this._reject(peer, key, 'blocked')
    const verdict = gateVerdict(res.raw, key, this.association, this._certOpts())
    if (verdict !== null) {
      const out = this._reject(peer, key, verdict)
      if (verdict !== 'not-in-log') out.shared = true
      return out
    }
    // Log quota (S3): the signed length and byteLength the quarantine core
    // learned with block 0 are checked before anything is opened in the main
    // store (an oversized block 0 itself is 'not-in-log': decodeBlock refuses
    // it).
    if (this._overQuota(res)) return this._reject(peer, key, 'quota')
    // Re-check the cap right before admitting (defence in depth, M1).
    if (this._served.size >= this.maxServed) return this._reject(peer, key, 'seeder-full')

    // (d) admit: persist BEFORE the main store opens the key. A failure after
    // admitted.set (persist throwing, e.g. ENOSPC, or openReplica throwing)
    // rolls the admission back: the key leaves the map, the file is rewritten
    // best-effort and the announcer gets 'admission-failed'; a later announce
    // runs the full gate again. A failure in the open step (S7) may have left
    // the core stored (corestore serves any stored core), so when the storage
    // holds it the replica is purged first; a purge failure is fatal like
    // every other and the key stays listed for the next start to re-gate and
    // purge it. (A core that was never stored is not purged: opening a fresh
    // session only to purge it races with the announcer's replication.)
    this._admitted.set(key, cert)
    let core
    let opening = false
    try {
      if (this.admitHook) await this.admitHook(key, 'persist')
      const before = this._blockedReason(key, res.raw)
      if (before !== null) {
        // Nothing persisted or opened yet: un-admit in memory only.
        this._admitted.delete(key)
        if (this._closing) return
        return this._reject(peer, key, before)
      }
      await this._persist()
      if (this._closing) return
      opening = true
      if (this.admitHook) await this.admitHook(key, 'open')
      core = await openReplica(this.store, key)
    } catch {
      if (opening) {
        try {
          if (await this._stored(key)) await this._purge(key)
        } catch {
          if (!this._closing) this._fatal(key)
          return
        }
      }
      this._admitted.delete(key)
      await this._persist().catch(noop)
      if (this._closing) return
      return this._reject(peer, key, 'admission-failed')
    }
    if (this._closing) return
    const after = this._blockedReason(key, res.raw)
    if (after !== null) {
      // Adopted while persisting or opening: the key is listed and its core
      // open but not served. Close, purge (a failure is fatal and keeps it
      // listed for the next start), un-admit, persist, then refuse.
      await core.close().catch(noop)
      try {
        if (await this._stored(key)) await this._purge(key)
      } catch {
        if (!this._closing) this._fatal(key)
        return
      }
      this._admitted.delete(key)
      await this._persist().catch(noop)
      if (this._closing) return
      return this._reject(peer, key, after)
    }
    this._serve(key, core, { regate: true })
    // A resumed main-store core already over the quota was dropped inside
    // _serve (rejected sent, purge under way): no join, no admitted (item 6).
    const entry = this._served.get(key)
    if (!entry || entry.dropped) return { type: 'rejected', reason: 'quota' }
    this.swarm.join(core.discoveryKey, { server: true, client: true })
    const length = core.contiguousLength
    peer.send({ type: 'admitted', key, length })
    this.log({ event: 'admitted', key, length })
    return { type: 'admitted', length, shared: true }
  }

  _isBlocked (key) {
    return this._blocklist !== null && this._blocklist.blocked().has(key)
  }

  // Options for every certificate check: the revoked issuers of the current
  // snapshot (none before start).
  _certOpts () {
    return { revokedIssuers: this._blocklist ? this._blocklist.revokedIssuers() : new Set() }
  }

  // Re-check of an admission in flight against the snapshot current now:
  // 'blocked', 'revoked-issuer' (block 0 from a now revoked issuer) or null.
  _blockedReason (key, raw) {
    if (this._isBlocked(key)) return 'blocked'
    return gateVerdict(raw, key, this.association, this._certOpts()) === 'revoked-issuer' ? 'revoked-issuer' : null
  }

  _reject (peer, key, reason) {
    peer.send({ type: 'rejected', key, reason })
    this.log({ event: 'rejected', key, reason })
    return { type: 'rejected', reason }
  }

  _overQuota ({ length, byteLength }) {
    return length > this.maxLogBlocks || byteLength > this.maxLogBytes
  }

  _serve (key, core, { regate }) {
    // Media scan state (header comment): `scanned` is the next block to read
    // for media-core records (block 0 is the certificate), `decls` the
    // declared cores seen so far (key -> { seq, at }, newest seq; a seq/key
    // list, never the entries), `latest` the current binding set and
    // `refused` the declarations whose block 0 failed the media gate (retried
    // only when re-declared at a newer seq). Index state (header comment):
    // `indexed` is the next block the engagement index reads, `indexPaused`
    // that the index refused a record at that block (cap reached) and the
    // cursor waits there until room is freed. The topic* fields are the
    // same state for the topic search index, on its own cursor.
    const entry = {
      core,
      download: null,
      stopFork: noop,
      stopGrow: noop,
      stopQuota: noop,
      gated: !regate,
      gating: false,
      dropped: false,
      scanned: 1,
      scanQueued: false,
      scanRetry: null, // pending retry timer of a failed block read
      scanRetries: 0, // failed reads in a row
      decls: new Map(),
      latest: [],
      refused: new Map(),
      indexed: 1,
      indexQueued: false,
      indexPaused: false,
      indexRetry: null,
      indexReadFailures: 0,
      topicIndexed: 1,
      topicQueued: false,
      topicPaused: false,
      topicRetry: null,
      topicReadFailures: 0,
      // Active-diary state (lib/activity.js; in memory only, never persisted
      // or logged): openReplica already awaited core.ready(), so core.length
      // is the stored signed length, and only growth past it counts.
      activityLength: core.length,
      activeAt: null
    }
    // Log quota on growth (S3): length/byteLength advance on the signed
    // upgrade ('append' fires) before the blocks arrive, so an admitted log
    // that grows past a limit is dropped before it is fetched. Registered
    // BEFORE the growth watcher (listeners run in registration order), and
    // _onGrow checks again, so nothing past the limit is ever advertised.
    const checkQuota = () => {
      if (entry.dropped || this._closing) return
      if (this._overQuota(core)) this._drop(key, 'quota')
      // The signed length grew: the committed follows may miss the new
      // blocks until the scan reaches them, so pages say incomplete.
      // The same growth marks the diary active (wall clock: the windows are
      // Brasília calendar days). The synchronous call at the end of _serve
      // sees core.length === activityLength, so a restore, a re-gate or a
      // rescan never counts.
      else if (this._served.get(key) === entry) {
        this._notices.markPending(key)
        noteGrowth(entry, core.length, Date.now())
      }
    }
    core.on('append', checkQuota)
    entry.stopQuota = () => core.off('append', checkQuota)
    entry.stopFork = watchFork(core, (reason) => this._drop(key, reason))
    entry.download = core.download({ start: 0, end: -1 })
    entry.stopGrow = watchContiguous(core, (length) => this._onGrow(key, entry, length))
    this._served.set(key, entry)
    // Every serve scans from block 1: rebuild this author's follows from
    // scratch, invisible to pages until the scan reaches the signed length.
    this._notices.removeAuthor(key)
    this._notices.markPending(key)
    checkQuota()
    if (entry.dropped) return
    // A replica opened for re-gating may already hold block 0.
    if (regate && core.contiguousLength >= 1) this._onGrow(key, entry, core.contiguousLength)
  }

  _onGrow (key, entry, length) {
    if (entry.dropped || this._closing) return
    if (this._overQuota(entry.core)) return this._drop(key, 'quota')
    if (!entry.gated) {
      // Re-gate on arrival: the main store may have received a different
      // block 0 than the quarantine did.
      if (entry.gating) return
      entry.gating = true
      this._gate(key, entry)
      return
    }
    this._broadcastHave(key, length)
    this._scanDiary(key, entry)
    this._indexDiary(key, entry)
    this._topicDiary(key, entry)
  }

  // Local gate of a served, not yet gated replica. The verdict is computed
  // across an await with the revoked issuers current at call time, while
  // _onBlocklistAdopted only re-checks entries already gated: a snapshot
  // adopted in between would otherwise let a stale pass mark the entry gated
  // and advertise a diary from a now revoked issuer for good (block 0 is
  // never re-checked on later growth). So a pass is applied only when no
  // moderation adoption happened meanwhile; otherwise the gate runs again
  // with the then-current snapshot (entry.gating stays true throughout, so
  // _onGrow never starts a second one).
  _gate (key, entry) {
    const gen = this._moderationGen
    localVerdict(entry.core, key, this.association, this._certOpts()).then(async (reason) => {
      if (this.regateHook) await this.regateHook(key, reason)
      if (entry.dropped || this._closing) {
        entry.gating = false
        return
      }
      if (reason === null && this._isBlocked(key)) reason = 'blocked'
      if (reason === null && gen !== this._moderationGen) return this._gate(key, entry)
      entry.gating = false
      if (reason !== null) return this._drop(key, reason)
      entry.gated = true
      this._broadcastHave(key, entry.core.contiguousLength)
      this._scanDiary(key, entry)
      this._indexDiary(key, entry)
      this._topicDiary(key, entry)
    }).catch(() => {
      // Only a throwing test hook gets here: fail closed (never gated).
      entry.gating = false
      if (!entry.dropped && !this._closing) this._drop(key, 'not-in-log')
    })
  }

  _broadcastHave (key, length) {
    for (const peer of this._peers) peer.send({ type: 'have', key, length })
    this.log({ event: 'have', key, length })
  }

  _stopEntry (entry) {
    clearTimeout(entry.indexRetry)
    entry.indexRetry = null
    clearTimeout(entry.topicRetry)
    entry.topicRetry = null
    entry.stopFork()
    entry.stopGrow()
    entry.stopQuota()
    if (entry.scanRetry) {
      clearTimeout(entry.scanRetry)
      entry.scanRetry = null
    }
    try {
      if (entry.download) entry.download.destroy()
    } catch {}
  }

  // Runtime drop (R6.1): the key stays persisted (in dropping) until its
  // purge succeeds. The drop wins over announces: it runs right away (after
  // an admission step that is mid-flight for the key, never after queued
  // announces), and every announce for the key waits for it (_admitNow).
  _drop (key, reason) {
    const entry = this._served.get(key)
    if (!entry || entry.dropped || this._closing) return
    entry.dropped = true
    this._served.delete(key)
    this._notices.removeAuthor(key)
    const cert = this._admitted.get(key)
    this._admitted.delete(key)
    this._dropping.set(key, cert)
    this._stopEntry(entry)
    // The diary leaves the engagement index NOW, before the purge even
    // starts: none of its edges, engagements or hints is readable from here
    // on. The room it frees resumes any cursor paused at the cap.
    // The name index too; an entry freed there resumes a cursor paused at
    // its cap (removeDiary only calls onFreed when engagement room shrinks).
    if (this._names.remove(key)) this._scheduleIndexResume()
    this._index.removeDiary(key, () => {
      // A pending rebuild already covers these removals. Never evict a key
      // and silently forget lost edges: rebuild at the bound instead.
      if (this._indexRebuildQueued) return
      this._indexDropped.add(key)
      if (this._indexDropped.size >= MAX_INVENTORY) this._rebuildIndex()
    })
    if (this._indexStartup !== null) this._indexStartup.delete(key)
    // Same deadline for the topic search index: synchronous, before the
    // purge, on every drop path (blocked, fork, quota, revoked issuer, failed
    // gate, blocklist adoption). No timer.
    this._topics.removeDiary(key)
    if (this._topicStartup !== null) this._topicStartup.delete(key)
    // A diary's media cores go with it (one side of the binding is gone); a
    // media admission in flight for it rolls itself back (_mediaStillWanted).
    for (const [k, m] of [...this._mediaServed]) {
      if (m.diary === key) this._dropMedia(k, reason)
    }
    if (this.swarm) {
      try {
        this.swarm.leave(entry.core.discoveryKey).catch(noop)
      } catch {}
    }
    for (const peer of this._peers) peer.send({ type: 'rejected', key, reason })
    this.log({ event: 'rejected', key, reason })
    const inflight = this._inflight.get(key) || null
    const drop = (async () => {
      if (inflight) await inflight.catch(noop)
      try {
        await this._purge(key)
      } catch {
        if (!this._closing) this._fatal(key)
        return
      }
      this._dropping.delete(key)
      await this._persist()
    })()
    const tracked = drop.catch(noop).then(() => {
      if (this._drops.get(key) === tracked) this._drops.delete(key)
    })
    this._drops.set(key, tracked)
  }

  // ---- Media cores (header comment) ------------------------------------

  _overMediaQuota ({ length, byteLength }) {
    return length > this.maxMediaBlocks || byteLength > this.maxMediaBytes
  }

  // Queues a scan of a gated diary for media-core records. Scans run one at
  // a time across all diaries (_scanQueue) and at most one is queued per
  // diary; a scan reads from the diary's cursor to its contiguous length
  // (checking again before it ends), so growth during a scan is not lost.
  _scanDiary (key, entry) {
    if (entry.scanQueued || entry.dropped || !entry.gated || this._closing) return
    entry.scanQueued = true
    const run = () => this._runScan(key, entry)
    this._scanQueue = this._scanQueue.then(run, run).catch(noop)
  }

  async _runScan (key, entry) {
    entry.scanQueued = false
    const core = entry.core
    while (!entry.dropped && !this._closing && entry.scanned < core.contiguousLength) {
      const i = entry.scanned
      let raw = null
      try {
        raw = await core.get(i, { wait: false, raw: true })
      } catch {}
      // The read suspended this scan: a drop, close or re-serve meanwhile
      // (all call _notices.removeAuthor) makes this entry stale, and a fold
      // for it would be an orphan (edge budget held for good) or, after a
      // re-serve, a seq high-water mark the new scan's records fall under.
      // Nothing below touches the index for a stale entry.
      if (entry.dropped || this._closing || this._served.get(key) !== entry) return
      if (raw === null) {
        // Pending until a pass commits; the read is retried a bounded number
        // of times, as growth alone may never re-queue the scan.
        this._notices.markPending(key)
        if (entry.scanRetry === null && entry.scanRetries < SCAN_RETRIES_MAX) {
          entry.scanRetries++
          entry.scanRetry = setTimeout(() => {
            entry.scanRetry = null
            this._scanDiary(key, entry)
          }, SCAN_RETRY_MS)
          entry.scanRetry.unref()
        }
        return
      }
      entry.scanRetries = 0
      entry.scanned = i + 1
      const block = decodeBlock(raw)
      if (block === null) continue
      if (block.type === 'follow') {
        const r = validRecordCopy(block, i)
        if (r !== null) this._notices.foldFollow(key, i, r)
        continue
      }
      if (block.type !== 'media-core') continue
      const record = validRecordCopy(block, i)
      if (record === null || record.key === key) continue
      const prev = entry.decls.get(record.key)
      if (prev === undefined || i > prev.seq) entry.decls.set(record.key, { seq: i, at: record.at })
    }
    if (entry.dropped || this._closing || this._served.get(key) !== entry) return
    // The loop stops at contiguousLength, while the signed length advances
    // before the blocks arrive: publishing a prefix could hide a later
    // unfollow, so only a fold that reached the signed length is committed
    // (a pending author marks every page `incomplete`).
    if (core.contiguousLength >= core.length) this._notices.commit(key)
    else this._notices.markPending(key)
    const entries = [...entry.decls].map(([k, { seq, at }]) => ({ seq, record: { type: 'media-core', key: k, at } }))
    entry.latest = latestMediaCores(entries, key, MAX_MEDIA_CORES)
    for (const k of [...entry.refused.keys()]) {
      if (!entry.latest.some((b) => b.key === k)) entry.refused.delete(k)
    }
    this._reconcileMedia(key, entry)
  }

  // Brings the media cores of a diary in line with its latest set: cores
  // that fell out of it are dropped (purge before un-listing), wanted ones
  // not yet bound are admitted. A core bound to ANOTHER diary is left alone
  // (its header can name only one diary; a declaration for someone else's
  // core binds nothing).
  _reconcileMedia (diary, entry) {
    if (entry.dropped || !entry.gated || this._closing) return
    const wanted = new Map(entry.latest.map(({ key, seq }) => [key, seq]))
    for (const [k, binding] of [...this._media]) {
      if (binding === null || binding.diary !== diary) continue
      if (!wanted.has(k)) this._dropMedia(k, 'unbound')
      else if (binding.seq !== wanted.get(k)) {
        binding.seq = wanted.get(k)
        this._persist().catch(noop)
      }
    }
    if (this._isBlocked(diary)) return
    for (const [k, seq] of wanted) {
      if (this._media.has(k) || this._mediaDropping.has(k)) continue
      if (this._inflight.has(k) || this._mediaReserved.has(k)) continue
      const refused = entry.refused.get(k)
      if (refused !== undefined && refused === seq) continue
      this._admitMedia(diary, entry, k, seq).catch(noop)
    }
  }

  // A new peer may be the one holding a wanted core: its socket joins every
  // quarantine fetch in flight (addSocket refuses a closed or already
  // attached socket by itself), and every served, gated diary with pending
  // bindings tries them again.
  _retryMedia (peer) {
    if (peer && peer.socket && !peer.seederDropped) {
      for (const fetch of this._mediaFetches.values()) fetch.addSocket(peer.socket)
    }
    for (const [key, entry] of this._served) {
      if (entry.gated && entry.latest.length > 0) this._reconcileMedia(key, entry)
    }
  }

  // Whether admitting K for D still makes sense after an await: D served and
  // gated, not blocked, still naming K in its latest set, and K not a diary
  // (admitted, dropping or being gated as one).
  _mediaStillWanted (diary, entry, key) {
    if (entry.dropped || !entry.gated || this._served.get(diary) !== entry) return false
    if (this._isBlocked(diary)) return false
    if (!entry.latest.some((b) => b.key === key)) return false
    return !(this._admitted.has(key) || this._dropping.has(key) || this._reserved.has(key) || this._chains.has(key))
  }

  // Open sockets of every connected peer (swarm and external): the quarantine
  // fetch of a media core is attached to all of them, since nothing on the
  // admission channel says who holds it.
  _peerSockets () {
    const sockets = []
    for (const peer of this._peers) {
      const s = peer.socket
      if (s && !s.destroyed && !s.destroying && !peer.seederDropped && !sockets.includes(s)) sockets.push(s)
    }
    return sockets
  }

  _rejectMedia (key, diary, reason) {
    this.log({ event: 'media-rejected', key, diary, reason })
  }

  // Admission of media core K declared by diary D (header comment, "two-way
  // binding"), mirroring _admitGated/_admitReserved: synchronous checks and
  // slot reservation first, then the quarantine gate, then persist BEFORE
  // open, then serve and join. A failure here is never fatal for D: the
  // declaration is retried on D's next growth or the next peer (bounded by
  // those triggers), except a block 0 that failed the header gate, which is
  // retried only when re-declared.
  async _admitMedia (diary, entry, key, seq) {
    if (this._closing) return
    if (!this._mediaStillWanted(diary, entry, key)) return
    if (this._mediaServed.size + this._mediaReserved.size >= this.maxMedia) return this._rejectMedia(key, diary, 'media-full')
    const sockets = this._peerSockets()
    if (sockets.length === 0) return this._rejectMedia(key, diary, 'no-peers')
    this._mediaReserved.add(key)
    const work = this._admitMediaReserved(diary, entry, key, seq, sockets)
    this._inflight.set(key, work)
    try {
      return await work
    } finally {
      this._mediaReserved.delete(key)
      if (this._inflight.get(key) === work) this._inflight.delete(key)
    }
  }

  async _admitMediaReserved (diary, entry, key, seq, sockets) {
    // A drop of K in progress (it fell out and came back) completes first.
    while (this._drops.has(key)) await this._drops.get(key)
    if (this._closing || !this._mediaStillWanted(diary, entry, key)) return
    // Peers that connect while the fetch runs are attached to it
    // (_retryMedia): the holder of K may arrive after D's declaration.
    let res
    try {
      const fetch = startQuarantineFetch(this.qstore, key, sockets, GATE_TIMEOUT_MS)
      this._mediaFetches.set(key, fetch)
      try {
        res = await fetch.promise
      } finally {
        if (this._mediaFetches.get(key) === fetch) this._mediaFetches.delete(key)
      }
    } catch {
      if (!this._closing) this._fatal(key)
      return
    }
    if (this._closing) return
    if (res.error) return this._rejectMedia(key, diary, 'timeout')
    if (!this._mediaStillWanted(diary, entry, key)) return
    const verdict = mediaVerdict(res.raw, diary)
    if (verdict !== null) {
      entry.refused.set(key, seq)
      return this._rejectMedia(key, diary, verdict)
    }
    // Media quota at the gate: the signed sizes the quarantine learned with
    // block 0. (The fetch does not expose the fork; it is checked right
    // after the open below, before anything is served.)
    if (this._overMediaQuota(res)) return this._rejectMedia(key, diary, 'quota')
    if (this._mediaServed.size >= this.maxMedia) return this._rejectMedia(key, diary, 'media-full')

    // Persist the binding BEFORE the main store opens K; roll back exactly
    // like a diary admission (a stored core is purged before un-listing; a
    // purge failure is fatal and keeps K listed for the next start).
    this._media.set(key, { diary, seq })
    let core
    let opening = false
    try {
      if (this.admitHook) await this.admitHook(key, 'persist')
      await this._persist()
      if (this._closing) return
      opening = true
      if (this.admitHook) await this.admitHook(key, 'open')
      core = await openMediaReplica(this.store, key)
    } catch {
      if (opening) {
        try {
          if (await this._stored(key)) await this._purge(key)
        } catch {
          if (!this._closing) this._fatal(key)
          return
        }
      }
      this._media.delete(key)
      await this._persist().catch(noop)
      if (this._closing) return
      return this._rejectMedia(key, diary, 'admission-failed')
    }
    if (this._closing) return
    let late = null
    if (!this._mediaStillWanted(diary, entry, key)) late = 'unbound'
    else if (core.fork !== 0) late = 'fork'
    else if (this._overMediaQuota(core)) late = 'quota'
    if (late !== null) {
      await core.close().catch(noop)
      try {
        if (await this._stored(key)) await this._purge(key)
      } catch {
        if (!this._closing) this._fatal(key)
        return
      }
      this._media.delete(key)
      await this._persist().catch(noop)
      if (this._closing) return
      return this._rejectMedia(key, diary, late)
    }
    this._serveMedia(key, diary, core, { expected: res.raw })
    const served = this._mediaServed.get(key)
    if (!served || served.dropped) return
    this.swarm.join(core.discoveryKey, { server: true, client: true })
    this.log({ event: 'media-admitted', key, diary, length: core.contiguousLength })
  }

  // Serving a media core: live download, fork watcher and media quota on
  // growth, no growth broadcast (media keys never reach the admission
  // channel). _stopEntry stops it like a diary entry. `expected` is the
  // block 0 the quarantine fetched (a fresh admission); `headerOk` is true
  // only for a core whose STORED block 0 passed the local gate (a startup
  // survivor), and mediaRead serves nothing before it is (_gateMedia).
  _serveMedia (key, diary, core, { expected = null, headerOk = false } = {}) {
    const entry = {
      core,
      diary,
      download: null,
      stopFork: noop,
      stopGrow: noop,
      stopQuota: noop,
      dropped: false,
      headerOk,
      gating: false,
      expected
    }
    const checkQuota = () => {
      if (entry.dropped || this._closing) return
      if (this._overMediaQuota(core)) this._dropMedia(key, 'quota')
    }
    core.on('append', checkQuota)
    entry.stopQuota = () => core.off('append', checkQuota)
    entry.stopFork = watchFork(core, (reason) => this._dropMedia(key, reason))
    entry.download = core.download({ start: 0, end: -1 })
    entry.stopGrow = watchContiguous(core, () => this._gateMedia(key, entry))
    this._mediaServed.set(key, entry)
    checkQuota()
    if (entry.dropped) return
    if (!entry.headerOk && core.contiguousLength >= 1) this._gateMedia(key, entry)
  }

  // Local re-gate of a served media core, the twin of _gate for diaries: the
  // holder of K's key may have served one block 0 to the quarantine and a
  // different signed fork-0 history to the empty main-store replica
  // (equivocation is invisible until conflicting proofs meet, so the fork
  // watcher cannot see it). Once block 0 is local it must be byte-identical
  // to what the quarantine fetched (else 'fork') and a valid header naming D
  // (else 'header-invalid' / 'wrong-diary'); any failure drops K with the
  // usual purge-before-unlist rules. Only then mediaRead serves K.
  _gateMedia (key, entry) {
    if (entry.dropped || entry.headerOk || entry.gating || this._closing) return
    if (entry.core.contiguousLength < 1) return
    entry.gating = true
    const check = async () => {
      let raw
      try {
        raw = await entry.core.get(0, { wait: false, raw: true })
      } catch {
        return 'header-invalid'
      }
      if (raw === null) return 'header-invalid'
      if (entry.expected !== null && !b4a.equals(raw, entry.expected)) return 'fork'
      return mediaVerdict(raw, entry.diary)
    }
    check().then((reason) => {
      entry.gating = false
      if (entry.dropped || this._closing || this._mediaServed.get(key) !== entry) return
      if (reason !== null) return this._dropMedia(key, reason)
      entry.headerOk = true
      entry.expected = null
    }, () => {
      entry.gating = false
      if (!entry.dropped && !this._closing) this._dropMedia(key, 'header-invalid')
    })
  }

  // Runtime drop of a media core (R6.1 order, as _drop): the binding stays
  // persisted (mediaDropping) until the purge succeeds; a purge failure is
  // fatal and keeps it listed for the next start.
  _dropMedia (key, reason) {
    const entry = this._mediaServed.get(key)
    if (!entry || entry.dropped || this._closing) return
    entry.dropped = true
    this._mediaServed.delete(key)
    const binding = this._media.get(key)
    this._media.delete(key)
    this._mediaDropping.set(key, binding)
    this._stopEntry(entry)
    if (this.swarm) {
      try {
        this.swarm.leave(entry.core.discoveryKey).catch(noop)
      } catch {}
    }
    this.log({ event: 'media-rejected', key, diary: entry.diary, reason })
    const inflight = this._inflight.get(key) || null
    const drop = (async () => {
      if (inflight) await inflight.catch(noop)
      try {
        await this._purge(key)
      } catch {
        if (!this._closing) this._fatal(key)
        return
      }
      this._mediaDropping.delete(key)
      await this._persist()
    })()
    const tracked = drop.catch(noop).then(() => {
      if (this._drops.get(key) === tracked) this._drops.delete(key)
    })
    this._drops.set(key, tracked)
  }

  // Blocks start..start+blocks-1 of media core K bound to diary D, for the
  // HTTP route: null unless the binding exists, D is admitted and not
  // blocked, start >= 1, the range is within K's signed length and EVERY
  // block is local. `bytes` is the exact total (summed from a first local
  // read, since hypercore exposes no per-block sizes), `blocks` yields each
  // block with { wait: false }: nothing here ever waits on the network, and
  // a block gone meanwhile (K purged or closed mid-stream) makes next()
  // reject promptly instead of stalling the response.
  async mediaRead (diaryHex, coreHex, start, blocks) {
    try {
      if (typeof diaryHex !== 'string' || !HEX64.test(diaryHex)) return null
      if (typeof coreHex !== 'string' || !HEX64.test(coreHex)) return null
      const binding = this._media.get(coreHex)
      if (!binding || binding.diary !== diaryHex) return null
      if (!this._admitted.has(diaryHex) || this._isBlocked(diaryHex)) return null
      const entry = this._mediaServed.get(coreHex)
      if (!entry || entry.dropped || !entry.headerOk || this._closing) return null
      const core = entry.core
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(blocks)) return null
      if (start < 1 || blocks < 1 || start + blocks > core.length) return null
      const end = start + blocks
      let bytes = 0
      for (let i = start; i < end; i++) {
        if (!(await core.has(i))) return null
        const raw = await core.get(i, { wait: false, raw: true })
        if (raw === null) return null
        bytes += raw.byteLength
      }
      const read = async function * () {
        for (let i = start; i < end; i++) {
          const raw = await core.get(i, { wait: false, raw: true })
          if (raw === null) throw new Error('bloco indisponível')
          yield raw
        }
      }
      return { bytes, blocks: read() }
    } catch {
      return null
    }
  }

  // Raw blocks 0 and `seq` of diary D, for the token-gated loopback route
  // the account service uses to judge a reported post (apps/cli/lib/
  // seed-ws.js, /moderation-post/). A report carries only the reporter's
  // quote; triage must look at what the author actually signed, and this
  // seeder already holds it. Purely local and read-only: nothing here
  // replicates, admits, downloads, decodes, joins the swarm or touches the
  // engagement index. null unless D is admitted, not blocked, served, gated
  // and not dropped, its core is on fork 0, 1 <= seq < length and BOTH
  // blocks are already local ({ wait: false }). Every await may interleave
  // with a drop, a re-gate, a close or a new blocklist snapshot, so after
  // each one the same conditions (plus an unchanged _moderationGen) are
  // checked again; any change answers null. Trust boundary: these are the
  // raw bytes this seeder's own Hypercore verified on arrival, not a
  // portable proof; the caller trusts this process plus its authenticated
  // loopback for authenticity and re-validates only the record's shape.
  async postBlock (diaryHex, seq) {
    try {
      if (typeof diaryHex !== 'string' || !HEX64.test(diaryHex)) return null
      if (!Number.isSafeInteger(seq) || seq < 1) return null
      const entry = this._served.get(diaryHex)
      const gen = this._moderationGen
      const live = () => !this._closing && this._served.get(diaryHex) === entry &&
        entry.gated && !entry.dropped && this._admitted.has(diaryHex) &&
        !this._isBlocked(diaryHex) && this._moderationGen === gen
      if (!entry || !live()) return null
      const core = entry.core
      if (core.fork !== 0 || seq >= core.length) return null
      const read = async (i) => {
        if (!(await core.has(i)) || !live()) return null
        const raw = await core.get(i, { wait: false, raw: true })
        return raw && live() ? raw : null
      }
      const block0 = await read(0)
      if (block0 === null) return null
      const block = await read(seq)
      if (block === null) return null
      // Re-check after the last await (a drop or adoption can run between
      // read() resolving and this line) and re-read the length: it only
      // grows on fork 0, and the answer must describe the core as handed out.
      if (!live() || core.fork !== 0 || seq >= core.length) return null
      return { fork: 0, length: core.length, block0, block }
    } catch {
      return null
    }
  }

  // ---- Engagement index (header comment) --------------------------------

  // Queues an index pass over a gated diary, on the index queue (one diary
  // at a time, at most one queued per diary), never on the media scan queue.
  _indexDiary (key, entry) {
    if (entry.dropped || !entry.gated || this._closing || this._served.get(key) !== entry) return
    if (this._indexDropped.has(key)) this._rebuildIndex()
    if (this._indexRebuildQueued || entry.indexQueued || entry.indexPaused || entry.indexRetry) return
    entry.indexQueued = true
    const run = () => this._runIndex(key, entry)
    this._indexQueue = this._indexQueue.then(run, run).catch(noop)
  }

  // Serialize the reset after outstanding reads: no old scan can add to a
  // cleared index or advance a reset cursor. Requests before this barrier
  // coalesce; requests during its scans can queue at most one more barrier.
  // Mark pending immediately so even reads before the reset are honest.
  _rebuildIndex () {
    if (this._closing || this._indexRebuildQueued) return
    this._indexRebuildQueued = true
    const rebuild = () => {
      if (this._closing) return
      this._index.clear()
      this._names.clear()
      this._indexDropped.clear()
      // Only gated diaries can start a pass; an ungated one (block 0 not
      // arrived yet) joins when its gate passes, so it must not pin
      // `indexing: true` here.
      this._indexStartup = new Set([...this._served].filter(([, entry]) => entry.gated).map(([key]) => key))
      this._indexRebuildQueued = false
      for (const [key, entry] of this._served) {
        clearTimeout(entry.indexRetry)
        entry.indexRetry = null
        entry.indexReadFailures = 0
        entry.indexPaused = false
        entry.indexQueued = false
        entry.indexed = 1
        this._indexDiary(key, entry)
      }
    }
    this._indexQueue = this._indexQueue.then(rebuild, rebuild).catch(noop)
  }

  // Reads from the index cursor to the contiguous length: each block is
  // decoded once, copied and validated (validRecordCopy) and, when it is one
  // of INDEX_TYPES, handed to the index. A refused add (cap reached) leaves
  // the cursor AT that block and pauses the diary: nothing is ever skipped.
  async _runIndex (key, entry) {
    const core = entry.core
    try {
      while (!entry.dropped && !this._closing && entry.gated && this._served.get(key) === entry && entry.indexed < core.contiguousLength) {
        const i = entry.indexed
        let raw
        try {
          raw = await core.get(i, { wait: false, raw: true })
        } catch {
          this._retryIndex(key, entry)
          return
        }
        if (entry.dropped || this._closing || this._served.get(key) !== entry) return
        if (raw === null) {
          this._retryIndex(key, entry)
          return
        }
        const block = decodeBlock(raw)
        if (block !== null && INDEX_TYPES.has(block.type)) {
          const record = validRecordCopy(block, i)
          // The name index refuses only a new author at its cap: pause like
          // an engagement cap (a retry of the same seq is a no-op there).
          if (record !== null && (record.type === 'profile' || record.type === 'username') && !this._names.note(key, i, record)) {
            entry.indexPaused = true
            return
          }
          if (record !== null && !this._index.add(key, i, record)) {
            entry.indexPaused = true
            return
          }
        }
        entry.indexed = i + 1
        entry.indexReadFailures = 0
      }
    } finally {
      entry.indexQueued = false
      // At most one @nome verification per diary per pass (paused included).
      if (this._served.get(key) === entry && !entry.dropped) this._names.settle(key)
      // The first pass over a diary served at start is over once its cursor
      // reached the length, paused at the cap, or failed three retries at
      // the same cursor. A behind cursor still makes `complete` false.
      if (this._indexStartup !== null && (entry.indexPaused || entry.indexReadFailures >= 4 || entry.indexed >= core.contiguousLength)) {
        this._indexStartup.delete(key)
      }
    }
  }

  // Failed reads release the queue immediately. One timer per served diary,
  // with backoff capped at 60s; growth cannot bypass an outstanding retry.
  _retryIndex (key, entry) {
    if (entry.indexRetry || entry.dropped || this._closing || this._served.get(key) !== entry) return
    entry.indexReadFailures = Math.min((entry.indexReadFailures || 0) + 1, 4)
    const delay = [2000, 10000, 30000, 60000][entry.indexReadFailures - 1]
    entry.indexRetry = setTimeout(() => {
      entry.indexRetry = null
      this._indexDiary(key, entry)
    }, delay)
    entry.indexRetry.unref()
  }

  // The name index of this seeder: capped at maxServed authors; a @nome
  // candidate verifies its signature and issuer delegation for the trusted
  // association (revocation is applied per query by indexSearch).
  _createNameIndex () {
    return createNameIndex({
      maxAuthors: this.maxServed,
      verifyUsername: (author, record) => {
        try {
          return cert.verifyUsernameRecord(record, author, this.association).ok === true
        } catch {
          return false
        }
      }
    })
  }

  // Many toggles or drops can free capacity in one turn; scan paused diaries
  // only once on the next tick, after all synchronous removals have settled.
  _scheduleIndexResume () {
    if (this._closing || this._indexResumeQueued) return
    this._indexResumeQueued = true
    setImmediate(() => {
      this._indexResumeQueued = false
      this._resumeIndex()
    })
  }

  // Room was freed in the index: every paused diary runs again.
  _resumeIndex () {
    // Saturation of one diary must not prevent another diary resuming, and
    // even at maxTargets an existing-target operation can still fit.
    if (this._closing) return
    for (const [key, entry] of this._served) {
      if (!entry.indexPaused) continue
      entry.indexPaused = false
      this._indexDiary(key, entry)
    }
  }

  // Whether an author may appear in an index answer: served, gated, not
  // dropped, admitted and not blocked (defence in depth over _drop, which
  // already removed it).
  _indexVisible (hex) {
    if (typeof hex !== 'string' || !HEX64.test(hex)) return false
    if (this._isBlocked(hex) || !this._admitted.has(hex)) return false
    const entry = this._served.get(hex)
    return !!entry && entry.gated && !entry.dropped
  }

  // The honesty flags of every answer: `indexing` until the first pass over
  // every diary served at start (or a rebuild) finished; `complete` only
  // while no served diary's cursor is paused or behind its contiguous length.
  _indexFlags () {
    const indexing = !this._ready || this._indexRebuildQueued || this._indexStartup === null || this._indexStartup.size > 0
    let complete = !indexing && !this._closing
    if (complete) {
      for (const entry of this._served.values()) {
        if (!entry.gated || entry.dropped) continue
        if (entry.indexPaused || entry.indexed < entry.core.contiguousLength) {
          complete = false
          break
        }
      }
    }
    return { indexing, complete }
  }

  // ---- Topic search index (header comment) ------------------------------

  // Queues a search pass over a gated diary on the search queue (one diary
  // at a time, at most one queued per diary). Unlike _indexDiary there is no
  // rebuild branch: a search posting has no edge from another diary, so
  // removeDiary in _drop is enough, and a re-admitted diary is a new entry
  // scanned from block 1.
  _topicDiary (key, entry) {
    if (entry.dropped || !entry.gated || this._closing || this._served.get(key) !== entry) return
    if (entry.topicQueued || entry.topicPaused || entry.topicRetry) return
    entry.topicQueued = true
    const run = () => this._runTopic(key, entry)
    this._topicQueue = this._topicQueue.then(run, run).catch(noop)
  }

  // A deliberate twin of _runIndex (its own cursor `topicIndexed`): a fix
  // to one must be applied to the other. Only post blocks are handed to the
  // search index; a refused add (cap reached) leaves the cursor AT that block
  // and pauses the diary's search cursor only (never entry.indexPaused).
  // this._topics.add is idempotent, so re-reading the paused block after a resume
  // never double counts.
  async _runTopic (key, entry) {
    const core = entry.core
    try {
      while (!entry.dropped && !this._closing && entry.gated && this._served.get(key) === entry && entry.topicIndexed < core.contiguousLength) {
        const i = entry.topicIndexed
        let raw
        try {
          raw = await core.get(i, { wait: false, raw: true })
        } catch {
          this._retryTopic(key, entry)
          return
        }
        if (entry.dropped || this._closing || this._served.get(key) !== entry) return
        if (raw === null) {
          this._retryTopic(key, entry)
          return
        }
        const block = decodeBlock(raw)
        if (block !== null && block.type === 'post') {
          const record = validRecordCopy(block, i)
          if (record !== null && !this._topics.add(key, i, record)) {
            entry.topicPaused = true
            return
          }
        }
        entry.topicIndexed = i + 1
        entry.topicReadFailures = 0
      }
    } finally {
      entry.topicQueued = false
      // Same startup accounting as _runIndex, over the search fields.
      if (this._topicStartup !== null && (entry.topicPaused || entry.topicReadFailures >= 4 || entry.topicIndexed >= core.contiguousLength)) {
        this._topicStartup.delete(key)
      }
    }
  }

  // As _retryIndex: one timer per served diary, backoff 2/10/30/60 s.
  _retryTopic (key, entry) {
    if (entry.topicRetry || entry.dropped || this._closing || this._served.get(key) !== entry) return
    entry.topicReadFailures = Math.min((entry.topicReadFailures || 0) + 1, 4)
    const delay = [2000, 10000, 30000, 60000][entry.topicReadFailures - 1]
    entry.topicRetry = setTimeout(() => {
      entry.topicRetry = null
      this._topicDiary(key, entry)
    }, delay)
    entry.topicRetry.unref()
  }

  // As _scheduleIndexResume: resume paused search cursors once, next tick.
  _scheduleTopicResume () {
    if (this._closing || this._topicResumeQueued) return
    this._topicResumeQueued = true
    setImmediate(() => {
      this._topicResumeQueued = false
      this._resumeTopic()
    })
  }

  // Room was freed in the search index: every paused search cursor runs again.
  _resumeTopic () {
    if (this._closing) return
    for (const [key, entry] of this._served) {
      if (!entry.topicPaused) continue
      entry.topicPaused = false
      this._topicDiary(key, entry)
    }
  }

  // The search index's honesty flags, as _indexFlags over the search cursor
  // (no rebuild flag: the search index is never rebuilt wholesale).
  _topicFlags () {
    const indexing = !this._ready || this._topicStartup === null || this._topicStartup.size > 0
    let complete = !indexing && !this._closing
    if (complete) {
      for (const entry of this._served.values()) {
        if (!entry.gated || entry.dropped) continue
        if (entry.topicPaused || entry.topicIndexed < entry.core.contiguousLength) {
          complete = false
          break
        }
      }
    }
    return { indexing, complete }
  }

  // GET /index/post/<author>/<seq>[/<cursor>]: the thread page of a post,
  // or null for anything unknown (an author not served, gated and unblocked,
  // a post not indexed, a malformed cursor). Hints cover the target, the
  // parent and every listed author; page items are filtered at read time.
  // Totals exclude dropped authors through synchronous removal.
  indexPost (authorHex, seq, cursor = null) {
    try {
      if (!this._indexVisible(authorHex) || !Number.isSafeInteger(seq) || seq < 1) return null
      const page = this._index.post(authorHex + ':' + seq, cursor, (hex) => this._indexVisible(hex))
      if (page === null) return null
      return { ...page, ...this._indexFlags() }
    } catch {
      return null
    }
  }

  // GET /index/counts/<ref,...>: counts for the refs that are indexed (an
  // unknown ref, or one of an author not visible, is omitted).
  indexCounts (refs) {
    try {
      if (!Array.isArray(refs)) return null
      const visible = (hex) => this._indexVisible(hex)
      return { counts: this._index.counts(refs, visible), ...this._indexFlags() }
    } catch {
      return null
    }
  }

  // GET /index/member/<author>[/<before>]: the timeline page of a served
  // author (posts and reposts currently on, seqs descending), its hints and
  // the length the seeder holds (contiguous); null when not visible.
  indexMember (authorHex, before = null) {
    try {
      if (!this._indexVisible(authorHex)) return null
      if (before !== null && (!Number.isSafeInteger(before) || before < 1)) return null
      const page = this._index.member(authorHex, before) || { profileSeq: null, usernameSeq: null, posts: [], postsTotal: 0 }
      const entry = this._served.get(authorHex)
      return { length: entry.core.contiguousLength, ...page, ...this._indexFlags() }
    } catch {
      return null
    }
  }

  // GET|HEAD /index/topic/<tok>+<tok>[/<cursor>]: refs of visible public
  // posts containing every query token (newest first), a seq hint per listed
  // author (engagement index hints: a hint, not content) and the search
  // index's own honesty flags; null for a malformed query or cursor. The
  // query is never logged. No follow filtering and no ageBand filter (every
  // hosted certificate is 'unchecked', cert.js); visibility is the read gate
  // of the engagement index (_indexVisible), and, as in indexSearch, a diary
  // whose re-gate after a newly revoked issuer is pending (_searchHeld) is
  // left out and the answer says it may be incomplete (complete false).
  indexTopic (path, cursor = null) {
    try {
      if (typeof path !== 'string' || !QUERY_RE.test(path)) return null
      const tokens = [...new Set(path.split('+'))]
      let held = false
      const visible = (hex) => {
        if (!this._indexVisible(hex)) return false
        if (this._searchHeld(hex)) {
          held = true
          return false
        }
        return true
      }
      const page = this._topics.search(tokens, cursor, visible, Date.now())
      if (page === null) return null
      const authors = {}
      for (const ref of page.items) {
        const author = ref.slice(0, ref.indexOf(':'))
        if (!(author in authors)) authors[author] = this._index.hints(author)
      }
      const flags = this._topicFlags()
      return { items: page.items, next: page.next, authors, indexing: flags.indexing, complete: flags.complete && !held }
    } catch {
      return null
    }
  }

  _fatal (key) {
    this.fatal = true
    this.log({ event: 'fatal', key, reason: 'purge-failed' })
    this.close().catch(noop)
  }

  // Whether the main store's storage holds a core for key (never opens one).
  _stored (key) {
    return storedCore(this.store, key)
  }

  async _purge (key) {
    if (!this.purgeHook) return purgeReplica(this.store, key)
    const core = this.store.get({ key: b4a.from(key, 'hex') })
    await core.ready()
    try {
      await this.purgeHook(core)
    } catch (err) {
      await core.close().catch(noop)
      throw err
    }
  }

  // ONE serialized writer: admitted.json = admitted ∪ dropping, and
  // media = media ∪ mediaDropping (same file, same write).
  _persist () {
    const write = () => {
      const admitted = {}
      for (const [key, cert] of this._admitted) admitted[key] = cert
      for (const [key, cert] of this._dropping) admitted[key] = cert
      const media = {}
      for (const [key, binding] of this._media) media[key] = binding
      for (const [key, binding] of this._mediaDropping) media[key] = binding
      writeJsonAtomic(path.join(this.dataDir, ADMITTED_FILE), { v: 1, admitted, media })
    }
    const next = this._writeQueue.then(write, write)
    this._writeQueue = next.catch(noop)
    return next
  }

  // blocklist.json goes through the same serialized writer as
  // admitted.json. The snapshot itself is never added to admitted.json.
  // createBlocklistState.offer re-checks the order inside its own queue and
  // swaps only after this resolves (C5); the write queue alone would not.
  _saveBlocklist (snapshot) {
    const write = () => writeBlocklist(this.dataDir, snapshot)
    const next = this._writeQueue.then(write, write)
    this._writeQueue = next.catch(noop)
    return next
  }

  _offerBlocklist (snapshot, from) {
    return this._blocklist.offer(snapshot).then((result) => {
      if (result.adopted) this._onBlocklistAdopted(result, from)
      return result
    })
  }

  // A newer snapshot was adopted (and saved): tell every other connection
  // (C4 fan-out), then drop every served diary it now blocks through the
  // crash-safe _drop (purge before un-listing). Admissions in flight
  // re-check after each await (_admitReserved). A key the snapshot unblocks
  // is not re-admitted: the author's next announce runs the normal gate.
  _onBlocklistAdopted (result, from) {
    this._blocklistHeld = false
    if (this._closing) return
    const snapshot = this._blocklist.current()
    // Before anything else: a gate verdict in flight (_gate) must not apply
    // a pass computed against the previous snapshot.
    if (result.added.size > 0 || result.revokedAdded.size > 0) this._moderationGen++
    this.log({ event: 'blocklist', seq: snapshot.seq })
    for (const handle of this._blocklistHandles) {
      if (handle !== from) handle.announce()
    }
    for (const key of [...this._served.keys()]) {
      if (this._isBlocked(key)) this._drop(key, 'blocked')
    }
    if (result.revokedAdded.size === 0) return
    // Newly revoked issuers: re-run the local gate on every served replica
    // whose block 0 has been gated. An ungated one is either waiting for
    // block 0 (gated later with the then-current snapshot) or has a verdict
    // in flight, which _gate re-runs because the generation moved.
    for (const [key, entry] of this._served) {
      if (!entry.gated) continue
      // Any failing verdict drops (fail closed): a block 0 that cannot be
      // read now ('not-in-log') would otherwise stay served with gated set,
      // and later growth never re-checks it. An honest author is gated
      // afresh on its next announce.
      // Held out of search until every pending verdict cleared it (indexSearch).
      entry.searchHold = (entry.searchHold || 0) + 1
      localVerdict(entry.core, key, this.association, this._certOpts()).then((reason) => {
        if (reason === null) entry.searchHold--
        if (reason === null || entry.dropped || this._closing) return
        if (this._served.get(key) === entry) this._drop(key, reason)
      })
    }
  }

  // Bounded per-key announce queue (R4.7, review item 1): one admission
  // RUNS per key and at most ONE more is QUEUED; any further announce for
  // the key only registers its peer (and its own, already verified,
  // certificate) as a waiter of the queued admission (one slot per peer; the
  // queued announcer itself is answered by its own run). Every queued
  // announcer and waiter is also attached to the quarantine fetch in flight
  // for the key (M2), so any honest announcer can supply block 0. A waiter
  // gets the queued admission's outcome only when it is `shared` (admitted,
  // or a block-0 certificate rejection); after an outcome that depended on
  // another announcer's socket (timeout, not-in-log, admission-failed, none)
  // a still-connected waiter runs its own gate, and a queued announcer that
  // left hands its turn to a connected waiter. Outstanding announces
  // (running, queued or waiting) are also bounded per peer: a peer that
  // would hold more than maxAnnounces distinct keys outstanding is dropped
  // ('announce-limit').
  _enqueue (key, cert, peer) {
    let chain = this._chains.get(key)
    if (!chain) {
      chain = { running: null, queued: null, fetch: null }
      this._chains.set(key, chain)
    }
    if (chain.running === null) {
      if (!this._holdAnnounce(peer, key)) {
        if (this._chains.get(key) === chain) this._chains.delete(key)
        return Promise.resolve()
      }
      return this._runItem(chain, key, { cert, peer, waiters: new Map(), settle: noop })
    }
    if (chain.queued === null) {
      if (!this._holdAnnounce(peer, key)) return Promise.resolve()
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      chain.queued = { cert, peer, waiters: new Map(), settle }
      this._attachToFetch(chain, peer)
      return done
    }
    if (chain.queued.peer === peer || chain.queued.waiters.has(peer)) return Promise.resolve()
    if (!this._holdAnnounce(peer, key)) return Promise.resolve()
    chain.queued.waiters.set(peer, cert)
    this._attachToFetch(chain, peer)
    return Promise.resolve()
  }

  _attachToFetch (chain, peer) {
    if (chain.fetch && this._peers.has(peer) && !peer.seederDropped) chain.fetch.addSocket(peer.socket)
  }

  // peer.announced: key -> number of queue slots (running, queued, waiter)
  // the peer holds for that key; its size is the peer's outstanding keys.
  _holdAnnounce (peer, key) {
    if (!peer.announced) peer.announced = new Map()
    const n = peer.announced.get(key) || 0
    if (n === 0 && peer.announced.size >= this.maxAnnounces) {
      this._dropPeer(peer, 'announce-limit')
      return false
    }
    peer.announced.set(key, n + 1)
    return true
  }

  _releaseAnnounce (peer, key) {
    if (!peer.announced) return
    const n = peer.announced.get(key) || 0
    if (n <= 1) peer.announced.delete(key)
    else peer.announced.set(key, n - 1)
  }

  _runItem (chain, key, item) {
    // A queued announcer that left hands its turn to a connected waiter.
    while (!this._peers.has(item.peer) && item.waiters.size > 0 && !this._closing) {
      this._releaseAnnounce(item.peer, key)
      const [w, wcert] = item.waiters.entries().next().value
      item.waiters.delete(w)
      item.peer = w
      item.cert = wcert
    }
    const onFetch = (fetch) => {
      chain.fetch = fetch
      if (!fetch) return
      for (const w of item.waiters.keys()) this._attachToFetch(chain, w)
      if (chain.queued) {
        this._attachToFetch(chain, chain.queued.peer)
        for (const w of chain.queued.waiters.keys()) this._attachToFetch(chain, w)
      }
    }
    const run = this._admitNow(key, item.cert, item.peer, onFetch).then((outcome) => outcome, () => undefined)
    chain.running = run
    const tail = run.then((outcome) => {
      chain.fetch = null
      this._releaseAnnounce(item.peer, key)
      const shared = !!(outcome && outcome.shared)
      const retry = []
      for (const [w, wcert] of item.waiters) {
        if (this._closing || !this._peers.has(w)) {
          this._releaseAnnounce(w, key)
        } else if (shared) {
          this._releaseAnnounce(w, key)
          if (outcome.type === 'admitted') w.send({ type: 'admitted', key, length: outcome.length })
          else w.send({ type: 'rejected', key, reason: outcome.reason })
        } else {
          retry.push([w, wcert])
        }
      }
      item.settle()
      let next = chain.queued
      chain.queued = null
      chain.running = null
      // Waiters that got no shared outcome keep their slot and gate again:
      // as waiters of the queued admission, or one of them runs next.
      for (const [w, wcert] of retry) {
        if (next === null) next = { cert: wcert, peer: w, waiters: new Map(), settle: noop }
        else if (next.peer === w || next.waiters.has(w)) this._releaseAnnounce(w, key)
        else next.waiters.set(w, wcert)
      }
      if (next) this._runItem(chain, key, next)
      else if (this._chains.get(key) === chain) this._chains.delete(key)
    })
    return tail
  }

  _onConnection (socket) {
    socket.on('error', noop)
    if (this._closing) {
      socket.destroy()
      return
    }
    // Swarm connection cap (S1), before the store replicates the socket.
    // External sockets (acceptStream) are never in swarm.connections and
    // have their own cap (maxExternal), so they never reduce this limit.
    const onDropped = (ev) => this.log(ev)
    const limit = this.maxConnections
    if (refuseOverConnectionLimit(this.swarm, socket, { limit, log: onDropped })) return
    this._attachPeer(socket)
  }

  // The charged FrameGuard with the lowest progress (received / declared)
  // whose reservation is at least frameEvictAgeMs old, or null.
  _frameVictim () {
    const now = Date.now()
    let victim = null
    let lowest = Infinity
    for (const guard of this._frameGuards) {
      if (now - guard.reservedAt < this.frameEvictAgeMs) continue
      const p = guard.progress()
      if (p < lowest) {
        lowest = p
        victim = guard
      }
    }
    return victim
  }

  // Admits a member over a raw duplex that is not the swarm (phase 0 spike:
  // a WebSocket). The stream is wrapped as a Noise responder keyed with
  // seeder-key.json, so the member's seeder verification (seederCertForKey
  // on the remote public key) is unchanged; after the handshake the socket
  // follows exactly the same path as a swarm connection (_attachPeer).
  // Returns the NoiseSecretStream, or null when the stream was refused.
  // onRefuse (optional, synchronous): on a capacity refusal the seeder calls
  // onRefuse({ reason: 'connection-limit' }) and does NOT destroy rawStream:
  // ownership moves to the caller, so it can tell the client why (seed-ws
  // closes the WebSocket with 1013) before tearing the transport down.
  // Destroying here would be too early: ws's createWebSocketStream
  // terminates the socket in _destroy, so a close frame queued just before
  // never reaches the client. Without onRefuse the stream is destroyed as
  // before; not-ready/closing refusals always destroy it.
  acceptStream (rawStream, { handshakeTimeoutMs = 10000, onRefuse = null } = {}) {
    rawStream.on('error', noop)
    if (!this._ready || this._closing) {
      rawStream.destroy()
      return null
    }
    // External cap (maxExternal) BEFORE the handshake: in-flight handshakes
    // count. Swarm sockets have their own cap and never count here; the
    // check and _external.add below are synchronous on the same set.
    if (this._external.size >= this.maxExternal) {
      this.log({ event: 'peer-dropped', peerKey: null, reason: 'connection-limit' })
      // The refused stream is never added to _external, so it takes no slot
      // whichever side ends up destroying it.
      if (typeof onRefuse === 'function') {
        try {
          onRefuse({ reason: 'connection-limit' })
        } catch {
          rawStream.destroy() // a throwing caller cannot be trusted to clean up
        }
      } else {
        rawStream.destroy()
      }
      return null
    }
    const NoiseSecretStream = require('@hyperswarm/secret-stream')
    // The frame guard bounds what an unauthenticated client can make the
    // secret stream allocate (see FrameGuard); swarm sockets keep
    // secret-stream's own behaviour.
    const guard = new FrameGuard(rawStream, {
      onLimit: (reason) => {
        const key = socket.connected && socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : null
        this.log({ event: 'peer-dropped', peerKey: key, reason })
      },
      budget: this._frameBudget,
      deadlineBaseMs: this.frameDeadlineBaseMs,
      deadlineCapMs: this.frameDeadlineCapMs,
      smallBytes: this.frameSmallBytes
    })
    guard.on('error', noop)
    const socket = new NoiseSecretStream(false, guard, { keyPair: this._keyPair })
    socket.on('error', noop)
    this._external.add(socket)
    // Absolute handshake deadline (never refreshed by incoming bytes).
    let timer = setTimeout(() => {
      timer = null
      socket.destroy()
    }, handshakeTimeoutMs)
    if (timer.unref) timer.unref()
    const clear = () => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
    }
    const onRawClose = () => { if (!socket.connected) socket.destroy() }
    rawStream.on('close', onRawClose)
    socket.on('close', () => {
      clear()
      this._external.delete(socket)
    })
    // The peer key is snapshotted when the admission channel is attached, so
    // _attachPeer never runs before the handshake completes.
    socket.on('connect', () => {
      clear()
      if (socket.remotePublicKey === null || this._closing) {
        socket.destroy()
        return
      }
      // secret-stream destroys the stream after this long without incoming
      // data (each received chunk refreshes the timer).
      socket.setTimeout(this.externalIdleMs)
      this._attachPeer(socket)
    })
    return socket
  }

  // Everything after the connection cap, shared by swarm and external
  // sockets: replicate the store, then the blocklist channel (right after
  // replicate, before the hello: protomux pairs an incoming open only once
  // this side has opened or registered the protocol, C2), then the
  // admission channel. A peer from before B2 rejects the blocklist open and
  // stays connected (blocklist-net.js header).
  _attachPeer (socket) {
    const onDropped = (ev) => this.log(ev)
    this.store.replicate(socket)
    let handle = null
    try {
      handle = attachBlocklist(socket, {
        current: () => this._blocklist.current(),
        offer: (snapshot) => this._offerBlocklist(snapshot, handle),
        compare: compareSnapshots,
        log: (ev) => this.log(ev)
      })
    } catch {
      socket.destroy()
      return
    }
    this._blocklistHandles.add(handle)
    socket.once('close', () => this._blocklistHandles.delete(handle))
    // Follow notices: only the followers of the diary key this connection
    // proved it owns, and never for a blocked diary. A target not (yet)
    // served or not gated (admission or quarantine window, a re-gate) and a
    // closing seeder still get what the index holds, marked incomplete: an
    // empty page marked final would make followers already committed
    // disappear. A peer that never opens the channel keeps replicating
    // (notices-net.js).
    let notices = null
    try {
      notices = attachNotices(socket, {
        role: 'seeder',
        page: ({ target, after, limit }) => {
          if (this._isBlocked(target)) return { items: [], next: null, incomplete: false }
          const result = this._notices.page({ target, isBlocked: (k) => this._isBlocked(k), after, limit })
          const e = this._served.get(target)
          if (this._closing || !e || !e.gated) result.incomplete = true
          return result
        },
        log: (ev) => this.log(ev)
      })
    } catch {
      socket.destroy()
      return
    }
    this._noticeHandles.add(notices)
    socket.once('close', () => this._noticeHandles.delete(notices))
    const have = []
    for (const [key, entry] of this._served) {
      // Never more than a valid hello carries (defence in depth, M1).
      if (have.length >= MAX_INVENTORY) break
      have.push({ key, length: entry.gated ? entry.core.contiguousLength : 0 })
    }
    let peer
    try {
      peer = attachAdmission(socket, {
        role: 'seeder',
        cert: this._cert,
        have,
        onmessage: (msg, p) => this._onMessage(msg, p),
        onclose: (p) => this._peers.delete(p),
        log: (ev) => { if (ev && ev.event === 'peer-dropped') onDropped(ev) }
      })
    } catch {
      socket.destroy()
      return
    }
    this._peers.add(peer)
    // A new socket may be the one that can supply a wanted media core's
    // block 0: retry the pending bindings (bounded: one attempt per trigger).
    this._retryMedia(peer)
    // hello resolves null when the peer leaves first: never block on it.
    Promise.resolve(peer.hello).then((hello) => {
      if (!hello || this._closing || !this._peers.has(peer)) return
      this.log({ event: 'peer', role: peer.remoteRole, peerKey: peer.peerKey })
    }, noop)
  }

  _onMessage (msg, peer) {
    if (this._closing) return
    if (msg.type === 'announce') this.admit(msg.key, msg.cert, peer).catch(noop)
  }

  // Whether a newly revoked issuer's re-gate of `hex` is still pending
  // (_onBlocklistAdopted): until block 0's verdict clears it, or the diary is
  // dropped, it must not take a search result slot. The verdict is the one
  // the gate uses (block 0's certificate), never the announcement's.
  _searchHeld (hex) {
    const entry = this._served.get(hex)
    return !!entry && entry.searchHold > 0
  }

  // GET /index/search/<segment>: the best members whose display name or
  // verified @nome matches the query, with seq hints, or null for a
  // malformed segment. Purely in memory: no disk, crypto or account service,
  // and nothing about the query is ever logged.
  indexSearch (segment) {
    try {
      const q = parseQuery(segment)
      if (q === null) return null
      const opts = this._certOpts()
      const revoked = opts && opts.revokedIssuers instanceof Set ? opts.revokedIssuers : new Set()
      // A match held by a pending re-gate is left out, and the answer says
      // it may be incomplete (complete false) rather than final.
      let held = false
      const visible = (hex) => {
        if (!this._indexVisible(hex)) return false
        if (this._searchHeld(hex)) {
          held = true
          return false
        }
        return true
      }
      const page = this._names.search(q, visible, (issuer) => !revoked.has(issuer))
      if (page === null) return null
      const flags = this._indexFlags()
      return { members: page.members, more: page.more, indexing: flags.indexing, complete: flags.complete && !held }
    } catch {
      return null
    }
  }

  close () {
    if (this._closing) return this._closing
    this._closing = (async () => {
      if (this._stopRediscovery) this._stopRediscovery()
      for (const entry of this._served.values()) this._stopEntry(entry)
      this._served.clear()
      this._notices = createNoticeIndex() // nothing of the index outlives close
      for (const entry of this._mediaServed.values()) this._stopEntry(entry)
      this._mediaServed.clear()
      for (const socket of [...this._external]) {
        try { socket.destroy() } catch {}
      }
      if (this.swarm) {
        try { await this.swarm.destroy() } catch {}
      }
      // The quarantine is closed and removed, and every in-flight admission
      // step and drop (purge) has settled, BEFORE the main store closes:
      // store.close releases the data-dir lock, so the next opener of this
      // data dir (which wipes/recreates the quarantine) never has it removed
      // under it.
      if (this.qstore) {
        try { await this.qstore.close() } catch {}
        await Promise.allSettled([...this._inflight.values()])
        removeQuarantine(this.dataDir)
      }
      await Promise.allSettled([...this._drops.values()])
      if (this.store) {
        try { await this.store.close() } catch {}
      }
      this._peers.clear()
      this._blocklistHandles.clear()
      for (const handle of this._noticeHandles) {
        try { handle.close() } catch {}
      }
      this._noticeHandles.clear()
      this._resolveClosed()
    })()
    return this._closing
  }
}

Seeder.GATE_TIMEOUT_MS = GATE_TIMEOUT_MS
Seeder.ANNOUNCE_RATE = ANNOUNCE_RATE
Seeder.ANNOUNCE_BURST = ANNOUNCE_BURST
Seeder.MAX_BAD_ANNOUNCES = MAX_BAD_ANNOUNCES

module.exports = {
  Seeder,
  GATE_TIMEOUT_MS,
  MAX_HANDSHAKE_FRAME,
  MAX_HANDSHAKE_BYTES,
  MAX_EXTERNAL_FRAME,
  MAX_FRAME_MEMORY,
  SMALL_FRAME_BYTES,
  FRAME_DEADLINE_BASE_MS,
  FRAME_DEADLINE_CAP_MS,
  FRAME_MIN_BYTES_PER_S,
  frameDeadlineFor,
  EXTERNAL_IDLE_MS
}
