'use strict'

// Confirmed own replies: the item and the listener bus (ownReply.js).
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/ownReply.js')

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const AT = '2026-10-20T10:00:00.000Z'

function base (over = {}) {
  return { author: A, seq: 1, to: B + ':1', text: 'oi', at: AT, ...over }
}

test('ownReplyItem accepts a ref string and an object target', async (t) => {
  const { ownReplyItem } = await load()
  const media = [{ core: 'ab' }]
  const byRef = ownReplyItem({
    author: A.toUpperCase(),
    seq: 4,
    to: B + ':2',
    text: 'oi',
    at: AT,
    media: []
  })
  t.alike(byRef, {
    kind: 'post',
    author: A,
    seq: 4,
    at: AT,
    text: 'oi',
    replyTo: { author: B, seq: 2 },
    gen: null
  })
  t.absent(byRef.media, 'an empty media array is dropped')

  const byObj = ownReplyItem({
    author: A,
    seq: 5,
    to: { author: B.toUpperCase(), seq: 9 },
    text: '',
    at: AT,
    media
  })
  t.alike(byObj, {
    kind: 'post',
    author: A,
    seq: 5,
    at: AT,
    text: '',
    replyTo: { author: B, seq: 9 },
    media,
    gen: null
  })
  t.is(byObj.media, media, 'a non-empty media array is kept')

  const before = Date.now()
  const timed = ownReplyItem({ author: A, seq: 1, to: B + ':1', text: 'agora' })
  const after = Date.now()
  const parsed = Date.parse(timed.at)
  t.ok(parsed >= before && parsed <= after, 'at defaults to now')
  const badAt = ownReplyItem({ author: A, seq: 1, to: { author: B, seq: 1 }, text: 'agora', at: 'nope' })
  const parsedBad = Date.parse(badAt.at)
  t.ok(parsedBad >= before && parsedBad <= Date.now(), 'an at string Date.parse refuses is replaced')
  t.ok(badAt.at !== 'nope')
})

test('ownReplyItem rejects seq 0, a bad author, a bad target, a non-string text and empty text without media', async (t) => {
  const { ownReplyItem } = await load()
  t.is(ownReplyItem(base({ seq: 0 })), null, 'seq 0')
  t.is(ownReplyItem(base({ seq: 1.5 })), null, 'fractional seq')
  t.is(ownReplyItem(base({ author: 'nope' })), null, 'bad author')
  t.is(ownReplyItem(base({ author: 1 })), null, 'author that is not a string')
  t.is(ownReplyItem(base({ to: 'bad' })), null, 'bad ref')
  t.is(ownReplyItem(base({ to: { author: 'nope', seq: 1 } })), null, 'bad target author')
  t.is(ownReplyItem(base({ to: { author: B, seq: 0 } })), null, 'target seq 0')
  t.is(ownReplyItem(base({ to: null })), null, 'missing target')
  t.is(ownReplyItem(base({ text: 1 })), null, 'non-string text')
  t.is(ownReplyItem(base({ text: null })), null, 'null text')
  t.is(ownReplyItem(base({ text: '' })), null, 'empty text without media')
  t.is(ownReplyItem(base({ text: '', media: [] })), null, 'empty text with an empty media array')
  t.is(ownReplyItem(null), null)
  t.is(ownReplyItem(), null)
  t.is(ownReplyItem('oi'), null)
})

test('gen is kept for a safe integer and null otherwise', async (t) => {
  const { ownReplyItem } = await load()
  t.is(ownReplyItem(base({ gen: 0 })).gen, 0, 'zero is a generation')
  t.is(ownReplyItem(base({ gen: 4 })).gen, 4)
  t.is(ownReplyItem(base({ gen: Number.MAX_SAFE_INTEGER })).gen, Number.MAX_SAFE_INTEGER)
  t.is(ownReplyItem(base({ gen: Number.MAX_SAFE_INTEGER + 1 })).gen, null, 'above the safe range')
  t.is(ownReplyItem(base()).gen, null, 'missing')
  t.is(ownReplyItem(base({ gen: -1 })).gen, null, 'negative')
  t.is(ownReplyItem(base({ gen: 1.5 })).gen, null, 'fractional')
  t.is(ownReplyItem(base({ gen: '2' })).gen, null, 'non-number')
  t.is(ownReplyItem(base({ gen: null })).gen, null, 'null')
  t.is(ownReplyItem(base({ gen: Infinity })).gen, null, 'not a safe integer')
})

