'use strict'

// Worst-case response sizes (docs/rpc.md section 2): the page maxima are the
// largest pages whose worst case fits MAX_MESSAGE.

const test = require('brittle')
const { validateRecord } = require('@varanda/core/lib/records')
const { isUsername } = require('@varanda/core/lib/account-link')
const { SEEN_BLOB_B64, MERGE_AVISOS_MAX, SYNC_PAGES_MAX, MERGE_PAGE_TOKENS_MAX } = require('@varanda/core/lib/seen-blob')
const {
  createServerDispatcher,
  validateParams,
  utf8ByteLength,
  MAX_ID,
  MAX_REQUEST,
  MAX_MESSAGE,
  MAX_LIST,
  MAX_NAME,
  MAX_BIO,
  MAX_TEXT,
  MAX_CARD_URL,
  MAX_CARD_TITLE,
  MAX_CARD_DESC,
  MAX_CARD_IMAGE_BYTES,
  MAX_MEDIA_BLOCKS,
  MAX_MEDIA_ITEM_BLOCKS,
  MAX_MEDIA_PER_POST,
  MAX_GROUP_MEDIA,
  MAX_MEDIA_DIMENSION,
  MEDIA_BLOCK_BYTES,
  MEDIA_MIMES,
  LOG_LIMIT_MAX,
  FEED_LIMIT_MAX,
  FEED_INCOMPLETE_MAX,
  PEEK_LIMIT_MAX,
  NOTICES_LIMIT_MAX,
  PROFILE_LIMIT_MAX,
  ENGAGEMENT_LIMIT_MAX,
  PEEK_SEQS_MAX,
  FOLLOW_LIMIT_MAX,
  GROUP_LIMIT_DEFAULT,
  GROUP_LIMIT_MAX,
  GROUP_MEMBERS_LIMIT_MAX,
  MAX_GROUP_NAME,
  MAX_GROUPS_PER_COMMUNITY,
  COMMUNITY_LIST_MAX,
  MAX_DM_MEDIA,
  DM_MEDIA_CHUNK_BYTES,
  DM_MEDIA_MAX_CHUNKS,
  DM_THREAD_LIMIT_MAX,
  feira
} = require('..')

const HEX = 'f'.repeat(64)
const SEQ = Number.MAX_SAFE_INTEGER
const AT = new Date(8.64e15).toISOString() // '+275760-09-13T00:00:00.000Z', the longest canonical ISO
// A lone surrogate is one char (code point) for records.js and the most
// expensive one on the wire: JSON.stringify writes it as \udXXX (6 bytes).
// A 4-byte UTF-8 character (4 bytes) and '"' or '\\' (2 bytes) are cheaper,
// and every other JSON-escaped character is forbidden in names and texts.
const WORST = ['\ud800', '\u{1f600}', '"', '\\', '\n']
// MAX_MEDIA_PER_POST descriptors with the longest allowed mime and the widest
// number in every field.
const MIME = MEDIA_MIMES.reduce((a, b) => (b.length > a.length ? b : a))
const DESCRIPTOR = {
  core: HEX,
  mime: MIME,
  start: MAX_MEDIA_BLOCKS - MAX_MEDIA_ITEM_BLOCKS,
  blocks: MAX_MEDIA_ITEM_BLOCKS,
  bytes: MAX_MEDIA_ITEM_BLOCKS * MEDIA_BLOCK_BYTES,
  sha256: HEX,
  width: MAX_MEDIA_DIMENSION,
  height: MAX_MEDIA_DIMENSION
}
const MEDIA = Array(MAX_MEDIA_PER_POST).fill(DESCRIPTOR)
// Group posts and listings keep their own, smaller caps.
const GROUP_MEDIA = Array(MAX_GROUP_MEDIA).fill(DESCRIPTOR)
const LISTING_MEDIA = Array(feira.MAX_LISTING_MEDIA).fill(DESCRIPTOR)
// The hostname is repeated in the card, so the longest hostname is widest.
const CARD_HOST = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')
const CARD_IMAGE = { ...DESCRIPTOR, mime: 'image/jpeg', start: MAX_MEDIA_BLOCKS - 1, blocks: 1, bytes: MAX_CARD_IMAGE_BYTES }
const CARD = {
  url: 'https://' + CARD_HOST + '/' + 'a'.repeat(MAX_CARD_URL - 9 - CARD_HOST.length),
  host: CARD_HOST,
  title: '\u{1f600}'.repeat(MAX_CARD_TITLE),
  desc: '\u{1f600}'.repeat(MAX_CARD_DESC),
  image: CARD_IMAGE
}
const PRIVATE_CARD_IMAGE = {
  core: HEX,
  mime: 'application/octet-stream',
  start: MAX_MEDIA_BLOCKS - 1,
  blocks: 1,
  bytes: MAX_CARD_IMAGE_BYTES,
  sha256: HEX,
  key: HEX,
  nonce: 'f'.repeat(48),
  plainMime: 'image/jpeg',
  plainSha256: HEX,
  w: MAX_MEDIA_DIMENSION,
  h: MAX_MEDIA_DIMENSION,
  ms: 0
}
const PRIVATE_CARD = { ...CARD, image: PRIVATE_CARD_IMAGE }

