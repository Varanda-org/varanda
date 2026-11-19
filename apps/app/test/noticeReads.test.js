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

test('aviso read snapshots remember an unread like omitted by later first pages', async (t) => {
  const { avisoReadRows } = await load()
  const { readTags } = await import('../src/noticeTags.js')
  const state = {}
  const newer = { kind: 'like', key: A, seq: 2, post: B + ':7', seen: 'a'.repeat(32) }
  const older = { ...newer, seq: 1, seen: 'b'.repeat(32) }
  const tags = (rows, ids) => readTags({ avisos: avisoReadRows(rows, ids, state, 1000) })
  t.alike(tags([newer, older], [newer.seen]), [])
  t.alike(tags([newer], [newer.seen]), [], 'moving the unread like to page two cannot close the post tag')
  t.alike(tags([], [newer.seen]), [], 'an empty poll cannot forget the unread row')
  t.alike(tags([newer], [newer.seen]), [], 'later polls still exclude the tag')
  t.alike(tags([older], [newer.seen, older.seen]), ['varanda-like-' + B + ':7'], 'a later answer confirms the older like read')
  t.alike(tags([newer], [newer.seen]), ['varanda-like-' + B + ':7'])
})

test('aviso unread retention expires after 24 hours without promoting the shared tag', async (t) => {
  const { avisoReadRows } = await load()
  const { readTags } = await import('../src/noticeTags.js')
  const state = {}
  const newer = { kind: 'like', key: A, seq: 2, post: B + ':7', seen: 'a'.repeat(32) }
  const older = { ...newer, seq: 1, seen: 'b'.repeat(32) }
  const other = { ...newer, seq: 3, post: B + ':8' }
  const ttl = 24 * 3600 * 1000
  avisoReadRows([newer, older], [newer.seen], state, 1000)
  t.alike(readTags({ avisos: avisoReadRows([newer], [newer.seen], state, 1000 + ttl - 1) }), [])
  t.is(state.unread?.size, 1, 'an omitted unread row survives until the deadline')
  const expired = avisoReadRows([newer, other], [newer.seen], state, 1000 + ttl)
  t.is(state.unread?.size, 0, 'polls do not extend retention of omitted rows')
  t.alike(readTags({ avisos: expired }), ['varanda-like-' + B + ':8'], 'forgetting a row is not evidence that its tag is read')
  t.alike(readTags({ avisos: avisoReadRows([newer], [newer.seen], state, 1000 + ttl * 2) }), [], 'the forgotten row cannot be rediscovered as read by a later poll')
})

test('aviso unread retention caps rows and excludes tags whose evidence was dropped', async (t) => {
  const { avisoReadRows } = await load()
  const { readTags } = await import('../src/noticeTags.js')
  const state = {}
  const rows = Array.from({ length: 257 }, (_, i) => ({ kind: 'like', key: A, seq: i + 1, post: B + ':' + (i + 1), seen: 'b'.repeat(32) }))
  const newer = { ...rows[0], seq: 258, seen: 'a'.repeat(32) }
  const other = { ...newer, seq: 259, post: B + ':300' }
  const first = avisoReadRows([newer, ...rows], [newer.seen], state, 1000)
  t.alike(readTags({ avisos: first }), [], 'overflow never promotes an unread tag')
  t.is(state.unread?.size, 256, 'remembered rows are capped')
  t.alike(readTags({ avisos: avisoReadRows([newer], [newer.seen], state, 1001) }), [], 'the evicted row still prevents closing its tag')
  const later = avisoReadRows([newer, other, ...rows.slice(1)], [newer.seen, 'b'.repeat(32)], state, 1002)
  t.absent(readTags({ avisos: later }).includes('varanda-like-' + B + ':1'), 'reading the retained rows cannot prove the dropped row read')
  t.ok(readTags({ avisos: avisoReadRows([other], [other.seen], state, 1003) }).includes('varanda-like-' + B + ':300'), 'unrelated read tags remain available')
  avisoReadRows(rows, [], state, 1004)
  avisoReadRows(rows.map((row) => ({ ...row, seq: row.seq + 1000, post: B + ':' + (row.seq + 1000) })), [], state, 1005)
  t.ok(state.unread?.size <= 256)
  t.ok(state.blocked?.size <= 256, 'forgotten tags are also bounded')
  t.alike(readTags({ avisos: avisoReadRows([newer, other], [newer.seen], state, 1006) }), [], 'exhausted evidence fails closed')
})
