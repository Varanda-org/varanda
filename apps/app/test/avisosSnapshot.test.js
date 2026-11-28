'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { compileFunction } = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/screens/Avisos.js'), 'utf8')
const OWN = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const binding = { origin: 'https://example.test', association: 'c'.repeat(64), owner: OWN, acting: { kind: 'me' } }
const AVATAR = { core: '56'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: '78'.repeat(32), width: 512, height: 512 }
const PEEK = { ...AVATAR, sha256: '9a'.repeat(32) }
const row = (seq, extra = {}) => ({ key: PEER, seq, at: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(), seen: seq.toString(16).padStart(32, '0'), name: 'Pessoa', username: null, ...extra })
const page = (notices, next = null, extra = {}) => ({ notices, next, ...extra })

// Run the screen's callbacks with controlled reads and timers, without React Native.
function section (start, end) {
  const a = source.indexOf(start)
  if (a < 0) throw new Error('Missing screen section: ' + start)
  const b = source.indexOf(end, a + start.length)
  if (b < 0) throw new Error('Missing end: ' + end)
  return source.slice(a + start.length, b)
}

function evaluate (expression, env) {
  return compileFunction('return (' + expression + ')', Object.keys(env))(...Object.values(env))
}

function screenHandler (name, env) {
  return evaluate(section('const ' + name + ' = useCallback(', '\n  }, [') + '\n}', env)
}

function seededNoticesFn (env) {
  return evaluate('function (binding) {' + section('function seededNotices (binding) {', '\n}') + '\n}', env)
}

async function noticesForStorageFromSource () {
  const { pickAvatar } = await import('../src/media/avatar.js')
  const { rowAvatarSource } = await import('../src/notices.js')
  return evaluate('function (items, profileOf, avatars) {' + section('export function noticesForStorage (items, profileOf, avatars) {', '\n}') + '\n}', { pickAvatar, rowAvatarSource })
}

function storedNoticesFn (env) {
  return evaluate('function (state, held, profileOf, avatars) {' + section('function storedNotices (state, held, profileOf, avatars) {', '\n}') + '\n}', env)
}

async function harness (items = [row(3), row(1)]) {
  const notices = await import('../src/notices.js')
  const paging = await import('../src/paging.js')
  const env = { ...notices, ...paging }
  env.prependNew = evaluate('function (currentItems, pageItems) {' + section('function prependNew (currentItems, pageItems) {', '\n}') + '\n}', env)
  env.confirmedNotices = evaluate('function (items, unverified) {' + section('function confirmedNotices (items, unverified) {', '\n}') + '\n}', env)
  const settled = []
  const armed = []
  const stateRef = { current: { items, seeded: true, unverified: items.map(notices.noticeId), newer: 0, loadedAt: null, next: null } }
  Object.assign(env, {
    stateRef,
    heldRef: { current: [] },
    cursorRowRef: { current: undefined },
    seqRef: { current: 0 },
    pageKeyRef: { current: null },
    corePageRef: { current: false },
    ownKeyRef: { current: OWN },
    activeRef: { current: true },
    backoffRef: { current: false },
    active: true,
    hosted: true,
    node: { epoch: 1 },
    binding,
    cacheGeneration: () => 10,
    cancelSave: () => {},
    armSave: (gen, b) => armed.push({ gen, b }),
    setAvatarCycle: () => {},
    badge: () => {},
    commit: (patch) => { stateRef.current = { ...stateRef.current, ...patch } },
    settle: (items, ...args) => settled.push({ items, args }),
    isSeederBusyError: () => false,
    isLockedError: () => false,
    isBusyError: () => false,
    errorText: (err) => err.message,
    read: async () => page([])
  })
  return { env, settled, armed, stateRef }
}

test('Avisos seeds only a personal member binding and leaves every cached row unverified', async (t) => {
  const { noticeId } = await import('../src/notices.js')
  const init = section('const [state, setState] = useState(', '\n  const { items,')
  const expression = init.slice(0, init.lastIndexOf(')'))
  let reads = 0
  const env = {
    binding,
    noticeId,
    loadScreenSnapshot: (kind, b) => {
      t.is(kind, 'avisos')
      t.is(b, binding)
      reads++
      return { body: { notices: [row(3), row(1)] } }
    }
  }
  env.seededNotices = seededNoticesFn(env)
  const state = evaluate(expression, env)()
  t.is(state.loadedAt, null)
  t.is(state.seeded, true)
  t.is(state.newer, 0)
  t.alike(state.unverified, state.items.map(noticeId))
  const empty = evaluate(expression, { ...env, binding: null, seededNotices: seededNoticesFn({ ...env, binding: null }) })()
  t.alike(empty.items, [])
  t.is(reads, 1, 'no binding never reads the store')
  t.ok(source.includes('const binding = memberSnapshotBinding({ node, acting, pageKey })'))
})

