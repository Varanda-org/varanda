'use strict'

// Diário paints its stored snapshot (src/screenSnapshot.js, kind 'diario') on
// mount and writes it again after a fresh first page or a deletion. Diario.js
// loads react-native, so the wiring is checked on its text; its module-level
// helpers run here on their own source.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const DIARIO = fs.readFileSync(path.join(APP, 'src/screens/Diario.js'), 'utf8')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const ME = { kind: 'me' }

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The text of the top-level `function <name> (...) { ... }`, braces matched.
function fnText (src, name) {
  let start = src.indexOf('\nfunction ' + name + ' (')
  if (start < 0) {
    start = src.indexOf('\nexport function ' + name + ' (')
    if (start >= 0) start += 'export '.length
  }
  if (start < 0) {
    start = src.indexOf('\nexport default function ' + name + ' (')
    if (start >= 0) start += 'export default '.length
  }
  if (start < 0) throw new Error('no function ' + name)
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i + 1)
  }
  throw new Error('unbalanced ' + name)
}

// The text of `const <name> = useCallback(...)` up to its dependency list.
function callbackText (src, name) {
  const start = src.indexOf('const ' + name + ' = useCallback(')
  if (start < 0) throw new Error('no callback ' + name)
  const end = src.indexOf('}, [', start)
  return src.slice(start, src.indexOf(']', end) + 1)
}

const CODE = withoutComments(DIARIO)
const screen = fnText(CODE, 'DiarioList')
const loadNewest = callbackText(screen, 'loadNewest')
const loadOlder = callbackText(screen, 'loadOlder')
const writeSnapshot = callbackText(screen, 'writeSnapshot')
const armSnapshot = callbackText(screen, 'armSnapshot')

function helper (name) {
  // eslint-disable-next-line no-new-func
  return new Function(fnText(CODE, name) + '\nreturn ' + name)()
}

function post (author, seq) {
  return { kind: 'post', author, name: null, username: null, seq, at: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(), text: 't' + seq, replyTo: null, quote: null, media: null, preview: null }
}

function at (seq) {
  return new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString()
}

