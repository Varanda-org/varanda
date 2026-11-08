'use strict'

// The merged feed of several diaries: post items (replies and quotes
// included) and repost items (one per target its author still reposts,
// lib/engagement.js), in (at, author, seq) order, plus the CLI text format.

const { copyLinkCard } = require('./link-card')
const { safe, cpWidth, displayWidth } = require('./safe')
const { validRecordCopy, latestProfileOfCopies, formatRef, parseRef } = require('./records')
const { latestUsernameOfCopies } = require('./username')
const { engagementOfCopies } = require('./engagement')
const { applyDeletesOfCopies, deletedSeqsOfCopies } = require('./deletion')
const { pageLifecycle, cutEntries } = require('./page-lifecycle')

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

// A page's first verified page-close or page-moved ends the log at its seq:
// no later block (post, repost, tombstone, profile) counts, so a leaked page
// key cannot keep feeding readers. The fold reads the raw entries, before
// applyDeletes, so a tombstone naming the terminal record cannot undo the
// cut. Blocks past the cut are dropped silently: `future` is the clock-skew
// channel and they never become items.
function movedCut (raw, key, association, revokedIssuers) {
  if (!raw.some((e) => e.record !== null && (e.record.type === 'page-moved' || e.record.type === 'page-close'))) return raw
  const lifecycle = pageLifecycle(raw, key, association, { revokedIssuers })
  if (lifecycle.movedTo === null && lifecycle.closed === null) return raw
  return cutEntries(raw, lifecycle)
}

// With raw blocks: a cut log is folded again from its raw blocks below the
// cut, so a tombstone past the cut (already applied by the caller's fold)
// deletes nothing; only the seqs `entries` shows stay. Without a cut the
// caller's fold stands.
function heldFold (raw, held, key, association, revokedIssuers) {
  const cut = movedCut(held, key, association, revokedIssuers)
  if (cut === held) return applyDeletesOfCopies(raw)
  const shown = new Set(raw.map((e) => e.seq))
  return applyDeletesOfCopies(cut).filter((e) => shown.has(e.seq))
}

// One validated copy per entry and call: every walker below reads these
// copies, never the caller's records, so each record is cloned and checked
// once. Keyed by seq and record object together, because validity depends
// on the seq (a cert is valid only at 0, a tombstone only over an earlier
// block): the same object at another seq is copied and checked again. A raw
// block holding the same object as its entry shares that entry's copy.
function entryCopier () {
  const bySeq = new Map()
  return (record, seq) => {
    const hit = bySeq.get(seq)
    if (hit !== undefined && hit.record === record) return hit.copy
    const copy = validRecordCopy(record, seq)
    if (hit === undefined) bySeq.set(seq, { record, copy })
    return copy
  }
}

// Validated copies of a log's optional raw blocks, or null.
function heldCopies (held, copyOf) {
  if (!Array.isArray(held)) return null
  const out = []
  for (const e of held) {
    if (e === null || typeof e !== 'object' || !Number.isSafeInteger(e.seq)) continue
    out.push({ seq: e.seq, record: copyOf(e.record, e.seq) })
  }
  return out
}

