'use strict'

const test = require('brittle')
const { PROTOCOL, MAX_ID, MAX_MESSAGE, utf8ByteLength } = require('@varanda/rpc')
const { altRecordsOf, postAltOf, pickAlt, pickAltAsync, fitAlt } = require('../lib/post-alt')

const AT = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'
const record = (seq, alt = ['Uma árvore']) => ({ type: 'post-alt', seq, alt, at: AT })

test('altRecordsOf accepts either companion position, ignores tombstones and keeps the lowest seq', (t) => {
  const copied = [
    { seq: 3, record: record(1, ['second']) },
    { seq: 2, record: record(1, ['first']) },
    { seq: 5, record: { type: 'post-thumbs', seq: 4 } },
    { seq: 6, record: record(4) },
    { seq: 8, record: null },
    { seq: 11, record: record(8) },
    { seq: 12, record: record(12) },
    { seq: 13, record: record(14) }
  ]
  const before = JSON.stringify(copied)
  const result = altRecordsOf(copied)
  t.alike([...result], [[1, ['first']], [4, ['Uma árvore']]])
  t.alike([...altRecordsOf(copied.slice().reverse())].sort((a, b) => a[0] - b[0]), [...result], 'input order cannot choose the later companion')
  t.not(result.get(1), copied[1].record.alt)
  t.is(JSON.stringify(copied), before, 'input is unchanged')
  t.alike([...altRecordsOf(null)], [])
  t.alike([...altRecordsOf([null, { get record () { throw new Error('hostile') } }, ...copied])], [...result], 'bad entries do not hide later entries')
})

test('postAltOf aligns descriptions, including video pairs, and returns a fresh list', (t) => {
  const media = [{ mime: 'image/jpeg' }, { mime: 'video/mp4' }]
  const alt = [null, 'Uma árvore ao vento']
  const result = postAltOf({ media }, alt)
  t.alike(result, alt)
  t.not(result, alt)
  for (const value of [undefined, null, {}, 'x', ['only one']]) t.is(postAltOf({ media }, value), null)
  t.is(postAltOf({}, alt), null)
  t.is(postAltOf(null, alt), null)
  t.is(postAltOf({ get media () { throw new Error('hostile') } }, alt), null)
})

test('pickAlt and pickAltAsync check P+1 then P+2 and stop at the first match', async (t) => {
  for (const pick of [pickAlt, pickAltAsync]) {
    for (const asyncRead of pick === pickAltAsync ? [false, true] : [false]) {
      const calls = []
      const run = async (blocks) => {
        calls.length = 0
        return pick(4, (seq) => {
          calls.push(seq)
          return asyncRead ? Promise.resolve(blocks[seq] || null) : blocks[seq] || null
        })
      }
      const first = record(4, ['first'])
      t.alike(await run({ 5: first, 6: record(4, ['second']) }), { seq: 5, alt: ['first'] })
      t.alike(calls, [5], 'no read beyond the first match')
      t.alike(await run({ 5: { type: 'post-thumbs', seq: 4 }, 6: record(4) }), { seq: 6, alt: ['Uma árvore'] })
      t.alike(calls, [5, 6])
      t.alike(await run({ 6: record(4) }), { seq: 6, alt: ['Uma árvore'] }, 'deleted first block')
      t.alike(await run({ 5: record(3), 6: record(4) }), { seq: 6, alt: ['Uma árvore'] }, 'another post is ignored')
      t.is(await run({ 5: record(3), 6: record(5) }), null)
      t.is(await run({}), null)
      const picked = await run({ 5: first })
      t.not(picked.alt, first.alt)
    }
    t.is(await pick(0, () => { throw new Error('should not read') }), null)
    t.is(await pick(4, () => ({ get type () { throw new Error('hostile') } })), null)
  }
  t.alike(await pickAltAsync(4, async (seq) => {
    if (seq === 5) throw new Error('unavailable')
    return record(4)
  }), { seq: 6, alt: ['Uma árvore'] })
})

