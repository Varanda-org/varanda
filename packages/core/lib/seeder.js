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
// verify the content from the diaries themselves (indexPost, indexEngagers,
// indexCounts, indexMember back the /index routes of apps/cli/lib/seed-ws.js).
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
//
// Group cores (lib/group.js, docs/protocol.md section 10) ride on the media
// invariants with the same TWO-WAY binding: a writer core W is kept only
// once an admitted, gated, non-blocked diary D holds a live `group-join`
// naming W AND W's block 0 is a group-writer header naming that group and D;
// a root G once its block 0 is a valid group header and some admitted,
// unblocked diary joins G (the diary its header names counts only through
// its own join for writer G: _rootBound). At most MAX_GROUP_WRITERS_PER_DIARY
// writers of one diary count per group (liveGroupJoins). Listed in
// admitted.json (`groups: { K: { diary, group, seq } }`), persisted before
// the open, purged before un-listing.
// Leaving (a join turned off) NEVER purges: it only marks the writer as
// left in the group index (lib/group-index.js), so the moderation record of
// a departed member stays verifiable. Purges happen for a dropped or
// blocked diary, a root its blocked or revoked creator bound, a root key in
// the blocklist snapshot, a fork or the quota.
// Group keys never travel on the admission channel; members learn writer
// sets over 'varanda/groups/1' (lib/groups-net.js) and the /index routes.
const fs = require('#fs')
const path = require('#path')
const process = require('#process')
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
const { attachNotices, attachNoticesV2 } = require('./notices-net')
const { createPostNoticeIndex } = require('./post-notices')
const { pushCandidate, pushName } = require('./push-events')
const {
  validateRecord,
  validRecordCopy,
  decodeBlock,
  MAX_LOG_BLOCKS,
  MAX_LOG_BYTES,
  MAX_MEDIA_BLOCKS,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_CORES,
  MAX_GROUP_WRITERS,
  MAX_GROUPS_PER_DIARY,
  MAX_GROUP_WRITERS_PER_DIARY
} = require('./records')
const { validateMediaHeader, latestMediaCores } = require('./media')
const { validateGroupHeader, validateWriterHeader, validateGroupRecord, groupJoins } = require('./group')
const { createGroupIndex } = require('./group-index')
const { attachGroups } = require('./groups-net')
const { presentState, presentLength, clearDeleted, downloadExcept, deletedRanges } = require('./deletion')
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
// this many times in a row (moving past a block resets the count): without
// it a fully contiguous log (no further growth to re-queue the scan) would
// stay pending, and its pages incomplete, for the life of the process.
const SCAN_RETRY_MS = 2000
const SCAN_RETRIES_MAX = 8
// Diaries prepared at once (_prepareDiary decodes every stored block of
// one diary into memory): at start every surviving diary is served
// together, and unbounded the peak heap is the sum of all of them.
const PREPARE_CONCURRENCY = 2
// Tombstones queued for an incremental irregular media memo update; more
// before the memo is next used rebuild it (bounds the queue of a regular
// diary, which never uses it).
const TOMB_NEW_MAX = 1024
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

// Below the present length a block that is not local is one a local
// tombstone above it targets (presentLength passes only those holes), even
// before the scan has learned that tombstone: a cursor passes it instead of
// waiting for a block no peer may serve any more. A null read of a local
// block stays a read failure.
async function deletedHole (core, seq) {
  try {
    return !(await core.has(seq))
  } catch {
    return false
  }
}

// Media cores whose deletion counters one diary keeps (a diary entry's
// `media`). Only the latest MAX_MEDIA_CORES are ever bound, so twice that
// covers every honest diary (about one core per device) with room to spare,
// while a diary declaring thousands of keys holds at most this many cores x
// MAX_MEDIA_BLOCKS x 2 counter entries, whatever it writes.
const MEDIA_TRACK_MAX = 2 * MAX_MEDIA_CORES

// Fresh counters for a core first declared at seq `since`. Sparse (one entry
// per block actually referenced, never above MAX_MEDIA_BLOCKS), so an honest
// diary costs only the blocks its posts and tombstones name.
function mediaState (since) {
  return { since, last: since, live: new Map(), del: new Map(), dead: 0, ver: 0 }
}

// Starts counting core K, first declared at seq `seq`, in `counts` (a
// diary entry, or the fresh counters of a recount). At the cap the core
// whose latest declaration is oldest is evicted: it falls out of the latest
// set first. An evicted core is never tracked again in this pass (its
// earlier ranges are lost), so mediaRead refuses it (fail closed) until a
// recount (_recountMedia) tracks it again. `pinned` cores (the bound set,
// at most MAX_MEDIA_CORES of the MEDIA_TRACK_MAX slots) are never evicted.
function trackMedia (counts, key, seq, pinned = null) {
  if (counts.media.size >= MEDIA_TRACK_MAX) {
    let oldest = null
    for (const [k, state] of counts.media) {
      if (pinned !== null && pinned.has(k)) continue
      if (oldest === null || state.last < counts.media.get(oldest).last) oldest = k
    }
    counts.media.delete(oldest)
  }
  counts.media.set(key, mediaState(seq))
}

// A `media-core` declaration of K at seq, before `declared` (the keys
// declared below seq) learns it.
function countDeclaration (counts, declared, key, seq, pinned = null) {
  if (!declared.has(key)) trackMedia(counts, key, seq, pinned)
  else if (counts.media.has(key)) counts.media.get(key).last = seq
}

// The media a post or profile at seq shows (r its valid copy, or null).
// A descriptor in a core not declared below seq makes the diary irregular:
// honest writers declare a core before using it, and the counters would
// miss it while readers' deletedRanges count every declared core.
function countShown (counts, declared, seq, r) {
  const refs = r === null ? [] : r.type === 'post' ? (r.media || []) : (r.avatar ? [r.avatar] : [])
  const counted = []
  for (const { core, start, blocks } of refs) {
    if (!declared.has(core)) counts.mediaIrregular = true
    const state = counts.media.get(core)
    if (state === undefined) continue
    mediaBump(state, start, blocks, 'live', 1)
    counted.push({ core, start, blocks })
  }
  if (counted.length > 0) counts.mediaRefs.set(seq, counted)
}

// Adds the ranges `media` of one tombstone (undefined: none) to the
// per-core block sets in `sets`, for the cores it holds only.
function addTombRanges (sets, media) {
  if (media === undefined) return
  for (const { core, start, blocks } of media) {
    const set = sets.get(core)
    if (set === undefined) continue
    for (let b = start; b < Math.min(start + blocks, MAX_MEDIA_BLOCKS); b++) set.add(b)
  }
}

// Whether tombstone `record` makes the diary irregular for media: it
// deletes a tombstone (the counters undo one level only, while readers fold
// every level) or lists a range in a core not declared below it (never
// counted). Honest writers do neither. `tombstones` needs only the seqs
// below the record: a target is always lower than its tombstone.
function tombstoneIrregular (declared, tombstones, record) {
  if (tombstones.has(record.seq)) return true
  if (!Array.isArray(record.media)) return false
  return record.media.some(({ core }) => !declared.has(core))
}

// The media side of tombstone `record` at seq whose target block decoded
// to `block` (null when unreadable): the target's shown media stop
// counting, a deleted tombstone's ranges are re-read from its own block and
// uncounted (a failed read keeps them counted, which refuses more, never
// less), and this tombstone's ranges count (guarded: a scan that retries
// a tombstone must not count it twice).
function countTombstone (counts, seq, record, block) {
  const target = record.seq
  const refs = counts.mediaRefs.get(target)
  if (refs !== undefined) {
    counts.mediaRefs.delete(target)
    for (const r of refs) mediaBump(counts.media.get(r.core), r.start, r.blocks, 'live', -1)
  }
  if (counts.mediaTombs.has(target) && block !== null && block.type === 'delete') {
    const prev = validRecordCopy(block, target)
    if (prev !== null) {
      counts.mediaTombs.delete(target)
      countRanges(counts, target, prev.media, -1)
    }
  }
  if (!counts.mediaTombs.has(seq) && countRanges(counts, seq, record.media, 1)) counts.mediaTombs.add(seq)
}

// Per-block counters of one tracked media core (mediaState): `live` how
// many surviving posts/profiles show a block, `del` how many effective
// tombstones list it, `dead` how many blocks have del > 0 and no live
// count, `ver` bumped on every change (mediaRead caches by it). Costs
// O(blocks), and a record's range is at most MAX_MEDIA_ITEM_BLOCKS.
function mediaBump (state, start, blocks, field, delta) {
  if (state === undefined) return
  const end = Math.min(start + blocks, MAX_MEDIA_BLOCKS)
  for (let b = Math.max(start, 0); b < end; b++) {
    const wasDead = state.del.has(b) && !state.live.has(b)
    const counts = state[field]
    const n = (counts.get(b) || 0) + delta
    if (n > 0) counts.set(b, n)
    else counts.delete(b)
    const isDead = state.del.has(b) && !state.live.has(b)
    if (wasDead !== isDead) state.dead += isDead ? 1 : -1
  }
  state.ver++
}

// The deletion state of a diary describes its whole log only once the scan
// has read every block of the signed length: before that, after every
// restart, while a new diary syncs or while a block is missing below
// blocks already stored, a tombstone may still be unread. (The scan skips
// the holes a tombstone explains and stops at any other one, so an unknown
// gap keeps this false until it is filled.)
function scanCaughtUp (entry) {
  return entry.scanned >= entry.core.length
}

// Adds (delta 1) or takes back (delta -1) the media ranges of tombstone
// `seq`. Only cores declared before `seq` count, which is exactly the set
// counted when the upward scan applied it, so taking back is symmetric.
// Returns whether any range counted.
function countRanges (counts, seq, ranges, delta) {
  if (!Array.isArray(ranges)) return false
  let any = false
  for (const { core, start, blocks } of ranges) {
    const state = counts.media.get(core)
    if (state === undefined || state.since >= seq) continue
    mediaBump(state, start, blocks, 'del', delta)
    any = true
  }
  return any
}

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
// verifyIssued). `out`, when given, receives the block-0 certificate
// (out.cert) the verdict judged: a revoked-issuer verdict must be recorded
// against that certificate's issuer, never an announced one, so a diary
// holding certificates from two issuers cannot keep its roots served once
// the one in its log is revoked.
function gateVerdict (raw, keyHex, associationHex, opts, out = null) {
  try {
    const block0 = decodeBlock(raw)
    if (block0 === null || validateRecord(block0, 0) !== null) return 'not-in-log'
    if (out !== null) out.cert = block0.cert
    const r = certForKey(block0.cert, keyHex, associationHex, opts)
    return r.ok ? null : r.reason
  } catch {
    return 'not-in-log'
  }
}