// The widest avatar: the longest avatar mime and the widest start, blocks
// and bytes (width and height are fixed).
const WORST_AVATAR = { core: HEX, mime: 'image/webp', start: 8184, blocks: 8, bytes: 262144, sha256: HEX, width: 512, height: 512 }

function worstProfile (ch) {
  return { type: 'profile', name: ch.repeat(MAX_NAME), bio: ch.repeat(MAX_BIO), at: AT, avatar: WORST_AVATAR }
}

function worstPost (ch, preview = true) {
  return { type: 'post', text: ch.repeat(MAX_TEXT), at: AT, replyTo: { author: HEX, seq: SEQ }, ...(preview ? { preview: CARD } : { media: MEDIA }) }
}

function worstQuote (ch, preview = true) {
  return { ...worstPost(ch, preview), replyTo: null, quote: { author: HEX, seq: SEQ } }
}

function size (result) {
  return utf8ByteLength(JSON.stringify({ v: 1, id: MAX_ID, ok: true, result }))
}

test('seen sync: worst-case request and results fit', (t) => {
  t.is(SEEN_BLOB_B64, 43744)
  t.is(MERGE_AVISOS_MAX, 256)
  t.is(SYNC_PAGES_MAX, 4)
  t.is(MERGE_PAGE_TOKENS_MAX, 32)
  t.is(MAX_REQUEST, 65536)
  t.is(MAX_MESSAGE, 262144)
  const tokens = (n) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(32, '0'))
  const avisos = {
    own: tokens(MERGE_AVISOS_MAX),
    pages: Object.fromEntries(Array.from({ length: SYNC_PAGES_MAX }, (_, i) => [
      'page:' + i.toString(16).padStart(64, '0'), tokens(MERGE_PAGE_TOKENS_MAX)
    ]))
  }
  const blob = 'A'.repeat(SEEN_BLOB_B64)
  const params = { blob, avisos, unchanged: false }
  t.ok(validateParams('seen.merge', params).ok)
  const request = utf8ByteLength(JSON.stringify({ v: 1, id: MAX_ID, method: 'seen.merge', params }))
  t.ok(request < MAX_REQUEST)
  t.comment('seen.merge worst-case request: ' + request + ' bytes')
  const write = size({ signature: 'f'.repeat(128), blob, hash: HEX, prevHash: HEX })
  t.ok(write < MAX_MESSAGE)
  t.comment('seen.sign worst-case write result: ' + write + ' bytes')
  const merge = size({
    avisos,
    pending: false,
    dmChanged: false,
    groupChanged: false,
    caughtUp: Array.from({ length: 512 }, (_, i) => i.toString(16).padStart(64, '0'))
  })
  t.ok(merge < MAX_MESSAGE)
  t.comment('seen.merge worst-case result with 512 caught-up keys: ' + merge + ' bytes')
})

function feedResult (n, ch, preview = true) {
  const item = { kind: 'post', author: HEX, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: { author: HEX, seq: SEQ }, quote: null, media: preview ? null : MEDIA, preview: preview ? CARD : null }
  return {
    items: Array(n).fill(item),
    skipped: Array(MAX_LIST).fill({ key: HEX, reason: 'untrusted-association' }),
    skippedTruncated: SEQ,
    future: Array(MAX_LIST).fill(HEX + ':' + SEQ),
    futureTruncated: SEQ,
    incomplete: Array(FEED_INCOMPLETE_MAX).fill(HEX),
    incompleteTruncated: SEQ
  }
}

// A PeekItem is a FeedItem plus `round` and the author's `avatar`; its worst case is a post with a
// reply or a quote ref (never both; a repost item is smaller).
function peekResult (n, ch, preview = true) {
  const item = { kind: 'post', author: HEX, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: null, quote: { author: HEX, seq: SEQ }, media: preview ? null : MEDIA, preview: preview ? CARD : null, round: 100000, avatar: WORST_AVATAR }
  return {
    items: Array(n).fill(item),
    next: { round: 100000, at: AT, author: HEX, seq: SEQ },
    diaries: 4096,
    skipped: 4096,
    incomplete: true
  }
}

