'use strict'

const test = require('brittle')
const load = () => import('../src/group-screen.js')
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)
const start = new Date(2026, 9, 10, 12).getTime()
const message = (writer, seq, offset = 0, extra = {}) => ({
  writer,
  diary: writer,
  seq,
  at: new Date(start + offset).toISOString(),
  text: 'Olá',
  ...extra
})

test('groupRows keeps oldest first, stable keys and the input unchanged', async (t) => {
  const { groupRows } = await load()
  const items = Object.freeze([
    Object.freeze(message(B, 1, 2000)),
    Object.freeze(message(A, 2, 1000)),
    Object.freeze(message(A, 1))
  ])
  const rows = groupRows(items, A)
  t.alike(rows.map((r) => r.key), [A + ':1', A + ':2', B + ':1'])
  t.alike(rows.map((r) => r.side), ['mine', 'mine', 'theirs'])
  t.alike(rows.map((r) => r.shape), ['first', 'last', 'single'])
  t.alike(rows.map((r) => r.showName), [true, false, true])
  t.alike(items.map((i) => i.seq), [1, 2, 1])
  t.is(groupRows([message(B, 1, 0, { diary: A })], A)[0].side, 'mine', 'ownership follows the diary, not the device writer')
  t.is(groupRows([message(A, 1, 0, { diary: B })], A)[0].side, 'theirs')
  t.is(groupRows([message(A, 1, 0, { diary: null })], null)[0].side, 'theirs')
  t.alike(groupRows(null, A), [])
  t.alike(groupRows([null, {}], A), [])
  t.is(groupRows([items[0], items[0]], A).length, 1)
})

test('groupRows groups by person (diary) and anchors the time limit at the first bubble', async (t) => {
  const { groupRows } = await load()
  const { DM_GROUP_MS } = await import('../src/dm-screen.js')
  const items = [
    message(A, 1),
    message(A, 2, DM_GROUP_MS / 2),
    message(A, 3, DM_GROUP_MS),
    message(A, 4, DM_GROUP_MS + 1),
    message(B, 1, DM_GROUP_MS + 2, { diary: A }),
    message(C, 1, DM_GROUP_MS + 3),
    message(A, 5, DM_GROUP_MS + 4)
  ]
  const rows = groupRows(items.reverse(), A)
  t.alike(rows.map((r) => r.shape), ['first', 'middle', 'last', 'first', 'last', 'single', 'single'], 'a second device of the same diary joins the run')
  t.alike(rows.map((r) => r.showName), [true, false, false, true, false, true, true])
  t.alike(rows.map((r) => r.side), ['mine', 'mine', 'mine', 'mine', 'mine', 'theirs', 'mine'])
})

test('groupRows marks local days and breaks runs at midnight or invalid times', async (t) => {
  const { groupRows } = await load()
  const at = (day, hour, minute) => new Date(2026, 9, day, hour, minute).toISOString()
  const rows = groupRows([
    message(A, 4, 0, { at: 'invalid' }),
    message(A, 3, 0, { at: at(11, 0, 1) }),
    message(A, 2, 0, { at: at(11, 0, 0) }),
    message(A, 1, 0, { at: at(10, 23, 59) })
  ], A)
  t.ok(rows[0].dayMark)
  t.ok(rows[1].dayMark)
  t.not(rows[0].dayMark, rows[1].dayMark)
  t.is(rows[2].dayMark, null)
  t.is(rows[3].dayMark, null)
  t.alike(rows.map((r) => r.shape), ['single', 'first', 'last', 'single'])
  t.alike(rows.map((r) => r.showName), [true, true, false, true])
})