test('the stored page is read in the first render, before any request', (t) => {
  const seedAt = screen.indexOf('readDiarioSeed(binding, acting)')
  t.ok(seedAt > 0, 'read in the screen')
  t.ok(/useState\(\(\) => readDiarioSeed\(binding, acting\)\)/.test(screen), 'once, in a state initializer')
  t.ok(/useState\(\(\) => \(boot === null \? null : boot\.data\)\)/.test(screen), 'the rows start from it')
  for (const call of ["request('node.info'", "request('log.read'", "request('community.list'"]) {
    const i = screen.indexOf(call)
    t.ok(i > seedAt, call + ' comes after the seed')
  }
  t.ok(/useSocial\(\{[^}]*seed: boot === null \? null : boot\.social/.test(screen), 'the stored originals seed useSocial')
})

test('a seeded page leaves loadedAt null, so the live read still runs', (t) => {
  t.ok(screen.includes('const loadedAtRef = useRef(null)'))
  const seeds = fnText(CODE, 'readDiarioSeed') + fnText(CODE, 'diarioSeed')
  t.absent(seeds.includes('loadedAt'), 'the seed never sets loadedAt')
  const sets = screen.match(/loadedAtRef\.current = \w+/g)
  t.ok(sets.every((s) => s === 'loadedAtRef.current = null' || s === 'loadedAtRef.current = startedAt'), 'set only to null or a live read start')
  t.ok(loadNewest.indexOf('loadedAtRef.current = startedAt') > loadNewest.indexOf("request('log.read'"), 'set after a live page')
  t.ok(/reuseInfo = [^;]*infoIdentityRef\.current !== null/.test(loadNewest.replace(/\s+/g, ' ')), 'the stored key is never reused for node.info')
})

test('the snapshot is written only after a live page or a deletion', (t) => {
  const arms = screen.split('armSnapshot()').length - 1
  t.is(arms, 2, 'armed in two places')
  const setAt = loadNewest.indexOf('setData({ info, rows, atEnd: isLastLogPage(log) })')
  const armAt = loadNewest.indexOf('armSnapshot()')
  t.ok(setAt > 0 && armAt > setAt, 'loadNewest arms after the live setData')
  t.ok(/if \(deletions === deletionsRef\.current\) armSnapshot\(\)/.test(loadNewest), 'not when a post was deleted during the read')
  t.ok(/deletionsRef\.current\+\+\s+armSnapshot\(\)/.test(screen), 'a deletion arms it again')
  t.absent(loadOlder.includes('armSnapshot'), 'an older page does not')
  t.is(CODE.split('saveScreenSnapshot(').length - 1, 1, 'one save call')
  t.ok(writeSnapshot.includes("saveScreenSnapshot('diario', snapshot, gen)"), 'in writeSnapshot')
  t.ok(/if \(cur\.seeded \|\| holdsDeleted\(cur\.rows, deletedSeqsRef\.current\)\) \{\s+clearScreenSnapshot\('diario'\)\s+return/.test(writeSnapshot), 'stored rows are never written back')
  t.ok(writeSnapshot.includes('sessionAllowsDiarioSnapshot(l.passkey, l.binding.owner)'), 'only for the unlocked owner')
  t.ok(writeSnapshot.includes('actingAsMember(l.acting)'), 'only as the member')
  t.ok(/SNAPSHOT_DEBOUNCE_MS = 2000/.test(CODE) && armSnapshot.includes('setTimeout(writeSnapshot, SNAPSHOT_DEBOUNCE_MS)'), 'debounced 2 s')
})

test('every write carries the generation read when it was armed', (t) => {
  t.ok(/import \{ cacheGeneration \} from '\.\.\/localCaches'/.test(CODE))
  t.ok(armSnapshot.indexOf('snapshotGen.current = cacheGeneration()') < armSnapshot.indexOf('setTimeout('), 'read before the debounce')
  t.ok(/const gen = snapshotGen\.current/.test(writeSnapshot))
  t.absent(writeSnapshot.includes('cacheGeneration()'), 'never re-read at write time')
  t.ok(/import \{ clearScreenSnapshot, loadScreenSnapshot, saveScreenSnapshot \} from '\.\.\/screenSnapshotStore'/.test(CODE), 'the shared store, which registers itself with localCaches')
})

test('no seed and no write in the Vitrine nor as a page', (t) => {
  const read = fnText(CODE, 'readDiarioSeed')
  t.ok(/if \(binding === null \|\| !actingAsMember\(acting\)\) return null/.test(read), 'the seed refuses')
  t.ok(/const memberActing = actingAsMember\(acting\)/.test(screen))
  t.ok(/memberActing \? liveBinding\(ownKey, node\.config\) : null/.test(screen), 'no binding in the Vitrine (config null) or as a page')
  t.ok(/if \(latestRef\.current\.binding === null\) return/.test(armSnapshot), 'no write without a binding (the Vitrine)')
  t.absent(/vitrine/.test(CODE.split('\n').filter((l) => l.startsWith('import')).join('\n')), 'Diario never imports src/vitrine (vitrineGuard)')
})

test('perf marks for the stored and the live rows', (t) => {
  t.ok(screen.includes("perfMarks().mark('rows-snapshot:diario')"))
  t.ok(loadNewest.includes("perfMarks().mark('rows-live:diario')"))
})

test('stored reposts meet the block list as soon as it is known', (t) => {
  t.ok(/data\.seeded === true \? hiddenStoredSeqs\(data\.rows, data\.stored, blocks, data\.info\.publicKey,/.test(screen), 'stored rows only')
  t.ok(/\(hidden === null \|\| !hidden\.has\(row\.seq\)\)/.test(screen))
  t.ok(/\}, \[data, blocks, social\.social\.originals\]\)/.test(screen), 'recomputed when the list changes')
  t.ok(writeSnapshot.includes('blocked: l.blocked') && writeSnapshot.includes('followed: l.persistOf'), 'the build drops blocked and unfollowed originals')
})

test('older pages after a seed start from the stored bound', (t) => {
  t.ok(/current\.seeded && Number\.isSafeInteger\(current\.oldest\) \? current\.oldest : oldestSeq\(current\.rows\)/.test(loadOlder))
})

test('a built diario snapshot seeds rows with the live shape', async (t) => {
  const snap = await import('../src/screenSnapshot.js')
  const diarioSeed = helper('diarioSeed')
  const diarioLogOf = helper('diarioLogOf')
  const live = {
    info: { publicKey: OWN },
    rows: [
      { seq: 9, entry: { seq: 9, record: { type: 'repost', to: { author: FOLLOW, seq: 2 }, on: true, at: at(9) } } },
      { seq: 8, entry: { seq: 8, record: { type: 'like', to: { author: STRANGER, seq: 1 }, at: at(8) } } },
      { seq: 7, invalid: { seq: 7, reason: 'deleted' } },
      { seq: 6, entry: { seq: 6, record: { type: 'post', text: 'oi', at: at(6), replyTo: null, quote: { author: STRANGER, seq: 4 } } } },
      { seq: 5, entry: { seq: 5, record: { type: 'post', text: 'antes', at: at(5), replyTo: null } } }
    ],
    atEnd: false
  }
  const log = diarioLogOf(live, OWN)
  t.is(log.key, OWN)
  t.is(log.entries.length, 4)
  t.is(log.invalid.length, 1)
  t.is(log.entriesTruncated, 1)
  const originals = new Map([[FOLLOW + ':2', post(FOLLOW, 2)], [STRANGER + ':4', post(STRANGER, 4)]])
  const built = snap.buildScreenSnapshot('diario', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, log, originals, followed: (a) => a === OWN || a === FOLLOW, blocked: new Set() })
  t.ok(built, 'built')
  t.alike(Object.keys(built.body.originals), [FOLLOW + ':2'], 'only a followed original')
  const parsed = snap.parseScreenSnapshot(JSON.stringify(built), 'diario', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME })
  const seed = diarioSeed(parsed)
  t.alike(seed.data.rows.map((r) => r.seq), [9, 6, 5], 'only posts and reposts, newest first')
  t.ok(seed.data.rows.every((r) => r.entry.seq === r.seq && r.entry.record), 'rows as logRows makes them')
  t.is(seed.data.info.publicKey, OWN)
  t.is(seed.data.seeded, true)
  t.alike([...seed.data.stored], [9, 6, 5], 'the stored seqs are remembered')
  t.is(seed.data.oldest, 5)
  t.is(seed.data.atEnd, false)
  t.absent('loadedAt' in seed.data)
  t.alike(seed.social.originals, [[FOLLOW + ':2', post(FOLLOW, 2)]])
  t.is(seed.social.counts.size, 0, 'no counts are stored')
  t.is(diarioSeed(null), null)
  t.is(snap.parseScreenSnapshot(JSON.stringify(built), 'diario', { origin: ORIGIN, association: ASSOC, owner: OWN, acting: { kind: 'page', key: FOLLOW } }), null, 'a page reads nothing')
})

