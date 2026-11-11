'use strict'

// Safety of A Rua's snapshot: stored rows fail closed when block.list fails,
// a deleted own post is never written back, follow.list is read whole before
// an unfollow prune, and an oversized stored text is never read whole.
// ARua.js, blocksProvider.js and App.js load react-native, so their helpers
// run here from their own source text and the wiring is checked on it; the
// stores run over the same kind of stubs as feedSnapshotStore.test.js.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { register } = require('node:module')

const APP = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The text of the top-level `[export] [async] function <name> (...) { ... }`.
function fnText (src, name) {
  const m = new RegExp('\\n(?:export )?((?:async )?function ' + name + ' \\()').exec(src)
  if (m === null) throw new Error('no function ' + name)
  const start = m.index + m[0].length - m[1].length
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error('unbalanced ' + name)
}

// `body` with `names` returned, run with no outer scope.
function run (body, names) {
  // eslint-disable-next-line no-new-func
  return new Function(body + '\nreturn { ' + names.join(', ') + ' }')()
}

const ARUA = withoutComments(read('src/screens/ARua.js'))
const BLOCKS = withoutComments(read('src/blocksProvider.js'))
const APP_JS = withoutComments(read('App.js'))
const member = fnText(ARUA, 'MemberARua')
const preview = fnText(ARUA, 'ARuaPreview')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const BLOCKED = 'cc'.repeat(32)

function post (author, seq, quote = null) {
  return { kind: 'post', author, seq, text: 't' + seq, replyTo: null, quote }
}
function repost (author, seq, to) {
  return { kind: 'repost', author, seq, to }
}

test('block load state: pending per epoch, ok on a whole read, failed on a refusal', (t) => {
  const { nextLoadState } = run(fnText(BLOCKS, 'nextLoadState'), ['nextLoadState'])
  t.is(nextLoadState('pending', 'failed'), 'failed')
  t.is(nextLoadState('failed', 'loaded'), 'ok', 'a later good read lifts the failure')
  t.is(nextLoadState('pending', 'loaded'), 'ok')
  t.is(nextLoadState('ok', 'failed'), 'ok', 'a good list of this epoch stands')
  t.is(nextLoadState('ok', 'epoch'), 'pending')
  t.is(nextLoadState('failed', 'epoch'), 'pending', 'a new epoch starts over')
  t.is(nextLoadState('ok', 'other'), 'ok')
})

