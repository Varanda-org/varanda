'use strict'

const test = require('brittle')

const load = () => import('../src/hashtagNav.js')

test('tagTarget: a tag becomes an assunto entry keyed by the folded token', async (t) => {
  const { tagTarget } = await load()
  t.alike(tagTarget('ceu'), { screen: 'assunto', key: 'ceu' })
  t.alike(tagTarget('#Céu'), { screen: 'assunto', key: 'ceu' })
})

test('tagTarget: invalid tags have no target', async (t) => {
  const { tagTarget } = await load()
  for (const bad of ['', '#', 'a', 'dois palavras', 'a+b', '../x', 'x'.repeat(33), null, undefined, 7, {}]) {
    t.is(tagTarget(bad), null, String(bad))
  }
})

test('tagTarget: the entry is a valid nav entry and differs per tag', async (t) => {
  const { tagTarget, tagTitle } = await import('../src/hashtagNav.js')
  const { validEntry } = await import('../src/nav.js')
  const a = tagTarget('ceu')
  const b = tagTarget('mar')
  t.ok(validEntry(a))
  t.not(a.key, b.key, 'a tag tapped on an assunto page pushes a new entry')
  t.is(tagTitle('ceu'), '#ceu')
})

// Tags are public-post only. A private surface (DM bubble, DM or group screen)
// must never opt in, so its text can never open a topic page.
const { readFileSync, readdirSync } = require('node:fs')
const { join, relative, sep } = require('node:path')
const SRC = join(__dirname, '..', 'src')
const src = (...p) => readFileSync(join(SRC, ...p), 'utf8')
const appJs = () => readFileSync(join(__dirname, '..', 'App.js'), 'utf8')

function jsFiles (dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...jsFiles(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

// Each <MentionText ...> or <RichText ...> element up to its closing '/>' (or
// the next element), checked for a hashtags attribute in any form.
function passesHashtags (code) {
  const re = /<(?:MentionText|RichText)\b/g
  let m
  while ((m = re.exec(code)) !== null) {
    const rest = code.slice(m.index + 1)
    const stop = rest.search(/\/>|\n\s*<[A-Za-z]/)
    const tag = stop === -1 ? rest : rest.slice(0, stop)
    if (/\shashtags(?=[\s=/>}]|$)/.test(tag) || /hashtags\s*:/.test(tag)) return true
  }
  return false
}

test('PostRow is the only file under src that passes hashtags to MentionText or RichText', (t) => {
  const passing = jsFiles(SRC).filter((f) => passesHashtags(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f).split(sep).join('/'))
  t.alike(passing, ['ui/PostRow.js'])
  t.ok(passesHashtags('<MentionText text={a} hashtags />'), 'the scan sees the bare attribute')
  t.ok(passesHashtags('<RichText\n  text={a}\n  hashtags={true}\n/>'), 'the scan sees a multi-line element')
  t.absent(passesHashtags('<MentionText text={a} numberOfLines={6} />'), 'and nothing else')
})

test('App.js provides the tag opener only on a hosted node', (t) => {
  const app = appJs()
  const providers = app.match(/<HashtagContext\.Provider\b[^>]*>/g) || []
  t.alike(providers, ['<HashtagContext.Provider value={node.hosted === true ? openTag : undefined}>'])
  for (const f of jsFiles(SRC)) t.absent(/HashtagContext\.Provider/.test(readFileSync(f, 'utf8')), relative(SRC, f))
})

test('a span is a tag link only with the prop, the context and no clamp', (t) => {
  const mention = src('ui', 'MentionText.js')
  t.ok(mention.includes("hashtags === true && typeof open === 'function'"))
  t.ok(mention.includes('const openTag = links ? contextTag : undefined'), 'a clamped text keeps tags plain, like links')
  t.ok(mention.includes("'Abrir assunto #'"))
  t.absent(/hitSlop/.test(mention), 'no hitSlop on a nested Text: React Native ignores it there')
})

test('Assunto: the effect depends on stable values, so it does not refetch on every render', (t) => {
  const code = src('screens', 'Assunto.js')
  t.ok(code.includes("const key = typeof entry.key === 'string' ? entry.key : ''"), 'the key is a string')
  t.ok(code.includes('const path = useMemo(() => topicPath(key), [key])'), 'the path object is memoized on that string')
  t.is(code.split('topicPath(').length - 1, 1, 'topicPath is not called anywhere else in render')
  t.ok(/useEffect\(\(\) => \{[\s\S]*?act\(true\)[\s\S]*?\}, \[act, commit\]\)/.test(code), 'the effect reruns only when act or commit change')
  t.ok(/const readPage = useCallback\([\s\S]*?\}, \[path, request\]\)/.test(code), 'readPage depends on the memoized path')
})

test('Assunto: blocked authors are dropped before peeking, a failed refresh keeps the list', (t) => {
  const code = src('screens', 'Assunto.js')
  t.ok(/const page = dropBlocked\(res\.value, blockedRef\.current\)\s+const plan = planTopicPeeks\(page, state\)/.test(code), 'blocked refs are dropped before planning and folding')
  t.ok(/if \(plan\.length > 0\) \{\s+try \{\s+await peekAll\(/.test(code), 'no peek when every ref was already judged')
  t.ok(/if \(refreshFailed\(fresh, out\)\) \{\s+commit\(\{ loading: false, refreshing: false, error: out\.error, retryFresh: true \}\)\s+return\s+\}\s+ingest\(/.test(code), 'a refresh that folded nothing keeps the list and the social cache')
  t.ok(code.includes('const header = notice === null && notes.length > 0'), 'the indexing and incomplete notes show on an empty list too')
})

test('Assunto: a retry redoes the failed action, a refresh supersedes Ver mais, peeks wait for the block list', (t) => {
  const code = src('screens', 'Assunto.js')
  t.ok(/commit\(\{ loading: false, refreshing: false, error: out\.error, retryFresh: true \}\)/.test(code), 'a refresh that kept the list marks its retry as a refresh')
  t.ok(code.includes('const retry = () => act(retryFresh === true)'))
  t.absent(/onRetry=\{\(\) => act\(false\)\}|body=\{error\}[^\n]*onAction=\{\(\) => act\(false\)\}/.test(code), 'no retry hardcodes Ver mais')
  t.ok(code.includes('if (current.refreshing || (current.loading && !fresh)) return'), 'only a refresh may start over a running Ver mais')
  t.ok(code.includes("const blocksKnown = blocks.loadState !== 'pending'"))
  t.ok(code.includes('if (!hosted || path === null || !blocksKnown) return'), 'nothing is read before the block list is known')
  t.ok(/\}, \[hosted, path, blocksKnown, readPage, commit, ingest\]\)/.test(code), 'the first read runs once the list is known')
  t.ok(code.includes(': loading && loadedAt !== null ? <ListFooter loading /> : null'), 'progress for an action over an empty list')
})