const SNAPSHOT_BINDING = { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now: Date.UTC(2026, 10, 1) }
const PREVIEW = {
  url: 'https://example.com/article',
  host: 'example.com',
  title: 'An article',
  desc: 'An article description',
  image: { core: '12'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: '34'.repeat(32), width: 640, height: 360 }
}

function snapshotWithPost (snap, extra = {}) {
  return snap.buildScreenSnapshot('diario', {
    ...SNAPSHOT_BINDING,
    log: {
      key: OWN,
      entries: [
        { seq: 2, record: { type: 'post', text: PREVIEW.url, at: at(2), replyTo: null, ...extra } },
        { seq: 1, record: { type: 'post', text: 'before', at: at(1), replyTo: null } }
      ],
      entriesTruncated: 0
    }
  })
}

test('diario post previews survive building and strict parsing unchanged', async (t) => {
  const snap = await import('../src/screenSnapshot.js')
  for (const preview of [PREVIEW, { ...PREVIEW, image: null }, null]) {
    const built = snapshotWithPost(snap, { preview })
    t.alike(built.body.rows.map((r) => r.seq), [2, 1], 'the preview row is kept')
    t.alike(built.body.rows[0].record.preview, preview, 'the built preview is unchanged')
    const stored = snapshotWithPost(snap)
    stored.body.rows[0].record.preview = preview
    const parsed = snap.parseScreenSnapshot(JSON.stringify(stored), 'diario', SNAPSHOT_BINDING)
    t.ok(parsed, 'a stored preview parses')
    t.alike(parsed && parsed.body.rows[0].record.preview, preview, 'the parsed preview is unchanged')
  }
})

