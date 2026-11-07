// Mural tiles from a diary log and from assembleMember items: photo posts
// only, newest seq first, with the moved-page cut, the feed's future rule,
// a page cap that is never an empty mural, and dedupe by ref.
'use strict'

const test = require('brittle')

const load = () => import('../src/mural.js')

const AUTHOR = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const EARLY = '2026-01-01T00:00:00.000Z'
const LATER = '2026-10-20T10:00:00.000Z'
const PHOTO = Object.freeze({ mime: 'image/jpeg', width: 8, height: 8 })
const DAY = 24 * 60 * 60 * 1000

const seqsOf = (tiles) => tiles.map((tile) => tile.seq)

function postRecord (extra = {}) {
  return Object.freeze({
    type: 'post',
    text: 'foto',
    at: LATER,
    replyTo: null,
    media: [PHOTO],
    ...extra
  })
}

function logRow (seq, record) {
  return Object.freeze({ seq, entry: Object.freeze({ seq, record }) })
}

function invalidRow (seq) {
  return Object.freeze({ seq, invalid: Object.freeze({ seq, reason: 'malformed' }) })
}

function memberItem (seq, extra = {}) {
  return Object.freeze({
    kind: 'post',
    author: AUTHOR,
    seq,
    at: LATER,
    text: 'foto',
    replyTo: null,
    quote: null,
    media: [PHOTO],
    ...extra
  })
}

function tile (seq, extra = {}) {
  return {
    ref: AUTHOR + ':' + seq,
    author: AUTHOR,
    seq,
    at: LATER,
    media: [PHOTO],
    ...extra
  }
}

test('tilesFromLog keeps own photo posts, newest seq first', async (t) => {
  const { tilesFromLog } = await load()
  const keptMedia = [PHOTO]
  const early = postRecord({ at: EARLY, media: keptMedia })
  const quotedNull = postRecord({ quote: null, at: LATER })
  // Bad rows carry media, a null reply and no quote wherever that still
  // leaves them a post, so only the rule under test keeps them out.
  const rows = Object.freeze([
    logRow(2, quotedNull),
    logRow(9, postRecord({ type: 'repost', on: true, to: { author: OTHER, seq: 1 } })),
    logRow(8, postRecord({ replyTo: { author: AUTHOR, seq: 1 } })),
    logRow(7, postRecord({ quote: { author: OTHER, seq: 1 } })),
    logRow(6, postRecord({ media: null })),
    logRow(5, postRecord({ media: [] })),
    logRow(12, postRecord({ media: 'foto' })),
    invalidRow(4),
    logRow(3, postRecord({ type: 'profile', name: 'Ana', bio: '' })),
    logRow(10, early)
  ])
  const tiles = tilesFromLog(AUTHOR, rows)
  t.alike(seqsOf(tiles), [10, 2], 'highest seq first, not the at clock and not input order')
  t.is(seqsOf(tiles).includes(10), true, 'a post with no quote key')
  t.is(seqsOf(tiles).includes(2), true, 'quote null is not a quote')
  t.alike(tiles[0], { ref: AUTHOR + ':10', author: AUTHOR, seq: 10, at: EARLY, media: [PHOTO] })
  t.alike(tiles[1], { ref: AUTHOR + ':2', author: AUTHOR, seq: 2, at: LATER, media: [PHOTO] })
  t.is(seqsOf(tiles).includes(9), false, 'repost')
  t.is(seqsOf(tiles).includes(8), false, 'reply')
  t.is(seqsOf(tiles).includes(7), false, 'quote')
  t.is(seqsOf(tiles).includes(6), false, 'media null')
  t.is(seqsOf(tiles).includes(5), false, 'empty media')
  t.is(seqsOf(tiles).includes(12), false, 'media must be an array')
  t.is(seqsOf(tiles).includes(4), false, 'invalid block')
  t.is(seqsOf(tiles).includes(3), false, 'not a post')
  tiles[0].media.push({ mime: 'image/png' })
  t.is(keptMedia.length, 1, 'the log record keeps its own media array')
  t.alike(tilesFromLog(AUTHOR, null), [])
  t.alike(tilesFromLog('', rows), [])
})

test('tilesFromItems keeps assembleMember photo posts and drops reposts and replies', async (t) => {
  const { tilesFromItems } = await load()
  const keptMedia = [PHOTO]
  const early = memberItem(10, { at: EARLY, media: keptMedia, quote: null })
  const noQuoteKey = { ...memberItem(2), at: LATER }
  delete noQuoteKey.quote
  const items = Object.freeze([
    Object.freeze(noQuoteKey),
    memberItem(9, { kind: 'repost', to: { author: OTHER, seq: 1 } }),
    Object.freeze({ kind: 'repost', author: AUTHOR, seq: 11, at: LATER, to: { author: OTHER, seq: 1 } }),
    memberItem(8, { replyTo: { author: OTHER, seq: 4 } }),
    memberItem(7, { quote: { author: OTHER, seq: 1 } }),
    memberItem(6, { media: null }),
    memberItem(5, { media: [] }),
    memberItem(12, { media: 'foto' }),
    memberItem(3, { kind: 'like' }),
    early
  ])
  const tiles = tilesFromItems(items)
  t.alike(seqsOf(tiles), [10, 2], 'highest seq first, not the at clock and not input order')
  t.is(seqsOf(tiles).includes(10), true, 'quote null is not a quote')
  t.is(seqsOf(tiles).includes(2), true, 'a post with no quote key')
  t.alike(tiles[0], { ref: AUTHOR + ':10', author: AUTHOR, seq: 10, at: EARLY, media: [PHOTO] })
  t.alike(tiles[1], { ref: AUTHOR + ':2', author: AUTHOR, seq: 2, at: LATER, media: [PHOTO] })
  t.is(seqsOf(tiles).includes(9), false, 'repost')
  t.is(seqsOf(tiles).includes(11), false, 'repost without media')
  t.is(seqsOf(tiles).includes(8), false, 'reply')
  t.is(seqsOf(tiles).includes(7), false, 'quote')
  t.is(seqsOf(tiles).includes(6), false, 'media null')
  t.is(seqsOf(tiles).includes(5), false, 'empty media')
  t.is(seqsOf(tiles).includes(12), false, 'media must be an array')
  t.is(seqsOf(tiles).includes(3), false, 'not a post')
  tiles[0].media.push({ mime: 'image/png' })
  t.is(keptMedia.length, 1, 'the peeked item keeps its own media array')
  t.alike(tilesFromItems(null), [])
})

