'use strict'

// The Avisos list view helpers (src/noticesView.js): filters, day headers and
// who gets the Seguir de volta pill. Pure ES module, loaded with import().
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const load = () => import('../src/noticesView.js')
const NOW = new Date(2026, 9, 23, 12).getTime()
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const at = (y, m, d, h = 9) => new Date(y, m, d, h).toISOString()
const row = (key, seq, kind, when) => Object.freeze(kind === undefined
  ? { key, seq, at: when, name: 'Ana', username: 'ana' }
  : { key, seq, kind, at: when, name: 'Ana', username: 'ana' })

test('noticesView is pure and has no em dash', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/noticesView.js'), 'utf8')
  const imports = source.split('\n').filter((line) => line.startsWith('import '))
  t.alike(imports, ["import { noticeKind } from './notices.js'", "import { dayHeading } from './format.js'"])
  t.absent(/from '(react|node:)|require\(/.test(source))
  t.absent(source.includes('\u2014'))
})

test('the filter chips and texts are the approved Portuguese', async (t) => {
  const { NOTICE_FILTERS, FOLLOW_BACK_LABEL, FILTER_EMPTY_TITLE, FILTER_EMPTY_TEXT } = await load()
  t.alike(NOTICE_FILTERS.map((f) => [f.id, f.label]), [['todas', 'Todas'], ['mencoes', 'Menções'], ['seguidores', 'Seguidores']])
  t.is(FOLLOW_BACK_LABEL, 'Seguir de volta')
  t.is(FILTER_EMPTY_TITLE, 'Nada neste filtro')
  t.is(FILTER_EMPTY_TEXT, 'Os avisos deste tipo aparecem aqui. Toque em Todas para ver os outros.')
})

test('filterNotices keeps the same rows in order for each filter', async (t) => {
  const { filterNotices } = await load()
  const when = at(2026, 9, 23)
  const follow = row(A, 1, 'follow', when)
  const legacy = row(B, 2, undefined, when)
  const odd = row(C, 3, 'something-new', when)
  const reply = row(A, 4, 'reply', when)
  const quote = row(B, 5, 'quote', when)
  const mention = row(C, 6, 'mention', when)
  const like = row(A, 7, 'like', when)
  const repost = row(B, 8, 'repost', when)
  const all = [follow, legacy, reply, like, quote, odd, mention, repost]
  const todas = filterNotices(all, 'todas')
  t.alike(todas, all)
  t.not(todas, all, 'a new array, the input is not handed back')
  t.ok(todas.every((r, i) => r === all[i]), 'the same objects')
  t.alike(filterNotices(all, 'mencoes'), [reply, quote, mention])
  t.ok(filterNotices(all, 'mencoes').every((r) => all.includes(r)))
  t.alike(filterNotices(all, 'seguidores'), [follow, legacy, odd], 'a row with no or an unknown kind reads as a follow (notices.js noticeKind)')
  t.absent(filterNotices(all, 'mencoes').includes(like), 'likes stay under Todas only')
  t.absent(filterNotices(all, 'seguidores').includes(repost))
  t.alike(filterNotices(all, 'nope'), all, 'an unknown id is Todas')
  t.alike(filterNotices(null, 'todas'), [])
  t.is(all.length, 8, 'the input is not mutated')
})

test('withDayHeaders inserts one header per local day and never touches the rows', async (t) => {
  const { withDayHeaders, isDayHeader } = await load()
  const r1 = row(A, 3, 'follow', at(2026, 9, 23, 11))
  const r2 = row(B, 2, 'like', at(2026, 9, 23, 8))
  const r3 = row(A, 2, 'reply', at(2026, 9, 22, 23))
  const r4 = row(C, 9, 'like', 'not a date')
  const r5 = row(C, 1, 'like', at(2026, 9, 3))
  const r6 = row(B, 1, 'like', at(2025, 9, 3))
  const rows = withDayHeaders([r1, r2, r3, r4, r5, r6], NOW)
  t.alike(rows.map((r) => (isDayHeader(r) ? 'H ' + r.title : r.key.slice(0, 1) + r.seq)), [
    'H Hoje', 'a3', 'b2', 'H Ontem', 'a2', 'c9', 'H 3 out', 'c1', 'H 3 out 2025', 'b1'
  ])
  const notices = rows.filter((r) => !isDayHeader(r))
  t.ok([r1, r2, r3, r4, r5, r6].every((r, i) => notices[i] === r), 'the same objects, in order, none merged')
  t.alike(rows.filter(isDayHeader).map((r) => r.key), ['d:2026-10-23', 'd:2026-10-22', 'd:2026-10-3', 'd:2025-10-3'])
  t.alike(withDayHeaders([r1, r2, r3], NOW).filter(isDayHeader).map((r) => r.key), ['d:2026-10-23', 'd:2026-10-22'], 'stable keys across calls')
  t.alike(withDayHeaders([], NOW), [])
  t.absent(isDayHeader(r1))
})

