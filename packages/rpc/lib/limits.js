'use strict'

const { utf8ByteLength, clipText } = require('./text')

const PROTOCOL = 1
const MAX_ID = 2147483647
const MAX_REQUEST = 65536 // bytes of one serialized request (UTF-8)
const MAX_MESSAGE = 262144 // bytes of one serialized response or event
const MAX_PENDING = 8 // requests in flight per connection
const MAX_OUTBOUND = 1048576 // bytes a server may queue to one client
const MAX_LIST = 100 // capped result lists (future, skipped, ...)
const MAX_LINE = 512 // code points of one event line or SyncResult string
const MAX_TOKEN_TEXT = 64 // code points of a key or reason inside a SyncResult
const MAX_TOKEN = 256
const MAX_CERT_BYTES = 4096
const DEFAULT_TIMEOUT_MS = 30000

// Same values as packages/core/lib/records.js (not imported: zero deps).
const MAX_NAME = 80
const MAX_BIO = 280
const MAX_TEXT = 1000
const MAX_TESTIMONIAL = 400
const MAX_SCRAP = 400
// Rich profile (profile-about and mood records), same values as records.js.
const MAX_ABOUT = 600
const MAX_CITY = 60
const MAX_WORK = 80
const MAX_STUDIES = 80
const MAX_INTERESTS = 200
const MAX_MOOD_TEXT = 60
// Melhores amigos (top-friends record), same value as records.js.
const MAX_TOP_FRIENDS = 8
const TESTIMONIAL_PENDING_MAX = 64
// Testimonial decisions synced in the member's seen document: kept and
// declined each keep their newest entries (packages/core/lib/seen-blob.js).
const TESTIMONIAL_KEPT_MAX = 64
const TESTIMONIAL_DECLINED_MAX = 64
const MEDIA_BLOCK_BYTES = 32768
const MAX_MEDIA_BLOCKS = 8192
const MAX_MEDIA_PER_POST = 10
const MAX_MEDIA_ITEM_BLOCKS = 256
const MEDIA_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
const MAX_MEDIA_DIMENSION = 16384
// Profile avatar, same values as records.js.
const AVATAR_SIDE = 512
const MAX_AVATAR_BLOCKS = 8
const MAX_AVATAR_BYTES = 262144
const AVATAR_MIMES = Object.freeze(['image/jpeg', 'image/webp'])
// Public post cover, same values as records.js.
const MAX_SHARE_COVER_SIDE = 1200
const MAX_SHARE_COVER_BLOCKS = 8
const MAX_SHARE_COVER_BYTES = 262144
// Short videos, same values as records.js: a post's [JPEG poster, video]
// pair and a momento video (its blob bytes add the DM_MEDIA_MAC_BYTES MAC).
const VIDEO_MIME = 'video/mp4'
const MAX_VIDEO_MS = 30000
const MAX_VIDEO_DIMENSION = 1920
const MAX_VIDEO_PIXELS = 2073600
const MAX_MOMENT_VIDEO_MS = 15000
const MAX_MOMENT_VIDEO_BYTES = 4194304
// Momentos the member has seen, synced in the seen document: the newest
// entries stay (packages/core/lib/seen-blob.js). moments.read answers at most
// 32 x 4 + 4 live items, and every one fits.
const MOMENT_SEEN_MAX = 132
// DM media items: blob descriptors of packages/core/lib/blob.js
// (BLOB_CHUNK_BYTES, BLOB_MAX_CHUNKS, BLOB_MAC_BYTES; not imported: zero deps)
// plus mime, w, h and ms (docs/protocol.md section 11).
const MAX_DM_MEDIA = 4
// Group posts keep four media items: the sealed record budget of
// packages/core/lib/group-media.js was measured for four.
const MAX_GROUP_MEDIA = 4
// Kept locally because RPC cannot import core's private image limits.
const PRIVATE_GROUP_IMAGE_SIDE = 512
const MAX_PRIVATE_GROUP_IMAGE_BLOCKS = 9
const MAX_PRIVATE_GROUP_IMAGE_BYTES = 262144
const DM_MEDIA_CHUNK_BYTES = 32768
const DM_MEDIA_MAX_CHUNKS = 257
const DM_MEDIA_MAC_BYTES = 16

