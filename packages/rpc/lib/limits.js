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
const MEDIA_BLOCK_BYTES = 32768
const MAX_MEDIA_BLOCKS = 8192
const MAX_MEDIA_PER_POST = 4
const MAX_MEDIA_ITEM_BLOCKS = 256
const MEDIA_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_MEDIA_DIMENSION = 16384

const LOG_LIMIT_DEFAULT = 20
// Page maxima: the largest pages whose worst case (every post with
// MAX_MEDIA_PER_POST maximal descriptors) fits MAX_MESSAGE (docs/rpc.md
// section 2, test/sizes.test.js).
const LOG_LIMIT_MAX = 36
const FEED_LIMIT_DEFAULT = 30
const FEED_LIMIT_MAX = 31
// Authors per profile.read: its worst case fits MAX_MESSAGE with room to
// spare (docs/rpc.md section 2, test/sizes.test.js).
const PROFILE_LIMIT_MAX = 100
const ENGAGEMENT_LIMIT_MAX = 62
const PEEK_SEQS_MAX = 36
const PEEK_TIMEOUT_MS = 8000
const FOLLOW_LIMIT_DEFAULT = 100
const FOLLOW_LIMIT_MAX = 500
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

module.exports = {
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
  MEDIA_BLOCK_BYTES,
  MAX_MEDIA_BLOCKS,
  MAX_MEDIA_PER_POST,
  MAX_MEDIA_ITEM_BLOCKS,
  MEDIA_MIMES,
  MAX_MEDIA_DIMENSION,
  LOG_LIMIT_DEFAULT,
  LOG_LIMIT_MAX,
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  PROFILE_LIMIT_MAX,
  ENGAGEMENT_LIMIT_MAX,
  PEEK_SEQS_MAX,
  PEEK_TIMEOUT_MS,
  FOLLOW_LIMIT_DEFAULT,
  FOLLOW_LIMIT_MAX,
  SYNC_TIMEOUT_MIN,
  SYNC_TIMEOUT_MAX,
  SYNC_TIMEOUT_DEFAULT,
  capList,
  capSyncResult
}
