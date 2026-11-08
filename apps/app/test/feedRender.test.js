'use strict'

// Feed rows render only when their own data changed: stable profile views
// (src/namesCache.js stableView) and the per-row props cache (cachedRow)
// that A Rua feeds the memoized PostRow with.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/namesCache.js')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

const AV = {
  core: 'cd'.repeat(32),
  mime: 'image/jpeg',
  start: 1,
  blocks: 1,
  bytes: 1000,
  sha256: 'ab'.repeat(32),
  width: 512,
  height: 512
}

test('stableView keeps the object while the entry says the same thing', async (t) => {
  const { stableView } = await load()
  const entry = { name: 'Ana', username: 'ana', bio: null, avatar: AV, loaded: true }
  const first = stableView(entry, undefined)
  t.alike(first, { name: 'Ana', username: 'ana', bio: null, avatar: AV })
  t.is(stableView(entry, first), first, 'same entry')
  t.is(stableView({ ...entry, loaded: false }, first), first, 'a refetch mark changes nothing shown')
  t.is(stableView({ ...entry, avatar: { ...AV } }, first), first, 'an equal avatar copy')
  t.not(stableView({ ...entry, name: 'Ana B' }, first), first, 'name')
  t.not(stableView({ ...entry, username: 'anab' }, first), first, 'username')
  t.not(stableView({ ...entry, bio: 'oi' }, first), first, 'bio')
  t.not(stableView({ ...entry, avatar: null }, first), first, 'avatar removed')
  t.not(stableView({ ...entry, avatar: undefined }, { ...first, avatar: null }), first, 'unknown differs from none')
  const page = stableView({ ...entry, page: true, closed: false }, first)
  t.not(page, first, 'a page view')
  t.alike(page, { name: 'Ana', username: 'ana', bio: null, avatar: AV, page: true, closed: false, moved: false })
  t.is(stableView({ ...entry, page: true }, page), page)
  t.not(stableView({ ...entry, page: true, closed: true }, page), page, 'closed')
  t.not(stableView({ ...entry, page: true, moved: true }, page), page, 'moved')
})

test('cachedRow returns the same props while the inputs are unchanged', async (t) => {
  const { cachedRow } = await load()
  const cache = new Map()
  const post = { author: 'a'.repeat(64), seq: 1, text: 'oi' }
  const prof = { name: 'Ana', username: 'ana', bio: null, avatar: null }
  const quote = { author: 'b'.repeat(64), seq: 2, text: 'citado' }
  const base = { post, prof, quoteOriginal: undefined, pending: null, liked: false, reposted: false, likes: 1, replies: 0, now: 1 }
  let builds = 0
  const row = (inputs, latest = {}) => cachedRow(cache, 'k', inputs, latest, (live) => {
    builds++
    return { ...inputs, onLike: () => live.like() }
  })
  const first = row({ ...base })
  t.is(row({ ...base }), first, 'unchanged')
  t.is(builds, 1)
  const changes = {
    'quote content arrived': { quoteOriginal: quote },
    pending: { pending: 'like' },
    liked: { liked: true },
    reposted: { reposted: true },
    counts: { likes: 2 },
    'profile view': { prof: { ...prof, name: 'Ana B' } },
    now: { now: 2 }
  }
  for (const [what, patch] of Object.entries(changes)) {
    const before = row({ ...base })
    const after = row({ ...base, ...patch })
    t.not(after, before, what + ' gives new props')
    t.is(row({ ...base, ...patch }), after, what + ' then stays')
  }
  t.not(row({ ...base, extra: 1 }), row({ ...base }), 'a different key set is a change')
})

test('cachedRow callbacks read the newest handlers without a rebuild', async (t) => {
  const { cachedRow } = await load()
  const cache = new Map()
  const calls = []
  const build = (live) => ({ onOpen: () => live.h.open() })
  const props = cachedRow(cache, 'k', { a: 1 }, { h: { open: () => calls.push('old') } }, build)
  t.is(cachedRow(cache, 'k', { a: 1 }, { h: { open: () => calls.push('new') } }, build), props)
  props.onOpen()
  t.alike(calls, ['new'])
})

