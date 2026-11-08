// Momentos pure module (moments.js): strip order, navigation, reply context.
'use strict'

const test = require('brittle')
const load = () => import('../src/moments.js')

const OWN = 'aa'.repeat(32)
const A = 'bb'.repeat(32)
const B = 'cc'.repeat(32)
const C = 'dd'.repeat(32)
const item = (seq, ref) => ({ seq, ref: ref || 'ref' + seq, text: 't', at: '2026-11-07T10:00:00.000Z', media: {} })
const who = (author, ...items) => ({ author, items })

test('ringOrder: own first, then unseen, then seen, stable inside groups', async (t) => {
  const { ringOrder } = await load()
  const authors = [who(A, item(1)), who(OWN, item(2)), who(B, item(3)), who(C, item(4))]
  const seen = new Set(['ref1', 'ref4'])
  t.alike(ringOrder(authors, seen, OWN).map((a) => a.author), [OWN, B, A, C])
})

test('ringOrder: ownKey absent, empty and all seen', async (t) => {
  const { ringOrder } = await load()
  const authors = [who(A, item(1)), who(B, item(2))]
  t.alike(ringOrder(authors, new Set(), undefined).map((a) => a.author), [A, B])
  t.alike(ringOrder(authors, new Set(), OWN).map((a) => a.author), [A, B])
  t.alike(ringOrder([], new Set(), OWN), [])
  t.alike(ringOrder(null, new Set(), OWN), [])
  t.alike(ringOrder(authors, ['ref1', 'ref2'], OWN).map((a) => a.author), [A, B])
  t.alike(ringOrder([who(A, item(1)), who(B, item(2))], ['ref1'], OWN).map((a) => a.author), [B, A])
})

test('ringOrder: an author with one unseen of several stays unseen; empty items count as seen', async (t) => {
  const { ringOrder } = await load()
  const authors = [who(A), who(B, item(1), item(2))]
  t.alike(ringOrder(authors, new Set(['ref1']), OWN).map((a) => a.author), [B, A])
})

test('seenKey', async (t) => {
  const { seenKey } = await load()
  t.is(seenKey('abc'), 'abc')
  t.is(seenKey(null), '')
  t.is(seenKey(5), '')
})

test('firstUnseenIndex', async (t) => {
  const { firstUnseenIndex } = await load()
  const items = [item(1), item(2), item(3)]
  t.is(firstUnseenIndex(items, new Set()), 0)
  t.is(firstUnseenIndex(items, new Set(['ref1'])), 1)
  t.is(firstUnseenIndex(items, new Set(['ref1', 'ref2'])), 2)
  t.is(firstUnseenIndex(items, new Set(['ref1', 'ref2', 'ref3'])), 0)
  t.is(firstUnseenIndex([], new Set()), 0)
  t.is(firstUnseenIndex(undefined, new Set()), 0)
})

test('nextIndex: steps and both ends', async (t) => {
  const { nextIndex } = await load()
  t.is(nextIndex(0, 3, 'next'), 1)
  t.is(nextIndex(1, 3, 'prev'), 0)
  t.is(nextIndex(2, 3, 'next'), null)
  t.is(nextIndex(0, 3, 'prev'), null)
  t.is(nextIndex(0, 0, 'next'), null)
  t.is(nextIndex(0, 1, 'next'), null)
  t.is(nextIndex(0, 3, 'up'), null)
  t.is(nextIndex(-1, 3, 'next'), null)
})

test('replyContext matches the openMessage context shape', async (t) => {
  const { replyContext } = await load()
  const moment = item(7)
  t.alike(replyContext(moment, A), { kind: 'moment', author: A, seq: 7, at: moment.at, text: 't', hasMedia: true })
  const { makeIntent, validIntent } = await import('../src/privateReply.js')
  const intent = makeIntent({ id: 'x', peer: A, from: 'rua', context: replyContext(moment, A) })
  t.alike(intent.context, replyContext(moment, A))
  t.ok(validIntent(intent, OWN))
})

test('canReply only for hosted === true', async (t) => {
  const { canReply } = await load()
  t.is(canReply({ hosted: true }), true)
  t.is(canReply({ hosted: false }), false)
  t.is(canReply({ hosted: 'true' }), false)
  t.is(canReply({}), false)
  t.is(canReply(null), false)
})

test('expiresIn: 24 h boundary', async (t) => {
  const { expiresIn, MOMENT_MS } = await load()
  const at = '2026-11-07T10:00:00.000Z'
  const start = Date.parse(at)
  t.is(MOMENT_MS, 86400000)
  t.is(expiresIn(at, start), MOMENT_MS)
  t.is(expiresIn(at, start + MOMENT_MS - 1), 1)
  t.is(expiresIn(at, start + MOMENT_MS), 0)
  t.is(expiresIn(at, start + MOMENT_MS + 1), 0)
  t.is(expiresIn('nope', start), 0)
})

test('progressOf', async (t) => {
  const { progressOf } = await load()
  t.alike(progressOf(0, 3), [0, 0, 0])
  t.alike(progressOf(2, 3), [1, 1, 0])
  t.alike(progressOf(0, 0), [])
})