function noticesResult (n, ch) {
  // Derive the maximum from core's username rule, which exports no length limit.
  let username = 'uuu'
  while (isUsername(username + 'u')) username += 'u'
  // A repost row carries the caller's post ref and the longest kind name.
  const item = { kind: 'repost', key: HEX, seq: SEQ, at: AT, name: ch.repeat(MAX_NAME), username, seen: 'f'.repeat(32), avatar: WORST_AVATAR, post: HEX + ':' + SEQ }
  return {
    notices: Array(n).fill(item),
    next: { at: AT, key: HEX, seq: SEQ },
    incomplete: true,
    supported: true,
    activity: true
  }
}

function logResult (n, ch, preview = true) {
  // Quote records retain replyTo: null and add quote, costing 13 bytes more
  // than plain reply records (FeedItems always carry both fields).
  return { key: HEX, entries: Array(n).fill({ seq: SEQ, record: worstQuote(ch, preview) }), invalid: [], entriesTruncated: SEQ }
}

function diaryPeekResult (entries, invalid, missing, ch, preview = true) {
  return {
    key: HEX,
    length: SEQ,
    entries: Array(entries).fill({ seq: SEQ, record: worstQuote(ch, preview) }),
    invalid: Array(invalid).fill(SEQ),
    missing: Array(missing).fill(SEQ),
    profile: { name: ch.repeat(MAX_NAME), bio: ch.repeat(MAX_BIO), avatar: WORST_AVATAR },
    username: 'u'.repeat(20)
  }
}

function profileResult (n, ch) {
  return {
    profiles: Array(n).fill({ author: HEX, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), bio: ch.repeat(MAX_BIO), avatar: WORST_AVATAR }),
    missing: []
  }
}

test('the worst-case records are valid records', (t) => {
  for (const ch of WORST) {
    t.is(validateRecord(worstPost(ch), 1), null)
    if (ch !== '\n') t.is(validateRecord({ type: 'profile', name: ch.repeat(MAX_NAME), bio: ch.repeat(MAX_BIO), at: AT }, 1), null)
    if (ch !== '\n') t.is(validateRecord(worstProfile(ch), 1), null)
  }
})

test('the worst avatar is a valid avatar', (t) => {
  t.is(utf8ByteLength(JSON.stringify(WORST_AVATAR)), 235)
  t.ok(validateParams('profile.set', { name: 'a', avatar: WORST_AVATAR }).ok)
  t.absent(validateParams('profile.set', { name: 'a', avatar: { ...WORST_AVATAR, start: 8185 } }).ok)
})

test('a post outweighs a profile and a certificate in a log page', (t) => {
  const post = JSON.stringify(worstPost('\ud800'))
  const profile = JSON.stringify({ type: 'profile', name: '\ud800'.repeat(MAX_NAME), bio: '\ud800'.repeat(MAX_BIO), at: AT })
  t.ok(utf8ByteLength(post) > utf8ByteLength(profile))
  t.ok(utf8ByteLength(post) > utf8ByteLength(JSON.stringify(worstProfile('\ud800'))), 'also a profile with an avatar')
  // A certificate has fixed-size fields (hex64, hex128, <= 32-char tokens, ISO).
  t.ok(utf8ByteLength(post) > 1000)
  t.is(utf8ByteLength(JSON.stringify(worstQuote('\ud800'))), utf8ByteLength(post) + 13, 'quote is the largest post record')
})

test('feed quote items are no larger than replies, and reposts are smaller', (t) => {
  for (const ch of WORST) {
    const post = feedResult(1, ch).items[0]
    const quote = { ...post, replyTo: null, quote: post.replyTo }
    const repost = { ...post, kind: 'repost', to: post.replyTo, text: null, replyTo: null, quote: null, media: null, preview: null }
    t.ok(size(quote) <= size(post), 'quote ' + JSON.stringify(ch))
    t.ok(size(repost) < size(post), 'repost ' + JSON.stringify(ch))
  }
})

test('feed.read: FEED_LIMIT_MAX fits, one more does not', (t) => {
  // With MAX_MEDIA_PER_POST public descriptors in every item.
  t.is(FEED_LIMIT_MAX, 26)
  t.is(FEED_INCOMPLETE_MAX, 16)
  for (const ch of WORST) t.ok(size(feedResult(FEED_LIMIT_MAX, ch, false)) <= MAX_MESSAGE, JSON.stringify(ch))
  const worst = size(feedResult(FEED_LIMIT_MAX, '\ud800', false))
  t.is(worst, 261312)
  t.comment('feed worst case at ' + FEED_LIMIT_MAX + ' items: ' + worst + ' bytes')
  const overflow = size(feedResult(FEED_LIMIT_MAX + 1, '\ud800', false))
  t.is(overflow, 270575)
  t.comment('feed worst case at ' + (FEED_LIMIT_MAX + 1) + ' items: ' + overflow + ' bytes')
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
  // Lone surrogates are the worst case: one more item of 4-byte characters fits.
  const fourByte = size(feedResult(FEED_LIMIT_MAX + 1, '\u{1f600}', false))
  t.is(fourByte, 212255)
  t.comment('feed at ' + (FEED_LIMIT_MAX + 1) + ' items of 4-byte characters: ' + fourByte + ' bytes')
  t.ok(fourByte <= MAX_MESSAGE, 'one more item of 4-byte characters would fit')
})

