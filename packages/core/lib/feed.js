'use strict'

// The merged feed of several diaries: post items (replies and quotes
// included) and repost items (one per target its author still reposts,
// lib/engagement.js), in (at, author, seq) order, plus the CLI text format.

const { safe, cpWidth, displayWidth } = require('./safe')
const { validRecordCopy, latestProfile, formatRef, parseRef } = require('./records')
const { latestUsername } = require('./username')
const { engagementState } = require('./engagement')
const { applyDeletes, deletedSeqs } = require('./deletion')

const MAX_FUTURE_MS = 86400000

function shortKey (hex) {
  return hex.slice(0, 8)
}

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// A copied, checked `before` cursor; anything else throws.
function feedCursor (before) {
  if (before === null || typeof before !== 'object') throw new TypeError('before inválido')
  const { at, author, seq } = before
  const t = typeof at === 'string' ? Date.parse(at) : NaN
  if (!Number.isFinite(t) || typeof author !== 'string' || !Number.isSafeInteger(seq)) {
    throw new TypeError('before inválido')
  }
  return { t, author, seq }
}

// Pure: no I/O, inputs are not mutated. `revokedIssuers` (a Set of issuer
// keys, blocklist.js revokedIssuerSet, or null) makes a username record from a
// revoked issuer invalid (username.js), so a stolen issuer key cannot keep
// naming diaries once the association revokes it. `before` ({ at, author,
// seq } of an item, or null) keeps only the items strictly before it in feed
// order, so a caller pages backwards from the oldest item it holds; the
// `limit` newest of those are returned. `future` is never paged.
// Every item has `kind`: 'post' ({ ..., text, replyTo, quote, media }, never
// both replyTo and quote) or 'repost' ({ ..., to, text: null, replyTo: null,
// quote: null, media: null }, seq/at of the latest `on` record for `to`).
function buildFeed ({ logs, association, limit = Infinity, now = Date.now(), revokedIssuers = null, before = null }) {
  if (limit !== Infinity && !(Number.isInteger(limit) && limit >= 1)) throw new TypeError('limit inválido')
  const cursor = before === null ? null : feedCursor(before)
  const items = []
  const future = []
  const usernameOpts = { revokedIssuers }
  // One pass over `logs`: a getter must not change a diary between the
  // deleted-ref set and the items. Tombstones are folded here, not only in
  // readAll, because the web node and tests pass partial entries.
  const deletedRefs = new Set()
  const prepared = []
  for (const { key, entries } of logs) {
    const snapshot = entries.map(({ seq, record }) => ({ seq, record: validRecordCopy(record, seq) }))
    const copied = applyDeletes(snapshot)
    for (const seq of deletedSeqs(copied)) deletedRefs.add(formatRef({ author: key, seq }))
    prepared.push({ key, copied })
  }
  for (const { key, copied } of prepared) {
    const name = (latestProfile(copied) || {}).name || null
    const username = latestUsername(copied, key, association, usernameOpts)
    for (const { seq, record: post } of copied) {
      if (post === null || post.type !== 'post') continue
      if (Date.parse(post.at) - now > MAX_FUTURE_MS) {
        future.push({ author: key, seq })
        continue
      }
      // `media`: a copy of the post's descriptors, or null when it has none.
      const media = Array.isArray(post.media) ? post.media.map((d) => ({ ...d })) : null
      const quote = post.quote ? { author: post.quote.author, seq: post.quote.seq } : null
      items.push({ kind: 'post', author: key, name, username, seq, at: post.at, text: post.text, replyTo: post.replyTo, quote, media })
    }
    for (const [ref, { seq, at }] of engagementState(copied).reposted) {
      if (Date.parse(at) - now > MAX_FUTURE_MS) {
        future.push({ author: key, seq })
        continue
      }
      // A tombstone counts only in the target's own diary. A repost of a log
      // this call did not receive stays. A reply or a quote is its own post.
      if (deletedRefs.has(ref)) continue
      const to = parseRef(ref)
      items.push({ kind: 'repost', author: key, name, username, seq, at, to, text: null, replyTo: null, quote: null, media: null })
    }
  }
  // Numeric time order: string order breaks for negative-year ISO dates.
  items.sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) || cmp(a.author, b.author) || a.seq - b.seq)
  future.sort((a, b) => cmp(a.author, b.author) || a.seq - b.seq)
  const kept = cursor === null
    ? items
    : items.filter((it) => ((Date.parse(it.at) - cursor.t) || cmp(it.author, cursor.author) || it.seq - cursor.seq) < 0)
  return {
    items: limit === Infinity ? kept : kept.slice(Math.max(0, kept.length - limit)),
    future: future.map(formatRef)
  }
}

