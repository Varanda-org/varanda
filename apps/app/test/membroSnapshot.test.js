'use strict'

// Membro paints a followed author's 'membro' snapshot (src/screenSnapshot.js)
// while profile.read and the member index answer, and writes it after a live
// first page. Membro.js loads react-native, so the wiring is checked on its
// text; its module-level rule runs here on its own source.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const MEMBRO = fs.readFileSync(path.join(APP, 'src/screens/Membro.js'), 'utf8')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The text from `start` through the brace that closes the one at `open`.
function blockFrom (src, start, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error('unbalanced at ' + start)
}

// A top-level `function <name> (...) { ... }`.
function fnText (src, name) {
  let start = src.indexOf('\nexport function ' + name + ' (')
  if (start >= 0) start += '\nexport '.length
  else start = src.indexOf('\nfunction ' + name + ' (') + 1
  if (start < 1) throw new Error('no function ' + name)
  return blockFrom(src, start, src.indexOf(') {', start) + 2)
}

// A `const <name> = useCallback(...)` body inside the component.
function callbackText (src, name) {
  const start = src.indexOf('const ' + name + ' = useCallback(')
  if (start < 0) throw new Error('no callback ' + name)
  const arrow = src.indexOf('=>', start)
  return blockFrom(src, arrow, src.indexOf('{', arrow))
}

const CODE = withoutComments(MEMBRO)
const allowed = new Function(fnText(CODE, 'membroSnapshotAllowed') + '\nreturn membroSnapshotAllowed')() // eslint-disable-line no-new-func
const seed = callbackText(CODE, 'seedSnapshot')
const save = callbackText(CODE, 'armSnapshotSave')
const drop = callbackText(CODE, 'dropSnapshotEntry')
const load = callbackText(CODE, 'load')

const ME = { kind: 'me' }
const base = { author: FOLLOW, ownKey: OWN, follows: new Set([FOLLOW]), blocked: false, page: false, acting: ME }

test('membro snapshot: only a followed person, as the member', (t) => {
  t.ok(allowed(base), 'followed author')
  t.absent(allowed({ ...base, author: STRANGER }), 'a stranger never')
  t.absent(allowed({ ...base, follows: null }), 'follow state not known yet')
  t.absent(allowed({ ...base, follows: [FOLLOW] }), 'only the node answer (a Set), never a guess')
  t.absent(allowed({ ...base, blocked: true }), 'a blocked author never')
  t.absent(allowed({ ...base, page: true }), 'a page never')
  t.absent(allowed({ ...base, acting: { kind: 'page', key: OWN } }), 'acting as a page never')
  t.absent(allowed({ ...base, acting: null }), 'unknown actor never')
  t.absent(allowed({ ...base, author: OWN, follows: new Set([OWN]) }), 'the own diary is not a membro entry')
})

