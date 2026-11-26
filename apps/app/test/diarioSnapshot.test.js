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
  const arms = screen.split('armSnapshot(').length - 1
  t.is(arms, 2, 'armed in two places')
  const setAt = loadNewest.indexOf('setData(next)')
  const armAt = loadNewest.indexOf('armSnapshot(gen)')
  t.ok(setAt > 0 && armAt > setAt, 'loadNewest arms after the live setData')
  t.ok(/if \(deletions === deletionsRef\.current && cacheGeneration\(\) === gen\) armSnapshot\(gen\)/.test(loadNewest), 'only when no deletion or invalidation intervened')
  t.ok(/deletionsRef\.current\+\+\s+armSnapshot\(cacheGeneration\(\)\)/.test(screen), 'a deletion arms it again')
  t.absent(loadOlder.includes('armSnapshot'), 'an older page does not')
  t.is(CODE.split('saveScreenSnapshot(').length - 1, 1, 'one save call')
  t.ok(writeSnapshot.includes("saveScreenSnapshot('diario', snapshot, gen)"), 'in writeSnapshot')
  t.ok(/const live = liveRef\.current/.test(writeSnapshot), 'the snapshot comes from the live page')
  t.ok(/seeded: dataRef\.current\?\.seeded === true/.test(writeSnapshot), 'stored rows only allow a clear before any live read')
  t.ok(writeSnapshot.includes('log: diarioLogOf(live, l.binding.owner)'))
  t.ok(writeSnapshot.includes('sameSnapshotBinding(live.binding, l.binding)'), 'only in the binding the page was read under')
  t.ok(writeSnapshot.includes('sessionAllowsDiarioSnapshot(l.passkey, l.binding.owner)'), 'only for the unlocked owner')
  t.ok(writeSnapshot.includes('actingAsMember(l.acting)'), 'only as the member')
  t.ok(/SNAPSHOT_DEBOUNCE_MS = 2000/.test(CODE) && armSnapshot.includes('setTimeout(() => writeSnapshot(gen), SNAPSHOT_DEBOUNCE_MS)'), 'debounced 2 s')
})

test('the newest read captures the generation before log.read and passes it to the save', (t) => {
  t.ok(/import \{ cacheGeneration \} from '\.\.\/localCaches'/.test(CODE))
  t.ok(/const gen = cacheGeneration\(\)\s+const log = await request\('log.read'/.test(loadNewest), 'read in the tick that starts the log request')
  t.absent(armSnapshot.includes('cacheGeneration()'), 'arming forwards the same generation')
  t.absent(writeSnapshot.includes('armSnapshot('), 'a refused save is not retried')
  t.ok(/current: live !== null && gen === cacheGeneration\(\) && live\.gen === gen/.test(writeSnapshot), 'the generation gates only the save')
  t.absent(/\) return\s/.test(writeSnapshot.slice(writeSnapshot.indexOf('if (l.binding === null) return') + 30, writeSnapshot.indexOf('diarioSnapshotAction('))), 'no session or generation return before the clears')
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
  const kept = fnText(CODE, 'storedRowsKept')
  t.ok(/if \(data\.seeded !== true\) return data\.rows/.test(kept), 'stored rows only')
  t.ok(/hiddenStoredSeqs\(data\.rows, data\.stored, blocks, data\.info\.publicKey, originalOf\)/.test(kept))
  t.ok(/return storedRowsKept\(data, blocks, \(ref\) => originals\.get\(ref\)\)\s*\}, \[data, blocks, social\.social\.originals\]\)/.test(screen), 'recomputed when the list changes')
  t.ok(writeSnapshot.includes('blocked: l.blocked') && writeSnapshot.includes('followed: l.persistOf'), 'the build drops blocked and unfollowed originals')
})

