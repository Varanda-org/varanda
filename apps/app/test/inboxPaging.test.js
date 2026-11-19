'use strict'

const test = require('brittle')

const load = () => import('../src/inboxPaging.js')
const row = (peer) => ({ peer, at: '2026-11-05T12:00:00.000Z' })

test('mergeFirstPage keeps the loaded rows under the fresh first page', async (t) => {
  const { mergeFirstPage } = await load()
  const loaded = [row('b'), row('c'), row('d'), row('e')]
  const fresh = { peer: 'c', at: '2026-11-06T12:00:00.000Z' }
  const merged = mergeFirstPage(loaded, [row('a'), fresh])
  t.alike(merged.map((r) => r.peer), ['a', 'c', 'b', 'd', 'e'])
  t.is(merged[1], fresh, 'the fresh row wins over the loaded one')
  t.alike(mergeFirstPage([], [row('a')]).map((r) => r.peer), ['a'])
  t.alike(mergeFirstPage(loaded, []).map((r) => r.peer), ['b', 'c', 'd', 'e'], 'an empty first page empties nothing')
  t.alike(mergeFirstPage(loaded, null).map((r) => r.peer), ['b', 'c', 'd', 'e'])
})

test('refreshDepth never shrinks below what is loaded or wanted, and is capped', async (t) => {
  const { refreshDepth, REFRESH_PAGES_MAX } = await load()
  t.is(refreshDepth(1, 0), 1)
  t.is(refreshDepth(3, 0), 3)
  t.is(refreshDepth(1, 4), 4, 'an overlapping refresh keeps its depth')
  t.is(refreshDepth(3, 2), 3)
  t.is(refreshDepth(undefined, undefined), 1)
  t.is(refreshDepth(REFRESH_PAGES_MAX + 5, 1), REFRESH_PAGES_MAX)
})

function fakeInbox (pages) {
  const calls = []
  const read = async (cursor) => {
    calls.push(cursor)
    const i = Number(cursor)
    return { conversations: pages[i], next: i + 1 < pages.length ? String(i + 1) : null }
  }
  return { read, calls }
}

test('readDepth re-reads back to the loaded depth and swaps once', async (t) => {
  const { readDepth } = await load()
  const pages = [[row('a'), row('b')], [row('c'), row('d')], [row('e')], [row('f')]]
  const { read, calls } = fakeInbox(pages)
  const first = { conversations: [row('a'), row('x')], next: '1' }
  const out = await readDepth({ first, depth: 3, read, current: () => true })
  t.alike(out.rows.map((r) => r.peer), ['a', 'x', 'c', 'd', 'e'])
  t.is(out.depth, 3)
  t.is(out.next, '3')
  t.alike(calls, ['1', '2'], 'two more pages, no more')
})

test('readDepth stops when the cursor ends and returns the shorter depth', async (t) => {
  const { readDepth } = await load()
  const { read } = fakeInbox([[row('a')], [row('b')]])
  const out = await readDepth({ first: { conversations: [row('a')], next: '1' }, depth: 5, read, current: () => true })
  t.is(out.depth, 2)
  t.is(out.next, null)
  const one = await readDepth({ first: { conversations: [row('a')], next: null }, depth: 5, read, current: () => true })
  t.is(one.depth, 1)
})

test('readDepth drops the walk of a refresh that was overtaken, and a failed page swaps nothing', async (t) => {
  const { readDepth } = await load()
  const { read, calls } = fakeInbox([[row('a')], [row('b')], [row('c')], [row('d')]])
  let live = true
  const out = await readDepth({
    first: { conversations: [row('a')], next: '1' },
    depth: 4,
    read: async (cursor) => { const res = await read(cursor); live = false; return res },
    current: () => live
  })
  t.is(out, null)
  t.alike(calls, ['1'], 'no page is read after the token moved on')
  await t.exception(readDepth({
    first: { conversations: [row('a')], next: '1' },
    depth: 3,
    read: async () => { throw new Error('rede') },
    current: () => true
  }), /rede/)
})

test('searchPaging stops on empty text, no next page, a failure or the budget', async (t) => {
  const { searchPaging, SEARCH_PAGES_MAX } = await load()
  t.ok(searchPaging({ needle: 'ana', next: 'c', pages: 0 }))
  t.absent(searchPaging({ needle: '', next: 'c', pages: 0 }), 'text cleared')
  t.absent(searchPaging({ needle: 'ana', next: null, pages: 0 }), 'all pages loaded')
  t.absent(searchPaging({ needle: 'ana', next: 'c', pages: 0, failed: true }), 'a failed page waits for the retry')
  t.ok(searchPaging({ needle: 'ana', next: 'c', pages: SEARCH_PAGES_MAX - 1 }))
  t.absent(searchPaging({ needle: 'ana', next: 'c', pages: SEARCH_PAGES_MAX }), 'bounded')
  t.absent(searchPaging({ needle: 'ana', next: 'c' }), 'a missing count never loops')
})

