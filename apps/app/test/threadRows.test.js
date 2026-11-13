// Reply-list rows (threadRows.js): one level of depth, stable keys, and
// cheap reply previews taken only from a list already loaded.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/threadRows.js')

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const D = 'dd'.repeat(32)

const refOf = (author, seq) => author + ':' + seq

const post = (author, seq, extra = {}) => ({
  kind: 'post',
  author,
  seq,
  at: '2026-10-20T10:00:00.000Z',
  text: 't' + seq,
  replyTo: null,
  name: 'Ana',
  username: 'ana',
  ...extra
})

test('parseRef, target and sameTarget keep their checks', async (t) => {
  const { parseRef, target, sameTarget } = await import('../src/thread.js')
  const ref = refOf(A, 3)
  t.alike(parseRef(ref), { author: A, seq: 3 })
  t.is(parseRef('nope'), null)
  t.is(parseRef(A.toUpperCase() + ':3'), null, 'still no lowercase of its own')
  const raw = { author: A, seq: 0 }
  const copy = target(raw)
  t.alike(copy, { author: A, seq: 0 })
  t.not(copy, raw, 'target copies')
  t.is(target({ author: 'zz', seq: 1 }), null)
  t.is(target({ author: A, seq: -1 }), null)
  t.is(target(null), null)
  t.ok(sameTarget(parseRef(ref), target({ author: A, seq: 3 })))
  t.is(sameTarget(parseRef(ref), target({ author: A, seq: 4 })), false)
  t.is(sameTarget(null, null), false)
})

test('row module imports the thread helpers and does not fetch', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/threadRows.js'), 'utf8')
  t.ok(src.includes("import { parseRef, target } from './thread.js'"))
  t.is(src.includes("from 'react'"), false)
  t.is(src.includes('react-native'), false)
  t.is(src.includes("from 'node:"), false)
})

test('threadRows lays out one level, flags unknown counts and keeps keys', async (t) => {
  const { threadRows, childLabel } = await load()
  const parent = post(A, 1, { text: 'pai' })
  const child = post(C, 3, { text: 'filha', replyTo: { author: A, seq: 1 }, name: 'Lia' })
  const otherChild = post(B, 8, { text: 'outra filha', replyTo: { author: A, seq: 1 } })
  const nested = post(D, 4, { text: 'neta', replyTo: { author: C, seq: 3 } })
  const parentRef = refOf(A, 1)
  const childRef = refOf(C, 3)
  const children = new Map([
    [parentRef, [child]],
    [childRef, [nested]]
  ])
  const counts = new Map([
    [parentRef, { replies: 2, likes: 0, reposts: 0, quotes: 0 }],
    [childRef, { replies: 4, likes: 0, reposts: 0, quotes: 0 }]
  ])
  const rows = threadRows({
    replies: [parent],
    children,
    counts,
    open: new Set([parentRef]),
    more: new Map([[parentRef, true]])
  })
  t.alike(rows.map((r) => r.kind), ['reply', 'expander', 'reply', 'more'])
  t.alike(rows.map((r) => r.key), [
    'reply:' + parentRef,
    'expander:' + parentRef,
    'reply:' + childRef,
    'more:' + parentRef
  ])
  t.is(rows[0].item, parent)
  t.is(rows[0].depth, 0)
  t.is(rows[0].deeper, 0, 'a direct reply expands in place')
  t.is(rows[1].parent, parent)
  t.is(rows[1].count, 2)
  t.is(rows[1].open, true)
  t.is(childLabel(rows[1].count, rows[1].open), 'Ocultar respostas')
  t.is(rows[2].depth, 1)
  t.is(rows[2].item, child)
  t.is(rows[2].deeper, 4, 'the grandchild count, not an inlined row')
  t.is(rows[3].parent, parent)
  t.is(rows.some((r) => r.item === nested), false)
  t.is(rows.filter((r) => r.kind === 'expander').length, 1)
  t.ok(rows.every((r) => r.kind !== 'reply' || r.depth === 0 || r.depth === 1))

  const closed = threadRows({ replies: [parent], children, counts, open: {}, more: {} })
  t.alike(closed.map((r) => r.key), ['reply:' + parentRef, 'expander:' + parentRef])
  t.is(closed[0].key, rows[0].key)
  t.is(closed[1].key, rows[1].key)
  t.is(closed[1].open, false)
  t.is(closed[1].count, 2)
  t.is(childLabel(closed[1].count, closed[1].open), 'Ver 2 respostas')

  const added = threadRows({
    replies: [parent],
    children: new Map([[parentRef, [child, otherChild]], [childRef, [nested]]]),
    counts,
    open: new Set([parentRef]),
    more: new Map([[parentRef, true]])
  })
  t.is(added[0].key, rows[0].key)
  t.is(added[1].key, rows[1].key)
  t.is(added[2].key, rows[2].key)
  t.is(added[3].depth, 1)
  t.is(added[3].deeper, 0)
  t.is(added[4].key, rows[3].key)

  const fromLoaded = threadRows({
    replies: [parent],
    children: new Map([[parentRef, [child]], [childRef, [nested, nested]]]),
    counts: new Map([[parentRef, 1]]),
    open: { [parentRef]: true },
    more: {}
  })
  t.is(fromLoaded.find((r) => r.depth === 1).deeper, 1, 'duplicate grandchild counts once')
  t.is(fromLoaded.some((r) => r.item === nested), false)

  const hidden = threadRows({
    replies: [parent],
    children,
    counts: { [parentRef]: 2 },
    open: {},
    more: { [parentRef]: true }
  })
  t.alike(hidden.map((r) => r.kind), ['reply', 'expander', 'more'])
  const notMore = threadRows({
    replies: [parent],
    counts: { [parentRef]: 2 },
    open: {},
    more: { [parentRef]: 1 }
  })
  t.alike(notMore.map((r) => r.kind), ['reply', 'expander'])
})

