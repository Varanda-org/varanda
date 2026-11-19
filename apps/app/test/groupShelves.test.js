'use strict'

const test = require('brittle')

const load = () => import('../src/groupShelves.js')
const key = (n) => n.toString(16).padStart(64, '0')
const DAY_MS = 86400000

function row (n, fields = {}) {
  return {
    group: key(n),
    name: 'Grupo\u202e',
    creator: key(100),
    community: key(101),
    communityName: 'Comunidade\u202e',
    writerCount: 7,
    ...fields
  }
}

test('shelf order, pt-BR copy and limits', async (t) => {
  const shelves = await load()
  const { SHELF_IDS, SHELF_TITLES, ORDER_TEXT, PARTIAL_TEXT, followReason, activeText } = shelves
  t.alike(SHELF_IDS, ['followed', 'trending', 'members', 'recent'])
  t.alike(SHELF_TITLES, {
    followed: 'Grupos de quem você segue',
    trending: 'Em alta',
    members: 'Mais membros',
    recent: 'Criados recentemente'
  })
  t.alike(Object.keys(ORDER_TEXT).sort(), [...SHELF_IDS].sort())
  t.is(PARTIAL_TEXT, 'A lista ainda está sendo atualizada; alguns grupos podem faltar.')
  const strings = [...SHELF_IDS, ...Object.values(SHELF_TITLES), ...Object.values(ORDER_TEXT), PARTIAL_TEXT,
    followReason(1, true), followReason(2, true), followReason(1, false), followReason(2, false), activeText(2)]
  for (const text of strings) {
    t.is(typeof text, 'string')
    t.ok(text.length > 0)
    t.absent(text.includes('\u2014'))
  }
  t.is(shelves.FOLLOW_SAMPLE_MAX, 24)
  t.is(shelves.FANOUT_GAP_MS, 750)
  t.is(shelves.FANOUT_MAX_FAILURES, 3)
  t.is(shelves.FOLLOW_CACHE_MS, 600000)
  t.is(shelves.TREND_MIN_ACTIVE, 2)
  t.is(shelves.SHELF_ROWS_MAX, 20)
  t.is(shelves.GROUP_LIST_LIMIT, 26)
  t.is(shelves.GROUP_LIST_PAGES, 3)
})

test('followSample sorts and deduplicates any iterable and keeps the whole short list', async (t) => {
  const { followSample } = await load()
  const keys = [key(2), key(1), key(2)]
  t.alike(followSample(keys.values(), DAY_MS * 19), [key(1), key(2)])
  t.alike(followSample(new Set(keys), DAY_MS, 2), [key(1), key(2)])
  t.alike(followSample([], 0), [])
  t.alike(followSample(keys, 0, 0), [])
  t.alike(keys, [key(2), key(1), key(2)])
})

test('followSample returns nothing for a clock that is not finite', async (t) => {
  const { followSample } = await load()
  const keys = [key(1), key(2), key(3)]
  for (const now of [NaN, Infinity, -Infinity, undefined]) t.alike(followSample(keys, now, 2), [], String(now))
  t.alike(followSample(keys, NaN, 3), [key(1), key(2), key(3)], 'a short list needs no clock')
})

test('followSample rotates at the day boundary, wraps and covers all keys', async (t) => {
  const { followSample, FOLLOW_SAMPLE_MAX } = await load()
  const keys = Array.from({ length: 53 }, (_, i) => key(i))
  const unsorted = [keys[7], ...keys].reverse()
  const days = Math.ceil(keys.length / FOLLOW_SAMPLE_MAX)
  const seen = new Set()
  for (const day of Array.from({ length: days }, (_, i) => i)) {
    const start = day * FOLLOW_SAMPLE_MAX
    const expected = keys.concat(keys).slice(start, start + FOLLOW_SAMPLE_MAX)
    const sample = followSample(unsorted, day * DAY_MS)
    t.alike(sample, expected)
    t.alike(followSample(keys, (day + 1) * DAY_MS - 1), sample, 'stable throughout the day')
    for (const k of sample) seen.add(k)
  }
  t.alike([...seen].sort(), keys)
  t.alike(followSample(keys, DAY_MS, 2), keys.slice(2, 4))
})