// One log's validated, live copies exactly as the feed folds them: the page
// cut (a verified page-close or page-moved ends the log), then tombstones.
// For other folds over the same diaries (Momentos), so a closed or migrated
// page cannot keep publishing to readers through them either.
function liveLogCopies ({ key, entries, raw: rawBlocks }, { association, revokedIssuers = null } = {}) {
  const copyOf = entryCopier()
  const raw = (Array.isArray(entries) ? entries : []).map(({ seq, record }) => ({ seq, record: copyOf(record, seq) }))
  const held = heldCopies(rawBlocks, copyOf)
  return held === null ? applyDeletesOfCopies(movedCut(raw, key, association, revokedIssuers)) : heldFold(raw, held, key, association, revokedIssuers)
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
// quote: null, media: null, preview: null }, seq/at of the latest `on` record for `to`).
// A log may carry `raw` (its blocks, tombstones not applied, holes as
// { seq, record: null }): the page cut is then read and folded from it
// (heldFold), so it never depends on a fold the caller already ran.
function buildFeed ({ logs, association, limit = Infinity, now = Date.now(), revokedIssuers = null, before = null }) {
  if (limit !== Infinity && !(Number.isInteger(limit) && limit >= 1)) throw new TypeError('limit inválido')
  const cursor = before === null ? null : feedCursor(before)
  // Rows of { t, item, log }: `at` is parsed once per item, and the log is
  // kept for the username, worked out only for the items returned (it
  // verifies a signature).
  const rows = []
  const future = []
  const usernameOpts = { revokedIssuers }
  // One pass over `logs`: a getter must not change a diary between the
  // deleted-ref set and the items. Tombstones are folded here, not only in
  // readAll, because the web node and tests pass partial entries.
  const deletedRefs = new Set()
  const prepared = []
  for (const { key, entries, raw: rawBlocks } of logs) {
    const copyOf = entryCopier()
    const raw = entries.map(({ seq, record }) => ({ seq, record: copyOf(record, seq) }))
    const held = heldCopies(rawBlocks, copyOf)
    const copied = held === null ? applyDeletesOfCopies(movedCut(raw, key, association, revokedIssuers)) : heldFold(raw, held, key, association, revokedIssuers)
    for (const seq of deletedSeqsOfCopies(copied)) deletedRefs.add(formatRef({ author: key, seq }))
    prepared.push({ key, copied })
  }
  for (const log of prepared) {
    const { key, copied } = log
    const name = (latestProfileOfCopies(copied) || {}).name || null
    for (const { seq, record: post } of copied) {
      if (post === null || post.type !== 'post') continue
      const t = Date.parse(post.at)
      if (t - now > MAX_FUTURE_MS) {
        future.push({ author: key, seq })
        continue
      }
      // `media`: a copy of the post's descriptors, or null when it has none.
      const media = Array.isArray(post.media) ? post.media.map((d) => ({ ...d })) : null
      const quote = post.quote ? { author: post.quote.author, seq: post.quote.seq } : null
      rows.push({ t, log, item: { kind: 'post', author: key, name, username: null, seq, at: post.at, text: post.text, replyTo: post.replyTo, quote, media, preview: post.preview ? copyLinkCard(post.preview, (d) => ({ ...d })) : null } })
    }
    for (const [ref, { seq, at }] of engagementOfCopies(copied).reposted) {
      const t = Date.parse(at)
      if (t - now > MAX_FUTURE_MS) {
        future.push({ author: key, seq })
        continue
      }
      // A tombstone counts only in the target's own diary. A repost of a log
      // this call did not receive stays. A reply or a quote is its own post.
      if (deletedRefs.has(ref)) continue
      const to = parseRef(ref)
      rows.push({ t, log, item: { kind: 'repost', author: key, name, username: null, seq, at, to, text: null, replyTo: null, quote: null, media: null, preview: null } })
    }
  }
  // Numeric time order: string order breaks for negative-year ISO dates.
  rows.sort((a, b) => (a.t - b.t) || cmp(a.item.author, b.item.author) || a.item.seq - b.item.seq)
  future.sort((a, b) => cmp(a.author, b.author) || a.seq - b.seq)
  const kept = cursor === null
    ? rows
    : rows.filter(({ t, item }) => ((t - cursor.t) || cmp(item.author, cursor.author) || item.seq - cursor.seq) < 0)
  const page = limit === Infinity ? kept : kept.slice(Math.max(0, kept.length - limit))
  for (const { item, log } of page) {
    if (log.username === undefined) log.username = latestUsernameOfCopies(log.copied, log.key, association, usernameOpts)
    item.username = log.username
  }
  return {
    items: page.map((row) => row.item),
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

module.exports = { MAX_FUTURE_MS, buildFeed, liveLogCopies, shortKey, formatFeedItem }