test('membro snapshot: the seed waits for follow.list and runs before the live reads', (t) => {
  const rule = seed.indexOf('membroSnapshotAllowed(')
  t.ok(rule > 0 && /follows: followSet/.test(seed.slice(rule, seed.indexOf(')', rule))), 'seed checks the follow.list answer')
  t.ok(rule < seed.indexOf("loadScreenSnapshot('membro'"), 'the rule runs before the store is read')
  t.ok(/blocked: at\.blocked/.test(seed) && /page: at\.page/.test(seed), 'blocked and page are checked')
  t.ok(/acting = actingAs\.get\(\)/.test(seed), 'the current actor is checked')
  t.ok(seed.indexOf("postsRef.current.phase !== 'loading'") > 0, 'live rows are never overwritten')
  t.ok(seed.indexOf('!headerRef.current.verified') > 0, 'a live header is never overwritten')
  t.ok(/seeded: true/.test(seed), 'seeded rows are marked')
  t.ok(seed.indexOf("perfMarks().mark('rows-snapshot:membro')") > 0, 'rows-snapshot mark')

  const call = load.indexOf('seedSnapshot(set, alive)')
  t.ok(call > 0, 'load seeds from the follow.list promise')
  t.ok(/if \(!refreshing\) followsRef\.current\.then\(\(set\) => seedSnapshot\(set, alive\)\)/.test(load), 'never on a refresh')
  t.ok(/if \(!blockedHere\) \{\s*followsRef\.current = loadFollows\(\)/.test(load), 'a blocked author is not seeded (no follow read in that load)')
  t.ok(call < load.indexOf('await readProfile()'), 'seed armed before profile.read')
  t.ok(call < load.indexOf('await readPage('), 'seed armed before the member index')
  t.is(load.split('loadFollows()').length, 2, 'follow.list is read once per load, as before')
})

test('membro snapshot: the seed waits for the first block.list answer (#463, #539)', (t) => {
  const step = new Function(fnText(CODE, 'membroSeedStep') + '\nreturn membroSeedStep')() // eslint-disable-line no-new-func
  t.is(step('pending'), 'wait', 'held until the node answers')
  t.is(step('ok'), 'go')
  t.is(step('failed'), 'skip', 'a failed list shows no stored row')
  t.is(step(undefined), 'skip')
  t.ok(/const step = membroSeedStep\(at\.blockLoad\)\s*if \(step === 'wait'\) \{\s*seedWaitRef\.current = \{ followSet, alive \}\s*return\s*\}\s*seedWaitRef\.current = null\s*if \(step !== 'go'\) return/.test(seed), 'held while pending, none unless ok')
  t.ok(seed.indexOf('membroSeedStep(') < seed.indexOf('membroSnapshotAllowed('), 'before any rule reads the block list')
  t.ok(/blockLoad: blocks\.loadState/.test(CODE), 'the rules see the load state')
  t.ok(/if \(membroSeedStep\(blocks\.loadState\) === 'wait'\) return\s*const wait = seedWaitRef\.current\s*seedWaitRef\.current = null\s*if \(wait !== null\) seedSnapshot\(wait\.followSet, wait\.alive\)/.test(CODE), 'the held seed runs once it answers')
})

test('membro snapshot: stored header and rows go on another installation or association', (t) => {
  t.ok(/seedBindingRef\.current = binding\s*if \(!headerRef\.current\.verified\) commitHeader\(\{ \.\.\.entry\.header, verified: false \}\)/.test(seed), 'the seed remembers its binding with the header')
  t.ok(/const firstHeaderRef = useRef\(header\)/.test(CODE))
  t.ok(/const seededWith = seedBindingRef\.current\s*if \(seededWith === null \|\| sameSnapshotBinding\(seededWith, liveBinding\(ownKey, node\.config\)\)\) return\s*seedBindingRef\.current = null\s*if \(!headerRef\.current\.verified\) commitHeader\(firstHeaderRef\.current\)\s*if \(postsRef\.current\.seeded\) commit\(\{ \.\.\.INITIAL_POSTS \}\)/.test(CODE))
})

test('membro snapshot: saved only after a live page, still followed, generation guarded', (t) => {
  const live = load.indexOf("perfMarks().mark('rows-live:membro')")
  const arm = load.indexOf('armSnapshotSave(')
  t.ok(live > 0 && arm > live, 'armed after the live first page')
  t.ok(/if \(index\.page !== true && gen === cacheGeneration\(\)\) armSnapshotSave\(/.test(load), 'never for a page index, and not after a wipe')
  t.ok(load.indexOf('seeded: false') > 0, 'the live page clears the seeded flag')
  const genAt = load.indexOf('const gen = cacheGeneration()')
  const readAt = load.indexOf('const page = await readPage(')
  t.ok(genAt > 0 && readAt > genAt, 'generation read in the turn that starts the index request')
  t.absent(/cacheGeneration\(\)/.test(save), 'arm uses the generation load read')
  t.ok(/saveScreenSnapshot\('membro', snapshot, gen\)/.test(save), 'the store gets the armed generation')
  const written = save.indexOf("saveScreenSnapshot('membro', snapshot, gen)")
  const afterWrite = save.slice(written + "saveScreenSnapshot('membro', snapshot, gen)".length)
  t.absent(/setTimeout|saveScreenSnapshot/.test(afterWrite), 'a refused save is not retried')
  const armArgs = load.slice(arm)
  t.ok(/armSnapshotSave\(\{ items,/.test(armArgs), 'built from the live page')
  t.absent(/r\.items/.test(armArgs), 'cached rows are not written')
  const rule = save.indexOf('membroSnapshotAllowed(')
  t.ok(rule > 0 && /follows: at\.follows/.test(save.slice(rule, save.indexOf(')', rule))), 'followed again when it fires')
  t.ok(rule < save.indexOf('buildScreenSnapshot('), 'the rule runs before the build')
  t.ok(/!headerRef\.current\.verified\) return/.test(save), 'only a live header')
  t.ok(/sessionAllowsSnapshot\(at\.passkey, ownKey\)/.test(save), 'an unlocked session of the owner')
  t.ok(/followed: at\.follows/.test(save) && /blocked: at\.blockedKeys/.test(save), 'the rules filter by follows and blocks')
})

test('membro snapshot: unfollow and block remove the entry at once', (t) => {
  t.ok(/mark\(author, on\)\s*if \(!on\) dropSnapshotEntry\(\)/.test(CODE), 'an unfollow here drops the entry')
  t.ok(/if \(blockedHere\) dropSnapshotEntry\(\)/.test(CODE), 'a block drops the entry')
  t.ok(/clearTimeout\(saveTimerRef\.current\)/.test(drop), 'a pending save is cancelled')
  t.ok(/screenWithoutAuthors\(snapshot, \[author\]\)/.test(drop), 'the author and their reposts go')
  t.ok(/acting\.kind !== 'me'\) \{\s*clearScreenSnapshot\('membro'\)/.test(drop), 'acting as a page: everything goes')
  t.ok(/Object\.keys\(next\.body\.authors\)\.length === 0 \|\| !saveScreenSnapshot\('membro', next, cacheGeneration\(\)\)\) clearScreenSnapshot\('membro'\)/.test(drop), 'an empty or failed rewrite clears')
  const toggle = CODE.slice(CODE.indexOf('const togglePageFollow = async'), CODE.indexOf('const isFollowed ='))
  t.absent(/Snapshot|snapshot/.test(toggle), 'a page follow never touches the member snapshot')
})

test('membro snapshot: page rows and seeded paging', (t) => {
  const snap = CODE.slice(CODE.indexOf('snapRef.current = {'), CODE.indexOf('useEffect(', CODE.indexOf('snapRef.current = {')))
  t.ok(/page: isPage \|\| /.test(snap), 'a page by any sign')
  t.ok(/seed\.page === true/.test(snap) && /idxHint !== null/.test(snap) && /pageRead !== null/.test(snap) && /namedPage\.page === true/.test(snap), 'seed, index, page.read and learned names count')
  t.ok(/current\.seeded \|\| current\.loadingMore/.test(CODE), 'seeded rows are never paged')
  t.ok(/if \(current\.seeded \|\| current\.atEnd/.test(CODE), 'the Mural fill waits for the live page')
  t.ok(/!seeded && !mural && !depo && !atEnd/.test(CODE), 'no load more under seeded rows')
  t.ok(/const postsReady = posts\.phase === 'ready' && !posts\.seeded/.test(CODE), 'common communities wait for the live page')
})

test('Membro: post rows are stable across renders', (t) => {
  const src = withoutComments(MEMBRO)
  t.absent(/renderItem=\{\(/.test(src) || src.includes('renderItem={depo ?'), 'no renderItem picked or built inline')
  t.ok(src.includes('const renderItem = useCallback((info) => renderRef.current(info), [])') && src.includes('renderItem={renderItem}'), 'one renderItem through a ref')
  t.ok(src.includes('renderRef.current = depo ? testimonialTab.renderItem : mural ? renderMural : renderPost'), 'the ref follows the tab')
  t.ok(src.includes('const extra = useMemo(() => ({ eng, follows, now, header, muralCols, own, isFollowed, profileOf: names.profileOf }), [eng, follows, now, header, muralCols, own, isFollowed, names.profileOf])') && src.includes('extraData={depo ? testimonialTab.extraData : extra}'), 'extraData is memoized')
  t.ok(src.includes('const rowCache = useThreadRowCache(posts.items.map(postKey), { handlers, eng })'), 'the list owns a row props cache')
  t.ok(src.includes('cache: rowCache, rowKey: postKey(item)'), 'post rows take cached props')
  t.ok(src.includes('const memberWho = useMemo('), 'a repost keeps one reposter object')
  t.ok(src.includes('item: withHeader(post)'), 'own posts keep one header copy')
  const hooks = src.indexOf('const rowCache = useThreadRowCache(')
  t.ok(hooks !== -1 && hooks < src.indexOf('\n  if (!full) {'), 'the list hooks run before the offline return')
})

const POSTS_MAX = 100
const keyOf = (row) => String(row.seq)
const compare = (a, b) => a.seq - b.seq
const row = (seq, text = 'a') => ({ seq, text })

// The same flags the screen passes: a short page while indexing is not the
// whole profile, and unreadable posts prove no absence.
function settleFirst (settleSeeded, { seeded, live, posts, indexing = false, indexComplete = true, unavailable = 0 }) {
  const whole = indexComplete !== false && indexing !== true
  return settleSeeded({
    seeded,
    live,
    last: whole && posts.length < POSTS_MAX,
    complete: whole && unavailable === 0,
    tail: 'keep',
    spanEnd: posts.length > 0 ? { seq: posts[posts.length - 1] } : null,
    keyOf,
    compare
  })
}

test('membro snapshot: the live page keeps seeded rows and counts newer ones', (t) => {
  t.ok(/unverified: \[\]/.test(CODE) && /newer: 0/.test(CODE), 'the post state carries both')
  t.ok(/const whole = index\.complete !== false && index\.indexing !== true/.test(load))
  t.ok(/last: whole && index\.posts\.length < POSTS_MAX/.test(load))
  t.ok(/complete: whole && unavailable === 0/.test(load))
  t.ok(/tail: 'keep'/.test(load))
  t.ok(/spanEnd: index\.posts\.length > 0 \? \{ seq: index\.posts\[index\.posts\.length - 1\] \} : null/.test(load))
  t.ok(/keyOf: \(i\) => String\(i\.seq\)/.test(load))
  t.ok(/compare: \(a, b\) => a\.seq - b\.seq/.test(load))
  t.ok(/settleSeeded\(/.test(load))
  t.ok(/if \(postsRef\.current\.seeded\)/.test(load))
  t.ok(/if \(!r\.replace\)/.test(load))
  t.ok(/nextItems = r\.items/.test(load))
  t.ok(/nextUnverified = r\.unverified/.test(load))
  t.ok(/nextNewer = r\.held\.length/.test(load))
  t.ok(/if \(r\.unverified\.length > 0 && index\.posts\.length > 0\) nextAtEnd = false/.test(load), 'unverified rows allow paging only when the index supplied a cursor')
  t.ok(/unverified: nextUnverified/.test(load))
  t.ok(/newer: nextNewer/.test(load))
  t.ok(/livePageRef\.current = \{/.test(load), 'the full live page is kept for the pill')
})

test('membro snapshot: loadMore unions by seq and settles that page span', (t) => {
  const more = callbackText(CODE, 'loadMore')
  t.ok(/for \(const row of items\) bySeq\.set\(row\.seq, row\)/.test(more), 'the page row wins')
  t.ok(/\.sort\(\(a, b\) => b\.seq - a\.seq\)/.test(more))
  t.ok(/settleSpan\(/.test(more))
  t.ok(/const whole = index\.complete !== false && index\.indexing !== true/.test(more))
  t.ok(/complete: whole && unavailable === 0/.test(more))
  t.ok(/from: \{ seq: current\.before \}/.test(more))
  t.ok(/to: index\.posts\.length > 0 \? \{ seq: index\.posts\[index\.posts\.length - 1\] \} : null/.test(more))
  t.ok(/end: whole && index\.posts\.length < POSTS_MAX/.test(more))
  t.ok(/keyOf: \(i\) => String\(i\.seq\)/.test(more))
  t.ok(/compare: \(a, b\) => a\.seq - b\.seq/.test(more))
  t.ok(/items: settled\.items/.test(more))
  t.ok(/unverified: settled\.unverified/.test(more))
  t.ok(/const unverified = postsRef\.current\.unverified/.test(more) && /items: merged,\s*unverified,/.test(more))
})

test('membro snapshot: unverified rows wait for the block list, and the pill shows the live page', (t) => {
  t.ok(/cachedRowsShown\(/.test(CODE))
  t.ok(/owner: ownKey/.test(CODE))
  t.ok(/if \(typeof author === 'string'\) authors\.push\(author\)/.test(CODE), 'the profile author')
  t.ok(/item\.kind === 'repost' && item\.to && typeof item\.to\.author === 'string'/.test(CODE))
  t.ok(/item\.quote && typeof item\.quote\.author === 'string'/.test(CODE))
  t.ok(/item\.replyTo && typeof item\.replyTo\.author === 'string'/.test(CODE))
  t.ok(/\[posts\.items, posts\.unverified, blocks\.loadState, blocks\.keys, author, ownKey\]/.test(CODE))
  t.ok(/newItems=\{\{ label: 'ver novidades', visible: !depo && posts\.newer > 0, onPress: showNewerPosts \}\}/.test(CODE))
  t.ok(/commit\(\{ phase: 'ready', error: '', items: live\.items, before: live\.before, atEnd: live\.atEnd, unavailable: live\.unavailable, newer: 0, unverified: \[\]/.test(CODE))
  t.ok(/scrollToOffset\(\{ offset: 0, animated: true \}\)/.test(CODE))
  t.absent(/visible: posts\.newer > 0/.test(CODE), 'no pill on Depoimentos, where it would change nothing visible')
})

test('membro snapshot: paging confirms cached rows and a pill tap discards the pending page', async (t) => {
  const { settleSpan } = await import('../src/paging.js')
  const first = { items: [row(12), row(11), row(10)], before: 10, atEnd: false, unavailable: 0 }
  const postsRef = { current: { ...first, phase: 'ready', items: [row(10), row(8, 'cached')], unverified: ['8'], newer: 2 } }
  const cursors = []
  const engagement = []
  let answer
  const context = {
    POSTS_MAX: 3,
    settleSpan,
    postsRef,
    genRef: { current: 1 },
    moreGenRef: { current: 0 },
    muralPages: { current: 0 },
    livePageRef: { current: first },
    seedOriginalsRef: { current: null },
    listRef: { current: null },
    readPage: (before) => {
      cursors.push(before)
      return new Promise((resolve) => { answer = resolve })
    },
    commit: (patch) => { postsRef.current = { ...postsRef.current, ...patch } },
    afterPage: (items) => engagement.push(items)
  }
  const start = CODE.indexOf('const showNewerPosts = ')
  const pill = blockFrom(CODE, start, CODE.indexOf('{', start))
  const handlers = 'const loadMore = async () ' + callbackText(CODE, 'loadMore') + '\n' + pill + '\nreturn { loadMore, showNewerPosts }'
  const { loadMore, showNewerPosts } = new Function(...Object.keys(context), handlers)(...Object.values(context)) // eslint-disable-line no-new-func
  const second = { items: [row(9), row(8, 'live'), row(7)], unavailable: 0, index: { posts: [9, 8, 7] } }
  const loadingSecond = loadMore()
  answer(second)
  await loadingSecond
  t.alike(engagement, [second.items], 'engagement reads cover fresh rows and the live copy of the confirmed row')
  const loadingThird = loadMore()
  showNewerPosts()
  t.is(postsRef.current.loadingMore, false, 'the restored first page is ready to page again')
  answer({ items: [row(6)], unavailable: 0, index: { posts: [6] } })
  await loadingThird
  t.alike(postsRef.current.items, first.items, 'the stale third page cannot append to the first')
  t.is(postsRef.current.before, first.before, 'the next read starts at the second page')
  t.alike(cursors, [10, 7])
})

// loadMore and the pill, run on their own text over a fake screen. Each
// readPage call waits for `answer(page)`.
async function screenHarness (posts, { first, POSTS_MAX = 3 } = {}) {
  const { settleSpan } = await import('../src/paging.js')
  const postsRef = { current: { phase: 'ready', loadingMore: false, refreshing: false, seeded: false, moreError: '', atEnd: false, indexing: false, complete: true, ...posts } }
  const cursors = []
  const engagement = []
  const pending = []
  const context = {
    POSTS_MAX,
    settleSpan,
    postsRef,
    genRef: { current: 1 },
    moreGenRef: { current: 0 },
    muralPages: { current: 4 },
    livePageRef: { current: first || null },
    seedOriginalsRef: { current: null },
    listRef: { current: null },
    readPage: (before) => {
      cursors.push(before)
      return new Promise((resolve) => pending.push(resolve))
    },
    commit: (patch) => { postsRef.current = { ...postsRef.current, ...patch } },
    afterPage: (items) => engagement.push(items)
  }
  const start = CODE.indexOf('const showNewerPosts = ')
  const pill = blockFrom(CODE, start, CODE.indexOf('{', start))
  const body = 'const loadMore = async () ' + callbackText(CODE, 'loadMore') + '\n' + pill + '\nreturn { loadMore, showNewerPosts }'
  const handlers = new Function(...Object.keys(context), body)(...Object.values(context)) // eslint-disable-line no-new-func
  const more = async (page) => {
    const run = handlers.loadMore()
    if (pending.length > 0) pending.shift()(page)
    await run
  }
  return { ...handlers, more, postsRef, cursors, engagement, context }
}

test('membro snapshot: a page that drops every cached row shows the held live page', async (t) => {
  const first = { items: [row(12), row(11), row(10)], before: 10, atEnd: false, unavailable: 0 }
  const s = await screenHarness({ items: [row(8, 'cached')], unverified: ['8'], before: 10, newer: 3, unavailable: 0 }, { first })
  await s.more({ items: [], unavailable: 0, index: { posts: [9, 7], indexing: false, complete: true } })
  t.alike(s.postsRef.current.items, first.items, 'not an empty profile over the pill')
  t.is(s.postsRef.current.newer, 0)
  t.alike(s.postsRef.current.unverified, [])
  t.is(s.postsRef.current.before, 10, 'paging goes on from the live page')
  t.is(s.postsRef.current.atEnd, false)
  t.is(s.postsRef.current.loadingMore, false)
})

test('membro snapshot: while the pill holds the live page, older pages keep its newer rows off the list', async (t) => {
  const first = { items: [row(12), row(11), row(10)], before: 10, atEnd: false, unavailable: 0 }
  const s = await screenHarness({ items: [row(5, 'cached'), row(4, 'cached'), row(3, 'cached')], unverified: ['5', '4', '3'], before: 10, newer: 3, unavailable: 0 }, { first })
  await s.more({ items: [row(9), row(8), row(7)], unavailable: 0, index: { posts: [9, 8, 7], indexing: false, complete: true } })
  t.alike(s.postsRef.current.items.map((r) => r.seq), [5, 4, 3], 'nothing jumps in above the cached rows')
  t.is(s.postsRef.current.newer, 6, 'the pill counts the held rows')
  t.alike(s.context.livePageRef.current.items.map((r) => r.seq), [12, 11, 10, 9, 8, 7])
  t.is(s.context.livePageRef.current.before, 7, 'the held page goes on below the rows it took')
  t.is(s.postsRef.current.before, 7)
  t.alike(s.engagement, [[row(9), row(8), row(7)]], 'held rows read engagement before the pill shows them')

  await s.more({ items: [row(6), row(5, 'live'), row(4, 'live')], unavailable: 0, index: { posts: [6, 5, 4], indexing: false, complete: true } })
  t.alike(s.postsRef.current.items.map((r) => r.seq), [5, 4, 3], 'a split page sends only the newer rows to the pill')
  t.is(s.postsRef.current.items[0].text, 'live')
  t.alike(s.postsRef.current.unverified, ['3'])
  t.is(s.postsRef.current.newer, 7)
  t.alike(s.context.livePageRef.current.items.map((r) => r.seq), [12, 11, 10, 9, 8, 7, 6])
  t.is(s.context.livePageRef.current.before, 6, 'the pill pages again from its last held row')

  s.showNewerPosts()
  t.alike(s.postsRef.current.items.map((r) => r.seq), [12, 11, 10, 9, 8, 7, 6])
  t.is(s.postsRef.current.before, 6)
  t.is(s.postsRef.current.newer, 0)
})

test('membro snapshot: a short page ends the list only when the index is whole, and an empty one always does', async (t) => {
  const s = await screenHarness({ items: [row(10), row(4, 'cached')], unverified: ['4'], before: 10, newer: 0, unavailable: 0 })
  await s.more({ items: [row(9)], unavailable: 0, index: { posts: [9], indexing: true, complete: true } })
  t.is(s.postsRef.current.atEnd, false, 'a short page while indexing is not the end')
  t.alike(s.postsRef.current.unverified, ['4'])
  t.is(s.postsRef.current.before, 9)
  await s.more({ items: [], unavailable: 0, index: { posts: [], indexing: true, complete: true } })
  t.is(s.postsRef.current.atEnd, true, 'an empty page cannot move the cursor, so it ends paging')
  t.is(s.postsRef.current.before, 9)
  await s.more(null)
  t.alike(s.cursors, [10, 9], 'no read after the empty page')

  const partial = await screenHarness({ items: [row(10)], unverified: [], before: 10, newer: 0, unavailable: 0 })
  await partial.more({ items: [row(9)], unavailable: 0, index: { posts: [9], indexing: false, complete: false } })
  t.is(partial.postsRef.current.atEnd, false, 'an incomplete index is not the end')
  await partial.more({ items: [row(8)], unavailable: 0, index: { posts: [8], indexing: false, complete: true } })
  t.is(partial.postsRef.current.atEnd, true, 'a short page of a whole index is')

  const leftover = await screenHarness({ items: [row(10), row(4, 'cached')], unverified: ['4'], before: 10, newer: 0, unavailable: 0 })
  await leftover.more({ items: [row(9)], unavailable: 1, index: { posts: [9, 8], indexing: false, complete: true } })
  t.is(leftover.postsRef.current.atEnd, false, 'a cached row the page could not prove gone gets one more read')
  await leftover.more({ items: [], unavailable: 0, index: { posts: [], indexing: false, complete: true } })
  t.is(leftover.postsRef.current.atEnd, true)
  t.alike(leftover.postsRef.current.unverified, [], 'the whole empty page below settles it')
})

test('membro snapshot: the pill resets the Mural budget and leaves the error state', async (t) => {
  const first = { items: [row(12), row(11)], before: 11, atEnd: true, unavailable: 0 }
  const s = await screenHarness({ phase: 'error', error: 'x', items: [row(9, 'cached')], unverified: ['9'], before: 9, newer: 2, unavailable: 0 }, { first })
  s.showNewerPosts()
  t.is(s.postsRef.current.phase, 'ready')
  t.is(s.postsRef.current.error, '')
  t.alike(s.postsRef.current.items, first.items)
  t.is(s.context.muralPages.current, 0, 'the first page starts the Mural fill over')
  const fail = CODE.slice(load.indexOf('} catch (err) {'))
  t.ok(/commit\(\{ phase: 'error', refreshing: false, seeded: false, newer: 0,/.test(fail), 'a failed load hides the pill')
})

test('membro snapshot: a refresh settles the cached rows the first page left unverified', async (t) => {
  const { settleSpan } = await import('../src/paging.js')
  const settle = new Function('POSTS_MAX', fnText(CODE, 'settleRefresh') + '\nreturn settleRefresh')(5) // eslint-disable-line no-new-func
  t.ok(/\} else if \(postsRef\.current\.unverified\.length > 0\) \{\s*const r = settleRefresh\(\{ current: postsRef\.current\.items, unverified: postsRef\.current\.unverified, items, index, unavailable, settleSpan \}\)\s*nextItems = r\.items\s*nextUnverified = r\.unverified\s*if \(r\.unverified\.length > 0 && index\.posts\.length > 0\) nextAtEnd = false\s*keepOriginals = nextUnverified\.length > 0/.test(load), 'load settles instead of replacing while rows are unverified')
  const current = [row(12, 'old'), row(9, 'cached'), row(5, 'confirmed'), row(2, 'tail')]
  const items = [row(12, 'live'), row(11), row(10), row(8)]
  const index = { posts: [12, 11, 10, 9, 8], indexing: false, complete: true }
  const clean = settle({ current, unverified: ['12', '9', '2'], items, index, unavailable: 0, settleSpan })
  t.alike(clean.items.map((i) => [i.seq, i.text]), [[12, 'live'], [11, 'a'], [10, 'a'], [8, 'a'], [2, 'tail']], 'the span drops 9, the tail waits for a later page')
  t.alike(clean.unverified, ['2'])
  const dirty = settle({ current, unverified: ['9', '2'], items, index, unavailable: 1, settleSpan })
  t.alike(dirty.unverified, ['9', '2'], 'unreadable posts prove no absence')
  t.ok(dirty.items.some((i) => i.seq === 9))
  const building = settle({ current, unverified: ['9'], items, index: { ...index, indexing: true }, unavailable: 0, settleSpan })
  t.alike(building.unverified, ['9'], 'nor does a read while indexing')
  const empty = settle({ current, unverified: ['9', '2'], items: [], index: { posts: [], indexing: false, complete: true }, unavailable: 0, settleSpan })
  t.alike(empty.items, [], 'a whole empty profile drops them all')
  const unknown = settle({ current, unverified: ['9'], items: [], index: { posts: [], indexing: true, complete: true }, unavailable: 0, settleSpan })
  t.alike(unknown.unverified, ['9'], 'an empty page while indexing keeps them')
})

test('membro snapshot: no overlap keeps the cached page and holds the live one', async (t) => {
  const { settleSeeded } = await import('../src/paging.js')
  const seeded = [row(5), row(4), row(3)]
  const live = [row(10), row(9), row(8)]
  const result = settleFirst(settleSeeded, { seeded, live, posts: [10, 9, 8], indexComplete: false })
  t.is(result.replace, false)
  t.is(result.disjoint, true)
  t.alike(result.items.map((item) => item.seq), [5, 4, 3])
  t.alike(result.held.map((item) => item.seq), [10, 9, 8])
  t.alike(result.unverified, ['5', '4', '3'])
})

test('membro snapshot: partial overlap refreshes matches, drops the read span and keeps the tail', async (t) => {
  const { settleSeeded } = await import('../src/paging.js')
  const posts = []
  for (let seq = 220; seq >= 121; seq--) posts.push(seq)
  t.is(posts.length, POSTS_MAX, 'a full page is not the end of the profile')
  // 150 is in the index span and absent from the verified page, so a complete
  // read drops it. Every live row newer than the newest kept row is held.
  const live = posts.filter((seq) => seq !== 150).map((seq) => row(seq, seq === 200 ? 'new' : 'live'))
  const seeded = [row(200, 'old'), row(150, 'gone'), row(40, 'tail')]
  const result = settleFirst(settleSeeded, { seeded, live, posts, indexing: false, indexComplete: true, unavailable: 0 })
  t.is(result.replace, false)
  t.is(result.items.find((item) => item.seq === 200).text, 'new')
  t.ok(result.items.some((item) => item.seq === 199), 'a live row at or below the cached top stays')
  t.absent(result.items.find((item) => item.seq === 150))
  t.absent(result.items.find((item) => item.seq === 220), 'newer than the cached page stays on the pill')
  t.is(result.items.find((item) => item.seq === 40).text, 'tail')
  const held = []
  for (let seq = 220; seq >= 201; seq--) held.push(seq)
  t.alike(result.held.map((item) => item.seq), held)
  t.alike(result.unverified, ['40'])
  t.ok(result.dropped.includes('150'))
})

test('membro snapshot: a short page while indexing is not the whole profile', async (t) => {
  const { settleSeeded } = await import('../src/paging.js')
  const seeded = [row(10, 'old'), row(4, 'cached')]
  const live = [row(10, 'new')]
  const posts = [10, 9, 8]
  const indexing = settleFirst(settleSeeded, { seeded, live, posts, indexing: true, indexComplete: true, unavailable: 0 })
  t.is(indexing.items.find((item) => item.seq === 10).text, 'new')
  t.is(indexing.items.find((item) => item.seq === 4).text, 'cached')
  t.alike(indexing.unverified, ['4'])
  t.is(indexing.replace, false)
  const done = settleFirst(settleSeeded, { seeded, live, posts, indexing: false, indexComplete: true, unavailable: 0 })
  t.absent(done.items.find((item) => item.seq === 4))
  t.ok(done.dropped.includes('4'))
})

test('membro snapshot: unreadable posts prove no absence', async (t) => {
  const { settleSeeded } = await import('../src/paging.js')
  const seeded = [row(10), row(9)]
  const live = [row(10)]
  const posts = [10, 9, 8]
  const dirty = settleFirst(settleSeeded, { seeded, live, posts, indexing: false, indexComplete: true, unavailable: 1 })
  t.is(dirty.replace, false)
  t.ok(dirty.unverified.includes('9'))
  t.ok(dirty.items.some((item) => item.seq === 9))
  const clean = settleFirst(settleSeeded, { seeded, live, posts, indexing: false, indexComplete: true, unavailable: 0 })
  t.ok(clean.dropped.includes('9'))
  t.absent(clean.items.find((item) => item.seq === 9))
  const empty = settleFirst(settleSeeded, { seeded: [row(5), row(4)], live: [], posts: [], indexing: false, indexComplete: true, unavailable: 0 })
  t.is(empty.replace, true)
  t.alike(empty.items, [])
  t.alike(empty.unverified, [])
})

test('membro snapshot: an older page settles only the span it read', async (t) => {
  const { settleSpan } = await import('../src/paging.js')
  const current = [row(150, 'cached'), row(120, 'old'), row(40, 'tail')]
  const page = [row(120, 'live')]
  const bySeq = new Map(current.map((item) => [item.seq, item]))
  for (const item of page) bySeq.set(item.seq, item)
  const merged = [...bySeq.values()].sort((a, b) => b.seq - a.seq)
  t.alike(merged.map((item) => [item.seq, item.text]), [[150, 'cached'], [120, 'live'], [40, 'tail']])
  const posts = []
  for (let seq = 200; seq >= 101; seq--) posts.push(seq)
  t.is(posts.length, POSTS_MAX)
  const whole = true
  const settled = settleSpan({
    items: merged,
    unverified: ['150', '40'],
    page,
    complete: whole,
    from: { seq: 201 },
    to: { seq: posts[posts.length - 1] },
    end: whole && posts.length < POSTS_MAX,
    keyOf,
    compare
  })
  t.alike(settled.items.map((item) => item.seq), [120, 40])
  t.alike(settled.unverified, ['40'])
  t.ok(settled.dropped.includes('150'))
})