const LOG_LIMIT_DEFAULT = 20
// Page maxima: the largest pages whose worst case fits MAX_MESSAGE
// (docs/rpc.md section 2, test/sizes.test.js). A post's worst item is its
// MAX_MEDIA_PER_POST media descriptors, which outweigh a maximal link card.
const LOG_LIMIT_MAX = 30
// Every FeedItem carries the widest avatar (235 bytes), which 26 maximal items
// no longer leave room for.
const FEED_LIMIT_DEFAULT = 25
const FEED_LIMIT_MAX = 25
// Keep the incomplete list bounded beside maximal media lists and the other
// feed metadata (docs/rpc.md section 2, test/sizes.test.js).
const FEED_INCOMPLETE_MAX = 16
// A PeekItem adds round to the avatar every FeedItem carries and omits the
// feed metadata lists, so 26 still fit (docs/rpc.md section 2, test/sizes.test.js).
const PEEK_LIMIT_DEFAULT = 26
const PEEK_LIMIT_MAX = 26
// Notices per page: the worst case fits MAX_MESSAGE (test/sizes.test.js).
const NOTICES_LIMIT_DEFAULT = 30
const NOTICES_LIMIT_MAX = 64
// Authors per profile.read: its worst case fits MAX_MESSAGE with room to
// spare (docs/rpc.md section 2, test/sizes.test.js).
const PROFILE_LIMIT_MAX = 100
const ENGAGEMENT_LIMIT_MAX = 62
const PEEK_SEQS_MAX = 29
// The largest page whose worst case includes a maximal private link card
// and GROUP_REACTIONS_MAX maximal reaction summaries per post and still fits
// MAX_MESSAGE (docs/rpc.md section 2, test/sizes.test.js).
const GROUP_LIMIT_DEFAULT = 26
const GROUP_LIMIT_MAX = 26
const GROUP_MEMBERS_LIMIT_MAX = 100
// Distinct emojis folded per group message (group-react, docs/protocol.md
// section 10); a group.read item carries at most this many summaries.
const GROUP_REACTIONS_MAX = 12
// Diary keys per emoji in the who-reacted answer: the largest list whose
// worst case (GROUP_REACTIONS_MAX emojis, each with this many keys) fits
// MAX_MESSAGE (test/sizes.test.js).
const GROUP_REACTORS_MAX = 324
// Polls (docs/protocol.md): a diary post's `poll` and a group topic's
// `group-poll` carry POLL_MIN..POLL_MAX options of 1..MAX_POLL_OPTION code
// points; a pick is 0..POLL_MAX - 1 or null.
const POLL_MIN = 2
const POLL_MAX = 4
const MAX_POLL_OPTION = 60
// group.read with `marks` or `topic` adds a topic marker to every item (and
// a topic's poll summary to the page), so it caps the page below
// GROUP_LIMIT_MAX; the unmarked page keeps its bytes (test/sizes.test.js).
const GROUP_MARKED_LIMIT = 24
// group.topics: maximal root texts and poll summaries fit MAX_MESSAGE with
// one item to spare (test/sizes.test.js).
const GROUP_TOPICS_LIMIT = 30
// Diary keys per option in the who-voted answer of a group poll: every
// option with this many keys fits MAX_MESSAGE with room (test/sizes.test.js).
const GROUP_VOTERS_MAX = 900
// Eventos (docs/protocol.md): a diary post's `event` and a group's
// `group-event` carry a title of 1..MAX_EVENT_TITLE and a place of
// 0..MAX_EVENT_PLACE code points, a start and an end (null or later than the
// start) as canonical ISO instants in UTC between EVENT_MIN_MS and
// EVENT_MAX_MS (2020-01-01 and 2100-01-01), at most EVENT_MAX_SPAN_MS apart.
const MAX_EVENT_TITLE = 80
const MAX_EVENT_PLACE = 120
const EVENT_MIN_MS = Date.UTC(2020, 0, 1)
const EVENT_MAX_MS = Date.UTC(2100, 0, 1)
const EVENT_MAX_SPAN_MS = 366 * 86400000
// group.events: one page of a group's events, a fixed size whose worst case
// (maximal texts, titles and places) fits MAX_MESSAGE (test/sizes.test.js).
const GROUP_EVENTS_LIMIT = 30
// Visitas (docs/protocol.md): a node sends at most VISIT_DAILY_MAX pings a
// day and at most one to the same profile in VISIT_PROFILE_DAYS days, and
// never spends the last VISIT_STAMP_RESERVE of its stamps on one. The list
// of visitors holds the newest VISIT_LIST_MAX rows and forgets a visit after
// VISIT_KEEP_DAYS days.
const VISIT_DAILY_MAX = 10
const VISIT_PROFILE_DAYS = 7
const VISIT_STAMP_RESERVE = 5
const VISIT_LIST_MAX = 50
const VISIT_KEEP_DAYS = 30
const MAX_GROUP_NAME = 80 // same value as records.js
const MAX_GROUP_ABOUT = 280 // same value as records.js
const MAX_GROUP_CUTS = 16
const MAX_GROUPS_PER_COMMUNITY = 32
const COMMUNITY_LIST_MAX = 64
// dm.thread: the largest page whose worst case (MAX_TEXT 4-byte characters,
// a maximal link card and two reactions at the emoji cap in every message)
// fits MAX_MESSAGE (docs/rpc.md 5.78, test/sizes.test.js).
const DM_THREAD_LIMIT_DEFAULT = 30
const DM_THREAD_LIMIT_MAX = 41
const PEEK_TIMEOUT_MS = 8000
const FOLLOW_LIMIT_DEFAULT = 100
const FOLLOW_LIMIT_MAX = 500
const BLOCK_MAX = 500
const SYNC_TIMEOUT_MIN = 1000
const SYNC_TIMEOUT_MAX = 600000
const SYNC_TIMEOUT_DEFAULT = 30000

