'use strict'

// Worst-case response sizes (docs/rpc.md section 2): the page maxima are the
// largest pages whose worst case fits MAX_MESSAGE.

const test = require('brittle')
const { validateRecord, validAltList, postAltRecord } = require('@varanda/core/lib/records')
const { fitAlt } = require('@varanda/core/lib/post-alt')
const { fitThumbs } = require('@varanda/core/lib/session')
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
  MAX_ALT,
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
  EXPORT_PAGE_MAX,
  EXPORT_PAGE_BYTES,
  GROUP_LIMIT_DEFAULT,
  GROUP_LIMIT_MAX,
  GROUP_MEMBERS_LIMIT_MAX,
  GROUP_REACTIONS_MAX,
  GROUP_REACTORS_MAX,
  REACTION_MAX_BYTES,
  MAX_GROUP_NAME,
  MAX_GROUP_ABOUT,
  MAX_GROUPS_PER_COMMUNITY,
  COMMUNITY_LIST_MAX,
  MAX_DM_MEDIA,
  DM_MEDIA_CHUNK_BYTES,
  DM_MEDIA_MAX_CHUNKS,
  DM_THREAD_LIMIT_MAX,
  POLL_MAX,
  MAX_POLL_OPTION,
  GROUP_MARKED_LIMIT,
  GROUP_TOPICS_LIMIT,
  GROUP_VOTERS_MAX,
  MAX_EVENT_TITLE,
  MAX_EVENT_PLACE,
  GROUP_EVENTS_LIMIT,
  isEvent,
  MAX_TESTIMONIAL,
  TESTIMONIAL_PENDING_MAX,
  TESTIMONIAL_KEPT_MAX,
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
    blocksChanged: false,
    testimonialsChanged: false,
    momentsChanged: false,
    caughtUp: Array.from({ length: 512 }, (_, i) => i.toString(16).padStart(64, '0'))
  })
  t.ok(merge < MAX_MESSAGE)
  t.comment('seen.merge worst-case result with 512 caught-up keys: ' + merge + ' bytes')
})

// testimonial.pending: a testimonial text refuses control characters and
// lone surrogates, so a 4-byte character is its widest code point.
test('testimonial.pending: worst-case pending and kept lists fit', (t) => {
  t.is(TESTIMONIAL_PENDING_MAX, 64)
  t.is(TESTIMONIAL_KEPT_MAX, 64)
  const row = { from: HEX, seq: SEQ, text: '\u{1f600}'.repeat(MAX_TESTIMONIAL), at: AT }
  const bytes = size({
    items: Array(TESTIMONIAL_PENDING_MAX).fill(row),
    kept: Array(TESTIMONIAL_KEPT_MAX).fill(row),
    incomplete: false
  })
  t.ok(bytes < MAX_MESSAGE)
  t.comment('testimonial.pending worst-case result: ' + bytes + ' bytes')
})

