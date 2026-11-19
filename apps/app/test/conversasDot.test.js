'use strict'

const test = require('brittle')
const load = () => import('../src/conversasDot.js')

const PAGE = 'ab'.repeat(32)

test('groupsUnread counts only group unread and stays unknown until the read is complete', async (t) => {
  const { groupsUnread } = await load()
  t.is(groupsUnread(null), null)
  t.is(groupsUnread(undefined), null)
  t.is(groupsUnread({}), null)
  t.is(groupsUnread('rows'), null)

  const unread = [{ kind: 'group', unread: 2 }]
  t.is(groupsUnread(unread, { complete: false }), true)
  t.is(groupsUnread(unread), true)

  const quiet = [
    null,
    undefined,
    0,
    'x',
    { kind: 'group', unread: 0 },
    { kind: 'group', unread: 1.5 },
    { kind: 'group' },
    { kind: 'dm', unread: true },
    { kind: 'requests', unread: true },
    { kind: 'communities', unread: 4 },
    { kind: 'old-key', unread: true }
  ]
  t.is(groupsUnread(quiet, { complete: true }), false)
  t.is(groupsUnread(quiet, { complete: false }), null)
  t.is(groupsUnread(quiet), null)
  t.is(groupsUnread([null, { kind: 'group', unread: 2 }, 1], { complete: false }), true)
})

test('conversasDot lights from strict dm flags or group unread, except groups while acting as a Página', async (t) => {
  const { conversasDot } = await load()
  t.is(conversasDot({ dm: { inboxUnread: true }, groups: false, actingPage: false }), true)
  t.is(conversasDot({ dm: { requests: true }, groups: false, actingPage: false }), true)
  t.is(conversasDot({ dm: {}, groups: true, actingPage: false }), true)
  t.is(conversasDot({ dm: {}, groups: false, actingPage: false }), false)
  t.is(conversasDot({ dm: null, groups: false }), false)
  t.is(conversasDot({ dm: null, groups: true, actingPage: true }), false)
  t.is(conversasDot({ dm: { requests: true }, groups: false, actingPage: true }), true)
  t.is(conversasDot({ dm: null, groups: null, actingPage: false }), false)
  t.is(conversasDot({ dm: undefined, groups: undefined }), false)
  t.is(conversasDot({ dm: { inboxUnread: 1, requests: 'true' }, groups: 1, actingPage: false }), false)
  t.is(conversasDot({ dm: { inboxUnread: 'true' }, groups: 'true' }), false)
})

test('settleGroups keeps the previous dot when the next read is unknown', async (t) => {
  const { settleGroups } = await load()
  t.is(settleGroups(true, null), true)
  t.is(settleGroups(false, undefined), false)
  t.is(settleGroups(true, false), false)
  t.is(settleGroups(false, true), true)
})

test('badgeListParams scopes a Página key and always returns a fresh object', async (t) => {
  const { badgeListParams } = await load()
  const member = { folder: 'inbox', limit: 1 }
  t.alike(badgeListParams(null), member)
  t.alike(badgeListParams(undefined), member)
  t.alike(badgeListParams(PAGE), { folder: 'inbox', limit: 1, page: PAGE })
  t.alike(badgeListParams('A'.repeat(64)), member)
  t.alike(badgeListParams('a'.repeat(63)), member)
  t.alike(badgeListParams('g'.repeat(64)), member)
  const first = badgeListParams(PAGE)
  const second = badgeListParams(PAGE)
  t.is(first === second, false)
  first.limit = 9
  t.is(second.limit, 1)
  const a = badgeListParams(null)
  const b = badgeListParams(null)
  t.is(a === b, false)
})

test('showNaoLidasEmpty only when the visible list is empty and nothing unread is still outstanding', async (t) => {
  const { showNaoLidasEmpty } = await load()
  t.is(showNaoLidasEmpty({ rows: [], requests: false, more: false }), true)
  t.is(showNaoLidasEmpty({ rows: [], requests: true, more: false }), false)
  t.is(showNaoLidasEmpty({ rows: [], requests: false, more: true, inboxUnread: true }), false)
  t.is(showNaoLidasEmpty({ rows: [], requests: false, more: true, inboxUnread: false }), true)
  t.is(showNaoLidasEmpty({ rows: [], requests: false, more: true, inboxUnread: undefined }), false)
  t.is(showNaoLidasEmpty({ rows: [{ kind: 'dm', unread: true }], requests: false, more: false }), false)
  t.is(showNaoLidasEmpty({ rows: [], requests: false, more: false, inboxUnread: true }), true, 'every page loaded')
  t.is(showNaoLidasEmpty({ rows: undefined, requests: false, more: false }), false, 'no list yet')
})

test('strict booleans: truthy non-booleans never settle or light anything', async (t) => {
  const { settleGroups, groupsUnread } = await load()
  t.is(settleGroups(1, null), false)
  t.is(settleGroups(false, 1), false)
  t.is(groupsUnread([{ kind: 'group', unread: 0 }], null), null, 'null options read as a partial list')
})