// Pure: the first `max` entries and the count of entries cut (0 when none).
function capList (list, max = MAX_LIST) {
  const all = Array.isArray(list) ? list : []
  if (all.length <= max) return { list: all.slice(), truncated: 0 }
  return { list: all.slice(0, max), truncated: all.length - max }
}

// Budget for the SyncResult inside a sync.stopped event, leaving room for
// the envelope and the other event fields.
const MAX_SYNC_RESULT = MAX_MESSAGE - 4096

function clipStrings (list) {
  return list.map((s) => clipText(String(s), MAX_LINE))
}

// The SyncResult of packages/core/lib/sync.js reshaped for the wire
// (docs/rpc.md 6.12): every list capped to MAX_LIST with a <name>Truncated
// count, `downloaded` capped to the MAX_LIST smallest keys, every string
// clipped (MAX_LINE code points, MAX_TOKEN_TEXT for keys and reasons), and,
// should it still exceed MAX_SYNC_RESULT bytes, errorsSoft, errors, skipped
// then unadvertised emptied in that order (their whole length moved to the
// Truncated count). Pure: the input is not mutated.
function capSyncResult (result) {
  const r = result !== null && typeof result === 'object' ? result : {}
  const keys = Object.keys(r.downloaded !== null && typeof r.downloaded === 'object' ? r.downloaded : {}).sort()
  const kept = capList(keys)
  const downloaded = {}
  for (const k of kept.list) {
    const n = r.downloaded[k]
    const name = clipText(k, MAX_TOKEN_TEXT)
    if (name === '__proto__') continue
    downloaded[name] = Number.isSafeInteger(n) ? n : 0
  }
  const unadvertised = capList(r.unadvertised)
  const skipped = capList(r.skipped)
  const errors = capList(r.errors)
  const errorsSoft = capList(r.errorsSoft)
  const out = {
    ok: r.ok === true,
    peers: Number.isSafeInteger(r.peers) ? r.peers : 0,
    seeders: Number.isSafeInteger(r.seeders) ? r.seeders : 0,
    admitted: r.admitted === true,
    rejected: typeof r.rejected === 'string' ? clipText(r.rejected, MAX_TOKEN_TEXT) : null,
    seederConfirmed: r.seederConfirmed === true,
    downloaded,
    downloadedTruncated: kept.truncated,
    unadvertised: unadvertised.list.map((k) => clipText(String(k), MAX_TOKEN_TEXT)),
    unadvertisedTruncated: unadvertised.truncated,
    skipped: skipped.list.map((s) => ({
      key: s && typeof s.key === 'string' ? clipText(s.key, MAX_TOKEN_TEXT) : '',
      reason: s && typeof s.reason === 'string' ? clipText(s.reason, MAX_TOKEN_TEXT) : ''
    })),
    skippedTruncated: skipped.truncated,
    errors: clipStrings(errors.list),
    errorsTruncated: errors.truncated,
    errorsSoft: clipStrings(errorsSoft.list),
    errorsSoftTruncated: errorsSoft.truncated
  }
  for (const name of ['errorsSoft', 'errors', 'skipped', 'unadvertised']) {
    if (utf8ByteLength(JSON.stringify(out)) <= MAX_SYNC_RESULT) break
    out[name + 'Truncated'] += out[name].length
    out[name] = []
  }
  return out
}

function shareCoverSource (record) {
  try {
    if (!record || typeof record !== 'object') return null
    const media = record.media
    if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_PER_POST) return null
    for (let i = 0; i < media.length; i++) {
      const item = media[i]
      if (item && typeof item === 'object' && typeof item.mime === 'string' && MEDIA_MIMES.includes(item.mime)) return item
    }
    return null
  } catch {
    return null
  }
}