function feedResult (n, ch, preview = true) {
  const item = { kind: 'post', author: HEX, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: { author: HEX, seq: SEQ }, quote: null, media: preview ? null : MEDIA, preview: preview ? CARD : null, avatar: WORST_AVATAR, edited: true }
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

// Every post item carries `edited: true` (a post with an applicable edit, 14 bytes).
// A PeekItem is a FeedItem plus `round` and the author's `avatar`; its worst case is a post with a
// reply or a quote ref (never both; a repost item is smaller).
function peekResult (n, ch, preview = true) {
  const item = { kind: 'post', author: HEX, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: null, quote: { author: HEX, seq: SEQ }, media: preview ? null : MEDIA, preview: preview ? CARD : null, round: 100000, avatar: WORST_AVATAR, edited: true }
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
  return { key: HEX, entries: Array(n).fill({ seq: SEQ, record: worstQuote(ch, preview), edited: true }), invalid: [], entriesTruncated: SEQ }
}

function diaryPeekResult (entries, invalid, missing, ch, preview = true) {
  return {
    key: HEX,
    length: SEQ,
    entries: Array(entries).fill({ seq: SEQ, record: worstQuote(ch, preview) }),
    invalid: Array(invalid).fill(SEQ),
    missing: Array(missing).fill(SEQ),
    profile: { name: ch.repeat(MAX_NAME), bio: ch.repeat(MAX_BIO), avatar: WORST_AVATAR },
    username: 'u'.repeat(20),
    certDate: AT
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
  // With MAX_MEDIA_PER_POST public descriptors and the widest avatar in every item.
  t.is(FEED_LIMIT_MAX, 25)
  t.is(FEED_INCOMPLETE_MAX, 16)
  for (const ch of WORST) t.ok(size(feedResult(FEED_LIMIT_MAX, ch, false)) <= MAX_MESSAGE, JSON.stringify(ch))
  const worst = size(feedResult(FEED_LIMIT_MAX, '\ud800', false))
  t.is(worst, 258524)
  t.comment('feed worst case at ' + FEED_LIMIT_MAX + ' items: ' + worst + ' bytes')
  const overflow = size(feedResult(FEED_LIMIT_MAX + 1, '\ud800', false))
  t.is(overflow, 268046)
  t.comment('feed worst case at ' + (FEED_LIMIT_MAX + 1) + ' items: ' + overflow + ' bytes')
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
  // Lone surrogates are the worst case: one more item of 4-byte characters fits.
  const fourByte = size(feedResult(FEED_LIMIT_MAX + 1, '\u{1f600}', false))
  t.is(fourByte, 211886)
  t.comment('feed at ' + (FEED_LIMIT_MAX + 1) + ' items of 4-byte characters: ' + fourByte + ' bytes')
  t.ok(fourByte <= MAX_MESSAGE, 'one more item of 4-byte characters would fit')
})

test('peek.read: PEEK_LIMIT_MAX fits', (t) => {
  // With MAX_MEDIA_PER_POST public descriptors in every item.
  t.is(PEEK_LIMIT_MAX, 26)
  for (const ch of WORST) t.ok(size(peekResult(PEEK_LIMIT_MAX, ch, false)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.is(size(peekResult(PEEK_LIMIT_MAX, '\ud800', false)), 248222)
  t.comment('peek worst case at ' + PEEK_LIMIT_MAX + ' items: ' + size(peekResult(PEEK_LIMIT_MAX, '\ud800', false)) + ' bytes')
})

// Synthetic node results: runtime attachment belongs to the node tests. Here
// maximal whole lists spend the available wire budget without cutting rows.
test('thumbnail reads fit MAX_MESSAGE and the dispatcher preserves rows and cursors', async (t) => {
  const descriptor = { ...DESCRIPTOR, mime: 'image/jpeg', start: 8190, blocks: 2, bytes: 65536, width: 640, height: 640 }
  const thumbs = Array(MAX_MEDIA_PER_POST).fill(descriptor)
  t.ok(validateParams('post.create', { text: '', media: MEDIA, thumbs }).ok, 'widest thumbnail list is accepted')
  t.is(validateRecord({ type: 'post-thumbs', seq: 1, thumbs, at: AT }, 2), null, 'valid companion record')
  const cost = utf8ByteLength(',"thumbs":' + JSON.stringify(thumbs))
  for (const [method, params, base, field, newestFirst] of [
    ['feed.read', { limit: FEED_LIMIT_MAX }, feedResult(FEED_LIMIT_MAX, '\ud800', false), 'items', false],
    ['peek.read', { limit: PEEK_LIMIT_MAX }, peekResult(PEEK_LIMIT_MAX, '\ud800', false), 'items', true],
    ['diary.peek', { author: HEX, seqs: Array.from({ length: PEEK_SEQS_MAX }, (_, i) => i + 1) }, diaryPeekResult(PEEK_SEQS_MAX, 0, 0, '\ud800', false), 'entries', false]
  ]) {
    const count = Math.floor((MAX_MESSAGE - size(base)) / cost)
    t.ok(count > 0 && count < base[field].length, method + ' only some maximal lists fit')
    const result = {
      ...base,
      [field]: base[field].map((row, i) => ({
        ...row,
        ...((newestFirst ? i < count : i >= base[field].length - count) ? { thumbs } : {})
      }))
    }
    t.is(size(result), size(base) + count * cost, method + ' accounts for every added byte')
    t.ok(size(result) <= MAX_MESSAGE, method + ' fits with the response envelope')
    t.ok(size(result) + cost > MAX_MESSAGE, method + ' another list would overflow')
    t.alike({
      ...result,
      [field]: result[field].map(({ thumbs, ...row }) => row)
    }, base, method + ' all rows and metadata are preserved')
    t.comment(method + ' worst case with ' + count + ' thumbnail lists: ' + size(result) + ' bytes')
    let receive
    const response = new Promise((resolve) => { receive = resolve })
    const dispatcher = createServerDispatcher({
      handlers: {
        [method]: (actual) => {
          t.alike(actual, { ...params, thumbs: true }, method + ' forwards the opt-in')
          return result
        }
      },
      send: (message, json) => { if (message.id === MAX_ID) receive(JSON.parse(json)) }
    })
    dispatcher.receive({ v: 1, id: 1, method: 'session.open', params: {} })
    dispatcher.receive({ v: 1, id: MAX_ID, method, params: { ...params, thumbs: true } })
    const message = await response
    t.is(message.ok, true, method + ' succeeds')
    t.alike(message.result, result, method + ' sends the whole result unchanged')
    dispatcher.close()
  }
})

// The widest valid description list: 10 entries of MAX_ALT code points. A 4-byte
// character costs the most valid bytes; '"' and '\\' are escaped on the wire but
// only 2 bytes each, so a mix is never wider. A lone surrogate would be 6 bytes
// but is invalid.
const ALT_CHARS = ['\u{1f600}', '"', '\\']
function altList (ch) {
  return Array(MAX_MEDIA_PER_POST).fill(ch.repeat(MAX_ALT))
}

test('the widest post-alt record is valid and never larger than the worst post entry', (t) => {
  const worstEntry = utf8ByteLength(JSON.stringify({ seq: SEQ, record: worstQuote('\ud800', false) }))
  for (const ch of ALT_CHARS) {
    const alt = altList(ch)
    t.ok(validAltList(alt), 'valid list of ' + JSON.stringify(ch))
    t.is(validateRecord({ type: 'post-alt', seq: 1, alt, at: AT }, 2), null)
    t.ok(validateParams('post.create', { text: '', media: MEDIA, alt }).ok, 'accepted by post.create ' + JSON.stringify(ch))
    const entry = utf8ByteLength(JSON.stringify({ seq: SEQ, record: { type: 'post-alt', seq: SEQ, alt, at: AT } }))
    t.ok(entry <= worstEntry, 'log.read entry ' + entry + ' <= ' + worstEntry)
  }
  const mixed = Array.from({ length: MAX_MEDIA_PER_POST }, (_, i) => ALT_CHARS[i % ALT_CHARS.length].repeat(MAX_ALT))
  t.ok(validAltList(mixed) && utf8ByteLength(JSON.stringify(mixed)) <= utf8ByteLength(JSON.stringify(altList(ALT_CHARS[0]))), 'a mix is never wider')
  const lone = altList('\ud800')
  t.absent(validAltList(lone), 'lone surrogates are invalid')
  t.ok(validateRecord({ type: 'post-alt', seq: 1, alt: lone, at: AT }, 2) !== null)
  t.absent(validateParams('post.create', { text: '', media: MEDIA, alt: lone }).ok)
  try { postAltRecord({ seq: 1, alt: lone, at: AT }); t.fail('the builder accepted lone surrogates') } catch (err) { t.is(err.message, 'alt-invalid') }
})

test('alt reads fit MAX_MESSAGE and the dispatcher preserves rows and cursors', async (t) => {
  // Rows of 4-byte characters (a lone surrogate would leave no room for a single list in a feed page).
  const alt = altList(ALT_CHARS[0])
  const cost = utf8ByteLength(',"alt":' + JSON.stringify(alt))
  for (const [method, params, base, field, newestFirst] of [
    ['feed.read', { limit: FEED_LIMIT_MAX }, feedResult(FEED_LIMIT_MAX, '\u{1f600}', false), 'items', false],
    ['peek.read', { limit: PEEK_LIMIT_MAX }, peekResult(PEEK_LIMIT_MAX, '\u{1f600}', false), 'items', true],
    ['diary.peek', { author: HEX, seqs: Array.from({ length: PEEK_SEQS_MAX }, (_, i) => i + 1) }, diaryPeekResult(PEEK_SEQS_MAX, 0, 0, '\u{1f600}', false), 'entries', false]
  ]) {
    const count = Math.floor((MAX_MESSAGE - size(base)) / cost)
    t.ok(count > 0 && count < base[field].length, method + ' only some maximal lists fit')
    const result = {
      ...base,
      [field]: base[field].map((row, i) => ({
        ...row,
        ...((newestFirst ? i < count : i >= base[field].length - count) ? { alt } : {})
      }))
    }
    t.is(size(result), size(base) + count * cost, method + ' accounts for every added byte')
    t.ok(size(result) <= MAX_MESSAGE, method + ' fits with the response envelope')
    t.ok(size(result) + cost > MAX_MESSAGE, method + ' another list would overflow')
    t.alike({
      ...result,
      [field]: result[field].map(({ alt, ...row }) => row)
    }, base, method + ' all rows and metadata are preserved')
    t.comment(method + ' worst case with ' + count + ' description lists: ' + size(result) + ' bytes')
    let receive
    const response = new Promise((resolve) => { receive = resolve })
    const dispatcher = createServerDispatcher({
      handlers: {
        [method]: (actual) => {
          t.alike(actual, { ...params, alt: true }, method + ' forwards the opt-in')
          return result
        }
      },
      send: (message, json) => { if (message.id === MAX_ID) receive(JSON.parse(json)) }
    })
    dispatcher.receive({ v: 1, id: 1, method: 'session.open', params: {} })
    dispatcher.receive({ v: 1, id: MAX_ID, method, params: { ...params, alt: true } })
    const message = await response
    t.is(message.ok, true, method + ' succeeds')
    t.alike(message.result, result, method + ' sends the whole result unchanged')
    dispatcher.close()
  }
})

test('fitAlt keeps whole lists newest first by exact byte accounting, and fitThumbs after it stays within MAX_MESSAGE', (t) => {
  const alt = altList(ALT_CHARS[0])
  const descriptor = { ...DESCRIPTOR, mime: 'image/jpeg', start: 8190, blocks: 2, bytes: 65536, width: 640, height: 640 }
  const thumbs = Array(MAX_MEDIA_PER_POST).fill(descriptor)
  const cost = utf8ByteLength(',"alt":' + JSON.stringify(alt))
  const base = feedResult(FEED_LIMIT_MAX, '\u{1f600}', false)
  // Distinct, decreasing times so "newest first" is the row order here.
  const rows = base.items.map((row, i) => ({ ...row, at: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString(), alt, thumbs }))
  const bare = { ...base, items: rows.map(({ alt: a, thumbs: th, ...row }) => row) }
  const count = Math.floor((MAX_MESSAGE - size(bare)) / cost)
  t.ok(count > 0 && count < rows.length, 'only some maximal lists fit')
  const fitted = fitAlt({ ...base, items: rows }, 'items', (i) => i.at)
  const withAlt = fitted.filter((i) => Array.isArray(i.alt))
  t.is(withAlt.length, count, 'exactly the lists that fit')
  t.alike(fitted.slice(0, count).map((i) => Array.isArray(i.alt)), Array(count).fill(true), 'the newest rows keep theirs')
  t.is(size({ ...base, items: fitted.map(({ thumbs: th, ...row }) => row) }), size(bare) + count * cost, 'exact accounting')
  t.ok(size({ ...base, items: fitted.map(({ thumbs: th, ...row }) => row) }) + cost > MAX_MESSAGE, 'one more would overflow')
  t.alike(fitted.map(({ alt: a, ...row }) => row), rows.map(({ alt: a, ...row }) => row), 'rows and order are preserved')
  const both = fitThumbs({ ...base, items: fitted }, 'items', (i) => i.at)
  t.ok(size({ ...base, items: both }) <= MAX_MESSAGE, 'both opt-ins fit together')
  t.alike(both.map(({ thumbs: th, ...row }) => row), fitted.map(({ thumbs: th, ...row }) => row), 'thumbnails never remove a description or a row')
})

test('notices.list: NOTICES_LIMIT_MAX fits', (t) => {
  for (const ch of WORST) t.ok(size(noticesResult(NOTICES_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.comment('notices.list worst case at ' + NOTICES_LIMIT_MAX + ' notices: ' + size(noticesResult(NOTICES_LIMIT_MAX, '\ud800')) + ' bytes')
})

test('log.read: LOG_LIMIT_MAX fits, one more does not', (t) => {
  t.is(LOG_LIMIT_MAX, 30)
  for (const ch of WORST) t.ok(size(logResult(LOG_LIMIT_MAX, ch, false)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.is(size(logResult(LOG_LIMIT_MAX, '\ud800', false)), 260368)
  t.comment('log worst case at ' + LOG_LIMIT_MAX + ' entries: ' + size(logResult(LOG_LIMIT_MAX, '\ud800', false)) + ' bytes')
  const overflow = size(logResult(LOG_LIMIT_MAX + 1, '\ud800', false))
  t.is(overflow, 269041)
  t.comment('log worst case at ' + (LOG_LIMIT_MAX + 1) + ' entries: ' + overflow + ' bytes')
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
})

function exportResult (entries, invalid, follows = []) {
  return { key: HEX, head: null, follows, entries, invalid, next: { part: 'diary', offset: SEQ, until: SEQ } }
}

test('export.read: a diary page at the byte budget and 500 follows fit', (t) => {
  t.is(EXPORT_PAGE_MAX, 500)
  t.is(EXPORT_PAGE_BYTES, 196608)
  for (const ch of WORST) {
    const item = { seq: SEQ, record: worstQuote(ch, false) }
    const cost = utf8ByteLength(JSON.stringify(item)) + 1
    // Largest page the core builds: items summed (+1 each) never pass the budget.
    const n = Math.min(EXPORT_PAGE_MAX, Math.floor(EXPORT_PAGE_BYTES / cost))
    t.ok(size(exportResult(Array(n).fill(item), [])) <= MAX_MESSAGE, JSON.stringify(ch))
  }
  const reason = { seq: SEQ, reason: 'x'.repeat(64) }
  const list = Array(EXPORT_PAGE_MAX).fill(reason)
  t.ok(size(exportResult([], list)) <= MAX_MESSAGE, '500 invalid')
  t.ok(size(exportResult([], [], Array(FOLLOW_LIMIT_MAX).fill(HEX))) <= MAX_MESSAGE, '500 follows')
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
  t.is(largest, 253803)
  t.ok(largest <= MAX_MESSAGE)
  t.is(size(diaryPeekResult(PEEK_SEQS_MAX + 1, 0, 0, '\ud800', false)), 262462)
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

// The widest reaction on the wire: isReaction caps it at REACTION_MAX_BYTES
// of UTF-8 and JSON escapes none of its code points, so an ASCII stand-in of
// that length weighs the same. A count is at most a safe integer.
const WORST_EMOJI = 'e'.repeat(REACTION_MAX_BYTES)
const WORST_REACTIONS = Array(GROUP_REACTIONS_MAX).fill({ emoji: WORST_EMOJI, count: SEQ, mine: false })

// Every item carries the compact reaction summary, GROUP_REACTIONS_MAX of the
// widest ones (`reactions` null leaves it out). `newest` adds the widest
// firstUnread, which only the newest page of a group carries.
function groupReadResult (n, ch, media, card = null, reactions = WORST_REACTIONS, newest = false) {
  const item = { writer: HEX, diary: HEX, seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: { writer: HEX, seq: SEQ }, fwd: 1, media, card, hidden: false, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), ...(reactions === null ? {} : { reactions }) }
  const result = { items: Array(n).fill(item), next: { at: AT, writer: HEX, seq: SEQ }, hidden: SEQ, incomplete: true, sealed: SEQ, epoch: { writer: HEX, seq: SEQ }, state: 'rekey-pending' }
  if (newest) result.firstUnread = { at: AT, writer: HEX, seq: SEQ }
  return result
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
  t.is(worst, 259854)
  t.is(overflow, 269833)
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

test('community.info: maximal names and description fit', (t) => {
  t.is(MAX_GROUPS_PER_COMMUNITY, 32)
  const group = { group: HEX, name: '\ud800'.repeat(MAX_GROUP_NAME), visibility: 'private', join: 'approval', role: 'creator', general: false, last: { name: '\ud800'.repeat(MAX_NAME), username: 'u'.repeat(20), preview: '\ud800'.repeat(140), at: AT, mine: false, hidden: false }, unread: 99 }
  for (const ch of ['😀', '\ud800']) {
    const about = ch.repeat(MAX_GROUP_ABOUT)
    const s = size({ community: HEX, name: '\ud800'.repeat(MAX_GROUP_NAME), about, join: 'approval', creator: HEX, role: 'creator', state: 'ready', members: SEQ, admins: SEQ, groups: Array(MAX_GROUPS_PER_COMMUNITY).fill(group), general: HEX, incomplete: true, leavePending: true })
    t.comment('community.info at ' + MAX_GROUPS_PER_COMMUNITY + ' groups with about of ' + JSON.stringify(ch) + ': ' + s + ' bytes')
    t.ok(s <= MAX_MESSAGE)
  }
})

test('group.standalone: GROUP_LIMIT_MAX rows with maximal names and images fit', (t) => {
  const row = { group: HEX, name: '\ud800'.repeat(MAX_GROUP_NAME), image: PRIVATE_CARD_IMAGE, imageAuthor: HEX, visibility: 'private', join: 'approval', role: 'creator', general: false, last: { name: '\ud800'.repeat(MAX_NAME), username: 'u'.repeat(20), preview: '\ud800'.repeat(140), at: AT, mine: false, hidden: false }, unread: 99 }
  const s = size({ groups: Array(GROUP_LIMIT_MAX).fill(row), total: SEQ })
  t.comment('group.standalone worst case at ' + GROUP_LIMIT_MAX + ' rows: ' + s + ' bytes')
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

// A reaction emoji at the REACTION_MAX_BYTES cap (isReaction itself accepts
// at most 30 UTF-8 bytes, and JSON escapes none of them): a bound.
const DM_REACTION_BOUND = '\u{1f600}'.repeat(REACTION_MAX_BYTES / 4)

// Every message at MAX_TEXT code points, a maximal card and both people's
// reactions at the emoji cap, which the sealed frame (DM_INNER_BYTES) cannot
// even carry together: a bound, not a message that exists.
function dmThreadResult (n, ch, card = true) {
  const reactions = [{ emoji: DM_REACTION_BOUND, mine: false }, { emoji: DM_REACTION_BOUND, mine: true }]
  // A bound reply whose message is kept carries replyFrom, wider than
  // replyMissing: true, and a row never carries both.
  const message = { id: 'f'.repeat(32), from: HEX, text: ch.repeat(MAX_TEXT), replyTo: 'f'.repeat(32), replyFrom: HEX, fwd: 1, at: AT, mine: false, media: card ? null : widestDmMedia(MAX_DM_MEDIA), card: card ? DM_CARD : null, reactions }
  return { messages: Array(n).fill(message), next: 'f'.repeat(32), folder: 'request', blocked: false, firstUnread: 'f'.repeat(32) }
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
  t.is(DM_THREAD_LIMIT_MAX, 41)
  t.ok(validateParams('dm.thread', { peer: HEX, limit: DM_THREAD_LIMIT_MAX }).ok)
  t.absent(validateParams('dm.thread', { peer: HEX, limit: DM_THREAD_LIMIT_MAX + 1 }).ok)
  for (const ch of DM_WORST) t.ok(size(dmThreadResult(DM_THREAD_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  const worst = size(dmThreadResult(DM_THREAD_LIMIT_MAX, '\u{1f600}'))
  t.comment('dm.thread worst case at ' + DM_THREAD_LIMIT_MAX + ' messages: ' + worst + ' bytes')
  const overflow = size(dmThreadResult(DM_THREAD_LIMIT_MAX + 1, '\u{1f600}'))
  t.is(worst, 262091)
  t.is(overflow, 268479)
  t.comment('dm.thread worst case at ' + (DM_THREAD_LIMIT_MAX + 1) + ' messages: ' + overflow + ' bytes')
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
})

test('dm.thread: a reactable:false row (no reactions) is never larger than the worst reactable row', (t) => {
  for (const ch of DM_WORST) {
    for (const card of [true, false]) {
      const worst = dmThreadResult(1, ch, card).messages[0]
      const { reactions, ...rest } = worst
      const unreactable = { ...rest, reactable: false }
      t.ok(utf8ByteLength(JSON.stringify(unreactable)) < utf8ByteLength(JSON.stringify(worst)), JSON.stringify(ch) + (card ? ' card' : ' media'))
    }
  }
  const page = dmThreadResult(DM_THREAD_LIMIT_MAX, '\u{1f600}')
  const { reactions, ...rest } = page.messages[0]
  t.ok(size({ ...page, messages: Array(DM_THREAD_LIMIT_MAX).fill({ ...rest, reactable: false }) }) < size(page), 'so the pinned page maximum holds')
})

test('dm.thread: a replyMissing or bare-id row is never larger than the worst bound row', (t) => {
  for (const ch of DM_WORST) {
    for (const card of [true, false]) {
      const worst = dmThreadResult(1, ch, card).messages[0]
      const { replyFrom, ...bare } = worst
      const missing = { ...bare, replyMissing: true }
      t.ok(utf8ByteLength(JSON.stringify(missing)) < utf8ByteLength(JSON.stringify(worst)), JSON.stringify(ch) + (card ? ' card' : ' media'))
      t.ok(utf8ByteLength(JSON.stringify(bare)) < utf8ByteLength(JSON.stringify(missing)))
    }
  }
})

// A reaction to a momento (inner v5) carries `moment` but one emoji of text,
// no reply, media, card or forward: the pinned page maximum still holds.
test('dm.thread: a momento reaction row is never larger than the worst row', (t) => {
  for (const card of [true, false]) {
    const worst = dmThreadResult(1, '\u{1f600}', card).messages[0]
    const { replyFrom, ...rest } = worst
    const reaction = { ...rest, text: DM_REACTION_BOUND, replyTo: null, fwd: 0, media: null, card: null, moment: Number.MAX_SAFE_INTEGER }
    t.ok(utf8ByteLength(JSON.stringify(reaction)) < utf8ByteLength(JSON.stringify(worst)), card ? 'card' : 'media')
  }
  const page = dmThreadResult(DM_THREAD_LIMIT_MAX, '\u{1f600}')
  const { replyFrom, ...rest } = page.messages[0]
  const reaction = { ...rest, text: DM_REACTION_BOUND, replyTo: null, fwd: 0, media: null, card: null, moment: Number.MAX_SAFE_INTEGER }
  t.ok(size({ ...page, messages: Array(DM_THREAD_LIMIT_MAX).fill(reaction) }) < size(page))
  t.is(size(page), 262091, 'the pinned worst case is unchanged')
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

test('group.read: maximal private cards and reaction summaries fit, one more does not', (t) => {
  t.is(GROUP_LIMIT_MAX, 26)
  t.is(GROUP_REACTIONS_MAX, 12)
  for (const ch of WORST) {
    const worst = groupReadResult(GROUP_LIMIT_MAX, ch, null, PRIVATE_CARD, WORST_REACTIONS, true)
    t.ok(size(worst) <= MAX_MESSAGE)
    t.ok(size(groupReadResult(GROUP_LIMIT_MAX, ch, null, CARD, WORST_REACTIONS, true)) < size(worst))
  }
  const worst = size(groupReadResult(GROUP_LIMIT_MAX, '\ud800', null, PRIVATE_CARD, WORST_REACTIONS, true))
  const overflow = size(groupReadResult(GROUP_LIMIT_MAX + 1, '\ud800', null, PRIVATE_CARD, WORST_REACTIONS, true))
  t.is(worst, 262032)
  t.is(overflow, 272089)
  t.ok(overflow > MAX_MESSAGE)
  t.is(utf8ByteLength(JSON.stringify(WORST_REACTIONS)), 1093, 'twelve maximal summaries')
  // Without reactions the page would still hold 29 items, as before.
  t.ok(size(groupReadResult(29, '\ud800', null, PRIVATE_CARD, null)) <= MAX_MESSAGE)
  t.comment('group.read worst case with reactions at ' + GROUP_LIMIT_MAX + ' items: ' + worst + ' bytes, ' + (GROUP_LIMIT_MAX + 1) + ': ' + overflow)
})

// The who-reacted answer for one message: every emoji it may carry, each
// with GROUP_REACTORS_MAX diary keys.
function whoReactedResult (k) {
  return { reactions: Array(GROUP_REACTIONS_MAX).fill({ emoji: WORST_EMOJI, count: SEQ, by: Array(k).fill(HEX) }) }
}

test('who reacted: GROUP_REACTORS_MAX keys per emoji fit, one more does not', (t) => {
  t.is(GROUP_REACTORS_MAX, 324)
  const worst = size(whoReactedResult(GROUP_REACTORS_MAX))
  const overflow = size(whoReactedResult(GROUP_REACTORS_MAX + 1))
  t.is(worst, 261574)
  t.is(overflow, 262378)
  t.ok(worst <= MAX_MESSAGE)
  t.ok(overflow > MAX_MESSAGE, 'largest that fits')
  t.comment('who reacted worst case at ' + GROUP_REACTORS_MAX + ' keys per emoji: ' + worst + ' bytes')
})

test('page.feed: maximal media lists fit the shared feed limit', (t) => {
  const result = { items: feedResult(FEED_LIMIT_MAX, '\ud800', false).items, incomplete: false }
  t.is(size(result), 238123)
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
  t.is(FEED_LIMIT_MAX, 25)
  t.is(LOG_LIMIT_MAX, 30)
  t.is(GROUP_LIMIT_MAX, 26)
  t.is(PEEK_SEQS_MAX, 29)
})

// Polls (docs/rpc.md): POLL_MAX options of MAX_POLL_OPTION characters, and
// a summary with the widest counts and a pick. An option refuses lone
// surrogates and line breaks, so its widest valid character is a 4-byte one;
// the sizes below use lone surrogates anyway (6 bytes each on the wire), an
// upper bound of every valid option.
const pollOf = (ch) => Array.from({ length: POLL_MAX }, (_, i) => String(i) + ch.repeat(MAX_POLL_OPTION - 1))
const WORST_POLL = pollOf('\ud800')
const WIDEST_VALID_POLL = pollOf('\u{1f600}')

// mine is null: no vote is the widest value (4 bytes against 1 for an index).
function worstPollSummary () {
  return { options: WORST_POLL, totals: Array(POLL_MAX).fill(SEQ), mine: null }
}

// A poll post is a root post: replyTo null, no media, preview or quote.
function worstPollPost (ch) {
  return { type: 'post', text: ch.repeat(MAX_TEXT), at: AT, replyTo: null, poll: WORST_POLL }
}

test('poll posts: the widest valid poll record is valid and bounded, and smaller than the worst quote', (t) => {
  t.is(validateRecord({ ...worstPollPost('a'), poll: WORST_POLL }, 1), 'poll-invalid', 'the size bound itself is no valid poll')
  t.ok(utf8ByteLength(JSON.stringify(WIDEST_VALID_POLL)) <= utf8ByteLength(JSON.stringify(WORST_POLL)), 'the bound covers the widest valid poll')
  for (const ch of WORST) {
    const record = { ...worstPollPost(ch), poll: WIDEST_VALID_POLL }
    t.is(validateRecord(record, 1), null, 'valid core record ' + JSON.stringify(ch))
    t.ok(validateParams('post.create', { text: record.text, poll: record.poll }).ok, 'valid rpc poll ' + JSON.stringify(ch))
    t.ok(utf8ByteLength(JSON.stringify(worstPollPost(ch))) < utf8ByteLength(JSON.stringify(worstQuote(ch, false))), 'smaller than a ten-photo quote ' + JSON.stringify(ch))
  }
  t.comment('worst poll post record: ' + utf8ByteLength(JSON.stringify(worstPollPost('\ud800'))) + ' bytes')
})

test('poll posts: feed, peek and log items stay under the page maxima', (t) => {
  // A FeedItem or PeekItem of a poll post carries `poll` (no media, no
  // preview); a log entry carries the record.
  const withPoll = (result) => (n, ch) => {
    const out = result(n, ch, false)
    const items = out.items || out.entries
    for (let i = 0; i < items.length; i++) {
      const e = items[i]
      items[i] = e.record ? { ...e, record: worstPollPost(ch) } : { ...e, replyTo: null, quote: null, media: null, preview: null, poll: WORST_POLL }
    }
    return out
  }
  for (const ch of WORST) {
    for (const result of [feedResult, peekResult, logResult]) {
      t.ok(size(withPoll(result)(1, ch)) < size(result(1, ch, false)), 'a poll item is smaller than a ten-photo item ' + JSON.stringify(ch))
    }
  }
  t.ok(size(withPoll(feedResult)(FEED_LIMIT_MAX, '\ud800')) <= MAX_MESSAGE)
  t.ok(size(withPoll(peekResult)(PEEK_LIMIT_MAX, '\ud800')) <= MAX_MESSAGE)
  t.ok(size(withPoll(logResult)(LOG_LIMIT_MAX, '\ud800')) <= MAX_MESSAGE)
})

test('diary.peek: PEEK_SEQS_MAX poll posts fit with profile and username', (t) => {
  t.is(PEEK_SEQS_MAX, 29)
  const polls = (ch) => ({ ...diaryPeekResult(0, 0, 0, ch, false), entries: Array(PEEK_SEQS_MAX).fill({ seq: SEQ, record: worstPollPost(ch) }) })
  for (const ch of WORST) {
    t.ok(size(polls(ch)) <= MAX_MESSAGE, JSON.stringify(ch))
    t.ok(size(polls(ch)) < size(diaryPeekResult(PEEK_SEQS_MAX, 0, 0, ch, false)), 'below the quote worst case ' + JSON.stringify(ch))
  }
  t.comment('diary.peek at ' + PEEK_SEQS_MAX + ' poll posts: ' + size(polls('\ud800')) + ' bytes')
})

// The topic marker of a marked group.read item: the root the item opens or
// belongs to, and whether that root carries a poll.
const WORST_MARK = { writer: HEX, seq: SEQ, poll: false }

// A marked page: every item carries `topic`, and a topic read also carries
// the root's poll summary. Only the newest page outside a topic carries
// firstUnread; the bound has both.
function markedGroupReadResult (n, ch, card = PRIVATE_CARD) {
  const result = groupReadResult(n, ch, null, card, WORST_REACTIONS, true)
  result.items = result.items.map((item) => ({ ...item, topic: WORST_MARK }))
  result.poll = worstPollSummary()
  // A root carries a poll or an event, never both; the event summary is the smaller one.
  result.event = { writer: HEX, seq: SEQ, ...WORST_EVENT, totals: [SEQ, SEQ], mine: 1 }
  return result
}

test('group.read: unmarked pages are unchanged', (t) => {
  const v = validateParams('group.read', { group: HEX })
  t.ok(v.ok)
  t.is(v.value.limit, GROUP_LIMIT_MAX, 'the unmarked default stays GROUP_LIMIT_MAX')
  t.absent('marks' in v.value)
  t.is(validateParams('group.read', { group: HEX, marks: false }).value.limit, GROUP_LIMIT_MAX)
  t.is(size(groupReadResult(GROUP_LIMIT_MAX, '\ud800', null, PRIVATE_CARD, WORST_REACTIONS, true)), 262032, 'the same bytes as before marks, plus firstUnread on the newest page')
  t.absent('topic' in groupReadResult(1, '\ud800', null, PRIVATE_CARD).items[0])
})

test('group.read: GROUP_MARKED_LIMIT marked items with a poll summary fit', (t) => {
  t.is(GROUP_MARKED_LIMIT, 24)
  t.is(validateParams('group.read', { group: HEX, marks: true }).value.limit, GROUP_MARKED_LIMIT)
  t.is(validateParams('group.read', { group: HEX, topic: { writer: HEX, seq: SEQ } }).value.limit, GROUP_MARKED_LIMIT)
  t.absent(validateParams('group.read', { group: HEX, marks: true, limit: GROUP_MARKED_LIMIT + 1 }).ok)
  const mark = { ...WORST_MARK, poll: true }
  t.is(utf8ByteLength(JSON.stringify(mark)), utf8ByteLength(JSON.stringify(WORST_MARK)) - 1, 'poll: false is the widest marker')
  for (const ch of WORST) {
    t.ok(size(markedGroupReadResult(GROUP_MARKED_LIMIT, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
    t.ok(size(markedGroupReadResult(GROUP_MARKED_LIMIT, ch, CARD)) <= MAX_MESSAGE, 'public card ' + JSON.stringify(ch))
  }
  const worst = size(markedGroupReadResult(GROUP_MARKED_LIMIT, '\ud800'))
  t.ok(size(markedGroupReadResult(GROUP_LIMIT_MAX, '\ud800')) > MAX_MESSAGE, 'a marked page of GROUP_LIMIT_MAX items would not fit')
  t.comment('group.read marked worst case at ' + GROUP_MARKED_LIMIT + ' items: ' + worst + ' bytes, ' + (MAX_MESSAGE - worst) + ' to spare')
})

// A group.topics item: the root's text and author, its hidden flag, the
// reply count, the time of the last reply and the poll summary.
function topicsResult (n, ch) {
  const item = { writer: HEX, diary: HEX, seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), hidden: false, replies: SEQ, last: AT, poll: worstPollSummary() }
  return { items: Array(n).fill(item), next: { at: AT, writer: HEX, seq: SEQ }, incomplete: true }
}

test('group.topics: a full page fits', (t) => {
  t.is(GROUP_TOPICS_LIMIT, 30)
  t.is(validateParams('group.topics', { group: HEX }).value.limit, GROUP_TOPICS_LIMIT)
  t.absent(validateParams('group.topics', { group: HEX, limit: GROUP_TOPICS_LIMIT + 1 }).ok)
  for (const ch of WORST) t.ok(size(topicsResult(GROUP_TOPICS_LIMIT, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  const worst = size(topicsResult(GROUP_TOPICS_LIMIT, '\ud800'))
  t.is(worst, 251255)
  t.ok(size(topicsResult(GROUP_TOPICS_LIMIT + 1, '\ud800')) <= MAX_MESSAGE, 'one item to spare')
  t.ok(size(topicsResult(GROUP_TOPICS_LIMIT + 2, '\ud800')) > MAX_MESSAGE)
  t.comment('group.topics worst case at ' + GROUP_TOPICS_LIMIT + ' topics: ' + worst + ' bytes')
})

// The who-voted answer for one group poll: every option, each with
// GROUP_VOTERS_MAX diary keys.
function votersResult (k) {
  return { voters: Array.from({ length: POLL_MAX }, (_, pick) => ({ pick, count: SEQ, by: Array(k).fill(HEX) })) }
}

test('group.voters: a full page fits', (t) => {
  t.is(GROUP_VOTERS_MAX, 900)
  const worst = size(votersResult(GROUP_VOTERS_MAX))
  t.is(worst, 241427)
  t.ok(worst <= MAX_MESSAGE)
  let largest = GROUP_VOTERS_MAX
  while (size(votersResult(largest + 1)) <= MAX_MESSAGE) largest++
  t.is(largest, 977, 'the largest list that would fit')
  t.comment('group.voters worst case at ' + GROUP_VOTERS_MAX + ' keys per option: ' + worst + ' bytes')
})

// Eventos (docs/rpc.md): a title of MAX_EVENT_TITLE and a place of
// MAX_EVENT_PLACE characters, an end and a start. Like a poll option, a
// title or place refuses lone surrogates and line breaks, so the widest valid
// character is a 4-byte one; the sizes below use lone surrogates anyway (6
// bytes each on the wire), an upper bound of every valid event. The instants
// are the 24-byte canonical form, wider than null.
const WORST_EVENT_INSTANT = '2099-12-31T23:59:59.999Z'
function eventOf (ch) {
  return { title: ch.repeat(MAX_EVENT_TITLE), start: WORST_EVENT_INSTANT, end: WORST_EVENT_INSTANT, place: ch.repeat(MAX_EVENT_PLACE) }
}
const WORST_EVENT = eventOf('\ud800')
const WIDEST_VALID_EVENT = { ...eventOf('\u{1f600}'), start: '2099-12-30T23:59:59.999Z' }

// An event post is a root post: replyTo null, no media, preview, quote or poll.
function worstEventPost (ch) {
  return { type: 'post', text: ch.repeat(MAX_TEXT), at: AT, replyTo: null, event: eventOf(ch) }
}

test('event posts: the widest valid event record is valid and bounded, and smaller than the worst quote', (t) => {
  t.is(isEvent(WORST_EVENT), false, 'the size bound itself is no valid event')
  t.ok(utf8ByteLength(JSON.stringify(WIDEST_VALID_EVENT)) <= utf8ByteLength(JSON.stringify(WORST_EVENT)), 'the bound covers the widest valid event')
  for (const ch of WORST) {
    const record = { ...worstEventPost(ch), event: WIDEST_VALID_EVENT }
    t.is(validateRecord(record, 1), null, 'valid core record ' + JSON.stringify(ch))
    t.ok(validateParams('post.create', { text: record.text, event: record.event }).ok, 'valid rpc event ' + JSON.stringify(ch))
    t.ok(validateParams('group.post', { group: HEX, text: 'a' + ch.repeat(MAX_TEXT - 1), event: record.event }).ok, 'valid group.post event ' + JSON.stringify(ch))
    t.ok(utf8ByteLength(JSON.stringify(worstEventPost(ch))) < utf8ByteLength(JSON.stringify(worstQuote(ch, false))), 'smaller than a ten-photo quote ' + JSON.stringify(ch))
  }
  t.comment('worst event post record: ' + utf8ByteLength(JSON.stringify(worstEventPost('\ud800'))) + ' bytes')
})

test('event posts: feed, peek and log items stay under the page maxima', (t) => {
  // A FeedItem or PeekItem of an event post carries `event` (no media, no
  // preview); a log entry carries the record.
  const withEvent = (result) => (n, ch) => {
    const out = result(n, ch, false)
    const items = out.items || out.entries
    for (let i = 0; i < items.length; i++) {
      const e = items[i]
      items[i] = e.record ? { ...e, record: worstEventPost(ch) } : { ...e, replyTo: null, quote: null, media: null, preview: null, event: eventOf(ch) }
    }
    return out
  }
  for (const ch of WORST) {
    for (const result of [feedResult, peekResult, logResult]) {
      t.ok(size(withEvent(result)(1, ch)) < size(result(1, ch, false)), 'an event item is smaller than a ten-photo item ' + JSON.stringify(ch))
    }
  }
  t.ok(size(withEvent(feedResult)(FEED_LIMIT_MAX, '\ud800')) <= MAX_MESSAGE)
  t.ok(size(withEvent(peekResult)(PEEK_LIMIT_MAX, '\ud800')) <= MAX_MESSAGE)
  t.ok(size(withEvent(logResult)(LOG_LIMIT_MAX, '\ud800')) <= MAX_MESSAGE)
})

test('diary.peek: PEEK_SEQS_MAX event posts fit with profile and username', (t) => {
  t.is(PEEK_SEQS_MAX, 29)
  const events = (ch) => ({ ...diaryPeekResult(0, 0, 0, ch, false), entries: Array(PEEK_SEQS_MAX).fill({ seq: SEQ, record: worstEventPost(ch) }) })
  for (const ch of WORST) {
    t.ok(size(events(ch)) <= MAX_MESSAGE, JSON.stringify(ch))
    t.ok(size(events(ch)) < size(diaryPeekResult(PEEK_SEQS_MAX, 0, 0, ch, false)), 'below the quote worst case ' + JSON.stringify(ch))
  }
  t.comment('diary.peek at ' + PEEK_SEQS_MAX + ' event posts: ' + size(events('\ud800')) + ' bytes')
})

// A group.events item: the root's text and author, its hidden flag, the
// event, the going and maybe totals and the caller's pick (null is widest).
function eventsResult (n, ch) {
  const item = { writer: HEX, diary: HEX, seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), hidden: false, event: eventOf(ch), totals: [SEQ, SEQ], mine: null }
  return { items: Array(n).fill(item), next: { at: AT, writer: HEX, seq: SEQ }, incomplete: true }
}

test('group.events: a full page fits', (t) => {
  t.is(GROUP_EVENTS_LIMIT, 30)
  for (const ch of WORST) t.ok(size(eventsResult(GROUP_EVENTS_LIMIT, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  const worst = size(eventsResult(GROUP_EVENTS_LIMIT, '\ud800'))
  t.ok(worst <= MAX_MESSAGE)
  t.ok(size(eventsResult(GROUP_EVENTS_LIMIT + 1, '\ud800')) <= MAX_MESSAGE, 'one item to spare')
  t.comment('group.events worst case at ' + GROUP_EVENTS_LIMIT + ' events: ' + worst + ' bytes')
})