test('seeded partial pages never paint or settle, and a failed continuation leaves the copy unconfirmed', async (t) => {
  const h = await harness()
  let failRead
  h.env.read = (mine, after, onPage) => {
    onPage(page([row(4), row(3)], 'cursor'))
    return new Promise((resolve, reject) => { failRead = reject })
  }
  const loading = screenHandler('loadFirst', h.env)()
  t.alike(h.settled, [])
  t.alike(h.stateRef.current.items, [row(3), row(1)])
  t.is(h.stateRef.current.loadedAt, null)
  failRead(new Error('offline'))
  await loading
  t.alike(h.settled, [], 'painted stayed false, so the catch cannot settle the copy')
  t.is(h.stateRef.current.seeded, true)
  t.is(h.stateRef.current.loadError, 'offline')
  t.alike(h.armed, [])
})

test('first answer and polls leave held notices unseen until the pill is pressed', async (t) => {
  const h = await harness()
  const events = []
  h.env.cacheGeneration = () => { events.push('generation'); return 12 }
  h.env.read = async (mine, after, onPage) => {
    events.push('request')
    onPage(page([row(5), row(3)], 'cursor'))
    return page([row(5), row(3)], 'cursor')
  }
  await screenHandler('loadFirst', h.env)()
  t.alike(events, ['generation', 'request'])
  t.alike(h.armed, [{ gen: 12, b: binding }])
  t.alike(h.stateRef.current.items, [row(3), row(1)], 'the older tail stays')
  t.alike(h.stateRef.current.unverified, [h.env.noticeId(row(1))])
  t.alike(h.env.heldRef.current, [row(5)])
  t.is(h.stateRef.current.newer, 1)
  t.alike(h.settled.map((s) => s.items), [[row(3)]])
  const updated = row(3, { name: 'Atualizada' })
  h.env.read = async () => page([row(6), row(5), updated], 'cursor')
  h.env.loadFirst = () => t.fail('held poll must not replace the list')
  await screenHandler('poll', h.env)()
  t.alike(h.env.heldRef.current, [row(6), row(5)])
  t.is(h.stateRef.current.newer, 2)
  t.alike(h.stateRef.current.items, [updated, row(1)])
  t.alike(h.settled[1].items, [updated])
  h.env.activeRef.current = false
  await screenHandler('poll', h.env)()
  t.alike(h.settled[2].items, [updated], 'a hidden poll never passes held rows to settle either')
  const scrolls = []
  h.env.listRef = { current: { scrollToOffset: (opts) => scrolls.push(opts) } }
  evaluate('() => {' + section('const takeHeld = () => {', '\n  }') + '\n}', h.env)()
  t.alike(h.env.heldRef.current, [])
  t.is(h.stateRef.current.newer, 0)
  t.alike(h.settled[3].items, [row(6), row(5), updated])
  t.alike(scrolls, [{ offset: 0, animated: true }])
  t.ok(source.includes("newItems={{ label: 'ver novidades', visible: newer > 0, onPress: takeHeld }}"))
})

test('pagination reconciles the live cursor span and settles only confirmed rows', async (t) => {
  const h = await harness([row(5), row(3), row(2), row(1)])
  h.env.read = async () => page([row(6), row(5)], 'first')
  await screenHandler('loadFirst', h.env)()
  h.env.read = async (mine, after) => {
    t.is(after, 'first')
    return page([row(3, { name: 'Live' })], 'second')
  }
  await screenHandler('loadMore', h.env)()
  t.alike(h.stateRef.current.unverified, [row(2), row(1)].map(h.env.noticeId))
  t.alike(h.settled[1].items, [row(5), row(3, { name: 'Live' })])
  h.env.read = async () => page([row(1)])
  await screenHandler('loadMore', h.env)()
  t.alike(h.stateRef.current.items.map((n) => n.seq), [5, 3, 1], 'a complete final span removes the missing cached row')
  t.alike(h.stateRef.current.unverified, [])
  t.absent(h.settled.flatMap((s) => s.items).some((n) => n.seq === 6), 'paging never settles the held first-page notice')
})