test('peek.read: PEEK_LIMIT_MAX fits', (t) => {
  // With MAX_MEDIA_PER_POST public descriptors in every item.
  for (const ch of WORST) t.ok(size(peekResult(PEEK_LIMIT_MAX, ch, false)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.is(size(peekResult(PEEK_LIMIT_MAX, '\ud800', false)), 247858)
  t.comment('peek worst case at ' + PEEK_LIMIT_MAX + ' items: ' + size(peekResult(PEEK_LIMIT_MAX, '\ud800', false)) + ' bytes')
})

test('notices.list: NOTICES_LIMIT_MAX fits', (t) => {
  for (const ch of WORST) t.ok(size(noticesResult(NOTICES_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.comment('notices.list worst case at ' + NOTICES_LIMIT_MAX + ' notices: ' + size(noticesResult(NOTICES_LIMIT_MAX, '\ud800')) + ' bytes')
})

test('log.read: LOG_LIMIT_MAX fits, one more does not', (t) => {
  t.is(LOG_LIMIT_MAX, 30)
  for (const ch of WORST) t.ok(size(logResult(LOG_LIMIT_MAX, ch, false)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.is(size(logResult(LOG_LIMIT_MAX, '\ud800', false)), 259948)
  t.comment('log worst case at ' + LOG_LIMIT_MAX + ' entries: ' + size(logResult(LOG_LIMIT_MAX, '\ud800', false)) + ' bytes')
  const overflow = size(logResult(LOG_LIMIT_MAX + 1, '\ud800', false))
  t.is(overflow, 268607)
  t.comment('log worst case at ' + (LOG_LIMIT_MAX + 1) + ' entries: ' + overflow + ' bytes')
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
})

test('diary.peek: every partition of PEEK_SEQS_MAX fits with profile and username', (t) => {
  t.is(PEEK_SEQS_MAX, 29)
  const worst = size(diaryPeekResult(PEEK_SEQS_MAX, 0, 0, '\ud800', false))
  for (const ch of WORST) t.ok(size(diaryPeekResult(PEEK_SEQS_MAX, 0, 0, ch, false)) <= MAX_MESSAGE, JSON.stringify(ch))
  // Each requested seq contributes to exactly one of entries/invalid/missing.
  // Maximum-width integers conservatively bound every distinct requested seq.
  let largest = 0
  for (let entries = 0; entries <= PEEK_SEQS_MAX; entries++) {
    for (let invalid = 0; invalid <= PEEK_SEQS_MAX - entries; invalid++) {
      const missing = PEEK_SEQS_MAX - entries - invalid
      largest = Math.max(largest, size(diaryPeekResult(entries, invalid, missing, '\ud800', false)))
    }
  }
  t.is(largest, worst, PEEK_SEQS_MAX + ' quote records dominate all partitions, including ' + PEEK_SEQS_MAX + ' invalid or missing seqs')
  t.is(largest, 253762)
  t.ok(largest <= MAX_MESSAGE)
  t.is(size(diaryPeekResult(PEEK_SEQS_MAX + 1, 0, 0, '\ud800', false)), 262421)
  t.ok(size(diaryPeekResult(PEEK_SEQS_MAX + 1, 0, 0, '\ud800', false)) > MAX_MESSAGE)
  t.comment('diary.peek worst case at ' + PEEK_SEQS_MAX + ' entries with profile and username: ' + largest + ' bytes')
  // All three arrays full would describe 96 requests, outside the contract.
  // Keep this counterexample explicit: it cannot be used as a fits proof.
  const impossible = size(diaryPeekResult(PEEK_SEQS_MAX, PEEK_SEQS_MAX, PEEK_SEQS_MAX, '\ud800', false))
  t.comment('diary.peek synthetic ' + PEEK_SEQS_MAX + ' entries + ' + PEEK_SEQS_MAX + ' invalid + ' + PEEK_SEQS_MAX + ' missing: ' + impossible + ' bytes (outside contract)')
  t.ok(impossible > largest)
})

test('engagement.read: ENGAGEMENT_LIMIT_MAX liked and reposted refs fit', (t) => {
  t.is(ENGAGEMENT_LIMIT_MAX, 62)
  const refs = Array.from({ length: ENGAGEMENT_LIMIT_MAX }, (_, i) => HEX + ':' + (SEQ - i))
  const bytes = size({ liked: refs, reposted: refs })
  t.comment('engagement.read worst case at ' + ENGAGEMENT_LIMIT_MAX + ' liked + ' + ENGAGEMENT_LIMIT_MAX + ' reposted refs: ' + bytes + ' bytes')
  t.ok(bytes <= MAX_MESSAGE)
})

test('profile.read: PROFILE_LIMIT_MAX fits', (t) => {
  for (const ch of WORST) t.ok(size(profileResult(PROFILE_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.comment('profile.read worst case at ' + PROFILE_LIMIT_MAX + ' authors: ' + size(profileResult(PROFILE_LIMIT_MAX, '\ud800')) + ' bytes')
  let n = PROFILE_LIMIT_MAX
  while (size(profileResult(n + 1, '\ud800')) <= MAX_MESSAGE) n++
  t.comment('profile.read largest that fits: ' + n + ' authors')
  t.ok(n >= PROFILE_LIMIT_MAX)
  t.ok(size(profileResult(n + 1, '\ud800')) > MAX_MESSAGE)
})

test('follow.list: FOLLOW_LIMIT_MAX keys fit with a wide margin', (t) => {
  const s = size({ follows: Array(FOLLOW_LIMIT_MAX).fill(HEX), total: SEQ })
  t.comment('follow.list worst case at ' + FOLLOW_LIMIT_MAX + ' keys: ' + s + ' bytes')
  t.ok(s * 4 < MAX_MESSAGE)
})

function groupReadResult (n, ch, media, card = null) {
  const item = { writer: HEX, diary: HEX, seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: { writer: HEX, seq: SEQ }, fwd: 1, media, card, hidden: false, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20) }
  return { items: Array(n).fill(item), next: { at: AT, writer: HEX, seq: SEQ }, hidden: SEQ, incomplete: true, sealed: SEQ, epoch: { writer: HEX, seq: SEQ }, state: 'rekey-pending' }
}

test('group.read: public media fits GROUP_LIMIT_MAX', (t) => {
  const media = GROUP_MEDIA.map((d, i) => ({ ...d, core: String(i).repeat(64) }))
  t.is(GROUP_LIMIT_DEFAULT, GROUP_LIMIT_MAX)
  t.ok(validateParams('group.post', { group: HEX, text: '\ud800'.repeat(MAX_TEXT), replyTo: { writer: HEX, seq: SEQ }, media }).ok, 'worst public media passes RPC validation')
  for (const ch of WORST) t.ok(size(groupReadResult(GROUP_LIMIT_MAX, ch, media)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.comment('group.read public media at ' + GROUP_LIMIT_MAX + ' items: ' + size(groupReadResult(GROUP_LIMIT_MAX, '\ud800', media)) + ' bytes')
})

test('group.read: GROUP_LIMIT_MAX with private media fits, one more does not', (t) => {
  const { width, height, ...cipher } = DESCRIPTOR
  const media = Array.from({ length: GROUP_MEDIA.length }, (_, i) => ({
    ...cipher,
    core: String(i).repeat(64),
    mime: 'application/octet-stream',
    bytes: cipher.blocks * MEDIA_BLOCK_BYTES,
    key: HEX,
    nonce: 'f'.repeat(48),
    plainMime: MIME,
    plainSha256: HEX,
    w: MAX_MEDIA_DIMENSION,
    h: MAX_MEDIA_DIMENSION,
    ms: 0
  }))
  const item = groupReadResult(1, '\ud800', media).items[0]
  t.ok(validateParams('group.post', { group: HEX, text: item.text, replyTo: item.replyTo, media, sealed: true }).ok, 'worst private media passes RPC validation')
  for (const ch of WORST) t.ok(size(groupReadResult(GROUP_LIMIT_MAX, ch, media)) <= MAX_MESSAGE, JSON.stringify(ch))
  const worst = size(groupReadResult(GROUP_LIMIT_MAX, '\ud800', media))
  const overflow = size(groupReadResult(GROUP_LIMIT_MAX + 1, '\ud800', media))
  t.ok(worst < size(groupReadResult(GROUP_LIMIT_MAX, '\ud800', null, PRIVATE_CARD)))
  t.is(worst, 257717)
  t.is(overflow, 266590)
  t.comment('group.read worst private item: ' + utf8ByteLength(JSON.stringify(item)) + ' bytes')
  t.comment('group.read worst case at ' + GROUP_LIMIT_MAX + ' items: ' + worst + ' bytes')
  t.comment('group.read worst case at ' + (GROUP_LIMIT_MAX + 1) + ' items: ' + overflow + ' bytes')
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
})

test('group.members: GROUP_MEMBERS_LIMIT_MAX fits', (t) => {
  const member = { member: HEX, name: '\ud800'.repeat(MAX_NAME), username: 'u'.repeat(20), admin: true, banned: true, joinedAt: AT }
  const s = size({ members: Array(GROUP_MEMBERS_LIMIT_MAX).fill(member), total: SEQ })
  t.comment('group.members worst case at ' + GROUP_MEMBERS_LIMIT_MAX + ' members: ' + s + ' bytes')
  t.ok(s <= MAX_MESSAGE)
})

test('community.info: MAX_GROUPS_PER_COMMUNITY groups with maximal names fit', (t) => {
  t.is(MAX_GROUPS_PER_COMMUNITY, 32)
  const group = { group: HEX, name: '\ud800'.repeat(MAX_GROUP_NAME), visibility: 'private', join: 'approval', role: 'creator', general: false, last: { name: '\ud800'.repeat(MAX_NAME), username: 'u'.repeat(20), preview: '\ud800'.repeat(140), at: AT, mine: false, hidden: false }, unread: 99 }
  const s = size({ community: HEX, name: '\ud800'.repeat(MAX_GROUP_NAME), join: 'approval', creator: HEX, role: 'creator', state: 'ready', members: SEQ, admins: SEQ, groups: Array(MAX_GROUPS_PER_COMMUNITY).fill(group), general: HEX, incomplete: true, leavePending: true })
  t.comment('community.info worst case at ' + MAX_GROUPS_PER_COMMUNITY + ' groups: ' + s + ' bytes')
  t.ok(s <= MAX_MESSAGE)
})

test('community.list: COMMUNITY_LIST_MAX communities with maximal names fit', (t) => {
  t.is(COMMUNITY_LIST_MAX, 64)
  const community = { community: HEX, name: '\ud800'.repeat(MAX_GROUP_NAME), join: 'approval', state: 'pending', role: 'creator', general: HEX }
  const s = size({ communities: Array(COMMUNITY_LIST_MAX).fill(community) })
  t.comment('community.list worst case at ' + COMMUNITY_LIST_MAX + ' communities: ' + s + ' bytes')
  t.ok(s <= MAX_MESSAGE)
})

// A DM text is well formed (packages/core/lib/dm.js validText), so a lone
// surrogate never reaches dm.thread: a 4-byte character is the widest code
// point there.
const DM_WORST = ['\u{1f600}', '"', '\\', '\n']
// The widest media item dm.send accepts: the longest mime, the most chunks
// and the largest ciphertext, the widest sides (ms is 0 for an image).
const DM_MEDIA_ITEM = {
  id: HEX,
  key: HEX,
  nonce: 'f'.repeat(48),
  mime: MIME,
  chunks: DM_MEDIA_MAX_CHUNKS,
  bytes: DM_MEDIA_MAX_CHUNKS * DM_MEDIA_CHUNK_BYTES,
  sha256: HEX,
  w: MAX_MEDIA_DIMENSION,
  h: MAX_MEDIA_DIMENSION,
  ms: 0
}

const DM_CARD = { ...CARD, image: { ...DM_MEDIA_ITEM, mime: 'image/jpeg', chunks: 1, bytes: MAX_CARD_IMAGE_BYTES } }

// Every message at MAX_TEXT code points and a maximal card, which the
// sealed frame (DM_INNER_BYTES) cannot even carry together: a bound, not a
// message that exists.
function dmThreadResult (n, ch, card = true) {
  const message = { id: 'f'.repeat(32), from: HEX, text: ch.repeat(MAX_TEXT), replyTo: 'f'.repeat(32), fwd: 1, at: AT, mine: false, media: card ? null : widestDmMedia(MAX_DM_MEDIA), card: card ? DM_CARD : null }
  return { messages: Array(n).fill(message), next: 'f'.repeat(32), folder: 'request', blocked: false }
}

// n widest items with distinct blob ids (dm.send refuses repeated ids); every
// id is 64 hex, so the width is the same as n copies.
function widestDmMedia (n) {
  return Array.from({ length: n }, (_, i) => ({ ...DM_MEDIA_ITEM, id: (i + 1).toString(16).padStart(2, '0').repeat(32) }))
}

test('the widest DM media item is a valid dm.send item', (t) => {
  t.ok(validateParams('dm.send', { to: HEX, text: '', media: widestDmMedia(MAX_DM_MEDIA) }).ok)
  t.absent(validateParams('dm.send', { to: HEX, text: '', media: [{ ...DM_MEDIA_ITEM, chunks: DM_MEDIA_MAX_CHUNKS + 1 }] }).ok)
  t.absent(validateParams('dm.send', { to: HEX, text: '', media: [{ ...DM_MEDIA_ITEM, bytes: DM_MEDIA_ITEM.bytes + 1 }] }).ok)
  t.absent(validateParams('dm.send', { to: HEX, text: '', media: widestDmMedia(MAX_DM_MEDIA + 1) }).ok)
  t.comment('widest DM media item: ' + utf8ByteLength(JSON.stringify(DM_MEDIA_ITEM)) + ' bytes')
})

test('dm.thread: DM_THREAD_LIMIT_MAX fits, one more does not', (t) => {
  t.is(DM_THREAD_LIMIT_MAX, 42)
  t.ok(validateParams('dm.thread', { peer: HEX, limit: DM_THREAD_LIMIT_MAX }).ok)
  t.absent(validateParams('dm.thread', { peer: HEX, limit: DM_THREAD_LIMIT_MAX + 1 }).ok)
  for (const ch of DM_WORST) t.ok(size(dmThreadResult(DM_THREAD_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  const worst = size(dmThreadResult(DM_THREAD_LIMIT_MAX, '\u{1f600}'))
  t.comment('dm.thread worst case at ' + DM_THREAD_LIMIT_MAX + ' messages: ' + worst + ' bytes')
  const overflow = size(dmThreadResult(DM_THREAD_LIMIT_MAX + 1, '\u{1f600}'))
  t.is(worst, 259022)
  t.is(overflow, 265186)
  t.comment('dm.thread worst case at ' + (DM_THREAD_LIMIT_MAX + 1) + ' messages: ' + overflow + ' bytes')
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
})

test('the dispatcher sends the worst-case feed page unchanged', async (t) => {
  const sent = []
  const d = createServerDispatcher({
    handlers: { 'feed.read': async () => feedResult(FEED_LIMIT_MAX, '\ud800', false) },
    send: (m) => sent.push(m)
  })
  d.receive({ v: 1, id: 1, method: 'session.open', params: {} })
  d.receive({ v: 1, id: MAX_ID, method: 'feed.read', params: { limit: FEED_LIMIT_MAX } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  t.is(sent[1].ok, true)
  t.is(sent[1].result.items.length, FEED_LIMIT_MAX)
  t.alike(sent[1].result, feedResult(FEED_LIMIT_MAX, '\ud800', false))
})

test('ten public descriptors outweigh a maximal card; four do not', (t) => {
  t.is(CARD.url.length, 300)
  t.is(CARD.host.length, 253)
  t.is(utf8ByteLength(JSON.stringify(CARD)), 1801)
  t.is(utf8ByteLength(JSON.stringify(PRIVATE_CARD)), 2051)
  t.is(utf8ByteLength(JSON.stringify(DM_CARD)), 1916)
  t.is(MEDIA.length, 10)
  t.is(utf8ByteLength(JSON.stringify(MEDIA)), 2431)
  t.ok(validateParams('post.create', { text: 'x', preview: CARD }).ok)
  t.ok(validateParams('post.create', { text: 'x', media: MEDIA }).ok)
  t.ok(validateParams('group.post', { group: HEX, text: 'x', card: PRIVATE_CARD, sealed: true }).ok)
  t.ok(validateParams('dm.send', { to: HEX, text: 'x', card: DM_CARD }).ok)
  const four = Array(4).fill(DESCRIPTOR)
  const withFour = (result) => (n, ch) => {
    const out = result(n, ch, false)
    for (const e of out.items || out.entries) {
      if (e.record) e.record = { ...e.record, media: four }
      else e.media = four
    }
    return out
  }
  for (const ch of WORST) {
    t.is(validateRecord(worstPost(ch), 1), null)
    t.is(validateRecord(worstQuote(ch), 1), null)
    t.is(validateRecord(worstPost(ch, false), 1), null)
    t.is(validateRecord(worstQuote(ch, false), 1), null)
    for (const result of [feedResult, peekResult, logResult]) {
      t.ok(size(result(1, ch, false)) > size(result(1, ch)), 'ten public descriptors exceed a card')
      t.ok(size(withFour(result)(1, ch)) < size(result(1, ch)), 'a card exceeds four public descriptors')
    }
    t.ok(size(diaryPeekResult(1, 0, 0, ch, false)) > size(diaryPeekResult(1, 0, 0, ch)))
  }
  t.ok(size(dmThreadResult(1, '\u{1f600}')) > size(dmThreadResult(1, '\u{1f600}', false)), 'DM card exceeds four media items')
  t.ok(size(groupReadResult(1, '\ud800', GROUP_MEDIA, null)) < size(groupReadResult(1, '\ud800', null, CARD)), 'a card exceeds four group media items')
})

test('group.read: maximal private cards fit, one more does not', (t) => {
  t.is(GROUP_LIMIT_MAX, 29)
  for (const ch of WORST) {
    const worst = groupReadResult(GROUP_LIMIT_MAX, ch, null, PRIVATE_CARD)
    t.ok(size(worst) <= MAX_MESSAGE)
    t.ok(size(groupReadResult(GROUP_LIMIT_MAX, ch, null, CARD)) < size(worst))
  }
  const worst = size(groupReadResult(GROUP_LIMIT_MAX, '\ud800', null, PRIVATE_CARD))
  const overflow = size(groupReadResult(GROUP_LIMIT_MAX + 1, '\ud800', null, PRIVATE_CARD))
  t.is(worst, 259979)
  t.is(overflow, 268930)
  t.ok(overflow > MAX_MESSAGE)
})

test('page.feed: maximal media lists fit the shared feed limit', (t) => {
  const result = { items: feedResult(FEED_LIMIT_MAX, '\ud800', false).items, incomplete: false }
  t.is(size(result), 240911)
  t.ok(size(result) < size(feedResult(FEED_LIMIT_MAX, '\ud800', false)))
  t.ok(size(result) <= MAX_MESSAGE)
})

test('listing.create, listing.edit and listing.mine: maximal sizes fit', (t) => {
  const request = (method, params) => utf8ByteLength(JSON.stringify({ v: 1, id: MAX_ID, method, params }))
  // The city keeps two letters so it still has a city key.
  const place = { uf: 'SP', city: 'ab' + '\ud800'.repeat(feira.MAX_PLACE - 2), bairro: '\ud800'.repeat(feira.MAX_PLACE) }
  const fields = {
    title: '\ud800'.repeat(feira.MAX_LISTING_TITLE),
    text: '\ud800'.repeat(MAX_TEXT),
    price: feira.MAX_PRICE_CENTS,
    unit: 'a-partir',
    cat: 'eletronicos',
    place,
    media: LISTING_MEDIA
  }
  const create = { kind: 'servico', ...fields }
  const edit = { to: HEX + ':' + SEQ, expectedRevision: SEQ, ...fields }
  t.ok(validateParams('listing.create', create).ok)
  t.ok(validateParams('listing.edit', edit).ok)
  t.ok(request('listing.create', create) <= MAX_REQUEST)
  t.ok(request('listing.edit', edit) <= MAX_REQUEST)
  t.ok(request('listing.create', create) <= MAX_MESSAGE)
  t.ok(request('listing.edit', edit) <= MAX_MESSAGE)
  // A listing.mine item: the current snapshot of one own listing with its
  // edit and status sequence numbers and both dates.
  const item = {
    seq: SEQ,
    editSeq: SEQ,
    statusSeq: SEQ,
    kind: 'servico',
    status: 'disponivel',
    ...fields,
    at: AT,
    editedAt: AT
  }
  const limit = validateParams('listing.mine', {}).value.limit
  t.is(limit, 20)
  const page = { items: Array(limit).fill(item), next: SEQ }
  t.ok(size(page) <= MAX_MESSAGE, 'listing.mine page ' + size(page))
})

test('a maximal video pair is smaller than ten maximal descriptors: page maxima unchanged', (t) => {
  const { VIDEO_MIME, MAX_VIDEO_MS, MAX_VIDEO_DIMENSION, MAX_VIDEO_PIXELS } = require('..')
  const side = Math.floor(MAX_VIDEO_PIXELS / MAX_VIDEO_DIMENSION)
  const poster = { ...DESCRIPTOR, mime: 'image/jpeg' }
  const video = { ...DESCRIPTOR, mime: VIDEO_MIME, width: MAX_VIDEO_DIMENSION, height: side, ms: MAX_VIDEO_MS }
  const pair = [poster, video]
  t.ok(validateParams('post.create', { text: 'x', media: pair }).ok, 'a valid rpc pair')
  t.is(validateRecord({ type: 'post', text: 'x', at: AT, replyTo: null, media: pair }, 1), null, 'a valid core pair')
  t.ok(utf8ByteLength(JSON.stringify(pair)) < utf8ByteLength(JSON.stringify(MEDIA)), 'the pair is smaller than ten descriptors')
  const withPair = (result) => (n, ch) => {
    const out = result(n, ch, false)
    for (const e of out.items || out.entries) {
      if (e.record) e.record = { ...e.record, media: pair }
      else e.media = pair
    }
    return out
  }
  for (const ch of WORST) {
    for (const result of [feedResult, peekResult, logResult]) {
      t.ok(size(withPair(result)(1, ch)) < size(result(1, ch, false)), 'a pair item is smaller than a ten-photo item')
    }
  }
  t.is(FEED_LIMIT_MAX, 26)
  t.is(LOG_LIMIT_MAX, 30)
  t.is(GROUP_LIMIT_MAX, 29)
  t.is(PEEK_SEQS_MAX, 29)
})