test('unreadPaging looks for an unread row within the search page budget', async (t) => {
  const { unreadPaging, SEARCH_PAGES_MAX } = await load()
  const pending = { filter: 'nao-lidas', unreadRows: 0, inboxUnread: true, next: 'c', pages: 0 }
  t.is(unreadPaging(pending), true)
  t.is(unreadPaging({ ...pending, filter: 'todas' }), false)
  t.is(unreadPaging({ ...pending, unreadRows: 1 }), false)
  const { unreadRows, ...withoutUnreadRows } = pending
  t.is(unreadPaging(withoutUnreadRows), false, 'a missing unread count never loops')
  t.is(unreadPaging({ ...pending, inboxUnread: false }), false)
  t.is(unreadPaging({ ...pending, inboxUnread: undefined }), false)
  t.is(unreadPaging({ ...pending, next: null }), false)
  t.is(unreadPaging({ ...pending, failed: true }), false, 'a failed page waits for the retry')
  t.is(unreadPaging({ ...pending, pages: SEARCH_PAGES_MAX }), false)
  const { pages, ...withoutPages } = pending
  t.is(unreadPaging(withoutPages), false, 'a missing page count never loops')
  t.is(unreadPaging({ ...pending, pages: SEARCH_PAGES_MAX - 1 }), true)
})

test('the inbox refreshes back to the loaded depth and its search pages through the rest', (t) => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const screen = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(screen.includes('const depth = refreshDepth(depthRef.current, wantRef.current)'), 'a refresh reads the depth on screen or the deeper one already wanted')
  t.ok(screen.includes('mergeFirstPage(s.rows, rows)') && screen.includes('readDepth({'), 'the first page merges at once, the deep read swaps once')
  t.ok(screen.includes('current: () => mine === gen.current'), 'an overtaken refresh drops its walk')
  t.ok(screen.includes('searchPaging({ needle, next: nextRef.current, pages: spent.current, failed })'), 'the search walk stops by the pure rules')
  t.ok(screen.includes('await wait(SEARCH_PAGE_GAP_MS)'), 'no tight loop')
  t.ok(screen.includes("needle: active ? query.trim().toLocaleLowerCase('pt-BR') : ''"), 'leaving the screen ends it')
  t.ok(screen.includes('} else if (needle !== \'\' && inbox.paging) {'), 'a searching list shows the skeleton, never "nenhuma conversa"')
})

test('settleRefresh keeps the rows loaded past a capped re-read', async (t) => {
  const { settleRefresh, REFRESH_PAGES_MAX } = await load()
  const deep = { rows: [row('a'), row('b')], next: 'c10', depth: REFRESH_PAGES_MAX }
  const loaded = { rows: [row('b'), row('x'), row('y')], next: 'c15' }
  const kept = settleRefresh(loaded, deep, 15)
  t.alike(kept.rows.map((r) => r.peer), ['a', 'b', 'x', 'y'], 'fresh rows first, the deeper loaded rows after them')
  t.is(kept.next, 'c15', 'the cursor of the deepest loaded page')
  t.is(kept.depth, 15)
  const ended = settleRefresh(loaded, { ...deep, next: null }, 15)
  t.alike(ended.rows.map((r) => r.peer), ['a', 'b'], 'a re-read that reached the end is the whole inbox')
  t.is(ended.next, null)
  const shallow = settleRefresh(loaded, { ...deep, depth: 3 }, 3)
  t.alike(shallow, { rows: deep.rows, next: 'c10', depth: 3 }, 'a re-read as deep as the list swaps it')
})

test('the inbox keeps deep pages on refresh and asks before searching past the budget', (t) => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const screen = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(screen.includes('const out = settleRefresh(s, deep, loadedDepth)'), 'the swap keeps the rows past the cap')
  t.ok(screen.includes('} else if (needle !== \'\' && inbox.searchSpent) {'), 'a spent budget says older conversations remain')
  t.ok(screen.includes("<Pill label='Buscar mais' onPress={() => inbox.searchMore()} />"), 'and lets the person go on')
  t.ok(screen.includes('}, [ready, needle, hasNext, pageKey, loadMore, walkRound])'), 'going on starts a new walk')
})