test('only the first live read settles a seeded page and refresh can replace it', (t) => {
  t.ok(screen.includes('const liveRef = useRef(null)'))
  t.ok(CODE.includes('const keyOf = (row) => String(row.seq)'))
  t.ok(CODE.includes('const compare = (a, b) => a.seq - b.seq'))
  t.ok(loadNewest.includes('!replace && dataRef.current?.seeded === true && liveRef.current === null'))
  t.ok(/const live = \{ info, rows, atEnd, oldest: oldestSeq\(rows\) \}/.test(loadNewest))
  t.ok(/liveRef\.current = \{ \.\.\.live, gen, binding: readBinding \}/.test(loadNewest))
  t.ok(/let next = live[\s\S]+const settled = seeded === null \? null : firstLivePage\(seeded, live\)/.test(loadNewest))
  t.ok(fnText(CODE, 'firstLivePage').includes("settleSeeded({ seeded: seeded.rows, live: live.rows, last: live.atEnd, complete: true, tail: 'keep', keyOf, compare })"))
  t.ok(/const reload = \(\) => \{[\s\S]+?loadNewest\(true, true\)/.test(screen), 'refresh requests replacement')
})

test('the first live page holds posts and reposts and inserts technical records quietly', (t) => {
  const first = fnText(CODE, 'firstLivePage')
  t.ok(/const held = r\.held\.some\(\(row\) => isPostRow\(row\) \|\| isRepostRow\(row\)\)/.test(first))
  t.ok(/rows: held \? r\.items : r\.items\.concat\(r\.held\)\.sort\(\(a, b\) => compare\(b, a\)\)/.test(first))
  t.ok(/atEnd: live\.atEnd && r\.unverified\.length === 0/.test(first))
  t.ok(/oldest: live\.oldest \?\? seeded\.oldest/.test(first), 'cursor from the live page, also when it is held')
  t.ok(/seeded: r\.unverified\.length > 0,\s+stored: new Set\(r\.unverified\.map\(Number\)\)/.test(first), 'only unverified seqs stay stored')
  t.ok(/let held = false[\s\S]+setHeldNew\(held\)/.test(loadNewest), 'a replacement clears heldNew')
  t.ok(/newItems=\{\{[^}]+visible: ownGrew \|\| heldNew,\s+onPress: reload/.test(screen), 'either source shows the pill and its press reloads')
})

test('the reset ingest asks for kept rows and re-reads unverified own text', (t) => {
  t.ok(/ingest\(\{ \.\.\.rowNeeds\(next\.rows, info\.publicKey, next\.stored\), reset: true \}\)/.test(loadNewest), 'the whole kept list, with the unverified seqs')
  t.absent(/rowNeeds\(rows,/.test(loadNewest), 'not the live page alone')
  const needs = fnText(CODE, 'rowNeeds')
  const branch = needs.indexOf('unverified instanceof Set && unverified.has(row.seq)')
  const trusted = needs.indexOf('local.set(ref, postOf(publicKey, row.seq, record))')
  t.ok(branch > 0 && trusted > branch, 'a cached row is not stored as an original')
  t.ok(/need\.push\(ref\)/.test(needs.slice(branch, trusted)), 'it is asked for through the original read')
  t.ok(/shown\.push\(ref\)/.test(needs.slice(0, branch)), 'its counts are still asked for')
})

test('older pages settle stored rows only in the requested span', (t) => {
  t.ok(/const before = current\.oldest \?\? oldestSeq\(current\.rows\)/.test(loadOlder))
  t.ok(/request\('log.read', \{ limit: LOG_LIMIT_MAX, before \}\)/.test(loadOlder))
  t.ok(/const \{ page, data: next \} = olderPageData\(current, log, before\)/.test(loadOlder))
  const older = fnText(CODE, 'olderPageData')
  t.ok(/const page = logRows\(log\)/.test(older))
  t.ok(/const end = isLastLogPage\(log\)/.test(older))
  t.ok(/settleSpan\(\{\s+items: mergeOlderRows\(current\.rows, log\),\s+unverified: Array\.from\(current\.stored \?\? \[\], String\),\s+page,\s+complete: true,\s+from: \{ seq: before \},\s+end,\s+keyOf,\s+compare/.test(older))
  t.ok(/oldest: oldestSeq\(page\) \?\? before,\s+seeded: unverified\.length > 0,\s+stored: new Set\(unverified\.map\(Number\)\),\s+held: current\.held \?\? null/.test(older), 'page cursor, remaining unverified seqs, held rows kept')
})

const keyOf = (row) => String(row.seq)
const compare = (a, b) => a.seq - b.seq

test('a full newer page of the own log holds every new row and keeps the painted page', async (t) => {
  const { LOG_LIMIT_MAX } = require('@varanda/rpc')
  const { settleSeeded } = await import('../src/paging.js')
  const seeded = seededRows()
  const live = Array.from({ length: LOG_LIMIT_MAX }, (_, i) => ({ seq: 10 + LOG_LIMIT_MAX - 1 - i, entry: { record: { type: 'post' } } }))
  const r = settleSeeded({ seeded, live, last: false, complete: true, tail: 'keep', keyOf, compare })
  t.is(r.replace, false)
  t.alike(r.items, seeded)
  t.alike(r.held, live)
  t.alike(r.unverified, seeded.map(keyOf))
})

test('a partly overlapping own log page verifies its matching rows and keeps the older tail', async (t) => {
  const { settleSeeded, mergeOlderRows, logRows, settleSpan } = await import('../src/paging.js')
  const seeded = seededRows()
  const newer = { seq: 10, entry: { record: { type: 'like' } } }
  const liveRow = { seq: 9, entry: { record: { type: 'repost' } } }
  const deleted = { seq: 8, invalid: { seq: 8, reason: 'deleted' } }
  const r = settleSeeded({ seeded, live: [newer, liveRow, deleted], last: false, complete: true, tail: 'keep', keyOf, compare })
  t.is(r.replace, false)
  t.alike(r.held, [newer])
  t.alike(r.items, [liveRow, deleted, ...seeded.slice(2)])
  t.alike(r.unverified, ['7', '6', '5'])

  const log = { entries: [seeded[2].entry], invalid: [{ seq: 6, reason: 'deleted' }] }
  const items = mergeOlderRows(r.items, log)
  const verified = settleSpan({ items, unverified: r.unverified, page: logRows(log), complete: true, from: { seq: 8 }, end: true, keyOf, compare })
  t.alike(verified.unverified, [])
  t.alike(verified.dropped, ['5'])
  t.alike(verified.items.map(keyOf), ['9', '8', '7', '6'])
  t.is(verified.items[3].invalid.reason, 'deleted', 'the live invalid slot replaces the cached post')
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
  t.ok(/holdsDeleted: live !== null && holdsDeleted\(live\.rows, deletedSeqsRef\.current\)/.test(writeSnapshot), 'cleared instead of saved')
  t.ok(/if \(action === 'clear'\) \{\s+clearScreenSnapshot\('diario'\)\s+return/.test(writeSnapshot))
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

// A module-level `const <name> = ...` line of Diario.js.
function constLine (name) {
  const m = CODE.match(new RegExp('\\nconst ' + name + ' = [^\\n]+'))
  if (!m) throw new Error('no const ' + name)
  return m[0]
}

const ROW_CONSTS = ['keyOf', 'compare', 'isPostRow', 'isRepostRow'].map(constLine).join('\n')

async function pagingHelper (name, deps) {
  const paging = await import('../src/paging.js')
  // eslint-disable-next-line no-new-func
  return new Function(...deps, ROW_CONSTS + '\n' + fnText(CODE, name) + '\nreturn ' + name)(...deps.map((d) => paging[d]))
}

function logOf (rows, end) {
  return {
    entries: rows.filter((r) => r.entry).map((r) => r.entry),
    invalid: rows.filter((r) => r.invalid).map((r) => r.invalid),
    entriesTruncated: end ? 0 : 1
  }
}

function postRow (seq) {
  return { seq, entry: { seq, record: { type: 'post', text: 'p' + seq, at: at(seq), replyTo: null } } }
}

test('held new posts: the older read starts at the live page, verifies painted rows and fills the gap', async (t) => {
  const { LOG_LIMIT_MAX } = require('@varanda/rpc')
  const firstLivePage = await pagingHelper('firstLivePage', ['settleSeeded'])
  const olderPageData = await pagingHelper('olderPageData', ['logRows', 'mergeOlderRows', 'isLastLogPage', 'settleSpan', 'oldestSeq'])
  const painted = seededRows()
  const seeded = { info: { publicKey: OWN }, rows: painted, atEnd: false, oldest: 5, seeded: true, stored: new Set([9, 8, 7, 6, 5]) }
  // More than a page of new blocks: the live page does not reach the painted rows.
  const liveRows = Array.from({ length: LOG_LIMIT_MAX }, (_, i) => postRow(50 + LOG_LIMIT_MAX - 1 - i))
  const live = { info: { publicKey: OWN }, rows: liveRows, atEnd: false, oldest: 50 }
  const { next, held } = firstLivePage(seeded, live)
  t.is(held, true, 'new posts wait behind the pill')
  t.alike(next.rows.map((r) => r.seq), [9, 8, 7, 6, 5], 'the painted rows stay')
  t.is(next.oldest, 50, 'the next older read starts at the live page, above every unverified row')
  t.is(next.atEnd, false)
  t.alike(next.held.map((r) => r.seq), liveRows.map((r) => r.seq), 'the held rows are kept')

  // The older read before 50: a gap post (20), the painted post 8 deleted
  // meanwhile, the others still there, and more below.
  const pageRows = [postRow(20), painted[0], { seq: 8, invalid: { seq: 8, reason: 'deleted' } }, painted[2], painted[3], painted[4]]
  const { data } = olderPageData(next, logOf(pageRows, false), next.oldest)
  t.alike(data.rows.map((r) => r.seq), [20, 9, 8, 7, 6, 5], 'the gap row merges in place')
  t.ok(data.rows[2].invalid, 'the deleted painted post is the live invalid slot')
  t.is(data.seeded, false, 'every painted row is verified')
  t.is(data.stored.size, 0)
  t.is(data.atEnd, false)
  t.is(data.oldest, 5)
  t.is(data.held, next.held, 'the held rows survive an older page')
})

test('an older page that leaves unverified rows never ends the list unless it is the last', async (t) => {
  const olderPageData = await pagingHelper('olderPageData', ['logRows', 'mergeOlderRows', 'isLastLogPage', 'settleSpan', 'oldestSeq'])
  const current = { info: { publicKey: OWN }, rows: seededRows(), atEnd: false, oldest: 10, seeded: true, stored: new Set([9, 8, 7, 6, 5]), held: null }
  const partial = olderPageData(current, logOf([seededRows()[0], seededRows()[1]], false), 10)
  t.alike([...partial.data.stored].sort(), [5, 6, 7], 'rows below the page stay unverified')
  t.is(partial.data.atEnd, false)
  const last = olderPageData(current, logOf([seededRows()[0]], true), 10)
  t.is(last.data.stored.size, 0, 'the end of the log settles the rest')
  t.is(last.data.atEnd, true)
})

test('a held newer repost turned off hides the older repost of the same post', async (t) => {
  // eslint-disable-next-line no-new-func
  const liveReposts = new Function(fnText(ARUA, 'refOf') + '\n' + ROW_CONSTS + '\n' + fnText(CODE, 'liveReposts') + '\nreturn liveReposts')()
  const firstLivePage = await pagingHelper('firstLivePage', ['settleSeeded'])
  const painted = seededRows()
  const seeded = { info: { publicKey: OWN }, rows: painted, atEnd: false, oldest: 5, seeded: true, stored: new Set([9, 8, 7, 6, 5]) }
  const off = { seq: 11, entry: { seq: 11, record: { type: 'repost', to: { author: FOLLOW, seq: 2 }, on: false, at: at(11) } } }
  const { next, held } = firstLivePage(seeded, { info: { publicKey: OWN }, rows: [off, ...painted], atEnd: false, oldest: 5 })
  t.is(held, true)
  t.absent(next.rows.some((r) => r.seq === 11), 'the newer record is held')
  t.absent(liveReposts(next.rows, next.held).has(9), 'the older on record no longer shows')
  t.ok(liveReposts(next.rows, null).has(9), 'without held rows it would')
  t.ok(/const live = liveReposts\(data\.rows, data\.held\)/.test(screen), 'the list passes the held rows')
})

test('a deletion clears the stored copy when its save is refused or the session locked', (t) => {
  const action = helper('diarioSnapshotAction')
  const base = { live: true, seeded: false, holdsDeleted: false, deletionPending: false, allowed: true, current: true }
  t.is(action(base), 'save')
  t.is(action({ ...base, current: false }), null, 'a refused save without a deletion does nothing')
  t.is(action({ ...base, current: false, deletionPending: true }), 'clear', 'a generation bump after a deletion clears')
  t.is(action({ ...base, allowed: false, deletionPending: true }), 'clear', 'a locked session after a deletion clears')
  t.is(action({ ...base, allowed: false }), null, 'a locked session alone does nothing')
  t.is(action({ ...base, holdsDeleted: true, allowed: false, current: false }), 'clear', 'a page holding a deleted row clears whatever the session')
  t.is(action({ ...base, live: false, seeded: true, allowed: false }), 'clear', 'a deletion over stored rows clears before any check')
  t.is(action({ ...base, live: false }), null)
  t.ok(/deletionPending: deletions !== writtenDeletionsRef\.current/.test(writeSnapshot), 'pending since the last save or clear')
  t.ok(/if \(action === null\) return\s+writtenDeletionsRef\.current = deletions/.test(writeSnapshot), 'a save or a clear covers the deletions so far')
  const sessionAt = writeSnapshot.indexOf('sessionAllowsDiarioSnapshot(')
  t.ok(sessionAt > writeSnapshot.indexOf('diarioSnapshotAction('), 'the session check only feeds the decision')
})

test('a stored own post the originals lookup finds deleted leaves the list, a pending or failed one stays', (t) => {
  // eslint-disable-next-line no-new-func
  const deletedStoredSeqs = new Function(ROW_CONSTS + '\n' + fnText(CODE, 'deletedStoredSeqs') + '\nreturn deletedStoredSeqs')()
  const rows = seededRows()
  const stored = new Set([9, 8, 7, 6, 5])
  const transient = Object.freeze({ transient: true })
  const looked = new Map([[OWN + ':8', null], [OWN + ':7', transient], [OWN + ':9', null]])
  const originalOf = (ref) => looked.get(ref)
  t.alike([...deletedStoredSeqs(rows, stored, OWN, originalOf)], [8], 'only the confirmed deleted own post goes; seq 6 is still pending')
  t.alike([...deletedStoredSeqs(rows, new Set([7, 6]), OWN, originalOf)], [], 'a verified row is never dropped by the lookup')
  const shown = screen.slice(screen.indexOf('const shownRows = useMemo('), screen.indexOf('const info = data === null'))
  t.ok(/deletedStoredSeqs\(data\.rows, data\.stored, data\.info\.publicKey, originalOf\)/.test(fnText(CODE, 'storedRowsKept')), 'the list asks only while rows are unverified')
  t.ok(/return keptRows\.filter\(/.test(shown), 'the deleted rows leave the shown list')
})

function storedRowsKeptHelper () {
  // eslint-disable-next-line no-new-func
  return new Function('snapshotRowsShown', ROW_CONSTS + '\n' + fnText(CODE, 'postOf') + '\n' + fnText(CODE, 'seededSeqsShown') + '\n' + fnText(CODE, 'hiddenStoredSeqs') + '\n' + fnText(CODE, 'deletedStoredSeqs') + '\n' + fnText(CODE, 'storedRowsKept') + '\nreturn storedRowsKept')(
    // eslint-disable-next-line no-new-func
    new Function(fnText(ARUA, 'refOf') + '\n' + fnText(ARUA, 'snapshotRowsShown') + '\nreturn snapshotRowsShown')())
}

function photoRow (seq) {
  return { seq, entry: { seq, record: { type: 'post', text: 'f' + seq, at: at(seq), replyTo: null, media: [{ type: 'image', sha256: String(seq % 10).repeat(64), mime: 'image/jpeg', width: 10, height: 10, bytes: 10 }] } } }
}

test('the Mural reads the same filtered rows as the list: a deleted cached photo leaves it', async (t) => {
  const { tilesFromLog } = await import('../src/mural.js')
  const storedRowsKept = storedRowsKeptHelper()
  const data = { seeded: true, rows: [photoRow(9), photoRow(8), photoRow(7)], stored: new Set([9, 8, 7]), info: { publicKey: OWN } }
  const blocks = { keys: new Set(), loadState: 'ok' }
  const looked = new Map([[OWN + ':8', null]])
  const rows = storedRowsKept(data, blocks, (ref) => looked.get(ref))
  t.alike(rows.map((r) => r.seq), [9, 7], 'the confirmed deleted stored post goes')
  t.alike(tilesFromLog(OWN, rows).map((tile) => tile.seq), [9, 7], 'and its photo leaves the Mural')
  t.is(storedRowsKept({ ...data, seeded: false }, blocks, (ref) => looked.get(ref)), data.rows, 'live rows are the node\'s')
  const tiles = screen.slice(screen.indexOf('const muralTiles = useMemo('), screen.indexOf('const muralFill'))
  t.ok(tiles.includes('tilesFromLog(publicKey, keptRows)') && !tiles.includes('data.rows'), 'the Mural source is the filtered rows')
})

test('a timed out or closed originals read keeps the cached Diário row; a confirmed deletion drops it', (t) => {
  const storedRowsKept = storedRowsKeptHelper()
  // eslint-disable-next-line no-new-func
  const isReadTransient = new Function('isSeederDown', 'isBusy', fnText(ARUA, 'isReadTransient') + '\nreturn isReadTransient')(() => false, () => false)
  const transient = Object.freeze({ transient: true })
  // What useSocial.resolve stores per ref: a transient failure is TRANSIENT,
  // a peek that answered without the post is null.
  const stored = (err) => (isReadTransient(err) ? transient : null)
  const data = { seeded: true, rows: [postRow(9), postRow(8), postRow(7)], stored: new Set([9, 8, 7]), info: { publicKey: OWN } }
  const blocks = { keys: new Set(), loadState: 'ok' }
  const looked = new Map([
    [OWN + ':9', stored(Object.assign(new Error('tempo esgotado'), { code: 'TIMEOUT' }))],
    [OWN + ':8', stored(Object.assign(new Error('sem conexão com o nó'), { code: 'CLOSED' }))],
    [OWN + ':7', null]
  ])
  t.alike(storedRowsKept(data, blocks, (ref) => looked.get(ref)).map((r) => r.seq), [9, 8], 'only the confirmed deleted row goes')
  const readAuthor = ARUA.slice(ARUA.indexOf('const readAuthor = useCallback('), ARUA.indexOf('const dropNameRetries'))
  t.ok(/if \(isReadTransient\(failure\)\)/.test(readAuthor), 'a failed peek routes through isReadTransient')
  t.ok(/catch \{\s*for \(const seq of g\.seqs\) transient\.add\(/.test(readAuthor), 'a failed fallback log.read is transient')
  t.ok(/groups\.slice\(FALLBACK_WINDOWS\)\) for \(const seq of g\.seqs\) transient\.add\(/.test(readAuthor), 'seqs beyond the fallback windows are transient')
  const resolve = ARUA.slice(ARUA.indexOf('const resolve = useCallback('), ARUA.indexOf('resolveRef.current = resolve'))
  t.ok(/got = new Map\(\)\s*got\.transient = new Set\(refs\)/.test(resolve), 'a thrown read leaves every ref transient')
})