test('an invalid diario post preview is skipped on build and rejects the stored snapshot', async (t) => {
  const snap = await import('../src/screenSnapshot.js')
  for (const preview of [{ ...PREVIEW, extra: true }, { ...PREVIEW, url: 'not a URL' }]) {
    const built = snapshotWithPost(snap, { preview })
    t.alike(built.body.rows.map((r) => r.seq), [1], 'only the invalid row is skipped on build')
    const stored = snapshotWithPost(snap)
    stored.body.rows[0].record.preview = preview
    t.is(snap.parseScreenSnapshot(JSON.stringify(stored), 'diario', SNAPSHOT_BINDING), null, 'the whole stored snapshot is refused')
  }
})

test('diario post records refuse the card key', async (t) => {
  const snap = await import('../src/screenSnapshot.js')
  const built = snapshotWithPost(snap, { card: PREVIEW })
  t.alike(built.body.rows.map((r) => r.seq), [1], 'the card row is skipped on build')
  const stored = snapshotWithPost(snap)
  stored.body.rows[0].record.card = PREVIEW
  t.is(snap.parseScreenSnapshot(JSON.stringify(stored), 'diario', SNAPSHOT_BINDING), null, 'the card key fails strict parsing')
})

test('postOf passes the own post preview to the feed item', (t) => {
  t.ok(fnText(CODE, 'postOf').includes('preview: record.preview || null'))
})

const ARUA = withoutComments(fs.readFileSync(path.join(APP, 'src/screens/ARua.js'), 'utf8'))

function seededSeqsShown () {
  // eslint-disable-next-line no-new-func
  const rowsShown = new Function(fnText(ARUA, 'refOf') + '\n' + fnText(ARUA, 'snapshotRowsShown') + '\nreturn snapshotRowsShown')()
  // eslint-disable-next-line no-new-func
  return new Function('snapshotRowsShown', fnText(CODE, 'postOf') + '\n' + fnText(CODE, 'seededSeqsShown') + '\nreturn seededSeqsShown')(rowsShown)
}

function seededRows () {
  return [
    { seq: 9, entry: { seq: 9, record: { type: 'repost', to: { author: FOLLOW, seq: 2 }, on: true, at: at(9) } } },
    { seq: 8, entry: { seq: 8, record: { type: 'post', text: 'q', at: at(8), replyTo: null, quote: { author: FOLLOW, seq: 3 } } } },
    { seq: 7, entry: { seq: 7, record: { type: 'post', text: 'r', at: at(7), replyTo: { author: STRANGER, seq: 1 } } } },
    { seq: 6, entry: { seq: 6, record: { type: 'post', text: 'own', at: at(6), replyTo: null } } },
    { seq: 5, entry: { seq: 5, record: { type: 'repost', to: { author: OWN, seq: 6 }, on: true, at: at(5) } } }
  ]
}