test('pruneRows drops rows that left the list', async (t) => {
  const { cachedRow, pruneRows } = await load()
  const cache = new Map()
  for (const k of ['a', 'b', 'c']) cachedRow(cache, k, { k }, {}, () => ({ k }))
  pruneRows(cache, ['b'])
  t.alike([...cache.keys()], ['b'])
})

test('A Rua keys the row cache on what each row shows', (t) => {
  const src = read('screens/ARua.js')
  const start = src.indexOf('const inputs = {')
  const body = src.slice(start, src.indexOf('return cachedRow(', start))
  for (const field of ['post,', 'prof,', 'quoteOriginal: q', 'quoteProfile', 'quoteTransient', 'replyToName', 'likes:', 'replies:', 'reposts:', 'quotes:', 'liked:', 'reposted:', 'pending:', 'now,', "'offers.'"]) {
    t.ok(body.includes(field), field)
  }
  t.ok(/cache: rowCache, rowKey: feedKey\(item\)/.test(src), 'A Rua passes its row cache')
  t.ok(src.includes('const renderItem = useCallback((info) => renderRef.current(info), [])'), 'renderItem is stable')
  t.absent(src.includes('await countsDone'), 'the next page does not wait for counts')
  t.ok(src.includes('(countedRef.current.get(ref) || 0) > started'), 'an older counts answer never replaces a newer one')
})

test('PostRow is memoized with the default comparison and reads text once', (t) => {
  const src = read('ui/PostRow.js')
  t.ok(src.includes('export const PostRow = memo(BlockGate)'), 'default shallow compare')
  t.is(src.split('displayText(text').length - 1, 1, 'displayText of the text once')
  t.absent(/useEffect\([^)]*isReduceMotionEnabled/.test(src), 'no per-mount reduce motion query')
  const list = read('ui/RefreshableList.js')
  t.ok(list.includes('initialNumToRender={FIRST_ROWS}') && list.includes('const FIRST_ROWS = 8'))
  t.ok(list.includes('maxToRenderPerBatch={ROWS_PER_BATCH}') && list.includes('const ROWS_PER_BATCH = 8'))
  t.ok(list.includes('windowSize={WINDOW_SCREENS}') && list.includes('const WINDOW_SCREENS = 7'))
  t.absent(list.includes('removeClippedSubviews'))
})

test('an older counts pass answering late never brings back its flags', async (t) => {
  const { countsFlags } = await load()
  let flags = { indexing: false, complete: true }
  let applied = 0
  // Pass 2 (newer) answers first, not indexing; pass 1 (older) then says indexing.
  let r = countsFlags({ prev: flags, applied, pass: 2, indexing: false, complete: true })
  flags = r.flags
  applied = r.applied
  r = countsFlags({ prev: flags, applied, pass: 1, indexing: true, complete: true })
  t.is(r.flags, flags, 'the newer flags stay')
  t.is(r.applied, 2)
  t.alike(r.flags, { indexing: false, complete: true })
  // The older page's counts failing still marks the shown counts incomplete:
  // the newer page holds other posts.
  const late = countsFlags({ prev: flags, applied, pass: 1, indexing: true, complete: false })
  t.alike(late.flags, { indexing: false, complete: false }, 'an older incomplete answer still counts, its indexing does not')
  t.is(late.applied, 2)
  const same = countsFlags({ prev: flags, applied, pass: 2, indexing: true, complete: true })
  t.alike(same.flags, { indexing: true, complete: true }, 'answers of one pass still combine')
  const next = countsFlags({ prev: same.flags, applied: same.applied, pass: 3, indexing: false, complete: false })
  t.alike(next.flags, { indexing: false, complete: false }, 'a newer pass sets them')
  const src = read('screens/ARua.js')
  t.is(src.split('countsFlags({').length - 1, 2, 'both counts answers (failed and ok) go through it')
})