// LOCAL gate: block 0 already in the main store. Any error is 'not-in-log',
// so a failure can never skip the purge.
async function localVerdict (core, keyHex, associationHex, opts, out = null) {
  try {
    const raw = await core.get(0, { wait: false, raw: true })
    return gateVerdict(raw, keyHex, associationHex, opts, out)
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

// A persisted group binding { diary, group, seq }, or null (purged at start
// as 'unbound', like an unusable media binding). A root's binding also
// carries `by`, the diary whose join admitted it and whose group budget it
// uses; a file written before `by` existed reads without it (charged to
// nobody, never to the header's diary). `bound: true` records that the
// header's diary bound the root with its own join (_rootBound) while it was
// served: only then does blocking or revoking that diary purge the root.
// `issuer` is the issuer of that diary's verified block-0 certificate, kept
// with `bound` so a later revocation of it still purges the root after the
// creator left for another reason (quota, its own drop).
function groupBinding (value) {
  if (!isPlainObject(value)) return null
  const { diary, group, seq, by, bound, issuer } = value
  if (typeof diary !== 'string' || !HEX64.test(diary)) return null
  if (typeof group !== 'string' || !HEX64.test(group)) return null
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  const out = { diary, group, seq }
  if (typeof by === 'string' && HEX64.test(by)) out.by = by
  if (bound === true) out.bound = true
  if (out.bound === true && typeof issuer === 'string' && HEX64.test(issuer)) out.issuer = issuer
  return out
}

// Sets k -> v in a denial map. At ROOT_CREATORS_MAX entries those whose
// denial is no longer in force (`lifted(k, v)`) go; one still in force
// never goes, or a purged root could return. false when the map holds
// ROOT_DENIALS_HARD entries and nothing was set. Only moderation outcomes
// (a served diary dropped or refused, a root purged) reach these maps,
// never an announce.
function bounded (map, k, v, lifted) {
  map.delete(k)
  if (map.size >= ROOT_CREATORS_MAX) {
    for (const [ek, ev] of [...map]) if (lifted(ek, ev)) map.delete(ek)
  }
  if (map.size >= ROOT_DENIALS_HARD) return false
  map.set(k, v)
  return true
}

// goneRoots as read from admitted.json: root -> { creator, issuer } (issuer
// null for a block). A plain creator string (the format before issuers were
// kept) reads as { creator, issuer: null }.
function goneRootMap (value) {
  const out = new Map()
  if (!isPlainObject(value)) return out
  for (const [k, v] of Object.entries(value)) {
    if (out.size >= ROOT_DENIALS_HARD) break
    if (!HEX64.test(k)) continue
    if (typeof v === 'string' && HEX64.test(v)) out.set(k, { creator: v, issuer: null })
    else if (isPlainObject(v) && typeof v.creator === 'string' && HEX64.test(v.creator)) {
      const issuer = typeof v.issuer === 'string' && HEX64.test(v.issuer) ? v.issuer : null
      out.set(k, { creator: v.creator, issuer })
    }
  }
  return out
}

// A bounded map of hex keys to hex values read from admitted.json (at most
// ROOT_CREATORS_MAX entries, the rest ignored).
function hexMap (value) {
  const out = new Map()
  if (!isPlainObject(value)) return out
  for (const [k, v] of Object.entries(value)) {
    if (out.size >= ROOT_DENIALS_HARD) break
    if (HEX64.test(k) && typeof v === 'string' && HEX64.test(v)) out.set(k, v)
  }
  return out
}

// The header fields /index/group answers for a root this seeder verified
// (_groupHeaders), kept after the root itself is purged or refused. A
// private root keeps no name.
function headerRecord (header) {
  const name = header.visibility === 'public' && typeof header.name === 'string' ? header.name : null
  return { kind: header.kind, visibility: header.visibility, join: header.join, name }
}

// groupHeaders as read from admitted.json: only well-formed records, at most
// ROOT_DENIALS_HARD (start prunes those of groups with no core left).
function headerRecordMap (value) {
  const out = new Map()
  if (!isPlainObject(value)) return out
  for (const [k, v] of Object.entries(value)) {
    if (out.size >= ROOT_DENIALS_HARD) break
    if (!HEX64.test(k) || !isPlainObject(v)) continue
    if ((v.kind !== 'group' && v.kind !== 'community') || (v.join !== 'open' && v.join !== 'approval')) continue
    if (v.visibility !== 'public' && v.visibility !== 'private') continue
    if (v.name !== null && (v.visibility !== 'public' || typeof v.name !== 'string' || v.name.length > 1024)) continue
    out.set(k, { kind: v.kind, visibility: v.visibility, join: v.join, name: v.name })
  }
  return out
}

// The issuer a v2 certificate names (lower-case hex), or null.
function issuerOf (cert) {
  const issuer = isPlainObject(cert) && typeof cert.issuer === 'string' ? cert.issuer.toLowerCase() : null
  return issuer !== null && HEX64.test(issuer) ? issuer : null
}

// The maps of admitted.json: `admitted` (diaries), `media` (media cores,
// values normalized through mediaBinding; absent before this version),
// `groups` (group cores through groupBinding; absent reads as {}),
// `revokedCreators` (diary -> the issuer of the certificate it was dropped
// or refused for) and `goneRoots` (root -> { creator, issuer } of the
// block or revocation that purged it, judged on its own against the current
// list); the last two absent read as empty.
function readAdmittedFile (dataDir) {
  const data = readJson(path.join(dataDir, ADMITTED_FILE), { v: 1, admitted: {} })
  const admitted = isPlainObject(data) && isPlainObject(data.admitted) ? data.admitted : {}
  const media = {}
  if (isPlainObject(data) && isPlainObject(data.media)) {
    for (const [key, value] of Object.entries(data.media)) media[key] = mediaBinding(value)
  }
  const groups = {}
  if (isPlainObject(data) && isPlainObject(data.groups)) {
    for (const [key, value] of Object.entries(data.groups)) groups[key] = groupBinding(value)
  }
  const revokedCreators = hexMap(isPlainObject(data) ? data.revokedCreators : null)
  const goneRoots = goneRootMap(isPlainObject(data) ? data.goneRoots : null)
  const groupHeaders = headerRecordMap(isPlainObject(data) ? data.groupHeaders : null)
  return { admitted, media, groups, revokedCreators, goneRoots, groupHeaders }
}

// The file as _persist and Seeder.drop write it: `groups`, `revokedCreators`
// and `goneRoots` only when non-empty, so a seeder without groups keeps its
// old shape.
function admittedFile (admitted, media, groups, { revokedCreators = new Map(), goneRoots = new Map(), groupHeaders = new Map() } = {}) {
  const file = { v: 1, admitted, media }
  if (Object.keys(groups).length > 0) file.groups = groups
  if (revokedCreators.size > 0) file.revokedCreators = Object.fromEntries(revokedCreators)
  if (goneRoots.size > 0) {
    file.goneRoots = {}
    for (const [k, { creator, issuer }] of goneRoots) file.goneRoots[k] = issuer === null ? { creator } : { creator, issuer }
  }
  if (groupHeaders.size > 0) file.groupHeaders = Object.fromEntries(groupHeaders)
  return file
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

// Block-0 verdict of a group core K for group G: a root (K === G) must be a
// valid group header, a writer a valid group-writer header naming G
// ('wrong-group') and the diary ('wrong-diary'). `diary` null accepts any
// root creator (a fresh root admission learns it from the header).
function groupVerdict (raw, key, group, diary) {
  try {
    const header = decodeBlock(raw)
    if (header === null) return 'header-invalid'
    if (key === group) {
      if (validateGroupHeader(header) !== null) return 'header-invalid'
      return diary === null || header.diary === diary ? null : 'wrong-diary'
    }
    if (validateWriterHeader(header) !== null) return 'header-invalid'
    if (header.group !== group) return 'wrong-group'
    return header.diary === diary ? null : 'wrong-diary'
  } catch {
    return 'header-invalid'
  }
}

// LOCAL group gate (block 0 in the main store): the verdict and the raw
// block; any error is 'header-invalid'.
async function localGroupVerdict (core, key, binding) {
  try {
    const raw = await core.get(0, { wait: false, raw: true })
    return { reason: groupVerdict(raw, key, binding.group, binding.diary), raw }
  } catch {
    return { reason: 'header-invalid', raw: null }
  }
}

// Writer cores one diary may hold at a seeder across all its groups, left
// ones included (leaving never frees a slot): its share of the group cores.
const MAX_GROUP_CORES_PER_DIARY = MAX_GROUPS_PER_DIARY * MAX_GROUP_WRITERS_PER_DIARY
// Waits before a group core that timed out or found no peer is tried again
// for the same diary, so scans and connections do not restart fetches.
const GROUP_BACKOFF_MS = [2000, 10000, 30000, 60000, 300000, 900000]
// Group admissions (quarantine fetches) in flight at once, in all and per
// diary.
const GROUP_INFLIGHT_MAX = 32
const GROUP_INFLIGHT_PER_DIARY = 2
// How long, in total within GROUP_STALL_WINDOW_MS, a diary's join scan may
// sit caught up with its local blocks behind its signed length before it
// stops holding other diaries' group answers incomplete (_groupScanCounts).
const GROUP_SCAN_STALL_MS = 10000
const GROUP_STALL_WINDOW_MS = 10 * 60 * 1000
// Bound on _revokedCreators and _goneRoots (persisted in admitted.json):
// past ROOT_CREATORS_MAX denials still in force no group root is admitted
// (_rootsClosed), and a live denial is never evicted to make room; each
// map still holds at most ROOT_DENIALS_HARD entries.
const ROOT_CREATORS_MAX = 4096
const ROOT_DENIALS_HARD = 2 * ROOT_CREATORS_MAX

// The live joins of a diary from its newest join per writer (lib/group.js
// groupJoins), keeping only joins of its first MAX_GROUPS_PER_DIARY groups
// by diary seq, so the extra joins are ignored the same way on every scan.
// Per group only the MAX_GROUP_WRITERS_PER_DIARY writers with the earliest
// on:true join count, a root joined by its own key holding one of them (the
// fold's rule, lib/group.js capPerDiary): this protects a group's writer cap
// and the seeder's group cores from one diary declaring hundreds of writers.
// `first` is group -> Map(writer -> earliest on:true seq).
// writer -> { group, seq }.
function liveGroupJoins (decls, first = new Map()) {
  const allowed = new Set()
  for (const [group, writers] of first) {
    const list = [...writers].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    let room = MAX_GROUP_WRITERS_PER_DIARY
    if (writers.has(group)) {
      allowed.add(group + ':' + group)
      room--
    }
    for (const [writer] of list) {
      if (writer === group) continue
      if (room <= 0) break
      allowed.add(group + ':' + writer)
      room--
    }
  }
  const entries = [...decls].map(([writer, d]) => ({ seq: d.seq, record: { type: 'group-join', group: d.group, writer, on: d.on, at: d.at } }))
  const live = [...groupJoins(entries).values()].sort((a, b) => a.seq - b.seq)
  const groups = new Set()
  const out = new Map()
  for (const j of live) {
    if (!allowed.has(j.group + ':' + j.writer)) continue
    if (!groups.has(j.group)) {
      if (groups.size >= MAX_GROUPS_PER_DIARY) continue
      groups.add(j.group)
    }
    out.set(j.writer, { group: j.group, seq: j.seq })
  }
  return out
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
  // local block-0 verdict is computed and before it is applied, _gate and
  // _gateGroup) and
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
  // maxGroupCores bounds the group cores (roots and writers; default
  // maxServed) and maxGroupWriters the writers of one group (default
  // MAX_GROUP_WRITERS); maxGroupInflight the group admissions in flight
  // at once (default GROUP_INFLIGHT_MAX); groupScanStallMs the stall bound
  // of _groupScanCounts (default GROUP_SCAN_STALL_MS);
  // groupHeaderTimeoutMs how long an admitted group core may wait for its
  // block 0 in the main store (default GATE_TIMEOUT_MS); admitHook and
  // purgeHook also see group keys.
  // onPush(event) is not a test hook: called synchronously, never awaited,
  // once per follow, reply, like or repost appended to a served diary past
  // its push cursor (push-events.js shapes the event; a throw is ignored).
  // noClear (default: VARANDA_NO_CLEAR=1, the rollout kill switch) keeps
  // the bytes of deleted diary blocks and media ranges: they are only
  // hidden, as before byte deletion.
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
    onPush = null,
    noClear = null,
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
    maxGroupCores = null,
    maxGroupWriters = MAX_GROUP_WRITERS,
    maxGroupInflight = GROUP_INFLIGHT_MAX,
    groupScanStallMs = GROUP_SCAN_STALL_MS,
    groupHeaderTimeoutMs = GATE_TIMEOUT_MS,
    regateTimeoutMs = GATE_TIMEOUT_MS,
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
    this.maxGroupCores = maxGroupCores === null ? maxServed : maxGroupCores
    this.maxGroupWriters = maxGroupWriters
    this.maxGroupInflight = maxGroupInflight
    this.groupScanStallMs = groupScanStallMs
    this.groupHeaderTimeoutMs = groupHeaderTimeoutMs
    this.regateTimeoutMs = regateTimeoutMs
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
    if (onPush !== null && typeof onPush !== 'function') throw new TypeError('onPush must be a function or null')
    this.onPush = onPush
    this.noClear = noClear === null ? (process.env || {}).VARANDA_NO_CLEAR === '1' : noClear === true
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
    // Discovery key (hex) -> purges running, and -> replication opens in
    // flight: a peer's request for a key never opens it while its storage
    // is being deleted (_guardReplication).
    this._purgingKeys = new Map()
    this._attaching = new Map()

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
    // Group cores (header comment): bound and dropping bindings, key ->
    // { diary, group, seq }; admitted.json `groups` is the union of both.
    // They share _inflight and _drops with diaries and media.
    this._groups = new Map()
    this._groupsDropping = new Map()
    this._groupServed = new Map() // key -> { core, diary, group, download, stopFork, stopGrow, stopQuota, dropped, headerOk, gating, expected }
    this._groupReserved = new Map() // key -> group, holding a group slot mid-admission
    this._groupReservedBy = new Map() // key -> diary whose join is admitting it
    this._groupBackoff = new Map() // 'diary:key' -> { reason, step, until } after 'timeout' / 'no-peers'
    this._groupRefusals = new Map() // 'diary:key' -> last refusal logged ('reason:seq')
    this._groupDeferred = new Set() // diaries with a join waiting for an admission slot
    this._groupStalls = new Map() // diary key -> stall budget of _groupScanCounts, kept across _drop/_serve
    this._goneRoots = new Map() // root key -> { creator, issuer } of the block or revocation that purged it (persisted)
    this._unrecordedRevoked = new Map() // diary -> issuer that _revokedCreators had no room for (this process only)
    this._denialsLost = false // a denial found no room: roots stay refused until restart (_rootsClosed)
    this._revokedCreators = new Map() // diary -> issuer it was dropped or refused for (persisted, _creatorGone)
    this._groupFetches = new Map() // group key -> quarantine fetch in flight
    this._groupHeaders = new Map() // root key -> headerRecord of a root this seeder verified, while a core of its group is kept (persisted)
    this._groupIndex = createGroupIndex({ maxGroups: this.maxGroupCores, maxWritersPerGroup: maxGroupWriters })
    this._groupHandles = new Set()
    this._preparing = 0 // _prepareDiary calls running (at most PREPARE_CONCURRENCY)
    this._prepareWaiters = []
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
    // Diaries served at start whose first group scan has not ended: a listed
    // root kept at start only provisionally (a member's live join may keep
    // it) is judged once this set empties (_groupStartupScanned); null when
    // nothing waits.
    this._groupRootStartup = null
    this._indexDropped = new Set()
    this._indexRebuildQueued = false
    // Topic search index (header comment): its own queue and startup set,
    // independent of the engagement index's.
    this._topics = createTopicIndex({ maxPosts: topicMaxPosts, perAuthorMax: topicPerAuthorMax, maxTerms: topicMaxTerms, maxPostings: topicMaxPostings, perAuthorPostingsMax: topicPerAuthorPostingsMax, perAuthorTermsMax: topicPerAuthorTermsMax, onFreed: () => this._scheduleTopicResume() })
    this._topicQueue = Promise.resolve()
    this._topicStartup = null
    this._pushQueue = Promise.resolve()
    this._topicResumeQueued = false
    this._writeQueue = Promise.resolve()
    // The signed moderation snapshot (blocklist.js createBlocklistState),
    // created in start() once the data-dir lock is held, and the open
    // blocklist channel of every connection (for the C4 fan-out).
    this._blocklist = null
    this._blocklistHandles = new Set()
    // True from a start whose blocklist.json was unreadable or missing with no
    // usable copy to fall back to (a list existed and is lost) until a
    // verified snapshot is adopted: new admissions are refused meanwhile.
    // Decided again at every start: a torn file kept aside by an earlier
    // start and no verified list hold it again.
    this._blocklistHeld = false
    // Follow notices (notices.js): the follower index is in memory only,
    // rebuilt from block 1 by the diary scan on every serve and never
    // persisted; the open notices channel of every connection.
    // isMember reads the live sets (both created above); a follow of a key
    // admitted later is picked up on that author's next serve or restart.
    // Post notices (post-notices.js: replies, quotes, @nome mentions) follow
    // the same lifecycle in their own index, so a mention spammer never
    // touches the follow index's budget; both are paged on
    // varanda/notices/2, and _noticeHandles holds the v1 and v2 channels.
    this._notices = createNoticeIndex({ isMember: (k) => this._admitted.has(k) || this._served.has(k) })
    this._postNotices = this._createPostNoticeIndex()
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
  // Group cores are listed the same way under the diary their binding names
  // (`groups: [{ key, group, length, byteLength }]`; a root under its creator).
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
        entry.groups = []
        for (const [k, binding] of Object.entries(file.groups)) {
          if (!HEX64.test(k) || binding === null || binding.diary !== key) continue
          const g = await sizes(k, openMediaReplica)
          entry.groups.push({ key: k, group: binding.group, length: g.length, byteLength: g.byteLength })
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
  // way (purge, then un-list), and so do its group writer cores (a root
  // stays: other members may still keep it, the next start re-gates it); a
  // media or group key itself may also be dropped. A
  // purge failure throws and leaves the file untouched. It is not a block:
  // the author's next announce runs the full gate again (to keep an author
  // out, block the key with `mod block`), and a dropped media core is bound
  // again by the next scan of its diary.
  static async drop (dataDir, associationKey, key) {
    Seeder.checkConfig(dataDir, associationKey)
    if (typeof key !== 'string' || !HEX64.test(key)) throw new UsageError('chave inválida')
    const store = await openStore(dataDir)
    try {
      const { admitted, media, groups, revokedCreators, goneRoots, groupHeaders } = readAdmittedFile(dataDir)
      const listed = Object.prototype.hasOwnProperty.call(admitted, key)
      const listedMedia = Object.prototype.hasOwnProperty.call(media, key)
      const listedGroup = Object.prototype.hasOwnProperty.call(groups, key)
      const stored = await storedCore(store, key)
      if (!listed && !listedMedia && !listedGroup && !stored) throw new Error('diário não está no semeador')
      const gone = new Set([key])
      for (const [k, binding] of Object.entries(media)) {
        if (HEX64.test(k) && binding !== null && binding.diary === key) gone.add(k)
      }
      for (const [k, binding] of Object.entries(groups)) {
        if (HEX64.test(k) && binding !== null && binding.diary === key && k !== binding.group) gone.add(k)
      }
      for (const k of gone) {
        if (k !== key && await storedCore(store, k)) await purgeReplica(store, k)
      }
      if (stored) await purgeReplica(store, key)
      if (listed || listedMedia || listedGroup || gone.size > 1) {
        const rest = {}
        for (const [k, cert] of Object.entries(admitted)) if (k !== key) rest[k] = cert
        const restMedia = {}
        for (const [k, binding] of Object.entries(media)) if (!gone.has(k)) restMedia[k] = binding
        const restGroups = {}
        for (const [k, binding] of Object.entries(groups)) if (!gone.has(k)) restGroups[k] = binding
        writeJsonAtomic(path.join(dataDir, ADMITTED_FILE), admittedFile(rest, restMedia, restGroups, { revokedCreators, goneRoots, groupHeaders }))
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
      this._guardReplication()
      if (this.storeHook) await this.storeHook()
      const file = readAdmittedFile(this.dataDir)
      for (const [key, cert] of Object.entries(file.admitted)) {
        if (HEX64.test(key)) this._admitted.set(key, cert)
      }
      // Media bindings (null for an unusable one: purged below as 'unbound').
      for (const [key, binding] of Object.entries(file.media)) {
        if (HEX64.test(key) && !this._admitted.has(key)) this._media.set(key, binding)
      }
      this._revokedCreators = file.revokedCreators
      this._goneRoots = file.goneRoots
      this._groupHeaders = file.groupHeaders
      for (const [key, binding] of Object.entries(file.groups)) {
        if (HEX64.test(key) && !this._admitted.has(key) && !this._media.has(key)) this._groups.set(key, binding)
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
        const judged = {}
        // A blocked author takes the fork path (rejected, purged, un-listed),
        // never _drop: _drop returns for a key not in _served (it is only
        // filled in step 4). A revoked issuer surfaces through localVerdict.
        if (this._isBlocked(key)) {
          reason = 'blocked'
          // A creator both blocked and from a revoked issuer: lifting only
          // the block must not bring back the roots it bound (_noteGoneRoot).
          if (core.fork === 0 && core.contiguousLength > 0 && await localVerdict(core, key, this.association, this._certOpts(), judged) === 'revoked-issuer') {
            this._noteRevokedCreator(key, judged.cert)
          }
        } else if (core.fork !== 0) reason = 'fork'
        else if (core.contiguousLength === 0) reason = 'no-cert'
        else if (this._overQuota(core)) reason = 'quota' // item 5: before any serve/join
        else reason = await localVerdict(core, key, this.association, this._certOpts(), judged)
        if (reason === null && survivors.length < this.maxServed) {
          this._forgetRevoked(key)
          survivors.push([key, core, judged.cert])
          continue
        }
        // Capacity (M1): a listed log beyond maxServed is purged through the
        // same path, so a restart always comes back under the cap.
        if (reason === null) this.log({ event: 'warning', key, reason: 'seeder-full' })
        else this.log({ event: 'rejected', key, reason })
        if (reason === 'revoked-issuer') this._noteRevokedCreator(key, judged.cert)
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

      // Step 3c: listed group cores, the same way (header comment). A writer
      // needs its diary to have survived; a root its creator or a listed
      // writer of the group whose diary survived. A root key in the
      // snapshot takes its group down. The stored block 0 must be the header
      // the binding names.
      const groupSurvivors = []
      const perGroup = new Map()
      let provisionalRoot = false
      const perDiary = new Map() // diary -> { total, roots, groups: Map(group -> writers) }
      // A root's creator supports it only if it bound the root (_rootBound),
      // which its scan tells: until then the root is provisional.
      const supported = (key, binding) => {
        if (key !== binding.group) return kept.has(binding.diary)
        for (const [k, b] of this._groups) {
          if (k !== key && b !== null && b.group === key && kept.has(b.diary)) return true
        }
        // Live joins are known only after the scans, which run after this
        // step: a root admitted through a member's join whose writer never
        // completed would be lost for good if purged now. It stays while
        // any unblocked diary survived, and is judged after the scans.
        for (const d of kept) {
          if (!this._isBlocked(d)) {
            provisionalRoot = true
            return true
          }
        }
        return false
      }
      for (const [key, binding] of [...this._groups]) {
        let reason = null
        let core = null
        let raw = null
        if (binding === null || !supported(key, binding)) reason = 'unbound'
        else if (this._isBlocked(binding.group)) reason = 'group-blocked'
        else if (key === binding.group && this._rootGone(key) !== null) {
          reason = this._rootGone(key)
          this._noteGoneRoot(key, binding.diary, reason)
        } else {
          core = await openMediaReplica(this.store, key)
          if (core.fork !== 0) reason = 'fork'
          else if (core.contiguousLength === 0) reason = 'no-header'
          else if (this._overQuota(core)) reason = 'quota'
          else ({ reason, raw } = await localGroupVerdict(core, key, binding))
        }
        if (reason === null && (groupSurvivors.length >= this.maxGroupCores || (perGroup.get(binding.group) || 0) >= this.maxGroupWriters)) reason = 'group-full'
        // The per-diary budget restored: writers under their diary, roots
        // under the diary charged with them (`by`; none for an old entry).
        const isRoot = reason === null && key === binding.group
        const chargedTo = reason !== null ? null : isRoot ? (binding.by || null) : binding.diary
        let held = null
        if (chargedTo !== null) {
          held = perDiary.get(chargedTo) || { total: 0, roots: 0, groups: new Map() }
          if (held.total >= MAX_GROUP_CORES_PER_DIARY) reason = 'group-full'
          else if (isRoot ? held.roots >= MAX_GROUPS_PER_DIARY : (held.groups.get(binding.group) || 0) >= MAX_GROUP_WRITERS_PER_DIARY) reason = 'group-full'
        }
        if (reason === null) {
          if (held !== null) {
            held.total++
            if (isRoot) held.roots++
            else held.groups.set(binding.group, (held.groups.get(binding.group) || 0) + 1)
            perDiary.set(chargedTo, held)
          }
          perGroup.set(binding.group, (perGroup.get(binding.group) || 0) + 1)
          groupSurvivors.push([key, binding, core, raw])
          continue
        }
        if (core !== null) await core.close().catch(noop)
        this.log({ event: 'group-rejected', key, diary: binding === null ? null : binding.diary, group: binding === null ? null : binding.group, reason })
        try {
          await this._purge(key)
        } catch {
          throw new Error('falha ao limpar núcleo de grupo rejeitado: ' + key8(key))
        }
        this._groups.delete(key)
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
      if (provisionalRoot) this._groupRootStartup = new Set(survivors.map(([key]) => key))
      // Each diary first clears what its stored tombstones delete (and the
      // ranges they list in its bound media cores), before any download
      // or peer can bring those bytes back.
      for (const [key, core, cert0] of survivors) this._serve(key, core, { regate: false, cert0 })
      await Promise.all(survivors.map(([key]) => this._served.has(key) ? this._served.get(key).prepared : null))
      for (const [key, diary, core] of mediaSurvivors) this._serveMedia(key, diary, core, { headerOk: true })
      await Promise.all(mediaSurvivors.map(([key]) => this._mediaServed.has(key) ? this._mediaServed.get(key).prepared : null))
      for (const [key, binding, core, raw] of groupSurvivors) {
        if (key === binding.group) {
          this._groupIndex.setHeader(key, decodeBlock(raw))
          this._keepGroupHeader(key, decodeBlock(raw))
        }
        this._serveGroup(key, binding, core, { headerOk: true })
        if (key === binding.group && !this._served.has(binding.diary)) this._indexKeptRoot(key, false)
      }
      for (const k of [...this._groupHeaders.keys()]) this._pruneGroupHeader(k)

      // Step 5: the swarm, with the seeder's Noise key pair.
      this.topic = topicFor(this.association)
      this.swarm = createSwarm({ bootstrap: this.bootstrap, keyPair: this._keyPair, host: this.host })
      this.swarm.on('connection', (socket) => this._onConnection(socket))
      const topics = [
        this.topic,
        ...survivors.map(([, core]) => core.discoveryKey),
        ...mediaSurvivors.filter(([key]) => this._mediaServed.has(key)).map(([, , core]) => core.discoveryKey),
        ...groupSurvivors.filter(([key]) => this._groupServed.has(key)).map(([, , core]) => core.discoveryKey)
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
      blocks += entry.present
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
      groupCores: this._groups.size,
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
      else {
        // A first refusal is a moderation outcome; the same key again from
        // the same peer is a replay, so it counts like a bad announce.
        if (!peer.revokedSeen) peer.revokedSeen = new Set()
        if (peer.revokedSeen.has(key)) this._badAnnounce(peer)
        else if (peer.revokedSeen.size < 256) peer.revokedSeen.add(key)
      }
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
      const length = served.present
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
    if (this._media.has(key) || this._mediaDropping.has(key) || this._mediaReserved.has(key) || this._isGroupKey(key)) {
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
    // The main replica may still be empty here while res.length is the
    // signed length the quarantine verified: the history up to it was
    // written before this admission and must never become a push.
    this._serve(key, core, { regate: true, pushFrom: Math.max(core.length, res.length) })
    // A resumed main-store core already over the quota was dropped inside
    // _serve (rejected sent, purge under way): no join, no admitted (item 6).
    const entry = this._served.get(key)
    if (!entry || entry.dropped) return { type: 'rejected', reason: 'quota' }
    await entry.prepared
    if (this._closing || entry.dropped || this._served.get(key) !== entry) return
    this.swarm.join(core.discoveryKey, { server: true, client: true })
    const length = entry.present
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

  _serve (key, core, { regate, cert0 = null, pushFrom = core.length }) {
    // Media scan state (header comment): `scanned` is the next block to read
    // for media-core records (block 0 is the certificate), `decls` the
    // declared cores seen so far (key -> { seq, at }, newest seq; a seq/key
    // list, never the entries), `latest` the current binding set and
    // `refused` the declarations whose block 0 failed the media gate (retried
    // only when re-declared at a newer seq). Index state (header comment):
    // `indexed` is the next block the engagement index reads, `indexPaused`
    // that the index refused a record at that block (cap reached) and the
    // cursor waits there until room is freed. The topic* fields are the
    // same state for the topic search index, on its own cursor. `pushNext`
    // is the next block the push scanner reads: set once here and only ever
    // advanced, never by a rescan or an index rebuild, so a block is pushed
    // at most once per serve and history at serve time never is.
    const entry = {
      core,
      download: null,
      stopFork: noop,
      stopGrow: noop,
      stopQuota: noop,
      gated: !regate,
      headerTimer: null, // the re-gate deadline of a replica served before its block 0 is local
      // The block-0 certificate the gate passed (judged again when the
      // diary is blocked, _drop).
      cert0,
      gating: false,
      dropped: false,
      scanned: 1,
      scanQueued: false,
      scanRetry: null, // pending retry timer of a failed block read
      scanRetries: 0, // failed passes in a row on the same block
      decls: new Map(),
      latest: [],
      refused: new Map(),
      // Group scan state: `groupDecls` the newest group-join per writer
      // (writer -> { group, on, seq, at }), `groupLive` the live joins kept
      // under MAX_GROUPS_PER_DIARY (writer -> { group, seq }) and
      // `groupRefused` the joins whose core failed the gate (writer -> seq),
      // `groupBound` the newest on:true join of each root key G naming G
      // itself (G -> { group: G, seq }), which keeps binding after a later
      // on:false or a later on:true join of G into another group: one
      // entry per root key, so a creator cannot unbind its own root (and
      // escape its purge) by naming the root key as a writer elsewhere, and
      // the map grows no faster than groupDecls; and
      // `groupFirst` the earliest on:true join per group and writer (group
      // -> Map(writer -> seq)), which ranks writers for the per-diary cap.
      groupDecls: new Map(),
      groupBound: new Map(),
      groupFirst: new Map(),
      groupLive: new Map(),
      groupRefused: new Map(),
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
      // Deletion state, rebuilt by every scan from block 1 (in memory only):
      // `deleted` every seq a scanned tombstone removed (monotone: the index
      // cursors skip them), `tombstones` tombstone seq -> target seq and
      // `effective` its cached fold (what readers hide, for postBlock),
      // `media` tracked media core -> per-block counters (trackMedia,
      // mediaBump; at most MEDIA_TRACK_MAX cores),
      // `mediaRefs` post/profile seq -> the counted media it shows,
      // `mediaTombs` the tombstone seqs whose ranges are counted,
      // `mediaIrregular` that the log does something the counters cannot
      // follow (countShown, tombstoneIrregular: mediaRead then refuses all
      // of this diary's media until a re-serve), `mediaRecounts` how many
      // recounts this serve ran and `mediaRecounting` one is running.
      deleted: new Set(),
      tombstones: new Map(),
      effective: null,
      media: new Map(),
      mediaRefs: new Map(),
      mediaTombs: new Set(),
      mediaIrregular: false,
      mediaRecounts: 0,
      mediaRecounting: false,
      // Byte deletion (in memory only, recomputed from the stored
      // tombstones at every serve): `gone` the target of every tombstone
      // read so far, effective or not (a hole there is known, so the scans
      // and the present length skip it), `excluded` every seq the readers'
      // fold has deleted in this serve (cleared, and left out of the
      // download; never shrinks, so a seq a later tombstone gives back is
      // not fetched again), `arrived` blocks downloaded above the scan
      // cursor (a tombstone among them is applied before the scan gets
      // there), `mediaStart` media core -> blocks the stored tombstones
      // delete (lib/deletion.js deletedRanges, for the cores bound at
      // serve), `present` the present length (lib/deletion.js; replaces
      // contiguousLength, which a clear pulls back) and `prepared` the
      // startup clear, before which nothing is downloaded.
      gone: new Set(),
      excluded: new Set(),
      arrived: new Set(),
      mediaStart: new Map(),
      present: 0,
      prepared: null,
      clearing: null,
      clearAgain: false,
      // Irregular media clear without reading tombstones back (_noteTombstone,
      // _mediaGone): `tombMedia` tombstone seq -> the ranges it lists,
      // `tombMax` the highest tombstone seq learned, `tombNew` tombstones
      // learned since `irrMemo` (per-core blocks for one effective set) that
      // only add their own ranges, `irrDirty` that the memo must be rebuilt,
      // and `clearedEffective` the effective set already in `excluded`.
      tombMedia: new Map(),
      tombMax: -1,
      tombNew: [],
      irrDirty: true,
      irrMemo: null,
      clearedEffective: null,
      // Active-diary state (lib/activity.js; in memory only, never persisted
      // or logged): openReplica already awaited core.ready(), so core.length
      // is the stored signed length, and only growth past it counts.
      activityLength: core.length,
      activeAt: null,
      pushNext: pushFrom,
      pushQueued: false,
      pushRetry: null,
      pushReadFailures: 0
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
        this._postNotices.markPending(key)
        noteGrowth(entry, core.length, Date.now())
      }
    }
    core.on('append', checkQuota)
    entry.stopQuota = () => core.off('append', checkQuota)
    entry.stopFork = watchFork(core, (reason) => this._drop(key, reason))
    this._served.set(key, entry)
    // Every serve scans from block 1: rebuild this author's follows from
    // scratch, invisible to pages until the scan reaches the signed length.
    this._notices.removeAuthor(key)
    this._notices.markPending(key)
    this._postNotices.removeAuthor(key)
    this._postNotices.markPending(key)
    checkQuota()
    if (entry.dropped) return
    // A peer that served block 0 to the quarantine and then withholds it
    // from the main store must not hold every group answer incomplete: past
    // the gate timeout the replica goes ('timeout') and the key returns only
    // through a new announce and the full quarantine gate.
    if (regate) {
      entry.headerTimer = setTimeout(() => {
        entry.headerTimer = null
        if (entry.dropped || entry.gated || entry.gating || this._closing || this._served.get(key) !== entry) return
        this._drop(key, 'timeout')
      }, this.regateTimeoutMs)
      if (entry.headerTimer.unref) entry.headerTimer.unref()
    }
    // _prepareDiary re-gates a replica that already holds block 0.
    entry.prepared = this._prepareBounded(key, entry, regate).catch(noop)
  }

  // The download starts inside _prepareDiary, after the clear, so waiting
  // here keeps a diary's deleted bytes from being fetched back.
  async _prepareBounded (key, entry, regate) {
    while (this._preparing >= PREPARE_CONCURRENCY) {
      await new Promise((resolve) => this._prepareWaiters.push(resolve))
    }
    this._preparing++
    try {
      if (entry.dropped || this._closing || this._served.get(key) !== entry) return
      await this._prepareDiary(key, entry, regate)
    } finally {
      this._preparing--
      const next = this._prepareWaiters.shift()
      if (next) next()
    }
  }

  // Local reads only (lib/deletion.js presentState walks every stored
  // block, past holes too): learn the stored tombstones, clear the blocks
  // their fold deletes, and only then start the download (one range per
  // gap, so no peer is asked for a deleted block) and the growth watcher.
  async _prepareDiary (key, entry, regate) {
    const core = entry.core
    const stale = () => entry.dropped || this._closing || this._served.get(key) !== entry
    let state = null
    try {
      state = await presentState(core)
    } catch {}
    if (stale()) return
    if (state !== null) {
      for (const { seq, record } of state.raw) {
        const r = record !== null && record.type === 'delete' ? validRecordCopy(record, seq) : null
        if (r === null) continue
        this._noteTombstone(entry, seq, r)
        entry.tombstones.set(seq, r.seq)
        entry.gone.add(r.seq)
        // Above a hole no tombstone explains, the scan cannot reach it yet.
        if (seq >= state.present) entry.arrived.add(seq)
      }
      entry.effective = null
      const bound = []
      for (const [k, binding] of this._media) if (binding !== null && binding.diary === key) bound.push(k)
      for (const r of deletedRanges(state.raw, bound)) {
        if (!entry.mediaStart.has(r.core)) entry.mediaStart.set(r.core, new Set())
        const blocks = entry.mediaStart.get(r.core)
        for (let b = r.start; b < Math.min(r.start + r.blocks, MAX_MEDIA_BLOCKS); b++) blocks.add(b)
      }
      // Only the sets above are kept: the decoded blocks go before the
      // clear and the present walk, which may wait on the disk a while.
      state = null
    }
    for (const seq of this._effectiveDeleted(entry)) entry.excluded.add(seq)
    if (!this.noClear) {
      try {
        await clearDeleted(core, entry.excluded)
      } catch {}
    }
    let present = 0
    try {
      present = await presentLength(core, entry.gone)
    } catch {}
    if (stale()) return
    entry.present = Math.max(entry.present, present)
    entry.download = this._downloader(core, entry.excluded)
    // Growth is measured on the present length (has() only: no block is
    // read here, the scan reads each one). A block arriving above the scan
    // cursor queues a pass, which applies a tombstone among such blocks
    // even when an unknown hole stops it (_applyArrived).
    let running = false
    let again = false
    let above = false
    const check = async () => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          const len = await presentLength(core, entry.gone, entry.present)
          if (stale()) return
          const arrivedAbove = above
          above = false
          this._onPresent(key, entry, len, arrivedAbove)
        } while (again)
      } catch {} finally {
        running = false
      }
    }
    const onAppend = () => { check() }
    const onDownload = (index) => {
      if (index >= entry.scanned) entry.arrived.add(index)
      if (index > entry.scanned) above = true
      check()
    }
    core.on('append', onAppend)
    core.on('download', onDownload)
    entry.stopGrow = () => {
      core.off('append', onAppend)
      core.off('download', onDownload)
    }
    // A replica opened for re-gating may already hold block 0.
    if (regate && entry.present >= 1) this._onGrow(key, entry, entry.present)
    if (entry.present > entry.pushNext) this._pushDiary(key, entry)
  }

  // The live download of a diary or media core minus `deleted`
  // (lib/deletion.js downloadExcept: update() clears and re-ranges). With
  // noClear every block is downloaded and kept, as before byte deletion.
  _downloader (core, deleted) {
    if (!this.noClear) return downloadExcept(core, deleted)
    const range = core.download({ start: 0, end: -1 })
    return { update: async () => [], destroy: () => range.destroy(), idle: async () => {} }
  }

  // Growth goes through _onGrow; a block that arrived above the scan
  // cursor without growth only queues a scan (the block AT the cursor is
  // the one a running or retrying pass reads).
  _onPresent (key, entry, length, above) {
    if (length > entry.present) return this._onGrow(key, entry, length)
    if (above && entry.gated) this._scanDiary(key, entry)
  }

  // `length` is a present length: it only ever raises entry.present.
  _onGrow (key, entry, length) {
    if (entry.dropped || this._closing) return
    if (!(entry.present >= length)) entry.present = length
    if (this._overQuota(entry.core)) return this._drop(key, 'quota')
    if (!entry.gated) {
      // Re-gate on arrival: the main store may have received a different
      // block 0 than the quarantine did. Not before block 0 is local.
      if (entry.gating || !(entry.present >= 1)) return
      entry.gating = true
      this._gate(key, entry)
      return
    }
    this._broadcastHave(key, entry.present)
    this._scanDiary(key, entry)
    this._indexDiary(key, entry)
    this._topicDiary(key, entry)
    this._pushDiary(key, entry)
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
    const judged = {}
    localVerdict(entry.core, key, this.association, this._certOpts(), judged).then(async (reason) => {
      if (this.regateHook) await this.regateHook(key, reason)
      if (entry.dropped || this._closing) {
        entry.gating = false
        return
      }
      if (reason === null && this._isBlocked(key)) reason = 'blocked'
      if (reason === null && gen !== this._moderationGen) return this._gate(key, entry)
      entry.gating = false
      if (reason !== null) return this._drop(key, reason, judged.cert)
      entry.gated = true
      entry.cert0 = judged.cert
      clearTimeout(entry.headerTimer)
      entry.headerTimer = null
      this._forgetRevoked(key)
      this._broadcastHave(key, entry.present)
      this._scanDiary(key, entry)
      this._indexDiary(key, entry)
      this._topicDiary(key, entry)
      // Growth during the gate returned early from _onGrow.
      this._pushDiary(key, entry)
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
    clearTimeout(entry.headerTimer)
    entry.headerTimer = null
    clearTimeout(entry.indexRetry)
    entry.indexRetry = null
    clearTimeout(entry.topicRetry)
    entry.topicRetry = null
    clearTimeout(entry.pushRetry)
    entry.pushRetry = null
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
  // `judgedCert` is the block-0 certificate a 'revoked-issuer' verdict
  // judged (_noteRevokedCreator).
  _drop (key, reason, judgedCert = null) {
    const entry = this._served.get(key)
    if (!entry || entry.dropped || this._closing) return
    entry.dropped = true
    this._served.delete(key)
    this._notices.removeAuthor(key)
    this._postNotices.removeAuthor(key)
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
    this._groupStartupScanned(key)
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
    // Its group writers too; a root stays while another diary keeps it.
    const rootRows = this._boundRootRows(key)
    this._groupIndex.removeDiary(key)
    this._forgetGroupAttempts(key)
    if (reason === 'revoked-issuer' && this._revokedCreators) this._noteRevokedCreator(key, judgedCert)
    // A blocked creator whose block-0 issuer is also revoked: noted before
    // its roots go, so lifting only the block does not let the roots it
    // bound back in while the issuer stays revoked.
    if (reason === 'blocked' && this._revokedCreators && entry.cert0 && certForKey(entry.cert0, key, this.association, this._certOpts()).reason === 'revoked-issuer') {
      this._noteRevokedCreator(key, entry.cert0)
    }
    for (const [k, g] of [...this._groupServed]) {
      if (g.diary === key && k !== g.group) this._dropGroup(k, reason)
    }
    this._dropUnsupportedRoots()
    for (const [k, row] of rootRows) this._indexKeptRoot(k, row.left)
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
  // diary; a scan walks the local blocks from the diary's cursor up to its
  // signed length, skipping the holes a tombstone explains and stopping at
  // any other (checking again before it ends), so growth during a scan is
  // not lost.
  _scanDiary (key, entry) {
    if (entry.scanQueued || entry.dropped || !entry.gated || this._closing) return
    entry.scanQueued = true
    const run = () => this._runScan(key, entry)
    this._scanQueue = this._scanQueue.then(run, run).catch(noop)
  }

  async _runScan (key, entry) {
    entry.scanQueued = false
    const core = entry.core
    const stale = () => entry.dropped || this._closing || this._served.get(key) !== entry
    while (!entry.dropped && !this._closing && entry.scanned < core.length) {
      const i = entry.scanned
      // Below the present length a block is local or a known hole, so it
      // is read right away; above it, only once has() says it is local.
      let local = i < entry.present
      if (!local) {
        try {
          local = await core.has(i)
        } catch {}
      }
      let raw = null
      if (local) {
        try {
          raw = await core.get(i, { wait: false, raw: true })
        } catch {}
      }
      // The read suspended this scan: a drop, close or re-serve meanwhile
      // (all call _notices.removeAuthor) makes this entry stale, and a fold
      // for it would be an orphan (edge budget held for good) or, after a
      // re-serve, a seq high-water mark the new scan's records fall under.
      // Nothing below touches the index for a stale entry.
      if (stale()) return
      if (raw === null && entry.gone.has(i)) {
        entry.scanned = i + 1
        entry.scanRetries = 0
        continue
      }
      // A hole no tombstone explains: its arrival queues the scan again.
      if (!local) break
      if (raw === null) {
        // Below the present length a hole is one a local tombstone above it
        // targets (presentLength), possibly cleared by every peer before
        // this replica opened: learn that tombstone now, or no pass ever
        // gets past the hole (_applyArrived only runs after an unknown one).
        for (let b = i + 1; b < entry.present; b++) entry.arrived.add(b)
        await this._applyArrived(key, entry)
        if (stale()) return
        if (entry.gone.has(i)) continue
        this._retryScan(key, entry)
        return
      }
      const block = decodeBlock(raw)
      if (block !== null && block.type === 'delete') {
        const r = validRecordCopy(block, i)
        if (r !== null && tombstoneIrregular(entry.decls, entry.tombstones, r)) entry.mediaIrregular = true
        if (r !== null && !entry.tombstones.has(i)) {
          this._noteTombstone(entry, i, r)
          entry.tombstones.set(i, r.seq)
          entry.effective = null
        }
        if (r !== null) entry.gone.add(r.seq)
        if (r !== null && !entry.deleted.has(i)) {
          const done = await this._applyDelete(key, entry, i, r)
          if (entry.dropped || this._closing || this._served.get(key) !== entry) return
          if (!done) {
            this._retryScan(key, entry)
            return
          }
        }
        // Only now: `scanned` feeds the `complete` flags, which must not
        // turn true while this tombstone's target is still indexed.
        entry.scanned = i + 1
        entry.scanRetries = 0
        continue
      }
      entry.scanned = i + 1
      // Reset only once the scan moves past a block: a tombstone whose
      // apply keeps failing reads fine every pass and would never hit the cap.
      entry.scanRetries = 0
      if (block === null) continue
      if (block.type === 'follow') {
        const r = validRecordCopy(block, i)
        if (r !== null) this._notices.foldFollow(key, i, r)
        continue
      }
      if (block.type === 'group-join') {
        const r = validRecordCopy(block, i)
        if (r === null) continue
        const prev = entry.groupDecls.get(r.writer)
        if (prev === undefined || i > prev.seq) entry.groupDecls.set(r.writer, { group: r.group, on: r.on, seq: i, at: r.at })
        const bound = r.writer === r.group ? entry.groupBound.get(r.writer) : undefined
        if (r.on && r.writer === r.group && (bound === undefined || i > bound.seq)) entry.groupBound.set(r.writer, { group: r.group, seq: i })
        if (r.on) {
          let firsts = entry.groupFirst.get(r.group)
          if (firsts === undefined) {
            firsts = new Map()
            entry.groupFirst.set(r.group, firsts)
          }
          if (!firsts.has(r.writer) || i < firsts.get(r.writer)) firsts.set(r.writer, i)
        }
        continue
      }
      // Folded here, not in _runIndex: that queue pauses at capacity and
      // would leave mention targets unknown while the scan commits.
      if (block.type === 'username') {
        const r = validRecordCopy(block, i)
        if (r !== null) this._postNotices.foldUsername(key, i, r)
        continue
      }
      if (block.type === 'post' || block.type === 'profile') {
        const r = validRecordCopy(block, i)
        if (r !== null && r.type === 'post') this._postNotices.foldPost(key, i, r)
        countShown(entry, entry.decls, i, r)
        continue
      }
      if (block.type !== 'media-core') continue
      const record = validRecordCopy(block, i)
      if (record === null || record.key === key) continue
      // Counters only for declared cores, from their first declaration on
      // (honest writers declare a core before using it), and for at most
      // MEDIA_TRACK_MAX of them: memory never grows with the number of
      // declarations or tombstones. A core declared before but no longer
      // tracked was evicted and stays untracked.
      const prev = entry.decls.get(record.key)
      countDeclaration(entry, entry.decls, record.key, i)
      if (prev === undefined || i > prev.seq) entry.decls.set(record.key, { seq: i, at: record.at })
    }
    if (stale()) return
    // Stopped at an unknown hole: tombstones that arrived above it are
    // applied now, never after the hole is filled (it may be a deleted
    // block no peer serves any more). One whose target is the hole lets
    // the next pass skip it.
    if (entry.scanned < core.length) {
      await this._applyArrived(key, entry)
      if (stale()) return
      if (entry.gone.has(entry.scanned)) this._scanDiary(key, entry)
    }
    for (const index of entry.arrived) {
      if (index < entry.scanned) entry.arrived.delete(index)
    }
    // The loop stops at an unknown hole, while the signed length advances
    // before the blocks arrive: publishing a prefix could hide a later
    // unfollow, so only a fold that reached the signed length is committed
    // (a pending author marks every page `incomplete`).
    if (entry.scanned >= core.length) {
      this._notices.commit(key)
      this._postNotices.settle(key)
    } else {
      this._notices.markPending(key)
      this._postNotices.markPending(key)
    }
    const entries = [...entry.decls].map(([k, { seq, at }]) => ({ seq, record: { type: 'media-core', key: k, at } }))
    entry.latest = latestMediaCores(entries, key, MAX_MEDIA_CORES)
    for (const k of [...entry.refused.keys()]) {
      if (!entry.latest.some((b) => b.key === k)) entry.refused.delete(k)
    }
    this._reconcileMedia(key, entry)
    entry.groupLive = liveGroupJoins(entry.groupDecls, entry.groupFirst)
    this._reconcileGroups(key, entry)
    this._groupStartupScanned(key)
    if (scanCaughtUp(entry) && !entry.mediaIrregular && entry.mediaRecounts < MEDIA_TRACK_MAX &&
      entry.latest.some((b) => !entry.media.has(b.key))) {
      await this._recountMedia(key, entry)
      if (stale()) return
    }
    // Never behind an index pass paused at a cap, and never holding up the
    // scan queue.
    this._scheduleClear(key, entry)
    let present = entry.present
    try {
      present = await presentLength(core, entry.gone, entry.present)
    } catch {}
    if (!stale() && present > entry.present) this._onGrow(key, entry, present)
  }

  // Applies the tombstones among the blocks that arrived above the scan
  // cursor (or were stored above a hole at serve) to the indexes and to
  // what is cleared. Their media counters wait for the scan: it counts each
  // tombstone once all the declarations below it are known.
  async _applyArrived (key, entry) {
    const stale = () => entry.dropped || this._closing || this._served.get(key) !== entry
    for (const index of [...entry.arrived].sort((a, b) => a - b)) {
      entry.arrived.delete(index)
      if (index < entry.scanned) continue
      let raw = null
      try {
        if (await entry.core.has(index)) raw = await entry.core.get(index, { wait: false, raw: true })
      } catch {}
      if (stale()) return
      const block = raw === null ? null : decodeBlock(raw)
      const r = block !== null && block.type === 'delete' ? validRecordCopy(block, index) : null
      if (r === null) continue
      if (!entry.tombstones.has(index)) {
        this._noteTombstone(entry, index, r)
        entry.tombstones.set(index, r.seq)
        entry.effective = null
      }
      entry.gone.add(r.seq)
      if (!entry.deleted.has(index)) await this._applyDelete(key, entry, index, r, { media: false })
      if (stale()) return
    }
  }

  // One clear at a time per diary; requests made while one runs coalesce
  // into a single next run (an update re-ranges the whole download, so a
  // stream of tombstones must not re-range once per scan pass).
  _scheduleClear (key, entry) {
    if (entry.clearing) {
      entry.clearAgain = true
      return
    }
    const stale = () => entry.dropped || this._closing || this._served.get(key) !== entry
    entry.clearing = (async () => {
      try {
        do {
          entry.clearAgain = false
          await this._clearDiary(key, entry)
        } while (entry.clearAgain && !stale())
      } finally {
        entry.clearing = null
      }
    })().catch(noop)
  }

  // Clears the diary blocks the readers' fold deletes (never block 0 nor a
  // tombstone: lib/deletion.js clearDeleted) and takes them out of the
  // download, then the media blocks of the cores bound to this diary.
  // A pass that learned no tombstone keeps the same cached effective set,
  // so the walk over it is skipped (excluded never shrinks). Under the kill
  // switch nothing is cleared, so the media side does not run at all.
  async _clearDiary (key, entry) {
    let changed = false
    const effective = this._effectiveDeleted(entry)
    if (entry.clearedEffective !== effective) {
      for (const seq of effective) {
        if (seq > 0 && !entry.excluded.has(seq)) {
          entry.excluded.add(seq)
          changed = true
        }
      }
      entry.clearedEffective = effective
    }
    if (changed && entry.download) {
      try {
        await entry.download.update(entry.excluded)
      } catch {}
    }
    if (entry.dropped || this._closing || this._served.get(key) !== entry) return
    if (this.noClear) return
    await this._clearMedia(key, entry)
  }

  // Records what the irregular media clear needs from a tombstone just
  // learned, so _mediaGone never reads tombstones back from disk. A new
  // highest tombstone whose target is not a tombstone changes no earlier
  // one's effect and only adds its own ranges to the memo; any other
  // (learned out of order, or deleting a tombstone) rebuilds it.
  _noteTombstone (entry, seq, r) {
    if (Array.isArray(r.media) && r.media.length > 0) entry.tombMedia.set(seq, r.media)
    if (seq <= entry.tombMax || entry.tombstones.has(r.seq) || entry.tombNew.length >= TOMB_NEW_MAX) {
      entry.irrDirty = true
      entry.tombNew = []
    } else if (!entry.irrDirty) {
      entry.tombNew.push(seq)
    }
    entry.tombMax = Math.max(entry.tombMax, seq)
  }

  // The media blocks of core K that diary D deletes, or null while that is
  // not known: for a regular diary the blocks its counters say are listed
  // by an effective tombstone and shown by no survivor (once its scan
  // caught up); for an irregular one every block an effective tombstone of
  // the readers' fold lists, survivors or not (self-only: its media is
  // refused anyway), from the ranges kept when each tombstone was learned
  // (_noteTombstone), memoized per effective set and grown incrementally.
  // The returned sets are shared: callers only read them.
  async _mediaGone (key, entry, cores) {
    const out = new Map()
    if (entry.mediaIrregular) {
      const deleted = this._effectiveDeleted(entry)
      let memo = entry.irrMemo
      if (memo === null || entry.irrDirty) {
        memo = entry.irrMemo = { effective: deleted, sets: new Map() }
        entry.irrDirty = false
        entry.tombNew = []
      } else if (memo.effective !== deleted) {
        for (const seq of entry.tombNew) addTombRanges(memo.sets, entry.tombMedia.get(seq))
        entry.tombNew = []
        memo.effective = deleted
      }
      const missing = new Map()
      for (const k of cores) if (!memo.sets.has(k)) missing.set(k, new Set())
      if (missing.size > 0) {
        for (const [seq, media] of entry.tombMedia) {
          if (!deleted.has(seq)) addTombRanges(missing, media)
        }
        for (const [k, set] of missing) memo.sets.set(k, set)
      }
      for (const k of cores) out.set(k, memo.sets.get(k))
      return out
    }
    for (const k of cores) out.set(k, new Set())
    if (!scanCaughtUp(entry) || entry.mediaRecounting) return null
    for (const k of cores) {
      const state = entry.media.get(k)
      if (state === undefined || state.dead === 0) continue
      const set = out.get(k)
      for (const b of state.del.keys()) {
        if (!state.live.has(b)) set.add(b)
      }
    }
    return out
  }

  // Never a core bound to another diary: only the served cores whose
  // binding names this one.
  async _clearMedia (key, entry) {
    const cores = []
    for (const [k, m] of this._mediaServed) {
      const binding = this._media.get(k)
      if (!m.dropped && m.diary === key && binding && binding.diary === key) cores.push(k)
    }
    if (cores.length === 0) return
    // The irregular blocks depend only on the effective set (and the core):
    // a core already cleared for this set has nothing new to exclude.
    const effective = entry.mediaIrregular ? this._effectiveDeleted(entry) : null
    if (effective !== null && cores.every((k) => this._mediaServed.get(k).clearedFor === effective)) return
    const gone = await this._mediaGone(key, entry, cores)
    if (gone === null) return
    for (const k of cores) {
      const m = this._mediaServed.get(k)
      if (!m || m.dropped || m.diary !== key) continue
      if (effective !== null) {
        if (m.clearedFor === effective) continue
        m.clearedFor = effective
      }
      let changed = false
      for (const b of gone.get(k)) {
        if (b > 0 && !m.excluded.has(b)) {
          m.excluded.add(b)
          changed = true
        }
      }
      if (changed && m.download) {
        try {
          await m.download.update(m.excluded)
        } catch {}
      }
    }
  }

  // A bound core evicted from tracking (more than MEDIA_TRACK_MAX cores over
  // the diary's life) and declared again by an honest member would stay
  // refused for good: recount the media counters from block 1 with the
  // bound set pinned, so every bound core is tracked from its first
  // declaration. Same rules as the scan, media state only (indexes,
  // topics and notices are left alone), local reads only. It runs on the
  // scan queue at the end of a pass, so no scan of this diary moves
  // `scanned` meanwhile, and mediaRead stays closed until it ends. At most
  // MEDIA_TRACK_MAX recounts per serve; a failed read keeps the old
  // counters (the core stays refused).
  async _recountMedia (key, entry) {
    entry.mediaRecounts++
    entry.mediaRecounting = true
    try {
      const pinned = new Set(entry.latest.map((b) => b.key))
      const counts = { media: new Map(), mediaRefs: new Map(), mediaTombs: new Set(), mediaIrregular: false }
      const declared = new Set()
      const end = entry.scanned
      const stale = () => entry.dropped || this._closing || this._served.get(key) !== entry
      const read = async (i) => {
        try {
          return await entry.core.get(i, { wait: false, raw: true })
        } catch {
          return null
        }
      }
      for (let i = 1; i < end; i++) {
        const raw = await read(i)
        if (stale()) return
        // A block cleared or never fetched because a tombstone deletes it.
        if (raw === null && entry.gone.has(i)) continue
        if (raw === null) return
        const block = decodeBlock(raw)
        if (block === null) continue
        if (block.type === 'delete') {
          const r = validRecordCopy(block, i)
          if (r === null) continue
          if (tombstoneIrregular(declared, entry.tombstones, r)) counts.mediaIrregular = true
          const targetRaw = await read(r.seq)
          if (stale()) return
          const target = targetRaw === null ? null : decodeBlock(targetRaw)
          if (target !== null && (target.type === 'follow' || target.type === 'media-core')) continue
          countTombstone(counts, i, r, target)
        } else if (block.type === 'post' || block.type === 'profile') {
          countShown(counts, declared, i, validRecordCopy(block, i))
        } else if (block.type === 'media-core') {
          const record = validRecordCopy(block, i)
          if (record === null || record.key === key) continue
          countDeclaration(counts, declared, record.key, i, pinned)
          declared.add(record.key)
        }
      }
      entry.media = counts.media
      entry.mediaRefs = counts.mediaRefs
      entry.mediaTombs = counts.mediaTombs
      if (counts.mediaIrregular) entry.mediaIrregular = true
    } finally {
      entry.mediaRecounting = false
    }
  }

  // Pending until a pass commits; the read is retried a bounded number of
  // times, as growth alone may never re-queue the scan.
  _retryScan (key, entry) {
    this._notices.markPending(key)
    this._postNotices.markPending(key)
    if (entry.scanRetry === null && entry.scanRetries < SCAN_RETRIES_MAX) {
      entry.scanRetries++
      entry.scanRetry = setTimeout(() => {
        entry.scanRetry = null
        this._scanDiary(key, entry)
      }, SCAN_RETRY_MS)
      entry.scanRetry.unref()
    } else if (entry.scanRetry === null) {
      // Out of retries: the diary's first group scan gave up.
      this._groupStartupScanned(key)
    }
  }

  // A tombstone found by the scan (docs/protocol.md): its target leaves the
  // engagement, topic, name and post notice indexes, and the index cursors skip it from
  // now on. The scan walks upwards, so a later tombstone that deletes this
  // one takes back only its media ranges, never the index removal (self-only
  // residual: honest writers never tombstone a tombstone; postBlock follows
  // the readers' fold instead, see _effectiveDeleted). A follow or
  // media-core target is left alone: writers never emit one, and the
  // follow fold and media bindings do not apply deletions yet. Returns false
  // when the scan must retry this tombstone before moving past it. `media`
  // false (a tombstone above the scan cursor, _applyArrived) leaves the
  // media counters to the scan, which applies it again on reaching it.
  async _applyDelete (key, entry, seq, record, { media = true } = {}) {
    const target = record.seq
    let raw = null
    try {
      raw = await entry.core.get(target, { wait: false, raw: true })
    } catch {}
    if (entry.dropped || this._closing || this._served.get(key) !== entry) return true
    const block = raw === null ? null : decodeBlock(raw)
    if (block !== null && (block.type === 'follow' || block.type === 'media-core')) return true
    entry.deleted.add(target)
    if (media) countTombstone(entry, seq, record, block)
    this._index.removeRecord(key, target)
    this._topics.removePost(key, target)
    this._postNotices.removePost(key, target)
    // Removing a block a paused cursor never indexed (the refused one, or a
    // later one) frees nothing, so onFreed never fires: resume this diary's
    // pass so it skips the deleted seq instead of staying paused.
    if (entry.indexPaused && target >= entry.indexed) {
      entry.indexPaused = false
      this._indexDiary(key, entry)
    }
    if (entry.topicPaused && target >= entry.topicIndexed) {
      entry.topicPaused = false
      this._topicDiary(key, entry)
    }
    // The surviving profile is read BEFORE the name is forgotten: forget()
    // succeeds only once, so a failed read after it would leave the account
    // nameless for good while the scan reports complete. A failed read here
    // leaves the name alone and has the scan retry this tombstone.
    let copy = null
    if (block === null || block.type === 'profile') {
      const { profileSeq } = this._index.hints(key)
      if (profileSeq !== null && profileSeq !== target && !entry.deleted.has(profileSeq)) {
        let prev = null
        try {
          prev = await entry.core.get(profileSeq, { wait: false, raw: true })
        } catch {}
        if (entry.dropped || this._closing || this._served.get(key) !== entry) return true
        if (prev === null) return false
        const decoded = decodeBlock(prev)
        const c = decoded === null ? null : validRecordCopy(decoded, profileSeq)
        if (c !== null && c.type === 'profile' && !entry.deleted.has(profileSeq)) copy = { seq: profileSeq, record: c }
      }
    }
    if (!this._names.forget(key, target)) return true
    if (copy !== null) this._names.note(key, copy.seq, copy.record)
    return true
  }

  // Whether any block of [start, start + blocks) of core K is listed by an
  // effective tombstone of diary D and shown by no surviving post or
  // profile of D: O(blocks), whatever the number of tombstones or refs.
  // Per block, unlike lib/deletion.js deletedRanges, which keeps a whole
  // listed range once a survivor overlaps any of it: honest writers only
  // list ranges no survivor overlaps, so both agree for every honest diary,
  // and a hand-made range can only hide its own author's media.
  _mediaDeleted (state, start, blocks) {
    if (state.dead === 0) return false
    for (let b = start; b < start + blocks; b++) {
      if (state.del.has(b) && !state.live.has(b)) return true
    }
    return false
  }

  // The counters mediaRead may trust for core K of diary D, or null (fail
  // closed): D not served, dropped, irregular for media, recounting or its
  // scan not caught up yet, or K not tracked (never declared, or evicted at
  // MEDIA_TRACK_MAX).
  _mediaState (diaryHex, coreHex) {
    const entry = this._served.get(diaryHex)
    if (!entry || entry.dropped || entry.mediaIrregular || entry.mediaRecounting || !scanCaughtUp(entry)) return null
    return entry.media.get(coreHex) || null
  }

  // The seqs readers hide (lib/deletion.js): from the highest tombstone
  // down, one takes effect only if no effective tombstone deleted it. Unlike
  // `deleted`, a tombstone deleted by a later one gives its target back, so
  // moderation sees exactly what readers show. Cached until a tombstone is
  // added. Tombstones are learned out of order (stored ones at serve,
  // arrivals above the scan cursor), so the seqs are sorted first.
  _effectiveDeleted (entry) {
    if (entry.effective === null) {
      const out = new Set()
      const seqs = Array.from(entry.tombstones.keys()).sort((a, b) => a - b)
      for (let n = seqs.length - 1; n >= 0; n--) {
        if (!out.has(seqs[n])) out.add(entry.tombstones.get(seqs[n]))
      }
      entry.effective = out
    }
    return entry.effective
  }

  // Diary D's first group scan since start ended (or gave up, or D left):
  // once every diary served at start is through, the provisional roots are
  // judged like any root at runtime.
  _groupStartupScanned (key) {
    if (this._groupRootStartup === null) return
    this._groupRootStartup.delete(key)
    if (this._groupRootStartup.size > 0) return
    this._groupRootStartup = null
    this._dropUnsupportedRoots()
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
    return !(this._admitted.has(key) || this._dropping.has(key) || this._reserved.has(key) || this._chains.has(key) || this._isGroupKey(key))
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
    await served.prepared
    if (this._closing || served.dropped || this._mediaServed.get(key) !== served) return
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
      expected,
      // The blocks a tombstone of D deletes (cleared and left out of the
      // download; never shrinks) and the clear that runs before the
      // download starts.
      excluded: new Set(),
      prepared: null,
      // The effective set of D whose irregular media blocks are already in
      // `excluded` (_clearMedia).
      clearedFor: null
    }
    const checkQuota = () => {
      if (entry.dropped || this._closing) return
      if (this._overMediaQuota(core)) this._dropMedia(key, 'quota')
    }
    core.on('append', checkQuota)
    entry.stopQuota = () => core.off('append', checkQuota)
    entry.stopFork = watchFork(core, (reason) => this._dropMedia(key, reason))
    this._mediaServed.set(key, entry)
    checkQuota()
    if (entry.dropped) return
    entry.prepared = this._prepareMedia(key, entry).catch(noop)
  }

  // What D's stored tombstones delete (at serve) and, once D's scan caught
  // up, its counters, cleared before the first download range opens.
  async _prepareMedia (key, entry) {
    const core = entry.core
    const stale = () => entry.dropped || this._closing || this._mediaServed.get(key) !== entry
    const d = this._served.get(entry.diary)
    if (d && !d.dropped) {
      if (d.prepared) await d.prepared
      if (stale()) return
      for (const b of d.mediaStart.get(key) || []) entry.excluded.add(b)
      const gone = await this._mediaGone(entry.diary, d, [key])
      if (stale()) return
      if (gone !== null) for (const b of gone.get(key)) entry.excluded.add(b)
    }
    entry.excluded.delete(0)
    if (!this.noClear) {
      try {
        await clearDeleted(core, entry.excluded)
      } catch {}
    }
    if (stale()) return
    entry.download = this._downloader(core, entry.excluded)
    entry.stopGrow = watchContiguous(core, () => this._gateMedia(key, entry))
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

  // ---- Group cores (header comment) -------------------------------------

  _isGroupKey (key) {
    return this._groups.has(key) || this._groupsDropping.has(key) || this._groupReserved.has(key)
  }

  // One log line per (diary, key) and refusal: a join retried on every scan,
  // connection and blocklist adoption must not flood the log. A new join
  // (another seq) or another reason is logged again.
  _rejectGroup (key, diary, group, reason, seq = null) {
    const id = diary + ':' + key
    const what = reason + ':' + seq
    if (this._groupRefusals.get(id) === what) return
    this._groupRefusals.set(id, what)
    this.log({ event: 'group-rejected', key, diary, group, reason })
  }

  // 'timeout' and 'no-peers' are remembered per (diary, key): the next try
  // waits GROUP_BACKOFF_MS, longer after each failure in a row.
  // A 'timeout' wait arms one unref'd timer per (diary, key) that retries
  // the join when the wait ends, so a writer missed once is fetched again
  // without waiting for some unrelated peer's hello.
  _groupBackoffHit (diary, key, reason, group = null) {
    const id = diary + ':' + key
    const prev = this._groupBackoff.get(id)
    if (prev !== undefined && prev.timer) clearTimeout(prev.timer)
    const step = prev === undefined ? 0 : Math.min(prev.step + 1, GROUP_BACKOFF_MS.length - 1)
    const b = { reason, step, group, until: Date.now() + GROUP_BACKOFF_MS[step], timer: null }
    this._groupBackoff.set(id, b)
    if (reason !== 'timeout') return
    b.timer = setTimeout(() => {
      b.timer = null
      if (this._closing || this._groupBackoff.get(id) !== b) return
      // Timers may fire a moment before Date.now() reaches `until`: the
      // wait is over now, or the reconcile would skip the join for good.
      b.until = Math.min(b.until, Date.now())
      // A core whose drop (purge) outlasts the wait is skipped by the
      // reconcile while it is dropping: the retry waits for that drop, or
      // it is lost and a step-0 timeout keeps the group's answers
      // incomplete until some unrelated hello.
      const dropping = this._groupsDropping.has(key) ? this._drops.get(key) : undefined
      if (dropping !== undefined) {
        dropping.then(() => {
          if (this._closing || this._groupBackoff.get(id) !== b) return
          this._reconcileDiaries([diary])
        })
        return
      }
      this._reconcileDiaries([diary])
    }, GROUP_BACKOFF_MS[step])
    if (b.timer.unref) b.timer.unref()
  }

  _deleteGroupBackoff (id) {
    const b = this._groupBackoff.get(id)
    if (b === undefined) return
    if (b.timer) clearTimeout(b.timer)
    this._groupBackoff.delete(id)
  }

  // Live joins whose core is missing for a reason that must keep answers
  // about G from looking final: the seeder's own capacity ('group-full':
  // maxGroupCores, maxGroupWriters) or a first timeout not yet retried
  // (_groupJoinStale takes over after the retry). For group G (or any when
  // null) and diary D (or any).
  _groupFullFor (group, diary = null) {
    for (const [id, b] of this._groupBackoff) {
      if (b.group === null || !(b.reason === 'group-full' || (b.reason === 'timeout' && b.step === 0))) continue
      if (group !== null && b.group !== group) continue
      const d = id.slice(0, 64)
      if (diary !== null && d !== diary) continue
      const key = id.slice(65)
      if (this._groups.has(key)) continue
      const e = this._served.get(d)
      if (!e || e.dropped) continue
      const j = e.groupLive.get(key)
      if (j !== undefined && j.group === b.group && e.groupRefused.get(key) !== j.seq) return true
      if (key === b.group) {
        for (const lj of e.groupLive.values()) if (lj.group === key && e.groupRefused.get(key) !== lj.seq) return true
      }
    }
    return false
  }

  _groupBackingOff (diary, key) {
    const b = this._groupBackoff.get(diary + ':' + key)
    return b !== undefined && Date.now() < b.until
  }

  // Why a root naming diary D cannot be served: 'blocked' (D blocked),
  // 'revoked-issuer' (D was dropped or refused at start for a revoked
  // issuer and is not served again), or null.
  _creatorGone (diary) {
    if (this._isBlocked(diary)) return 'blocked'
    // Judged against the CURRENT list: lifting the revocation lifts this.
    // Only a diary's own block-0 verdict counts: an announce is signed by the
    // issuer alone, so a revoked issuer's key could name any diary.
    const issuer = this._revokedCreators.has(diary) ? this._revokedCreators.get(diary) : this._unrecordedRevoked.get(diary)
    if (issuer !== undefined && !this._served.has(diary) && this._issuerRevoked(issuer)) return 'revoked-issuer'
    return null
  }

  // Whether no group root may be admitted now: a denial map holds
  // ROOT_CREATORS_MAX denials still in force, or one denial found no room
  // at all. Fail closed: an evicted or unrecorded denial would let a purged
  // root come back through any member's join.
  _rootsClosed () {
    if (this._denialsLost) return true
    let n = 0
    if (this._revokedCreators.size >= ROOT_CREATORS_MAX) {
      for (const i of this._revokedCreators.values()) if (this._issuerRevoked(i)) n++
      if (n >= ROOT_CREATORS_MAX) return true
    }
    if (this._goneRoots.size < ROOT_CREATORS_MAX) return false
    n = 0
    for (const k of this._goneRoots.keys()) if (this._goneRootReason(k) !== null) n++
    return n >= ROOT_CREATORS_MAX
  }

  _denialNotKept (what) {
    if (!this._denialsLost) this.log({ event: 'warning', reason: 'denials-full', what })
    this._denialsLost = true
  }

  _issuerRevoked (issuer) {
    return issuer !== null && this._certOpts().revokedIssuers.has(issuer)
  }

  // Why root K must go: its header's diary bound it (`bound`, set while that
  // diary was served) and is now gone (_creatorGone). A root naming a diary
  // that never bound it only names it: blocking that diary leaves it to the
  // members that keep it (it has no creator).
  // The issuer kept with the binding counts too, so a creator that left
  // first for another reason (quota, its own drop) cannot escape a later
  // revocation of its issuer while a member keeps its root served.
  _rootGone (key) {
    const b = this._groups.get(key)
    if (!b || b.group !== key || b.bound !== true) return null
    const gone = this._creatorGone(b.diary)
    if (gone !== null) return gone
    if (typeof b.issuer === 'string' && !this._served.has(b.diary) && this._issuerRevoked(b.issuer)) {
      // Recorded like a revoked-issuer drop of the creator: the purged root
      // stays refused (goneRoots) whichever member's join names it.
      this._noteRevokedCreator(b.diary, { issuer: b.issuer })
      return 'revoked-issuer'
    }
    return null
  }

  // Why purged root K stays refused, from its own goneRoots entry alone (no
  // other map can have evicted the evidence): its creator is blocked, or the
  // issuer recorded at the purge is revoked under the CURRENT list while the
  // creator is not served again.
  _goneRootReason (key) {
    const e = this._goneRoots.get(key)
    if (e === undefined) return null
    if (this._isBlocked(e.creator)) return 'blocked'
    if (e.issuer !== null && !this._served.has(e.creator) && this._issuerRevoked(e.issuer)) return 'revoked-issuer'
    return null
  }

  // A purged root of a gone creator stays refused across restarts while the
  // creator stays gone, whichever member's join names it. The creator's
  // revoked issuer is kept whatever the purge reason, and a known issuer is
  // never replaced by none: a creator both blocked and revoked keeps its
  // roots out once only the block is lifted.
  _noteGoneRoot (key, creator, reason) {
    let issuer = this._revokedCreators.get(creator) || this._unrecordedRevoked.get(creator) || null
    const prev = this._goneRoots.get(key)
    if (issuer === null && prev !== undefined && prev.creator === creator) issuer = prev.issuer
    if (!bounded(this._goneRoots, key, { creator, issuer }, (k) => this._goneRootReason(k) === null)) this._denialNotKept('goneRoots')
    this._persist().catch(noop)
  }

  // A moderation outcome: diary D, served or listed, was dropped or refused
  // because its certificate's issuer is revoked. `cert` is the block-0
  // certificate the verdict judged (v2 names its issuer); without an issuer
  // nothing is kept. Nothing is
  // written when the pair is already known.
  _noteRevokedCreator (diary, cert) {
    const issuer = issuerOf(cert)
    if (issuer === null) return
    // Roots already purged for this creator under another reason (a block
    // judged first) take the issuer too, so the denial outlives the block.
    let backfilled = false
    for (const e of this._goneRoots.values()) {
      if (e.creator !== diary || e.issuer !== null) continue
      e.issuer = issuer
      backfilled = true
    }
    if (this._revokedCreators.get(diary) === issuer) {
      if (backfilled) this._persist().catch(noop)
      return
    }
    if (!bounded(this._revokedCreators, diary, issuer, (d, i) => !this._issuerRevoked(i))) {
      // Its bound roots are still purged now (_creatorGone reads this).
      if (this._unrecordedRevoked.size < ROOT_DENIALS_HARD) this._unrecordedRevoked.set(diary, issuer)
      this._denialNotKept('revokedCreators')
    }
    this._persist().catch(noop)
  }

  // D was admitted with a certificate that verifies under the current list
  // (a new certificate, or the revocation lifted): whatever was remembered
  // about a revoked issuer of D no longer holds.
  _forgetRevoked (diary) {
    if (!this._revokedCreators) return
    this._unrecordedRevoked.delete(diary)
    let changed = this._revokedCreators.delete(diary)
    for (const [k, e] of [...this._goneRoots]) {
      if (e.creator !== diary || e.issuer === null) continue
      this._goneRoots.delete(k)
      changed = true
    }
    if (changed) this._persist().catch(noop)
  }

  // A diary gone forgets its admission memory (bounded by its join set).
  _forgetGroupAttempts (diary) {
    const prefix = diary + ':'
    if (this._groupBackoff) {
      for (const id of [...this._groupBackoff.keys()]) if (id.startsWith(prefix)) this._deleteGroupBackoff(id)
    }
    for (const map of [this._groupRefusals]) {
      if (!map) continue
      for (const id of [...map.keys()]) if (id.startsWith(prefix)) map.delete(id)
    }
    if (this._groupDeferred) this._groupDeferred.delete(diary)
  }

  // Group cores charged to a diary, bound or being admitted: its writers in
  // group G (`inGroup`), the roots its joins admitted (`roots`, by the
  // binding's `by`, never the header's diary, which anyone may name) and
  // both together (`total`). Charges stay after the join is withdrawn, so
  // admitting and withdrawing in a loop cannot fill the seeder's group cores.
  _diaryGroupCores (diary, group) {
    let inGroup = 0
    let roots = 0
    let total = 0
    for (const [k, b] of this._groups) {
      if (b === null) continue
      if (k === b.group) {
        if (b.by !== diary) continue
        roots++
      } else {
        if (b.diary !== diary) continue
        if (b.group === group) inGroup++
      }
      total++
    }
    for (const [k, d] of this._groupReservedBy) {
      const g = this._groupReserved.get(k)
      if (d !== diary || g === undefined || this._groups.has(k)) continue
      if (k === g) roots++
      else if (g === group) inGroup++
      total++
    }
    return { inGroup, roots, total }
  }

  // In-flight group admissions started by a diary.
  _diaryGroupInflight (diary) {
    let n = 0
    for (const d of this._groupReservedBy.values()) if (d === diary) n++
    return n
  }

  // Whether the diary a root's header names bound the root: served,
  // unblocked and with an on:true group-join for writer G in its own diary
  // (any ever, the fold's binding rule). Anyone may name any diary in a
  // header, so only then does that diary support the root or show as its
  // creator. The creator's scan indexes the root as its writer exactly then
  // (_reconcileGroups), and its drop removes that row.
  _rootBound (group, creator) {
    const e = this._served.get(creator)
    if (!e || e.dropped || this._isBlocked(creator)) return false
    const row = this._groupIndex.writer(group)
    return row !== null && row.group === group && row.diary === creator
  }

  // The index rows of the served roots diary D bound, as [root, row].
  _boundRootRows (diary) {
    const out = []
    if (!this._groups) return out
    for (const [k, b] of this._groups) {
      if (b === null || k !== b.group || b.diary !== diary || b.bound !== true || !this._groupServed.has(k)) continue
      const row = this._groupIndex.writer(k)
      if (row !== null && row.group === k && row.diary === diary) out.push([k, row])
    }
    return out
  }

  // A root its creator bound stays listed under that creator, from its
  // binding, while members keep it served after the creator's diary is gone
  // here (quota, capacity, a restart without it): without the row the
  // account service's check of a report on a root post answers 'nao-membro'
  // and both block options are refused. A blocked or revoked creator's
  // bound root is purged instead (_dropUnsupportedRoots), and the root's own
  // drop removes the row.
  _indexKeptRoot (key, left) {
    const b = this._groups.get(key)
    if (!b || b.group !== key || b.bound !== true || !this._groupServed.has(key)) return
    if (this._served.has(b.diary) || this._isBlocked(b.diary)) return
    if (this._groupIndex.writer(key) !== null) return
    if (this._groupIndex.addWriter(key, key, b.diary, b.seq)) this._groupIndex.setLeft(key, left === true)
  }

  // Whether row (diary, key) is a root kept for a creator gone here
  // (_indexKeptRoot): listed although that diary is not visible.
  _keptRootRow (diary, key) {
    const b = this._groups.get(key)
    return !!b && b.group === key && b.bound === true && b.diary === diary &&
      !this._served.has(diary) && !this._isBlocked(diary)
  }

  // Cores bound or being admitted for a group (the root counts: it is the
  // creator's writer). An admission is listed in _groups from persist on
  // while still reserved: each key counts once, or a valid writer would be
  // refused as group-full before the cap is reached.
  _groupCoreCount (group) {
    let n = 0
    for (const b of this._groups.values()) if (b !== null && b.group === group) n++
    for (const [k, g] of this._groupReserved) {
      if (g !== group) continue
      const b = this._groups.get(k)
      if (b === undefined || b === null || b.group !== group) n++
    }
    return n
  }

  // Group cores served or being admitted, each key once.
  _groupCoresInUse () {
    let n = this._groupServed.size
    for (const k of this._groupReserved.keys()) if (!this._groupServed.has(k)) n++
    return n
  }

  // Brings the group cores of a diary in line with its scan: index rows for
  // the cores bound to it (left once no live join names them; leaving never
  // drops a core) and admissions for live joins not yet bound, the writer
  // itself and the group root.
  _reconcileGroups (diary, entry) {
    if (entry.dropped || !entry.gated || this._closing) return
    for (const [k, b] of this._groups) {
      if (b === null || b.diary !== diary || !this._groupServed.has(k)) continue
      const live = entry.groupLive.get(k)
      const bound = live !== undefined && live.group === b.group
      let seq = bound ? live.seq : b.seq
      if (k === b.group) {
        // A root's row must point at a join in its creator's own diary: the
        // binding may have been persisted with the seq of the member join
        // that admitted it. Binding is any on:true join ever (lib/group.js),
        // so the creator's newest on:true join for G is used even after an
        // on:false; with none, the root is no writer of that diary and is
        // not listed.
        const own = entry.groupBound.get(k)
        if (own === undefined || own.group !== k) continue
        seq = own.seq
        // Kept for when this diary is gone: only a root it bound is its
        // content (_rootGone).
        if (b.bound !== true) {
          b.bound = true
          this._persist().catch(noop)
        }
        // Its block-0 issuer stays with the binding: a revocation adopted
        // after this diary left still purges the root (_rootGone).
        const issuer = issuerOf(entry.cert0)
        if (issuer !== null && b.issuer !== issuer) {
          b.issuer = issuer
          this._persist().catch(noop)
        }
      }
      if (seq !== b.seq) {
        b.seq = seq
        this._persist().catch(noop)
      }
      this._groupIndex.addWriter(b.group, k, diary, b.seq)
      this._groupIndex.setLeft(k, !bound)
    }
    if (this._isBlocked(diary)) return
    for (const [writer, j] of entry.groupLive) {
      const keys = writer === j.group ? [writer] : [writer, j.group]
      for (const k of keys) {
        if (this._groups.has(k) || this._groupsDropping.has(k)) continue
        if (this._inflight.has(k) || this._groupReserved.has(k)) continue
        const refused = entry.groupRefused.get(k)
        if (refused !== undefined && refused === j.seq) continue
        if (this._groupBackingOff(diary, k)) continue
        this._admitGroup(diary, entry, k, j.group, j.seq).catch(noop)
      }
    }
  }

  _retryGroups (peer) {
    if (peer) {
      if (!peer.socket || peer.seederDropped) return
      for (const fetch of this._groupFetches.values()) fetch.addSocket(peer.socket)
      // A new socket is what a 'no-peers' refusal lacked. Only those
      // diaries reconcile: a connection must not re-run every diary's joins.
      // Expired 'timeout' waits wait for the peer's hello
      // (_retryGroupTimeouts).
      const diaries = new Set()
      for (const [id, b] of [...this._groupBackoff]) {
        if (b.reason !== 'no-peers') continue
        this._deleteGroupBackoff(id)
        diaries.add(id.slice(0, 64))
      }
      this._reconcileDiaries(diaries)
      return
    }
    for (const [key, entry] of this._served) {
      if (entry.gated && entry.groupLive.size > 0) this._reconcileGroups(key, entry)
    }
  }

  // A helloed peer may hold a core whose fetch timed out: each expired
  // 'timeout' wait is retried at most once per wait from a connection, so
  // peers connecting in a loop cannot restart fetches of unservable cores.
  _retryGroupTimeouts () {
    if (this._closing) return
    const diaries = new Set()
    const now = Date.now()
    for (const [id, b] of this._groupBackoff) {
      if (b.reason !== 'timeout' || now < b.until || b.retried) continue
      b.retried = true
      diaries.add(id.slice(0, 64))
    }
    this._reconcileDiaries(diaries)
  }

  _reconcileDiaries (diaries) {
    for (const d of diaries) {
      const e = this._served.get(d)
      if (e && e.gated && !e.dropped) this._reconcileGroups(d, e)
    }
  }

  // A join whose core timed out again on its retry past the first wait is
  // still retried, but no longer holds group answers back: a core nobody
  // serves would otherwise keep every page of its group incomplete. A
  // writer missed once stays pending until that retry; 'group-full' never
  // goes stale (the seeder's own capacity is the reason: _groupFullFor).
  _groupJoinStale (diary, key) {
    const b = this._groupBackoff.get(diary + ':' + key)
    return b !== undefined && b.reason === 'timeout' && b.step >= 1
  }

  // A core in admission that still holds group answers back.
  _groupReservedCounts (key) {
    const d = this._groupReservedBy.get(key)
    return d === undefined || !this._groupJoinStale(d, key)
  }

  // Whether admitting group core K (the root when K === G) for diary D
  // still makes sense after an await: D served, gated and unblocked, G not
  // blocked, the list not held, D still joining (a writer: a live join
  // naming K for G; the root: any live join for G), and K no diary or media.
  _groupStillWanted (diary, entry, key, group) {
    if (entry.dropped || !entry.gated || this._served.get(diary) !== entry) return false
    if (this._isBlocked(diary) || this._isBlocked(group) || this._blocklistHeld) return false
    if (key === group) {
      let joined = false
      for (const j of entry.groupLive.values()) if (j.group === group) joined = true
      if (!joined) return false
    } else {
      const j = entry.groupLive.get(key)
      if (!j || j.group !== group) return false
    }
    return !(this._admitted.has(key) || this._dropping.has(key) || this._reserved.has(key) || this._chains.has(key) ||
      this._media.has(key) || this._mediaDropping.has(key) || this._mediaReserved.has(key))
  }

  // Admission of group core K for D's join, the media steps: synchronous
  // checks and slot, quarantine gate on every peer socket, persist BEFORE
  // open, late checks, serve and join.
  async _admitGroup (diary, entry, key, group, seq) {
    if (this._closing) return
    if (this._isBlocked(group)) return this._rejectGroup(key, diary, group, 'group-blocked', seq)
    // A root already fetched once and naming a still blocked diary is
    // refused without fetching it again; blocklist adoption forgets these.
    if (key === group && this._goneRootReason(key) !== null) return this._rejectGroup(key, diary, group, this._goneRootReason(key), seq)
    if (key === group && this._rootsClosed()) {
      if (this._groupRefusals.get(diary + ':' + key) !== 'denials-full:' + seq) this.log({ event: 'warning', key, reason: 'denials-full' })
      return this._rejectGroup(key, diary, group, 'denials-full', seq)
    }
    if (this._blocklistHeld) return this._rejectGroup(key, diary, group, 'blocklist-pending', seq)
    if (!this._groupStillWanted(diary, entry, key, group)) {
      this._deleteGroupBackoff(diary + ':' + key)
      return
    }
    if (this._groupCoresInUse() >= this.maxGroupCores || this._groupCoreCount(group) >= this.maxGroupWriters) {
      this._groupBackoffHit(diary, key, 'group-full', group)
      return this._rejectGroup(key, diary, group, 'group-full', seq)
    }
    // liveGroupJoins already keeps one diary's live joins under the caps;
    // this also counts the cores it left (still bound and served).
    const held = this._diaryGroupCores(diary, group)
    if (held.total >= MAX_GROUP_CORES_PER_DIARY ||
      (key === group ? held.roots >= MAX_GROUPS_PER_DIARY : held.inGroup >= MAX_GROUP_WRITERS_PER_DIARY)) {
      return this._rejectGroup(key, diary, group, 'group-full', seq)
    }
    // Bounded fan-out: scans, connections and blocklist adoptions may ask
    // for every live join at once. Past either limit the join waits; the
    // end of an admission re-runs the waiting diaries (_groupDeferred).
    if (this._groupReserved.size >= this.maxGroupInflight || this._diaryGroupInflight(diary) >= GROUP_INFLIGHT_PER_DIARY) {
      this._groupDeferred.add(diary)
      return
    }
    const sockets = this._peerSockets()
    if (sockets.length === 0) {
      this._groupBackoffHit(diary, key, 'no-peers')
      return this._rejectGroup(key, diary, group, 'no-peers', seq)
    }
    this._groupReserved.set(key, group)
    this._groupReservedBy.set(key, diary)
    // An attempt that sets no new wait of its own ended for good (admitted,
    // refused by its header or size, no longer wanted): an older wait must
    // not keep group answers incomplete for a join already judged.
    const waitBefore = this._groupBackoff.get(diary + ':' + key)
    const work = this._admitGroupReserved(diary, entry, key, group, seq, sockets)
    this._inflight.set(key, work)
    try {
      return await work
    } finally {
      this._groupReserved.delete(key)
      this._groupReservedBy.delete(key)
      this._pruneGroupHeader(group)
      // A core admitted for this join and still awaiting its header in the
      // main store keeps the wait (_gateGroup clears it): a header withheld
      // after every quarantine pass must still advance the wait, or the
      // group's pages never stop waiting for it.
      const awaiting = this._groupServed.get(key)
      const kept = awaiting !== undefined && !awaiting.dropped && !awaiting.headerOk && awaiting.by === diary
      if (!kept && waitBefore !== undefined && this._groupBackoff.get(diary + ':' + key) === waitBefore) this._deleteGroupBackoff(diary + ':' + key)
      if (this._inflight.get(key) === work) this._inflight.delete(key)
      this._resumeDeferredGroups()
    }
  }

  // A slot freed: waiting diaries take turns, oldest first (_groupDeferred
  // is a FIFO in insertion order). Each reconciles once; one that still has
  // joins waiting re-queues itself at the tail (_admitGroup), so a few
  // diaries whose joins name unservable cores cannot keep every slot from a
  // later diary. Stops when the slots are full or each waiting diary had
  // its turn.
  _resumeDeferredGroups () {
    if (this._closing) return
    let turns = this._groupDeferred.size
    while (turns-- > 0 && this._groupReserved.size < this.maxGroupInflight) {
      const d = this._groupDeferred.values().next().value
      this._groupDeferred.delete(d)
      const e = this._served.get(d)
      if (e && e.gated && !e.dropped) this._reconcileGroups(d, e)
    }
  }

  // Whether a diary waiting for an admission slot has a live join for G
  // whose cores are not bound yet.
  // `group` null: any group. Joins whose cores went stale (_groupJoinStale)
  // do not count.
  _groupDeferredFor (group) {
    for (const d of this._groupDeferred) {
      if (this._groupDiaryWaiting(d, group)) return true
    }
    return false
  }

  // Whether diary D has a live join (for G, or any when G is null) with a
  // core neither bound nor stale.
  _groupDiaryWaiting (diary, group) {
    const e = this._served.get(diary)
    if (!e || e.dropped) return false
    for (const [writer, j] of e.groupLive) {
      if (group !== null && j.group !== group) continue
      for (const k of writer === j.group ? [writer] : [writer, j.group]) {
        if (!this._groups.has(k) && !this._groupJoinStale(diary, k)) return true
      }
    }
    return false
  }

  async _admitGroupReserved (diary, entry, key, group, seq, sockets) {
    while (this._drops.has(key)) await this._drops.get(key)
    if (this._closing || !this._groupStillWanted(diary, entry, key, group)) return
    let res
    try {
      const fetch = startQuarantineFetch(this.qstore, key, sockets, GATE_TIMEOUT_MS)
      this._groupFetches.set(key, fetch)
      try {
        res = await fetch.promise
      } finally {
        if (this._groupFetches.get(key) === fetch) this._groupFetches.delete(key)
      }
    } catch {
      if (!this._closing) this._fatal(key)
      return
    }
    if (this._closing) return
    if (res.error) {
      this._groupBackoffHit(diary, key, 'timeout', group)
      return this._rejectGroup(key, diary, group, 'timeout', seq)
    }
    if (!this._groupStillWanted(diary, entry, key, group)) return
    const verdict = groupVerdict(res.raw, key, group, key === group ? null : diary)
    if (verdict !== null) {
      entry.groupRefused.set(key, seq)
      return this._rejectGroup(key, diary, group, verdict, seq)
    }
    // Verified here: a root refused or purged from now on still shows its
    // kind on /index/group while members' writers stay served.
    if (key === group) this._keepGroupHeader(group, decodeBlock(res.raw))
    // Refusals after a fetch are remembered (this join) or backed off, so a
    // rescan does not fetch the same core again.
    if (this._overQuota(res)) {
      entry.groupRefused.set(key, seq)
      return this._rejectGroup(key, diary, group, 'quota', seq)
    }
    if (this._groupServed.size >= this.maxGroupCores) {
      this._groupBackoffHit(diary, key, 'group-full', group)
      return this._rejectGroup(key, diary, group, 'group-full', seq)
    }

    // A root is listed under its creator (the diary its header names).
    const header = decodeBlock(res.raw)
    const owner = key === group ? header.diary : diary
    // A root naming a blocked or revoked diary is that diary's content
    // (_dropUnsupportedRoots). Backed off rather than remembered: unlike
    // block 0 and its size, a block or a revocation can be lifted, and
    // blocklist adoption clears these waits (backoff reason 'blocked').
    if (key === group && (this._goneRootReason(key) || this._creatorGone(owner)) !== null) {
      const gone = this._goneRootReason(key) || this._creatorGone(owner)
      this._groupBackoffHit(diary, key, 'blocked')
      return this._rejectGroup(key, diary, group, gone, seq)
    }
    // Until the creator's scan rewrites it (_reconcileGroups), a root
    // admitted through a member's join carries that join's seq only as a
    // placeholder: it is never indexed for the creator.
    let ownSeq = seq
    if (owner !== diary) {
      const ownerEntry = this._served.get(owner)
      const own = ownerEntry ? ownerEntry.groupBound.get(key) : undefined
      if (own !== undefined && own.group === key) ownSeq = own.seq
    }
    // A root is charged to the diary whose join admitted it (`by`), never to
    // the diary its header names unless that diary's own join did it.
    // A root purged for its creator and admitted again once the denial was
    // lifted keeps `bound` from that purge, so blocking or revoking the
    // creator again purges it even before the creator is served.
    const wasGone = key === group ? this._goneRoots.get(key) : undefined
    const rootBinding = { diary: owner, group, seq: ownSeq, by: diary }
    if (wasGone !== undefined && wasGone.creator === owner) {
      rootBinding.bound = true
      if (wasGone.issuer !== null) rootBinding.issuer = wasGone.issuer
    }
    this._groups.set(key, key === group ? rootBinding : { diary: owner, group, seq: ownSeq })
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
      this._groups.delete(key)
      await this._persist().catch(noop)
      if (this._closing) return
      return this._rejectGroup(key, diary, group, 'admission-failed', seq)
    }
    if (this._closing) return
    let late = null
    if (this._isBlocked(group)) late = 'group-blocked'
    else if (this._isBlocked(diary)) late = 'blocked'
    else if (key === group && (this._goneRootReason(key) || this._creatorGone(owner)) !== null) late = this._goneRootReason(key) || this._creatorGone(owner)
    else if (key === group && this._rootsClosed()) late = 'denials-full'
    else if (!this._groupStillWanted(diary, entry, key, group)) late = 'unbound'
    else if (core.fork !== 0) late = 'fork'
    else if (this._overQuota(core)) late = 'quota'
    if (late !== null) {
      await core.close().catch(noop)
      try {
        if (await this._stored(key)) await this._purge(key)
      } catch {
        if (!this._closing) this._fatal(key)
        return
      }
      this._groups.delete(key)
      await this._persist().catch(noop)
      if (this._closing) return
      return this._rejectGroup(key, diary, group, late, seq)
    }
    // The (diary, key) backoff stays until the header verifies in the main
    // store (_gateGroup): a core whose block 0 is then withheld keeps
    // growing its wait instead of starting over at every admission.
    this._groupRefusals.delete(diary + ':' + key)
    this._serveGroup(key, { diary: owner, group }, core, { expected: res.raw, by: diary })
    const served = this._groupServed.get(key)
    if (!served || served.dropped) return
    this.swarm.join(core.discoveryKey, { server: true, client: true })
    if (key === group) this._groupIndex.setHeader(group, header)
    // Another diary's join may have admitted it (a root through a member's
    // join) while the owner's scan skipped it as in flight: index it from
    // the owner's scan now, never only when the owner admitted it.
    const ownerEntry = this._served.get(owner)
    if (ownerEntry && !ownerEntry.dropped && ownerEntry.gated) this._reconcileGroups(owner, ownerEntry)
    this.log({ event: 'group-admitted', key, diary: owner, group, length: core.contiguousLength })
    // Its denial was lifted: the root is served again and `bound` came back
    // with it (set above), so the entry is no longer needed.
    if (key === group && this._goneRoots.delete(key)) this._persist().catch(noop)
  }

  // Serving a group core: live download, fork watcher, the log quota on
  // every append, no growth broadcast. `expected` and `headerOk` as for
  // media (_serveMedia): a fresh admission is re-gated once block 0 is local.
  _serveGroup (key, { diary, group }, core, { expected = null, headerOk = false, by = diary } = {}) {
    const entry = {
      core,
      diary,
      group,
      by,
      headerTimer: null,
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
      if (this._overQuota(core)) this._dropGroup(key, 'quota')
    }
    core.on('append', checkQuota)
    entry.stopQuota = () => core.off('append', checkQuota)
    entry.stopFork = watchFork(core, (reason) => this._dropGroup(key, reason))
    entry.download = core.download({ start: 0, end: -1 })
    entry.stopGrow = watchContiguous(core, () => this._gateGroup(key, entry))
    this._groupServed.set(key, entry)
    checkQuota()
    if (entry.dropped) return
    // A peer that served block 0 to the quarantine and then withholds it
    // from the main store must not keep the group's answers incomplete
    // forever: past the gate timeout the core goes and its join backs off.
    if (!entry.headerOk) {
      entry.headerTimer = setTimeout(() => {
        entry.headerTimer = null
        if (entry.dropped || entry.headerOk || entry.gating || this._closing || this._groupServed.get(key) !== entry) return
        this._dropGroup(key, 'timeout')
        this._groupBackoffHit(entry.by, key, 'timeout', group)
      }, this.groupHeaderTimeoutMs)
      if (entry.headerTimer.unref) entry.headerTimer.unref()
    }
    if (!entry.headerOk && core.contiguousLength >= 1) this._gateGroup(key, entry)
  }

  // Local re-gate of a served group core, the twin of _gateMedia: block 0
  // in the main store must be byte-identical to the quarantined one (else
  // 'fork') and a header naming the same keys.
  _gateGroup (key, entry) {
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
      return groupVerdict(raw, key, entry.group, entry.diary)
    }
    check().then(async (reason) => {
      if (this.regateHook) await this.regateHook(key, reason)
      entry.gating = false
      if (entry.dropped || this._closing || this._groupServed.get(key) !== entry) return
      if (reason !== null) return this._dropGroup(key, reason)
      entry.headerOk = true
      entry.expected = null
      clearTimeout(entry.headerTimer)
      entry.headerTimer = null
      this._deleteGroupBackoff(entry.by + ':' + key)
    }, () => {
      entry.gating = false
      if (!entry.dropped && !this._closing) this._dropGroup(key, 'header-invalid')
    })
  }

  // Runtime drop of a group core (R6.1 order, as _dropMedia).
  _dropGroup (key, reason) {
    const entry = this._groupServed.get(key)
    if (!entry || entry.dropped || this._closing) return
    entry.dropped = true
    this._groupServed.delete(key)
    // A core judged before its header verified (fork, quota, blocked) ends
    // its join's wait, as a refusal during admission does; only the header
    // deadline grows it (the timer's _groupBackoffHit reads it).
    if (!entry.headerOk && reason !== 'timeout') this._deleteGroupBackoff(entry.by + ':' + key)
    this._pruneGroupHeader(entry.group)
    const binding = this._groups.get(key)
    this._groups.delete(key)
    this._groupsDropping.set(key, binding)
    this._stopEntry(entry)
    this._groupIndex.removeWriter(key)
    if (key === entry.group) this._groupIndex.setHeader(key, null)
    if (this.swarm) {
      try {
        this.swarm.leave(entry.core.discoveryKey).catch(noop)
      } catch {}
    }
    this.log({ event: 'group-rejected', key, diary: entry.diary, group: entry.group, reason })
    const inflight = this._inflight.get(key) || null
    const drop = (async () => {
      if (inflight) await inflight.catch(noop)
      try {
        await this._purge(key)
      } catch {
        if (!this._closing) this._fatal(key)
        return
      }
      this._groupsDropping.delete(key)
      await this._persist()
    })()
    const tracked = drop.catch(noop).then(() => {
      if (this._drops.get(key) === tracked) this._drops.delete(key)
    })
    this._drops.set(key, tracked)
  }

  // Whether a core of G is served or being admitted.
  _groupHasCore (group) {
    for (const e of this._groupServed.values()) if (e.group === group && !e.dropped) return true
    for (const g of this._groupReserved.values()) if (g === group) return true
    return false
  }

  // Keeps the header fields of root G (verified through the quarantine or
  // in the main store). Bounded: a record lives only while a core of G is
  // served or being admitted, so stale ones go first; past the bound the
  // record is not kept and G's pages stay incomplete (indexGroup).
  _keepGroupHeader (group, header) {
    if (this._isBlocked(group) || header === null) return
    const rec = headerRecord(header)
    const prev = this._groupHeaders.get(group)
    if (prev !== undefined && prev.kind === rec.kind && prev.visibility === rec.visibility && prev.join === rec.join && prev.name === rec.name) return
    const max = this.maxGroupCores + this.maxGroupInflight
    if (prev === undefined && this._groupHeaders.size >= max) {
      for (const k of [...this._groupHeaders.keys()]) this._pruneGroupHeader(k)
      if (this._groupHeaders.size >= max) return
    }
    this._groupHeaders.set(group, rec)
    this._persist().catch(noop)
  }

  // A blocked group, or one with no core left here, loses its record.
  _pruneGroupHeader (group) {
    if (!this._groupHeaders.has(group)) return
    if (!this._isBlocked(group) && this._groupHasCore(group)) return
    this._groupHeaders.delete(group)
    this._persist().catch(noop)
  }

  // A root stays while at least one served, unblocked diary still keeps the
  // group: its creator if it bound the root (_rootBound), a diary with a
  // bound writer in it, or a live join.
  _groupSupported (group) {
    const live = (d) => {
      const e = this._served.get(d)
      return !!e && !e.dropped && !this._isBlocked(d)
    }
    for (const [k, b] of this._groups) {
      if (b === null || b.group !== group) continue
      if (k === group ? this._rootBound(group, b.diary) : live(b.diary)) return true
    }
    for (const [d, e] of this._served) {
      if (!live(d)) continue
      for (const j of e.groupLive.values()) if (j.group === group) return true
    }
    return false
  }

  // Blocking a group's creator, or revoking the issuer of its certificate,
  // removes the group root at seeders when that diary bound the root (the
  // `bound` bit recorded while it was served): the root's posts and
  // authority records are then the creator's content. A root whose header
  // only names the diary has no creator and stays while members keep it.
  // The purged root stays refused, across restarts, while the creator stays
  // gone (_goneRoots). Members' writers stay under the usual rules.
  _dropUnsupportedRoots () {
    for (const [k, g] of [...this._groupServed]) {
      if (k !== g.group) continue
      const gone = this._rootGone(k)
      if (gone === null) continue
      this._noteGoneRoot(k, g.diary, gone)
      this._dropGroup(k, gone)
    }
    if (this._groupRootStartup !== null) return
    for (const [k, g] of [...this._groupServed]) {
      if (k === g.group && !this._groupSupported(k)) this._dropGroup(k, 'unbound')
    }
  }

  // Blocks start..start+blocks-1 of media core K bound to diary D, for the
  // HTTP route: null unless the binding exists, D is admitted and not
  // blocked, D's scan has caught up and tracks K (_mediaState), no block of
  // the range is deleted, start >= 1, the range is within K's signed length
  // and EVERY block is local. `bytes` is the exact total (summed from a first local
  // read, since hypercore exposes no per-block sizes), `blocks` yields each
  // block with { wait: false }: nothing here ever waits on the network, and
  // a block gone meanwhile (K purged, cleared or closed mid-stream) makes next()
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
      // A tombstone can be applied during any await below: check again after
      // each one, so no byte of a range deleted meanwhile leaves (an early
      // end of the stream makes the route destroy the response).
      // A diary falling behind (it grew, or was re-served) also counts as
      // deleted, so a stream stops while its scan catches up. Recomputed
      // only when K's counters changed, so a long range does not cost
      // O(blocks) per streamed block.
      let seen = null
      let seenVer = -1
      let seenAnswer = false
      const deleted = () => {
        const state = this._mediaState(diaryHex, coreHex)
        if (state === null) return true
        if (state === seen && state.ver === seenVer) return seenAnswer
        seen = state
        seenVer = state.ver
        seenAnswer = this._mediaDeleted(state, start, blocks)
        return seenAnswer
      }
      if (deleted()) return null
      const end = start + blocks
      let bytes = 0
      for (let i = start; i < end; i++) {
        if (!(await core.has(i))) return null
        const raw = await core.get(i, { wait: false, raw: true })
        if (raw === null || deleted()) return null
        bytes += raw.byteLength
      }
      const read = async function * () {
        for (let i = start; i < end; i++) {
          if (deleted()) return
          const raw = await core.get(i, { wait: false, raw: true })
          // A block cleared because its range was deleted ends the stream
          // like any deletion; any other missing block is an error.
          if (deleted()) return
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
  // engagement index. null unless D is admitted, not blocked, served,
  // gated, not dropped and its scan caught up (a tombstone not yet read may
  // delete seq), seq is not deleted, its core is on fork 0,
  // 1 <= seq < length and BOTH blocks are already local ({ wait: false }).
  // Every await may interleave
  // with a drop, a re-gate, a close or a new blocklist snapshot, so after
  // each one the same conditions (plus an unchanged _moderationGen) are
  // checked again; any change answers null. Trust boundary: these are the
  // raw bytes this seeder's own Hypercore verified on arrival, not a
  // portable proof; the caller trusts this process plus its authenticated
  // loopback for authenticity and re-validates only the record's shape.
  // The group-post at block <seq> of served group core <writer> (a member's
  // writer or the root), for the account service's check of a group report
  // (seed-ws.js, /moderation-group-post/): { group, diary, seq, texto,
  // resposta } read from local blocks only, block 0 re-checked as the header
  // the binding names and block <seq> validated as a group-post. null for
  // anything else: not served, header not checked yet, the group or the
  // diary blocked, a block not local, another record type, or a change
  // while it read. The text is the author's signed record, not a quote.
  async groupPostBlock (writerHex, seq) {
    try {
      if (typeof writerHex !== 'string' || !HEX64.test(writerHex)) return null
      if (!Number.isSafeInteger(seq) || seq < 1) return null
      const entry = this._groupServed.get(writerHex)
      const gen = this._moderationGen
      const live = () => !this._closing && this._groupServed.get(writerHex) === entry &&
        entry.headerOk && !entry.dropped && !this._isBlocked(entry.group) &&
        !this._isBlocked(entry.diary) && this._moderationGen === gen
      if (!entry || !live()) return null
      const core = entry.core
      if (core.fork !== 0 || seq >= core.length) return null
      const read = async (i) => {
        if (!(await core.has(i)) || !live()) return null
        const raw = await core.get(i, { wait: false, raw: true })
        return raw && live() ? raw : null
      }
      const block0 = await read(0)
      if (block0 === null || groupVerdict(block0, writerHex, entry.group, entry.diary) !== null) return null
      const raw = await read(seq)
      if (raw === null) return null
      const record = decodeBlock(raw)
      if (record === null || record.type !== 'group-post') return null
      if (validateGroupRecord(record, seq, { root: writerHex === entry.group }) !== null) return null
      if (!live() || core.fork !== 0) return null
      const reply = record.replyTo
      return {
        group: entry.group,
        diary: entry.diary,
        seq,
        texto: record.text,
        resposta: reply ? { writer: reply.writer, seq: reply.seq } : null
      }
    } catch {
      return null
    }
  }

  async postBlock (diaryHex, seq) {
    try {
      if (typeof diaryHex !== 'string' || !HEX64.test(diaryHex)) return null
      if (!Number.isSafeInteger(seq) || seq < 1) return null
      const entry = this._served.get(diaryHex)
      const gen = this._moderationGen
      const live = () => !this._closing && this._served.get(diaryHex) === entry &&
        entry.gated && !entry.dropped && scanCaughtUp(entry) && this._admitted.has(diaryHex) &&
        !this._isBlocked(diaryHex) && this._moderationGen === gen
      if (!entry || !live()) return null
      const core = entry.core
      // Besides scanCaughtUp: never answer for a block the scan has not read.
      if (core.fork !== 0 || seq >= core.length || seq >= entry.scanned) return null
      if (this._effectiveDeleted(entry).has(seq)) return null
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
      if (!live() || core.fork !== 0 || seq >= core.length || seq >= entry.scanned || this._effectiveDeleted(entry).has(seq)) return null
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
      // The scans are not rerun: their tombstones must still hold incoming
      // likes, reposts, replies and quotes out of the fresh index.
      for (const [key, entry] of this._served) {
        for (const seq of entry.deleted || []) this._index.removeRecord(key, seq)
      }
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

  // Reads from the index cursor to the present length (a hole below it is
  // a block a tombstone deletes, skipped): each block is
  // decoded once, copied and validated (validRecordCopy) and, when it is one
  // of INDEX_TYPES, handed to the index. A refused add (cap reached) leaves
  // the cursor AT that block and pauses the diary: nothing is ever skipped.
  async _runIndex (key, entry) {
    const core = entry.core
    try {
      while (!entry.dropped && !this._closing && entry.gated && this._served.get(key) === entry && entry.indexed < entry.present) {
        const i = entry.indexed
        let raw
        try {
          raw = await core.get(i, { wait: false, raw: true })
        } catch {
          this._retryIndex(key, entry)
          return
        }
        if (entry.dropped || this._closing || this._served.get(key) !== entry) return
        if (raw === null && !entry.gone?.has(i) && !(await deletedHole(core, i))) {
          this._retryIndex(key, entry)
          return
        }
        const block = raw === null || entry.deleted?.has(i) ? null : decodeBlock(raw)
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
      if (this._indexStartup !== null && (entry.indexPaused || entry.indexReadFailures >= 4 || entry.indexed >= entry.present)) {
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

  // The post notice index: same member predicate as the follow index and the
  // same @nome verification as the name index (revocation is applied per
  // page by issuerUsable).
  _createPostNoticeIndex () {
    return createPostNoticeIndex({
      isMember: (k) => this._admitted.has(k) || this._served.has(k),
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
  // while no served diary's cursor is paused or behind its contiguous length,
  // its scan included (a tombstone not yet scanned may delete a listed post).
  _indexFlags () {
    const indexing = !this._ready || this._indexRebuildQueued || this._indexStartup === null || this._indexStartup.size > 0
    let complete = !indexing && !this._closing
    if (complete) {
      for (const entry of this._served.values()) {
        if (!entry.gated || entry.dropped) continue
        if (entry.indexPaused || entry.indexed < entry.present || entry.scanned < entry.present) {
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
      while (!entry.dropped && !this._closing && entry.gated && this._served.get(key) === entry && entry.topicIndexed < entry.present) {
        const i = entry.topicIndexed
        let raw
        try {
          raw = await core.get(i, { wait: false, raw: true })
        } catch {
          this._retryTopic(key, entry)
          return
        }
        if (entry.dropped || this._closing || this._served.get(key) !== entry) return
        if (raw === null && !entry.gone?.has(i) && !(await deletedHole(core, i))) {
          this._retryTopic(key, entry)
          return
        }
        const block = raw === null || entry.deleted?.has(i) ? null : decodeBlock(raw)
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
      if (this._topicStartup !== null && (entry.topicPaused || entry.topicReadFailures >= 4 || entry.topicIndexed >= entry.present)) {
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

  // ---- Web Push (onPush) -----------------------------------------------

  // Queues a push pass over a gated diary on the push queue (one diary at a
  // time, at most one queued per diary). Nothing runs without onPush.
  _pushDiary (key, entry) {
    if (!this.onPush) return
    if (entry.dropped || !entry.gated || this._closing || this._served.get(key) !== entry) return
    if (entry.pushQueued || entry.pushRetry) return
    entry.pushQueued = true
    const run = () => this._runPush(key, entry)
    this._pushQueue = this._pushQueue.then(run, run).catch(noop)
  }

  // Reads from the push cursor to the present length (a hole below it is a
  // deleted block, passed without a push). A failed read of
  // the diary's own block keeps the cursor there and retries; every block
  // read is then passed exactly once, emitted or not (at-most-once: a push
  // is a hint, the in-app notices stay the record).
  async _runPush (key, entry) {
    const core = entry.core
    const live = () => !entry.dropped && !this._closing && entry.gated && this._served.get(key) === entry
    try {
      while (live() && entry.pushNext < entry.present) {
        const i = entry.pushNext
        let raw
        try {
          raw = await core.get(i, { wait: false, raw: true })
        } catch {
          raw = null
        }
        if (!live()) return
        if (raw === null && !entry.gone.has(i) && !(await deletedHole(core, i))) {
          this._retryPush(key, entry)
          return
        }
        entry.pushReadFailures = 0
        const block = raw === null ? null : decodeBlock(raw)
        const record = block && validRecordCopy(block, i)
        const c = record && pushCandidate({
          author: key,
          seq: i,
          record,
          now: Date.now(),
          isMember: (k) => this._admitted.has(k) || this._served.has(k),
          isBlocked: (k) => this._isBlocked(k)
        })
        if (c) {
          const exists = c.kind === 'follow' || await this._pushTargetIsPost(c.recipient, record.type === 'post' ? record.replyTo.seq : record.to.seq)
          if (!live()) return
          const name = exists ? await this._pushActorName(key, entry) : null
          if (!live()) return
          // The recipient may have been dropped or blocked, or the actor
          // blocked, while the reads above were pending: decide again on the
          // current state. The cursor still advances (at-most-once).
          const r = c.recipient
          const eligible = (this._admitted.has(r) || this._served.has(r)) && !this._isBlocked(r) && !this._isBlocked(key)
          if (exists && eligible && this.onPush !== null) {
            try {
              this.onPush({ v: 1, kind: c.kind, actor: key, recipient: c.recipient, seq: i, ref: c.ref, name })
            } catch {}
          }
        }
        entry.pushNext = i + 1
      }
    } finally {
      entry.pushQueued = false
    }
  }

  // The engagement index only checks a reference's shape and keeps targets
  // that do not exist: read the target from the recipient's own replica,
  // without waiting, and accept only a valid post there.
  async _pushTargetIsPost (recipient, seq) {
    const re = this._served.get(recipient)
    if (!re || re.dropped || !re.gated || seq >= re.present) return false
    let raw
    try {
      raw = await re.core.get(seq, { wait: false, raw: true })
    } catch {
      return false
    }
    if (raw === null || this._closing || re.dropped || !re.gated || this._served.get(recipient) !== re) return false
    const block = decodeBlock(raw)
    const record = block && validRecordCopy(block, seq)
    return !!record && record.type === 'post'
  }

  // The actor's sanitized profile name (never bio or post text), from the
  // newest profile block the index has seen, or null when it is not held.
  async _pushActorName (key, entry) {
    const ps = this._index.hints(key).profileSeq
    if (!Number.isSafeInteger(ps) || ps < 1 || ps >= entry.present) return null
    let raw
    try {
      raw = await entry.core.get(ps, { wait: false, raw: true })
    } catch {
      return null
    }
    if (raw === null) return null
    const block = decodeBlock(raw)
    const record = block && validRecordCopy(block, ps)
    return record && record.type === 'profile' ? pushName(record.name) : null
  }

  // As _retryIndex: one timer per served diary, backoff 2/10/30/60 s.
  _retryPush (key, entry) {
    if (entry.pushRetry || entry.dropped || this._closing || this._served.get(key) !== entry) return
    entry.pushReadFailures = Math.min(entry.pushReadFailures + 1, 4)
    const delay = [2000, 10000, 30000, 60000][entry.pushReadFailures - 1]
    entry.pushRetry = setTimeout(() => {
      entry.pushRetry = null
      this._pushDiary(key, entry)
    }, delay)
    entry.pushRetry.unref()
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
        if (entry.topicPaused || entry.topicIndexed < entry.present || entry.scanned < entry.present) {
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

  // The likers / reposters page of apps/cli/lib/seed-ws.js: who currently
  // likes or reposts a post, newest first by each engager's own `at`, with a hint
  // per listed engager; null for anything unknown (a kind other than likes
  // or reposts, an author not visible, a post not indexed, a malformed
  // cursor). As in indexTopic, an engager whose re-gate is pending
  // (_searchHeld) is left out and the answer says complete false; a held
  // target author answers null. `total` counts every engager currently on.
  indexEngagers (kind, authorHex, seq, cursor = null) {
    try {
      if (kind !== 'likes' && kind !== 'reposts') return null
      if (!this._indexVisible(authorHex) || !Number.isSafeInteger(seq) || seq < 1) return null
      let held = false
      const visible = (hex) => {
        if (!this._indexVisible(hex)) return false
        if (this._searchHeld(hex)) {
          held = true
          return false
        }
        return true
      }
      const page = this._index.engagers(authorHex + ':' + seq, kind, cursor, visible, Date.now())
      if (page === null) return null
      const flags = this._indexFlags()
      return { ref: page.ref, kind: page.kind, items: page.items, next: page.next, total: page.total, authors: page.authors, indexing: flags.indexing, complete: flags.complete && !held }
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
      return { length: entry.present, ...page, ...this._indexFlags() }
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

  // ---- Group index answers (header comment) ----------------------------

  // A group core an answer may name: served, its header gated, not dropped.
  _groupCoreVisible (key) {
    const e = this._groupServed.get(key)
    return !!e && e.headerOk && !e.dropped
  }

  // The present length (lib/deletion.js): a cleared deleted block is a hole
  // the scan already went past, so contiguousLength alone would read as a
  // gap forever. Never below contiguousLength.
  _scanTop (entry) {
    return Math.max(entry.present || 0, entry.core.contiguousLength)
  }

  // Whether a diary's join scan reached its signed length. The scan stops
  // at the present length while the signed length advances before the blocks
  // arrive, and a join beyond the local prefix is not seen yet (the notices
  // fold commits only at core.length for the same reason).
  _groupScanBehind (entry) {
    return !entry.gated || entry.scanQueued || entry.scanned < this._scanTop(entry) || entry.scanned < entry.core.length
  }

  // Whether a diary's scan holds answers about OTHER diaries' groups
  // incomplete. A member can sign a length and withhold the blocks forever,
  // or release them one at a time just faster than any progress-based
  // bound, or close and reopen the gap over and over, and its scan can only
  // hide its own joins (joins live in the joining diary). So each diary has
  // a budget of groupScanStallMs of time spent caught up with its local
  // prefix while the signed length is ahead (a gap open), summed over every
  // gap within GROUP_STALL_WINDOW_MS: blocks trickling in and gaps closing
  // never refill it. Once spent, the diary stops counting until the window
  // passes. Counting only for groups the diary already joined is unsafe: a
  // join hidden in the gap can name any group.
  // The budget is kept per diary key, not on the served entry, so a diary
  // cannot refill it by getting dropped (a fork) and announcing again.
  // Monotonic clock: a wall-clock step must not end the wait early.
  _groupScanCounts (key, entry) {
    const now = clock.now()
    let s = this._groupStalls.get(key) || null
    if (s !== null && s.out !== null) {
      if (now - s.out < GROUP_STALL_WINDOW_MS) return false
      this._groupStalls.delete(key)
      s = null
    }
    if (s !== null && now - s.from >= GROUP_STALL_WINDOW_MS) {
      s.spent = 0
      s.from = now
      if (s.since !== null) s.since = now
    }
    const behind = this._groupScanBehind(entry)
    const contiguous = this._scanTop(entry)
    // A replica still waiting for its block 0 (a re-gate) spends the budget
    // too: its block 0 can be withheld, and the scan cannot start without it.
    const stalled = behind && (!entry.gated || (contiguous < entry.core.length && !entry.scanQueued && entry.scanned >= contiguous))
    if (s !== null && s.since !== null && !stalled) {
      s.spent += now - s.since
      s.since = null
    }
    if (!behind) return false
    if (!stalled) return true
    if (s === null) s = this._newGroupStall(key, now)
    else if (s.since === null) s.since = now
    if (s.spent + now - s.since < this.groupScanStallMs) return true
    s.out = now
    s.since = null
    return false
  }

  // Budgets of keys no longer stalling within the window go first; past
  // 2 * maxServed entries the oldest of a diary not served goes, so keys
  // announced and dropped in a loop cannot grow the map, and a served
  // diary's budget is never the one evicted.
  _newGroupStall (key, now) {
    const max = 2 * this.maxServed
    if (this._groupStalls.size >= max) {
      for (const [k, s] of [...this._groupStalls]) {
        const done = s.out !== null ? now - s.out >= GROUP_STALL_WINDOW_MS : s.since === null && now - s.from >= GROUP_STALL_WINDOW_MS
        if (done) this._groupStalls.delete(k)
      }
    }
    if (this._groupStalls.size >= max) {
      for (const k of this._groupStalls.keys()) {
        if (this._served.has(k)) continue
        this._groupStalls.delete(k)
        break
      }
    }
    const s = { from: now, since: now, spent: 0, out: null }
    this._groupStalls.set(key, s)
    return s
  }

  // A served group core whose local header check still holds answers back:
  // once its header deadline expired on a retry past the first wait
  // (_groupJoinStale), a core whose block 0 is withheld no longer does.
  _groupHeaderPending (key, e) {
    return !e.dropped && !e.headerOk && !this._groupJoinStale(e.by, key)
  }

  // Group core K is being admitted or still waits for its local header
  // check (answers hide it until then).
  _groupCorePending (key) {
    if (this._groupReserved.has(key)) return true
    const e = this._groupServed.get(key)
    return !!e && !e.dropped && !e.headerOk
  }

  // Any group answer may still miss something: a diary scan is behind, a
  // group core is being admitted or waits for an admission slot, or a served
  // one awaits its header check.
  _groupsUnsettled () {
    if (!this._ready || this._closing) return true
    for (const k of this._groupReserved.keys()) if (this._groupReservedCounts(k)) return true
    if (this._groupDeferredFor(null) || this._groupFullFor(null)) return true
    for (const [k, e] of this._groupServed) if (this._groupHeaderPending(k, e)) return true
    for (const [key, entry] of this._served) {
      if (!entry.dropped && this._groupScanCounts(key, entry)) return true
    }
    return false
  }

  // Pages of a group stay incomplete while any diary scan is behind
  // (_groupScanCounts), a core
  // of that group is being admitted or waits for an admission slot
  // (_groupDeferredFor), or a served core of it still waits for
  // its local header check (pages hide it until then).
  _groupIncomplete (group) {
    if (!this._ready || this._closing) return true
    for (const [k, g] of this._groupReserved) if (g === group && this._groupReservedCounts(k)) return true
    if (this._groupDeferredFor(group) || this._groupFullFor(group)) return true
    for (const [k, e] of this._groupServed) {
      if (e.group === group && this._groupHeaderPending(k, e)) return true
    }
    for (const [key, entry] of this._served) {
      if (entry.dropped) continue
      if (this._groupScanCounts(key, entry)) return true
    }
    return false
  }

  _groupPage (group, after, limit) {
    if (typeof group !== 'string' || !HEX64.test(group) || this._isBlocked(group)) return null
    return this._groupIndex.page(group, after, limit, {
      visible: (diary, key) => (this._indexVisible(diary) || this._keptRootRow(diary, key)) && this._groupCoreVisible(key),
      lengthOf: (key) => this._groupServed.get(key).core.contiguousLength,
      // A writer's withheld block must not hold its group's pages
      // incomplete forever: the signed length is reported, never awaited.
      signedOf: (key) => this._groupServed.get(key).core.length
    })
  }

  // The 'varanda/groups/1' answer (groups-net.js page): writers of a group
  // whose diary is visible and whose core is served, in key order. A
  // blocked root answers an empty, final page.
  groupWriters ({ group, after = null, limit } = {}) {
    try {
      if (this._isBlocked(group)) return { items: [], next: null, incomplete: false }
      const page = this._groupPage(group, after, limit)
      if (page === null) return { items: [], next: null, incomplete: true }
      const items = page.items.map(({ key, diary, length, signed, seq }) => ({ key, diary, length, signed, seq }))
      return { items, next: page.next, incomplete: this._groupIncomplete(group) }
    } catch {
      return { items: [], next: null, incomplete: true }
    }
  }

  // GET /index/group/<G>[/<after>]: the root header fields the seeder holds
  // (`name` null for a private root), `rootServed` whether the root core
  // itself is served, and a page of writers, each with `left`; null for a
  // malformed or blocked group. Hints only. A root this seeder verified
  // keeps its header fields while writers of G stay served after the root
  // was purged or refused (_groupHeaders): the account service needs `kind`
  // to confirm a report against the group. With no header at all while a
  // writer of G is served the page is never complete.
  indexGroup (group, after = null) {
    try {
      const page = this._groupPage(group, after, 64)
      if (page === null) return null
      const rootServed = this._groupCoreVisible(group)
      let header = rootServed ? this._groupIndex.header(group) : null
      // No creator unless the header's diary bound the root (_rootBound).
      if (header !== null && !this._rootBound(group, header.diary)) header.diary = null
      let writerServed = false
      for (const [k, e] of this._groupServed) {
        if (k !== group && e.group === group && this._groupCoreVisible(k)) {
          writerServed = true
          break
        }
      }
      if (header === null && writerServed && this._groupHeaders.has(group)) header = { ...this._groupHeaders.get(group), diary: null }
      const incomplete = this._groupIncomplete(group) || (header === null && writerServed)
      return { header, rootServed, writers: page.items, next: page.next, indexing: !this._ready, complete: !incomplete }
    } catch {
      return null
    }
  }

  // GET /index/groups/<D>: the groups a visible diary writes to, one row per
  // group naming its newest live writer (`left` once every join of D in
  // that group is off), at most MAX_GROUPS_PER_DIARY rows; null when not
  // visible.
  indexGroups (diaryHex) {
    try {
      if (!this._indexVisible(diaryHex)) return null
      const groups = this._groupIndex.groupsOf(diaryHex, (group, writer) => !this._isBlocked(group) && this._groupCoreVisible(writer))
      const entry = this._served.get(diaryHex)
      let complete = this._ready && !this._closing && !this._groupScanBehind(entry)
      // A live join whose writer is in admission or awaits its header check
      // is left out of `groups` above: not complete yet.
      for (const writer of entry.groupLive.keys()) {
        if (this._groupCorePending(writer) && !this._groupJoinStale(diaryHex, writer)) complete = false
      }
      if (this._groupDeferred.has(diaryHex) && this._groupDiaryWaiting(diaryHex, null)) complete = false
      if (this._groupFullFor(null, diaryHex)) complete = false
      return { groups, indexing: !this._ready, complete }
    } catch {
      return null
    }
  }

  // GET /index/group-search/<segment>: public groups whose header name
  // matches, each with that name as the root header wrote it (peer text,
  // rendered by the client through displayText), served roots only, never a
  // blocked one; null for a malformed segment. Nothing about the query is
  // logged.
  indexGroupSearch (segment) {
    try {
      const visible = (group) => !this._isBlocked(group) && this._groupCoreVisible(group)
      const page = this._groupIndex.search(segment, visible)
      if (page === null) return null
      return { groups: page.groups, more: page.more, indexing: !this._ready, complete: !this._groupsUnsettled() }
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

  // A peer's replication request opens a stored core (corestore
  // _attachMaybe, private API of the exactly pinned corestore; a test fails
  // if it disappears). That open waits for a purge's close but not for its
  // storage delete, and a delete committing mid-open throws inside the
  // protocol stream, outside any handler: the process would exit. So a
  // request for a key under purge is not attached (the peer asking after
  // the delete finds no core, as before), and a purge first lets the opens
  // already in flight for its key settle.
  _guardReplication () {
    const store = this.store
    const attach = store._attachMaybe
    if (typeof attach !== 'function') throw new Error('corestore sem _attachMaybe: proteção da limpeza indisponível')
    store._attachMaybe = (muxer, dk) => {
      const id = b4a.toString(dk, 'hex')
      if (this._purgingKeys.has(id)) return Promise.resolve()
      const p = attach.call(store, muxer, dk)
      let inflight = this._attaching.get(id)
      if (!inflight) this._attaching.set(id, inflight = new Set())
      inflight.add(p)
      const settled = () => {
        inflight.delete(p)
        if (inflight.size === 0 && this._attaching.get(id) === inflight) this._attaching.delete(id)
      }
      p.then(settled, settled)
      return p
    }
  }

  async _purge (key) {
    const id = b4a.toString(crypto.discoveryKey(b4a.from(key, 'hex')), 'hex')
    this._purgingKeys.set(id, (this._purgingKeys.get(id) || 0) + 1)
    try {
      const inflight = this._attaching.get(id)
      if (inflight) await Promise.allSettled([...inflight])
      if (!this.purgeHook) return await purgeReplica(this.store, key)
      const core = this.store.get({ key: b4a.from(key, 'hex') })
      await core.ready()
      try {
        await this.purgeHook(core)
      } catch (err) {
        await core.close().catch(noop)
        throw err
      }
    } finally {
      const n = this._purgingKeys.get(id) - 1
      if (n === 0) this._purgingKeys.delete(id)
      else this._purgingKeys.set(id, n)
    }
  }

  // ONE serialized writer: admitted.json = admitted ∪ dropping, media =
  // media ∪ mediaDropping and groups = groups ∪ groupsDropping (same file,
  // same write).
  _persist () {
    const write = () => {
      const admitted = {}
      for (const [key, cert] of this._admitted) admitted[key] = cert
      for (const [key, cert] of this._dropping) admitted[key] = cert
      const media = {}
      for (const [key, binding] of this._media) media[key] = binding
      for (const [key, binding] of this._mediaDropping) media[key] = binding
      const groups = {}
      for (const [key, binding] of this._groups) groups[key] = binding
      for (const [key, binding] of this._groupsDropping) groups[key] = binding
      writeJsonAtomic(path.join(this.dataDir, ADMITTED_FILE), admittedFile(admitted, media, groups, { revokedCreators: this._revokedCreators, goneRoots: this._goneRoots, groupHeaders: this._groupHeaders }))
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
    // The group map too: this loop alone walks only diaries. A root key in
    // the snapshot takes the root and every writer of its group.
    for (const [k, g] of [...this._groupServed]) {
      if (this._isBlocked(g.group)) this._dropGroup(k, 'group-blocked')
      else if (k !== g.group && this._isBlocked(g.diary)) this._dropGroup(k, 'blocked')
    }
    for (const k of [...this._groupHeaders.keys()]) this._pruneGroupHeader(k)
    this._dropUnsupportedRoots()
    // Joins held while the list was lost may be admitted now, and so may
    // roots refused for naming a diary the new list no longer blocks.
    for (const [id, b] of [...this._groupBackoff]) if (b.reason === 'blocked') this._deleteGroupBackoff(id)
    this._retryGroups(null)
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
      const judged = {}
      localVerdict(entry.core, key, this.association, this._certOpts(), judged).then((reason) => {
        if (reason === null) entry.searchHold--
        if (reason === null || entry.dropped || this._closing) return
        if (this._served.get(key) === entry) this._drop(key, reason, judged.cert)
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
    // One close listener releases every channel handle of this connection:
    // one per channel would pass the emitter's default listener limit.
    const release = []
    socket.once('close', () => {
      for (const fn of release) fn()
    })
    release.push(() => this._blocklistHandles.delete(handle))
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
    release.push(() => this._noticeHandles.delete(notices))
    // Post notices merged with follows, under the same rules as v1. A
    // revoked issuer's names stop matching at once, as in indexSearch.
    let noticesV2 = null
    try {
      noticesV2 = attachNoticesV2(socket, {
        role: 'seeder',
        page: ({ target, after, limit }) => {
          if (this._isBlocked(target)) return { items: [], next: null, incomplete: false }
          const isBlocked = (k) => this._isBlocked(k)
          const f = this._notices.rowsFor(target, isBlocked)
          const opts = this._certOpts()
          const revoked = opts && opts.revokedIssuers instanceof Set ? opts.revokedIssuers : new Set()
          const result = this._postNotices.pageV2({
            target,
            followRows: f.rows,
            followIncomplete: f.incomplete,
            isBlocked,
            issuerUsable: (i) => !revoked.has(i),
            after,
            limit,
            now: Date.now()
          })
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
    this._noticeHandles.add(noticesV2)
    release.push(() => this._noticeHandles.delete(noticesV2))
    // Groups channel: writer pages from the group index, before the hello
    // like the notices channel (groups-net.js).
    let groups = null
    try {
      groups = attachGroups(socket, {
        role: 'seeder',
        page: (q) => this.groupWriters(q),
        log: (ev) => this.log(ev)
      })
    } catch {
      socket.destroy()
      return
    }
    this._groupHandles.add(groups)
    release.push(() => this._groupHandles.delete(groups))
    const have = []
    for (const [key, entry] of this._served) {
      // Never more than a valid hello carries (defence in depth, M1).
      if (have.length >= MAX_INVENTORY) break
      have.push({ key, length: entry.gated ? entry.present : 0 })
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
    this._retryGroups(peer)
    // hello resolves null when the peer leaves first: never block on it.
    Promise.resolve(peer.hello).then((hello) => {
      if (!hello || this._closing || !this._peers.has(peer)) return
      this.log({ event: 'peer', role: peer.remoteRole, peerKey: peer.peerKey })
      this._retryGroupTimeouts()
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
      this._postNotices = createPostNoticeIndex()
      for (const entry of this._mediaServed.values()) this._stopEntry(entry)
      this._mediaServed.clear()
      for (const entry of this._groupServed.values()) this._stopEntry(entry)
      this._groupServed.clear()
      this._groupIndex.clear()
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
      for (const handle of this._groupHandles) {
        try { handle.close() } catch {}
      }
      this._groupHandles.clear()
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