test('applyCut hides seqs at and after a moved page cut', async (t) => {
  const { applyCut } = await load()
  const tiles = Object.freeze([tile(1), tile(5), tile(3)])
  t.alike(seqsOf(applyCut(tiles, 4)), [1, 3], 'below the cut, in the order given')
  t.alike(seqsOf(applyCut(tiles, 3)), [1], 'the cut seq itself is not shown')
  t.alike(seqsOf(applyCut(tiles, null)), [1, 5, 3])
  t.alike(seqsOf(applyCut(tiles, undefined)), [1, 5, 3])
  t.alike(applyCut(null, 1), [])
})

test('hideFuture drops tiles more than 24 h ahead and keeps the boundary', async (t) => {
  const { hideFuture, MAX_FUTURE_MS } = await load()
  const now = Date.parse('2026-10-20T12:00:00.000Z')
  t.is(MAX_FUTURE_MS, DAY)
  const at = (ms) => new Date(ms).toISOString()
  const tiles = Object.freeze([
    tile(1, { at: at(now - DAY) }),
    tile(3, { at: at(now + DAY + 1) }),
    tile(2, { at: at(now + DAY) })
  ])
  t.alike(seqsOf(hideFuture(tiles, now)), [1, 2], 'exactly 24 h stays, one ms later does not')
  t.alike(hideFuture(null, now), [])
})

test('muralRows groups tiles into columns, three by default', async (t) => {
  const { muralRows } = await load()
  const tiles = Object.freeze([1, 2, 3, 4].map((seq) => tile(seq)))
  const grid = (rows) => rows.map((row) => row.map((cell) => cell.seq))
  t.alike(grid(muralRows(tiles)), [[1, 2, 3], [4]])
  t.alike(grid(muralRows(tiles, 2)), [[1, 2], [3, 4]])
  t.alike(grid(muralRows(tiles, 1)), [[1], [2], [3], [4]])
  t.alike(muralRows([]), [])
  t.alike(muralRows(null), [])
})

test('fillState pages until the grid is full, the source ends, or the cap', async (t) => {
  const { fillState } = await load()
  const tiles = (n) => Array.from({ length: n }, (_, i) => tile(i + 1))
  t.is(fillState({ tiles: tiles(12), atEnd: false, pages: 1 }), 'full')
  t.is(fillState({ tiles: tiles(12), atEnd: true, pages: 6 }), 'full', 'enough tiles win over the end and the cap')
  t.is(fillState({ tiles: tiles(11), atEnd: false, pages: 1 }), 'more')
  t.is(fillState({ tiles: tiles(3), atEnd: true, pages: 2 }), 'end')
  t.is(fillState({ tiles: [], atEnd: true, pages: 1 }), 'end')
  t.is(fillState({ tiles: tiles(3), atEnd: false, pages: 1, want: 3 }), 'full', 'want is the caller threshold')
  t.is(fillState({ tiles: tiles(1), atEnd: false, pages: 2, want: 12, maxPages: 2 }), 'capped', 'maxPages is the caller cap')
  t.is(fillState({}), 'more', 'nothing read yet still pages')
})

test('a capped scan is never reported as an empty mural', async (t) => {
  const { fillState } = await load()
  const capped = fillState({ tiles: [], atEnd: false, pages: 6 })
  t.is(capped, 'capped')
  t.not(capped, 'end', 'six mixed pages are not the end of the diary')
  t.not(capped, 'vazio')
  t.not(capped, 'empty')
  t.is(fillState({ tiles: [], atEnd: false, pages: 5 }), 'more', 'under the cap, keep paging even with no photo yet')
  t.is(fillState({ tiles: [tile(1), tile(2)], atEnd: false, pages: 6 }), 'capped')
  t.is(fillState({ tiles: [], atEnd: true, pages: 6 }), 'end', 'an exhausted source may be empty')
})

test('mergeTiles dedupes by ref and keeps the log tile', async (t) => {
  const { mergeTiles } = await load()
  const log5 = tile(5)
  const log3 = tile(3)
  const index5 = tile(5, { at: EARLY })
  const index4 = tile(4)
  const merged = mergeTiles(Object.freeze([log5, log3, log5]), Object.freeze([index5, index4, log3]))
  t.alike(seqsOf(merged), [5, 4, 3], 'newest first even when the index adds a seq between log seqs')
  t.is(merged[0], log5, 'the log tile wins the same ref')
  t.is(merged[1], index4)
  t.is(merged[2], log3)
  t.alike(seqsOf(mergeTiles([tile(40), tile(9)], [tile(41), tile(8)])), [41, 40, 9, 8], 'an index seq newer than the paged log goes on top')
  t.not(merged[0], index5)
  t.alike(mergeTiles(null, null), [])
  t.alike(seqsOf(mergeTiles([], [index4, index4])), [4])
})
