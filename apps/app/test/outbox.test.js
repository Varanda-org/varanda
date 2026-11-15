'use strict'

// The outbox data layer (src/outbox.js): a leaf ES module with no imports,
// loaded here through Node's module syntax detection.
const test = require('brittle')

const load = () => import('../src/outbox.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const ASSOC = 'c'.repeat(64)
const OTHER_ASSOC = 'd'.repeat(64)
const T0 = Date.parse('2026-10-24T12:00:00.000Z')

const idOf = (n) => n.toString(16).padStart(16, '0')
// Any well-formed box: the node seals it (test/outboxSeal.test.js covers
// sealing and opening); this layer only checks its shape.
const BOX = 'Qk9Y'.repeat(20)

// Enqueues (stored as v2, sealed) and returns the new item open, i.e. with
// `to` and `text` in memory, as the provider holds it after outbox.open.
function add (o, items, fields) {
  const f = { author: A, association: ASSOC, kind: 'post', to: null, text: 'olá', now: T0, id: idOf(1), box: BOX, ...fields }
  const next = o.enqueue(items, f)
  return next.map((item, i) => i === next.length - 1 ? o.hydrate(item, { to: f.to === undefined ? null : f.to, text: f.text }) : item)
}

// The same item as stored before the seal (v1, clear `to` and `text`).
function legacy (o, item) {
  const { box, ...rest } = o.storedItem(item)
  return { ...rest, v: 1, to: item.to, text: item.text }
}

const entry = (seq, text, replyTo = null, at = new Date(T0).toISOString()) => ({ seq, record: { type: 'post', text, replyTo, at } })

// A log.read result; entriesTruncated defaults to the smallest seq of the window.
function page (entries, entriesTruncated, invalid) {
  if (entriesTruncated === undefined) {
    entriesTruncated = entries.length === 0 ? 0 : Math.min(...entries.map((e) => e.seq))
  }
  return { key: A, entries, invalid, entriesTruncated }
}

test('parse/serialize round trip', async (t) => {
  const o = await load()
  let items = add(o, [], { id: idOf(1) })
  items = add(o, items, { id: idOf(2), kind: 'reply', to: B + ':3', text: 'resposta', now: T0 + 1000 })
  const text = o.serializeOutbox(items)
  const back = o.parseOutbox(text)
  t.alike(back, items.map(o.storedItem))
  t.is(JSON.parse(text).v, 2)
  t.is(back[0].v, 2)
  t.is(back[0].box, BOX)
  t.is(back[0].writtenAt, new Date(T0).toISOString())
  t.is(back[0].state, 'queued')
  t.is(items[1].to, B + ':3', 'open in memory')
  t.absent('to' in back[1], 'the target is not stored')
  t.absent('text' in back[1], 'the text is not stored')
  t.absent(text.includes('resposta') || text.includes(B + ':3'), 'nothing of it in the stored value')
})

test('v1 items still parse, and are written back as they are', async (t) => {
  const o = await load()
  const v1 = legacy(o, add(o, [], { id: idOf(1), kind: 'reply', to: B + ':3', text: 'antiga' })[0])
  const [v2] = add(o, [], { id: idOf(2) }).map(o.storedItem)
  const back = o.parseOutbox(JSON.stringify({ v: 1, items: [v1] }))
  t.alike(back, [v1], 'a v1 envelope')
  t.alike(o.parseOutbox(JSON.stringify({ v: 2, items: [v1, v2] })), [v1, v2], 'v1 and v2 side by side')
  t.alike(o.parseOutbox(o.serializeOutbox([v1, v2])), [v1, v2], 'a v1 item keeps its clear fields until it is sealed')
})

test('sealedItem: the v1 item as v2 under the box, without to and text', async (t) => {
  const o = await load()
  const v1 = legacy(o, add(o, [], { kind: 'reply', to: B + ':3', text: 'antiga' })[0])
  const v2 = o.sealedItem(v1, BOX)
  t.is(v2.v, 2)
  t.is(v2.box, BOX)
  t.absent('to' in v2)
  t.absent('text' in v2)
  const { box, ...restV2 } = v2
  const { to, text, ...restV1 } = v1
  t.alike({ ...restV2, v: 1 }, restV1, 'every other field kept')
  t.alike(o.sealParams(v1), { id: v1.id, author: A, association: ASSOC, kind: 'reply', to: B + ':3', text: 'antiga', writtenAt: v1.writtenAt })
  t.alike(o.openParams(v2), { box: BOX, id: v1.id, author: A, association: ASSOC, kind: 'reply', writtenAt: v1.writtenAt })
  t.exception(() => o.sealedItem(v1, 'curta'), /publicação inválida/)
})

test('bad envelope gives []', async (t) => {
  const o = await load()
  const [good] = add(o, [], {}).map(o.storedItem)
  t.alike(o.parseOutbox('not json'), [])
  t.alike(o.parseOutbox(null), [])
  t.alike(o.parseOutbox(JSON.stringify({ v: 3, items: [good] })), [], 'unknown envelope version')
  t.alike(o.parseOutbox(JSON.stringify({ v: 1, items: {} })), [])
  t.alike(o.parseOutbox(JSON.stringify([])), [])
  t.alike(o.parseOutbox('null'), [])
})

test('malformed items are dropped', async (t) => {
  const o = await load()
  const good = o.storedItem(add(o, [], {})[0])
  const old = legacy(o, add(o, [], {})[0])
  const bad = [
    { ...good, author: A.toUpperCase() },
    { ...good, author: 'ab' },
    { ...good, association: 1 },
    { ...good, kind: 'repost' },
    { ...old, to: B + ':1' },
    { ...old, kind: 'reply', to: null },
    { ...old, kind: 'reply', to: B + ':0' },
    { ...old, kind: 'reply', to: B.toUpperCase() + ':1' },
    { ...old, kind: 'reply', to: B + ':01' },
    { ...old, kind: 'reply', to: B + ':9007199254740993' },
    { ...old, text: '' },
    { ...old, text: 'x'.repeat(1001) },
    { ...old, text: 5 },
    { ...good, box: undefined },
    { ...good, box: '' },
    { ...good, box: 'Q'.repeat(o.BOX_MIN - 1) },
    { ...good, box: 'Q'.repeat(o.BOX_MAX + 1) },
    { ...good, box: 'Q'.repeat(60) + '==' },
    { ...good, box: 'Q+/'.repeat(30) },
    { ...good, box: 'Q'.repeat(57) },
    { ...good, box: 'Q'.repeat(57) + 'R' },
    { ...good, box: 'Q'.repeat(54) + 'R' },
    { ...good, box: 5 },
    { ...good, v: 3 },
    { ...good, state: 'done' },
    { ...good, attempts: -1 },
    { ...good, attempts: 1.5 },
    { ...good, nextAt: 'now' },
    { ...good, floorSeq: -2 },
    { ...good, attemptAt: 'x' },
    { ...good, lastError: null },
    { ...good, id: 'xyz' },
    { ...good, writtenAt: 'ontem' },
    { ...good, writtenAt: '' },
    { ...good, writtenAt: 'Sun Nov 15 2026 12:00:00 GMT+0000 (Horário Padrão)' },
    null,
    'item'
  ]
  const kept = { ...old, id: idOf(9), text: '😀'.repeat(1000) }
  const keptV2 = { ...good, id: idOf(10), box: 'Q'.repeat(o.BOX_MAX), to: B + ':1', text: 'plantado em claro' }
  // The node's bounds: the shortest box, the longest writtenAt, the largest
  // safe seq, and the other canonical tails.
  const keptEdges = [
    { ...good, id: idOf(11), box: 'Q'.repeat(o.BOX_MIN) },
    { ...good, id: idOf(12), writtenAt: '2026-11-15T12:00:00.00000000000Z' },
    { ...old, id: idOf(13), kind: 'reply', to: B + ':9007199254740991' },
    { ...good, id: idOf(14), box: 'Q'.repeat(57) + 'Q' },
    { ...good, id: idOf(15), box: 'Q'.repeat(54) + 'A' }
  ]
  const parsed = o.parseOutbox(JSON.stringify({ v: 2, items: [...bad, kept, keptV2, ...keptEdges] }))
  t.alike(parsed.slice(2).map((i) => i.id), keptEdges.map((i) => i.id), 'the node\'s bounds are kept')
  t.is(parsed.length, 2 + keptEdges.length)
  t.is(keptEdges[1].writtenAt.length, o.WRITTEN_AT_MAX)
  t.is(parsed[0].id, idOf(9))
  t.is(parsed[1].id, idOf(10))
  t.absent('text' in parsed[1], 'a clear text next to a box is ignored')
  t.absent('to' in parsed[1])
})

test('a sending item survives parse as sending with floorSeq and attemptAt', async (t) => {
  const o = await load()
  const items = o.claim(add(o, [], {}), idOf(1), { now: T0 + 5000, floorSeq: 7 })
  const back = o.parseOutbox(o.serializeOutbox(items))
  t.is(back.length, 1)
  t.is(back[0].state, 'sending')
  t.is(back[0].floorSeq, 7)
  t.is(back[0].attemptAt, T0 + 5000)
})

test('enqueue validation errors', async (t) => {
  const o = await load()
  const invalid = [
    { author: 'x' },
    { association: ASSOC.toUpperCase() },
    { kind: 'repost' },
    { kind: 'post', to: B + ':1' },
    { kind: 'reply', to: null },
    { kind: 'reply', to: B + ':0' },
    { kind: 'reply', to: B + ':9007199254740993' },
    { text: '' },
    { text: 'x'.repeat(1001) },
    { id: 'short' },
    { id: idOf(1).toUpperCase().replace(/0/g, 'F') },
    { box: undefined },
    { box: 'Q'.repeat(o.BOX_MIN - 1) },
    { box: 'Q'.repeat(o.BOX_MAX + 1) },
    { box: 'Q+'.repeat(40) },
    { box: 'Q'.repeat(57) + 'R' },
    { now: -1 }
  ]
  for (const fields of invalid) {
    t.exception(() => add(o, [], fields), /publicação inválida/, JSON.stringify(fields))
  }
  t.is(add(o, [], { text: '😀'.repeat(1000) }).length, 1, '1000 code points accepted')
  const input = []
  add(o, input, {})
  t.is(input.length, 0, 'input not mutated')
})

test('enqueue refuses exactly the text the diary refuses', async (t) => {
  const o = await load()
  const { records } = require('@varanda/core')
  const coreAccepts = (text) => {
    try {
      records.postRecord({ text })
      return true
    } catch {
      return false
    }
  }
  const expected = [
    ['\u0000', false], ['\u0009', false], ['\u000a', true], ['\u001f', false],
    ['\u007f', false], ['\u009f', false], ['\u00a0', true],
    ['\u2027', true], ['\u2028', false], ['\u2029', false],
    ['\u202a', false], ['\u202e', false], ['\u202f', true],
    ['\u2065', true], ['\u2066', false], ['\u2069', false], ['\u206a', true]
  ]
  for (const [ch, accepted] of expected) {
    const text = 'a' + ch + 'b'
    const label = 'U+' + ch.codePointAt(0).toString(16).padStart(4, '0')
    t.is(coreAccepts(text), accepted, 'core ' + label)
    let enqueued
    try {
      enqueued = add(o, [], { text }).length === 1
    } catch (err) {
      t.is(err.message, 'publicação inválida', label)
      enqueued = false
    }
    t.is(enqueued, accepted, 'outbox ' + label)
    const [good] = add(o, [], {})
    const parsed = o.parseOutbox(JSON.stringify({ v: 1, items: [{ ...legacy(o, good), text }] }))
    t.is(parsed.length, accepted ? 1 : 0, 'parse ' + label)
  }
})

test('per-author limit: the 51st throws, another author still enqueues', async (t) => {
  const o = await load()
  let items = []
  for (let i = 0; i < o.OUTBOX_MAX; i++) items = add(o, items, { id: idOf(i + 1) })
  t.is(items.length, 50)
  t.exception(() => add(o, items, { id: idOf(100) }), /Muitas publicações aguardando envio/)
  t.exception(() => add(o, items, { id: idOf(100), association: OTHER_ASSOC }), /Muitas publicações aguardando envio/)
  items = add(o, items, { id: idOf(100), author: B })
  t.is(items.length, 51)
})

test('itemsOf hides another author and another association', async (t) => {
  const o = await load()
  let items = add(o, [], { id: idOf(2), now: T0 + 2000 })
  items = add(o, items, { id: idOf(3), author: B })
  items = add(o, items, { id: idOf(4), association: OTHER_ASSOC })
  items = add(o, items, { id: idOf(1), now: T0 })
  t.alike(o.itemsOf(items, A, ASSOC).map((i) => i.id), [idOf(1), idOf(2)])
  t.alike(o.itemsOf(items, B, ASSOC).map((i) => i.id), [idOf(3)])
  t.alike(o.itemsOf(items, A, OTHER_ASSOC).map((i) => i.id), [idOf(4)])
})

test('nextToSend: null while sending, else the oldest due queued item', async (t) => {
  const o = await load()
  let items = add(o, [], { id: idOf(1), now: T0 })
  items = add(o, items, { id: idOf(2), now: T0 + 1 })
  items = add(o, items, { id: idOf(3), now: T0 + 2 })
  items = add(o, items, { id: idOf(4), now: T0 + 3 })
  items = o.markUncertain(items, idOf(1))
  items = o.markFailed(items, idOf(2), 'erro')
  items = o.markRetry(items, idOf(3), { error: 'x', now: T0 })
  t.is(o.nextToSend(items, A, ASSOC, T0).id, idOf(4), 'skips uncertain, failed and a future nextAt')
  t.is(o.nextToSend(items, A, ASSOC, T0 + 30000).id, idOf(3), 'due once nextAt passes')
  t.is(o.nextDueAt(items, A, ASSOC), 0)
  t.is(o.nextToSend(items, B, ASSOC, T0), null)
  const claimed = o.claim(items, idOf(4), { now: T0, floorSeq: 2 })
  t.alike(o.sendingOf(claimed, A, ASSOC).id, idOf(4))
  t.is(o.nextToSend(claimed, A, ASSOC, T0 + 30000), null)
  t.is(o.nextDueAt(claimed, A, ASSOC), T0 + 30000)
  t.is(o.nextDueAt([], A, ASSOC), null)
})

test('claim sets sending, attemptAt and floorSeq', async (t) => {
  const o = await load()
  const items = add(o, [], {})
  const claimed = o.claim(items, idOf(1), { now: T0 + 9, floorSeq: -1 })
  t.is(claimed[0].state, 'sending')
  t.is(claimed[0].attemptAt, T0 + 9)
  t.is(claimed[0].floorSeq, -1)
  t.is(items[0].state, 'queued', 'input not mutated')
  t.exception(() => o.claim(items, idOf(1), { now: T0, floorSeq: -2 }))
})

test('claim, markRetry and wake refuse an invalid now', async (t) => {
  const o = await load()
  const items = add(o, [], {})
  for (const now of [NaN, new Date(T0), -1, undefined, '1']) {
    t.exception(() => o.claim(items, idOf(1), { now, floorSeq: 0 }), /instante inválido/, 'claim ' + String(now))
    t.exception(() => o.markRetry(items, idOf(1), { error: 'x', now }), /instante inválido/, 'markRetry ' + String(now))
    t.exception(() => o.wake(items, A, ASSOC, now), /instante inválido/, 'wake ' + String(now))
  }
  t.is(o.wake(items, A, ASSOC, 0)[0].nextAt, 0, 'zero is a valid instant')
})

test('reconcile: a sending item that is not open is left alone', async (t) => {
  const o = await load()
  const items = o.claim(add(o, [], {}), idOf(1), { now: T0, floorSeq: 5 }).map(o.storedItem)
  for (const p of [page([entry(6, 'olá')]), page([], 0), null]) {
    const r = o.reconcile(items, A, ASSOC, p, T0)
    t.is(r.status, 'sealed')
    t.is(r.items, items, 'the same array: nothing to save')
    t.is(r.sent, null)
  }
})

test('checkDraft and writtenAtOf', async (t) => {
  const o = await load()
  t.execution(() => o.checkDraft({ author: A, association: ASSOC, kind: 'reply', to: B + ':1', text: 'oi' }))
  t.execution(() => o.checkDraft({ author: A, association: ASSOC, kind: 'post', text: 'oi' }), 'to defaults to null')
  t.exception(() => o.checkDraft({ author: A, association: ASSOC, kind: 'post', to: B + ':1', text: 'oi' }), /publicação inválida/)
  t.exception(() => o.checkDraft({ author: A, association: ASSOC, kind: 'post', to: null, text: '' }), /publicação inválida/)
  t.is(o.writtenAtOf(T0), new Date(T0).toISOString())
  t.exception(() => o.writtenAtOf(NaN), /publicação inválida/)
  const [item] = add(o, [], { now: T0 + 7 })
  t.is(item.writtenAt, o.writtenAtOf(T0 + 7), 'enqueue stores the writtenAt that was sealed')
})

test('reconcile: a match removes the item and reports seq and ref', async (t) => {
  const o = await load()
  let items = add(o, [], { id: idOf(1), kind: 'reply', to: B + ':4', text: 'oi' })
  items = add(o, items, { id: idOf(2), author: B })
  items = o.claim(items, idOf(1), { now: T0, floorSeq: 5 })
  const entries = [entry(6, 'oi'), entry(7, 'oi', { author: B.toUpperCase(), seq: 4 })]
  const r = o.reconcile(items, A, ASSOC, page(entries), T0)
  t.is(r.status, 'sent')
  t.is(r.sent.seq, 7)
  t.is(r.sent.ref, A + ':7')
  t.is(r.sent.item.id, idOf(1))
  t.alike(r.items.map((i) => i.id), [idOf(2)])
})

test('reconcile: only a block dated within this attempt is ours', async (t) => {
  const o = await load()
  t.is(o.MATCH_SLACK_MS, 2000)
  const attemptAt = T0 + 3600000
  const items = o.claim(add(o, [], {}), idOf(1), { now: attemptAt, floorSeq: 5 })
  const at = (ms) => new Date(ms).toISOString()
  t.is(o.reconcile(items, A, ASSOC, page([entry(6, 'olá', null, at(attemptAt - 1000))]), T0).status, 'sent', 'within the slack')
  t.is(o.reconcile(items, A, ASSOC, page([entry(6, 'olá', null, at(attemptAt + 14000))]), T0).status, 'sent', 'appended during the gate')
  const early = o.reconcile(items, A, ASSOC, page([entry(6, 'olá', null, at(attemptAt - 3000))]), T0)
  t.is(early.status, 'unknown', 'another device, or a clock moved backward')
  t.is(early.items.length, 1, 'kept')
  t.is(early.items[0].state, 'uncertain')
  t.is(early.items[0].lastError, o.UNCERTAIN_MESSAGE)
  t.is(early.sent, null)
  const same = o.reconcile(items, A, ASSOC, page([entry(5, 'olá', null, at(attemptAt))]), T0)
  t.is(same.status, 'absent', 'seq === floorSeq is not a candidate')
  const unparsable = o.reconcile(items, A, ASSOC, page([entry(6, 'olá', null, 'ontem')]), T0)
  t.is(unparsable.status, 'unknown', 'an unparsable at is not proof of our append')
  t.is(o.ATTEMPT_WINDOW_MS, 60000)
  t.is(o.reconcile(items, A, ASSOC, page([entry(6, 'olá', null, at(attemptAt + 60000))]), T0).status, 'sent', 'the window end is inclusive')
  // The claim was saved, the tab closed before the request went out, and an
  // hour later another device published the same text: not this attempt.
  const later = o.reconcile(items, A, ASSOC, page([entry(6, 'olá', null, at(attemptAt + 3600000))]), T0)
  t.is(later.status, 'unknown', 'dated after the attempt window')
  t.alike(later.items.map((i) => [i.id, i.state]), [[idOf(1), 'uncertain']], 'kept, not removed')
  t.is(o.reconcile(items, A, ASSOC, page([entry(6, 'olá', null, at(attemptAt + 60001))]), T0).status, 'unknown', 'just past the window')
})

test('reconcile: an identical post from another device between writing and attempt is uncertain', async (t) => {
  const o = await load()
  // Queued at 12:00, the other device publishes the same text at 12:30, the
  // attempt starts at 13:00 with floor 5; the catch-up replicated it at seq 6.
  const items = o.claim(add(o, [], { now: T0 }), idOf(1), { now: T0 + 3600000, floorSeq: 5 })
  const other = new Date(T0 + 1800000).toISOString()
  const r = o.reconcile(items, A, ASSOC, page([entry(6, 'olá', null, other)]), T0 + 3600000)
  t.is(r.status, 'unknown')
  t.is(r.sent, null)
  t.alike(r.items.map((i) => [i.id, i.state]), [[idOf(1), 'uncertain']], 'not removed')
})

test('reconcile: an older replicated candidate and ours: sent with the higher seq', async (t) => {
  const o = await load()
  const items = o.claim(add(o, [], {}), idOf(1), { now: T0, floorSeq: 5 })
  const old = new Date(T0 - 86400000).toISOString()
  const ours = new Date(T0 + 500).toISOString()
  const r = o.reconcile(items, A, ASSOC, page([entry(7, 'olá', null, ours), entry(6, 'olá', null, old)]), T0)
  t.is(r.status, 'sent')
  t.is(r.sent.seq, 7)
  t.is(r.sent.ref, A + ':7')
  t.alike(r.items, [])
})

test('reconcile: a sending item without attemptAt never owns a candidate', async (t) => {
  const o = await load()
  const [item] = o.claim(add(o, [], {}), idOf(1), { now: T0, floorSeq: 5 })
  const items = [{ ...item, attemptAt: null }]
  const r = o.reconcile(items, A, ASSOC, page([entry(6, 'olá', null, new Date(T0).toISOString())]), T0)
  t.is(r.status, 'unknown')
  t.is(r.items[0].state, 'uncertain')
  t.is(r.items.length, 1)
})

test('reconcile: negatives with a window reaching the floor are absent', async (t) => {
  const o = await load()
  const items = o.claim(add(o, [], { kind: 'reply', to: B + ':4', text: 'oi' }), idOf(1), { now: T0, floorSeq: 5 })
  const pages = [
    page([entry(5, 'oi', { author: B, seq: 4 })]),
    page([entry(6, 'outro', { author: B, seq: 4 })]),
    page([entry(6, 'oi', { author: B, seq: 3 })]),
    page([entry(6, 'oi', null)]),
    page([{ seq: 6, record: { type: 'react', text: 'oi', replyTo: { author: B, seq: 4 }, at: '' } }]),
    page([], 0),
    page([], 6, [{ seq: 6, reason: 'assinatura' }]),
    page([entry(7, 'outro', { author: B, seq: 4 })], 6)
  ]
  for (const p of pages) {
    const r = o.reconcile(items, A, ASSOC, p, T0)
    t.is(r.status, 'absent', JSON.stringify(p))
    t.is(r.sent, null)
    t.is(r.items[0].state, 'queued')
    t.is(r.items[0].attemptAt, null)
    t.is(r.items[0].floorSeq, null)
    t.is(r.items[0].attempts, 0)
  }
})

test('reconcile: coverage by entriesTruncated', async (t) => {
  const o = await load()
  const items = o.claim(add(o, [], {}), idOf(1), { now: T0, floorSeq: 5 })
  t.is(o.reconcile(items, A, ASSOC, page([entry(7, 'outro')], 6), T0).status, 'absent', 'covers at floorSeq + 1')
  const r = o.reconcile(items, A, ASSOC, page([entry(7, 'outro'), entry(8, 'outro')], 7), T0)
  t.is(r.status, 'unknown', 'not at floorSeq + 2')
  t.is(r.items[0].state, 'uncertain')
  t.is(r.items[0].lastError, o.UNCERTAIN_MESSAGE)
  const empty = o.reconcile(items, A, ASSOC, page([], 7), T0)
  t.is(empty.status, 'unknown', 'an empty entries array above the floor proves nothing')
  const onlyInvalid = o.reconcile(items, A, ASSOC, page([], 7, [{ seq: 7, reason: 'assinatura' }, { seq: 8, reason: 'assinatura' }]), T0)
  t.is(onlyInvalid.status, 'unknown', 'a window of only invalid blocks proves nothing')
  t.is(onlyInvalid.items[0].state, 'uncertain')
  t.is(o.reconcile(add(o, [], {}), A, ASSOC, page([]), T0).status, 'none')
})

test('reconcile: a malformed result is unknown', async (t) => {
  const o = await load()
  const items = o.claim(add(o, [], {}), idOf(1), { now: T0, floorSeq: 5 })
  const bad = [
    null,
    undefined,
    [entry(6, 'olá')],
    { entries: [entry(6, 'olá')] },
    { entries: [entry(6, 'olá')], entriesTruncated: -1 },
    { entries: [entry(6, 'olá')], entriesTruncated: 1.5 },
    { entries: [entry(6, 'olá')], entriesTruncated: '6' },
    { entries: [entry(6, 'olá')], invalid: {}, entriesTruncated: 6 },
    { entries: 'x', entriesTruncated: 0 },
    new Error('leitura falhou')
  ]
  for (const p of bad) {
    const r = o.reconcile(items, A, ASSOC, p, T0)
    t.is(r.status, 'unknown', String(p))
    t.is(r.sent, null)
    t.is(r.items.length, 1, 'never removed')
    t.is(r.items[0].state, 'uncertain', 'never requeued')
  }
  const noInvalid = o.reconcile(items, A, ASSOC, { entries: [entry(6, 'olá')], entriesTruncated: 6 }, T0)
  t.is(noInvalid.status, 'sent', 'invalid may be undefined')
})

test('reconcile: two identical texts, only the sending one is consumed', async (t) => {
  const o = await load()
  let items = add(o, [], { id: idOf(1), now: T0 })
  items = add(o, items, { id: idOf(2), now: T0 + 1 })
  items = o.claim(items, idOf(1), { now: T0, floorSeq: 0 })
  const r = o.reconcile(items, A, ASSOC, page([entry(1, 'olá')]), T0)
  t.is(r.status, 'sent')
  t.alike(r.items.map((i) => [i.id, i.state]), [[idOf(2), 'queued']])
})

test('reconcile: a quote with the same text as a queued post leaves the post queued', async (t) => {
  const o = await load()
  const quoteOf = (seq, text) => ({ seq, record: { type: 'post', text, replyTo: null, quote: { author: B, seq: 4 }, at: new Date(T0).toISOString() } })
  const post = o.claim(add(o, [], { text: 'olá' }), idOf(1), { now: T0, floorSeq: 5 })
  const r = o.reconcile(post, A, ASSOC, page([quoteOf(6, 'olá')]), T0)
  t.is(r.status, 'absent', 'a quote never counts as the post')
  t.is(r.sent, null)
  t.is(r.items[0].state, 'queued')
  // The quote also hides nothing: the real post next to it is still found.
  const both = o.reconcile(post, A, ASSOC, page([quoteOf(7, 'olá'), entry(6, 'olá')]), T0)
  t.is(both.status, 'sent')
  t.is(both.sent.seq, 6)
  const reply = o.claim(add(o, [], { kind: 'reply', to: B + ':4', text: 'oi' }), idOf(1), { now: T0, floorSeq: 5 })
  const replyQuote = { seq: 6, record: { type: 'post', text: 'oi', replyTo: { author: B, seq: 4 }, quote: { author: B, seq: 4 }, at: new Date(T0).toISOString() } }
  t.is(o.reconcile(reply, A, ASSOC, page([replyQuote]), T0).status, 'absent', 'a record with a quote never matches a reply')
})

test('isQuoteRecord', async (t) => {
  const o = await load()
  t.ok(o.isQuoteRecord({ type: 'post', text: 'a', replyTo: null, quote: { author: B, seq: 1 } }))
  t.absent(o.isQuoteRecord({ type: 'post', text: 'a', replyTo: null }))
  t.absent(o.isQuoteRecord({ type: 'post', text: 'a', replyTo: null, quote: null }))
  t.absent(o.isQuoteRecord(null))
})

test('markRetry backoff', async (t) => {
  const o = await load()
  let items = add(o, [], {})
  const delays = []
  for (let i = 0; i < 6; i++) {
    items = o.claim(items, idOf(1), { now: T0, floorSeq: 0 })
    items = o.markRetry(items, idOf(1), { error: o.GATE_MESSAGE, now: T0 })
    delays.push(items[0].nextAt - T0)
  }
  t.alike(delays, [30000, 60000, 120000, 240000, 300000, 300000])
  t.is(items[0].state, 'queued')
  t.is(items[0].attempts, 6)
  t.is(items[0].attemptAt, null)
  t.is(items[0].lastError, o.GATE_MESSAGE)
})

test('markQueued resets attempts and keeps lastError; no-op while sending', async (t) => {
  const o = await load()
  let items = o.markRetry(add(o, [], {}), idOf(1), { error: 'falhou', now: T0 })
  items = o.markFailed(items, idOf(1), 'falhou de vez')
  items = o.markQueued(items, idOf(1))
  t.is(items[0].state, 'queued')
  t.is(items[0].attempts, 0)
  t.is(items[0].nextAt, 0)
  t.is(items[0].lastError, 'falhou de vez')
  const sending = o.claim(items, idOf(1), { now: T0, floorSeq: 0 })
  t.is(o.markQueued(sending, idOf(1))[0].state, 'sending')
})

test('wake sets nextAt of the pair queued items', async (t) => {
  const o = await load()
  let items = add(o, [], { id: idOf(1) })
  items = add(o, items, { id: idOf(2), author: B })
  items = o.markRetry(items, idOf(1), { error: 'x', now: T0 })
  items = o.markRetry(items, idOf(2), { error: 'x', now: T0 })
  const woken = o.wake(items, A, ASSOC, T0 + 5)
  t.is(woken[0].nextAt, T0 + 5)
  t.is(woken[1].nextAt, T0 + 30000)
})

test('remove refuses a sending item; removeAuthor', async (t) => {
  const o = await load()
  let items = add(o, [], { id: idOf(1) })
  items = add(o, items, { id: idOf(2) })
  items = add(o, items, { id: idOf(3), author: B })
  const claimed = o.claim(items, idOf(1), { now: T0, floorSeq: 0 })
  t.is(o.remove(claimed, idOf(1)), claimed)
  t.alike(o.remove(claimed, idOf(2)).map((i) => i.id), [idOf(1), idOf(3)])
  t.alike(o.removeAuthor(items, A).map((i) => i.id), [idOf(3)])
})

test('classifyFailure', async (t) => {
  const o = await load()
  const retried = [o.GATE_MESSAGE, o.LOCKED_MESSAGE, o.BUSY_MESSAGE, o.CLOSED_MESSAGE, o.NO_NODE_MESSAGE, o.SESSION_CLOSED_MESSAGE, o.TOO_MANY_MESSAGE]
  for (const message of retried) {
    t.is(o.classifyFailure(new Error(message)), 'retry', message)
  }
  t.is(o.SESSION_CLOSED_MESSAGE, 'sessão encerrada')
  t.is(o.TOO_MANY_MESSAGE, 'pedidos demais em andamento')
  t.is(o.classifyFailure(new Error('sessão encerrada.')), 'fail')
  t.is(o.classifyFailure({ code: 'CLOSED', message: 'x' }), 'retry')
  t.is(o.classifyFailure({ uncertain: true, message: o.GATE_MESSAGE }), 'uncertain')
  t.is(o.classifyFailure(new Error('sincronize com o semeador antes de publicar.')), 'fail')
  t.is(o.classifyFailure(new Error('texto inválido')), 'fail')
  t.is(o.classifyFailure(null), 'fail')
})

test('rpcParams has no at and no extra key', async (t) => {
  const o = await load()
  const [post] = add(o, [], {})
  const [reply] = add(o, [], { kind: 'reply', to: B + ':2', text: 'r' })
  t.alike(o.rpcParams(post), { text: 'olá' })
  t.alike(o.rpcParams(reply), { to: B + ':2', text: 'r' })
  t.absent('at' in o.rpcParams(post))
})

test('maxSeq', async (t) => {
  const o = await load()
  t.is(o.maxSeq(page([])), -1)
  t.is(o.maxSeq(page([{ seq: 3 }, { seq: 9 }, { seq: 1.5 }, { seq: 4 }], 3)), 9)
  t.is(o.maxSeq(page([{ seq: 3 }], 3, [{ seq: 11, reason: 'assinatura' }, { seq: 4, reason: 'x' }])), 11, 'counts invalid blocks')
  t.is(o.maxSeq(page([], 11, [{ seq: 11, reason: 'assinatura' }])), 11)
  t.is(o.maxSeq([{ seq: 3 }]), -1, 'an entries array is not a result')
  t.is(o.maxSeq(null), -1)
  t.is(o.maxSeq({ entries: [{ seq: 3 }] }), -1, 'missing entriesTruncated')
})

test('reconcile: a deleted slot above the floor is uncertain, never requeued', async (t) => {
  const o = await load()
  const items = o.claim(add(o, [], {}), idOf(1), { now: T0, floorSeq: 5 })
  const r = o.reconcile(items, A, ASSOC, page([], 0, [{ seq: 6, reason: 'deleted' }]), T0)
  t.is(r.status, 'unknown')
  t.is(r.sent, null)
  t.alike(r.items.map((i) => [i.id, i.state]), [[idOf(1), 'uncertain']])
  t.is(o.reconcile(items, A, ASSOC, page([], 0, [{ seq: 5, reason: 'deleted' }]), T0).status, 'absent', 'at the floor')
  t.is(o.reconcile(items, A, ASSOC, page([], 0, [{ seq: 6, reason: 'malformed' }]), T0).status, 'absent', 'other reasons')
})

test('reconcile: our post found beside an unrelated deleted slot is sent', async (t) => {
  const o = await load()
  const attemptAt = T0 + 3600000
  const items = o.claim(add(o, [], {}), idOf(1), { now: attemptAt, floorSeq: 5 })
  const at = (ms) => new Date(ms).toISOString()
  const r = o.reconcile(items, A, ASSOC, page([entry(8, 'olá', null, at(attemptAt + 1000))], 6, [{ seq: 7, reason: 'deleted' }]), T0)
  t.is(r.status, 'sent')
  t.is(r.sent.seq, 8)
  t.alike(r.items, [])
})

test('hexId', async (t) => {
  const o = await load()
  const id = o.hexId(new Uint8Array([0, 1, 15, 16, 127, 128, 254, 255]))
  t.is(id, '00010f107f80feff')
  t.ok(/^[0-9a-f]{16}$/.test(id))
  t.exception(() => o.hexId(new Uint8Array(4)))
})