test('a replacement and a later refresh clear all held and unverified state', async (t) => {
  const h = await harness()
  h.env.read = async () => page([row(5)])
  await screenHandler('loadFirst', h.env)()
  t.alike(h.stateRef.current.items, [row(5)], 'complete disjoint page replaces the copy')
  t.alike(h.env.heldRef.current, [])
  t.alike(h.stateRef.current.unverified, [])
  t.alike(h.settled[0].items, [row(5)])
  h.env.heldRef.current = [row(7)]
  h.env.commit({ newer: 1, unverified: [h.env.noticeId(row(5))] })
  h.env.read = async () => page([row(8), row(7)])
  await screenHandler('loadFirst', h.env)()
  t.alike(h.env.heldRef.current, [])
  t.is(h.stateRef.current.newer, 0)
  t.alike(h.stateRef.current.unverified, [])
})

test('remote seen and every settle path reject a copy before the live answer', async (t) => {
  const h = await harness()
  const start = source.indexOf('// A seen pass brought the marks')
  const effect = source.slice(start, source.indexOf('\n  const loadFirst', start))
  const body = effect.slice(effect.indexOf('useEffect(() => {') + 'useEffect(() => {'.length, effect.indexOf('\n  }, ['))
  evaluate('() => {' + body + '\n}', { stateRef: h.stateRef })()
  t.pass('the remoteSeen effect returns before even reading remote tokens')
  screenHandler('settle', { stateRef: h.stateRef })([row(3)])
  t.pass('settle itself refuses an initial cached paint')
  t.ok(source.includes('list = confirmedNotices(list, stateRef.current.unverified)'), 'show and namespace effects also exclude the unverified tail')
  t.ok(/tail: 'keep',[\s\S]*keyOf: noticeId,[\s\S]*compare: \(a, b\) => compareNotices\(b, a\)/.test(source))
})

test('snapshot debounce saves confirmed and held rows in order and refuses stale generations or bindings', async (t) => {
  const h = await harness()
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const communities = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const same = communities.match(/export function sameSnapshotBinding \(binding, now\) \{([\s\S]*?)\n\}/)[1]
  const sameSnapshotBinding = evaluate('function (binding, now) {' + same + '}', {})
  let gen = 20
  let now = binding
  let timer = null
  const saves = []
  h.env.commit({ items: [row(3), row(1)], unverified: [h.env.noticeId(row(1))], loadedAt: 1 })
  h.env.heldRef.current = [row(5)]
  Object.assign(h.env, {
    saveRef: { current: null },
    blocksRef: { current: { loadState: 'ok', keys: new Set() } },
    nodeRef: { current: {} },
    actingGet: () => ({ kind: 'me' }),
    memberSnapshotBinding: () => now,
    sameSnapshotBinding,
    buildScreenSnapshot,
    cacheGeneration: () => gen,
    setTimeout: (fn, ms) => { t.is(ms, 2000); timer = fn; return 1 },
    saveScreenSnapshot: (...args) => { saves.push(args); return false },
    noticesForStorage: await noticesForStorageFromSource(),
    profileOfRef: { current: () => undefined },
    avatarsRef: { current: { [PEER]: AVATAR } },
    armedSaveRef: { current: null }
  })
  h.env.storedNotices = storedNoticesFn(h.env)
  const arm = screenHandler('armSave', h.env)
  arm(20, binding)
  timer()
  t.is(saves.length, 1, 'a refused save is attempted once')
  t.is(saves[0][0], 'avisos')
  t.is(saves[0][2], 20)
  t.alike(saves[0][1].body.notices.map((n) => n.seq), [5, 3])
  t.alike(saves[0][1].body.notices.map((n) => n.avatar), [AVATAR, AVATAR], 'the armed save stores the row picture')
  t.is(h.env.saveRef.current, null)
  arm(20, binding)
  gen++
  timer()
  t.is(saves.length, 1, 'a purge during the debounce rejects the write')
  for (const changed of [null, { ...binding, owner: PEER }, { ...binding, origin: 'https://other.test' }, { ...binding, association: PEER }]) {
    arm(gen, binding)
    now = changed
    timer()
    t.is(saves.length, 1, 'lock, page actor, origin, association or owner cannot inherit the save')
  }
  timer = null
  arm(gen - 1, binding)
  t.is(timer, null, 'a purge during the request arms no debounce')
  arm(gen, null)
  t.is(timer, null, 'no binding arms nothing')
  now = binding
  h.env.blocksRef.current.loadState = 'pending'
  arm(gen, binding)
  timer()
  t.is(saves.length, 1, 'unknown blocks never reach storage')
  h.env.blocksRef.current = { loadState: 'ok', keys: new Set([PEER]) }
  arm(gen, binding)
  timer()
  t.alike(saves[1][1].body.notices, [], 'blocked authors are removed at write time')
  t.ok(source.includes('useEffect(() => cancelSave, [cancelSave])'))
  const reset = section('const listBindingRef = useRef(bindingKey)', '\n  // The page read is signed')
  for (const text of ['cancelSave()', 'heldRef.current = []', 'newer: 0', 'unverified: []', 'seeded: false']) t.ok(reset.includes(text), text)
})

