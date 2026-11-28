'use strict'

// Avisos.js is a screen. Read it as text so this test never loads JSX.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

test('Avisos polls on node.visible and a hosted refusal is not web-only', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  t.absent(source.includes('document.addEventListener'))
  t.absent(source.includes('document.visibilityState'))
  t.absent(/unsupported\s*\?\s*'web-only'/.test(source))
  t.ok(source.includes('node.visible'))
  t.absent(source.includes('AppState'))
  t.absent(source.includes('../visibility'))
  t.absent(source.includes('\u2014'))
})

test('Avisos rows show a snippet read through the node and an unread dot', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  t.ok(source.includes('snippetOf(item, postText)'))
  t.ok(source.includes("request('diary.peek'") === false)
  t.ok(source.includes('peekAll('))
  t.ok(source.includes('displayText(snippetOf('))
  t.ok(source.includes('unreadDot'))
  t.absent(source.includes('fetch('))
})

test('Avisos marks snippet refs tried only after their read completed', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const effect = source.slice(source.indexOf('function useSnippets'), source.indexOf('function NoticeRow'))
  t.ok(effect.indexOf('if (!alive) return') < effect.indexOf('triedRef.current.add(r)'), 'tried only after the alive check')
  t.absent(/const list = wantedKey\.split\(','\)\n\s*for \(const r of list\) triedRef/.test(effect), 'not marked before the read')
  t.ok(effect.includes('setRound('), 'a finished batch advances to the next refs')
  t.ok(effect.includes('SNIPPET_BATCH'))
})

test('Avisos retries refs a failed snippet read did not reach, at most SNIPPET_TRIES times', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const effect = source.slice(source.indexOf('function useSnippets'), source.indexOf('function NoticeRow'))
  t.ok(/const SNIPPET_TRIES = 2\b/.test(source))
  t.ok(effect.includes('await peekAll(request, [params], peeked, () => alive)'), 'one chunk at a time')
  t.ok(effect.includes('failedAt = params'), 'a throw is charged to the chunk that threw')
  t.ok(effect.includes('if (post !== null || done.some((p) => chunkHas(p, r))) {'), 'found or completed refs count as tried')
  t.ok(effect.includes('} else if (failedAt !== null && chunkHas(failedAt, r)) {'), 'only the failed chunk spends a try')
  t.ok(/if \(tries >= SNIPPET_TRIES\) \{\n\s*triedRef\.current\.add\(r\)/.test(effect), 'exhausted refs count as tried')
  t.absent(/for \(const r of list\) triedRef\.current\.add\(r\)/.test(effect), 'the whole batch is never marked at once')
})

test('Avisos asks for snippets only of canonical post refs', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const fnSrc = source.slice(source.indexOf('function snippetRef'), source.indexOf('const SNIPPET_BATCH'))
  t.ok(fnSrc.includes('const ref = noticeRef(item)'), 'the same ref rule as opening the post')
  t.ok(fnSrc.includes('return isRef(ref) ? ref : null'), 'a page notice ref that is not <hex64>:<seq> is skipped')
  t.ok(source.includes("import { isRef } from '../nav'"))
})

test('Avisos keeps the verified @nome line and shows the snippet apart, in quotes', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  t.absent(/snippet \|\| subtitle/.test(source), 'post text never replaces the handle')
  t.ok(source.includes('{subtitle ? <Text style={styles.handle} numberOfLines={1}>{subtitle}</Text> : null}'))
  t.ok(source.includes("? <Text style={styles.snippet} numberOfLines={1}>{'“' + snippet + '”'}</Text>"), 'a cut snippet stays one plain line, in quotes')
  t.ok(source.includes('<Text style={styles.snippet}>“<MentionText text={snippetOf(item, postText)} />”</Text>'), 'a whole snippet shows its links, in quotes')
  t.ok(/snippet: \{ \.\.\.type\.postMeta, color: colors\.ink \}/.test(source), 'a style apart from the handle')
})

test('Avisos gives exhausted snippet refs another chance on reload, and speaks the whole row', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const hook = source.slice(source.indexOf('function useSnippets'), source.indexOf('function NoticeRow'))
  t.ok(hook.includes('exhaustedRef.current.add(r)'), 'refs that ran out of tries are remembered apart')
  t.ok(/triedRef\.current\.delete\(r\)\n\s*triesRef\.current\.delete\(r\)/.test(hook), 'a reload releases them')
  t.ok(hook.includes('}, [retryKey])'))
  t.ok(source.includes('useSnippets(shownItems, node.request, active && passkeyHosted && notice === null, loadedAt)'), 'the reload signal is loadedAt')
  t.ok(source.includes("const spoken = [line, subtitle, snippet ? '“' + snippet + '”' : null, unread ? 'não lido' : null].filter(Boolean).join(', ')"))
  t.ok(source.includes("accessibilityLabel={ref === null ? spoken : spoken + ', abrir publicação'}"))
  t.ok(source.includes("accessibilityLabel={spoken + ', ver perfil'}"))
})

