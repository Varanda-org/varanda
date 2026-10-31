'use strict'

// Worst-case response sizes (docs/rpc.md section 2): the page maxima are the
// largest pages whose worst case fits MAX_MESSAGE.

const test = require('brittle')
const { validateRecord } = require('@varanda/core/lib/records')
const { isUsername } = require('@varanda/core/lib/account-link')
const {
  createServerDispatcher,
  validateParams,
  utf8ByteLength,
  MAX_ID,
  MAX_MESSAGE,
  MAX_LIST,
  MAX_NAME,
  MAX_BIO,
  MAX_TEXT,
  MAX_MEDIA_BLOCKS,
  MAX_MEDIA_ITEM_BLOCKS,
  MAX_MEDIA_PER_POST,
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
  GROUP_LIMIT_MAX,
  GROUP_MEMBERS_LIMIT_MAX,
  MAX_GROUP_NAME
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
// The widest avatar: the longest avatar mime and the widest start, blocks
// and bytes (width and height are fixed).
const WORST_AVATAR = { core: HEX, mime: 'image/webp', start: 8184, blocks: 8, bytes: 262144, sha256: HEX, width: 512, height: 512 }

function worstProfile (ch) {
  return { type: 'profile', name: ch.repeat(MAX_NAME), bio: ch.repeat(MAX_BIO), at: AT, avatar: WORST_AVATAR }
}

function worstPost (ch) {
  return { type: 'post', text: ch.repeat(MAX_TEXT), at: AT, replyTo: { author: HEX, seq: SEQ }, media: MEDIA }
}

function worstQuote (ch) {
  return { ...worstPost(ch), replyTo: null, quote: { author: HEX, seq: SEQ } }
}

function size (result) {
  return utf8ByteLength(JSON.stringify({ v: 1, id: MAX_ID, ok: true, result }))
}

function feedResult (n, ch) {
  const item = { kind: 'post', author: HEX, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: { author: HEX, seq: SEQ }, quote: null, media: MEDIA }
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
function peekResult (n, ch) {
  const item = { kind: 'post', author: HEX, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: null, quote: { author: HEX, seq: SEQ }, media: MEDIA, round: 100000, avatar: WORST_AVATAR }
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
  const item = { kind: 'mention', key: HEX, seq: SEQ, at: AT, name: ch.repeat(MAX_NAME), username, seen: 'f'.repeat(32), avatar: WORST_AVATAR }
  return {
    notices: Array(n).fill(item),
    next: { at: AT, key: HEX, seq: SEQ },
    incomplete: true,
    supported: true,
    activity: true
  }
}

function logResult (n, ch) {
  // Quote records retain replyTo: null and add quote, costing 13 bytes more
  // than plain reply records (FeedItems always carry both fields).
  return { key: HEX, entries: Array(n).fill({ seq: SEQ, record: worstQuote(ch) }), invalid: [], entriesTruncated: SEQ }
}

function diaryPeekResult (entries, invalid, missing, ch) {
  return {
    key: HEX,
    length: SEQ,
    entries: Array(entries).fill({ seq: SEQ, record: worstQuote(ch) }),
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
    const repost = { ...post, kind: 'repost', to: post.replyTo, text: null, replyTo: null, quote: null, media: null }
    t.ok(size(quote) <= size(post), 'quote ' + JSON.stringify(ch))
    t.ok(size(repost) < size(post), 'repost ' + JSON.stringify(ch))
  }
})

test('feed.read: FEED_LIMIT_MAX fits, one more does not', (t) => {
  // With MAX_MEDIA_PER_POST maximal descriptors in every item.
  t.is(FEED_LIMIT_MAX, 31)
  t.is(FEED_INCOMPLETE_MAX, 16)
  for (const ch of WORST) t.ok(size(feedResult(FEED_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  const worst = size(feedResult(FEED_LIMIT_MAX, '\ud800'))
  t.comment('feed worst case at ' + FEED_LIMIT_MAX + ' items: ' + worst + ' bytes')
  const overflow = size(feedResult(FEED_LIMIT_MAX + 1, '\ud800'))
  t.comment('feed worst case at ' + (FEED_LIMIT_MAX + 1) + ' items: ' + overflow + ' bytes')
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
  // Lone surrogates are the worst case: one more item of 4-byte characters fits.
  const fourByte = size(feedResult(FEED_LIMIT_MAX + 1, '\u{1f600}'))
  t.comment('feed at ' + (FEED_LIMIT_MAX + 1) + ' items of 4-byte characters: ' + fourByte + ' bytes')
  t.ok(fourByte <= MAX_MESSAGE, 'one more item of 4-byte characters would fit')
})

test('peek.read: PEEK_LIMIT_MAX fits', (t) => {
  // With MAX_MEDIA_PER_POST maximal descriptors in every item.
  for (const ch of WORST) t.ok(size(peekResult(PEEK_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.comment('peek worst case at ' + PEEK_LIMIT_MAX + ' items: ' + size(peekResult(PEEK_LIMIT_MAX, '\ud800')) + ' bytes')
})

test('notices.list: NOTICES_LIMIT_MAX fits', (t) => {
  for (const ch of WORST) t.ok(size(noticesResult(NOTICES_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.comment('notices.list worst case at ' + NOTICES_LIMIT_MAX + ' notices: ' + size(noticesResult(NOTICES_LIMIT_MAX, '\ud800')) + ' bytes')
})

test('log.read: LOG_LIMIT_MAX fits, one more does not', (t) => {
  t.is(LOG_LIMIT_MAX, 36)
  for (const ch of WORST) t.ok(size(logResult(LOG_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.comment('log worst case at ' + LOG_LIMIT_MAX + ' entries: ' + size(logResult(LOG_LIMIT_MAX, '\ud800')) + ' bytes')
  const overflow = size(logResult(LOG_LIMIT_MAX + 1, '\ud800'))
  t.comment('log worst case at ' + (LOG_LIMIT_MAX + 1) + ' entries: ' + overflow + ' bytes')
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
})

test('diary.peek: every partition of PEEK_SEQS_MAX fits with profile and username', (t) => {
  t.is(PEEK_SEQS_MAX, 36)
  const worst = size(diaryPeekResult(PEEK_SEQS_MAX, 0, 0, '\ud800'))
  for (const ch of WORST) t.ok(size(diaryPeekResult(PEEK_SEQS_MAX, 0, 0, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  // Each requested seq contributes to exactly one of entries/invalid/missing.
  // Maximum-width integers conservatively bound every distinct requested seq.
  let largest = 0
  for (let entries = 0; entries <= PEEK_SEQS_MAX; entries++) {
    for (let invalid = 0; invalid <= PEEK_SEQS_MAX - entries; invalid++) {
      const missing = PEEK_SEQS_MAX - entries - invalid
      largest = Math.max(largest, size(diaryPeekResult(entries, invalid, missing, '\ud800')))
    }
  }
  t.is(largest, worst, '36 quote records dominate all partitions, including 36 invalid or missing seqs')
  t.ok(largest <= MAX_MESSAGE)
  t.comment('diary.peek worst case at ' + PEEK_SEQS_MAX + ' entries with profile and username: ' + largest + ' bytes')
  // All three arrays full would describe 108 requests, outside the contract.
  // Keep this counterexample explicit: it cannot be used as a fits proof.
  const impossible = size(diaryPeekResult(PEEK_SEQS_MAX, PEEK_SEQS_MAX, PEEK_SEQS_MAX, '\ud800'))
  t.comment('diary.peek synthetic 36 entries + 36 invalid + 36 missing: ' + impossible + ' bytes (outside contract)')
  t.ok(impossible > MAX_MESSAGE)
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

function groupReadResult (n, ch) {
  const item = { writer: HEX, diary: HEX, seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: { writer: HEX, seq: SEQ }, hidden: false, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20) }
  return { items: Array(n).fill(item), next: { at: AT, writer: HEX, seq: SEQ }, hidden: SEQ, incomplete: true, sealed: SEQ, epoch: { writer: HEX, seq: SEQ }, state: 'rekey-pending' }
}

test('group.read: GROUP_LIMIT_MAX fits', (t) => {
  t.is(GROUP_LIMIT_MAX, 31)
  for (const ch of WORST) t.ok(size(groupReadResult(GROUP_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.comment('group.read worst case at ' + GROUP_LIMIT_MAX + ' items: ' + size(groupReadResult(GROUP_LIMIT_MAX, '\ud800')) + ' bytes')
})

test('group.members: GROUP_MEMBERS_LIMIT_MAX fits', (t) => {
  const member = { member: HEX, name: '\ud800'.repeat(MAX_NAME), username: 'u'.repeat(20), admin: true, banned: true, joinedAt: AT }
  const s = size({ members: Array(GROUP_MEMBERS_LIMIT_MAX).fill(member), total: SEQ })
  t.comment('group.members worst case at ' + GROUP_MEMBERS_LIMIT_MAX + ' members: ' + s + ' bytes')
  t.ok(s <= MAX_MESSAGE)
})

test('community.info: 32 groups with maximal names fit', (t) => {
  const group = { group: HEX, name: '\ud800'.repeat(MAX_GROUP_NAME) }
  const s = size({ community: HEX, name: '\ud800'.repeat(MAX_GROUP_NAME), creator: HEX, groups: Array(32).fill(group), admins: SEQ, state: 'ready', incomplete: true })
  t.comment('community.info worst case at 32 groups: ' + s + ' bytes')
  t.ok(s <= MAX_MESSAGE)
})

test('the dispatcher sends the worst-case feed page unchanged', async (t) => {
  const sent = []
  const d = createServerDispatcher({
    handlers: { 'feed.read': async () => feedResult(FEED_LIMIT_MAX, '\ud800') },
    send: (m) => sent.push(m)
  })
  d.receive({ v: 1, id: 1, method: 'session.open', params: {} })
  d.receive({ v: 1, id: MAX_ID, method: 'feed.read', params: { limit: FEED_LIMIT_MAX } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  t.is(sent[1].ok, true)
  t.is(sent[1].result.items.length, FEED_LIMIT_MAX)
  t.alike(sent[1].result, feedResult(FEED_LIMIT_MAX, '\ud800'))
})