function needsShareCover (record) {
  try {
    const source = shareCoverSource(record)
    if (!source) return false
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(source.mime)) return true
    const bytes = source.bytes instanceof Uint8Array ? source.bytes.byteLength : source.bytes
    return !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_SHARE_COVER_BYTES
  } catch {
    return false
  }
}

module.exports = {
  shareCoverSource,
  needsShareCover,
  PROTOCOL,
  MAX_ID,
  MAX_REQUEST,
  MAX_MESSAGE,
  MAX_PENDING,
  MAX_OUTBOUND,
  MAX_LIST,
  MAX_LINE,
  MAX_TOKEN_TEXT,
  MAX_TOKEN,
  MAX_CERT_BYTES,
  MAX_SYNC_RESULT,
  DEFAULT_TIMEOUT_MS,
  MAX_NAME,
  MAX_BIO,
  MAX_TEXT,
  MAX_TESTIMONIAL,
  MAX_SCRAP,
  MAX_ABOUT,
  MAX_CITY,
  MAX_WORK,
  MAX_STUDIES,
  MAX_INTERESTS,
  MAX_MOOD_TEXT,
  MAX_TOP_FRIENDS,
  TESTIMONIAL_PENDING_MAX,
  TESTIMONIAL_KEPT_MAX,
  TESTIMONIAL_DECLINED_MAX,
  MEDIA_BLOCK_BYTES,
  MAX_MEDIA_BLOCKS,
  MAX_MEDIA_PER_POST,
  MAX_MEDIA_ITEM_BLOCKS,
  MEDIA_MIMES,
  MAX_MEDIA_DIMENSION,
  AVATAR_SIDE,
  MAX_AVATAR_BLOCKS,
  MAX_AVATAR_BYTES,
  AVATAR_MIMES,
  MAX_SHARE_COVER_SIDE,
  MAX_SHARE_COVER_BLOCKS,
  MAX_SHARE_COVER_BYTES,
  VIDEO_MIME,
  MAX_VIDEO_MS,
  MAX_VIDEO_DIMENSION,
  MAX_VIDEO_PIXELS,
  MAX_MOMENT_VIDEO_MS,
  MAX_MOMENT_VIDEO_BYTES,
  MOMENT_SEEN_MAX,
  MAX_DM_MEDIA,
  MAX_GROUP_MEDIA,
  PRIVATE_GROUP_IMAGE_SIDE,
  MAX_PRIVATE_GROUP_IMAGE_BLOCKS,
  MAX_PRIVATE_GROUP_IMAGE_BYTES,
  DM_MEDIA_CHUNK_BYTES,
  DM_MEDIA_MAX_CHUNKS,
  DM_MEDIA_MAC_BYTES,
  LOG_LIMIT_DEFAULT,
  LOG_LIMIT_MAX,
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  FEED_INCOMPLETE_MAX,
  PEEK_LIMIT_DEFAULT,
  PEEK_LIMIT_MAX,
  NOTICES_LIMIT_DEFAULT,
  NOTICES_LIMIT_MAX,
  PROFILE_LIMIT_MAX,
  ENGAGEMENT_LIMIT_MAX,
  PEEK_SEQS_MAX,
  GROUP_LIMIT_DEFAULT,
  GROUP_LIMIT_MAX,
  GROUP_MEMBERS_LIMIT_MAX,
  GROUP_REACTIONS_MAX,
  GROUP_REACTORS_MAX,
  POLL_MIN,
  POLL_MAX,
  MAX_POLL_OPTION,
  GROUP_MARKED_LIMIT,
  GROUP_TOPICS_LIMIT,
  GROUP_VOTERS_MAX,
  MAX_EVENT_TITLE,
  MAX_EVENT_PLACE,
  EVENT_MIN_MS,
  EVENT_MAX_MS,
  EVENT_MAX_SPAN_MS,
  GROUP_EVENTS_LIMIT,
  VISIT_DAILY_MAX,
  VISIT_PROFILE_DAYS,
  VISIT_STAMP_RESERVE,
  VISIT_LIST_MAX,
  VISIT_KEEP_DAYS,
  MAX_GROUP_NAME,
  MAX_GROUP_ABOUT,
  MAX_GROUP_CUTS,
  MAX_GROUPS_PER_COMMUNITY,
  COMMUNITY_LIST_MAX,
  DM_THREAD_LIMIT_DEFAULT,
  DM_THREAD_LIMIT_MAX,
  PEEK_TIMEOUT_MS,
  FOLLOW_LIMIT_DEFAULT,
  FOLLOW_LIMIT_MAX,
  BLOCK_MAX,
  SYNC_TIMEOUT_MIN,
  SYNC_TIMEOUT_MAX,
  SYNC_TIMEOUT_DEFAULT,
  capList,
  capSyncResult
}
