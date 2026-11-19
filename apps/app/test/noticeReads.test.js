'use strict'

const test = require('brittle')
const load = () => import('../src/noticeReads.js')
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

test('group read snapshots retain exact public counts and total private unread', async (t) => {
  const { groupReadState } = await load()
  const rows = [
    { group: A, visibility: 'public', unread: 0, last: { at: '2026-11-19T12:00:00.000Z' } },
    { group: B, visibility: 'private', unread: 2 },
    { group: 'c'.repeat(64), visibility: 'private', unread: 3 }
  ]
  t.alike(groupReadState({ rows }), {
    groups: [{ group: A, unread: 0, at: rows[0].last.at }],
    privateUnread: 5
  })
  t.alike(groupReadState({ rows: [] }), { groups: [], privateUnread: 0 })
  t.is(rows[0].unread, 0)
  t.is(rows[1].unread, 2)
})

test('unknown or incomplete group reads cannot claim no private unread', async (t) => {
  const { groupReadState } = await load()
  const publicRow = { group: A, visibility: 'public', unread: 0 }
  for (const row of [
    { group: B, seeded: true },
    { group: B, unread: 0 },
    ...[undefined, null, '0', -1, false].map((unread) => ({ group: B, visibility: 'private', unread }))
  ]) {
    const snapshot = groupReadState({ rows: [publicRow, row] })
    t.is(snapshot.privateUnread, undefined)
    t.alike(snapshot.groups, [{ group: A, unread: 0, at: undefined }])
  }
  t.is(groupReadState({ rows: [publicRow], partial: true }).privateUnread, undefined)
  for (const failure of [{ failed: true }, { error: 'failed' }]) {
    t.alike(groupReadState({ rows: [publicRow], ...failure }), { groups: [], privateUnread: undefined })
  }
})

test('group read snapshots do not normalize unknown counts to zero or publish seeds', async (t) => {
  const { groupReadState } = await load()
  for (const unread of [undefined, null, '0', false, -1]) {
    t.is(groupReadState({ rows: [{ group: A, visibility: 'public', unread }] }).groups[0].unread, unread)
  }
  t.alike(groupReadState({ rows: [{ group: A, visibility: 'public', unread: 0, seeded: true }] }), { groups: [], privateUnread: undefined })
})

test('aviso read snapshots use valid seen tokens and preserve the target of a reply', async (t) => {
  const { avisoReadRows } = await load()
  const row = Object.freeze({ kind: 'reply', key: A, seq: 3, post: B + ':7', at: '2026-11-19T12:00:00.000Z', seen: 'a'.repeat(32) })
  const expected = { kind: row.kind, key: A, seq: 3, post: B + ':7', at: row.at }
  t.alike(avisoReadRows([row], [row.seen]), [{ ...expected, read: true }])
  t.alike(avisoReadRows([row], []), [{ ...expected, read: false }])
  for (const seen of [undefined, '', 'invalid']) {
    t.is(avisoReadRows([{ ...row, seen }], [seen])[0].read, false)
  }
  t.is(avisoReadRows([{ ...row, post: undefined }], [row.seen])[0].post, undefined, 'no fallback to the reply ref')
  t.is(row.read, undefined, 'the screen row is untouched')
})