test('unknown counts open the expander and a missing count does not', async (t) => {
  const { threadRows, childLabel } = await load()
  const unknown = post(A, 1)
  const nullReplies = post(B, 2)
  const zero = post(C, 3)
  const absent = post(D, 4)
  const refU = refOf(A, 1)
  const refN = refOf(B, 2)
  const refZ = refOf(C, 3)
  const refA = refOf(D, 4)
  const loaded = post(A, 9, { text: 'carregada' })
  const rows = threadRows({
    replies: [unknown, nullReplies, zero, absent],
    children: {
      [refU]: [loaded],
      [refN]: [loaded],
      [refZ]: [loaded],
      [refA]: [loaded]
    },
    counts: {
      [refU]: null,
      [refN]: { replies: null, likes: 0, reposts: 0, quotes: 0 },
      [refZ]: { replies: 0, likes: 1, reposts: 0, quotes: 0 }
    },
    open: {},
    more: {}
  })
  t.alike(rows.map((r) => [r.kind, r.kind === 'reply' ? r.item : r.count]), [
    ['reply', unknown],
    ['expander', null],
    ['reply', nullReplies],
    ['expander', null],
    ['reply', zero],
    ['reply', absent]
  ])
  t.is(rows[1].open, false)
  t.is(childLabel(rows[1].count, rows[1].open), 'Ver respostas')
  t.is(rows.some((r) => r.item === loaded), false, 'closed threads do not leak loaded children')

  const opened = threadRows({
    replies: [unknown],
    children: { [refU]: [loaded, { text: 'sem ref' }] },
    counts: { [refU]: null },
    open: { [refU]: true },
    more: {}
  })
  t.alike(opened.map((r) => r.kind), ['reply', 'expander', 'reply'])
  t.is(opened[1].count, null)
  t.is(opened[1].open, true)
  t.is(opened[2].item, loaded)
  t.is(opened[2].depth, 1)
  t.is(opened[2].deeper, 0)
  t.is(childLabel(opened[1].count, opened[1].open), 'Ocultar respostas')

  const refLoaded = refOf(A, 9)
  const nested = post(D, 4, { replyTo: { author: A, seq: 9 } })
  const unknownDeep = threadRows({
    replies: [unknown],
    children: { [refU]: [loaded], [refLoaded]: [nested] },
    counts: { [refU]: 1, [refLoaded]: null },
    open: { [refU]: true },
    more: {}
  })
  t.is(unknownDeep.filter((r) => r.kind === 'expander').length, 1)
  t.is(unknownDeep[2].depth, 1)
  t.is(unknownDeep[2].deeper, null, 'unknown but flagged stays null, which is not 0')
  t.is(unknownDeep.some((r) => r.item === nested), false)

  const staleZero = threadRows({
    replies: [unknown],
    children: { [refU]: [loaded], [refLoaded]: [nested] },
    counts: { [refU]: 1, [refLoaded]: 0 },
    open: { [refU]: true },
    more: {}
  })
  t.is(staleZero[2].deeper, 1, 'a loaded grandchild still counts when the index says 0')

  const zeroOpen = threadRows({
    replies: [zero],
    children: { [refZ]: [loaded] },
    counts: { [refZ]: 0 },
    open: { [refZ]: true },
    more: {}
  })
  t.alike(zeroOpen.map((r) => r.kind), ['reply', 'expander', 'reply'])
  t.is(zeroOpen[1].count, 0)
  t.is(zeroOpen[1].open, true)
  t.is(zeroOpen[2].item, loaded)
})

