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
  const read = member.indexOf('readSnapshot(liveBinding(ownKey, node.config))')
  t.ok(read > 0, 'read in the first render')
  t.ok(read < member.indexOf('const loadNewest = useCallback'), 'before loadNewest exists')
  const reader = fnText(CODE, 'readSnapshot')
  t.ok(/if \(binding === null\) return null/.test(reader), 'no read without a binding (the Vitrine has none)')
  t.ok(reader.indexOf('parseSnapshot(') > 0)
  t.ok(/clearSnapshot\(\)/.test(reader), 'a text that does not parse is cleared')
  t.ok(/initialFeedState\(boot\.snapshot\)/.test(member), 'the feed starts from the snapshot rows')
  t.ok(/seed: boot\.social/.test(member) && /socialSeed\(snapshot\)/.test(member), 'useSocial gets the social seed')
})

test('the snapshot path lifts the boot cover at once and learns the names', (t) => {
  const at = member.indexOf('const snapshot = boot.snapshot')
  t.ok(at > 0)
  const effect = member.slice(at, member.indexOf('}, [])', at))
  t.ok(effect.includes("onBoot('page')") && effect.includes("onBoot('details')"))
  t.ok(effect.includes("perfMarks().mark('rows-snapshot')"))
  t.ok(effect.includes('seedMany(Object.entries(snapshot.names))'), 'seeds only for authors not known yet')
  t.absent(effect.includes('learnMany('), 'never learnMany: it would overwrite a newer entry')
  t.ok(member.includes("perfMarks().mark('rows-live')"), 'the first live page is marked')
})

test('the snapshot write is guarded by cacheGeneration and debounced', (t) => {
  const write = member.slice(member.indexOf('const writeSnapshot = useCallback'), member.indexOf('useEffect(() => () => clearTimeout(writeRef.current.timer)'))
  t.ok(write.includes('pending.gen !== cacheGeneration()'), 'a purge since arming drops the write')
  t.ok(write.includes('pendingWriteRef.current = { gen: cacheGeneration() }'), 'the generation is taken when armed')
  t.ok(member.includes("const snapHead = useMemo(() => (loadedAt === null ? null : loadedAt + '|' + items.slice(0, FEED_LIMIT_DEFAULT).map(feedKey).join()), [items, loadedAt])"), 'any change of the live first page (quiet, range or delete) rewrites')
  t.ok(write.includes('w.done === snapKey') && write.includes('w.head = snapKey'), 'the key is the head plus the stored content digest')
  t.ok(member.includes("snapHead + '#' + snapshotDigest(items.slice(0, FEED_LIMIT_DEFAULT), socialState, names.profileOf)"))
  t.absent(/snapTick/.test(member), 'no trigger tied to one kind of read')
  t.ok(write.includes('setTimeout(writeSnapshot, SNAPSHOT_DEBOUNCE_MS)'))
  t.ok(write.includes('feedDetailsReady('), 'only once the first rows have their details')
  t.ok(write.includes('buildSnapshot('))
  t.ok(/const SNAPSHOT_DEBOUNCE_MS = 2000/.test(CODE))
  t.ok(/blocked: latest\.blocked/.test(write), 'the block list in force')
})

test('the snapshot is read and written on every platform: previewCapable is not consulted', (t) => {
  t.absent(/\bpreviewCapable\b/.test(CODE), 'ARua.js')
  t.absent(/\bpreviewCapable\b/.test(withoutComments(APP_JS)), 'App.js')
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
  t.ok(/\nregisterLocalCache\(\{\n {2}wipe: clearSnapshot,/.test(CODE))
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
  t.ok(/const complete = Array\.isArray\(r\.follows\) && Number\.isSafeInteger\(r\.total\) && r\.follows\.length === r\.total/.test(social))
  t.ok(/if \(complete && set === knownRef\.current && typeof onFollowsRef\.current === 'function'\)/.test(social), 'a partial list calls nothing')
  t.ok(/request\('follow\.list', \{ offset: 0, limit: FOLLOW_LIMIT_MAX \}\)/.test(social), 'the list starts at offset 0')
})

test('App.js seeds the own name from the snapshot before profile.read', (t) => {
  const code = withoutComments(APP_JS)
  t.ok(code.includes("import ARua, { liveBinding } from './src/screens/ARua'"), 'the same binding rule as A Rua')
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
