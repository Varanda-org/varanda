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
  t.ok(source.includes("{snippet ? <Text style={styles.snippet} numberOfLines={1}>{'“' + snippet + '”'}</Text> : null}"))
  t.ok(/snippet: \{ \.\.\.type\.postMeta, color: colors\.ink \}/.test(source), 'a style apart from the handle')
})

test('Avisos gives exhausted snippet refs another chance on reload, and speaks the whole row', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const hook = source.slice(source.indexOf('function useSnippets'), source.indexOf('function NoticeRow'))
  t.ok(hook.includes('exhaustedRef.current.add(r)'), 'refs that ran out of tries are remembered apart')
  t.ok(/triedRef\.current\.delete\(r\)\n\s*triesRef\.current\.delete\(r\)/.test(hook), 'a reload releases them')
  t.ok(hook.includes('}, [retryKey])'))
  t.ok(source.includes('useSnippets(shownItems, node.request, active && hosted && notice === null, loadedAt)'), 'the reload signal is loadedAt')
  t.ok(source.includes("const spoken = [line, subtitle, snippet ? '“' + snippet + '”' : null, unread ? 'não lido' : null].filter(Boolean).join(', ')"))
  t.ok(source.includes("accessibilityLabel={ref === null ? spoken : spoken + ', abrir publicação'}"))
  t.ok(source.includes("accessibilityLabel={spoken + ', ver perfil'}"))
})

test('Avisos resets the seen ids before folding remote marks, and a hidden poll neither marks nor reports', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const reset = source.indexOf('shownListRef.current = null')
  const fold = source.indexOf('// A seen pass brought the marks of another device')
  t.ok(reset > 0 && fold > 0)
  t.ok(reset < fold, 'the namespace reset effect runs before the remote fold effect')
  t.ok(source.includes('settle(page.notices, false, false)'))
  t.absent(source.includes('settle(page.notices, false)\n'))
  t.ok(/if \(shown && typeof onSeenStateRef\.current === 'function'\)/.test(source))
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
  for (const piece of ["from '../names'", 'fetchMember', 'pickAvatar', 'avatarOf', 'needsAvatar', 'resolveRowAvatars', 'rowAvatarSource(item, avatars[item.key])', 'picture={picture}', 'avatar: picture || null', 'resolveMany(', 'const AVATAR_BATCH = 10', 'persist={false}']) {
    t.ok(source.includes(piece), piece)
  }
  t.absent(source.includes('picture={item.avatar}'))
  t.absent(source.includes('avatar: item.avatar'))
  t.absent(/[^a-zA-Z]fetch\(/.test(source), 'no raw fetch call')
  t.absent(source.includes('\u2014'))
})

test('Avisos marks avatar authors tried only after the batch completed and keeps the cache out of its lifetime', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
  const hook = source.slice(source.indexOf('function useRowAvatars'), source.indexOf('const SNIPPET_BATCH'))
  t.ok(hook.indexOf('if (!alive) return') < hook.indexOf('triedRef.current.add(k)'))
  t.ok(hook.includes('resolveRowAvatars(list, { fetchMember, peekChunk, alive: () => alive })'))
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
  t.ok(source.includes("if (active && hosted && shownKeys !== '') resolveMany(shownKeys.split(','))"))
  t.ok(source.includes('}, [active, hosted, shownKeys, resolveMany])'))
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