test('block.list: only the latest reload of the epoch counts', (t) => {
  const { isLatestReload } = run(fnText(BLOCKS, 'isLatestReload'), ['isLatestReload'])
  t.ok(isLatestReload(3, 3, 1, 1))
  t.absent(isLatestReload(2, 3, 1, 1), 'an older reload answered late')
  t.absent(isLatestReload(3, 3, 1, 2), 'an answer from the previous epoch')
  const reload = BLOCKS.slice(BLOCKS.indexOf('const reload = useCallback'), BLOCKS.indexOf('const setBlock = useCallback'))
  t.ok(/const seq = \+\+reloadSeqRef\.current/.test(reload), 'each call takes a number')
  t.ok(/const current = \(\) => alive\(\) && isLatestReload\(seq, reloadSeqRef\.current, epoch, epochRef\.current\)/.test(reload))
  t.ok(/if \(current\(\)\) setLoadState\(\(s\) => nextLoadState\(s, 'failed'\)\)/.test(reload), 'a stale failure sets nothing')
  t.ok(/if \(!current\(\)\) return\s*commit\(/.test(reload), 'a stale answer never commits')
})

test('blocksProvider: the reload marks the state, the effect resets it per epoch', (t) => {
  const reload = BLOCKS.slice(BLOCKS.indexOf('const reload = useCallback'), BLOCKS.indexOf('const setBlock = useCallback'))
  t.ok(/catch \(err\) \{[\s\S]*nextLoadState\(s, 'failed'\)[\s\S]*throw err/.test(reload), 'a rejected block.list sets failed and still throws')
  t.ok(/commit\(blockedSetOf\(answer\)\)[\s\S]*nextLoadState\(s, 'loaded'\)/.test(reload), 'ok only after the whole list is committed')
  t.ok(/epochRef\.current\+\+\s*setLoadState\(\(s\) => nextLoadState\(s, 'epoch'\)\)\s*if \(!ready\) return/.test(BLOCKS), 'each epoch starts pending')
  const setBlock = BLOCKS.slice(BLOCKS.indexOf('const setBlock = useCallback'), BLOCKS.indexOf('const refresh = useCallback'))
  t.absent(setBlock.includes('setLoadState'), 'one key set here is not the list')
  t.ok(/loadState,\s*changed,/.test(BLOCKS), 'the context carries it')
})

test('snapshot rows: a failed block list leaves only the own rows', (t) => {
  const { snapshotRowsShown } = run(fnText(ARUA, 'refOf') + '\n' + fnText(ARUA, 'snapshotRowsShown'), ['snapshotRowsShown'])
  const quoting = post(OWN, 7, { author: BLOCKED, seq: 4 })
  const replying = { ...post(OWN, 8), replyTo: { author: BLOCKED, seq: 4 } }
  const quotingOwn = post(OWN, 9, { author: OWN, seq: 7 })
  const originals = new Map([[OWN + ':1', post(OWN, 1)], [OWN + ':7', quoting], [OWN + ':8', replying], [OWN + ':9', quotingOwn]])
  const originalOf = (ref) => originals.get(ref)
  const items = [
    post(FOLLOW, 5),
    post(BLOCKED, 4),
    repost(OWN, 3, { author: BLOCKED, seq: 4 }),
    repost(OWN, 2, { author: OWN, seq: 1 }),
    post(OWN, 6, { author: BLOCKED, seq: 4 }),
    repost(OWN, 10, { author: OWN, seq: 7 }),
    repost(OWN, 11, { author: OWN, seq: 8 }),
    repost(OWN, 12, { author: OWN, seq: 9 }),
    replying,
    quotingOwn,
    repost(OWN, 13, { author: OWN, seq: 99 }),
    post(OWN, 1)
  ]
  const keys = (rows) => rows.map((i) => i.author.slice(0, 2) + i.seq)
  t.alike(keys(snapshotRowsShown(items, new Set(), 'failed', OWN.toUpperCase(), originalOf)), ['aa2', 'aa13', 'aa1'], 'own rows only, none showing anyone else')
  t.alike(snapshotRowsShown(items, new Set(), 'failed', null, originalOf), [], 'no owner, nothing')
  t.is(snapshotRowsShown(items, new Set(), 'pending', OWN), items, 'before the answer: as stored (product decision)')
  t.is(snapshotRowsShown(items, new Set(), 'ok', OWN), items)
  t.alike(keys(snapshotRowsShown(items.slice(0, 5).concat(post(OWN, 1)), new Set([BLOCKED]), 'ok', OWN)), ['bb5', 'aa2', 'aa6', 'aa1'], 'a known list drops the blocked author and reposts of them')
})

test('A Rua and its preview filter stored rows by the load state', (t) => {
  t.ok(/loadedAt !== null\s*\? items\s*: snapshotRowsShown\(items, blockedKeys, blockLoad, ownKey, \(ref\) => shownOriginals\.get\(ref\)\)/.test(member), 'A Rua: snapshot rows only through the helper')
  t.ok(member.includes('const shownOriginals = social.social.originals'))
  t.ok(member.includes('const blockLoad = blocks.loadState'))
  t.ok(/snapshotRowsShown\(view\.items, blockedKeys, blockLoad, ownKey, view\.original\)/.test(preview), 'the preview, still on screen once the node is up')
  t.ok(preview.includes('const blockLoad = blocks.loadState'))
})

test('a delete: no snapshot write until a first page read started after it', (t) => {
  let bumps = 0
  globalThis.__bump = () => { bumps++ }
  t.teardown(() => { delete globalThis.__bump })
  const mod = run('let deletionCount = 0\nconst bumpCacheGeneration = () => globalThis.__bump()\n' + fnText(ARUA, 'noteDeleted') + '\n' + fnText(ARUA, 'snapshotWriteAllowed') + '\nconst count = () => deletionCount', ['noteDeleted', 'snapshotWriteAllowed', 'count'])
  const mark = mod.count()
  t.ok(mod.snapshotWriteAllowed(mark, mod.count()))
  mod.noteDeleted()
  t.is(bumps, 1, 'an armed write is dropped')
  t.absent(mod.snapshotWriteAllowed(mark, mod.count()), 'the page read before the delete may hold the post')
  t.ok(mod.snapshotWriteAllowed(mod.count(), mod.count()), 'a read started after it may write')
  t.absent(mod.snapshotWriteAllowed(null, 0), 'no first page read yet')
  t.absent(mod.snapshotWriteAllowed(undefined, 0))
})

test('the delete wiring: App.js marks it, A Rua checks before writing and arming', (t) => {
  const handler = APP_JS.slice(APP_JS.indexOf('const deletedPost = useCallback'))
  const body = handler.slice(0, handler.indexOf('}, [])'))
  t.ok(/noteDeleted\(\)\s*clearSnapshot\(\)/.test(body), 'deletedPost notes it and clears the file')
  t.ok(/import \{[^}]*\bbumpCacheGeneration\b[^}]*\} from '\.\.\/localCaches'/.test(ARUA), 'noteDeleted bumps the generation')
  t.ok(/import ARua, \{[^}]*\bnoteDeleted\b[^}]*\} from '\.\/src\/screens\/ARua'/.test(APP_JS))
  t.ok(/const loadMark = deletionCount\s*try \{\s*const page = await request\('feed\.read'/.test(member), 'the mark is taken before the read')
  t.ok(/newer: 0,\s*loadMark,\s*loading: false/.test(member), 'and committed with the page')
  const write = member.slice(member.indexOf('const writeSnapshot = useCallback'), member.indexOf('writeSnapshotRef.current = writeSnapshot'))
  const refuse = write.indexOf('snapshotWriteAllowed(latest.feed.loadMark, deletionCount)')
  t.ok(refuse > 0 && refuse < write.indexOf('pending.gen !== cacheGeneration()'), 'refused before the generation re-arm')
  t.ok(/snapshotWriteAllowed\(latest\.feed\.loadMark, deletionCount\)\) \{\s*pendingWriteRef\.current = null\s*return\s*\}/.test(write), 'refused without re-arming')
  t.ok(/w\.done === snapKey\) return\s*if \(!snapshotWriteAllowed\(feed\.loadMark, deletionCount\)\) return/.test(member), 'the effect does not arm either')
})