test('joinedOf combines pages and keeps every role except left', async (t) => {
  const { joinedOf } = await load()
  const roles = ['creator', 'admin', 'member', 'requested', 'banned', 'pending', 'left']
  const rows = roles.map((role, i) => ({ group: key(i), role }))
  const pages = [{ groups: rows.slice(0, 4), total: 7 }, { groups: [...rows.slice(4), rows[0]], total: 7 }]
  t.alike([...joinedOf(pages)], rows.slice(0, -1).map(({ group }) => group))
  for (const malformed of [null, {}, [null], [{ groups: 'bad', total: 1 }], [{ groups: [], total: '0' }],
    [...pages, { groups: [null], total: 1 }], [{ groups: [{ group: key(1) }], total: 1 }]]) {
    t.alike([...joinedOf(malformed)], [])
  }
  t.alike([...joinedOf([])], [])
  t.alike([...joinedOf([{ groups: [], total: 0 }])], [])
})

test('visibleRows drops blocked groups, communities and creators, preserving order and data', async (t) => {
  const { visibleRows } = await load()
  const rows = [row(5), row(1), row(2, { community: key(60) }), row(3, { creator: key(61) }), row(4)]
  t.alike(visibleRows(rows, new Set([key(1), key(60), key(61)])), [rows[0], rows[4]])
  t.alike(visibleRows(rows, new Set()), rows)
  t.alike(visibleRows([], new Set([key(1)])), [])
})

test('trendingRows keeps the threshold and higher counts in their original order', async (t) => {
  const { trendingRows } = await load()
  const rows = [0, 1, 2, null, 8].map((active, i) => row(i, { active }))
  t.alike(trendingRows(rows), [rows[2], rows[4]])
  t.alike(trendingRows([]), [])
})

test('tallyFollowed counts distinct diaries across repeated pages and breaks ties by key', async (t) => {
  const { tallyFollowed } = await load()
  const largest = row(3)
  const opts = { joined: new Set(), blocked: new Set(), own: key(93) }
  const result = tallyFollowed([
    { diary: key(90), groups: [row(2), { ...largest, extra: true }, largest] },
    { diary: key(90), groups: [largest, row(1)] },
    { diary: key(91), groups: [largest] },
    { diary: key(92), groups: [] }
  ], opts)
  t.alike(result, [{ ...largest, count: 2 }, { ...row(1), count: 1 }, { ...row(2), count: 1 }])
  t.alike(tallyFollowed([], opts), [])
})

test('tallyFollowed excludes joined groups and rows or diaries listed as blocked', async (t) => {
  const { tallyFollowed } = await load()
  const kept = row(2)
  const opts = { joined: new Set([key(1)]), blocked: new Set([key(3), key(60), key(61), key(91)]), own: key(92) }
  const result = tallyFollowed([
    { diary: key(90), groups: [row(1), kept, row(3), row(4, { community: key(60) }), row(5, { creator: key(61) })] },
    { diary: key(91), groups: [kept, row(6)] },
    { diary: key(92), groups: [kept, row(7)] }
  ], opts)
  t.alike(result, [{ ...kept, count: 1 }])
})

test('tallyFollowed caps the ranked shelf after sorting', async (t) => {
  const { tallyFollowed, SHELF_ROWS_MAX } = await load()
  const rows = Array.from({ length: SHELF_ROWS_MAX + 2 }, (_, i) => row(i))
  const last = rows[rows.length - 1]
  const result = tallyFollowed([
    { diary: key(90), groups: rows.slice().reverse() },
    { diary: key(91), groups: [last] }
  ], { joined: new Set(), blocked: new Set(), own: key(92) })
  t.alike(result, [{ ...last, count: 2 }, ...rows.slice(0, SHELF_ROWS_MAX - 1).map((r) => ({ ...r, count: 1 }))])
})

test('followReason handles singular, plural and a partial sample', async (t) => {
  const { followReason, activeText } = await load()
  t.is(followReason(1, true), '1 pessoa que você segue está aqui')
  t.is(followReason(2, true), '2 pessoas que você segue estão aqui')
  t.is(followReason(1, false), 'Pelo menos 1 pessoa que você segue está aqui')
  t.is(followReason(24, false), 'Pelo menos 24 pessoas que você segue estão aqui')
  t.is(activeText(2), '2 pessoas escreveram nos últimos 7 dias')
  t.is(activeText(99), '99 pessoas escreveram nos últimos 7 dias')
})

test('olderSeeder requires exactly three not-found failures', async (t) => {
  const { olderSeeder } = await load()
  const missing = { ok: false, reason: 'not-found' }
  t.is(olderSeeder([missing, missing, missing]), true)
  for (const results of [null, [], [missing, missing], [missing, missing, missing, missing],
    [missing, missing, { ok: false, reason: 'network' }], [missing, missing, { ok: true, value: { groups: [] } }],
    [missing, missing, { reason: 'not-found' }], [missing, missing, undefined]]) {
    t.is(olderSeeder(results), false)
  }
})