const MIN_WIDTH = 20

// Hard-wrap one logical line by display columns: the first segment holds up
// to `first` columns, every other one up to `max`.
function wrapLine (line, max, first = max) {
  const out = []
  let cur = ''
  let cols = 0
  let limit = first
  for (const ch of line) {
    const w = cpWidth(ch.codePointAt(0))
    if (cols + w > limit) {
      out.push(cur)
      cur = ''
      cols = 0
      limit = max
    }
    cur += ch
    cols += w
  }
  out.push(cur)
  return out
}

// Every wrapped segment of the text is indented by two spaces and, when a
// width is given, is at most `width` columns, so no line of a post can start
// at column 0 (not even through the terminal's soft wrap) and pass for a
// '[date]' header (security audit S5, L1). Peer-derived strings are escaped.
// A repost item is the header alone, ending in 'republicou <key8>#<seq>'.
function formatFeedItem (item, { width } = {}) {
  const target = (r) => safe(shortKey(r.author)) + '#' + r.seq
  const repost = item.kind === 'repost'
  let reply = ''
  if (repost) reply = ' republicou ' + target(item.to)
  else if (item.replyTo) reply = ' ↳ ' + target(item.replyTo)
  else if (item.quote) reply = ' cita ' + target(item.quote)
  const total = width === undefined ? Infinity : Math.max(MIN_WIDTH, width)
  const max = total - 2
  const name = safe(item.name || 'anônimo')
  const head = '[' + item.at + '] '
  const username = item.username == null ? '' : ' @' + safe(item.username)
  const tail = ' (' + shortKey(item.author) + username + ') #' + item.seq + reply
  let rows
  if (total === Infinity) {
    rows = [head + name + tail]
  } else if (displayWidth(head) + displayWidth(tail) + 1 <= total) {
    // The authenticated part (key8, seq, reply) always stays on the first
    // row: the name is truncated by display width, never wrapped, so a padded
    // name cannot push the real suffix onto an indented row.
    const room = total - displayWidth(head) - displayWidth(tail)
    let shown = name
    if (displayWidth(name) > room) {
      // ASCII mark, never East Asian Ambiguous (U+2026 may draw 2 columns).
      const mark = '...'.slice(0, room)
      shown = ''
      let cols = 0
      for (const ch of name) {
        const w = cpWidth(ch.codePointAt(0))
        if (cols + w > room - mark.length) break
        shown += ch
        cols += w
      }
      shown += mark
    }
    rows = [head + shown + tail]
  } else {
    // Too narrow even without the name: authenticated header first, the name
    // on its own indented row(s).
    rows = wrapLine(head + tail.slice(1), max, total).map((seg, i) => (i === 0 ? seg : '  ' + seg))
    for (const seg of wrapLine(name, max)) rows.push('  ' + seg)
  }
  if (repost) return rows.join('\n')
  for (const line of String(item.text).split('\n')) {
    for (const seg of wrapLine(safe(line), max)) rows.push('  ' + seg)
  }
  return rows.join('\n')
}

module.exports = { MAX_FUTURE_MS, buildFeed, shortKey, formatFeedItem }