test('Avisos resets the seen ids before folding remote marks, and a hidden poll reports rows without marking them', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const reset = source.indexOf('shownListRef.current = null')
  const fold = source.indexOf('// A seen pass brought the marks of another device')
  t.ok(reset > 0 && fold > 0)
  t.ok(reset < fold, 'the namespace reset effect runs before the remote fold effect')
  t.ok(source.includes('settle(page.notices, false, false)'))
  t.absent(source.includes('settle(page.notices, false)\n'))
  t.ok(source.includes('onSeenStateRef.current(seenNamespace, shown ? seenOnScreen(list, seen.ids) : [],'))
  // Every settle that only moves the dot stores the loaded rows another
  // device saw, not only the settle right after a pass.
  const settleAt = source.indexOf('const settle = useCallback(')
  const settleEnd = source.indexOf('}, [seenNamespace, badge])', settleAt)
  t.ok(source.slice(settleAt, settleEnd).includes('mergeRemoteSeen(seen.ids, remote, rows, randomBytes)'))
})

test('Avisos settles a read begun before the own key through the current namespace', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const settleAt = source.indexOf('const settle = useCallback(')
  const body = source.slice(settleAt, source.indexOf('}, [seenNamespace, badge])', settleAt))
  t.ok(body.includes('if (seenNamespaceRef.current !== seenNamespace) {'))
  t.ok(body.indexOf('seenNamespaceRef.current !== seenNamespace') < body.indexOf('lastListRef.current = { list, shown }'), 'the stale check runs before any ref is written')
  t.ok(source.includes('settleRef.current = settle'))
})

test('Avisos never gives the unread dot to a row read on another device', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const settleAt = source.indexOf('const settle = useCallback(')
  const body = source.slice(settleAt, source.indexOf('}, [seenNamespace, badge])', settleAt))
  t.ok(body.includes('const elsewhere = remote.filter((id) => !stored.has(id))'), 'echoes of this device\'s own marks are left out')
  t.ok(body.includes('!stored.has(item.seen) && !elsewhere.includes(item.seen)'), 'marks from elsewhere count as seen for the dot')
  t.ok(body.includes('new Set([...u].filter((id) => !elsewhere.includes(id)))'), 'only marks from elsewhere clear the dot')
  t.ok(body.indexOf('const stored = new Set(seen.ids)') < body.indexOf('markSeenPadded('), 'stored is read before this settle marks anything')
})

test('Avisos completes a missing row photo from the names cache or a hinted peek', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  for (const piece of ["from '../names'", 'fetchMembers', 'pickAvatar', 'avatarOf', 'needsAvatar', 'resolveRowAvatars', 'rowAvatarSource(item, avatars[item.key])', 'picture={picture}', 'avatar: picture || null', 'resolveMany(', 'const AVATAR_BATCH = 10', "persist={persistCopy ? 'copy' : false}"]) {
    t.ok(source.includes(piece), piece)
  }
  t.absent(source.includes('picture={item.avatar}'))
  t.absent(source.includes('avatar: item.avatar'))
  t.absent(/[^a-zA-Z]fetch\(/.test(source), 'no raw fetch call')
  t.absent(source.includes('\u2014'))
})

test('a row read as a Página keeps its photo out of the copy store', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const { compileFunction } = require('node:vm')
  const expr = (start, end) => {
    const a = source.indexOf(start)
    t.ok(a >= 0, start)
    if (a < 0) return 'undefined'
    return source.slice(a + start.length, source.indexOf(end, a + start.length))
  }
  const run = (code, env) => compileFunction('return (' + code + ')', Object.keys(env))(...Object.values(env))
  const pageRows = expr('const pageRows = ', '\n')
  const passed = expr('persistCopy={', '}\n')
  const persist = expr('persist={', '} />')
  const page = 'd'.repeat(64)
  const rowPersist = (pageKey, prevActing, actingKey) => {
    const rows = run(pageRows, { pageKey, actingKeyRef: { current: prevActing }, actingKey })
    return run(persist, { persistCopy: run(passed, { pageRows: rows }) })
  }
  t.is(rowPersist(page, page, page), false, 'acting as a Página')
  t.is(rowPersist(null, page, ''), false, 'the commit after leaving the Página')
  t.is(rowPersist(null, '', ''), 'copy', 'acting as the member')
})

