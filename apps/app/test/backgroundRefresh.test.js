'use strict'

// The background refresh of A Rua's snapshot (src/backgroundRefresh.js),
// with a fake node, fake stores and no keychain.
const test = require('brittle')

const load = () => import('../src/backgroundRefresh.js')
const loadSnap = () => import('../src/feedSnapshot.js')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)
const BLOCKED = 'dd'.repeat(32)
const OTHER = 'ef'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const HOUR = 60 * 60 * 1000

const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
const photo = (n) => ({ core: '12'.repeat(32), mime: 'image/jpeg', start: n, blocks: 1, bytes: 1000, sha256: '34'.repeat(32), width: 100, height: 100 })
const avatar = { core: '56'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: '78'.repeat(32), width: 512, height: 512 }

function post (author, seq, extra = {}) {
  return { kind: 'post', author, name: null, username: null, seq, at: at(seq), text: 'texto ' + seq, replyTo: null, quote: null, media: null, preview: null, ...extra }
}

const config = { kind: 'hosted', installationUrl: ORIGIN, association: ASSOC, seederUrl: 'wss://bora.varanda.app/seeder', rpId: 'varanda.app' }

async function oldSnapshot () {
  const { buildSnapshot, parseSnapshot } = await loadSnap()
  const built = buildSnapshot({ origin: ORIGIN, association: ASSOC, owner: OWN, items: [post(OWN, 1)], now: Date.now() - 7 * HOUR })
  return parseSnapshot(JSON.stringify(built), { origin: ORIGIN, association: ASSOC })
}

// A node that answers from fixed data. `on` (method -> fn) runs before an
// answer, to bump a generation or abort mid-run.
function fakeNode ({ owner = OWN, follows = [FOLLOW, BLOCKED], blocks = [BLOCKED], feed, followTotal = null, syncReason = 'done', syncNever = false, on = {} } = {}) {
  const calls = []
  const starts = []
  let stops = 0
  // Oldest first, as feed.read answers (docs/rpc.md 5.13).
  const items = feed || [
    post(FOLLOW, 5, { media: [photo(4)] }),
    post(OWN, 6, { media: [photo(3)] }),
    post(STRANGER, 7),
    post(BLOCKED, 8),
    post(FOLLOW, 9, { media: [photo(1), photo(2)] })
  ]
  const start = async (cfg, { onEvent }) => {
    starts.push(cfg)
    return {
      async request (method, params) {
        calls.push({ method, params })
        if (on[method]) await on[method](params)
        switch (method) {
          case 'node.info': return { publicKey: owner }
          case 'sync.start':
            if (!syncNever) setImmediate(() => onEvent('sync.stopped', { runId: 'r1', reason: syncReason }))
            return { runId: 'r1' }
          case 'block.list': return { keys: blocks }
          case 'follow.list': {
            const total = followTotal === null ? follows.length : followTotal
            return { follows: follows.slice(params.offset, params.offset + params.limit), total }
          }
          case 'feed.read': return { items, skipped: [], future: [], incomplete: [] }
          case 'profile.read':
            return {
              profiles: params.authors.map((a) => ({ author: a, name: a === OWN ? 'Eu' : 'Bia', username: null, bio: null, avatar: a === FOLLOW ? avatar : null })),
              missing: []
            }
          default: throw new Error('inesperado ' + method)
        }
      }
    }
  }
  return { start, stop: async () => { stops++ }, calls, starts, stops: () => stops }
}

// Every function counts its calls: the run must never reach them.
function forbidden () {
  const hits = []
  const make = (name) => new Proxy({}, { get: (t, k) => (...a) => { hits.push(name + '.' + String(k)) } })
  return { identity: make('identity'), sessionStore: make('sessionStore'), keychain: make('keychain'), hits }
}

