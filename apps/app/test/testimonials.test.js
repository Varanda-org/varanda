// Depoimentos rows (testimonials.js): profile rows from verified show
// blocks, the own sent list and the pending list.
'use strict'

const test = require('brittle')
const load = () => import('../src/testimonials.js')

const OWNER = 'ab'.repeat(32)
const W1 = 'cd'.repeat(32)
const W2 = 'ef'.repeat(32)
const OTHER = '12'.repeat(32)
const NONCE = '34'.repeat(32)
const AT1 = '2026-11-01T10:00:00.000Z'
const AT2 = '2026-11-02T10:00:00.000Z'
const AT3 = '2026-11-03T10:00:00.000Z'
const BOX = 'A'.repeat(200)

const show = (from, wseq, text, at) => ({ type: 'testimonial-show', from, seq: wseq, text, nonce: NONCE, at })
const written = (to, at = AT1) => ({ type: 'testimonial', to, gen: 1, hash: '56'.repeat(32), box: BOX, at })

function ownerPeek (entries) {
  return { key: OWNER, length: 50, entries, invalid: [], missing: [], profile: null, username: null }
}

function writerPeek (key, entries, profile = null, username = null) {
  return { key, length: 50, entries, invalid: [], missing: [], profile, username }
}

test('rowsFrom: display shape with the writer name, username and avatar', async (t) => {
  const { rowsFrom } = await load()
  const avatar = { core: OTHER, seq: 1, size: 10, sha256: '78'.repeat(32), mime: 'image/jpeg' }
  const peek = ownerPeek([{ seq: 10, record: show(W1, 3, 'Gente boa demais', AT2) }])
  const writers = new Map([[W1, writerPeek(W1, [{ seq: 3, record: written(OWNER) }], { name: 'Ana', bio: '', avatar }, 'ana')]])
  t.alike(rowsFrom(peek, OWNER, writers), [
    { from: W1, seq: 10, text: 'Gente boa demais', at: AT2, ref: OWNER + ':10', name: 'Ana', username: 'ana', avatar }
  ])
  const plain = { [W1]: writerPeek(W1, [{ seq: 3, record: written(OWNER) }]) }
  t.alike(rowsFrom(peek, OWNER, plain), [
    { from: W1, seq: 10, text: 'Gente boa demais', at: AT2, ref: OWNER + ':10', name: null, username: null, avatar: null }
  ], 'plain object and no profile')
})

test('rowsFrom: duplicates per writer collapse to the newest show', async (t) => {
  const { rowsFrom } = await load()
  const peek = ownerPeek([
    { seq: 12, record: show(W1, 5, 'novo', AT3) },
    { seq: 8, record: show(W1, 3, 'velho', AT1) },
    { seq: 10, record: show(W2, 2, 'outro', AT2) }
  ])
  const writers = new Map([
    [W1, writerPeek(W1, [{ seq: 3, record: written(OWNER) }, { seq: 5, record: written(OWNER) }])],
    [W2, writerPeek(W2, [{ seq: 2, record: written(OWNER) }])]
  ])
  const rows = rowsFrom(peek, OWNER, writers)
  t.alike(rows.map((r) => [r.from, r.seq, r.text]), [[W1, 12, 'novo'], [W2, 10, 'outro']])
})

test('rowsFrom: wrong owner, revoked or absent writer blocks are dropped', async (t) => {
  const { rowsFrom } = await load()
  const peek = ownerPeek([
    { seq: 4, record: show(W1, 3, 'a', AT1) },
    { seq: 5, record: show(W2, 2, 'b', AT1) },
    { seq: 6, record: show(OTHER, 9, 'c', AT1) }
  ])
  const writers = new Map([
    [W1, writerPeek(W1, [{ seq: 3, record: written(OTHER) }])],
    [W2, writerPeek(W2, [])]
  ])
  t.alike(rowsFrom(peek, OWNER, writers), [], 'misaddressed, revoked and unknown writer')
  const good = new Map([[W1, writerPeek(W1, [{ seq: 3, record: written(OWNER) }])]])
  t.alike(rowsFrom({ ...peek, key: OTHER }, OWNER, good), [], 'peek of another diary')
  t.alike(rowsFrom(peek, OWNER.toUpperCase(), good), [], 'owner must be lowercase hex64')
  t.alike(rowsFrom(peek, OWNER, new Map([[W1, writerPeek(OTHER, [{ seq: 3, record: written(OWNER) }])]])), [], 'writer peek of another key')
  t.alike(rowsFrom(peek, OWNER, new Map([[W1, writerPeek(W1, [{ seq: 3, record: { type: 'post', at: AT1 } }])]])), [], 'not a testimonial block')
  t.alike(rowsFrom(peek, OWNER, null), [], 'no writer peeks')
  t.is(rowsFrom(peek, OWNER, good).length, 1, 'the live one stays')
  const self = ownerPeek([{ seq: 4, record: show(OWNER, 3, 'eu', AT1) }])
  t.alike(rowsFrom(self, OWNER, new Map([[OWNER, writerPeek(OWNER, [{ seq: 3, record: written(OWNER) }])]])), [], 'own show of self')
  const malformed = ownerPeek([
    { seq: 4, record: show(W1, 3, '', AT1) },
    { seq: 5, record: show(W1, 0, 'x', AT1) },
    { seq: 6, record: show(W1, 3, 'x', 'ontem') },
    { seq: 7, record: { type: 'post', text: 'x', at: AT1 } },
    { seq: 0, record: show(W1, 3, 'x', AT1) },
    null
  ])
  t.alike(rowsFrom(malformed, OWNER, good), [], 'malformed shows')
})