test('Avisos marks avatar authors tried only after the batch completed and keeps the cache out of its lifetime', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const hook = source.slice(source.indexOf('function useRowAvatars'), source.indexOf('const SNIPPET_BATCH'))
  t.ok(hook.indexOf('if (!alive) return') < hook.indexOf('triedRef.current.add(k)'))
  t.ok(hook.includes('resolveRowAvatars(list, { fetchMembers, peekChunk, alive: () => alive })'))
  t.ok(hook.includes('peekAll(request, [chunk], new Map(), () => alive)'))
  t.ok(hook.includes('setRound('))
  // A batch in flight is frozen: a names-cache commit cannot change its key.
  t.ok(hook.includes('if (enabled && batchRef.current !== null) {\n    wantedKey = batchRef.current'))
  t.ok(hook.indexOf('if (!alive) return') < hook.indexOf('batchRef.current = null\n      const next'))
  // A new cycle restarts the batch in flight, so a reload never loses its retry.
  t.ok(hook.includes('}, [wantedKey, request, cycle])'))
  // A reload asks the index again for the authors already asked.
  const reset = hook.slice(hook.indexOf('useEffect(() => {'), hook.indexOf('}, [cycle])'))
  const drop = reset.indexOf('for (const k of triedRef.current) invalidateMember(k)')
  t.ok(drop >= 0 && drop < reset.indexOf('triedRef.current.clear()'))
  t.absent(/\}, \[[^\]]*(cachedOf|profileOf)[^\]]*\]\)/.test(hook))
})

test('Avisos asks the names cache only while the screen is active and hosted', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  t.ok(source.includes("if (active && passkeyHosted && shownKeys !== '') resolveMany(shownKeys.split(','))"))
  t.ok(source.includes('}, [active, passkeyHosted, shownKeys, resolveMany])'))
})

test('Avisos gives a snippet read that came back without the post another chance on reload', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Avisos.js'), 'utf8')
  const hook = source.slice(source.indexOf('function useSnippets'), source.indexOf('function NoticeRow'))
  t.ok(/if \(post === null\) blankRef\.current\.add\(r\)/.test(hook), 'a finished read without the post is remembered apart')
  t.ok(hook.includes('for (const r of [...exhaustedRef.current, ...blankRef.current])'), 'a reload releases blank refs with the exhausted ones')
  t.ok(hook.includes('blankRef.current.clear()'), 'and forgets them, so the next blank read is tracked again')
})

test('Avisos retries avatars once per full reload, not per partial page', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const callAt = source.indexOf('useRowAvatars(shownItems')
  const call = source.slice(callAt, source.indexOf('\n', callAt))
  t.ok(callAt > 0)
  t.absent(call.includes('loadedAt'))
  const from = source.indexOf('const loadFirst = useCallback')
  const to = source.indexOf('const loadMore', from)
  const slice = source.slice(from, to)
  t.ok(from > 0 && to > from)
  t.ok(slice.includes('setAvatarCycle('))
  t.is(source.split('setAvatarCycle(').length - 1, 1, 'only loadFirst bumps the cycle')
  const pollAt = source.indexOf('const poll = useCallback')
  t.absent(source.slice(pollAt, source.indexOf('\n  }, [', pollAt)).includes('setAvatarCycle'))
})

// Slices the real effect bodies out of the screen source and runs them in a hand-built
// context, so a new identifier in those effects breaks the test with a ReferenceError.
function screenCallback (screen, marker, context) {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/' + screen + '.js'), 'utf8')
  const at = source.indexOf(marker)
  if (at < 0) throw new Error('Screen callback not found: ' + marker)
  const start = source.indexOf('(', at) + 1
  const end = source.indexOf('\n  }, [', start) + '\n  }'.length
  return require('node:vm').runInNewContext('(' + source.slice(start, end) + ')', context)
}

test('Avisos hidden polls cannot close a tag while an older like remains unread', async (t) => {
  const notices = await import('../src/notices.js')
  const { avisoReadRows } = await import('../src/noticeReads.js')
  const { readTags } = await import('../src/noticeTags.js')
  const ownKey = 'b'.repeat(64)
  const newer = { kind: 'like', key: 'a'.repeat(64), seq: 2, post: ownKey + ':7', seen: 'a'.repeat(32) }
  const older = { ...newer, seq: 1, seen: 'b'.repeat(32) }
  const seenRef = { current: { ids: [newer.seen] } }
  const reports = []
  const closed = []
  const settle = screenCallback('Avisos', 'const settle = useCallback(', {
    ...notices,
    avisoReadRows,
    // A live list has loaded and every row is confirmed: the cached-paint
    // guards of settle (T16) pass through.
    stateRef: { current: { loadedAt: 1, unverified: [] } },
    heldRef: { current: [] },
    confirmedNotices: (items) => items,
    seenNamespace: ownKey,
    seenNamespaceRef: { current: ownKey },
    activeRef: { current: false },
    lastListRef: { current: null },
    shownListRef: { current: null },
    seenRef,
    ownKeyRef: { current: ownKey },
    remoteSeenRef: { current: null },
    remoteFor: () => [],
    followsSetRef: { current: null },
    randomBytes: null,
    badge () {},
    setUnread () {},
    onSeenStateRef: {
      current: (namespace, tokens, avisos) => {
        reports.push({ namespace, tokens: [...tokens] })
        closed.push(readTags({ avisos }))
      }
    }
  })
  settle([newer, older], false)
  t.alike(closed.at(-1), [])
  settle([newer], false, false)
  t.alike(closed.at(-1), [], 'page two still has an unread like for this post')
  t.alike(reports.at(-1), { namespace: ownKey, tokens: [] }, 'hidden rows are still not uploaded as local marks')
  settle([older], true)
  t.alike(closed.at(-1), ['varanda-like-' + ownKey + ':7'], 'showing the older row proves it read')
  settle([newer], false, false)
  t.alike(closed.at(-1), ['varanda-like-' + ownKey + ':7'])
  seenRef.current = { ids: [newer.seen] }
  settle([newer, older], false, false)
  t.alike(closed.at(-1), [])
  seenRef.current = { ids: [newer.seen] }
  settle([newer], false, false)
  t.alike(closed.at(-1), ['varanda-like-' + ownKey + ':7'], 'reloading the namespace discards its previous read memory')
})