test('withDayHeaders never repeats a header key, even for rows out of order', async (t) => {
  const { withDayHeaders, isDayHeader } = await load()
  const today = row(A, 2, 'like', at(2026, 9, 23, 11))
  const older = row(B, 1, 'like', at(2026, 9, 20))
  const todayAgain = row(C, 1, 'like', at(2026, 9, 23, 7))
  const rows = withDayHeaders([today, older, todayAgain], NOW)
  const keys = rows.filter(isDayHeader).map((r) => r.key)
  t.is(new Set(keys).size, keys.length)
  t.is(rows.filter((r) => !isDayHeader(r)).length, 3)
})

test('a loaded row that says dayHeader is still a notice, never a header', async (t) => {
  const { withDayHeaders, isDayHeader } = await load()
  const forged = Object.freeze({ key: A, seq: 1, kind: 'follow', at: at(2026, 9, 23), dayHeader: true, title: 'forged' })
  t.absent(isDayHeader(forged), 'a field never makes a header')
  t.absent(isDayHeader({ dayHeader: true, key: 'd:2026-10-23', title: 'Hoje' }), 'not even one shaped like a header')
  const rows = withDayHeaders([forged], NOW)
  t.is(rows.length, 2)
  t.ok(isDayHeader(rows[0]))
  t.is(rows[0].title, 'Hoje')
  t.is(rows[1], forged)
  t.absent(isDayHeader(rows[1]))
  t.absent(isDayHeader(null))
  t.absent(isDayHeader('d:2026-10-23'))
})

test('showsFollowBack: only a follow notice, only as the person, only for someone not followed', async (t) => {
  const { showsFollowBack } = await load()
  const when = at(2026, 9, 23)
  const follow = row(A, 1, 'follow', when)
  const none = new Set()
  t.ok(showsFollowBack(follow, { pageActing: false, follows: none, ownKey: C }))
  t.absent(showsFollowBack(follow, { pageActing: true, follows: none, ownKey: C }), 'never while a page is acting')
  t.absent(showsFollowBack(follow, { pageActing: undefined, follows: none, ownKey: C }), 'an unknown acting state is not the person')
  t.absent(showsFollowBack(follow, { pageActing: false, follows: new Set([A]), ownKey: C }), 'never for someone already followed')
  t.absent(showsFollowBack(row(A.toUpperCase(), 1, 'follow', when), { pageActing: false, follows: new Set([A]), ownKey: C }), 'the set is compared in lowercase')
  t.absent(showsFollowBack(follow, { pageActing: false, follows: null, ownKey: C }), 'not before the follow set is read')
  t.absent(showsFollowBack(follow, { pageActing: false, follows: none, ownKey: A }), 'never the own key')
  t.ok(showsFollowBack(row(B, 1, undefined, when), { pageActing: false, follows: none, ownKey: C }), 'a legacy follow row')
  t.absent(showsFollowBack(row(B, 1, 'something-new', when), { pageActing: false, follows: none, ownKey: C }), 'an unknown kind lists under Seguidores but gets no pill')
  t.absent(showsFollowBack(row(B, 1, null, when), { pageActing: false, follows: none, ownKey: C }))
  for (const kind of ['reply', 'quote', 'mention', 'like', 'repost']) {
    t.absent(showsFollowBack(row(B, 1, kind, when), { pageActing: false, follows: none, ownKey: C }), kind)
  }
  t.absent(showsFollowBack(row('not-a-key', 1, 'follow', when), { pageActing: false, follows: none, ownKey: C }), 'only a 64-hex key')
  t.absent(showsFollowBack(null, { pageActing: false, follows: none, ownKey: C }))
})