test('groupRows escapes peer text and discards hidden message content', async (t) => {
  const { groupRows } = await load()
  const { HIDDEN_LABEL } = await import('../src/groups.js')
  const rows = groupRows([
    message(A, 2, 1000, { hidden: true, text: 'não mostrar' }),
    message(B, 1, 0, { text: 'oi\n\u202e\ud800', replyTo: { writer: A, seq: 2 } })
  ], A)
  t.is(rows[0].text, 'oi\n\ufffd\ufffd')
  t.is(rows[0].rawText, 'oi\n\u202e\ud800', 'MentionText needs the original text to reject unsafe links')
  t.is(rows[0].replyTo, A + ':2')
  t.is(rows[1].text, HIDDEN_LABEL)
  t.is(rows[1].rawText, '')
})

test('replyPreview uses only loaded targets and hides both content and name', async (t) => {
  const { groupRows, replyPreview } = await load()
  const { HIDDEN_LABEL } = await import('../src/groups.js')
  const target = message(A, 1, 0, { name: 'Ana', text: 'Primeira mensagem' })
  const reply = message(B, 1, 1000, { replyTo: { writer: A, seq: 1 } })
  const byRef = new Map([[A + ':1', target]])
  t.alike(replyPreview(reply, byRef), { name: 'Ana', text: 'Primeira mensagem' })
  t.alike(replyPreview(groupRows([reply], A)[0], byRef), { name: 'Ana', text: 'Primeira mensagem' })
  t.is(replyPreview(reply, new Map([[B + ':1', target]])), null, 'the sequence alone cannot identify a target')
  t.is(replyPreview(message(B, 2), byRef), null)
  t.is(replyPreview(null, byRef), null)
  t.is(replyPreview({ replyTo: { writer: A, seq: '1' } }, byRef), null)
  byRef.set(A + ':1', { ...target, hidden: true })
  t.alike(replyPreview(reply, byRef), { name: '', text: HIDDEN_LABEL })
})

test('replyPreview collapses line breaks and escapes names and lone surrogates', async (t) => {
  const { replyPreview } = await load()
  const preview = (target) => replyPreview({ replyTo: { writer: A, seq: 1 } }, new Map([[A + ':1', target]]))
  t.alike(preview({ name: 'Ana\u202e', text: 'um\r\n\ndois\rtrês\u2028quatro\u2029cinco\u0000\ud800' }), {
    name: 'Ana\ufffd',
    text: 'um dois três quatro cinco\ufffd\ufffd'
  })
  t.is(preview({ username: 'bia', text: '' }).name, 'bia', 'a known username supplies the name')
  t.is(preview({ name: '@Ana', text: null }).name, 'Ana')
  t.is(preview({}).text, '')
  t.is(preview({ text: 'a'.repeat(89) + '\ud800' + 'z' }).text, 'a'.repeat(89) + '\ufffd')
  t.is(preview({ text: 'a'.repeat(89) + '\udc00' + 'z' }).text, 'a'.repeat(89) + '\ufffd')
})

test('replyPreview clips at 90 code points without splitting an emoji', async (t) => {
  const { replyPreview } = await load()
  const preview = (text) => replyPreview({ replyTo: A + ':1' }, new Map([[A + ':1', { name: 'Ana', text }]])).text
  t.is(preview('a'.repeat(89) + '😀' + 'z'), 'a'.repeat(89) + '😀')
  t.is(preview('😀'.repeat(91)), '😀'.repeat(90))
  t.is(preview('a'.repeat(90)), 'a'.repeat(90))
  t.is(preview('a'.repeat(89) + '\r\n' + 'z'), 'a'.repeat(89) + ' ', 'line breaks collapse before clipping')
})

test('groupRows takes the clock, so a day change relabels hoje as ontem', async (t) => {
  const { groupRows } = await load()
  const A = 'a'.repeat(64)
  const at = new Date(2026, 9, 10, 12, 0).toISOString()
  const items = [{ writer: A, seq: 1, diary: A, text: 'oi', at, hidden: false, replyTo: null }]
  const sameDay = groupRows(items, A, new Date(2026, 9, 10, 23, 0).getTime())
  const nextDay = groupRows(items, A, new Date(2026, 9, 11, 0, 30).getTime())
  t.is(sameDay[0].dayMark, 'hoje')
  t.is(nextDay[0].dayMark, 'ontem')
})