test('threadRows drops a duplicate ref and keeps every key unique', async (t) => {
  const { threadRows } = await load()
  const first = post(A, 1, { text: 'primeiro' })
  const again = post(A, 1, { text: 'de novo' })
  const child = post(B, 2, { text: 'um' })
  const childAgain = post(B, 2, { text: 'dois' })
  const parentRef = refOf(A, 1)
  const replies = [first, again]
  const rows = threadRows({
    replies,
    children: { [parentRef]: [child, childAgain, first] },
    counts: { [parentRef]: 3 },
    open: { [parentRef]: true },
    more: {}
  })
  t.is(replies.length, 2, 'the input list is not rewritten')
  t.alike(rows.map((r) => r.kind), ['reply', 'expander', 'reply'])
  t.is(rows[0].item, first)
  t.is(rows[1].count, 3)
  t.is(rows[2].item, child)
  t.is(rows[2].depth, 1)
  t.is(new Set(rows.map((r) => r.key)).size, rows.length)
  t.alike(threadRows(), [])
  t.alike(threadRows(null), [])
  t.alike(threadRows({ replies: [null, { text: 'x' }] }), [])
})

test('mergeChildren dedupes by ref, orders by at, author, seq and returns a new map', async (t) => {
  const { mergeChildren } = await load()
  const parentRef = refOf(A, 1)
  const early = post(B, 2, { at: '2026-10-20T09:00:00.000Z', text: 'cedo' })
  const later = post(C, 1, { at: '2026-10-20T12:00:00.000Z', text: 'tarde' })
  // Same instant written two ways: as strings '.000Z' sorts before 'Z'.
  const tieA5 = post(A, 5, { at: '2026-01-01T00:00:00Z', text: 'a5' })
  const tieA2 = post(A, 2, { at: '2026-01-01T00:00:00.000Z', text: 'a2' })
  const tieD1 = post(D, 1, { at: '2026-01-01T00:00:00.000Z', text: 'd1' })
  const dup = post(B, 2, { at: '2026-10-20T08:00:00.000Z', text: 'copia' })
  const otherRef = refOf(D, 9)
  const other = post(D, 9)
  const prev = new Map([[otherRef, [other]]])
  const out = mergeChildren(prev, parentRef, [later, early, dup, tieD1, tieA5, tieA2, { text: 'lixo' }])
  t.ok(out instanceof Map)
  t.not(out, prev)
  t.is(prev.has(parentRef), false)
  t.is(prev.get(otherRef)[0], other)
  t.is(out.get(otherRef), prev.get(otherRef), 'an untouched parent keeps its list')
  t.alike(out.get(parentRef).map((i) => i.text), ['a2', 'a5', 'd1', 'cedo', 'tarde'],
    'same instant orders by author then seq, as the reply index does, not by the date string')
  t.is(out.get(parentRef)[3], early, 'the first copy of a ref wins')

  const again = mergeChildren(out, parentRef, [dup, post(C, 4, { at: '2026-10-20T13:00:00.000Z', text: 'nova' })])
  t.is(again.get(parentRef)[3], early)
  t.not(again.get(parentRef), out.get(parentRef))
  t.is(again.get(parentRef).at(-1).text, 'nova')
  t.is(mergeChildren(out, 'nope', [later]).get(parentRef), out.get(parentRef))
  t.is(mergeChildren(out, parentRef, null).get(parentRef), out.get(parentRef), 'a bad page does not wipe')

  const fromObject = mergeChildren({ [parentRef]: [later, early] }, parentRef, [])
  t.alike(fromObject.get(parentRef).map((i) => i.text), ['cedo', 'tarde'])
})

