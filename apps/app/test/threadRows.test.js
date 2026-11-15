// Reply row helpers (threadRows.js): labels, chips and merges. A Rua's
// comment previews are feedFold.js now.
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
  t.ok(src.includes("import { parseRef } from './thread.js'"))
  t.is(src.includes("from 'react'"), false)
  t.is(src.includes('react-native'), false)
  t.is(src.includes("from 'node:"), false)
})

test('the thread layout lives in roda.js: no nested reply rows here', async (t) => {
  const mod = await load()
  t.is(mod.threadRows, undefined, 'commentRows (roda.js) lays out comments and rodas')
  t.is(mod.deeperOf, undefined)
  t.alike(Object.keys(mod).sort(), ['childLabel', 'compareAtSeq', 'mergeChildren', 'replyChip', 'withOwnReply'])
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
