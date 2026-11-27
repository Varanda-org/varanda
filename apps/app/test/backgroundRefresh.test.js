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
// peeks: author -> a diary.peek answer, or a function of the params that
// returns or throws one; an author missing from it fails. linkUp() says
// whether the continuous run started for the peeks is still going.
function fakeNode ({ owner = OWN, follows = [FOLLOW, BLOCKED], blocks = [BLOCKED], feed, followTotal = null, syncReason = 'done', syncNever = false, peeks = null, on = {} } = {}) {
  const calls = []
  const starts = []
  let stops = 0
  let linked = false
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
        calls.push({ method, params, linked })
        if (on[method]) await on[method](params)
        switch (method) {
          case 'node.info': return { publicKey: owner }
          case 'sync.start':
            if (params.once !== true) {
              if (peeks === null) throw new Error('inesperado ' + method)
              linked = true
              return { runId: 'r2' }
            }
            if (!syncNever) setImmediate(() => onEvent('sync.stopped', { runId: 'r1', reason: syncReason }))
            return { runId: 'r1' }
          case 'sync.stop':
            if (peeks === null) throw new Error('inesperado ' + method)
            linked = false
            return { stopped: true }
          case 'diary.peek': {
            if (peeks === null || !Object.prototype.hasOwnProperty.call(peeks, params.author)) throw new Error('sem semeador')
            const p = peeks[params.author]
            const answer = await (typeof p === 'function' ? p(params) : p)
            // As the node does (docs/rpc.md 5.27): the profile and the
            // username are read only from the hinted blocks.
            if (!answer || typeof answer !== 'object') return answer
            return { ...answer, profile: params.profileSeq >= 1 ? answer.profile : null, username: params.usernameSeq >= 1 ? answer.username : null }
          }
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
  return { start, stop: async () => { stops++ }, calls, starts, stops: () => stops, linkUp: () => linked }
}

// A verified diary.peek answer holding posts at `seqs` (extra: seq -> fields).
function peekAnswer (author, seqs, { name = 'Estranha', username = null, extra = {} } = {}) {
  return {
    key: author,
    profile: name === null ? null : { name, bio: '', avatar: null },
    username,
    entries: seqs.map((seq) => ({ seq, record: { type: 'post', text: 'original ' + seq, at: at(seq), replyTo: null, quote: null, ...(extra[seq] || {}) } })),
    invalid: [],
    missing: []
  }
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

test('nothingToRefresh: only a missing config or snapshot, never a busy node or a recent run', async (t) => {
  const { nothingToRefresh } = await load()
  const snapshot = await oldSnapshot()
  t.absent(nothingToRefresh({ snapshot, config }), 'a bound snapshot keeps the task')
  t.absent(nothingToRefresh({ snapshot, config: { config } }))
  t.ok(nothingToRefresh({ snapshot: null, config }), 'no snapshot (wiped)')
  t.ok(nothingToRefresh({ snapshot, config: null }), 'no remembered config')
  t.ok(nothingToRefresh({ snapshot, config: { ...config, kind: 'p2p' } }))
  t.ok(nothingToRefresh({ snapshot, config: { ...config, association: 'ab'.repeat(32) } }), 'another association')
  t.ok(nothingToRefresh({ snapshot, config: { ...config, installationUrl: 'https://outra.app' } }), 'another installation')
  t.ok(nothingToRefresh({ snapshot: { ...snapshot, items: [] }, config }), 'empty snapshot')
  t.ok(nothingToRefresh(), 'no arguments')
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
  t.is(node.calls.find((c) => c.method === 'feed.read').params.thumbs, true, 'saved photo rows request thumbnails')
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

test('keepPlan queues only the poster of a video post', async (t) => {
  const { keepPlan } = await load()
  const poster = { ...photo(5), width: 640, height: 360 }
  const clip = { core: '9a'.repeat(32), mime: 'video/mp4', start: 6, blocks: 30, bytes: 30 * 32768 - 5, sha256: 'bc'.repeat(32), width: 640, height: 360, ms: 12000 }
  const items = [post(FOLLOW, 2, { media: [poster, clip] }), post(FOLLOW, 1, { media: [photo(9)] })]
  const plan = keepPlan({ items, names: {} })
  t.alike(plan.map((p) => p.d), [poster, photo(9)], 'the poster and the next photo, never the video')
  t.absent(plan.some((p) => p.d.mime === 'video/mp4'))
})

test('originals, names and hearts carry over only for refs still shown, under the rules now', async (t) => {
  // The stranger's peek fails here (the fake node knows no diary.peek): the
  // old original and name stay as the fallback.
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
  t.alike(Object.keys(snap.originals).sort(), [FOLLOW + ':1', F2 + ':3'].sort(), 'the repost rows in both keep their originals')
  t.absent(snap.originals[FOLLOW + ':7'], 'a ref no longer on the page is dropped')
  t.ok(snap.originals[F2 + ':3'], 'an unfollowed author keeps the original')
  t.absent(snap.originals[BLOCKED + ':4'], 'a blocked author is dropped')
  t.alike(snap.liked, [FOLLOW + ':1'])
  t.alike(snap.reposted, [FOLLOW + ':1'])
  t.alike(snap.counts, {}, 'counts stay out')
  t.is(snap.names[F2].name, 'Antigo', 'an unfollowed author keeps the old name')
  t.absent(snap.names[BLOCKED])
  t.is(snap.names[FOLLOW].name, 'Bia', 'profile.read wins over the old name')
  t.is(snap.names[FOLLOW].page, true, 'page hint carried over')
  t.is(snap.names[FOLLOW].closed, true)
  t.is(snap.names[FOLLOW].moved, false)
})

test('a quoted original is not carried over: it may have been deleted since', async (t) => {
  const { runRefresh } = await load()
  const { buildSnapshot, parseSnapshot } = await loadSnap()
  const repost = (author, seq, to) => ({ kind: 'repost', author, name: null, username: null, seq, at: at(seq), to, text: null, replyTo: null, quote: null, media: null, preview: null })
  const items = [
    post(FOLLOW, 22, { quote: { author: FOLLOW, seq: 4 } }),
    repost(FOLLOW, 21, { author: FOLLOW, seq: 1 })
  ]
  const built = buildSnapshot({
    origin: ORIGIN,
    association: ASSOC,
    owner: OWN,
    items,
    originals: new Map([[FOLLOW + ':4', post(FOLLOW, 4)], [FOLLOW + ':1', post(FOLLOW, 1)]]),
    profileOf: () => ({ name: 'Antigo', username: null, avatar: null }),
    isKnown: () => true,
    now: Date.now() - 7 * HOUR
  })
  const previous = parseSnapshot(JSON.stringify(built), { origin: ORIGIN, association: ASSOC })
  t.ok(previous.originals[FOLLOW + ':4'], 'the old snapshot held the quoted post')
  const node = fakeNode({ follows: [FOLLOW], blocks: [], feed: items.slice().reverse() })
  const { saves, deps } = await base({ node, deps: { snapshot: previous } })
  t.ok((await runRefresh(deps)).saved)
  const snap = parseSnapshot(saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
  t.absent(snap.originals[FOLLOW + ':4'], 'the quoted post is left unresolved until the live page')
  t.ok(snap.originals[FOLLOW + ':1'], 'a repost original still carries over')
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

const repostOf = (author, seq, to) => ({ kind: 'repost', author, name: null, username: null, seq, at: at(seq), to, text: null, replyTo: null, quote: null, media: null, preview: null })

// Oldest first: a repost and a quote of STRANGER, a reply to OTHER, and refs
// to a blocked, a followed and the own diary, which are never peeked.
function peekFeed () {
  return [
    repostOf(FOLLOW, 10, { author: STRANGER, seq: 3 }),
    post(FOLLOW, 11, { quote: { author: STRANGER, seq: 5 } }),
    post(OWN, 12, { replyTo: { author: OTHER, seq: 2 } }),
    post(FOLLOW, 13, { quote: { author: BLOCKED, seq: 4 } }),
    post(FOLLOW, 14, { quote: { author: FOLLOW, seq: 1 } }),
    post(FOLLOW, 15, { replyTo: { author: OWN, seq: 6 } })
  ]
}

function peekNode (overrides = {}) {
  return fakeNode({
    feed: peekFeed(),
    peeks: {
      [STRANGER]: peekAnswer(STRANGER, [3, 5], { username: 'estranha', extra: { 5: { media: [photo(7)] } } }),
      [OTHER]: peekAnswer(OTHER, [2])
    },
    ...overrides
  })
}

test('peekTargets: strangers only, grouped by author, capped', async (t) => {
  const { peekTargets, BG_PEEK_AUTHORS } = await load()
  const { PEEK_SEQS_MAX } = await import('../src/thread.js')
  const known = new Set([FOLLOW])
  const blocked = new Set([BLOCKED])
  const rows = resetRows(peekFeed())
  t.alike(peekTargets(rows, { own: OWN, known, blocked }), [{ author: OTHER, seqs: [2] }, { author: STRANGER, seqs: [3, 5] }], 'newest rows first, seqs ascending')
  const many = []
  for (let i = 0; i < 8; i++) many.push(post(FOLLOW, 100 + i, { quote: { author: (i + 1).toString(16).padStart(2, '0').repeat(32), seq: 1 } }))
  for (let s = 1; s <= 40; s++) many.push(repostOf(FOLLOW, 200 + s, { author: STRANGER, seq: s }))
  const capped = peekTargets(many, { own: OWN, known, blocked })
  t.is(capped.length, BG_PEEK_AUTHORS, 'at most six authors')
  t.absent(capped.some((x) => x.author === STRANGER), 'the seventh author on is left out')
  const one = peekTargets(many.slice(8), { own: OWN, known, blocked })
  t.is(one[0].seqs.length, PEEK_SEQS_MAX, 'at most PEEK_SEQS_MAX seqs')
  t.alike(peekTargets([post(FOLLOW, 1, { quote: { author: STRANGER, seq: 0 } })], { own: OWN, known, blocked }), [], 'seq 0 is never a post')
})

function resetRows (oldestFirst) {
  return oldestFirst.slice().reverse()
}

// The member index (indexClient fetchMembers): author -> { profileSeq,
// usernameSeq }, a missing author answers not-found. `calls` records each
// read's authors.
function fakeMembers (hints = { [STRANGER]: { profileSeq: 1, usernameSeq: 2 } }) {
  const calls = []
  const fetchMembers = async (authors) => {
    calls.push(authors)
    return authors.map((a) => Object.prototype.hasOwnProperty.call(hints, a)
      ? { ok: true, value: { length: 10, posts: [], postsTotal: 0, complete: true, indexing: false, ...hints[a] } }
      : { ok: false, reason: 'not-found' })
  }
  return { fetchMembers, calls }
}

test('strangers\' originals are peeked on a live link, stopped after, and saved with their names', async (t) => {
  const { runRefresh } = await load()
  const { parseSnapshot } = await loadSnap()
  const node = peekNode()
  const members = fakeMembers()
  const { saves, deps } = await base({ node, deps: { fetchMembers: members.fetchMembers } })
  const r = await runRefresh(deps)
  t.ok(r.ok)
  const methods = node.calls.map((c) => c.method)
  const peeks = node.calls.filter((c) => c.method === 'diary.peek')
  t.alike(members.calls, [[OTHER, STRANGER]], 'one member read, for the peeked authors')
  t.alike(peeks.map((c) => c.params), [
    { author: OTHER, seqs: [2], thumbs: true, alt: true },
    { author: STRANGER, seqs: [3, 5], profileSeq: 1, usernameSeq: 2, thumbs: true, alt: true }
  ], 'one peek per author, in order, with thumbs and alt, and the index hints when it gave them')
  t.ok(peeks.every((c) => c.linked), 'every peek runs while the link is up')
  const second = node.calls.findIndex((c) => c.method === 'sync.start' && c.params.once === false)
  t.ok(second > methods.indexOf('feed.read') && second < methods.indexOf('diary.peek'), 'the run for the peeks starts after the reads')
  t.alike(second === -1 ? null : node.calls[second].params, { once: false })
  t.is(methods.filter((m) => m === 'sync.stop').length, 1)
  t.ok(methods.lastIndexOf('diary.peek') < methods.indexOf('sync.stop'), 'stopped after the last peek')
  t.absent(node.linkUp(), 'no run left going')
  t.is(node.stops(), 1)
  const snap = parseSnapshot(saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
  t.is(snap.originals[STRANGER + ':3']?.text, 'original 3', 'a repost target')
  t.is(snap.originals[STRANGER + ':5']?.text, 'original 5', 'a quote target')
  t.alike(snap.originals[STRANGER + ':5']?.media, [photo(7)])
  t.is(snap.originals[OTHER + ':2']?.text, 'original 2', 'a reply target')
  t.is(snap.names[STRANGER]?.name, 'Estranha', 'the peeked name, read at the hinted block')
  t.is(snap.names[STRANGER]?.username, 'estranha', 'the peeked username, read at the hinted block')
  t.is(snap.originals[STRANGER + ':3']?.name, 'Estranha')
  t.absent(snap.names[OTHER], 'no index hints: the peek has no profile, stored without a name')
  t.is(snap.originals[OTHER + ':2']?.name, null)
  t.absent(snap.originals[BLOCKED + ':4'], 'no original of the blocked author')
  t.absent(snap.names[BLOCKED], 'no name of the blocked author')
})

test('a blocked, followed or own target is never peeked', async (t) => {
  const { runRefresh } = await load()
  const node = peekNode()
  const { deps } = await base({ node })
  await runRefresh(deps)
  const authors = node.calls.filter((c) => c.method === 'diary.peek').map((c) => c.params.author)
  for (const a of [BLOCKED, FOLLOW, OWN]) t.absent(authors.includes(a))
})

test('a failed peek skips that author once and the others still run', async (t) => {
  const { runRefresh } = await load()
  const { parseSnapshot } = await loadSnap()
  const node = peekNode({
    peeks: {
      [OTHER]: () => { throw new Error('sem semeador') },
      [STRANGER]: peekAnswer(STRANGER, [3, 5])
    }
  })
  const { saves, deps } = await base({ node })
  const r = await runRefresh(deps)
  t.ok(r.ok)
  const authors = node.calls.filter((c) => c.method === 'diary.peek').map((c) => c.params.author)
  t.alike(authors, [OTHER, STRANGER], 'never retried')
  t.is(node.calls.filter((c) => c.method === 'sync.stop').length, 1)
  t.absent(node.linkUp())
  const snap = parseSnapshot(saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
  t.absent(snap.originals[OTHER + ':2'])
  t.ok(snap.originals[STRANGER + ':3'])
})

test('a failed start of the peek run skips the peeks, still stops and saves', async (t) => {
  const { runRefresh } = await load()
  const node = peekNode({ on: { 'sync.start': (p) => { if (p.once === false) throw new Error('falhou') } } })
  const { saves, deps } = await base({ node })
  const r = await runRefresh(deps)
  t.ok(r.ok)
  t.is(saves.length, 1)
  t.absent(node.calls.some((c) => c.method === 'diary.peek'))
  t.is(node.calls.filter((c) => c.method === 'sync.stop').length, 1, 'a start that may have reached the node is stopped')
})

test('the deadline during a peek stops the run and the node; no save', async (t) => {
  const { runRefresh, BG_DEADLINE_MS } = await load()
  let fire = null
  const setTimer = (fn, ms) => {
    if (ms === BG_DEADLINE_MS) {
      fire = fn
      return 'deadline'
    }
    return setTimeout(fn, ms)
  }
  const clearTimer = (id) => { if (id !== 'deadline') clearTimeout(id) }
  const node = peekNode({
    peeks: {
      [OTHER]: () => { fire(); return new Promise(() => {}) },
      [STRANGER]: peekAnswer(STRANGER, [3, 5])
    }
  })
  const { saves, deps } = await base({ node, deps: { setTimer, clearTimer } })
  const t0 = Date.now()
  const r = await runRefresh(deps)
  t.ok(Date.now() - t0 < 1000)
  t.is(r.reason, 'prazo')
  t.is(saves.length, 0)
  t.alike(node.calls.filter((c) => c.method === 'diary.peek').map((c) => c.params.author), [OTHER], 'no peek after the deadline')
  t.is(node.calls.filter((c) => c.method === 'sync.stop').length, 1)
  t.absent(node.linkUp(), 'no run left going')
  t.is(node.stops(), 1)
})

test('under 6 s of the deadline left nothing is peeked', async (t) => {
  const { runRefresh } = await load()
  for (const [spent, peeked] of [[15000, false], [14000, true]]) {
    let clock = 1e12
    const node = peekNode({ on: { 'feed.read': () => { clock += spent } } })
    const { saves, deps } = await base({ node, deps: { now: () => clock } })
    const r = await runRefresh(deps)
    t.ok(r.ok)
    t.is(saves.length, 1)
    t.is(node.calls.some((c) => c.method === 'diary.peek'), peeked, (20000 - spent) + ' ms left')
    t.is(node.calls.some((c) => c.method === 'sync.start' && c.params.once === false), peeked)
  }
})

test('keepPlan reserves up to four slots for the originals\' photos', async (t) => {
  const { keepPlan } = await load()
  const items = []
  for (let i = 1; i <= 10; i++) items.push(post(FOLLOW, i, { media: [photo(i), photo(i + 20)] }))
  const originals = {
    [STRANGER + ':1']: post(STRANGER, 1, { media: [photo(100), photo(101)] }),
    [STRANGER + ':2']: post(STRANGER, 2, { media: [photo(102), photo(103), photo(104)] })
  }
  const plan = keepPlan({ items, names: {}, originals })
  t.is(plan.length, 12)
  t.is(plan.filter((p) => p.persist === true).length, 8, 'followed photos first, up to 8')
  t.alike(plan.filter((p) => p.persist === 'copy').map((p) => p.d.start), [100, 101, 102, 103], 'then 4 of the originals, as copies')
  t.ok(plan.slice(0, 8).every((p) => p.persist === true), 'the originals come after')
  const two = keepPlan({ items, names: {}, originals: { [STRANGER + ':1']: originals[STRANGER + ':1'] } })
  t.is(two.filter((p) => p.persist === true).length, 10, 'only as many slots as originals\' photos are held')
  t.is(two.filter((p) => p.persist === 'copy').length, 2)
  const few = keepPlan({ items: items.slice(0, 1), names: {}, originals })
  t.is(few.filter((p) => p.persist === 'copy').length, 5, 'slots the rows leave free go to the originals too')
})

test('the keep rules are set from this run\'s lists before any copy write', async (t) => {
  const { runRefresh } = await load()
  const events = []
  const real = await import('../src/localCaches.js')
  const caches = {
    wipeEpoch: () => { events.push('wipeEpoch'); return real.wipeEpoch() },
    setAllowedAuthors: (keys) => { events.push('setAllowedAuthors'); t.alike([...keys].sort(), [OWN, FOLLOW, BLOCKED].sort(), 'own and follows'); real.setAllowedAuthors(keys) },
    denyAuthors: (keys) => { events.push('denyAuthors'); t.alike([...keys], [BLOCKED]); real.denyAuthors(keys) },
    noteBlocksKnown: (since) => { events.push('noteBlocksKnown'); t.is(since, real.wipeEpoch()); real.noteBlocksKnown(since) }
  }
  const node = peekNode({ on: { 'block.list': () => events.push('block.list'), 'follow.list': () => events.push('follow.list') } })
  const k = keptStore()
  const loadKept = async (args) => {
    events.push('keep:' + args.persist)
    const { loadKept: realLoadKept } = await import('../src/media/keptLoad.js')
    return realLoadKept(args)
  }
  const { deps } = await base({ node, deps: { kept: k.store, caches, loadKept } })
  const r = await runRefresh(deps)
  t.ok(r.ok)
  const i = (e) => events.indexOf(e)
  t.ok(i('wipeEpoch') < i('block.list'), 'the epoch is read before block.list')
  t.ok(i('follow.list') < i('setAllowedAuthors'))
  t.ok(i('noteBlocksKnown') < i('keep:true') && i('noteBlocksKnown') < i('keep:copy'), 'before any keep')
  t.ok(real.peekKeepAllowed(STRANGER), 'a stranger may be kept as a copy')
  t.absent(real.peekKeepAllowed(BLOCKED), 'never a blocked author')
  t.alike(k.kept.map((x) => x.kind + ':' + x.author.slice(0, 2) + ':' + x.start), ['avatars:bb:1', 'copyPosts:cc:7'], 'the stranger\'s original photo went to the copy kinds')
})

test('a peek that never answers ends the round before the deadline and the copy is still saved', async (t) => {
  const { runRefresh, BG_DEADLINE_MS, BG_PEEK_SAVE_MARGIN_MS } = await load()
  const { buildSnapshot, parseSnapshot } = await loadSnap()
  const built = buildSnapshot({
    origin: ORIGIN,
    association: ASSOC,
    owner: OWN,
    items: [repostOf(FOLLOW, 10, { author: STRANGER, seq: 3 })],
    originals: new Map([[STRANGER + ':3', post(STRANGER, 3)]]),
    isKnown: (a) => a === FOLLOW,
    blocked: new Set([BLOCKED]),
    now: Date.now() - 7 * HOUR
  })
  const previous = parseSnapshot(JSON.stringify(built), { origin: ORIGIN, association: ASSOC })
  t.ok(previous.originals[STRANGER + ':3'], 'the old copy held the repost original')
  // The fake clock leaves about 7 s after feed.read; the real deadline timer
  // fires at 200 ms, any other timer at 10 ms.
  let clock = Date.now()
  const asked = []
  const setTimer = (fn, ms) => {
    asked.push(ms)
    return setTimeout(fn, ms === BG_DEADLINE_MS ? 200 : 10)
  }
  const node = peekNode({
    peeks: { [OTHER]: () => new Promise(() => {}), [STRANGER]: peekAnswer(STRANGER, [3, 5]) },
    on: { 'feed.read': () => { clock += BG_DEADLINE_MS - 7000 } }
  })
  const { saves, deps } = await base({ node, deps: { snapshot: previous, now: () => clock, setTimer } })
  const r = await runRefresh(deps)
  t.ok(r.ok)
  t.is(r.reason, 'ok')
  t.is(saves.length, 1, 'the copy is saved')
  t.ok(asked.includes(7000 - BG_PEEK_SAVE_MARGIN_MS), 'the peek is bounded by the deadline less the margin')
  t.alike(node.calls.filter((c) => c.method === 'diary.peek').map((c) => c.params.author), [OTHER], 'no peek after the round ended')
  t.is(node.calls.filter((c) => c.method === 'sync.stop').length, 1)
  t.absent(node.linkUp(), 'no run left going')
  t.is(node.stops(), 1)
  const snap = parseSnapshot(saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
  t.is(snap?.originals[STRANGER + ':3']?.text, 'texto 3', 'the carried-over original stays')
  t.absent(snap?.originals[OTHER + ':2'])
})

test('member hints: only seqs >= 1 are passed; a failed or late read peeks without them, never retried', async (t) => {
  const { runRefresh, BG_DEADLINE_MS } = await load()
  const { parseSnapshot } = await loadSnap()
  const peekParams = (node) => node.calls.filter((c) => c.method === 'diary.peek').map((c) => c.params)

  let node = peekNode()
  let members = fakeMembers({ [STRANGER]: { profileSeq: null, usernameSeq: 0 }, [OTHER]: { profileSeq: 4, usernameSeq: null } })
  let b = await base({ node, deps: { fetchMembers: members.fetchMembers } })
  t.ok((await runRefresh(b.deps)).ok)
  t.alike(peekParams(node), [
    { author: OTHER, seqs: [2], profileSeq: 4, thumbs: true, alt: true },
    { author: STRANGER, seqs: [3, 5], thumbs: true, alt: true }
  ], 'a null or zero hint is left out')
  let snap = parseSnapshot(b.saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
  t.is(snap.names[OTHER]?.name, 'Estranha')
  t.absent(snap.names[STRANGER])

  for (const failing of [async () => { throw new Error('rede') }, () => { throw new Error('rede') }, async () => ({ ok: false, reason: 'invalid-input' }), async () => [null, 'x']]) {
    node = peekNode()
    let reads = 0
    b = await base({ node, deps: { fetchMembers: (a) => { reads++; return failing(a) } } })
    const r = await runRefresh(b.deps)
    t.ok(r.ok)
    t.is(reads, 1, 'never retried')
    t.alike(peekParams(node).map((p) => p.profileSeq === undefined && p.usernameSeq === undefined), [true, true], 'peeked without hints')
    snap = parseSnapshot(b.saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
    t.ok(snap.originals[STRANGER + ':3'], 'the posts are still stored')
    t.absent(snap.names[STRANGER], 'without a name')
  }

  // A read that never answers: given up at the peeks' budget (the fake
  // timer fires at once), and the peeks still run.
  const asked = []
  const setTimer = (fn, ms) => {
    asked.push(ms)
    return setTimeout(fn, ms === BG_DEADLINE_MS ? 5000 : 10)
  }
  node = peekNode()
  members = { fetchMembers: () => new Promise(() => {}) }
  b = await base({ node, deps: { fetchMembers: members.fetchMembers, setTimer } })
  const r = await runRefresh(b.deps)
  t.ok(r.ok)
  t.alike(peekParams(node).map((p) => [p.author, p.profileSeq, p.usernameSeq]), [[OTHER, undefined, undefined], [STRANGER, undefined, undefined]], 'the peeks run, without hints')
  t.ok(asked.some((ms) => ms > 0 && ms < BG_DEADLINE_MS), 'the member read is bounded by the peek budget')
})

test('a nameless peek keeps the carried original\'s name; a named one wins', async (t) => {
  const { runRefresh } = await load()
  const { buildSnapshot, parseSnapshot } = await loadSnap()
  const built = buildSnapshot({
    origin: ORIGIN,
    association: ASSOC,
    owner: OWN,
    items: [repostOf(FOLLOW, 10, { author: STRANGER, seq: 3 })],
    originals: new Map([[STRANGER + ':3', post(STRANGER, 3, { name: 'Antiga', username: 'antiga', avatar })]]),
    isKnown: (a) => a === FOLLOW,
    now: Date.now() - 7 * HOUR
  })
  const previous = parseSnapshot(JSON.stringify(built), { origin: ORIGIN, association: ASSOC })
  t.is(previous.originals[STRANGER + ':3']?.name, 'Antiga', 'the old copy held the named original')
  const feed = [repostOf(FOLLOW, 10, { author: STRANGER, seq: 3 })]
  const answer = peekAnswer(STRANGER, [3], { username: 'estranha', extra: { 3: { text: 'editado' } } })

  let node = fakeNode({ feed, peeks: { [STRANGER]: answer } })
  let b = await base({ node, deps: { snapshot: previous } })
  t.ok((await runRefresh(b.deps)).ok)
  let snap = parseSnapshot(b.saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
  const kept = snap.originals[STRANGER + ':3']
  t.is(kept?.text, 'editado', 'the peeked post fields')
  t.is(kept?.name, 'Antiga', 'the carried name')
  t.is(kept?.username, 'antiga', 'the carried username')
  t.alike(kept?.avatar, avatar, 'the carried avatar')

  node = fakeNode({ feed, peeks: { [STRANGER]: answer } })
  b = await base({ node, deps: { snapshot: previous, fetchMembers: fakeMembers().fetchMembers } })
  t.ok((await runRefresh(b.deps)).ok)
  snap = parseSnapshot(b.saves[0], { origin: ORIGIN, association: ASSOC, owner: OWN })
  t.is(snap.originals[STRANGER + ':3']?.name, 'Estranha', 'a peek with a profile wins as is')
  t.is(snap.originals[STRANGER + ':3']?.username, 'estranha')
  t.is(snap.originals[STRANGER + ':3']?.avatar, null)
})

test('keepPlan holds slots only for strangers\' photos it would take', async (t) => {
  const { keepPlan } = await load()
  const items = []
  for (let i = 1; i <= 10; i++) items.push(post(FOLLOW, i, { media: [photo(i), photo(i + 20)] }))
  const originals = {
    [OWN + ':1']: post(OWN, 1, { media: [photo(100), photo(101)] }),
    [FOLLOW + ':50']: post(FOLLOW, 50, { media: [photo(102)] }),
    [STRANGER + ':1']: post(STRANGER, 1, { media: [photo(103), { ...photo(104), bytes: 0 }] }),
    [STRANGER + ':2']: post(STRANGER, 2, { media: [photo(103)] })
  }
  const plan = keepPlan({ owner: OWN, items, names: {}, originals })
  t.is(plan.length, 12)
  t.is(plan.filter((p) => p.persist === true).length, 11, 'one slot held: the owner\'s and a row author\'s originals, an invalid and a duplicate hold none')
  t.alike(plan.filter((p) => p.persist === 'copy').map((p) => p.author + ':' + p.d.start), [STRANGER + ':103'], 'the stranger\'s photo takes it')
  t.ok(plan.slice(0, 11).every((p) => p.persist === true), 'rows first')
  const huge = { ...photo(105), blocks: 300, bytes: 9 * 1024 * 1024 }
  const tooBig = keepPlan({ owner: OWN, items, names: {}, originals: { [STRANGER + ':3']: post(STRANGER, 3, { media: [huge] }) } })
  t.is(tooBig.filter((p) => p.persist === true).length, 12, 'a photo past the byte budget holds no slot')
})

test('a once run that met no seeder peeks nothing', async (t) => {
  const { runRefresh } = await load()
  const members = fakeMembers()
  const node = peekNode({ syncReason: 'timeout' })
  const { saves, deps } = await base({ node, deps: { fetchMembers: members.fetchMembers } })
  const r = await runRefresh(deps)
  t.ok(r.ok)
  t.is(saves.length, 1, 'the local rows are still saved')
  t.absent(node.calls.some((c) => c.method === 'diary.peek'))
  t.absent(node.calls.some((c) => c.method === 'sync.start' && c.params.once === false), 'no run started for peeks')
  t.alike(members.calls, [], 'no member read')
})

test('an abort during the peeks sends sync.stop without waiting for it', async (t) => {
  const { runRefresh } = await load()
  const ac = new AbortController()
  const asked = []
  const setTimer = (fn, ms) => {
    asked.push(ms)
    return setTimeout(fn, ms)
  }
  const node = peekNode({
    peeks: { [OTHER]: () => { setTimeout(() => ac.abort(), 5); return new Promise(() => {}) }, [STRANGER]: peekAnswer(STRANGER, [3, 5]) },
    on: { 'sync.stop': () => new Promise(() => {}) }
  })
  const { saves, deps } = await base({ node, deps: { signal: ac.signal, setTimer } })
  const t0 = Date.now()
  const r = await runRefresh(deps)
  const spent = Date.now() - t0
  t.is(r.reason, 'interrompido')
  t.is(saves.length, 0)
  t.is(node.calls.filter((c) => c.method === 'sync.stop').length, 1, 'the run is still stopped')
  t.absent(asked.includes(1000), 'no wait for the sync.stop answer')
  t.ok(spent < 900, 'resolved without the stop wait (' + spent + ' ms)')
  t.is(node.stops(), 1)
})

// The real screen store over a Map, holding a stored block list `blocks`
// and a mute list for the snapshot's binding.
async function quietStore (blocks) {
  const snap = await import('../src/screenSnapshot.js')
  const { cacheGeneration } = await import('../src/localCaches.js')
  const texts = new Map()
  const store = snap.createScreenSnapshotStore({ load: (k) => texts.get(k), save: (k, v) => { texts.set(k, v) }, clear: (k) => { texts.delete(k) } })
  const binding = { origin: ORIGIN, association: ASSOC, owner: OWN, acting: { kind: 'me' } }
  for (const [kind, keys] of [['bloqueios', blocks], ['silenciados', [OTHER]]]) {
    store.saveScreenSnapshot(kind, snap.buildScreenSnapshot(kind, { ...binding, keys }), cacheGeneration())
  }
  return { texts, store, lists: snap.storedQuietLists() }
}

test('a block the stored list lacks removes both stored lists, so the next open purges', async (t) => {
  const { runRefresh } = await load()
  const q = await quietStore([])
  t.ok(q.texts.has('bloqueios') && q.texts.has('silenciados'))
  const { saves, deps } = await base({ deps: { quietLists: q.lists } })
  const r = await runRefresh(deps)
  t.ok(r.ok)
  t.is(saves.length, 1, 'the refresh still saves')
  t.absent(q.texts.has('bloqueios'), 'no stored block list to seed the next open')
  t.absent(q.texts.has('silenciados'))
})

test('the platform store is used when none is passed', async (t) => {
  const { runRefresh } = await load()
  const q = await quietStore([OTHER])
  const { deps } = await base()
  const r = await runRefresh(deps)
  t.ok(r.ok)
  t.absent(q.texts.has('bloqueios'))
  t.absent(q.texts.has('silenciados'))
})

test('an equal or larger stored block list stays', async (t) => {
  const { runRefresh } = await load()
  for (const blocks of [[BLOCKED], [BLOCKED, OTHER]]) {
    const q = await quietStore(blocks)
    const before = q.texts.get('bloqueios')
    const { deps } = await base({ deps: { quietLists: q.lists } })
    const r = await runRefresh(deps)
    t.ok(r.ok)
    t.is(q.texts.get('bloqueios'), before, 'not rewritten with the fresh keys either')
    t.ok(q.texts.has('silenciados'))
  }
})

test('a missing stored list or a failing store changes nothing and the refresh goes on', async (t) => {
  const { runRefresh } = await load()
  const cleared = []
  const missing = { load: () => null, clear: (k) => cleared.push(k) }
  let a = await base({ deps: { quietLists: missing } })
  let r = await runRefresh(a.deps)
  t.ok(r.ok)
  t.is(a.saves.length, 1)
  t.alike(cleared, [], 'nothing removed without a stored list')
  const failing = { load: () => { throw new Error('io') }, clear: () => { throw new Error('io') } }
  a = await base({ deps: { quietLists: failing } })
  r = await runRefresh(a.deps)
  t.ok(r.ok)
  t.is(a.saves.length, 1)
  const clearFails = { load: () => ({ body: { keys: [] } }), clear: () => { throw new Error('io') } }
  a = await base({ deps: { quietLists: clearFails } })
  r = await runRefresh(a.deps)
  t.ok(r.ok, 'a failed removal does not end the run')
  t.is(a.saves.length, 1)
})
