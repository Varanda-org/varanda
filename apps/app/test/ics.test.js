'use strict'

const test = require('brittle')
const load = () => import('../src/ics.js')

const card = (o = {}) => ({ title: 'Festa', place: 'Praça', startMs: Date.parse('2030-05-03T22:30:00Z'), endMs: null, ...o })

test('builds one event with CRLF lines', async (t) => {
  const m = await load()
  const out = m.buildIcs({ card: card({ endMs: Date.parse('2030-05-03T23:00:00Z') }), uid: 'ab-1', now: Date.parse('2030-01-01T00:00:00Z') })
  t.ok(out.startsWith('BEGIN:VCALENDAR\r\n'))
  t.ok(out.endsWith('END:VCALENDAR\r\n'))
  t.ok(out.includes('DTSTART:20300503T223000Z\r\n'))
  t.ok(out.includes('DTEND:20300503T230000Z\r\n'))
  t.ok(out.includes('DTSTAMP:20300101T000000Z\r\n'))
  t.ok(out.includes('SUMMARY:Festa\r\n'))
  t.ok(out.includes('UID:ab-1@varanda\r\n'))
  t.is(out.split('BEGIN:VEVENT').length, 2)
  t.absent(m.buildIcs({ card: card(), uid: 'x' }).includes('DTEND'))
  t.absent(m.buildIcs({ card: card({ place: '' }), uid: 'x' }).includes('LOCATION'))
})

test('peer text cannot add properties', async (t) => {
  const m = await load()
  const evil = 'a,b;c\\d\r\nEND:VEVENT\r\nBEGIN:VEVENT\nATTENDEE:x\u0000\u0007'
  const out = m.buildIcs({ card: card({ title: evil, place: evil }), uid: 'u\r\nX:1', now: 0 })
  const lines = out.split('\r\n')
  t.is(lines.filter((l) => l === 'END:VEVENT').length, 1)
  t.is(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1)
  t.absent(lines.some((l) => l.startsWith('ATTENDEE')))
  t.absent(lines.some((l) => l.startsWith('X:')))
  const flat = out.replace(/\r\n /g, '')
  t.ok(flat.includes('SUMMARY:a\\,b\\;c\\\\d\\nEND:VEVENT\\nBEGIN:VEVENT\\nATTENDEE:x'))
  t.absent(out.split('').some((c) => c.charCodeAt(0) < 9))
})

test('literal backslash n stays text', async (t) => {
  const m = await load()
  t.is(m.escapeText('a\\nb'), 'a\\\\nb')
})

test('long lines fold at 75 octets without splitting characters', async (t) => {
  const m = await load()
  const out = m.buildIcs({ card: card({ title: 'é'.repeat(80) }), uid: 'u', now: 0 })
  const enc = new TextEncoder()
  for (const l of out.split('\r\n')) t.ok(enc.encode(l).length <= 75)
  t.is(out.replace(/\r\n /g, '').includes('SUMMARY:' + 'é'.repeat(80)), true)
})