test('the shared binding refuses page actors, locked sessions and the Vitrine', (t) => {
  const communities = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
  const body = communities.match(/export function memberSnapshotBinding \(\{ node, acting, pageKey \}\) \{([\s\S]*?)\n\}/)[1]
  const memberSnapshotBinding = evaluate('function ({ node, acting, pageKey }) {' + body + '}', {
    liveBinding: (owner, config) => config === 'vitrine' ? null : { ...binding, owner }
  })
  const member = { node: { passkey: { status: { unlocked: true, publicKey: OWN } } }, acting: { kind: 'me' }, pageKey: null }
  t.alike(memberSnapshotBinding(member), binding)
  t.is(memberSnapshotBinding({ ...member, pageKey: PEER }), null)
  t.is(memberSnapshotBinding({ ...member, acting: { kind: 'page', key: PEER } }), null)
  t.is(memberSnapshotBinding({ ...member, node: { ...member.node, config: 'vitrine' } }), null)
  for (const status of [null, { unlocked: false, publicKey: OWN }, { unlocked: true, signedOut: true, publicKey: OWN }]) {
    t.is(memberSnapshotBinding({ ...member, node: { passkey: { status } } }), null)
  }
})

test('an incomplete answer retains missing cached rows without marking them seen', async (t) => {
  const h = await harness([row(4), row(3), row(1)])
  h.env.read = async () => page([row(5), row(3)], null, { incomplete: true })
  await screenHandler('loadFirst', h.env)()
  t.alike(h.stateRef.current.items, [row(4), row(3), row(1)])
  t.alike(h.stateRef.current.unverified, [row(4), row(1)].map(h.env.noticeId))
  t.alike(h.env.heldRef.current, [row(5)])
  t.alike(h.settled[0].items, [row(3)])
})

test('a hidden poll confirms the cached rows it returns live, without marking them seen', async (t) => {
  const h = await harness([row(3), row(1)])
  h.env.read = async () => page([row(3)], null, { incomplete: true })
  await screenHandler('loadFirst', h.env)()
  t.alike(h.stateRef.current.unverified, [h.env.noticeId(row(1))])
  // The real settle filters by the unverified list it reads at call time.
  h.env.settle = (items, ...args) => h.settled.push({ items: h.env.confirmedNotices(items, h.stateRef.current.unverified), args })
  h.env.activeRef.current = false
  h.env.loadFirst = () => t.fail('a hidden poll whose page has no gap does not reload')
  h.env.read = async () => page([row(3), row(1)])
  await screenHandler('poll', h.env)()
  t.alike(h.stateRef.current.unverified, [], 'the live row leaves the unverified list')
  const last = h.settled[h.settled.length - 1]
  t.alike(last.items, [row(3), row(1)], 'settle sees the confirmed row')
  t.alike(last.args, [false, false], 'a hidden poll never marks or shows')
  t.alike(h.stateRef.current.items, [row(3), row(1)], 'the hidden poll does not replace the list')
})

function settleEnv (notices, { seenIds = [], namespace = OWN, active = false, held = [] } = {}) {
  const badges = []
  const env = {
    ...notices,
    stateRef: { current: { loadedAt: 1, unverified: [] } },
    heldRef: { current: held },
    seenNamespaceRef: { current: namespace },
    seenNamespace: namespace,
    settleRef: { current: null },
    activeRef: { current: active },
    lastListRef: { current: null },
    shownListRef: { current: null },
    seenRef: { current: { ids: seenIds.slice() } },
    ownKeyRef: { current: OWN },
    remoteSeenRef: { current: null },
    followsSetRef: { current: null },
    onSeenStateRef: { current: null },
    randomBytes: null,
    loadSeen: () => ({ ids: seenIds.slice() }),
    writeSeen: () => {},
    setUnread: () => {},
    avisoReadRows: () => [],
    badge: (value) => badges.push(value)
  }
  env.remoteFor = evaluate('function (remoteSeen, namespace) {' + section('function remoteFor (remoteSeen, namespace) {', '\n}') + '\n}', env)
  env.confirmedNotices = evaluate('function (items, unverified) {' + section('function confirmedNotices (items, unverified) {', '\n}') + '\n}', env)
  return { env, badges, settle: screenHandler('settle', env) }
}