test('follow.list is paged to its total before it counts as whole', async (t) => {
  const { readAllFollows } = run(fnText(ARUA, 'readAllFollows'), ['readAllFollows'])
  const all = Array.from({ length: 1203 }, (_, i) => i.toString(16).padStart(64, '0').toUpperCase())
  const asked = []
  const request = (method, params) => {
    asked.push(method + ' ' + params.offset + '/' + params.limit)
    return Promise.resolve({ follows: all.slice(params.offset, params.offset + params.limit), total: all.length })
  }
  const still = () => 4
  const seen = []
  const r = await readAllFollows(request, (k) => seen.push(k), 500, 50, still)
  t.is(r.complete, true)
  t.is(r.keys.length, 1203)
  t.is(r.keys[1202], all[1202].toLowerCase())
  t.is(seen.length, 1203)
  t.alike(asked, ['follow.list 0/500', 'follow.list 500/500', 'follow.list 1000/500'])

  asked.length = 0
  const capped = await readAllFollows(request, () => {}, 500, 2, still)
  t.is(capped.complete, false, 'the page cap leaves it partial')
  t.is(asked.length, 2)

  let n = 0
  const moving = (method, params) => Promise.resolve({ follows: all.slice(params.offset, params.offset + params.limit), total: all.length + (n++) })
  t.is((await readAllFollows(moving, () => {}, 500, 50, still)).complete, false, 'a total that moved while paging')

  let v = 0
  const folding = (method, params) => { v++; return request(method, params) }
  t.is((await readAllFollows(folding, () => {}, 500, 50, () => v)).complete, false, 'the follows changed between pages, same total')

  const short = () => Promise.resolve({ follows: [], total: 3 })
  t.is((await readAllFollows(short, () => {}, 500, 50, still)).complete, false, 'an empty page before the total')

  const odd = () => Promise.resolve({ follows: [OWN, 7], total: 2 })
  t.is((await readAllFollows(odd, () => {}, 500, 50, still)).complete, false, 'a non-key entry')

  const none = () => Promise.resolve({ follows: [], total: 0 })
  t.alike(await readAllFollows(none, () => {}, 500, 50, still), { keys: [], complete: true })

  await t.exception(readAllFollows(() => Promise.reject(new Error('down')), () => {}, 500, 50, still))
})