test('sentRows: live own testimonials, tombstoned ones excluded', async (t) => {
  const { sentRows } = await load()
  const log = {
    key: OWNER,
    entries: [
      { seq: 2, record: written(W1, AT1) },
      { seq: 4, record: written(W2, AT2) },
      { seq: 5, record: { type: 'post', text: 'oi', at: AT2 } },
      { seq: 6, record: written(W1, AT3) },
      { seq: 7, record: { type: 'delete', seq: 4, at: AT3 } }
    ],
    invalid: [{ seq: 3, reason: 'deleted' }],
    entriesTruncated: 0
  }
  t.alike(sentRows(log, OWNER), [
    { to: W1, seq: 6, at: AT3, ref: OWNER + ':6' },
    { to: W1, seq: 2, at: AT1, ref: OWNER + ':2' }
  ])
  const older = { key: OWNER, entries: [{ seq: 1, record: written(W2, AT1) }], invalid: [], entriesTruncated: 0 }
  const newer = { key: OWNER, entries: [{ seq: 9, record: { type: 'delete', seq: 1, at: AT3 } }, { seq: 8, record: written(W1, AT2) }], invalid: [], entriesTruncated: 1 }
  t.alike(sentRows([newer, older], OWNER), [{ to: W1, seq: 8, at: AT2, ref: OWNER + ':8' }], 'a tombstone on another page')
  t.alike(sentRows({ ...log, key: OTHER }, OWNER), [], 'log of another diary')
  t.alike(sentRows(log, 'nope'), [])
  t.alike(sentRows(null, OWNER), [])
})

test('pendingRows: normalises testimonial.pending items', async (t) => {
  const { pendingRows, TESTIMONIAL_PENDING_MAX } = await load()
  t.is(TESTIMONIAL_PENDING_MAX, 64)
  const items = [
    { from: W1, seq: 3, text: 'oi', at: AT1 },
    { from: W1, seq: 3, text: 'oi', at: AT1 },
    { from: W1.toUpperCase(), seq: 4, text: 'x', at: AT1 },
    { from: W2, seq: 0, text: 'x', at: AT1 },
    { from: W2, seq: 2, text: '', at: AT1 },
    { from: W2, seq: 2, text: 'x', at: 'hoje' },
    null,
    { from: W2, seq: 5, text: 'tchau', at: AT2 }
  ]
  t.alike(pendingRows({ items }), [
    { from: W1, seq: 3, text: 'oi', at: AT1, ref: W1 + ':3' },
    { from: W2, seq: 5, text: 'tchau', at: AT2, ref: W2 + ':5' }
  ])
  const many = []
  for (let i = 1; i <= 70; i++) many.push({ from: W1, seq: i, text: 'x', at: AT1 })
  t.is(pendingRows({ items: many }).length, 64, 'capped')
  t.alike(pendingRows(null), [])
  t.alike(pendingRows({ items: 'x' }), [])
})

test('pendingIncomplete: only an explicit incomplete: true', async (t) => {
  const { pendingIncomplete, pendingRows } = await load()
  t.is(pendingIncomplete({ items: [], incomplete: true }), true)
  t.is(pendingIncomplete({ items: [], incomplete: false }), false)
  t.is(pendingIncomplete({ items: [] }), false, 'an older node without the flag')
  for (const v of [null, undefined, 'x', [], { incomplete: 'true' }, { incomplete: 1 }]) t.is(pendingIncomplete(v), false)
  t.alike(pendingRows({ items: [], incomplete: true }), [], 'pendingRows still takes the new shape')
})
