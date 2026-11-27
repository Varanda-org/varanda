'use strict'

// A Rua paints its stored snapshot (src/feedSnapshot.js) on a cold start and
// writes it again after each fresh first page. ARua.js and App.js load
// react-native, so the wiring is checked on their text; the module-level
// helpers of ARua.js run here on their own source, with the store stubbed.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const ARUA = fs.readFileSync(path.join(APP, 'src/screens/ARua.js'), 'utf8')
const APP_JS = fs.readFileSync(path.join(APP, 'App.js'), 'utf8')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const GONE = 'cc'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The text of the top-level `function <name> (...) { ... }`, braces matched.
function fnText (src, name) {
  let start = src.indexOf('\nfunction ' + name + ' (')
  if (start < 0) start = src.indexOf('\nasync function ' + name + ' (')
  if (start < 0) {
    start = src.indexOf('\nexport function ' + name + ' (')
    if (start >= 0) start += 'export '.length
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

const CODE = withoutComments(ARUA)
const member = fnText(CODE, 'MemberARua')
const page = fnText(CODE, 'PageARua')

function post (author, seq) {
  return { kind: 'post', author, name: null, username: null, seq, at: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(), text: 't' + seq, replyTo: null, quote: null, media: null, preview: null }
}

async function stored () {
  const snap = await import('../src/feedSnapshot.js')
  const built = snap.buildSnapshot({
    origin: ORIGIN,
    association: ASSOC,
    owner: OWN,
    items: [post(FOLLOW, 3), post(GONE, 2), post(OWN, 1)],
    cursor: null,
    profileOf: (a) => (a === FOLLOW ? { name: 'Bia', username: 'bia' } : a === OWN ? { name: 'Eu', username: 'eu_mesmo' } : null),
    isKnown: (a) => a === FOLLOW || a === GONE,
    now: Date.now()
  })
  return { snap, built }
}

// Runs one module-level helper of ARua.js with the store, the clock-free
// snapshot module and the installation stubbed.
function helper (name, deps, extra = []) {
  const names = Object.keys(deps)
  const body = extra.map((n) => fnText(CODE, n)).concat(fnText(CODE, name)).join('\n')
  // eslint-disable-next-line no-new-func
  return new Function(...names, body + '\nreturn ' + name)(...names.map((k) => deps[k]))
}

// Runs `fn` with globalThis.location set to `location` (undefined = none).
function withLocation (location, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'location')
  const before = globalThis.location
  if (location === undefined) delete globalThis.location
  else globalThis.location = location
  try {
    return fn()
  } finally {
    if (had) globalThis.location = before
    else delete globalThis.location
  }
}

function memStore (text) {
  const box = { text, saves: 0, clears: 0 }
  box.loadSnapshotText = () => box.text
  box.saveSnapshotText = (t) => { box.saves++; box.text = t }
  box.clearSnapshot = () => { box.clears++; box.text = null }
  return box
}

test('rewriteStored prunes against the stored binding and clears what does not parse', async (t) => {
  const { snap, built } = await stored()
  t.ok(built !== null)
  const box = memStore(JSON.stringify(built))
  const rewrite = helper('rewriteStored', { parseSnapshot: snap.parseSnapshot, loadSnapshotText: box.loadSnapshotText, saveSnapshotText: box.saveSnapshotText, clearSnapshot: box.clearSnapshot })
  rewrite((s) => snap.keepOnlyAuthors(s, new Set([FOLLOW])))
  const after = JSON.parse(box.text)
  t.alike(after.items.map((i) => i.author), [FOLLOW, OWN], 'the unfollowed author left, the own rows stay')
  t.is(box.saves, 1)
  rewrite((s) => snap.keepOnlyAuthors(s, new Set([FOLLOW])))
  t.is(box.saves, 1, 'an unchanged snapshot is not written again')
  rewrite((s) => snap.withoutAuthors(s, [FOLLOW]))
  t.alike(JSON.parse(box.text).items.map((i) => i.author), [OWN], 'a block drops the author')
  rewrite(() => null)
  t.is(box.text, null, 'a failed change clears')
  const bad = memStore('{"v":1')
  helper('rewriteStored', { parseSnapshot: snap.parseSnapshot, loadSnapshotText: bad.loadSnapshotText, saveSnapshotText: bad.saveSnapshotText, clearSnapshot: bad.clearSnapshot })((s) => s)
  t.is(bad.text, null, 'a damaged text is removed')
  t.is(bad.saves, 0)
  const none = memStore(null)
  helper('rewriteStored', { parseSnapshot: snap.parseSnapshot, loadSnapshotText: none.loadSnapshotText, saveSnapshotText: none.saveSnapshotText, clearSnapshot: none.clearSnapshot })((s) => s)
  t.is(none.clears, 0, 'nothing stored, nothing done')
})

test('liveBinding needs the own key, the remembered association and the installation', (t) => {
  const bind = (origin) => helper('liveBinding', { installationOrigin: () => origin }, ['snapshotOrigin'])
  withLocation(undefined, () => {
    // Native: the configured installation.
    t.alike(bind(ORIGIN)(OWN.toUpperCase(), { association: ASSOC }), { origin: ORIGIN, association: ASSOC, owner: OWN })
    t.is(bind(ORIGIN)(OWN, null), null, 'the Vitrine runs with config null')
    t.is(bind(ORIGIN)(null, { association: ASSOC }), null)
    t.is(bind(null)(OWN, { association: ASSOC }), null, 'no installation at all')
    t.is(bind('')(OWN, { association: ASSOC }), null)
  })
  // Web: installationOrigin() stays null and the page is the installation.
  withLocation({ origin: 'https://web.varanda.app' }, () => {
    t.alike(bind(null)(OWN, { association: ASSOC }), { origin: 'https://web.varanda.app', association: ASSOC, owner: OWN })
    t.is(bind(ORIGIN)(OWN, { association: ASSOC }).origin, ORIGIN, 'a chosen installation wins')
    t.is(bind(null)(OWN, null), null, 'still no binding without a configuration')
  })
  withLocation({ origin: 'null' }, () => {
    t.is(bind(null)(OWN, { association: ASSOC }), null, 'an opaque origin binds nothing')
  })
})

test('readSnapshot paints only a parsed snapshot of this binding', async (t) => {
  const { snap, built } = await stored()
  const binding = { origin: ORIGIN, association: ASSOC, owner: OWN }
  const run = (box) => helper('readSnapshot', { parseSnapshot: snap.parseSnapshot, loadSnapshotText: box.loadSnapshotText, clearSnapshot: box.clearSnapshot })
  const box = memStore(JSON.stringify(built))
  t.is(run(box)(binding).items.length, 3)
  t.is(run(box)(null), null, 'no binding, no read')
  t.ok(box.text !== null)
  run(box)({ ...binding, owner: FOLLOW })
  t.is(box.text, null, 'a snapshot of another owner is cleared')
  const empty = memStore(JSON.stringify({ ...built, items: [], names: {}, counts: {}, liked: [], reposted: [], originals: {} }))
  t.is(run(empty)(binding), null, 'no rows, nothing painted')
})

test('MemberARua reads the snapshot before its first loadNewest and only with a binding', (t) => {
  const read = member.indexOf('const first = liveBinding(ownKey, node.config)\n    const snapshot = readSnapshot(first)')
  t.ok(read > 0, 'read in the first render')
  t.ok(read < member.indexOf('const loadNewest = useCallback'), 'before loadNewest exists')
  const reader = fnText(CODE, 'readSnapshot')
  t.ok(/if \(binding === null\) return null/.test(reader), 'no read without a binding (the Vitrine has none)')
  t.ok(reader.indexOf('parseSnapshot(') > 0)
  t.ok(/clearSnapshot\(\)/.test(reader), 'a text that does not parse is cleared')
  t.ok(/initialFeedState\(boot\.snapshot\)/.test(member), 'the feed starts from the snapshot rows')
  t.ok(/seed: boot\.social/.test(member) && /socialSeed\(snapshot\)/.test(member), 'useSocial gets the social seed')
})

test('the snapshot reports page and details and seeds names while Momentos still gates the cover', (t) => {
  const at = member.indexOf('const snapshot = boot.snapshot')
  t.ok(at > 0)
  const effect = member.slice(at, member.indexOf('}, [])', at))
  t.ok(effect.includes("onBoot('page')") && effect.includes("onBoot('details')"))
  t.absent(effect.includes("onBoot('moments')"))
  t.ok(effect.includes("perfMarks().mark('rows-snapshot')"))
  t.ok(member.slice(member.lastIndexOf('useEffect(() => {', at), at).trim() === 'useEffect(() => {', 'the perf mark and the boot stages stay in the passive effect')
  t.absent(effect.includes('seedMany('), 'the names are not seeded after the first paint')
  const seedAt = member.indexOf('useLayoutEffect(() => {')
  t.ok(seedAt > 0 && seedAt < at, 'a layout effect before the boot effect')
  const seeds = member.slice(seedAt, member.indexOf('}, [])', seedAt))
  t.ok(seeds.includes('if (boot.snapshot !== null) seedMany(Object.entries(boot.snapshot.names))'), 'the stored names are seeded before the first paint, only for authors not known yet')
  t.ok(seeds.includes('if (boot.moments !== null) seedMany(boot.moments.names.map('), 'and the strip names')
  t.absent(seeds.includes('learnMany(') || effect.includes('learnMany('), 'never learnMany: it would overwrite a newer entry')
  t.is((member.match(/\bseedMany\(/g) || []).length, 2, 'no other seed')
  t.ok(member.includes("perfMarks().mark('rows-live')"), 'the first live page is marked')
})

test('the snapshot write is guarded by cacheGeneration and debounced', (t) => {
  const write = member.slice(member.indexOf('const writeSnapshot = useCallback'), member.indexOf('useEffect(() => () => clearTimeout(writeRef.current.timer)'))
  t.ok(write.includes('pending.gen !== cacheGeneration()'), 'a purge since arming drops the write')
  t.ok(write.includes('pendingWriteRef.current = { gen: cacheGeneration() }'), 'the generation is taken when armed')
  t.ok(member.includes("const snapHead = useMemo(() => (loadedAt === null ? null : loadedAt + '|' + unverifiedCount + '|' + items.slice(0, FEED_LIMIT_DEFAULT).map(feedKey).join()), [items, loadedAt, unverifiedCount])"), 'any change of the live first page (quiet, range, delete or a confirmed cached row) rewrites')
  t.ok(write.includes('w.done === snapKey') && write.includes('w.head = snapKey'), 'the key is the head plus the stored content digest')
  t.ok(member.includes("snapHead + '#' + snapshotDigest(items.slice(0, FEED_LIMIT_DEFAULT), socialState, names.profileOf)"))
  t.absent(/snapTick/.test(member), 'no trigger tied to one kind of read')
  t.ok(write.includes('setTimeout(writeSnapshot, SNAPSHOT_DEBOUNCE_MS)'))
  t.ok(write.includes('feedDetailsReady('), 'only once the first rows have their details')
  t.ok(write.includes('buildSnapshot('))
  t.ok(/const SNAPSHOT_DEBOUNCE_MS = 2000/.test(CODE))
  t.ok(/blocked: latest\.blocked/.test(write), 'the block list in force')
  // The folded rows (feedFold.js) are for the screen: the snapshot stores the
  // feed items, and feedSnapshot.js decides which originals go with them.
  t.ok(write.includes('const all = latest.feed.items'), 'raw feed items, not the folded rows')
  t.absent(/\bfold/.test(write.slice(0, write.indexOf('writeSnapshotRef.current = writeSnapshot'))), 'nothing folded is written')
})

test('the snapshot is read and written on every platform: previewCapable gates only the App.js preview', (t) => {
  t.absent(/\bpreviewCapable\b/.test(CODE), 'ARua.js')
  const app = withoutComments(APP_JS)
  t.is((app.match(/\bpreviewCapable\b/g) || []).length, 3, 'App.js: only the import, the read guard and the previewAllowed input')
  t.ok(app.includes('if (!previewCapable || !appActive || previewAsked.current) return'))
})

test('a write dropped by the generation guard is not done and is armed again', (t) => {
  const write = member.slice(member.indexOf('const writeSnapshot = useCallback'), member.indexOf('writeSnapshotRef.current = writeSnapshot'))
  const guard = write.indexOf('if (pending.gen !== cacheGeneration()) {')
  t.ok(guard > 0)
  const dropped = write.slice(guard, write.indexOf('return', guard))
  t.ok(dropped.includes('pendingWriteRef.current = { gen: cacheGeneration() }'), 'armed with the generation now')
  t.ok(dropped.includes('setTimeout(writeSnapshotRef.current, SNAPSHOT_DEBOUNCE_MS)'), 'still debounced')
  t.absent(dropped.includes('w.done'), 'the key is not marked done')
  t.ok(write.indexOf('w.done = w.head') > guard, 'only a write that passed the guard marks its key done')
})

test('a delete clears the stored snapshot at once', (t) => {
  const del = member.slice(member.indexOf('onDeleted: async (t) => {'), member.indexOf('await revokeDeletedMedia(request, [t.seq])'))
  t.ok(/\n {6}clearSnapshot\(\)\n/.test(del), 'cleared whether or not snapshot rows are on screen')
  t.absent(del.includes('if (cur.loadedAt === null) clearSnapshot()'))
  t.ok(del.indexOf('clearSnapshot()') < del.length, 'before the media revocation bumps the generation')
})

test('snapshotDigest changes with every stored detail of the first page', (t) => {
  const digest = helper('snapshotDigest', {}, ['refOf'])
  const avatar = { sha256: '12'.repeat(32) }
  const quoted = { ...post(GONE, 7) }
  const rows = [
    { ...post(FOLLOW, 3), quote: { author: GONE, seq: 7 } },
    { kind: 'repost', author: FOLLOW, seq: 2, to: { author: OWN, seq: 1 } }
  ]
  const base = () => ({
    counts: new Map([[FOLLOW + ':3', { replies: 1, likes: 2, reposts: 0, quotes: 0 }]]),
    eng: { liked: new Set(), reposted: new Set() },
    originals: new Map([[GONE + ':7', quoted]])
  })
  const profiles = { [FOLLOW]: { name: 'Bia', username: 'bia', avatar: null } }
  const profileOf = (a) => profiles[a]
  const d0 = digest(rows, base(), profileOf)
  t.is(digest(rows, base(), profileOf), d0, 'same content, same digest')
  const c = base()
  c.counts.set(FOLLOW + ':3', { replies: 1, likes: 3, reposts: 0, quotes: 0 })
  t.not(digest(rows, c, profileOf), d0, 'a count')
  const l = base()
  l.eng.liked.add(FOLLOW + ':3')
  t.not(digest(rows, l, profileOf), d0, 'a heart')
  const r = base()
  r.eng.reposted.add(OWN + ':1')
  t.not(digest(rows, r, profileOf), d0, 'an own repost of an original')
  const o = base()
  o.originals.set(OWN + ':1', post(OWN, 1))
  t.not(digest(rows, o, profileOf), d0, 'an original arrived')
  const gone = base()
  gone.originals.delete(GONE + ':7')
  t.not(digest(rows, gone, profileOf), d0, 'an original went')
  t.not(digest(rows, base(), (a) => (a === FOLLOW ? { name: 'Bia', username: 'bia', avatar } : undefined)), d0, 'a photo')
  t.not(digest(rows, base(), (a) => (a === FOLLOW ? { name: 'Bia B', username: 'bia', avatar: null } : undefined)), d0, 'a name')
  t.not(digest(rows, base(), (a) => (a === GONE ? { name: 'Cris', username: null, avatar: null } : profiles[a])), d0, "an original author's name")
})

test('no snapshot write while the identity is locked, signed out, reset or another owner', (t) => {
  const allows = helper('sessionAllowsSnapshot', {})
  const st = (over) => ({ status: { exists: true, publicKey: OWN, unlocked: true, signedOut: false, ...over } })
  t.ok(allows(st({}), OWN))
  t.ok(allows(st({ publicKey: OWN.toUpperCase() }), OWN))
  t.absent(allows(st({ unlocked: false }), OWN), 'locked')
  t.absent(allows(st({ signedOut: true }), OWN), 'signed out')
  t.absent(allows(st({ exists: false, publicKey: null, unlocked: false }), OWN), 'reset')
  t.absent(allows(st({ publicKey: FOLLOW }), OWN), 'another owner')
  t.absent(allows({ status: null }, OWN), 'status unknown')
  t.ok(allows(null, OWN), 'a node without a passkey identity has nothing to lock')
  const write = member.slice(member.indexOf('const writeSnapshot = useCallback'), member.indexOf('writeSnapshotRef.current = writeSnapshot'))
  const check = write.indexOf('if (!sessionAllowsSnapshot(latest.passkey, latest.binding.owner)) {')
  t.ok(check > 0, 'the write checks the session when it runs')
  t.ok(check < write.indexOf('buildSnapshot('), 'before building or saving')
  t.ok(check < write.indexOf('setTimeout('), 'before any retry')
  t.absent(write.slice(check, write.indexOf('return', check)).includes('setTimeout'), 'a refused write is not armed again')
  t.ok(member.includes('const sessionOk = binding !== null && sessionAllowsSnapshot(node.passkey, binding.owner)'))
  const effect = member.slice(member.indexOf('if (!sessionOk) {'), member.indexOf('if (binding === null || snapKey === null'))
  t.ok(effect.includes('clearTimeout(w.timer)') && effect.includes('pendingWriteRef.current = null'), 'a lock cancels the armed write')
  t.ok(/\}, \[sessionOk, snapKey,/.test(member), 'the effect runs again when the session changes')
})

test('PageARua never reads or writes the snapshot', (t) => {
  for (const name of ['readSnapshot', 'parseSnapshot', 'buildSnapshot', 'loadSnapshotText', 'saveSnapshotText', 'clearSnapshot', 'keepOnlyAuthors', 'onFollows', 'seed:']) {
    t.absent(page.includes(name), name)
  }
})

test('the cache registry entry is registered once, at module scope', (t) => {
  const calls = CODE.match(/\bregisterLocalCache\(/g) || []
  t.is(calls.length, 1)
  t.ok(/\nregisterLocalCache\(\{\s+wipe: \(\) => \{\s+reconciledFollows = null\s+return clearSnapshot\(\)\s+\},/.test(CODE), 'a wipe clears the snapshot and forgets the reconciled follows')
  t.ok(/dropAuthors: \(keys\) => rewriteStored\(\(snapshot\) => withoutAuthors\(snapshot, keys\)\)/.test(CODE))
  t.ok(/keepOnlyAuthors: \(allowed\) => rewriteStored\(\(snapshot\) => snapshotKeepOnly\(snapshot, allowed\)\)/.test(CODE))
})

test('keepOnlyAuthors runs only with a complete follow list', (t) => {
  const calls = CODE.match(/\bkeepOnlyAuthors\(/g) || []
  t.is(calls.length, 1, 'one call site')
  const onFollows = member.slice(member.indexOf('const onFollows = useCallback'), member.indexOf('const social = useSocial('))
  t.ok(onFollows.includes('keepOnlyAuthors(new Set(allowed))'))
  t.ok(onFollows.includes('new Set([b.owner, ...keys])'), 'the own key is always allowed')
  const social = fnText(CODE.replace('\nexport function useSocial', '\nfunction useSocial'), 'useSocial')
  const pages = CODE.slice(CODE.indexOf('export async function readAllFollows ('), CODE.indexOf('export function useSocial'))
  t.ok(/const \{ keys, complete \} = await readAllFollows\(request, /.test(social), 'every page is read')
  t.ok(/complete: offset === total && keys\.length === total && version\(\) === before/.test(pages))
  t.ok(/if \(complete && set === knownRef\.current && typeof onFollowsRef\.current === 'function'\)/.test(social), 'a partial list calls nothing')
  t.ok(/let offset = 0/.test(pages) && /request\('follow\.list', \{ offset, limit \}\)/.test(pages), 'the list starts at offset 0')
})

test('App.js seeds the own name from the snapshot before profile.read', (t) => {
  const code = withoutComments(APP_JS)
  t.ok(/import ARua, \{[^}]*\bliveBinding\b[^}]*\} from '\.\/src\/screens\/ARua'/.test(code), 'the same binding rule as A Rua')
  const at = code.indexOf('const binding = liveBinding(ownKey, snapshotConfig)')
  t.ok(at > 0)
  const effect = code.slice(at, code.indexOf('}, [setupDone, ownKey, snapshotConfig, seedMany, resolve])', at))
  t.ok(effect.includes('parseSnapshot(loadSnapshotText(), { ...binding, now: Date.now() })'))
  t.ok(effect.includes('seedMany([[ownKey, own]])'), 'a seed only when the own entry is not known')
  t.absent(/\blearn\(ownKey, own\)/.test(effect))
  t.ok(effect.indexOf('seedMany(') < effect.indexOf('resolve(ownKey)'), 'seeded before the read')
})

test('absentSeeds keeps only keys the cache has no entry for', async (t) => {
  const { absentSeeds, applySeed } = await import('../src/namesCache.js')
  const known = new Map([[FOLLOW, { name: 'Bia nova', username: 'bia', bio: null, avatar: null, loaded: true }], [GONE, null]])
  const seeds = [[FOLLOW.toUpperCase(), { name: 'Bia velha' }], [GONE, { name: 'X' }], [OWN, { name: 'Eu' }], [OWN, { name: 'Eu de novo' }], [null, { name: 'n' }], 'bad']
  t.alike(absentSeeds(known, seeds), [[OWN, { name: 'Eu' }]], 'known, null and repeated keys are left out')
  t.alike(absentSeeds(null, [[OWN, 'Eu']]), [[OWN, 'Eu']])
  t.alike(absentSeeds(known, null), [])
  t.is(applySeed(null, { name: 'Eu' }).loaded, false, 'a new seeded entry is not loaded, so resolveMany reads it')
  const names = withoutComments(fs.readFileSync(path.join(APP, 'src/names.js'), 'utf8'))
  t.ok(names.includes('const seedMany = useCallback((entries) => apply(absentSeeds(cacheRef.current, entries)), [apply])'))
})

test('every screen delete clears the stored first page through the shell', (t) => {
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  const at = app.indexOf('const deletedPost = useCallback(() => {')
  t.ok(at > 0, 'the shared delete handler exists')
  t.ok(app.slice(at, at + 120).includes('clearSnapshot()'), 'it clears the snapshot first')
})

// The preview region of ARua.js: from its marker to makeStyles.
function previewRegion () {
  const at = ARUA.indexOf('// --- the cold-start preview')
  return withoutComments(ARUA.slice(at, ARUA.indexOf('const makeStyles = ', at)))
}

test('ARuaPreview sends nothing: no request, no fetch, no handler', (t) => {
  const region = previewRegion()
  t.ok(region.includes('export function ARuaPreview ('))
  t.absent(/\brequest\s*\(/.test(region), 'no request(')
  t.absent(/node\.request/.test(region), 'no node.request')
  t.absent(/fetch/i.test(region), 'no fetch')
  t.absent(/onRefresh|onLoadMore|onOpen|onReply|onReport/.test(region), 'no refresh, paging or tap handler')
  t.ok(region.includes("pointerEvents='box-only'"), 'rows take no touch of their own')
  t.ok(region.includes('<KeptOnlyContext.Provider value>'), 'photos only from the kept store')
  t.absent(/bytes: -1/.test(region), 'valid descriptors: the kept-only mode decides')
  t.ok(region.includes("perfMarks().mark('preview-shown')"))
  t.ok(region.includes('<TopBar title=') && region.includes('<RefreshableList'))
  t.ok(region.includes('<StatusBar style={statusBarStyle(scheme)} />'), 'sets the status bar as the splash did')
  t.ok(region.includes('pendingOf: view.pending') && region.includes('pending: () => false'), 'it folds with what the snapshot holds and asks for nothing')
  t.absent(/\bingest\b|foldNeeds/.test(region), 'no fold read')
})

test('previewBinding checks installation and association, not the owner', (t) => {
  const bind = (origin) => helper('previewBinding', { installationOrigin: () => origin }, ['snapshotOrigin'])
  withLocation(undefined, () => {
    t.alike(bind(ORIGIN)({ association: ASSOC }), { origin: ORIGIN, association: ASSOC })
    t.is(bind(ORIGIN)(null), null, 'the Vitrine runs with config null')
    t.is(bind(null)({ association: ASSOC }), null)
  })
})

test('App.js: the preview is fail-closed and never reads the keychain before the app was active', (t) => {
  const app = withoutComments(APP_JS)
  t.ok(app.includes('let activeSeen = false'))
  t.ok(app.includes("if (state === 'active') activeSeen = true"))
  t.ok(app.includes('useState(() => noteAppState(AppState.currentState))'))
  t.absent(/sessionStore\.load\(/.test(app), 'never the destructive load')
  t.is((app.match(/sessionStore\.hasLive\(/g) || []).length, 1, 'one read-only probe')
  const at = app.indexOf('sessionStore.hasLive(')
  const guard = app.lastIndexOf('if (!previewCapable || !appActive || previewAsked.current) return', at)
  t.ok(guard > 0 && at - guard < 1500, 'guarded by the first active state in the same effect')
  t.ok(app.includes('sessionStore.hasLive({ rpId, publicKey: snapshot.owner })'), 'exactly the snapshot owner')
  const effect = app.slice(app.indexOf('rememberedConfig().then((remembered) => {'), app.indexOf('}, [appActive, previewConfig, previewPhase, previewRetry])'))
  t.ok(app.indexOf('}, [appActive, previewConfig, previewPhase, previewRetry])') > 0, 'effect anchors found')
  t.ok(app.includes("const stillActive = () => AppState.currentState === 'active'"))
  t.ok(effect.indexOf('if (!stillActive()) {') > 0 && effect.indexOf('if (!stillActive()) {') < effect.indexOf('sessionStore.hasLive('), 'foreground re-checked after the await, before the probe')
  t.ok(effect.includes('if (live !== true) return') && effect.indexOf('if (!stillActive()) {', effect.indexOf('sessionStore.hasLive(')) > 0, 'and again after the probe')
  t.ok(effect.includes('if (!settled) previewAsked.current = false'), 'a discarded attempt gives the latch back')
  t.ok(app.includes('rememberedConfig().then((remembered) => {'), 'the association before the node connects, from disk only')
  t.ok(app.includes('previewBinding(remembered || previewConfig)') && app.includes('parseSnapshot(loadSnapshotText(), { ...binding, now: Date.now() })'))
  const mismatch = app.slice(app.indexOf('const previewMismatch ='), app.indexOf('const previewStep ='))
  t.ok(mismatch.includes('wipeLocalCaches()'), 'the mismatch path wipes the local caches')
  t.ok(mismatch.includes('pkStatus.publicKey.toLowerCase() !== previewOwner') && mismatch.includes('pkStatus.signedOut === true') && mismatch.includes("step === 'entrar'"))
  t.ok(app.includes('const previewOn = previewOwner !== null && !previewMismatch && previewAllowed({'))
  t.ok(app.includes('const bootCover = previewOn ? <ARuaPreview '), 'rendered only when previewAllowed')
  t.is((app.match(/<ARuaPreview /g) || []).length, 1)
  t.absent(app.includes('{splash}'), 'every splash use goes through bootCover')
})

test('App.js: the preview reads the Momentos copy for the snapshot owner and stays off without it', (t) => {
  const app = withoutComments(APP_JS)
  t.ok(/import \{[^}]*\bloadScreenSnapshotText\b[^}]*\} from '\.\/src\/screenSnapshotStore'/.test(app) && app.includes("import { parseScreenSnapshot } from './src/screenSnapshot'"))
  const read = app.indexOf('if (!previewCapable || !appActive || previewAsked.current) return')
  const effect = app.slice(read, app.indexOf('}, [appActive, previewConfig, previewPhase, previewRetry])'))
  t.ok(effect.includes("moments = parseScreenSnapshot(loadScreenSnapshotText('momentos'), 'momentos', { ...binding, owner: snapshot.owner, acting: actingAs.get(), now: Date.now() })"), 'same binding plus the feed snapshot owner, as the member only, read without clearing a refused copy')
  t.absent(effect.includes("loadScreenSnapshot('momentos'"), 'the probe never deletes the copy the live screen may accept')
  t.ok(effect.includes('if (snapshot === null || snapshot.items.length === 0 || moments === null) return'), 'no Momentos copy: no keychain probe, no seed')
  t.ok(effect.indexOf("loadScreenSnapshotText('momentos')") < effect.indexOf('sessionStore.hasLive('), 'read before the probe')
  const gateCall = app.slice(app.indexOf('const previewOn ='), app.indexOf('const bootCover = '))
  t.ok(gateCall.includes('momentsKnown: previewSeed.moments !== null && previewSeed.moments.owner === previewOwner,'))
  t.ok(app.includes('<ARuaPreview snapshot={previewSeed.snapshot} moments={previewSeed.moments.body} progress={bootBar} />'), 'the strip body goes down to the preview')
})

test('ARuaPreview draws the saved Momentos strip as MemberARua does, untouchable and filtered at render', (t) => {
  const region = previewRegion()
  t.ok(region.includes('export function ARuaPreview ({ snapshot, moments = null, progress = 0, onScrollFrame })'))
  t.ok(region.includes('cachedRowsShown(moments.authors, { loadState: blockLoad, blocked: blockedKeys, muted: mutes.keys, owner: ownKey, authorsOf: (a) => [a.author] })'), 'block list pending: only the own ring')
  t.absent(/useMemo\(\(\) => cachedRowsShown|useMemo\(\(\) => \(?moments === null \? \[\] : cachedRowsShown/.test(region), 'computed at render, never memoized once')
  t.ok(region.includes("<View pointerEvents='none' accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>") && region.includes('<MomentosStrip'), 'the rings take no touch, and no screen reader action (no onOpen here)')
  t.ok(region.includes('ListHeaderComponent={header}'), 'the strip is the list header, as on A Rua')
  t.ok(region.includes('moments.names.map((n) => [n.author, { name: n.name, username: n.username, avatar: n.avatar }])'), 'names from the Momentos snapshot')
  t.absent(/useMomentSeen|bindMomentSeen|useMoments\(/.test(region), 'nothing bound to the node')
  const strip = region.slice(region.indexOf('<MomentosStrip'), region.indexOf('/>', region.indexOf('<MomentosStrip')))
  t.absent(/onOpen/.test(strip), 'no ring opens anything')
  t.ok(/\bhosted\b/.test(strip) && /data=\{\{ phase: 'ready', authors: stripAuthors, own: moments\.own \}\}/.test(strip))
  const live = member.slice(member.indexOf('ListHeaderComponent={('), member.indexOf('ListEmptyComponent='))
  t.ok(live.indexOf('<MomentosStrip') < live.indexOf('<CountsNote'), 'live header: strip, then the counts note')
  t.ok(region.indexOf('<MomentosStrip') < region.indexOf('<CountsNote social={view} />'), 'the preview header has the same order')
})

test('sessionStore.web.js and configStore.web.js twins hold nothing for the preview', async (t) => {
  const { sessionStore } = await import('../src/sessionStore.web.js')
  t.is(await sessionStore.load({ rpId: 'bora.varanda.app', publicKey: OWN }), null)
  const web = withoutComments(fs.readFileSync(path.join(APP, 'src/configStore.web.js'), 'utf8'))
  t.ok(/export async function rememberedConfig \(\) \{\s*return null\s*\}/.test(web))
  t.is(await sessionStore.hasLive({ rpId: 'bora.varanda.app', publicKey: OWN }), false)
})

test('App.js: a stale preview (purge or another binding) is dropped and only a fresh read brings one back', (t) => {
  const app = withoutComments(APP_JS)
  t.ok(app.includes("import { cacheGeneration, wipeEpoch, wipeLocalCaches } from './src/localCaches'"))
  const stale = app.slice(app.indexOf('const previewStale ='), app.indexOf('useEffect(() => {', app.indexOf('const previewStale =')))
  t.ok(stale.includes('previewSeed.gen !== cacheGeneration()'), 'a purge since the read')
  t.ok(stale.includes('installationOrigin() !== previewSeed.origin'), 'another installation')
  t.ok(stale.includes('previewConfig.association !== previewSeed.association'), 'another association')
  const drop = app.indexOf('if (!previewStale) return')
  const read = app.indexOf('if (!previewCapable || !appActive || previewAsked.current) return')
  t.ok(drop > 0 && drop < read, 'the drop effect runs before the read effect')
  t.ok(app.slice(drop, read).includes('setPreviewSeed(null)') && app.slice(drop, read).includes('previewAsked.current = false'), 'dropped, and the latch given back for a fresh read')
  const effect = app.slice(read, app.indexOf('}, [appActive, previewConfig, previewPhase, previewRetry])'))
  t.ok(effect.includes('const gen = cacheGeneration()'), 'the generation is taken before the reads')
  t.ok(effect.includes('if (cacheGeneration() !== gen) {'), 'a purge during the reads discards the result')
  t.ok(effect.includes('setPreviewSeed({ snapshot, moments, sessionLive: true, gen, origin: binding.origin, association: binding.association })'))
  t.ok(app.includes('const previewOwner = previewSeed !== null && !previewStale &&'), 'a stale seed never renders, even before the drop effect')
  t.absent(/sessionStore\.load\(/.test(app))
})

test('a dropped or interrupted preview read is retried, not lost for the boot', (t) => {
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes('const [previewRetry, setPreviewRetry] = useState(0)'), 'a retry counter')
  t.ok(app.includes('}, [appActive, previewConfig, previewPhase, previewRetry])'), 'the read watches it')
  const drop = app.indexOf('if (!previewStale) return')
  t.ok(drop > 0 && app.slice(drop, drop + 160).includes('setPreviewRetry((n) => n + 1)'), 'a drop asks again')
  t.ok(app.includes("if (state === 'active' && !previewAsked.current) setPreviewRetry((n) => n + 1)"), 'a return to the foreground asks again')
  const probe = app.indexOf('if (live !== true) return')
  t.ok(probe > 0 && app.slice(probe, probe + 200).includes('previewAsked.current = false'), 'leaving the foreground during the probe gives the latch back')
})

// --- cache-first reopen: the first live page keeps the painted rows ---

async function settleHelpers () {
  const paging = await import('../src/paging.js')
  const deps = {
    resetWith: paging.resetWith,
    isLastFeedPage: paging.isLastFeedPage,
    settleSeeded: paging.settleSeeded,
    cursorOf: paging.cursorOf,
    feedStillSyncing: paging.feedStillSyncing,
    syncTruncated: paging.syncTruncated,
    FEED_LIMIT_DEFAULT: 25
  }
  return { paging, seededFirstPage: helper('seededFirstPage', deps, ['pageComplete']) }
}

// confirmWalk over a feed.read limit of `limit` rows.
function walkHelper2 (paging, limit) {
  return helper('confirmWalk', { isLastFeedPage: paging.isLastFeedPage, cursorOf: paging.cursorOf, feedStillSyncing: paging.feedStillSyncing, syncTruncated: paging.syncTruncated, FEED_LIMIT_MAX: limit, CONFIRM_PAGES_MAX: 4 }, ['pageComplete'])
}

// walkPage over a feed.read limit of `limit` rows.
async function walkHelper (limit = 25) {
  const paging = await import('../src/paging.js')
  return helper('walkPage', {
    resetWith: paging.resetWith,
    compareFeed: paging.compareFeed,
    mergeRange: paging.mergeRange,
    settleSpan: paging.settleSpan,
    isLastFeedPage: paging.isLastFeedPage,
    cursorOf: paging.cursorOf,
    feedKey: paging.feedKey,
    feedStillSyncing: paging.feedStillSyncing,
    syncTruncated: paging.syncTruncated,
    FEED_LIMIT_MAX: limit
  }, ['pageComplete', 'addHeld', 'keepOrHeld'])
}

// A feed.read answer: `rows` newest first, as the screen holds them.
function answer (rows, extra = {}) {
  return { items: rows.slice().reverse(), skipped: [], skippedTruncated: 0, future: [], futureTruncated: 0, incomplete: [], incompleteTruncated: 0, ...extra }
}

const keys = (rows) => rows.map((i) => i.author + ':' + i.seq)

test('seededFirstPage keeps cached rows below the page, holds newer ones and drops rows gone from a complete span', async (t) => {
  const { seededFirstPage } = await settleHelpers()
  const cached = [post(FOLLOW, 9), post(FOLLOW, 8), post(OWN, 7), post(FOLLOW, 6), post(FOLLOW, 2), post(OWN, 1)]
  const fresh = post(FOLLOW, 10)
  // A full page (25 rows, so not the last one): four rows of the cache's
  // range plus 21 rows just below the cached row 6.
  const span = [fresh, cached[0], cached[2], cached[3]]
  const pad = Array.from({ length: 21 }, (_, i) => ({ ...post(GONE, 100 + i), at: new Date(Date.UTC(2026, 10, 1, 0, 0, 6) - (i + 1) * 10).toISOString() }))
  const full = answer(span.concat(pad))
  const r = seededFirstPage(cached, full)
  t.ok(r !== null, 'the painted rows stay')
  t.is(r.patch.newer, 1, 'a newer post waits behind the pill')
  t.absent(keys(r.patch.items).includes(FOLLOW + ':10'), 'it is not inserted above the person')
  t.absent(keys(r.patch.items).includes(FOLLOW + ':8'), 'a row inside a complete span it no longer returns leaves')
  t.alike(r.patch.unverified, [FOLLOW + ':2', OWN + ':1'], 'the rows below the page stay unverified')
  t.alike(r.patch.cursor, { at: post(OWN, 1).at, author: OWN, seq: 1 }, 'the cursor is the oldest row kept')
  t.is(r.patch.atEnd, false, 'scrolling continues while rows are unverified')
  t.is(r.first.complete, true)
  t.alike(r.first.oldest.seq, 120, 'the walk starts below the page')

  const syncing = seededFirstPage(cached, { ...full, incomplete: [FOLLOW] })
  t.ok(syncing.patch.unverified.includes(FOLLOW + ':8'), 'a still-syncing page drops nothing it did not return')
  t.is(syncing.first.complete, false, 'and the walk starts from the top')
  t.is(seededFirstPage(cached, { ...full, skippedTruncated: 2 }).first.complete, false, 'a capped list is not complete')

  const short = seededFirstPage(cached, answer([cached[0], cached[2]]))
  t.alike(keys(short.patch.items), [FOLLOW + ':9', OWN + ':7'], 'a short complete page is the whole feed: every other cached row leaves')
  t.alike(short.patch.unverified, [])
  t.is(short.patch.atEnd, true)
  t.is(seededFirstPage(cached, answer([post(GONE, 50)])), null, 'nothing of the cache survives: the page replaces the list')
})

test('unverifiedRowsShown: a blocked author never shows, only clean own rows while block.list is pending or failed', async (t) => {
  const paging = await import('../src/paging.js')
  const shown = helper('unverifiedRowsShown', { feedKey: paging.feedKey }, ['refOf', 'snapshotRowsShown'])
  const confirmed = post(FOLLOW, 9)
  const cachedOwn = post(OWN, 3)
  const cachedFollow = post(FOLLOW, 2)
  const cachedQuote = { ...post(OWN, 1), quote: { author: FOLLOW, seq: 2 } }
  const items = [confirmed, cachedOwn, cachedFollow, cachedQuote]
  const unverified = keys([cachedOwn, cachedFollow, cachedQuote])
  t.is(shown(items, [], new Set([FOLLOW]), 'ok', OWN, () => null), items, 'nothing unverified: the list as read')
  t.alike(shown(items, unverified, new Set(), 'ok', OWN, () => null), items)
  t.alike(shown(items, unverified, new Set([FOLLOW]), 'ok', OWN, () => null), [confirmed, cachedOwn, cachedQuote], 'a block that arrives after the paint hides the cached row; a confirmed row is the node\'s answer')
  for (const state of ['pending', 'failed']) {
    t.alike(shown(items, unverified, new Set(), state, OWN, () => null), [confirmed, cachedOwn], state + ': only clean own rows among the unverified')
  }
})

test('confirmWalk pages older until nothing is unverified, the last page or 4 pages, and stops when cancelled', async (t) => {
  const paging = await import('../src/paging.js')
  const walk = walkHelper2(paging, 2)
  const pages = [answer([post(FOLLOW, 8), post(FOLLOW, 7)]), answer([post(FOLLOW, 6), post(FOLLOW, 5)]), answer([post(FOLLOW, 4), post(FOLLOW, 3)]), answer([post(FOLLOW, 2), post(FOLLOW, 1)]), answer([post(FOLLOW, 0.5)])]
  const asked = []
  const reader = () => (from) => { asked.push(from); return Promise.resolve(pages[asked.length - 1]) }
  t.alike(await walk(reader(), null, () => 3, () => false), { outcome: 'partial', resume: paging.cursorOf(pages[3].items), capped: true }, 'rows left after 4 pages: it goes on later below the last page')
  t.is(asked.length, 4, 'at most 4 pages')
  t.is(asked[0], null, 'the first from the given start')
  t.alike(asked[1], paging.cursorOf(pages[0].items), 'then from the oldest row of the page before')
  asked.length = 0
  const froms = []
  t.alike(await walk(reader(), { at: 'x', author: OWN, seq: 1 }, (page, from) => { froms.push(from); return froms.length === 2 ? 0 : 1 }, () => false), { outcome: 'done' })
  t.is(asked.length, 2, 'stops once nothing is unverified')
  t.alike(froms[0], { at: 'x', author: OWN, seq: 1 }, 'settle gets the cursor the page was asked with')
  asked.length = 0
  let settled = 0
  t.alike(await walk(reader(), null, () => { settled++; return 1 }, () => true), { outcome: 'cancelled' })
  t.is(settled, 0, 'a cancelled walk commits nothing')
  const last = (from) => Promise.resolve(answer([post(FOLLOW, 1)]))
  let n = 0
  t.alike(await walk(last, null, () => { n++; return 1 }, () => false), { outcome: 'done' }, 'a complete last page ends it')
  t.is(n, 1, 'stops on the last page')
})

test('a deleted cached row leaves: the oldest row, the whole tail and inside the first page', async (t) => {
  const { paging, seededFirstPage } = await settleHelpers()
  const walk = walkHelper2(paging, 25)
  const walkPage = await walkHelper(25)
  // The node's feed: 30 rows, newest first; the cache holds the 25 newest
  // plus 2 rows deleted elsewhere since (one inside the first page, one the
  // oldest), and `tail` deleted rows below everything.
  const feedRows = Array.from({ length: 30 }, (_, i) => ({ ...post(FOLLOW, 100 - i), at: new Date(Date.UTC(2026, 10, 2) - i * 1000).toISOString() }))
  const at = (ms) => new Date(Date.UTC(2026, 10, 2) - ms).toISOString()
  const inside = { ...post(FOLLOW, 500), at: at(3500) }
  const tail = [{ ...post(FOLLOW, 501), at: at(40000) }, { ...post(FOLLOW, 502), at: at(41000) }]
  const cached = feedRows.slice(0, 25).concat([inside]).concat(feedRows.slice(25)).concat(tail).sort((a, b) => paging.compareFeed(b, a))
  const read = (from) => {
    const below = from === null ? feedRows : feedRows.filter((r) => paging.compareFeed(r, from) < 0)
    return Promise.resolve(answer(below.slice(0, 25)))
  }
  const first = await read(null)
  const r = seededFirstPage(cached, first)
  t.absent(keys(r.patch.items).includes(FOLLOW + ':500'), 'inside the first page: gone at once')
  t.ok(r.patch.unverified.length > 0)
  let feed = { items: r.patch.items, unverified: r.patch.unverified, cursor: r.patch.cursor, newer: r.patch.newer }
  let held = r.first.held
  const outcome = await walk(read, r.first.complete ? r.first.oldest : null, (page, from) => {
    const w = walkPage(feed, page, from, held)
    held = w.held
    feed = { ...feed, ...w.patch }
    return w.patch.unverified.length
  }, () => false)
  t.alike(outcome, { outcome: 'done' })
  t.alike(feed.unverified, [], 'every cached row settled')
  t.alike(keys(feed.items), keys(feedRows), 'the whole deleted tail, the oldest row included, left; the rows the node returns stay')
})

test('MemberARua settles the snapshot rows on the first live page and replaces on every later reload', (t) => {
  const newest = member.slice(member.indexOf('const loadNewest = useCallback'), member.indexOf('const bootRef = useRef('))
  t.ok(newest.includes('const seeded = cur.loadedAt === null && cur.items.length > 0 ? seededFirstPage(cur.items, page) : null'), 'only rows painted from the snapshot')
  t.ok(newest.includes('items: resetWith(page.items),\n        unverified: [],\n        cursor: cursorOf(page.items),\n        atEnd: isLastFeedPage(page, FEED_LIMIT_DEFAULT),'), 'a replacing reload (refresh, the pill) clears unverified')
  t.ok(/newer: 0,\s*loadMark,\s*loading: false,\s*refreshing: false,\s*\.\.\.\(seeded === null \? \{\} : seeded\.patch\)\s*\}\)/.test(newest), 'only the seeded patch overrides the replacing fields')
  t.ok(newest.includes('firstPageRef.current = seeded === null ? null : seeded.first'), 'the walk start is remembered')
  t.ok(newest.includes('loadedAt: Date.now()'))
  const quietReplace = newest.slice(newest.indexOf('items: resetWith(page.items),\n          unverified: []'))
  t.ok(quietReplace.length > 0 && newest.includes('items: resetWith(page.items),\n          unverified: [],\n          cursor: cursorOf(page.items),\n          atEnd: plan.atEnd'), 'the quiet replace clears unverified')
  t.ok(newest.includes('settleSpan({ items: merged.items, unverified: prev.unverified, page: resetWith(page.items), complete: pageComplete(page), from: null, end: isLastFeedPage(page, FEED_LIMIT_DEFAULT) })'), 'the quiet merge settles its span from the top')
  t.ok(newest.includes('items: settled.items,\n            unverified: settled.unverified'))
  t.ok(newest.includes('ingest({ ...seededNeeds(seeded.patch.items, seeded.patch.unverified), authors: page.items.map((i) => i.author), reset: true })'), 'the kept cached rows keep their counts, unverified ones are not stored as originals')
  const resets = (CODE.match(/items: resetWith\(/g) || []).length
  const cleared = (member.match(/items: resetWith\(page\.items\),\n {8,10}unverified: \[\]/g) || []).length
  t.is(cleared, 2, 'both replacing commits of MemberARua clear unverified')
  t.ok(resets >= cleared)
  t.ok(member.includes('    unverified: [],\n'), 'the feed state starts with nothing unverified')
})

test('the delete commit, loadOlder and loadRange carry unverified', (t) => {
  const del = member.slice(member.indexOf('onDeleted: async (t) => {'), member.indexOf('await revokeDeletedMedia(request, [t.seq])'))
  t.ok(del.includes('commit({ items: kept, unverified: cur.unverified.filter((key) => left.has(key)) })'), 'a deleted row leaves unverified')
  const older = member.slice(member.indexOf('const loadOlder = useCallback'), member.indexOf('const loadRange = useCallback'))
  t.ok(older.includes('settleSpan({ items: patch.items, unverified: prev.unverified, page: resetWith(page.items), complete: pageComplete(page), from: before, end: isLastFeedPage(page, FEED_LIMIT_MAX) })'), 'from the cursor it asked with')
  t.ok(older.includes('items: settled.items,\n        unverified: settled.unverified'))
  const range = member.slice(member.indexOf('const loadRange = useCallback'), member.indexOf('const [walkRetry, setWalkRetry]'))
  t.ok(range.includes('let before = rangeReadStart(current.items, current.rangeFrom, current.unverified)\n      const start = before'), 'from the top when the top row is unverified')
  t.ok(range.includes('whole = whole && pageComplete(page)'), 'complete only when every page of the walk was')
  t.ok(range.includes('if (before !== null) oldest = before'))
  t.ok(range.includes("settleSpan({ items: merged.items, unverified: prev.unverified, page: resetWith(rows), complete: whole, from: start, to: oldest, end: step === 'end' })"), 'a short page reaches the end of the list')
  t.ok(range.includes("const kept = keepOrHeld(settled, addHeld(first !== null ? first.held : [], resetWith(rows), new Set(merged.newer)), Math.max(prev.newer, merged.newer.length), { rows: resetWith(rows), last: step === 'end' })"), 'the same fallback as walkPage when every row left')
  t.ok(range.includes('if (first !== null) first.held = kept.held'))
  t.ok(/deep: true,\s*\.\.\.kept\.patch,\s*\.\.\.\(kept\.replaced \? \{ rangeFrom: null, probeOlder: false \} : \{\}\),\s*loadingMore: false/.test(range), 'the kept list overrides the end state of the read')
})

test('the confirm walk shares the read sequence and runs only when nothing else is in flight', (t) => {
  const at = member.indexOf('const confirmUnverified = useCallback')
  const fn = member.slice(at, member.indexOf('const unverifiedLeft', at))
  t.ok(fn.includes('const mine = ++seqRef.current'), 'a replacing read cancels it')
  t.ok(fn.includes('() => mine !== seqRef.current'))
  t.ok(fn.includes('current.loading || current.refreshing || current.loadingMore'))
  t.ok(fn.includes('first.done || first.running || first.resumeAt === seqRef.current'), 'one at a time; a partial walk goes on only after another read')
  t.ok(fn.includes('first.resume !== undefined ? first.resume : first.complete && first.oldest !== null ? first.oldest : null'), 'from where a partial walk stopped, else from the top unless the first page was complete')
  t.ok(fn.includes("if (outcome === 'partial') first.resume = r.resume"))
  t.ok(fn.includes("else if (outcome === 'done') first.done = true\n      else first.resumeAt = mine"), 'done only when settled; partial or failed stays retriable')
  t.ok(fn.includes("request('feed.read', from === null ? { limit: FEED_LIMIT_MAX, thumbs: true, alt: true } : { limit: FEED_LIMIT_MAX, before: from, thumbs: true, alt: true })"), 'the same read as loadOlder')
  t.ok(fn.includes('const r = walkPage(feedRef.current, page, from, first.held)'), 'rows inside the cached range join the list (walkPage)')
  t.ok(fn.includes('first.held = r.held') && fn.includes('commit(r.patch)'))
  t.ok(fn.includes('learnPage(r.fresh)') && fn.includes('ingest(pageNeeds(r.fresh))'), 'rows the page confirmed or added are ingested as originals')
  const walk = fnText(CODE, 'confirmWalk')
  t.ok(walk.includes('isLastFeedPage(page, FEED_LIMIT_MAX)'), 'the last page is judged by the limit the walk reads with')
  t.absent(walk.includes('FEED_LIMIT_DEFAULT'))
  t.ok(fn.includes('if (cancelled) setWalkRetry((n) => n + 1)'), 'a cancelled walk is asked again')
  t.ok(member.includes('if (unverifiedLeft > 0 && active && !loading && !refreshing && !loadingMore) confirmUnverified()'))
})

test('shownItems passes unverified rows through the snapshot rules on every change of blocks', (t) => {
  t.ok(/withoutMutedRows\(unverifiedRowsShown\(loadedAt !== null\s*\? items\s*: snapshotRowsShown\(items, blockedKeys, blockLoad, ownKey, \(ref\) => shownOriginals\.get\(ref\)\), unverifiedKeys, blockedKeys, blockLoad, ownKey, \(ref\) => shownOriginals\.get\(ref\)\), mutedHas\)/.test(member), 'live rows that are unverified pass the snapshot rules')
  t.ok(member.includes('[items, loadedAt, unverifiedKeys, blockedKeys, blockLoad, ownKey, shownOriginals, mutedHas])'), 'recomputed on every change of those inputs')
  const write = member.slice(member.indexOf('const writeSnapshot = useCallback'), member.indexOf('writeSnapshotRef.current = writeSnapshot'))
  t.ok(write.includes('const unverified = new Set(latest.feed.unverified)'))
  t.ok(write.includes('const rows = followed.filter((i) => !unverified.has(feedKey(i)))'), 'unverified rows are never written back')
  t.ok(write.includes('if (rows.length === 0 && followed.length > 0) return') && write.indexOf('if (rows.length === 0 && followed.length > 0) return') < write.indexOf('clearSnapshot()'), 'a list empty only of unverified rows keeps the stored copy')
  t.ok(write.includes('cursor: rows.length === all.length ? latest.feed.cursor : null'), 'a left-out row voids the cursor')
})

test('Momentos: seeded from the snapshot, shown under the block and mute lists, written from a live read only', (t) => {
  t.ok(member.includes("const momentos = first === null ? null : loadScreenSnapshot('momentos', { ...first, acting, now: Date.now() })"), 'the same binding, none in the Vitrine')
  t.ok(member.includes('moments: momentos === null ? null : momentos.body'))
  t.ok(member.includes('useMoments({ ownKey, active: active !== false, tick: refresh, seed: boot.moments })'))
  const boot = member.slice(member.indexOf('if (boot.moments !== null) seedMany('), member.indexOf('const snapshot = boot.snapshot'))
  t.ok(boot.includes('seedMany(boot.moments.names.map('), 'names seeded, never learned')
  t.ok(member.includes('cachedRowsShown(moments.authors, { loadState: blocks.loadState, blocked: blocks.keys, muted: mutes.keys, owner: ownKey, authorsOf: (a) => [a.author] })'))
  t.ok(member.includes('[moments.seeded, moments.authors, blocks.loadState, blocks.keys, mutes.keys, ownKey])'), 'derived on every change, never filtered once')
  t.ok(member.includes('liveAuthors(momentAuthors, now)') && member.includes('data={momentsShown}') && member.includes('viewerRings({ authors: momentAuthors'), 'the strip, its rings and the warm photo use the shown authors')
  const at = member.indexOf('const momentLatestRef = useRef(null)')
  const write = member.slice(at, member.indexOf('useEffect(() => () => clearTimeout(momentWriteRef.current.timer), [])', at))
  t.ok(write.includes('if (!momentsLive ||'), 'only from a live answer')
  t.ok(write.includes('const gen = w.gen !== null && w.readGen === momentsReadGen ? w.gen : momentsReadGen') && write.includes('if (cacheGeneration() !== gen) return'), 'armed only under the generation of its read (or its own prune bump)')
  t.ok(write.indexOf('w.readGen = momentsReadGen') < write.indexOf('if (!followsReady || !momentsBlocksOk) return') && write.indexOf('if (!followsReady || !momentsBlocksOk) return') < write.indexOf('setTimeout('), 'armed, but not started before the follow set and the block list are known')
  t.ok(write.includes("const momentsBlocksOk = blocks.loadState === 'ok'") && write.includes("blocksOk: blocks.loadState === 'ok' }"), 'the write waits for block.list to answer')
  const fire = write.slice(write.indexOf('setTimeout('))
  const skip = fire.indexOf('if (!latest.followsReady || !latest.blocksOk || followed === null) return')
  t.ok(skip > 0 && skip < fire.indexOf('w.done = latest.authors'), 'a write skipped for the follow set is not done')
  t.ok(member.includes('const followsReady = followsAt !== null && followsAt === followsNow'), 'the follow set of the follows version now')
  const timer = write.slice(write.indexOf('setTimeout('))
  t.ok(timer.includes('const followed = followSetRef.current') && timer.includes('if (!latest.followsReady || !latest.blocksOk || followed === null) return'), 'followed = the last complete follow.list when the timer runs, never one captured at render')
  t.absent(write.includes('latest.followed'))
  t.ok(write.includes('momentsOwn, followsReady, momentsBlocksOk])'), 'the write starts once the follow set and the block list load')
  t.ok(write.includes('setTimeout(') && write.includes('SNAPSHOT_DEBOUNCE_MS'))
  t.ok(write.indexOf('sessionAllowsSnapshot(latest.passkey, latest.binding.owner)') < write.indexOf('buildScreenSnapshot('), 'the session is checked when it runs')
  t.ok(write.includes("buildScreenSnapshot('momentos', { ...latest.binding, acting: latest.acting, authors: latest.authors, own: latest.own, names: latest.profileOf, followed, blocked: latest.blocked })"))
  t.ok(write.includes("saveScreenSnapshot('momentos', snapshot, g)"))
  t.absent(/saveScreenSnapshot\([^)]*\)[\s\S]*saveScreenSnapshot\(/.test(write), 'a refused save is not retried')
  t.ok(write.includes('if (!sessionOk || binding === null) {') && write.includes('clearTimeout(w.timer)'), 'a lock cancels the armed write')
  const onFollows = member.slice(member.indexOf('const onFollows = useCallback'), member.indexOf('const social = useSocial('))
  t.ok(onFollows.includes('if (moment.gen !== null && moment.gen === before) moment.gen = cacheGeneration()'), 'its own prune bump is adopted')
  for (const name of ['loadScreenSnapshot', 'saveScreenSnapshot', 'buildScreenSnapshot', 'seed: boot']) t.absent(page.includes(name), 'PageARua: ' + name)
})

test('a cached momento of a blocked or muted author never shows on the seeded strip', async (t) => {
  const { cachedRowsShown } = await import('../src/cachedRows.js')
  const authors = [{ author: FOLLOW, items: [] }, { author: GONE, items: [] }, { author: OWN, items: [] }]
  const show = (o) => cachedRowsShown(authors, { owner: OWN, authorsOf: (a) => [a.author], ...o }).map((a) => a.author)
  t.alike(show({ loadState: 'pending', blocked: new Set() }), [OWN], 'pending: only the own ring')
  t.alike(show({ loadState: 'ok', blocked: new Set([GONE]), muted: new Set([FOLLOW]) }), [OWN])
  t.alike(show({ loadState: 'ok', blocked: new Set(), muted: new Set() }), [FOLLOW, GONE, OWN])
})

test('seededNeeds: an unverified cached row is never stored as an original, a reply parent among them is read', async (t) => {
  const paging = await import('../src/paging.js')
  const needs = helper('seededNeeds', { feedKey: paging.feedKey }, ['refOf', 'pageNeeds'])
  const confirmed = { ...post(FOLLOW, 9), quote: { author: FOLLOW, seq: 3 } }
  const cached = post(FOLLOW, 3)
  const reply = { ...post(OWN, 8), replyTo: { author: FOLLOW, seq: 3 } }
  const n = needs([confirmed, reply, cached], [FOLLOW + ':3'])
  t.ok(n.local.has(FOLLOW + ':9') && n.local.has(OWN + ':8'), 'confirmed rows are originals')
  t.absent(n.local.has(FOLLOW + ':3'), 'the unverified row is not: a quote of it passes diary.peek')
  t.ok(n.need.includes(FOLLOW + ':3'), 'the quote of it is resolved')
  t.ok(n.parents.includes(FOLLOW + ':3'), 'a reply parent that is an unverified row is read')
  t.ok(n.shown.includes(FOLLOW + ':3'), 'its counts are still asked for')
  const all = needs([confirmed, reply, cached], [])
  t.ok(all.local.has(FOLLOW + ':3') && !all.parents.includes(FOLLOW + ':3'), 'nothing unverified: pageNeeds as is')
})

test('walkPage adds live rows inside the cached range, never above the top row nor below the cursor', async (t) => {
  const walkPage = await walkHelper(25)
  const items = [post(FOLLOW, 20), post(FOLLOW, 10), post(FOLLOW, 5)]
  const prev = { items, unverified: [FOLLOW + ':10', FOLLOW + ':5'], cursor: { at: items[2].at, author: FOLLOW, seq: 5 }, newer: 1 }
  // Read from the top: one row newer than the top, two in the gaps, one below the cursor.
  const page = answer([post(FOLLOW, 30), post(FOLLOW, 20), post(GONE, 15), post(FOLLOW, 10), post(GONE, 7), post(FOLLOW, 5), post(GONE, 2)])
  const r = walkPage(prev, page, null, [post(FOLLOW, 30)])
  t.alike(keys(r.patch.items), [FOLLOW + ':20', GONE + ':15', FOLLOW + ':10', GONE + ':7', FOLLOW + ':5'], 'the gap rows join in place')
  t.absent(keys(r.patch.items).includes(GONE + ':2'), 'a row below the cursor comes by scrolling')
  t.absent(keys(r.patch.items).includes(FOLLOW + ':30'), 'a newer row waits behind the pill')
  t.is(r.patch.newer, 1)
  t.alike(r.patch.unverified, [], 'the cached rows it returned are confirmed')
  t.alike(keys(r.fresh).sort(), [GONE + ':15', GONE + ':7', FOLLOW + ':10', FOLLOW + ':5'].sort(), 'confirmed and added rows are ingested; the confirmed top row was already')
  t.alike(keys(r.held), [FOLLOW + ':30'], 'a held row is kept once')
})

test('walkPage: when every cached row left, the held newer rows become the list', async (t) => {
  const walkPage = await walkHelper(25)
  const items = [post(FOLLOW, 9), post(FOLLOW, 8)]
  const prev = { items, unverified: keys(items), cursor: { at: items[1].at, author: FOLLOW, seq: 8 }, newer: 2 }
  const held = [post(GONE, 12), post(GONE, 11)]
  // A complete last page below the first page: nothing of the cache.
  const r = walkPage(prev, answer([post(GONE, 1)]), { at: post(GONE, 11).at, author: GONE, seq: 11 }, held)
  t.alike(keys(r.patch.items), [GONE + ':12', GONE + ':11'], 'the held rows are the list, never an empty feed')
  t.is(r.patch.newer, 0)
  t.alike(r.patch.unverified, [])
  t.alike(r.patch.cursor, { at: post(GONE, 11).at, author: GONE, seq: 11 }, 'scrolling continues below them')
  t.is(r.patch.atEnd, false)
  t.alike(keys(r.fresh), [GONE + ':12', GONE + ':11'])
  const none = walkPage(prev, answer([post(GONE, 1)]), { at: post(GONE, 11).at, author: GONE, seq: 11 }, [])
  t.alike(keys(none.patch.items), [GONE + ':1'], 'nothing held: the page rows are the list')
  const empty = walkPage(prev, answer([]), { at: post(GONE, 11).at, author: GONE, seq: 11 }, [])
  t.alike(empty.patch.items, [], 'an empty last page: the list is empty')
  t.is(empty.patch.atEnd, true, 'and ends')
})

test('walkPage: a first live page empty and incomplete, then a walk of only older rows, never leaves an empty feed', async (t) => {
  const { seededFirstPage } = await settleHelpers()
  const walkPage = await walkHelper(25)
  const cached = [post(FOLLOW, 10), post(FOLLOW, 9)]
  const first = seededFirstPage(cached, answer([], { incomplete: [FOLLOW] }))
  t.alike(keys(first.patch.items), keys(cached), 'the cached rows stay over an empty incomplete page')
  t.is(first.patch.atEnd, true)
  t.is(first.first.complete, false, 'the walk starts from the top')
  const prev = { items: first.patch.items, unverified: first.patch.unverified, cursor: first.patch.cursor, newer: first.patch.newer }
  const r = walkPage(prev, answer([post(FOLLOW, 8), post(FOLLOW, 7)]), null, first.first.held)
  t.alike(keys(r.patch.items), [FOLLOW + ':8', FOLLOW + ':7'], 'the deleted cached rows leave and the page rows, older than the cached cursor, are the list')
  t.alike(r.patch.unverified, [])
  t.alike(r.patch.cursor, { at: post(FOLLOW, 7).at, author: FOLLOW, seq: 7 }, 'scrolling continues below the page')
  t.is(r.patch.atEnd, true, 'a short page is the end')
  t.alike(keys(r.fresh), [FOLLOW + ':8', FOLLOW + ':7'], 'the new list is learned and ingested')
  const full = Array.from({ length: 25 }, (_, i) => post(FOLLOW, 8 - (i + 1) / 100))
  const more = walkPage(prev, answer(full), null, [])
  t.is(more.patch.items.length, 25)
  t.is(more.patch.atEnd, false, 'a full page is not the end')
  const none = walkPage(prev, answer([], { incomplete: [FOLLOW] }), null, [])
  t.alike(keys(none.patch.items), keys(cached), 'an incomplete empty page drops nothing')
})

test('a confirm walk stopped at its page cap goes on through the sync planner without diary growth', async (t) => {
  const paging = await import('../src/paging.js')
  const walk = walkHelper2(paging, 2)
  const full = (hi) => answer([post(GONE, hi), post(GONE, hi - 1)])
  const pages = [full(20), full(18), full(16), full(14)]
  let n = 0
  const r = await walk(() => Promise.resolve(pages[n++]), null, () => 2, () => false)
  t.alike(r, { outcome: 'partial', resume: paging.cursorOf(pages[3].items), capped: true }, 'every page complete: capped')
  n = 0
  const syncing = await walk(() => Promise.resolve(n++ === 1 ? { ...pages[1], incomplete: [GONE] } : pages[n - 1]), null, () => 2, () => false)
  t.is(syncing.capped, false, 'an incomplete page waits for the sync growth instead')
  const fn = member.slice(member.indexOf('const confirmUnverified = useCallback'), member.indexOf('const unverifiedLeft'))
  t.ok(fn.includes("if (outcome === 'partial' && r.capped && mine === seqRef.current) commit({ rangeFrom: r.resume, deep: true })"), 'the capped continuation is handed to the planner')
  const items = [post(FOLLOW, 3), post(FOLLOW, 2)]
  const feed = { loadedAt: 1, loading: false, loadingMore: false, refreshing: false, loadError: '', moreError: '', items, deep: true, probeOlder: false, atEnd: true, syncBase: {}, syncTruncated: 0, emptyStreak: 0, rangeFrom: r.resume }
  t.ok(paging.planSyncRead(feed, {}, true, 25) !== null, 'a range read is planned with no growth')
  t.is(paging.planSyncRead({ ...feed, rangeFrom: null }, {}, true, 25), null, 'without it nothing would be read')
  t.is(paging.planSyncRead(feed, {}, true, 25).kind, 'range')
  const start = helper('rangeReadStart', { rangeStart: paging.rangeStart, compareFeed: paging.compareFeed, feedKey: paging.feedKey })
  t.alike(start(items, r.resume, keys(items)), r.resume, 'it reads on from where the walk stopped')
})

test('a complete range read that reaches the end drops a deleted unverified head and tail', async (t) => {
  const paging = await import('../src/paging.js')
  const start = helper('rangeReadStart', { rangeStart: paging.rangeStart, compareFeed: paging.compareFeed, feedKey: paging.feedKey })
  const cached = Array.from({ length: 25 }, (_, i) => post(FOLLOW, 25 - i))
  const unverified = keys(cached)
  const live = cached.slice(1, 24)
  t.is(start(cached, null, unverified), null, 'an unverified top row: the read starts at the top')
  t.alike(start(cached, null, unverified.slice(1)), paging.cursorOf([cached[0]]), 'a confirmed top row: below it, as before')
  const below = paging.cursorOf([cached[10]])
  t.alike(start(cached, below, unverified), below, 'a capped continuation goes on where it stopped')
  // The read loadRange makes from the top: one short complete page of 23 rows.
  const page = answer(live)
  const step = paging.rangeStep({ page, limit: 25, until: paging.cursorOf([cached[24]]), pages: 1, cap: 3 })
  t.is(step, 'end')
  const s = paging.settleSpan({ items: cached, unverified, page: paging.resetWith(page.items), complete: true, from: start(cached, null, unverified), to: paging.cursorOf(page.items), end: step === 'end' })
  t.alike(keys(s.items), keys(live), 'the deleted newest and oldest rows both left')
  t.alike(s.unverified, [])
})

test('MemberARua: onFollows records the follows version its set was read at', (t) => {
  const onFollows = member.slice(member.indexOf('const onFollows = useCallback'), member.indexOf('const social = useSocial('))
  t.ok(onFollows.indexOf('setFollowsAt(followsNowRef.current)') > onFollows.indexOf('followSetRef.current = allowed'))
  t.ok(onFollows.indexOf('setFollowsAt(followsNowRef.current)') < onFollows.indexOf('if (reconciledFollows === id) return'), 'also when the set did not change')
})

test('a confirm walk stopped by a short incomplete page goes on later and drops the deleted row', async (t) => {
  const paging = await import('../src/paging.js')
  const walk = walkHelper2(paging, 25)
  const walkPage = await walkHelper(25)
  const at = (ms) => new Date(Date.UTC(2026, 10, 2) - ms).toISOString()
  const rows = Array.from({ length: 10 }, (_, i) => ({ ...post(FOLLOW, 100 - i), at: at(i * 1000) }))
  const deleted = { ...post(FOLLOW, 500), at: at(4500) }
  const cached = rows.concat([deleted]).sort((a, b) => paging.compareFeed(b, a))
  let feed = { items: cached, unverified: keys(cached), cursor: paging.cursorOf([cached[cached.length - 1]]), newer: 0 }
  let held = []
  const settle = (page, from) => {
    const w = walkPage(feed, page, from, held)
    held = w.held
    feed = { ...feed, ...w.patch }
    return w.patch.unverified.length
  }
  // Still syncing: a short page that misses the deleted row settles nothing it did not return.
  const syncing = await walk(() => Promise.resolve(answer(rows, { incomplete: [FOLLOW] })), null, settle, () => false)
  t.alike(syncing, { outcome: 'partial', resume: null, capped: false }, 'not done: it goes on from the top later')
  t.ok(keys(feed.items).includes(FOLLOW + ':500'), 'the deleted row still waits')
  t.alike(feed.unverified, [FOLLOW + ':500'])
  const later = await walk(() => Promise.resolve(answer(rows)), syncing.resume, settle, () => false)
  t.alike(later, { outcome: 'done' })
  t.absent(keys(feed.items).includes(FOLLOW + ':500'), 'the complete page drops it')
  t.alike(keys(feed.items), keys(rows))
})

test('rangeReadStart goes on from a capped continuation above an unverified top row', async (t) => {
  const paging = await import('../src/paging.js')
  const start = helper('rangeReadStart', { rangeStart: paging.rangeStart, compareFeed: paging.compareFeed, feedKey: paging.feedKey })
  const cached = [post(FOLLOW, 9), post(FOLLOW, 8)]
  // A capped read from the top stopped among rows newer than the top row.
  const above = paging.cursorOf([post(GONE, 30)])
  t.alike(start(cached, above, keys(cached)), above, 'where it stopped, not the top again')
  t.is(start(cached, null, keys(cached)), null, 'no continuation: from the top')
  t.alike(start(cached, above, [FOLLOW + ':8']), paging.cursorOf([cached[0]]), 'a confirmed top row: below it, as before')
})

test('a range read that removes every cached row makes the newer rows the list', async (t) => {
  const paging = await import('../src/paging.js')
  const keep = helper('keepOrHeld', { cursorOf: paging.cursorOf })
  const add = helper('addHeld', { feedKey: paging.feedKey, compareFeed: paging.compareFeed })
  const cached = [post(FOLLOW, 9), post(FOLLOW, 8)]
  const prev = { items: cached, unverified: keys(cached), cursor: paging.cursorOf([cached[1]]), newer: 0 }
  // loadRange from the top: one short complete page of rows newer than the cache only.
  const rows = answer([post(GONE, 12), post(GONE, 11)]).items
  const merged = paging.mergeRange(prev.items, rows)
  t.is(merged.newer.length, 2)
  const settled = paging.settleSpan({ items: merged.items, unverified: prev.unverified, page: paging.resetWith(rows), complete: true, from: null, to: paging.cursorOf(rows), end: true })
  t.alike(settled.items, [], 'every cached row left')
  const kept = keep(settled, add([], paging.resetWith(rows), new Set(merged.newer)), Math.max(prev.newer, merged.newer.length))
  t.ok(kept.replaced)
  t.alike(keys(kept.patch.items), [GONE + ':12', GONE + ':11'], 'never an empty A Rua while posts exist')
  t.is(kept.patch.newer, 0)
  t.alike(kept.patch.unverified, [])
  t.alike(kept.patch.cursor, paging.cursorOf([post(GONE, 11)]))
  t.is(kept.patch.atEnd, false)
  const rest = keep({ items: [cached[0]], unverified: [] }, [post(GONE, 12)], 1)
  t.absent(rest.replaced, 'rows left: the newer ones wait behind the pill')
  t.alike(rest.patch, { items: [cached[0]], unverified: [], newer: 1 })
})

test('a short incomplete first page and an incomplete walk: the next sync tick still plans a read', async (t) => {
  const { paging, seededFirstPage } = await settleHelpers()
  const walk = walkHelper2(paging, 25)
  const walkPage = await walkHelper(25)
  const at = (ms) => new Date(Date.UTC(2026, 10, 2) - ms).toISOString()
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...post(FOLLOW, 100 - i), at: at(i * 1000) }))
  const deleted = { ...post(FOLLOW, 500), at: at(10000) }
  const cached = rows.concat([deleted])
  const page = answer(rows, { incomplete: [FOLLOW] })
  const r = seededFirstPage(cached, page)
  t.alike(r.patch.unverified, [FOLLOW + ':500'])
  t.is(r.patch.atEnd, true, 'a short live page: the list is at its end')
  const idle = { loadedAt: 1, loading: false, loadingMore: false, refreshing: false, loadError: '', moreError: '', deep: false, probeOlder: false, rangeFrom: null, emptyStreak: 0, syncTruncated: 0 }
  let feed = { ...idle, ...r.patch, syncBase: paging.syncBaseline(page, { [FOLLOW]: 5 }) }
  let held = r.first.held
  const outcome = await walk(() => Promise.resolve(page), null, (p, from) => {
    const w = walkPage(feed, p, from, held)
    held = w.held
    feed = { ...feed, ...w.patch }
    return w.patch.unverified.length
  }, () => false)
  t.is(outcome.outcome, 'partial', 'the walk stops incomplete')
  t.ok(feed.items.some((i) => i.seq === 500), 'the deleted row still waits')
  t.is(paging.planSyncRead(feed, { [FOLLOW]: 5 }, true, 25), null, 'no growth: no read')
  const plan = paging.planSyncRead(feed, { [FOLLOW]: 6 }, true, 25)
  t.ok(plan !== null && plan.kind === 'newest', 'growth plans the newest read, which settles the list from the top')
})

// socialRowProps with the screen's pure imports, the rest stubbed.
async function compileRowProps () {
  const { replyMarkOf } = await import('../src/who.js')
  const { cachedRow } = await import('../src/namesCache.js')
  const { commentedLabel, knownReplies } = await import('../src/feedFold.js')
  const body = [fnText(CODE, 'refOf'), fnText(CODE, 'withActions'), fnText(CODE, 'socialRowProps')].join('\n')
  // eslint-disable-next-line no-new-func
  return new Function('replyMarkOf', 'cachedRow', 'commentedLabel', 'knownReplies', 'pickAvatar', 'installationOrigin', 'postLink', 'actingPageKey', 'canDelete',
    body + '\nreturn socialRowProps')(replyMarkOf, cachedRow, commentedLabel, knownReplies, () => null, () => null, () => null, () => null, () => false)
}

test('a stranger quote under a copy row is kept as copy, a followed one as followed', async (t) => {
  const socialRowProps = await compileRowProps()
  const quoted = { ...post(GONE, 3), quote: null }
  const known = new Set([OWN, FOLLOW])
  const social = {
    social: { flags: { indexing: false, complete: true }, counts: new Map(), eng: { liked: new Set(), reposted: new Set() }, pending: new Map() },
    original: (ref) => (ref === GONE + ':3' ? quoted : ref === FOLLOW + ':4' ? { ...post(FOLLOW, 4), quote: null } : undefined),
    transient: () => false,
    pending: () => false,
    persistOf: (author) => known.has(author),
    retry: () => {},
    toggle: () => {},
    notify: undefined
  }
  const row = (quoteAuthor, quoteSeq, strangerPersist) => socialRowProps({
    post: { ...post(FOLLOW, 9), quote: { author: quoteAuthor, seq: quoteSeq } },
    ref: FOLLOW + ':9',
    social,
    profileOf: () => null,
    now: 0,
    ownKey: OWN,
    h: {},
    persist: true,
    ...(strangerPersist === undefined ? {} : { strangerPersist })
  })
  t.is(row(GONE, 3, 'copy').quote.persist, 'copy', 'an unknown quote author under a copy row')
  t.is(row(FOLLOW, 4, 'copy').quote.persist, true, 'a followed quote author stays kept as followed')
  t.is(row(GONE, 3, 'peek').quote.persist, 'peek', 'peek still passes through')
  t.is(row(GONE, 3).quote.persist, false, 'nothing passed: never kept')
  t.is(row(GONE, 3, true).quote.persist, false, 'only peek or copy pass through')
})

test('A Rua\'s member list and its preview pass copy for stranger originals; the page list passes none', (t) => {
  t.is((member.match(/strangerPersist: 'copy'/g) || []).length, 3, 'the fold row, the repost row and the post row')
  t.ok(member.includes("foldRowView(item, { social, profileOf: names.profileOf, now, ownKey, h: handlers, cache: rowCache, strangerPersist: 'copy' })"), 'the fold row')
  t.ok(member.includes("fold: fold.attached.get(feedKey(item)) || null, strangerPersist: 'copy' })} />\n    }"), 'the repost row')
  t.ok(member.includes("persist: true, cache: rowCache, rowKey: feedKey(item), fold: fold.attached.get(feedKey(item)) || null, strangerPersist: 'copy' })"), 'the post row keeps persist: true')
  t.absent(page.includes('strangerPersist'), 'PageARua passes none')
  const fold = fnText(CODE, 'foldRowView')
  t.ok(fold.includes('persist, strangerPersist = false }) {'), 'the fold row takes it, off by default')
  t.ok(fold.includes('fold: item, strangerPersist })'), 'and hands it to socialRowProps')
  const preview = fnText(CODE, 'ARuaPreview')
  t.is((preview.match(/strangerPersist: 'copy'/g) || []).length, 3, 'the preview\'s three rows')
  t.is((preview.match(/persist: true/g) || []).length, 2, 'the rows with an explicit persist keep it')
  t.ok(/persistOf: \(\) => 'copy',/.test(fnText(CODE, 'previewSocial')), 'previewSocial answers copy')
  t.ok(CODE.includes('const persistOf = useCallback((author) => typeof author === \'string\' && isKnown(author.toLowerCase()), [isKnown])'), 'useSocial\'s persistOf is unchanged')
  t.ok(CODE.includes('persistOf: social.persistOf,') && CODE.includes('isKnown: latest.persistOf,'), 'and it is still the isKnown of the snapshot build')
})