test('withOwnReply inserts a just-sent reply once', async (t) => {
  const { withOwnReply } = await load()
  const a = post(A, 1, { at: '2026-10-20T10:00:00.000Z' })
  const b = post(B, 2, { at: '2026-10-20T12:00:00.000Z' })
  const mid = post(C, 3, { at: '2026-10-20T11:00:00.000Z', text: 'novo' })
  const list = [a, b]
  const out = withOwnReply(list, mid)
  t.alike(list.map((i) => i.seq), [1, 2])
  t.alike(out.map((i) => i.seq), [1, 3, 2])
  t.not(out, list)
  const copy = post(C, 3, { text: 'outra', at: '2026-10-21T11:00:00.000Z' })
  t.is(withOwnReply(out, copy), out, 'the same ref is not inserted again')
  t.is(out[1].text, 'novo')
  t.is(withOwnReply(list, { text: 'sem ref' }), list)
  t.alike(withOwnReply(null, mid).map((i) => i.seq), [3])
  const newest = post(D, 4, { at: '2026-10-20T13:00:00.000Z' })
  t.alike(withOwnReply(list, newest).map((i) => i.seq), [1, 2, 4])
  const sameAt = post(D, 5, { at: a.at })
  t.alike(withOwnReply([a], sameAt).map((i) => i.seq), [1, 5])
  // Index order at one instant: aa:10, bb:1. A sent cc:5 goes after both.
  const aa10 = post(A, 10, { at: a.at })
  const bb1 = post(B, 1, { at: a.at })
  const cc5 = post(C, 5, { at: a.at })
  t.alike(withOwnReply([aa10, bb1], cc5).map((i) => i.author + ':' + i.seq), [A + ':10', B + ':1', C + ':5'],
    'a just-sent reply lands where the index will put it')
})

test('childLabel names the expander in pt-BR', async (t) => {
  const { childLabel } = await load()
  t.is(childLabel(1, false), 'Ver 1 resposta')
  t.is(childLabel(1, true), 'Ocultar respostas')
  t.is(childLabel(2, false), 'Ver 2 respostas')
  t.is(childLabel(0, false), 'Ver 0 respostas')
  t.is(childLabel(12, false), 'Ver 12 respostas')
  t.is(childLabel(null, false), 'Ver respostas')
  t.is(childLabel(undefined, false), 'Ver respostas')
  t.is(childLabel(1.5, false), 'Ver respostas')
  t.is(childLabel(-1, false), 'Ver respostas')
  t.is(childLabel(null, true), 'Ocultar respostas')
  t.is(childLabel(2, 'yes'), 'Ver 2 respostas')
})

test('replyChip prefers @username, then the name, then a bare label', async (t) => {
  const { replyChip } = await load()
  t.is(replyChip({ username: 'ana', name: 'Ana' }), 'Respondendo a @ana')
  t.is(replyChip({ username: '@ana', name: 'Ana' }), 'Respondendo a @ana')
  t.is(replyChip({ username: '', name: 'Ana' }), 'Respondendo a Ana')
  t.is(replyChip({ username: '   ', name: 'Ana Maria' }), 'Respondendo a Ana Maria')
  t.is(replyChip({ username: null, name: 'Ana' }), 'Respondendo a Ana')
  t.is(replyChip({ name: 'Ana' }), 'Respondendo a Ana')
  t.is(replyChip({}), 'Respondendo')
  t.is(replyChip(), 'Respondendo')
  t.is(replyChip({ username: 'ana\u202e' }), 'Respondendo a @ana\ufffd')
  t.is(replyChip({ name: 'Ana\u0001' }), 'Respondendo a Ana\ufffd')
  t.is(replyChip({ username: 'ana\u202e' }).includes('\u202e'), false)
  t.is(replyChip({ name: 'Ana\u0001' }).includes('\u0001'), false)
})