function keptStore ({ hangAfter = Infinity } = {}) {
  const kept = []
  let fetched = 0
  return {
    kept,
    store: {
      keptUrl: () => null,
      keep: (kind, author, d) => { kept.push({ kind, author, start: d.start }); return 'file://k/' + kept.length },
      fetchBytes: () => {
        fetched++
        if (fetched > hangAfter) return new Promise(() => {})
        return Promise.resolve(new Uint8Array(4))
      },
      validateAvatar: () => true
    }
  }
}

async function base (overrides = {}) {
  const node = overrides.node || fakeNode()
  const saves = []
  let gen = 0
  const f = forbidden()
  const deps = {
    snapshot: await oldSnapshot(),
    config,
    start: node.start,
    stop: node.stop,
    saveSnapshot: (text) => saves.push(text),
    cacheGeneration: () => gen,
    ...f,
    ...overrides.deps
  }
  return { node, saves, deps, f, bump: () => { gen++ } }
}

test('shouldRun: snapshot, binding, node and gap', async (t) => {
  const { shouldRun, BG_MIN_GAP_MS } = await load()
  const snapshot = await oldSnapshot()
  const now = Date.now()
  t.is(BG_MIN_GAP_MS, 6 * HOUR)
  t.ok(shouldRun({ snapshot, config, nodeRunning: false, nowMs: now, lastRunMs: null }))
  t.ok(shouldRun({ snapshot, config: { config }, nodeRunning: false, nowMs: now, lastRunMs: now - 6 * HOUR }))
  t.absent(shouldRun({ snapshot: null, config, nodeRunning: false, nowMs: now }), 'no snapshot')
  t.absent(shouldRun({ snapshot, config: null, nodeRunning: false, nowMs: now }), 'no remembered config')
  t.absent(shouldRun({ snapshot, config: { ...config, kind: 'p2p' }, nodeRunning: false, nowMs: now }))
  t.absent(shouldRun({ snapshot, config: { ...config, association: 'ab'.repeat(32) }, nodeRunning: false, nowMs: now }), 'another association')
  t.absent(shouldRun({ snapshot, config: { ...config, installationUrl: 'https://outra.app' }, nodeRunning: false, nowMs: now }), 'another installation')
  t.absent(shouldRun({ snapshot, config, nodeRunning: true, nowMs: now }), 'node running')
  t.absent(shouldRun({ snapshot, config, nodeRunning: false, nowMs: now, lastRunMs: now - 6 * HOUR + 1 }), 'too soon')
  t.absent(shouldRun({ snapshot: { ...snapshot, items: [] }, config, nodeRunning: false, nowMs: now }), 'empty snapshot')
})

test('no snapshot: nothing starts', async (t) => {
  const { runRefresh } = await load()
  const { node, saves, deps } = await base()
  const r = await runRefresh({ ...deps, snapshot: null })
  t.is(node.starts.length, 0)
  t.is(node.stops(), 0)
  t.is(saves.length, 0)
  t.absent(r.ok)
})