test('held notices keep the dot on until the pill settles them', async (t) => {
  const notices = await import('../src/notices.js')
  const hidden = settleEnv(notices, { seenIds: [row(3).seen], held: [row(5)] })
  hidden.settle([row(3)])
  t.alike(hidden.badges, [true], 'a hidden settle of seen rows still lights the dot for a new held row')
  const shown = settleEnv(notices, { seenIds: [row(3).seen], held: [row(5)], active: true })
  shown.settle([row(3)])
  t.alike(shown.badges, [true], 'marking the rows on screen does not clear the dot for held rows')
  t.absent(shown.env.seenRef.current.ids.includes(row(5).seen), 'held rows are never marked seen')
  shown.env.heldRef.current = []
  shown.settle([row(5), row(3)])
  t.alike(shown.badges, [true, false], 'after takeHeld the rows are marked and the dot goes off')
  const old = settleEnv(notices, { seenIds: [row(3).seen, row(5).seen], held: [row(5)] })
  old.settle([row(3)])
  t.alike(old.badges, [false], 'a held row seen already lights nothing')
  const anon = settleEnv(notices, { namespace: '', held: [row(5)], active: true })
  anon.settle([])
  t.alike(anon.badges, [true], 'before the identity is known held rows still count')
})

test('a held poll with a gap behind its full page reloads instead of joining held', async (t) => {
  const h = await harness()
  h.env.read = async () => page([row(5), row(3)], 'cursor')
  await screenHandler('loadFirst', h.env)()
  t.alike(h.env.heldRef.current, [row(5)])
  let reloads = 0
  h.env.loadFirst = () => { reloads++ }
  h.env.read = async () => page([row(9), row(8)], 'cursor')
  await screenHandler('poll', h.env)()
  t.is(reloads, 1, 'last row unknown on screen and in held')
  t.alike(h.env.heldRef.current, [row(5)], 'nothing joined held')
  h.env.read = async () => page([row(6), row(5)], 'cursor')
  await screenHandler('poll', h.env)()
  t.is(reloads, 1, 'a page that reaches a held row has no gap')
  t.alike(h.env.heldRef.current, [row(6), row(5)])
})

test('a binding change alone keeps live rows and the read gates, and an unlock seeds an unloaded list', async (t) => {
  const { noticeId } = await import('../src/notices.js')
  const body = section('const listBindingRef = useRef(bindingKey)\n  useEffect(() => {', '\n  }, [actingKey, bindingKey')
  let snapshot = null
  const calls = { badge: [], loads: 0, cancels: 0 }
  const make = (state, { actingKey = '', prevActing = '', bindingKey, prevBinding, b }) => {
    const stateRef = { current: state }
    const env = {
      noticeId,
      binding: b,
      loadScreenSnapshot: () => snapshot,
      actingKey,
      actingKeyRef: { current: prevActing },
      bindingKey,
      listBindingRef: { current: prevBinding },
      cancelSave: () => { calls.cancels++ },
      heldRef: { current: [row(9)] },
      cursorRowRef: { current: row(1) },
      stateRef,
      commit: (patch) => { stateRef.current = { ...stateRef.current, ...patch } },
      setFilter: () => {},
      seqRef: { current: 0 },
      seenRef: { current: {} },
      busyRetryRef: { current: null },
      backoffRef: { current: false },
      clearTimeout: () => {},
      badge: (v) => calls.badge.push(v),
      loadFirstRef: { current: () => { calls.loads++ } }
    }
    env.seededNotices = seededNoticesFn(env)
    evaluate('() => {' + body + '\n}', env)()
    return env
  }
  const lock = make({ items: [row(3), row(1)], unverified: [noticeId(row(1))], seeded: false, newer: 1, loadedAt: 5 }, { bindingKey: '', prevBinding: 'x', b: null })
  t.alike(lock.stateRef.current.items, [row(3)], 'only the unverified copy leaves')
  t.is(lock.stateRef.current.loadedAt, 5)
  t.is(lock.stateRef.current.newer, 0)
  t.alike(lock.heldRef.current, [])
  t.is(calls.cancels, 1)
  t.is(calls.loads, 0, 'no direct read: the first-read gate decides')
  t.alike(calls.badge, [])
  snapshot = { body: { notices: [row(4), row(2)] } }
  const unlock = make({ items: [], unverified: [], seeded: false, newer: 0, loadedAt: null }, { bindingKey: 'x', prevBinding: '', b: binding })
  t.alike(unlock.stateRef.current.items, [row(4), row(2)], 'an unlock before the first load seeds the copy')
  t.is(unlock.stateRef.current.seeded, true)
  t.alike(unlock.stateRef.current.unverified, [row(4), row(2)].map(noticeId))
  t.is(calls.loads, 0)
  const loaded = make({ items: [row(3)], unverified: [], seeded: false, newer: 0, loadedAt: 5 }, { bindingKey: 'x', prevBinding: '', b: binding })
  t.alike(loaded.stateRef.current.items, [row(3)], 'a loaded list is never replaced by the copy')
  const acting = make({ items: [row(3)], unverified: [], seeded: false, newer: 0, loadedAt: 5 }, { actingKey: '', prevActing: PEER, bindingKey: 'x', prevBinding: '', b: binding })
  t.alike(acting.stateRef.current.items, [row(4), row(2)], 'back to acting as yourself seeds the personal copy')
  t.is(acting.stateRef.current.loadedAt, null)
  t.is(calls.loads, 1, 'an acting change still reloads')
  t.alike(calls.badge, [false])
})