test('loadFollows reads every page and prunes only on a whole list', (t) => {
  const load = ARUA.slice(ARUA.indexOf('const loadFollows = useCallback'))
  const body = load.slice(0, load.indexOf('}, [request])'))
  t.ok(/readAllFollows\(request, \(k\) => set\.add\(k\), FOLLOW_LIMIT_MAX, FOLLOW_PAGES_MAX, \(\) => followsVersionRef\.current\)/.test(body), 'checked against the node follows version')
  t.ok(/followsVersionRef\.current = typeof node\.followsVersion === 'number' \? node\.followsVersion : 0/.test(ARUA))
  t.ok(/if \(!complete && set === knownRef\.current\) followsLoadedRef\.current = false/.test(body), 'a partial list is read again on the next need')
  t.ok(/if \(complete && set === knownRef\.current/.test(body), 'the known-set reset guard stays')
  t.ok(/export const FOLLOW_PAGES_MAX = 50\b/.test(ARUA))
})

test('the stores cap equals the snapshot cap', async (t) => {
  const { SNAPSHOT_MAX_BYTES } = await import('../src/feedSnapshot.js')
  for (const p of ['src/feedSnapshotStore.native.js', 'src/feedSnapshotStore.web.js']) {
    const m = /const MAX_BYTES = (\d+)/.exec(read(p))
    t.ok(m !== null, p)
    t.is(Number(m[1]), SNAPSHOT_MAX_BYTES, p)
  }
})

const hooks = `
const SRC = 'export const Paths = { document: { uri: "file:///stub/Documents/" }, cache: { uri: "file:///stub/Caches/" } }\\n' +
  'export class File {\\n' +
  '  constructor (dir, name) { this.uri = dir.uri + name }\\n' +
  '  get exists () { return globalThis.__files.has(this.uri) }\\n' +
  '  get size () { if (globalThis.__size) return globalThis.__size(this.uri); return globalThis.__files.has(this.uri) ? globalThis.__files.get(this.uri).length : 0 }\\n' +
  '  create () { globalThis.__files.set(this.uri, "") }\\n' +
  '  write (text) { globalThis.__files.set(this.uri, text) }\\n' +
  '  textSync () { globalThis.__reads++; return globalThis.__files.get(this.uri) }\\n' +
  '  delete () { globalThis.__files.delete(this.uri) }\\n' +
  '  move (dest) { globalThis.__files.set(dest.uri, globalThis.__files.get(this.uri)); globalThis.__files.delete(this.uri); this.uri = dest.uri }\\n' +
  '}\\n'
export async function resolve (specifier, context, next) {
  if (specifier === 'expo-file-system') return { url: 'data:text/javascript,' + encodeURIComponent(SRC), shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

const PATH = 'file:///stub/Caches/varanda-rua-snapshot.json'
const CAP = 524288

function files (t, entries) {
  globalThis.__files = new Map(entries)
  globalThis.__reads = 0
  delete globalThis.__size
  t.teardown(() => {
    delete globalThis.__files
    delete globalThis.__reads
    delete globalThis.__size
  })
}

test('native: an oversized snapshot file is not read and goes with its .bak and .tmp', async (t) => {
  const { loadSnapshotText } = await import('../src/feedSnapshotStore.native.js')
  files(t, [[PATH, 'x'.repeat(CAP + 1)], [PATH + '.bak', '{}'], [PATH + '.tmp', '{}']])
  t.is(loadSnapshotText(), null)
  t.is(globalThis.__reads, 0, 'never read whole')
  t.is(globalThis.__files.size, 0, 'file, .bak and .tmp removed')

  files(t, [[PATH + '.bak', 'y'.repeat(CAP + 1)]])
  t.is(loadSnapshotText(), null, 'the .bak fallback is capped too')
  t.is(globalThis.__files.size, 0)

  files(t, [[PATH, '{"v":1}'], [PATH + '.bak', '{}']])
  globalThis.__size = () => { throw new Error('stat failed') }
  t.is(loadSnapshotText(), null, 'a size that cannot be read')
  t.is(globalThis.__files.size, 0)

  files(t, [[PATH, '{"v":1}']])
  globalThis.__size = () => NaN
  t.is(loadSnapshotText(), null)
  t.is(globalThis.__files.size, 0)

  files(t, [[PATH, 'z'.repeat(CAP)]])
  t.is(loadSnapshotText().length, CAP, 'at the cap it reads')
  t.is(globalThis.__reads, 1)
})

test('web: an oversized snapshot text is removed', async (t) => {
  const { loadSnapshotText } = await import('../src/feedSnapshotStore.web.js')
  const map = new Map([['varanda-rua-snapshot', 'x'.repeat(CAP + 1)]])
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k)
  }
  t.teardown(() => { if (!had) delete globalThis.localStorage })
  t.is(loadSnapshotText(), null)
  t.is(map.size, 0)
  map.set('varanda-rua-snapshot', '{"v":1}')
  t.is(loadSnapshotText(), '{"v":1}')
})