test('a full run saves own and followed rows, never a blocked author, and keeps photos', async (t) => {
  const { runRefresh } = await load()
  const { parseSnapshot } = await loadSnap()
  const k = keptStore()
  const { node, saves, deps, f } = await base({ deps: { kept: k.store } })
  const r = await runRefresh(deps)
  t.ok(r.ok)
  t.ok(r.saved)
  t.is(saves.length, 1)
  t.is(node.starts.length, 1)
  t.is(node.starts[0].kind, 'hosted')
  t.is(node.stops(), 1, 'node stopped at the end')
  const sync = node.calls.find((c) => c.method === 'sync.start')
  t.alike(sync.params, { once: true, timeoutMs: 12000, groups: false })
  const snap = parseSnapshot(saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
  t.ok(snap)
  t.alike(snap.items.map((i) => i.author + ':' + i.seq), [FOLLOW + ':9', OWN + ':6', FOLLOW + ':5'], 'newest first')
  t.alike(snap.cursor, { at: at(5), author: FOLLOW, seq: 5 }, 'the oldest kept row bounds it')
  t.absent(saves[0].includes(BLOCKED), 'blocked author nowhere in the snapshot')
  t.absent(saves[0].includes(STRANGER))
  t.alike(snap.names[FOLLOW].avatar, avatar)
  t.is(r.kept, 5, 'avatar and four photos')
  t.alike(k.kept.map((x) => x.kind + ':' + x.start), ['avatars:1', 'posts:1', 'posts:2', 'posts:3', 'posts:4'], 'from the top of the feed')
  t.alike(f.hits, [], 'identity, session store and keychain never called')
  const methods = new Set(node.calls.map((c) => c.method))
  t.alike([...methods].sort(), ['block.list', 'feed.read', 'follow.list', 'node.info', 'profile.read', 'sync.start'])
})

test('another owner: stop, no sync, no save', async (t) => {
  const { runRefresh } = await load()
  const { node, saves, deps, f } = await base({ node: fakeNode({ owner: OTHER }) })
  const r = await runRefresh(deps)
  t.absent(r.ok)
  t.is(r.reason, 'outra identidade')
  t.is(saves.length, 0)
  t.is(node.stops(), 1)
  t.absent(node.calls.some((c) => c.method === 'sync.start'))
  t.alike(f.hits, [])
})

test('an incomplete follow list: no save', async (t) => {
  const { runRefresh } = await load()
  const { node, saves, deps } = await base({ node: fakeNode({ followTotal: 3 }) })
  const r = await runRefresh(deps)
  t.is(r.reason, 'seguidos incompletos')
  t.is(saves.length, 0)
  t.is(node.stops(), 1)
  t.absent(node.calls.some((c) => c.method === 'feed.read'))
})

test('a follows.changed while paging makes the list incomplete', async (t) => {
  const { runRefresh } = await load()
  let emit = null
  const inner = fakeNode({ follows: Array.from({ length: 600 }, (_, i) => i.toString(16).padStart(64, '0')) })
  const node = {
    ...inner,
    start: (cfg, opts) => { emit = opts.onEvent; return inner.start(cfg, opts) }
  }
  const wrapped = await base({ node })
  const realStart = wrapped.deps.start
  wrapped.deps.start = async (cfg, opts) => {
    const client = await realStart(cfg, opts)
    return {
      async request (method, params) {
        if (method === 'follow.list' && params.offset > 0) emit('follows.changed', {})
        return client.request(method, params)
      }
    }
  }
  const r = await runRefresh(wrapped.deps)
  t.is(r.reason, 'seguidos incompletos')
  t.is(wrapped.saves.length, 0)
})

test('a wipe during the run discards the save', async (t) => {
  const { runRefresh } = await load()
  let bump = null
  const node = fakeNode({ on: { 'feed.read': () => bump() } })
  const b = await base({ node })
  bump = b.bump
  const r = await runRefresh(b.deps)
  t.is(r.reason, 'limpeza')
  t.is(b.saves.length, 0)
  t.is(node.stops(), 1)
})

test('a failed sync keeps the old snapshot', async (t) => {
  const { runRefresh } = await load()
  const { node, saves, deps } = await base({ node: fakeNode({ syncReason: 'error' }) })
  const r = await runRefresh(deps)
  t.is(r.reason, 'sincronização')
  t.is(saves.length, 0)
  t.is(node.stops(), 1)
})

test('a failed request is not retried and ends the run', async (t) => {
  const { runRefresh } = await load()
  const node = fakeNode({ on: { 'block.list': () => { throw new Error('falhou') } } })
  const { saves, deps } = await base({ node })
  const r = await runRefresh(deps)
  t.absent(r.ok)
  t.is(saves.length, 0)
  t.is(node.calls.filter((c) => c.method === 'block.list').length, 1)
  t.is(node.stops(), 1)
})

test('abort stops at the next step and stops the node', async (t) => {
  const { runRefresh } = await load()
  const ac = new AbortController()
  const node = fakeNode({ on: { 'follow.list': () => ac.abort() } })
  const { saves, deps } = await base({ node, deps: { signal: ac.signal } })
  const r = await runRefresh(deps)
  t.is(r.reason, 'interrompido')
  t.is(saves.length, 0)
  t.is(node.stops(), 1)
  t.absent(node.calls.some((c) => c.method === 'feed.read'))
})

test('abort while the sync runs ends the wait at once', async (t) => {
  const { runRefresh } = await load()
  const ac = new AbortController()
  const node = fakeNode({ syncNever: true, on: { 'sync.start': () => setTimeout(() => ac.abort(), 10) } })
  const { saves, deps } = await base({ node, deps: { signal: ac.signal } })
  const t0 = Date.now()
  const r = await runRefresh(deps)
  t.ok(Date.now() - t0 < 1000)
  t.is(r.reason, 'interrompido')
  t.is(saves.length, 0)
  t.is(node.stops(), 1)
})

test('the deadline stops the photo keeps and the node; the snapshot stays saved', async (t) => {
  const { runRefresh } = await load()
  const k = keptStore({ hangAfter: 1 })
  const { node, saves, deps } = await base({ deps: { kept: k.store, deadlineMs: 150 } })
  const t0 = Date.now()
  const r = await runRefresh(deps)
  t.ok(Date.now() - t0 < 1000)
  t.is(r.reason, 'prazo')
  t.ok(r.saved)
  t.is(saves.length, 1)
  t.is(r.kept, 1, 'only the photo before the deadline')
  t.is(k.kept.length, 1)
  t.is(node.stops(), 1)
})

test('the deadline during the sync: no save', async (t) => {
  const { runRefresh } = await load()
  const node = fakeNode({ syncNever: true })
  const { saves, deps } = await base({ node, deps: { deadlineMs: 80 } })
  const r = await runRefresh(deps)
  t.is(r.reason, 'prazo')
  t.is(saves.length, 0)
  t.is(node.stops(), 1)
})

test('keepPlan caps count and bytes', async (t) => {
  const { keepPlan } = await load()
  const items = []
  for (let i = 1; i <= 10; i++) items.push(post(FOLLOW, i, { media: [photo(i), photo(i + 20)] }))
  t.is(keepPlan({ items, names: {} }).length, 12)
  const big = (n) => ({ ...photo(n), blocks: 128, bytes: 4 * 1024 * 1024 })
  const heavy = [post(FOLLOW, 1, { media: [big(1), big(200), photo(3)] })]
  const plan = keepPlan({ items: heavy, names: {} })
  t.alike(plan.map((p) => p.d.start), [1, 200], '8 MiB in all: the small one past the cap is left')
})

test('originals, names and hearts carry over only for refs still shown, under the rules now', async (t) => {
  const { runRefresh } = await load()
  const { buildSnapshot, parseSnapshot } = await loadSnap()
  const F2 = '9a'.repeat(32)
  const repost = (author, seq, to) => ({ kind: 'repost', author, name: null, username: null, seq, at: at(seq), to, text: null, replyTo: null, quote: null, media: null, preview: null })
  const oldItems = [
    repost(FOLLOW, 23, { author: FOLLOW, seq: 7 }),
    post(FOLLOW, 22, { quote: { author: BLOCKED, seq: 4 } }),
    repost(FOLLOW, 21, { author: F2, seq: 3 }),
    repost(FOLLOW, 20, { author: FOLLOW, seq: 1 })
  ]
  const originals = new Map([
    [FOLLOW + ':1', post(FOLLOW, 1)],
    [F2 + ':3', post(F2, 3)],
    [BLOCKED + ':4', post(BLOCKED, 4)],
    [FOLLOW + ':7', post(FOLLOW, 7)]
  ])
  const built = buildSnapshot({
    origin: ORIGIN,
    association: ASSOC,
    owner: OWN,
    items: oldItems,
    originals,
    liked: [FOLLOW + ':1', FOLLOW + ':7'],
    reposted: [FOLLOW + ':1'],
    profileOf: (a) => ({ name: 'Antigo', username: null, avatar: null, ...(a === FOLLOW ? { page: true, closed: true, moved: false } : {}) }),
    isKnown: () => true,
    now: Date.now() - 7 * HOUR
  })
  const previous = parseSnapshot(JSON.stringify(built), { origin: ORIGIN, association: ASSOC })
  t.ok(previous.originals[F2 + ':3'] && previous.originals[BLOCKED + ':4'] && previous.originals[FOLLOW + ':7'], 'old snapshot held them all')
  const node = fakeNode({ follows: [FOLLOW, BLOCKED], blocks: [BLOCKED], feed: oldItems.slice(1).reverse() })
  const { saves, deps } = await base({ node, deps: { snapshot: previous } })
  const r = await runRefresh(deps)
  t.ok(r.saved)
  const snap = parseSnapshot(saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
  t.alike(Object.keys(snap.originals), [FOLLOW + ':1'], 'the repost row in both keeps its original')
  t.absent(snap.originals[FOLLOW + ':7'], 'a ref no longer on the page is dropped')
  t.absent(snap.originals[F2 + ':3'], 'an unfollowed author is dropped')
  t.absent(snap.originals[BLOCKED + ':4'], 'a blocked author is dropped')
  t.alike(snap.liked, [FOLLOW + ':1'])
  t.alike(snap.reposted, [FOLLOW + ':1'])
  t.alike(snap.counts, {}, 'counts stay out')
  t.absent(snap.names[F2])
  t.absent(snap.names[BLOCKED])
  t.is(snap.names[FOLLOW].name, 'Bia', 'profile.read wins over the old name')
  t.is(snap.names[FOLLOW].page, true, 'page hint carried over')
  t.is(snap.names[FOLLOW].closed, true)
  t.is(snap.names[FOLLOW].moved, false)
})

// A node whose start and stop take time; `log` records when it came up,
// when it was stopped and when runRefresh resolved.
function slowNode ({ startMs, stopMs = 0, never = false }) {
  const log = []
  let up = false
  const start = () => new Promise((resolve) => {
    if (never) return
    setTimeout(() => {
      up = true
      log.push('up')
      resolve({ request: () => new Promise(() => {}) })
    }, startMs)
  })
  const stop = () => new Promise((resolve) => {
    setTimeout(() => {
      if (up) log.push('stop')
      else log.push('stop-none')
      up = false
      resolve()
    }, stopMs)
  })
  return { start, stop, log, isUp: () => up }
}

test('a start still in flight at the deadline is awaited, then stopped, before resolving', async (t) => {
  const { runRefresh } = await load()
  const n = slowNode({ startMs: 120 })
  const { deps } = await base({ node: n, deps: { deadlineMs: 30 } })
  const r = await runRefresh(deps)
  n.log.push('resolved')
  t.is(r.reason, 'prazo')
  t.ok(r.stopped)
  t.alike(n.log, ['up', 'stop', 'resolved'])
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.absent(n.isUp(), 'no node left running')
  t.alike(n.log, ['up', 'stop', 'resolved'], 'no late stop after resolving')
})

test('a start that settles while a slow stop would be pending is still stopped', async (t) => {
  const { runRefresh } = await load()
  const n = slowNode({ startMs: 60, stopMs: 80 })
  const { deps } = await base({ node: n, deps: { deadlineMs: 30 } })
  const r = await runRefresh(deps)
  n.log.push('resolved')
  t.ok(r.stopped)
  await new Promise((resolve) => setTimeout(resolve, 250))
  t.absent(n.isUp(), 'no node left running')
  t.alike(n.log, ['up', 'stop', 'resolved'])
})

test('a start that never settles is reported, not resolved as stopped', async (t) => {
  const { runRefresh } = await load()
  const n = slowNode({ never: true })
  const { deps } = await base({ node: n, deps: { deadlineMs: 30, stopGraceMs: 30 } })
  const r = await runRefresh(deps)
  t.absent(r.ok)
  t.is(r.stopped, false)
  t.ok(r.settle && typeof r.settle.then === 'function')
  t.alike(n.log, [], 'no blind stop')
})