// Exercise the actual screen effects without JSX, a platform or a network.
test('hidden screens serialize the two short links before sync is ready', async (t) => {
  const peek = await import('../src/peek.js')
  const notices = await import('../src/notices.js')
  const waits = []
  const calls = []
  const node = {
    epoch: 10,
    online: true,
    visible: true,
    phase: 'ready',
    signals: { seederVerified: true, ready: false },
    whenIdle (ms) {
      let release
      const promise = new Promise((resolve) => { release = resolve })
      waits.push({ ms, resolve: release })
      return { promise, cancel () {} }
    }
  }
  const state = { loadedAt: null, loading: false, refreshing: false, unsupported: false }
  const common = {
    ...peek,
    ...notices,
    node,
    hosted: true,
    active: false,
    activeRef: { current: false },
    state,
    stateRef: { current: state },
    previous: { current: {} },
    refreshRef: { current: 0 }
  }
  let finishPeek
  const peekRead = new Promise((resolve) => { finishPeek = resolve })
  const warm = screenCallback('Espiadinha', 'useEffect(() => {\n    const warm', {
    ...common,
    seederVerified: true,
    heldRef: { current: null },
    loadFirst: (opts) => { calls.push(['peek', opts.quiet]); return peekRead }
  })
  const firstReadEpochRef = { current: null }
  const first = screenCallback('Avisos', 'useEffect(() => {\n    const canStart', {
    ...common,
    firstReadEpochRef,
    loadFirst: (opts) => calls.push(['notices'])
  })
  warm()
  first()
  t.alike(waits.map((w) => w.ms), [500], 'notices waits for Espiadinha, not just a longer timer')
  waits[0].resolve()
  await Promise.resolve()
  t.alike(calls, [['peek', true]])
  first()
  t.is(waits.length, 1, 'notices cannot start while the warm read is pending')
  finishPeek()
  await Promise.resolve()
  first()
  t.alike(waits.map((w) => w.ms), [500, 1000])
  waits[1].resolve()
  await Promise.resolve()
  t.alike(calls, [['peek', true], ['notices']])
  warm()
  first()
  t.is(waits.length, 2, 'neither screen repeats its first read this epoch')
})

test('a refused seeder cancels both warm reads even after their idle waits were armed', async (t) => {
  const peek = await import('../src/peek.js')
  const notices = await import('../src/notices.js')
  for (const screen of ['Espiadinha', 'Avisos']) {
    const epoch = screen === 'Espiadinha' ? 11 : 12
    peek.updatePeekWarmState(epoch, { eligible: false })
    let release
    let calls = 0
    const state = { loadedAt: null, loading: false, refreshing: false, unsupported: false }
    const context = {
      ...peek,
      ...notices,
      node: {
        epoch,
        online: true,
        visible: true,
        phase: 'ready',
        signals: { seederVerified: true, ready: false },
        whenIdle: () => ({ promise: new Promise((resolve) => { release = resolve }), cancel () {} })
      },
      hosted: true,
      active: false,
      activeRef: { current: false },
      seederVerified: true,
      state,
      stateRef: { current: state },
      heldRef: { current: null },
      firstReadEpochRef: { current: null },
      previous: { current: {} },
      refreshRef: { current: 0 },
      loadFirst: async () => { calls++ }
    }
    const marker = screen === 'Espiadinha' ? 'useEffect(() => {\n    const warm' : 'useEffect(() => {\n    const canStart'
    const effect = screenCallback(screen, marker, context)
    effect()
    t.is(typeof release, 'function', screen + ' armed its idle wait')
    peek.updatePeekWarmState(epoch, { busy: true })
    release()
    await Promise.resolve()
    effect()
    t.is(calls, 0, screen + ' checks the refusal again before opening a link')
  }
})