test('listeners receive the item and the sender token', async (t) => {
  const { ownReplyItem, onOwnReply, announceOwnReply } = await load()
  const item = ownReplyItem(base({ seq: 3, gen: 2 }))
  const seen = []
  const screen = { name: 'conversa' }
  const off = onOwnReply((got, from) => { seen.push([got, from]) })
  t.teardown(off)
  t.is(announceOwnReply(item, 'publicar'), 1)
  t.is(seen[0][0], item)
  t.is(seen[0][1], 'publicar')
  t.is(announceOwnReply(item, screen), 1)
  t.is(seen[1][1], screen)
  t.is(announceOwnReply(item), 1)
  t.is(seen[2][1], null, 'from defaults to null')
})

test('a removed listener is not called', async (t) => {
  const { ownReplyItem, onOwnReply, announceOwnReply } = await load()
  const item = ownReplyItem(base())
  const seen = []
  const offA = onOwnReply(() => { seen.push('a') })
  const offB = onOwnReply(() => { seen.push('b') })
  t.teardown(offB)
  offA()
  t.is(announceOwnReply(item, 'publicar'), 1)
  t.alike(seen, ['b'])
})

test('a throwing listener does not stop the next one', async (t) => {
  const { ownReplyItem, onOwnReply, announceOwnReply } = await load()
  const item = ownReplyItem(base())
  const seen = []
  const offA = onOwnReply(() => { throw new Error('boom') })
  const offB = onOwnReply(() => { seen.push('b') })
  const offC = onOwnReply(() => { throw new Error('boom') })
  t.teardown(offA)
  t.teardown(offB)
  t.teardown(offC)
  t.is(announceOwnReply(item, 'publicar'), 3)
  t.alike(seen, ['b'])
})

test('announceOwnReply(null) calls nobody', async (t) => {
  const { onOwnReply, announceOwnReply, ownReplyItem } = await load()
  const seen = []
  const off = onOwnReply(() => { seen.push('x') })
  t.teardown(off)
  t.is(announceOwnReply(null), 0)
  t.is(announceOwnReply(undefined), 0)
  t.is(announceOwnReply('publicar'), 0)
  t.is(announceOwnReply(ownReplyItem(base({ seq: 0 }))), 0)
  t.alike(seen, [])
})

test('the gone channel delivers a Set and is independent of the reply channel', async (t) => {
  const { ownReplyItem, onOwnReply, announceOwnReply, onOwnReplyGone, announceOwnReplyGone } = await load()
  const item = ownReplyItem(base())
  const replies = []
  const gones = []
  const offR = onOwnReply((got, from) => { replies.push(got.seq + ':' + from) })
  const offG = onOwnReplyGone((set) => { gones.push(set) })
  t.teardown(offR)
  t.teardown(offG)
  t.is(announceOwnReply(item, 'publicar'), 1)
  t.alike(replies, ['1:publicar'])
  t.alike(gones, [], 'a reply does not reach the gone channel')

  const refs = [A + ':4', B + ':1']
  t.is(announceOwnReplyGone(refs), 1)
  t.is(gones.length, 1)
  t.ok(gones[0] instanceof Set)
  t.alike([...gones[0]], refs)
  t.alike(replies, ['1:publicar'], 'gone does not reach the reply channel')

  const asSet = new Set([A + ':8'])
  t.is(announceOwnReplyGone(asSet), 1)
  t.ok(gones[1] instanceof Set)
  t.ok(gones[1].has(A + ':8'))

  t.is(announceOwnReplyGone([]), 0)
  t.is(announceOwnReplyGone(new Set()), 0)
  t.is(announceOwnReplyGone(null), 0)
  t.is(gones.length, 2, 'an empty input calls nobody')

  offG()
  t.is(announceOwnReplyGone(refs), 0)
  t.is(gones.length, 2, 'a removed gone listener is not called')
})

test('a throwing gone listener does not stop the next one', async (t) => {
  const { onOwnReplyGone, announceOwnReplyGone } = await load()
  const seen = []
  const offA = onOwnReplyGone(() => { throw new Error('boom') })
  const offB = onOwnReplyGone((set) => { seen.push(set) })
  t.teardown(offA)
  t.teardown(offB)
  t.is(announceOwnReplyGone([A + ':1']), 2)
  t.is(seen.length, 1)
  t.ok(seen[0] instanceof Set)
})

test('the module imports in plain Node', async (t) => {
  const mod = await load()
  t.is(typeof mod.ownReplyItem, 'function')
  t.is(typeof mod.onOwnReply, 'function')
  t.is(typeof mod.announceOwnReply, 'function')
  t.is(typeof mod.onOwnReplyGone, 'function')
  t.is(typeof mod.announceOwnReplyGone, 'function')
  const src = fs.readFileSync(path.join(__dirname, '../src/ownReply.js'), 'utf8')
  t.alike(src.match(/from ['"][^'"]+['"]/g), ["from './thread.js'", "from './nav.js'"])
  t.absent(src.includes('require('))
  t.absent(src.includes('\u2014'))
  t.absent(src.includes('new Map'), 'no item storage')
  t.is(mod.ownReplyItem(base()).author, A)
})
