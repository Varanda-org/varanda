// Photo tiles of one member, newest seq first. log.read rows and
// assembleMember items both mix posts, replies and reposts with no media
// filter (the member index lists every timeline seq, and log.read returns
// 32 mixed blocks a page), so the grid only sees what these normalisers keep.

import { shownUnderCut } from './pageMove.js'

// Same value as packages/core/lib/feed.js MAX_FUTURE_MS.
export const MAX_FUTURE_MS = 86400000

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isPostSeq = (n) => Number.isSafeInteger(n) && n >= 1

function hasMedia (media) {
  return Array.isArray(media) && media.length > 0
}

// Null and absent are an original post. Any other quote value is a quote.
function isQuote (quote) {
  return quote !== undefined && quote !== null
}

function tileOf (author, seq, at, media) {
  return { ref: author + ':' + seq, author, seq, at, media: media.slice() }
}

function muralRecord (record) {
  return isObject(record) &&
    record.type === 'post' &&
    record.replyTo === null &&
    !isQuote(record.quote) &&
    hasMedia(record.media) &&
    typeof record.at === 'string'
}

// logRows yields { seq, entry } or { seq, invalid }. Only a real entry has a record.
function rowRecord (row) {
  if (!isObject(row) || !isObject(row.entry)) return null
  return isObject(row.entry.record) ? row.entry.record : null
}

function rowSeq (row) {
  if (isPostSeq(row.seq)) return row.seq
  if (isObject(row.entry) && isPostSeq(row.entry.seq)) return row.entry.seq
  return null
}

export function tilesFromLog (author, rows) {
  if (typeof author !== 'string' || author.length === 0 || !Array.isArray(rows)) return []
  const tiles = []
  for (const row of rows) {
    const record = rowRecord(row)
    if (!muralRecord(record)) continue
    const seq = rowSeq(row)
    if (seq === null) continue
    tiles.push(tileOf(author, seq, record.at, record.media))
  }
  // Seq descending is what logRows and the member index already call newest.
  // `at` can be backdated, so it must not reshuffle the signed log.
  tiles.sort((a, b) => b.seq - a.seq)
  return tiles
}

function muralItem (item) {
  return isObject(item) &&
    item.kind === 'post' &&
    typeof item.author === 'string' &&
    item.author.length > 0 &&
    isPostSeq(item.seq) &&
    item.replyTo === null &&
    !isQuote(item.quote) &&
    hasMedia(item.media) &&
    typeof item.at === 'string'
}

export function tilesFromItems (items) {
  if (!Array.isArray(items)) return []
  const tiles = []
  for (const item of items) {
    if (!muralItem(item)) continue
    tiles.push(tileOf(item.author, item.seq, item.at, item.media))
  }
  tiles.sort((a, b) => b.seq - a.seq)
  return tiles
}

// The cut is the first seq a moved page no longer shows. Blocks there and
// after were appended by the key that left.
export function applyCut (tiles, cut) {
  if (!Array.isArray(tiles)) return []
  return tiles.filter((tile) => isObject(tile) && shownUnderCut(cut, tile.seq))
}

// More than 24 h ahead is hidden until the reader's clock catches up.
// Exactly 24 h stays, as in the feed.
export function hideFuture (tiles, now) {
  if (!Array.isArray(tiles)) return []
  return tiles.filter((tile) => {
    if (!isObject(tile) || typeof tile.at !== 'string') return true
    return !(Date.parse(tile.at) - now > MAX_FUTURE_MS)
  })
}

export function muralRows (tiles, columns = 3) {
  const list = Array.isArray(tiles) ? tiles : []
  // A non-positive count would not advance the loop.
  const cols = Number.isSafeInteger(columns) && columns >= 1 ? columns : 3
  const rows = []
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols))
  return rows
}

// 'full' once `want` tiles are in hand. 'end' only when the source is
// exhausted. 'capped' after `maxPages` still short of `want`: those pages
// mix replies and reposts, so the screen offers "Ver mais" and never "vazio".
// Anything else keeps paging.
export function fillState ({ tiles, atEnd, pages, want = 12, maxPages = 6 } = {}) {
  const count = Array.isArray(tiles) ? tiles.length : 0
  if (count > 0 && count >= want) return 'full'
  if (atEnd === true) return 'end'
  if (pages >= maxPages) return 'capped'
  return 'more'
}

// One tile per ref, newest seq first like every list here. The own log wins
// a clash with the index for the same ref.
export function mergeTiles (local, indexed) {
  const seen = new Set()
  const out = []
  const append = (list) => {
    if (!Array.isArray(list)) return
    for (const tile of list) {
      if (!isObject(tile) || typeof tile.ref !== 'string') continue
      if (seen.has(tile.ref)) continue
      seen.add(tile.ref)
      out.push(tile)
    }
  }
  append(local)
  append(indexed)
  out.sort((a, b) => b.seq - a.seq)
  return out
}