test('cheapReplies takes distant loaded replies and skips the near window', async (t) => {
  const { cheapReplies } = await load()
  const parent = post(A, 1, { text: 'foco' })
  const near = []
  for (let i = 0; i < 5; i++) {
    near.push(post(B, i + 1, { replyTo: { author: A, seq: 1 }, text: 'perto' + i, name: 'Perto' }))
  }
  const other = post(C, 1, { replyTo: { author: D, seq: 1 }, text: 'outra', name: 'Outra' })
  const far1 = post(C, 2, { replyTo: { author: A, seq: 1 }, text: 'longe\u0001', name: 'Lia\u202e' })
  const far2 = post(C, 3, { replyTo: refOf(A, 1), text: 'a\nb', name: null, username: 'lia' })
  const far3 = post(C, 4, { replyTo: { author: A, seq: 1 }, text: 'extra', name: 'Extra' })
  const items = [parent, ...near, other, far1, far2, far3]
  const out = cheapReplies(items, refOf(A, 1))
  t.is(out.length, 2, 'default max is 2')
  t.alike(out.map((r) => r.key), [refOf(C, 2), refOf(C, 3)])
  t.is(out[0].name, 'Lia\ufffd')
  t.is(out[0].text, 'longe\ufffd')
  t.is(out[0].name.includes('\u202e'), false)
  t.is(out[0].text.includes('\u0001'), false)
  t.is(out[1].name, 'lia')
  t.is(out[1].text, 'a\nb', 'a line break in the post text stays')
  t.is(out.some((r) => r.text.startsWith('perto')), false, 'distance 1 to 5 is inside the default window')
  t.is(out.some((r) => r.key === refOf(C, 1)), false, 'a far row aimed at another post is not a reply here')
  t.is(typeof out.then, 'undefined')

  const custom = cheapReplies(items, refOf(A, 1), { skipNear: 0, max: 1 })
  t.alike(custom, [{ key: refOf(B, 1), name: 'Perto', text: 'perto0' }])

  const upper = cheapReplies(items, refOf(A, 1).toUpperCase(), { max: 1 })
  t.is(upper[0].key, refOf(C, 2))

  t.alike(cheapReplies([far1, far2, far3], refOf(A, 1)), [], 'no parent row, so distance is unknown')
  t.alike(cheapReplies(items, 'nope'), [])
  t.alike(cheapReplies(null, refOf(A, 1)), [])
  t.alike(cheapReplies(items, refOf(A, 1), { max: 0 }), [], 'a max of 0 is a cap, not the default')
  t.alike(cheapReplies([...items, far1], refOf(A, 1), { max: 4 }).map((r) => r.key), [refOf(C, 2), refOf(C, 3), refOf(C, 4)])

  const ghost = post(A, 1, { text: 'copia' })
  const echo = post(B, 6, { replyTo: { author: A, seq: 1 }, text: 'eco', name: 'Eco' })
  const gap = Array.from({ length: 6 }, (_, i) => post(D, i + 30, { text: 'g' }))
  t.alike(cheapReplies([ghost, ...gap, parent, echo], refOf(A, 1)), [], 'near a later copy of the parent is still near')

  const above = post(B, 9, { replyTo: { author: A, seq: 1 }, text: 'acima', name: 'Bo' })
  const below = post(C, 9, { replyTo: { author: A, seq: 1 }, text: 'abaixo', name: 'Ca' })
  const pads = Array.from({ length: 9 }, (_, i) => post(D, i + 1, { text: 'p' }))
  const after = Array.from({ length: 6 }, (_, i) => post(D, i + 20, { text: 'q' }))
  const beside = post(B, 7, { replyTo: { author: A, seq: 1 }, text: 'colada', name: 'Bo' })
  const found = cheapReplies([above, ...pads, parent, beside, ...after, below], refOf(A, 1), { skipNear: 5, max: 3 })
  t.alike(found.map((r) => r.text), ['acima', 'abaixo'])

  const textReply = post(C, 21, { replyTo: { author: A, seq: 1 }, text: 'texto', name: 'Ca' })
  const gap6 = Array.from({ length: 6 }, (_, i) => post(D, i + 60, { text: 'r' }))
  const wrapper = { ...post(D, 50, { text: '' }), kind: 'repost', to: { author: A, seq: 1 } }
  t.alike(cheapReplies([wrapper, ...gap6, textReply], refOf(A, 1)).map((r) => r.text), ['texto'],
    'a repost row of the parent marks where the parent is')
  const photo1 = post(B, 20, { replyTo: { author: A, seq: 1 }, text: '  ', name: 'Foto' })
  const photo2 = post(B, 21, { replyTo: { author: A, seq: 1 }, text: '', name: 'Foto' })
  t.alike(cheapReplies([parent, ...gap6, photo1, photo2, textReply], refOf(A, 1)).map((r) => r.text), ['texto'],
    'photo-only replies do not use up the slots')
  const wrapReply = { ...post(C, 20, { replyTo: { author: A, seq: 1 }, text: 'nao' }), kind: 'repost', to: { author: D, seq: 99 } }
  t.alike(cheapReplies([parent, ...gap6, wrapReply, textReply], refOf(A, 1)).map((r) => r.text), ['texto'],
    'a repost wrapper is not a reply')
})

