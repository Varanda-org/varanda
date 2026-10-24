'use strict'

// Worst-case response sizes (docs/rpc.md section 2): the page maxima are the
// largest pages whose worst case fits MAX_MESSAGE.

const test = require('brittle')
const { validateRecord } = require('../../core/lib/records')
const {
  createServerDispatcher,
  utf8ByteLength,
  MAX_ID,
  MAX_MESSAGE,
  MAX_LIST,
  MAX_NAME,
  MAX_BIO,
  MAX_TEXT,
  LOG_LIMIT_MAX,
  FEED_LIMIT_MAX,
  FOLLOW_LIMIT_MAX
} = require('..')

const HEX = 'f'.repeat(64)
const SEQ = Number.MAX_SAFE_INTEGER
const AT = new Date(8.64e15).toISOString() // '+275760-09-13T00:00:00.000Z', the longest canonical ISO
// A lone surrogate is one char (code point) for records.js and the most
// expensive one on the wire: JSON.stringify writes it as \udXXX (6 bytes).
// A 4-byte UTF-8 character (4 bytes) and '"' or '\\' (2 bytes) are cheaper,
// and every other JSON-escaped character is forbidden in names and texts.
const WORST = ['\ud800', '\u{1f600}', '"', '\\', '\n']

function size (result) {
  return utf8ByteLength(JSON.stringify({ v: 1, id: MAX_ID, ok: true, result }))
}

function feedResult (n, ch) {
  const item = { author: HEX, name: ch.repeat(MAX_NAME), username: 'u'.repeat(20), seq: SEQ, at: AT, text: ch.repeat(MAX_TEXT), replyTo: { author: HEX, seq: SEQ } }
  return {
    items: Array(n).fill(item),
    skipped: Array(MAX_LIST).fill({ key: HEX, reason: 'untrusted-association' }),
    skippedTruncated: SEQ,
    future: Array(MAX_LIST).fill(HEX + ':' + SEQ),
    futureTruncated: SEQ
  }
}

function logResult (n, ch) {
  const post = { type: 'post', text: ch.repeat(MAX_TEXT), at: AT, replyTo: { author: HEX, seq: SEQ } }
  return { key: HEX, entries: Array(n).fill({ seq: SEQ, record: post }), invalid: [], entriesTruncated: SEQ }
}

test('the worst-case records are valid records', (t) => {
  for (const ch of WORST) {
    t.is(validateRecord({ type: 'post', text: ch.repeat(MAX_TEXT), at: AT, replyTo: { author: HEX, seq: SEQ } }, 1), null)
    if (ch !== '\n') t.is(validateRecord({ type: 'profile', name: ch.repeat(MAX_NAME), bio: ch.repeat(MAX_BIO), at: AT }, 1), null)
  }
})

test('a post outweighs a profile and a certificate in a log page', (t) => {
  const post = JSON.stringify({ type: 'post', text: '\ud800'.repeat(MAX_TEXT), at: AT, replyTo: { author: HEX, seq: SEQ } })
  const profile = JSON.stringify({ type: 'profile', name: '\ud800'.repeat(MAX_NAME), bio: '\ud800'.repeat(MAX_BIO), at: AT })
  t.ok(utf8ByteLength(post) > utf8ByteLength(profile))
  // A certificate has fixed-size fields (hex64, hex128, <= 32-char tokens, ISO).
  t.ok(utf8ByteLength(post) > 1000)
})

test('feed.read: FEED_LIMIT_MAX fits, one more does not', (t) => {
  t.is(FEED_LIMIT_MAX, 35)
  for (const ch of WORST) t.ok(size(feedResult(FEED_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  const worst = size(feedResult(FEED_LIMIT_MAX, '\ud800'))
  t.comment('feed worst case at ' + FEED_LIMIT_MAX + ' items: ' + worst + ' bytes')
  t.ok(size(feedResult(FEED_LIMIT_MAX + 1, '\ud800')) > MAX_MESSAGE, 'largest that fits')
  t.ok(size(feedResult(50, '\u{1f600}')) <= MAX_MESSAGE, '50 items of 4-byte characters would fit')
  t.ok(size(feedResult(50, '\ud800')) > MAX_MESSAGE, '50 items of lone surrogates would not')
})

test('log.read: LOG_LIMIT_MAX fits, one more does not', (t) => {
  for (const ch of WORST) t.ok(size(logResult(LOG_LIMIT_MAX, ch)) <= MAX_MESSAGE, JSON.stringify(ch))
  t.comment('log worst case at ' + LOG_LIMIT_MAX + ' entries: ' + size(logResult(LOG_LIMIT_MAX, '\ud800')) + ' bytes')
  t.ok(size(logResult(LOG_LIMIT_MAX + 1, '\ud800')) > MAX_MESSAGE, 'largest that fits')
})

test('follow.list: FOLLOW_LIMIT_MAX keys fit with a wide margin', (t) => {
  const s = size({ follows: Array(FOLLOW_LIMIT_MAX).fill(HEX), total: SEQ })
  t.comment('follow.list worst case at ' + FOLLOW_LIMIT_MAX + ' keys: ' + s + ' bytes')
  t.ok(s * 4 < MAX_MESSAGE)
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