test('both screens share a seeder refusal and leave explicit reads available', async (t) => {
  const peek = await import('../src/peek.js')
  const notices = await import('../src/notices.js')
  for (const screen of ['Espiadinha', 'Avisos']) {
    const epoch = screen === 'Espiadinha' ? 13 : 14
    peek.updatePeekWarmState(epoch, { eligible: true })
    const activeRef = { current: false }
    const stateRef = { current: { loadedAt: null, unsupported: false } }
    let calls = 0
    const refused = async () => {
      calls++
      throw Object.assign(new Error('Semeador ocupado; tente novamente em instantes.'), { code: 'USAGE' })
    }
    const context = {
      ...peek,
      ...notices,
      node: { epoch },
      hosted: true,
      stateRef,
      activeRef,
      seqRef: { current: 0 },
      commit: (patch) => { stateRef.current = { ...stateRef.current, ...patch } },
      errorText: (err) => err.message,
      followedHereRef: { current: new Map() },
      pendingIngestRef: { current: null },
      followsPending: { current: false },
      PEEK_LIMIT_DEFAULT: 30,
      peek: refused,
      pageKeyRef: { current: null },
      ownKeyRef: { current: null },
      backoffRef: { current: false },
      setAvatarCycle () {},
      read: refused,
      // The saved-copy helpers of Avisos (T16): no copy is armed here.
      binding: null,
      cancelSave () {},
      armSave () {},
      cacheGeneration: () => 0,
      heldRef: { current: [] },
      cursorRowRef: { current: null },
      corePageRef: { current: false },
      busyRetryRef: { current: null },
      loadFirstRef: { current: null },
      isLockedError: () => false,
      isBusyError: (err) => err.message === 'avisos já em andamento',
      setTimeout: () => t.fail('a refused seeder must not schedule a retry')
    }
    const loadFirst = screenCallback(screen, 'const loadFirst = useCallback(', context)
    await loadFirst({ quiet: true })
    t.is(calls, 1)
    t.is(peek.getPeekWarmState().busy, true, screen + ' publishes the refusal')
    t.is(stateRef.current.loading, false)
    activeRef.current = true
    await loadFirst()
    t.is(calls, 2, screen + ' explicit read bypasses the warm refusal and idle wait')
  }
})

test('the hidden poll still starts the first read, and rows are not drawn before the first show', (t) => {
  let loads = 0
  const poll = screenCallback('Avisos', 'const poll = useCallback', {
    hosted: true,
    stateRef: { current: { loadedAt: null, unsupported: false, locked: false } },
    pageKeyRef: { current: null },
    ownKeyRef: { current: null },
    activeRef: { current: false },
    loadFirst: () => { loads++ }
  })
  poll()
  t.is(loads, 1, 'the 5-minute poll lights the bell while the tab is hidden')
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  t.ok(source.includes('if (active) shownOnceRef.current = true'))
  t.ok(source.includes('data={shownOnceRef.current ? rows : EMPTY_ROWS}'))
  t.ok(source.includes('const filteredItems = filterNotices(shownItems, filter)'), 'the drawn rows still come from shownItems')
  t.ok(source.includes('const rows = withDayHeaders(filteredItems, now)'))
  t.ok(source.includes('const EMPTY_ROWS = Object.freeze([])'))
})

test('the filter chips and day headers never reach settle, the seen marks or the badge', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const allowed = new Set(['items', 'merged', 'page.notices', 'stateRef.current.items', 'current.items', 'plan.settle.list', 'list',
    // a live read only: confirmedNotices keeps the unverified rows out of the marks
    'confirmedNotices(r.items', 'confirmedNotices(items', 'confirmedNotices(merged'])
  const calls = [...source.matchAll(/\bsettle(?:Ref\.current)?\(([^,)]+)/g)].map((m) => m[1].trim())
  t.ok(calls.length >= 10)
  for (const arg of calls) t.ok(allowed.has(arg), 'settle takes a whole loaded list: ' + arg)
  t.is(source.split('filterNotices(').length - 1, 1, 'filtered only where the rows are drawn')
  t.is(source.split('withDayHeaders(').length - 1, 1)
  for (const derived of ['filteredItems', 'rows']) {
    for (const sink of ['settle(', 'badge(', 'hasNew(', 'seenOnScreen(', 'markSeenPadded(', 'onSeenStateRef.current(']) {
      t.absent(source.includes(sink + derived), sink + derived)
    }
  }
  // The filtered list and the drawn rows go nowhere else: the header rows,
  // the data prop and the filter's empty state.
  const component = source.slice(source.indexOf('export default function Avisos'), source.indexOf('const makeStyles'))
  t.is(component.split(/\bfilteredItems\b/).length - 1, 3, 'filteredItems: declared, given to withDayHeaders, and the empty check')
  t.ok(component.includes('const rows = withDayHeaders(filteredItems, now)'))
  t.ok(component.includes('const listEmpty = shownItems.length > 0 && filteredItems.length === 0'))
  // settle has a `rows` of its own (remoteFoldPlan), declared before this one.
  const drawn = component.slice(component.indexOf('const rows = withDayHeaders('))
  t.is(drawn.split(/\brows\b/).length - 1, 2, 'rows: declared and drawn, nothing else')
  t.is(component.split('withDayHeaders(').length - 1, 1)
  t.ok(component.includes('data={shownOnceRef.current ? rows : EMPTY_ROWS}'))
  // Day headers have keys of their own and never pass for a notice.
  t.ok(source.includes("const rowKey = (row) => (isDayHeader(row) ? row.key : 'n:' + noticeId(row))"))
  t.ok(source.includes('keyExtractor={rowKey}'))
  t.ok(source.includes("if (isDayHeader(item)) return <Text style={styles.dayHeader} accessibilityRole='header' numberOfLines={1}>{displayText(item.title)}</Text>"), 'a header title goes through displayText too')
})

