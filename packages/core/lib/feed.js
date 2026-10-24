'use strict'

const { safe, cpWidth, displayWidth } = require('./safe')
const { validRecordCopy, latestProfile, formatRef } = require('./records')
const { latestUsername } = require('./username')

const MAX_FUTURE_MS = 86400000

function shortKey (hex) {
  return hex.slice(0, 8)
}

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// Pure: no I/O, inputs are not mutated.
function buildFeed ({ logs, association, limit = Infinity, now = Date.now() }) {
  if (limit !== Infinity && !(Number.isInteger(limit) && limit >= 1)) throw new TypeError('limit inválido')
  const items = []
  const future = []
  for (const { key, entries } of logs) {
    // Snapshot peer data once so all three readers see the same values,
    // even when the input has getters.
    const copied = entries.map(({ seq, record }) => ({ seq, record: validRecordCopy(record, seq) }))
    const name = (latestProfile(copied) || {}).name || null
    const username = latestUsername(copied, key, association)
    for (const { seq, record: post } of copied) {
      if (post === null || post.type !== 'post') continue
      if (Date.parse(post.at) - now > MAX_FUTURE_MS) {
        future.push({ author: key, seq })
        continue
      }
      items.push({ author: key, name, username, seq, at: post.at, text: post.text, replyTo: post.replyTo })
    }
  }
  // Numeric time order: string order breaks for negative-year ISO dates.
  items.sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) || cmp(a.author, b.author) || a.seq - b.seq)
  future.sort((a, b) => cmp(a.author, b.author) || a.seq - b.seq)
  return {
    items: limit === Infinity ? items : items.slice(Math.max(0, items.length - limit)),
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
function formatFeedItem (item, { width } = {}) {
  const reply = item.replyTo ? ' ↳ ' + shortKey(item.replyTo.author) + '#' + item.replyTo.seq : ''
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
  for (const line of String(item.text).split('\n')) {
    for (const seg of wrapLine(safe(line), max)) rows.push('  ' + seg)
  }
  return rows.join('\n')
}

module.exports = { MAX_FUTURE_MS, buildFeed, shortKey, formatFeedItem }