test('stored rows under the block list: blocked reposts go, a failed list keeps only own content', (t) => {
  const shown = seededSeqsShown()
  const none = () => undefined
  t.alike([...shown(seededRows(), { keys: new Set(), loadState: 'pending' }, OWN, none)], [6, 5], 'nothing known yet: only own content, as in A Rua (#463)')
  t.alike([...shown(seededRows(), { keys: new Set([FOLLOW]), loadState: 'ok' }, OWN, none)], [8, 7, 6, 5], 'a blocked author\'s repost goes')
  t.alike([...shown(seededRows(), { keys: new Set(), loadState: 'failed' }, OWN, none)], [6, 5], 'failed list: only own rows naming no one else')
  t.ok(CODE.includes("import { CountsNote, RepostPlaceholder, SocialToast, liveBinding, refOf, snapshotRowsShown, socialRowProps, useRowPropsCache, useSocial } from './ARua'"), 'A Rua\'s rule, reused')
})

test('a row deleted in this session is never written back', (t) => {
  // eslint-disable-next-line no-new-func
  const holdsDeleted = new Function(fnText(CODE, 'holdsDeleted') + '\nreturn holdsDeleted')()
  const rows = seededRows()
  t.ok(holdsDeleted(rows, new Set([6])), 'a page read before the deletion still holds it')
  t.absent(holdsDeleted([{ seq: 6, invalid: { seq: 6, reason: 'deleted' } }], new Set([6])), 'a live page without it')
  t.ok(/if \(cur\.seeded \|\| holdsDeleted\(cur\.rows, deletedSeqsRef\.current\)\) \{\s+clearScreenSnapshot\('diario'\)\s+return/.test(writeSnapshot), 'cleared instead of saved')
  t.absent(/deletedSeqsRef\.current\.add\(row\.seq\)/.test(screen), 'an own repost of the deleted post is not marked (#539)')
  t.ok(/const deletedSeq = cur !== null \? ownDeletedSeq\(t\.ref, cur\.info\.publicKey\) : null\s*if \(deletedSeq !== null\) deletedSeqsRef\.current\.add\(deletedSeq\)/.test(screen), 'only the own post seq of the ref')
})

test('deleting an own post the page also reposts keeps the copy writable', (t) => {
  const ownDeletedSeq = helper('ownDeletedSeq')
  // eslint-disable-next-line no-new-func
  const holdsDeleted = new Function(fnText(CODE, 'holdsDeleted') + '\nreturn holdsDeleted')()
  t.is(ownDeletedSeq(OWN + ':6', OWN), 6)
  t.is(ownDeletedSeq(OWN.toUpperCase() + ':6', OWN), 6, 'any case')
  t.is(ownDeletedSeq(FOLLOW + ':6', OWN), null, 'not own')
  t.is(ownDeletedSeq(OWN + ':x', OWN), null)
  t.is(ownDeletedSeq(null, OWN), null)
  const deleted = new Set([ownDeletedSeq(OWN + ':6', OWN)])
  // The next live page: the post is a deleted slot, the own repost of it a live entry.
  const live = [
    { seq: 9, entry: { seq: 9, record: { type: 'repost', to: { author: OWN, seq: 6 }, on: true, at: at(9) } } },
    { seq: 6, invalid: { seq: 6, reason: 'deleted' } }
  ]
  t.absent(holdsDeleted(live, deleted), 'the live page can be written again')
  t.ok(holdsDeleted([{ seq: 6, entry: { seq: 6, record: { type: 'post', text: 'own', at: at(6), replyTo: null } } }], deleted), 'a page read before the deletion still cannot')
})

test('the block rule of the stored rows never hides live older rows', (t) => {
  const rowsShown = new Function(fnText(ARUA, 'refOf') + '\n' + fnText(ARUA, 'snapshotRowsShown') + '\nreturn snapshotRowsShown')() // eslint-disable-line no-new-func
  // eslint-disable-next-line no-new-func
  const hiddenStoredSeqs = new Function('snapshotRowsShown', fnText(CODE, 'postOf') + '\n' + fnText(CODE, 'seededSeqsShown') + '\n' + fnText(CODE, 'hiddenStoredSeqs') + '\nreturn hiddenStoredSeqs')(rowsShown)
  const none = () => undefined
  // The stored page, then an older live page appended after a failed first read.
  const rows = seededRows().concat([
    { seq: 4, entry: { seq: 4, record: { type: 'repost', to: { author: FOLLOW, seq: 1 }, on: true, at: at(4) } } },
    { seq: 3, entry: { seq: 3, record: { type: 'post', text: 'q', at: at(3), replyTo: null, quote: { author: STRANGER, seq: 2 } } } }
  ])
  const stored = new Set([9, 8, 7, 6, 5])
  t.alike([...hiddenStoredSeqs(rows, stored, { keys: new Set(), loadState: 'failed' }, OWN, none)].sort(), [7, 8, 9], 'only stored rows naming someone else')
  t.alike([...hiddenStoredSeqs(rows, stored, { keys: new Set([FOLLOW]), loadState: 'ok' }, OWN, none)], [9], 'a blocked author\'s stored repost; the live one is the node\'s')
  t.is(hiddenStoredSeqs(rows, new Set(), { keys: new Set(), loadState: 'failed' }, OWN, none).size, 0, 'no stored rows, nothing hidden')
  t.is(hiddenStoredSeqs(rows, undefined, { keys: new Set(), loadState: 'failed' }, OWN, none).size, 0)
  t.ok(/\.\.\.\(base\.seeded \? \{ seeded: true, stored: base\.stored \} : \{\}\)/.test(loadOlder), 'an older page keeps the stored seqs, not more')
})

test('stored rows go on another installation or association with the same key', (t) => {
  t.ok(/const seedBindingRef = useRef\(binding\)/.test(screen), 'the binding the boot read used')
  t.ok(/cur\.seeded && \(!sameSnapshotBinding\(seedBindingRef\.current, binding\) \|\| cur\.info\.publicKey !== binding\.owner\)/.test(screen), 'origin and association too, not only the owner')
  t.ok(CODE.includes("import { sameSnapshotBinding } from './Comunidades'"))
})

test('Diario rows come from the props cache through one stable renderItem', (t) => {
  const src = withoutComments(DIARIO)
  t.ok(/useRowPropsCache\(posts, rowKeyOf, \{ h: handlers, social \}\)/.test(src), 'row props cache')
  t.ok(/const renderItem = useCallback\(\(info\) => renderRef\.current\(info\), \[\]\)/.test(src), 'renderItem via ref, empty deps')
  t.ok(/renderRef\.current = \(/.test(src), 'ref holds the newest render')
  t.is((src.match(/socialRowProps\(\{[^}]*cache: rowCache, rowKey/g) || []).length, 2, 'both rows use the cache')
  t.absent(/const renderItem = \(\{ item: row \}\)/.test(src), 'no inline arrow renderItem')
  t.ok(/ownPostOf\(info\.publicKey, row\.seq, record\)/.test(src), 'own post object kept per record')
})

test('Diario own posts: one post object per record, so the row props are reused', async (t) => {
  const { cachedRow } = await import('../src/namesCache.js')
  const code = withoutComments(DIARIO)
  const body = (name) => fnText(code, name)
  /* eslint-disable no-new-func */
  const postOf = new Function(body('postOf').replace('function postOf', 'return function postOf'))()
  const ownPostOf = new Function('postOf', 'ownPosts', body('ownPostOf').replace('function ownPostOf', 'return function ownPostOf'))(postOf, new WeakMap())
  /* eslint-enable no-new-func */
  const record = { type: 'post', at: 1, text: 'oi' }
  const a = ownPostOf(OWN, 3, record)
  t.is(ownPostOf(OWN, 3, record), a, 'same record, same post')
  t.not(ownPostOf(OWN, 4, record), a, 'another seq is another post')
  const cache = new Map()
  const build = (live) => ({ live })
  const p1 = cachedRow(cache, 'e3', { post: ownPostOf(OWN, 3, record) }, {}, build)
  const p2 = cachedRow(cache, 'e3', { post: ownPostOf(OWN, 3, record) }, {}, build)
  t.is(p1, p2, 'two renders give the same props object')
})