test('Avisos tints an unread row beside its dot', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  t.ok(source.includes('unreadRow: { backgroundColor: colors.accentSoft }'))
  const row = source.slice(source.indexOf('function NoticeRow'), source.indexOf('export default function Avisos'))
  t.ok(row.includes('[styles.row, unread && styles.unreadRow, pressed && open && styles.pressed]'), 'a post row')
  t.ok(row.includes('!followBack && unread && styles.unreadRow'), 'a follow row without the pill')
  t.ok(row.includes('<View style={[styles.row, unread && styles.unreadRow]}>'), 'a follow row with the pill')
  t.ok(row.includes('{unread ? <View style={styles.unreadDot} accessible={false} /> : null}'), 'the dot stays')
})

test('the Seguir de volta pill is only for the person, only for someone not followed', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  // A list cleared only in the acting effect still holds the page's rows for
  // one commit after a switch back to the person: no pill until it is cleared.
  t.ok(source.includes('const pageRows = pageKey !== null || actingKeyRef.current !== actingKey\n'))
  t.ok(source.includes('followBack={!pendingRows.has(noticeId(item)) && showsFollowBack(item, { pageActing: pageRows, follows, ownKey })}'))
  t.ok(/if \(actingKeyRef\.current === actingKey && listBindingRef\.current === bindingKey\) return\n(?:\s*.*\n){0,16}?\s*actingKeyRef\.current = actingKey/.test(source), 'the ref moves only where the list is cleared')
  t.is(source.split('actingKeyRef.current = actingKey').length - 1, 1)
  // The pressed row is the key that is sent.
  t.ok(source.includes('onFollow={() => onFollowBack(item)}'))
  t.ok(source.includes('onFollowBack={followBack}'))
  t.ok(source.includes("const key = item && typeof item.key === 'string' ? item.key.toLowerCase() : ''"))
  t.ok(source.includes("const r = await request('follow.add', { key })"))
  // The handler's page guard reads the render's copy and the store itself.
  t.ok(source.includes('pageKeyRef.current = pageKey\n'))
  t.ok(source.includes("if (followBackRef.current !== null || pageKeyRef.current !== null || actingGet().kind === 'page') return"))
  t.ok(source.includes("import { get as actingGet, subscribe as actingSubscribe } from '../actingAs'"))
  t.ok(source.includes("const pageKey = acting.kind === 'page' ? acting.key : null"))
  t.ok(source.includes('if (passkeyHosted && active && pageKey === null) loadFollows()'), 'a page never reads the person\'s follow set')
  t.ok(source.includes('}, [passkeyHosted, active, pageKey, ownKey, followsVersion, loadFollows])'), 'read again on any follow change or identity')
  t.ok(source.includes('const { follows, load: loadFollows, mark: markFollow } = useFollowSet(request)'))
  t.ok(source.includes('label={FOLLOW_BACK_LABEL}'))
  t.ok(source.includes('followDisabled={followBackKey !== null}'), 'one follow back at a time')
  const row = source.slice(source.indexOf('function NoticeRow'), source.indexOf('export default function Avisos'))
  t.ok(row.indexOf('</PressScale>') < row.indexOf('<FollowPill'), 'the pill is not inside the row control')
  t.is(source.split("request('follow.add'").length - 1, 1, 'one follow.add call site')
  t.absent(source.includes("'follow.remove'"))
})

const A = 'a'.repeat(64)

test('Seguir de volta on a notice not yet confirmed live sends nothing', async (t) => {
  const h = followBackHarness({ answer: () => Promise.resolve({ changed: true }) })
  h.context.stateRef.current = { unverified: [A + ':1'] }
  await h.followBack({ key: A, seq: 1, name: 'Bia' })
  t.alike(h.calls, [])
  t.alike(h.pending, [])
})

function followBackHarness ({ pageKey = null, acting = { kind: 'me' }, answer, reload = () => {} }) {
  const calls = []
  const toasts = []
  const marks = []
  const pending = []
  let reloads = 0
  let changed = 0
  const context = {
    followBackRef: { current: null },
    stateRef: { current: { unverified: [] } },
    noticeId: (item) => item.key + ':' + item.seq,
    pageKeyRef: { current: pageKey },
    actingGet: () => acting,
    KEY64: /^[0-9a-f]{64}$/i,
    setFollowBackKey: (key) => pending.push(key),
    request: (method, params) => {
      // The params object is built inside the vm context: compared as text.
      calls.push(method + ' ' + JSON.stringify(params))
      return answer()
    },
    markFollow: (key, on) => marks.push([key, on]),
    displayText: (s) => s,
    whoOf: (p) => ({ title: p.name }),
    onToast: (text) => toasts.push(text),
    onFollowsChanged: () => { changed++ },
    errorText: (err) => (err.uncertain ? 'incerto' : err.message),
    loadFollows: () => {
      reloads++
      return reload()
    }
  }
  const followBack = screenCallback('Avisos', 'const followBack = useCallback(', context)
  return { followBack, calls, toasts, marks, pending, context, reloads: () => reloads, changed: () => changed }
}