test('a continuation under a kept cached tail lands in notice order, without duplicates', async (t) => {
  const h = await harness([row(5), row(1)])
  h.env.read = async () => page([row(5)], 'first')
  await screenHandler('loadFirst', h.env)()
  t.alike(h.stateRef.current.items.map((n) => n.seq), [5, 1])
  h.env.read = async () => page([row(4), row(3), row(2), row(1)])
  await screenHandler('loadMore', h.env)()
  t.alike(h.stateRef.current.items.map((n) => n.seq), [5, 4, 3, 2, 1])
  t.alike(h.stateRef.current.unverified, [])
})

test('a cached row the node has not confirmed offers no follow back', (t) => {
  t.ok(source.includes('const pendingRows = new Set(unverified)'), 'the unverified ids reach the render')
  t.ok(source.includes('followBack={!pendingRows.has(noticeId(item)) && showsFollowBack('), 'no pill on an unverified row')
  const press = source.slice(source.indexOf('const followBack = useCallback'))
  t.ok(press.slice(0, press.indexOf("request('follow.add'")).includes('if (stateRef.current.unverified.includes(noticeId(item))) return'), 'a press on an unverified row sends nothing')
})

test('noticesForStorage keeps the picture the row draws, and the save arms again when avatars arrive', async (t) => {
  const { buildScreenSnapshot, parseScreenSnapshot } = await import('../src/screenSnapshot.js')
  const noticesForStorage = await noticesForStorageFromSource()
  const base = row(4, { kind: 'reply', post: OWN + ':4', avatar: null })
  const [stored] = noticesForStorage([base], () => ({ avatar: AVATAR }), { [PEER]: PEEK })
  t.alike(stored.avatar, AVATAR, 'a cached profile avatar wins over the row and the peek')
  t.is(stored.key, base.key)
  t.is(stored.seq, base.seq)
  t.is(stored.at, base.at)
  t.is(stored.name, base.name)
  t.is(stored.username, base.username)
  t.is(stored.seen, base.seen)
  t.is(stored.kind, 'reply')
  t.is(stored.post, OWN + ':4')
  t.is(noticesForStorage([row(3, { avatar: AVATAR })], () => ({ avatar: null }), { [PEER]: PEEK })[0].avatar, null, 'a cached null wins too')
  t.is(noticesForStorage([row(3, { avatar: AVATAR })], () => ({ avatar: { ...AVATAR, width: 64 } }), {})[0].avatar, null, 'a defined cached avatar that is not a photo wins as null')
  t.alike(noticesForStorage([row(3, { avatar: AVATAR })], () => ({}), { [PEER]: PEEK })[0].avatar, AVATAR, 'an unknown cached avatar leaves the row photo')
  t.alike(noticesForStorage([row(3, { avatar: AVATAR })], () => null, { [PEER]: PEEK })[0].avatar, AVATAR, 'a null profile leaves the row photo')
  t.alike(noticesForStorage([row(3, { avatar: null })], () => undefined, { [PEER]: PEEK })[0].avatar, PEEK, 'otherwise the peek map')
  const bare = noticesForStorage([row(2)], () => undefined, {})[0]
  t.is(bare.avatar, null)
  t.is(bare.name, 'Pessoa')
  t.alike(noticesForStorage(null, () => ({}), {}), [])
  const now = Date.now()
  const built = buildScreenSnapshot('avisos', { ...binding, now, notices: [stored], blocked: [] })
  t.ok(built)
  const parsed = built && parseScreenSnapshot(JSON.stringify(built), 'avisos', { origin: binding.origin, association: binding.association, owner: binding.owner, acting: binding.acting, now })
  t.alike(parsed && parsed.body.notices, [{
    kind: 'reply',
    key: PEER,
    seq: 4,
    at: stored.at,
    name: 'Pessoa',
    username: null,
    seen: stored.seen,
    avatar: AVATAR,
    post: OWN + ':4'
  }])
  const armBody = section('const armSave = useCallback(', '\n  }, [')
  t.ok(armBody.includes('storedNotices('), 'armSave uses the helper')
  t.ok(section('function storedNotices (state, held, profileOf, avatars) {', '\n}').includes('noticesForStorage('))
  t.ok(armBody.includes('profileOfRef.current') && armBody.includes('avatarsRef.current'))
  t.ok(armBody.includes('armedSaveRef.current = armed'))
  t.ok(section('const cancelSave = useCallback(', '\n  }, [').includes('armedSaveRef.current = null'), 'a cancelled save is not armed')
  t.ok(source.includes("picture={picture} persist={persistCopy ? 'copy' : false}"), 'a member row keeps bytes from the copy store')
  t.ok(source.includes('armSave(armed.gen, armed.b)'), 'the save is re-armed when avatars change')
  t.ok(source.includes('}, [avatars, profileOf, armSave])'), 'and when the names cache answers anew')
  t.ok(source.indexOf('const avatars = useRowAvatars') < source.indexOf('armSave(armed.gen, armed.b)'))
})

