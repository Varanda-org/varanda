'use strict'

const test = require('brittle')
const load = () => import('../src/events.js')

const ev = (o = {}) => ({ title: 'Festa', start: '2030-05-03T22:30:00.000Z', end: null, place: 'Praça', ...o })

test('eventCard validates the shape', async (t) => {
  const m = await load()
  const c = m.eventCard(ev())
  t.is(c.title, 'Festa')
  t.is(c.endMs, null)
  t.is(c.startMs, Date.parse('2030-05-03T22:30:00.000Z'))
  t.ok(m.eventCard(ev({ place: '' })))
  t.ok(m.eventCard(ev({ end: '2030-05-03T23:30:00.000Z' })))
  t.is(m.eventCard(ev({ title: '' })), null)
  t.is(m.eventCard(ev({ title: 'x'.repeat(81) })), null)
  t.is(m.eventCard(ev({ place: 'x'.repeat(121) })), null)
  t.is(m.eventCard(ev({ start: '2030-05-03' })), null)
  t.is(m.eventCard(ev({ start: '2030-05-03T22:30:00+02:00' })), null)
  t.is(m.eventCard(ev({ end: '2030-05-03T21:00:00.000Z' })), null, 'end before start')
  t.is(m.eventCard(null), null)
  t.is(m.eventCard([]), null)
})

test('limits count code points; instants are canonical', async (t) => {
  const m = await load()
  t.ok(m.eventCard(ev({ title: '😀'.repeat(80), place: '😀'.repeat(120) })))
  t.is(m.eventCard(ev({ title: '😀'.repeat(81) })), null)
  t.is(m.eventCard(ev({ place: '😀'.repeat(121) })), null)
  for (const bad of ['2030-05-03T22:30:00Z', '2030-02-30T10:00:00.000Z', '2030-05-03T24:00:00.000Z', '2019-12-31T23:59:59.999Z', '2100-01-01T00:00:00.001Z']) {
    t.is(m.instantMs(bad), null, bad)
  }
  t.ok(m.instantMs('2020-01-01T00:00:00.000Z') !== null)
  t.ok(m.instantMs('2100-01-01T00:00:00.000Z') !== null)
})

test('whenText is pt-BR local time', async (t) => {
  const m = await load()
  const d = new Date(2030, 4, 3, 19, 30)
  const card = m.eventCard(ev({ start: d.toISOString(), end: new Date(2030, 4, 3, 22, 0).toISOString() }))
  t.is(m.whenText(card), 'sex, 3 de mai de 2030, 19:30 às 22:00')
  const two = m.eventCard(ev({ start: d.toISOString(), end: new Date(2030, 4, 4, 1, 5).toISOString() }))
  t.is(m.whenText(two), 'sex, 3 de mai de 2030, 19:30 até sáb, 4 de mai de 2030, 01:05')
  t.is(m.whenText(m.eventCard(ev({ start: d.toISOString() }))), 'sex, 3 de mai de 2030, 19:30')
})

test('upcoming and past split', async (t) => {
  const m = await load()
  const now = Date.parse('2030-01-10T12:00:00.000Z')
  const mk = (id, start, end = null) => ({ id, card: m.eventCard(ev({ start, end })) })
  const items = [
    mk('b', '2030-02-01T10:00:00.000Z'),
    mk('a', '2030-01-11T10:00:00.000Z'),
    mk('p1', '2030-01-01T10:00:00.000Z'),
    mk('p2', '2030-01-05T10:00:00.000Z'),
    mk('live', '2030-01-10T10:00:00.000Z', '2030-01-10T14:00:00.000Z'),
    { id: 'bad', card: null }
  ]
  const { upcoming, past } = m.splitEvents(items, now)
  t.alike(upcoming.map((x) => x.id), ['live', 'a', 'b'])
  t.alike(past.map((x) => x.id), ['p2', 'p1'])
})

test('a gone event is cancelado', async (t) => {
  const m = await load()
  const r = m.eventRow({ ref: { author: 'a', seq: 1 }, gone: true })
  t.is(r.status, 'cancelado')
  t.is(r.card, null)
  t.is(m.eventRow({ ref: {}, event: { title: '' } }), null)
  const ok = m.eventRow({ ref: {}, event: ev() }, Date.parse('2030-05-04T00:00:00.000Z'))
  t.is(ok.status, 'já passou')
})