test('Seguir de volta sends one follow.add per press and marks it pending before the request', async (t) => {
  let resolve
  const h = followBackHarness({ answer: () => new Promise((_resolve) => { resolve = _resolve }) })
  const item = { key: A, seq: 1, name: 'Bia', username: 'bia' }
  const first = h.followBack(item)
  t.alike(h.pending, [A], 'pending is set in the same tick as the press')
  t.alike(h.calls, ['follow.add ' + JSON.stringify({ key: A })])
  await h.followBack(item)
  t.is(h.calls.length, 1, 'a second press while pending sends nothing')
  resolve({ changed: true })
  await first
  t.alike(h.marks, [[A, true]])
  t.is(h.changed(), 1, 'onFollowsChanged on success')
  t.alike(h.toasts, ['Agora você segue Bia.'])
  t.alike(h.pending, [A, null])
  t.is(h.reloads(), 0)
})

test('Seguir de volta never resends after a failed or uncertain answer, and reads the set again', async (t) => {
  for (const err of [Object.assign(new Error('falhou'), { code: 'USAGE' }), Object.assign(new Error('x'), { uncertain: true })]) {
    const h = followBackHarness({ answer: () => Promise.reject(err) })
    await h.followBack({ key: A, seq: 1, name: 'Bia' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    t.is(h.calls.length, 1, 'exactly one request')
    t.alike(h.toasts, [err.uncertain ? 'incerto' : 'falhou'], 'the error text is shown')
    t.is(h.reloads(), 1, 'the follow set is read again')
    t.is(h.changed(), 0)
    t.alike(h.marks, [])
    t.alike(h.pending, [A, null])
  }
})

test('Seguir de volta reads the acting store, not only the render copy', async (t) => {
  const h = followBackHarness({ acting: { kind: 'page', key: 'b'.repeat(64) }, answer: () => Promise.resolve({ changed: true }) })
  await h.followBack({ key: A, seq: 1, name: 'Bia' })
  t.is(h.calls.length, 0, 'a switch to a page that has not rendered yet still sends nothing')
  t.alike(h.pending, [])
})

test('Seguir de volta keeps the pill pending until the set is read again after a failure', async (t) => {
  let finish
  const h = followBackHarness({
    answer: () => Promise.reject(Object.assign(new Error('x'), { uncertain: true })),
    reload: () => new Promise((_resolve) => { finish = _resolve })
  })
  const press = h.followBack({ key: A, seq: 1, name: 'Bia' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  t.alike(h.toasts, ['incerto'], 'the toast comes before the re-read')
  t.is(h.reloads(), 1)
  t.alike(h.pending, [A], 'still pending while the set is read')
  finish(new Set())
  await press
  t.alike(h.pending, [A, null])
  t.is(h.calls.length, 1, 'never resent')
  const broken = followBackHarness({ answer: () => Promise.reject(new Error('falhou')), reload: () => Promise.reject(new Error('lista')) })
  await broken.followBack({ key: A, seq: 1, name: 'Bia' })
  t.alike(broken.pending, [A, null], 'a failed re-read still releases the pill')
  t.is(broken.calls.length, 1)
})

test('Seguir de volta sends the row key in lower case', async (t) => {
  const h = followBackHarness({ answer: () => Promise.resolve({ changed: true }) })
  await h.followBack({ key: 'A'.repeat(64) + '', seq: 1, name: 'Bia' })
  t.alike(h.calls, ['follow.add ' + JSON.stringify({ key: A })])
  t.alike(h.marks, [[A, true]])
})

test('a show and an acting switch set the filter back to Todas before anything is marked seen', (t) => {
  const events = []
  const base = {
    previous: { current: { active: false, refresh: 0, scrollToTop: 0 } },
    refresh: 0,
    scrollToTop: 0,
    stateRef: { current: { loading: false, refreshing: false, loadedAt: Date.now(), items: ['row'] } },
    reloadAfterRef: { current: false },
    followsReadAtRef: { current: null },
    followsReadCovers: () => false,
    promote: () => {},
    shouldReloadOnShow: () => false,
    settle: () => events.push('settle'),
    loadFirst: () => events.push('load'),
    setFilter: (id) => events.push('filter ' + id)
  }
  const shownEffect = screenCallback('Avisos', 'useEffect(() => {\n    const prev = previous.current', { ...base, active: true })
  shownEffect()
  t.alike(events, ['filter todas', 'settle'], 'reset, then the show marks the loaded rows')
  events.length = 0
  shownEffect()
  t.alike(events, [], 'still shown: the chosen filter stays')
  const hiddenEffect = screenCallback('Avisos', 'useEffect(() => {\n    const prev = previous.current', { ...base, previous: { current: { active: false } }, active: false })
  hiddenEffect()
  t.alike(events, [], 'hidden: nothing')
  const actingEffect = screenCallback('Avisos', 'useEffect(() => {\n    if (actingKeyRef.current === actingKey && listBindingRef.current === bindingKey) return', {
    actingKey: 'b'.repeat(64),
    actingKeyRef: { current: '' },
    bindingKey: 'k',
    listBindingRef: { current: 'k' },
    cancelSave: () => {},
    heldRef: { current: ['held'] },
    binding: null,
    seededNotices: () => null,
    cursorRowRef: { current: 1 },
    seqRef: { current: 0 },
    seenRef: { current: null },
    busyRetryRef: { current: null },
    backoffRef: { current: false },
    clearTimeout: () => {},
    commit: () => events.push('commit'),
    badge: () => {},
    loadFirstRef: { current: () => events.push('load') },
    setFilter: (id) => events.push('filter ' + id)
  })
  actingEffect()
  t.alike(events, ['filter todas', 'commit', 'load'])
})

test('Seguir de volta does nothing while a page is acting', async (t) => {
  const h = followBackHarness({ pageKey: 'b'.repeat(64), answer: () => Promise.resolve({ changed: true }) })
  await h.followBack({ key: A, seq: 1, name: 'Bia' })
  t.is(h.calls.length, 0, 'follow.add would act as the person')
  t.alike(h.pending, [])
  const bad = followBackHarness({ answer: () => Promise.resolve({ changed: true }) })
  await bad.followBack({ key: 'not-a-key', seq: 1 })
  t.is(bad.calls.length, 0, 'only a 64-hex key')
})

test('a follows change reads on its own only while the tab is hidden (issue #230)', async (t) => {
  const { followsReadsHere } = await import('../src/notices.js')
  t.is(followsReadsHere({ active: true, busy: false }), false, 'shown: the refresh bump reads, once')
  t.is(followsReadsHere({ active: true, busy: true }), false)
  t.is(followsReadsHere({ active: false, busy: false }), true, 'hidden: read in the background')
  t.is(followsReadsHere({ active: false, busy: true }), false, 'a read in flight is not doubled')
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  t.ok(source.includes('if (!followsReadsHere({ active, busy: current.loading || current.refreshing })) return'))
  t.absent(source.includes('if (!stateRef.current.loading && !stateRef.current.refreshing) loadFirst()'), 'no unconditional read on a follows bump')
})

test('Seguir de volta asks for one reload only when the follow changed', async (t) => {
  const changed = followBackHarness({ answer: () => Promise.resolve({ changed: true }) })
  await changed.followBack({ key: A, seq: 1, name: 'Bia' })
  t.is(changed.changed(), 1)
  const same = followBackHarness({ answer: () => Promise.resolve({ changed: false }) })
  await same.followBack({ key: A, seq: 1, name: 'Bia' })
  t.is(same.changed(), 0, 'nothing changed: no reload')
})

test('a hidden follows read keeps the refresh bump from reading again at show (issue #230)', async (t) => {
  const { followsReadCovers, FOLLOWS_COVER_MS } = await import('../src/notices.js')
  const run = (readAt) => {
    const events = []
    const previous = { current: { active: false, refresh: 0, scrollToTop: 0 } }
    const followsReadAtRef = { current: readAt }
    const ctx = (extra) => ({
      previous,
      scrollToTop: 0,
      stateRef: { current: { loading: false, refreshing: false, loadedAt: Date.now(), items: [] } },
      reloadAfterRef: { current: false },
      followsReadAtRef,
      followsReadCovers,
      promote: () => {},
      shouldReloadOnShow: () => false,
      settle: () => {},
      loadFirst: () => events.push('load'),
      setFilter: () => {},
      ...extra
    })
    screenCallback('Avisos', 'useEffect(() => {\n    const prev = previous.current', ctx({ active: false, refresh: 1 }))()
    const adopted = previous.current.refresh
    const cleared = followsReadAtRef.current
    screenCallback('Avisos', 'useEffect(() => {\n    const prev = previous.current', ctx({ active: true, refresh: 1 }))()
    return { adopted, cleared, events }
  }
  const fresh = run(Date.now())
  t.is(fresh.adopted, 1, 'a bump right after a hidden follows read is adopted')
  t.is(fresh.cleared, null, 'once')
  t.alike(fresh.events, [], 'shown with the same refresh: no second read')
  const stale = run(Date.now() - FOLLOWS_COVER_MS - 1000)
  t.is(stale.adopted, 0, 'a later, unrelated bump is not adopted')
  t.is(stale.cleared, null)
  t.alike(stale.events, ['load'], 'so the show reads')
  t.absent(followsReadCovers({ readAt: null, now: Date.now() }), 'no follows read')
  t.absent(followsReadCovers({ readAt: Date.now() + 5000, now: Date.now() }), 'a clock step back covers nothing')
})