test('the stored-rows mark fires once, when a stored row is actually drawn', (t) => {
  const code = source.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
  t.is(code.split("perfMarks().mark('rows-snapshot:avisos')").length - 1, 1, 'one mark')
  t.absent(/if \(seeded\) perfMarks\(\)\.mark\('rows-snapshot:avisos'\)/.test(code), 'not on the seed alone, which the block gate may hide whole')
  t.ok(code.includes('const storedShown = seeded && shownItems.some((item) => unverified.includes(noticeId(item)))'), 'a stored row past the filters')
  t.ok(/if \(!storedShown \|\| snapshotMarked\.current\) return\s+snapshotMarked\.current = true\s+perfMarks\(\)\.mark\('rows-snapshot:avisos'\)\s+\}, \[storedShown\]\)/.test(code), 'once per mount')
  t.ok(code.indexOf('const shownItems = useMemo(') < code.indexOf('const storedShown = '), 'read from the rows the list draws')
})

// cancelSave, armSave and the re-arm effect compiled from the screen, with fake timers.
async function saveHarness () {
  const notices = await import('../src/notices.js')
  const paging = await import('../src/paging.js')
  const env = { ...notices, ...paging }
  env.prependNew = evaluate('function (currentItems, pageItems) {' + section('function prependNew (currentItems, pageItems) {', '\n}') + '\n}', env)
  env.confirmedNotices = evaluate('function (items, unverified) {' + section('function confirmedNotices (items, unverified) {', '\n}') + '\n}', env)
  env.noticesForStorage = await noticesForStorageFromSource()
  env.storedNotices = storedNoticesFn(env)
  const clock = { now: 0, next: 1, timers: new Map() }
  const saves = []
  const h = {
    gen: 10,
    saves,
    clock,
    pending: () => clock.timers.size,
    tick (ms) {
      const until = clock.now + ms
      for (;;) {
        let due = null
        for (const [id, timer] of clock.timers) if (timer.at <= until && (due === null || timer.at < due[1].at)) due = [id, timer]
        if (due === null) break
        clock.timers.delete(due[0])
        clock.now = due[1].at
        due[1].fn()
      }
      clock.now = until
    }
  }
  Object.assign(env, {
    setTimeout: (fn, ms) => { const id = clock.next++; clock.timers.set(id, { fn, at: clock.now + ms }); return id },
    clearTimeout: (id) => { clock.timers.delete(id) },
    cacheGeneration: () => h.gen,
    memberSnapshotBinding: () => binding,
    sameSnapshotBinding: (a, b) => a === b,
    actingGet: () => ({ kind: 'me' }),
    nodeRef: { current: {} },
    pageKeyRef: { current: null },
    blocksRef: { current: { loadState: 'ok', keys: [] } },
    stateRef: { current: { items: [row(3), row(1)], unverified: [] } },
    heldRef: { current: [] },
    profileOfRef: { current: () => undefined },
    avatarsRef: { current: {} },
    saveRef: { current: null },
    armedSaveRef: { current: null },
    buildScreenSnapshot: (kind, body) => ({ body }),
    saveScreenSnapshot: (kind, snapshot, gen) => { saves.push({ at: clock.now, notices: snapshot.body.notices }); return true }
  })
  env.cancelSave = screenHandler('cancelSave', env)
  env.armSave = screenHandler('armSave', env)
  h.env = env
  const head = 'useEffect(() => {\n    const armed = armedSaveRef.current'
  h.effect = evaluate('() => {' + head.slice(head.indexOf('\n')) + section(head, '\n  }, [') + '\n}', env)
  // As React runs it: again only when an entry of its own dependency list
  // (read from the screen) changed identity.
  const deps = section(head + section(head, '\n  }, [') + '\n  }, [', '])')
  let last = null
  h.render = (scope) => {
    const next = evaluate('[' + deps + ']', scope)
    if (last !== null && next.length === last.length && next.every((d, i) => Object.is(d, last[i]))) return
    last = next
    h.effect()
  }
  return h
}