function cost (alt) {
  return utf8ByteLength(',"alt":' + JSON.stringify(alt))
}

function withBudget (rows, budget) {
  const result = { rows, next: { seq: 42 }, padding: '' }
  const bare = rows.map(({ alt, thumbs, ...rest }) => rest)
  const size = utf8ByteLength(JSON.stringify({ v: PROTOCOL, id: MAX_ID, ok: true, result: { ...result, rows: bare } }))
  result.padding = 'x'.repeat(MAX_MESSAGE - size - budget)
  return result
}

test('fitAlt keeps newest lists first with later index winning ties, without reordering rows', (t) => {
  const alt = ['Árvore 😀']
  const rows = [
    { seq: 1, at: AT, alt },
    { seq: 2, at: LATER, alt, thumbs: null },
    { seq: 3, at: LATER, alt },
    { seq: 4, at: AT, alt: null },
    { seq: 5, at: AT }
  ]
  const result = withBudget(rows, cost(alt))
  const before = JSON.stringify(result)
  const out = fitAlt(result, 'rows', (row) => row.at)
  t.alike(out.map((row) => row.seq), [1, 2, 3, 4, 5])
  t.alike(out.map((row) => 'alt' in row), [false, false, true, false, false])
  t.alike(out[2].alt, alt, 'exact budget fits with UTF-8 byte cost')
  t.is(out[1].thumbs, null)
  t.is(JSON.stringify(result), before, 'rows, cursor and envelope are unchanged')
  t.not(out[2], rows[2], 'output row is a copy')
  const two = fitAlt(withBudget(rows, cost(alt) * 2), 'rows', (row) => row.at)
  t.alike(two.map((row) => 'alt' in row), [false, true, true, false, false])
  const all = fitAlt({ rows }, 'rows', (row) => row.at)
  t.alike(all.map((row) => 'alt' in row), [true, true, true, false, false])
})

test('fitAlt stops at the first miss even when an older list would fit', (t) => {
  const rows = [
    { seq: 1, at: AT, alt: ['x'] },
    { seq: 2, at: LATER, alt: ['x'.repeat(140)] },
    { seq: 3, at: LATER, alt: ['x'] }
  ]
  const out = fitAlt(withBudget(rows, cost(['x']) * 2), 'rows', (row) => row.at)
  t.alike(out.map((row) => 'alt' in row), [false, false, true])
  const none = fitAlt(withBudget(rows, cost(['x']) - 1), 'rows', (row) => row.at)
  t.ok(none.every((row) => !('alt' in row)))
})

test('fitAlt excludes thumbnails from the budget and preserves them on every row', (t) => {
  const thumbs = [{ padding: 'x'.repeat(MAX_MESSAGE) }]
  const rows = [
    { seq: 1, at: AT, alt: ['older'], thumbs },
    { seq: 2, at: LATER, alt: ['newer'], thumbs },
    { seq: 3, at: AT, alt: null, thumbs: null }
  ]
  const out = fitAlt(withBudget(rows, cost(['newer'])), 'rows', (row) => row.at)
  t.alike(out.map((row) => 'alt' in row), [false, true, false])
  for (let i = 0; i < rows.length; i++) t.is(out[i].thumbs, rows[i].thumbs, 'thumbs untouched at ' + i)
})

test('fitAlt never throws on malformed peer data, and a failure drops only descriptions', (t) => {
  t.alike(fitAlt(null, 'items', (row) => row.at), [])
  t.alike(fitAlt({ items: [{ seq: 1, get alt () { throw new Error('hostile') } }] }, 'items', (row) => row.at), [{ seq: 1 }])
  const rows = [{ seq: 1, at: '2026-01-01T00:00:00.000Z', alt: ['a'] }, { seq: 2, at: 'x', alt: ['b'] }]
  const out = fitAlt({ items: rows }, 'items', () => { throw new Error('bad at') })
  t.alike(out, [{ seq: 1, at: '2026-01-01T00:00:00.000Z' }, { seq: 2, at: 'x' }], 'every row stays, in order, without alt')
})
