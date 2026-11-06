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