test('a names-cache picture that settles after the save saves again with it; the same answer does not', async (t) => {
  const h = await saveHarness()
  const avatars = {}
  const render = (profileOf) => {
    h.env.profileOfRef.current = profileOf
    h.render({ avatars, profileOf, armSave: h.env.armSave })
  }
  render(() => undefined)
  h.env.armSave(10, binding)
  h.tick(2000)
  t.is(h.saves.length, 1)
  t.is(h.saves[0].notices[0].avatar, null, 'saved before the names cache knew the picture')
  render((k) => (k === PEER ? { name: 'Pessoa', username: null, avatar: AVATAR } : undefined))
  t.is(h.pending(), 1, 'armed again')
  h.tick(2000)
  t.alike(h.saves.map((s) => s.notices.map((n) => n.avatar)), [[null, null], [AVATAR, AVATAR]], 'the second save carries the names-cache picture')
  render((k) => (k === PEER ? { name: 'Pessoa', username: null, avatar: AVATAR } : undefined))
  t.is(h.pending(), 0, 'a new profileOf with the same answer: no timer')
  h.tick(10000)
  t.is(h.saves.length, 2, 'not written again')
})

test('a cancelled save stays cancelled when a peek lands', async (t) => {
  const h = await saveHarness()
  h.env.armSave(10, binding)
  t.is(h.pending(), 1)
  h.env.cancelSave()
  h.env.avatarsRef.current = { [PEER]: PEEK }
  h.effect()
  t.is(h.pending(), 0, 'no timer')
  h.tick(10000)
  t.alike(h.saves, [], 'nothing saved')
})

test('a peek that lands after the save saves again with the new picture', async (t) => {
  const h = await saveHarness()
  h.env.armSave(10, binding)
  h.tick(2000)
  t.is(h.saves.length, 1)
  t.is(h.saves[0].notices[0].avatar, null)
  h.env.avatarsRef.current = { [PEER]: PEEK }
  h.effect()
  t.is(h.pending(), 1, 'armed again')
  h.tick(2000)
  t.alike(h.saves.map((s) => s.notices.map((n) => n.avatar)), [[null, null], [PEEK, PEEK]], 'the second save carries the peeked photo')
})

test('a peek batch that changes no stored row arms no new save', async (t) => {
  const h = await saveHarness()
  h.env.avatarsRef.current = { [PEER]: PEEK }
  h.env.armSave(10, binding)
  h.tick(2000)
  t.is(h.saves.length, 1)
  h.env.avatarsRef.current = { [PEER]: { ...PEEK } }
  h.effect()
  t.is(h.pending(), 0, 'same stored rows: no timer')
  h.tick(10000)
  t.is(h.saves.length, 1, 'not written again')
})

test('a peek that lands while the save is pending does not push it back', async (t) => {
  const h = await saveHarness()
  h.env.armSave(10, binding)
  const first = h.env.saveRef.current
  h.tick(1500)
  h.env.avatarsRef.current = { [PEER]: PEEK }
  h.effect()
  t.is(h.env.saveRef.current, first, 'the pending timer is kept')
  h.tick(500)
  t.alike(h.saves.map((s) => s.at), [2000], 'written once, at the original time')
  t.alike(h.saves.map((s) => s.notices.map((n) => n.avatar)), [[PEEK, PEEK]], 'with the peek that landed before it fired')
  t.is(h.pending(), 0)
})

test('a save armed before a cache wipe is never written, pending or re-armed', async (t) => {
  const h = await saveHarness()
  h.env.armSave(10, binding)
  h.gen = 11
  h.env.avatarsRef.current = { [PEER]: PEEK }
  h.effect()
  h.tick(10000)
  t.alike(h.saves, [], 'the pending save sees the new generation')
  h.gen = 10
  h.env.armSave(10, binding)
  h.tick(2000)
  t.is(h.saves.length, 1)
  h.gen = 11
  h.env.avatarsRef.current = { [PEER]: AVATAR }
  h.effect()
  h.tick(10000)
  t.is(h.saves.length, 1, 'no re-arm under a new generation')
})