test('cheapRepliesMap: one walk for many parents, cheapReplies rules kept', async (t) => {
  const { cheapReplies, cheapRepliesMap } = await import('../src/threadRows.js')
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const C = 'c'.repeat(64)
  const row = (author, seq, extra = {}) => ({ kind: 'post', author, seq, at: '2026-10-20T10:00:00.000Z', text: author[0] + seq, name: 'N' + seq, ...extra })
  const pad = (from) => Array.from({ length: 7 }, (_, i) => row(C, from + i))
  const list = [
    row(A, 1),
    ...pad(100),
    row(B, 1, { replyTo: { author: A, seq: 1 } }),
    row(B, 2, { replyTo: A.toUpperCase() + ':1' }),
    row(B, 3, { replyTo: { author: A, seq: 1 }, text: '' }),
    { ...row(B, 4, { replyTo: { author: A, seq: 1 } }), kind: 'repost', to: { author: A, seq: 2 } },
    row(B, 8, { replyTo: { author: A, seq: 2 } }),
    ...pad(200),
    row(B, 5, { replyTo: { author: A, seq: 2 } }),
    row(B, 1, { replyTo: { author: A, seq: 1 } }),
    row(B, 6, { replyTo: { author: A, seq: 1 } }),
    row(B, 7, { replyTo: { author: A, seq: 3 } })
  ]
  const map = cheapRepliesMap(list, [A + ':1', A.toUpperCase() + ':2', A + ':3', 'nada', B + ':1'])
  const keys = (lines) => (lines || []).map((l) => l.key)
  t.alike(keys(map.get(A + ':1')), [B + ':1', B + ':2'], 'two lines in list order, a blank skipped')
  t.alike(keys(map.get(A + ':2')), [B + ':5'], 'a repost row places its original; the reply beside it is a row')
  t.alike(map.get(A + ':3'), [], 'a parent that is not in the list gets no lines')
  t.alike(map.get(B + ':1'), [], 'no reply, no lines')
  t.ok(!map.has('nada') && map.size === 4, 'an invalid ref is left out')
  t.alike(cheapReplies(list, A.toUpperCase() + ':1'), map.get(A + ':1'), 'cheapReplies is the one-ref case')
  t.alike(cheapRepliesMap(list, []), new Map())
  t.alike(cheapRepliesMap(null, [A + ':1']).get(A + ':1'), [])
  t.alike(keys(cheapRepliesMap(list, [A + ':1'], { max: 3 }).get(A + ':1')), [B + ':1', B + ':2', B + ':6'], 'a repeat of a shown key is skipped')
})
