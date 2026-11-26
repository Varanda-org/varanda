'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '../src/screens/Salvos.js'), 'utf8')
const communities = fs.readFileSync(path.join(__dirname, '../src/screens/Comunidades.js'), 'utf8')
const owner = 'aa'.repeat(32)
const author = 'bb'.repeat(32)
const other = 'cc'.repeat(32)
const binding = { origin: 'https://example.test', association: 'dd'.repeat(32), owner, acting: { kind: 'me' } }
const post = (key, seq, extra = {}) => ({ kind: 'post', author: key, seq, name: 'Pessoa', username: null, at: '2026-11-01T00:00:00.000Z', text: 'salvo ' + seq, media: null, preview: null, quote: null, replyTo: null, ...extra })
const row = (post) => ({ ref: post.author + ':' + post.seq, post })
const entry = (key, seq) => ({ author: key, seq, savedAt: 1 })

function evaluate (text, deps = {}) {
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), text)(...Object.values(deps))
}

function extract (src, name, deps) {
  const start = src.indexOf('function ' + name + ' (')
  return evaluate('return ' + (src.slice(start - 6, start) === 'async ' ? 'async ' : '') + src.slice(start, src.indexOf('\n}', start) + 2), deps)
}

const memberSnapshotBinding = extract(communities, 'memberSnapshotBinding', {
  liveBinding: (key, config) => config ? { origin: config.origin, association: config.association, owner: key } : null
})
const sameSnapshotBinding = extract(communities, 'sameSnapshotBinding')
const savedRowAuthors = extract(source, 'savedRowAuthors')
const seedPeeked = extract(source, 'seedPeeked')
const replacePeeked = extract(source, 'replacePeeked')
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

// Run the screen's hooks with deferred reads and a manual clock. The JSX
// contract is checked separately, without a device runtime or network.
async function harness (options = {}) {
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const view = await import('../src/savedView.js')
  const { lookupPost } = await import('../src/thread.js')
  const gate = await import('../src/cachedRows.js')
  const { poolMap } = await import('../src/engagement.js')
  const slots = []
  const effects = []
  const timers = new Map()
  const requests = []
  const reads = []
  const writes = []
  let index = 0
  let timerId = 0
  let generation = 0
  let acting = options.acting || binding.acting
  let blockState = 'pending'
  let blockKeys = new Set()
  const has = (key) => blockKeys.has(key)
  const node = {
    hosted: true,
    online: options.online !== false,
    config: options.vitrine ? null : { ...binding },
    passkey: { status: { unlocked: !options.locked, publicKey: owner } },
    request: (method, params) => new Promise((resolve, reject) => requests.push({ method, params, resolve, reject }))
  }
  const saved = {
    available: true,
    loaded: false,
    entries: options.entries || [entry(author, 2), entry(author, 1)],
    unsave: async (key, seq) => {
      saved.entries = saved.entries.filter((e) => e.author !== key || e.seq !== seq)
      return true
    }
  }
  let stored = buildScreenSnapshot('listas', { ...binding, name: 'salvos', scope: options.scope || '', rows: options.rows || [row(post(author, 1)), row(post(author, 2)), row(post(other, 1))], blocked: [] })
  const changed = (i, deps) => !slots[i] || deps.some((v, n) => v !== slots[i].deps[n])
  const hooks = {
    useState (initial) {
      const i = index++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
    },
    useRef (initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useMemo (fn, deps) {
      const i = index++
      if (changed(i, deps)) slots[i] = { deps, value: fn() }
      return slots[i].value
    },
    useCallback (fn, deps) {
      const i = index++
      if (changed(i, deps)) slots[i] = { deps, value: fn }
      return slots[i].value
    },
    useEffect (fn, deps) {
      const i = index++
      if (changed(i, deps)) {
        effects.push(() => {
          if (slots[i] && slots[i].cleanup) slots[i].cleanup()
          slots[i] = { deps, cleanup: fn() }
        })
      }
    }
  }
  const start = source.indexOf('function SalvosList (')
  const end = source.indexOf('\n  let empty = null', start)
  const screen = evaluate('return ' + source.slice(start, end) + '\nreturn { load, rows, read, unsave, v, cachedRefs }\n}', {
    ...hooks,
    ...view,
    ...gate,
    useStyles: () => ({}),
    makeStyles: () => ({}),
    useNode: () => node,
    useSaved: () => saved,
    useBlocks: () => ({ keys: blockKeys, has, loadState: blockState }),
    useActing: () => acting,
    pageMode: ({ acting }) => ({ key: acting.kind === 'page' ? other : null }),
    pagesOn: () => true,
    useBottomPad: () => 0,
    useNow: () => Date.now(),
    memberSnapshotBinding,
    sameSnapshotBinding,
    savedRowAuthors,
    seedPeeked,
    replacePeeked,
    poolMap,
    postAt: lookupPost,
    lookupHints: options.lookupHints || (async () => ({})),
    peekChunk: async (request, params, peeked, alive) => {
      const answer = await request('diary.peek', params)
      if (alive() && answer) {
        const previous = peeked.get(answer.key)
        peeked.set(answer.key, { ...answer, entries: [...(previous ? previous.entries : []), ...answer.entries] })
      }
    },
    cacheGeneration: () => generation,
    loadScreenSnapshot: (kind, b) => { reads.push({ kind, b }); return stored },
    buildScreenSnapshot,
    saveScreenSnapshot: (kind, snapshot, gen) => { writes.push({ kind, snapshot, gen }); return false },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId },
    clearTimeout: (id) => timers.delete(id),
    SAVE_DELAY_MS: 2000
  })
  return {
    node,
    saved,
    requests,
    reads,
    writes,
    timers,
    render: () => {
      index = 0
      const state = screen({})
      while (effects.length) effects.shift()()
      return state
    },
    blocks: (state, keys = []) => { blockState = state; blockKeys = new Set(keys) },
    act: (next) => { acting = next },
    bump: () => { generation++ },
    store: (next) => { stored = next },
    answer: (i, posts) => {
      const key = requests[i].params.author
      requests[i].resolve(seedPeeked(posts.map(row)).get(key) || { key, entries: [] })
    },
    flush: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const timer of pending) timer.fn()
    },
    unmount: () => { for (const slot of slots) if (slot && slot.cleanup) slot.cleanup() }
  }
}

test('only saved refs in the expected scope seed an unlocked member binding', async (t) => {
  const h = await harness()
  const state = h.render()
  t.alike([...state.cachedRefs.current], [author + ':1', author + ':2'])
  t.absent(state.load.peeked.has(other), 'removed saves never seed the map')
  t.is(h.timers.size, 0, 'a cached paint never writes')
  for (const options of [{ locked: true }, { vitrine: true }, { acting: { kind: 'page' } }]) {
    const h = await harness(options)
    t.is(h.render().load.peeked.size, 0)
    t.is(h.reads.length, 0, 'no binding does not even read the snapshot')
    const pass = h.render().read(false)
    await tick()
    h.answer(0, [post(author, 1)])
    await pass
    h.flush()
    t.is(h.writes.length, 0, 'no binding never saves')
  }
  const scoped = await harness({ scope: 'other' })
  t.is(scoped.render().load.peeked.size, 0)
})

test('the render gate follows pending, ok, later blocks, binding changes and purges', async (t) => {
  const h = await harness({ online: false })
  t.alike(h.render().rows, [], 'pending hides other people')
  h.blocks('ok')
  let state = h.render()
  t.alike(state.rows.map((r) => r.ref), [author + ':2', author + ':1'], 'saved order, not snapshot order')
  t.is(state.v.view, 'ready', 'cache is visible offline before a live pass')
  h.blocks('ok', [author])
  t.alike(h.render().rows, [], 'a later block hides the cached cards')
  h.blocks('ok')
  t.is(h.render().rows.length, 2)
  h.act({ kind: 'page' })
  t.alike(h.render().rows, [])
  h.act({ kind: 'me' })
  state = h.render()
  t.is(state.rows.length, 2)
  h.bump()
  t.alike(h.render().rows, [], 'a purge hides the seed')
})

test('the cached gate includes the original, quote and reply authors', async (t) => {
  const { cachedRowsShown } = await import('../src/cachedRows.js')
  const own = await harness({ entries: [entry(owner, 1)], rows: [row(post(owner, 1))] })
  t.is(own.render().rows.length, 1, 'an own post can paint before block.list')
  for (const extra of [{ to: { author: other, seq: 1 } }, { quote: { author: other, seq: 1 } }, { replyTo: { author: other, seq: 1 } }]) {
    const rows = [row(post(owner, 1, extra))]
    t.alike(savedRowAuthors(rows[0]), [owner, other])
    t.alike(cachedRowsShown(rows, { loadState: 'pending', blocked: new Set(), owner, authorsOf: savedRowAuthors }), [])
    t.alike(cachedRowsShown(rows, { loadState: 'ok', blocked: new Set([other]), owner, authorsOf: savedRowAuthors }), [])
  }
  const h = await harness({ rows: [row(post(author, 1, { replyTo: { author: other, seq: 1 } }))] })
  h.blocks('ok')
  t.is(h.render().rows.filter((r) => r.kind === 'post').length, 1)
  h.blocks('ok', [other])
  t.is(h.render().rows.filter((r) => r.kind === 'post').length, 0)
})

test('each live chunk replaces its cached refs immediately and evicts gone posts', async (t) => {
  const h = await harness({ entries: [entry(author, 2), entry(other, 1), entry(author, 1)] })
  const pass = h.render().read(false)
  await tick()
  t.is(h.requests.length, 2)
  h.answer(0, [post(author, 1, { text: 'live' })])
  await tick()
  const state = h.render()
  t.alike(state.rows.map((r) => [r.ref, r.kind]), [[author + ':2', 'gone'], [author + ':1', 'post']], 'the other chunk still waits behind the gate')
  t.is(state.rows[1].post.text, 'live')
  t.alike([...state.cachedRefs.current], [other + ':1'])
  h.answer(1, [post(other, 1)])
  await pass
  t.alike(h.render().rows.map((r) => r.ref), [author + ':2', other + ':1', author + ':1'])
  t.is([...h.timers.values()][0].delay, 2000)
  h.blocks('ok')
  h.render()
  h.flush()
  t.alike(h.writes[0].snapshot.body.lists.salvos.rows.map((r) => r.ref), [other + ':1', author + ':1'])
  h.flush()
  t.is(h.writes.length, 1, 'a refused save is not retried')
})

test('a failed live read keeps the cache gated and never stores it as live', async (t) => {
  const h = await harness()
  const pass = h.render().read(false)
  await tick()
  h.requests[0].reject(new Error('offline'))
  await pass
  t.alike(h.render().rows, [])
  h.blocks('ok')
  t.is(h.render().rows.length, 2)
  h.flush()
  t.alike(h.writes[0].snapshot.body.lists.salvos.rows, [])
})

test('save merges the latest shared lists, drops blocks, caps live rows and re-saves removals', async (t) => {
  const { buildScreenSnapshot } = await import('../src/screenSnapshot.js')
  const posts = Array.from({ length: 33 }, (_, i) => post(author, i + 1, i === 0 ? { replyTo: { author: other, seq: 1 } } : {}))
  const h = await harness({ entries: posts.map((p) => entry(p.author, p.seq)) })
  const pass = h.render().read(false)
  await tick()
  for (let i = 0; i < h.requests.length; i++) h.answer(i, posts.filter((p) => h.requests[i].params.seqs.includes(p.seq)))
  await pass
  h.blocks('ok', [other])
  h.render()
  const shared = buildScreenSnapshot('listas', { ...binding, name: 'seguindo', scope: '', rows: [owner], total: 1, blocked: [] })
  h.store(shared)
  h.flush()
  const body = h.writes[0].snapshot.body
  t.alike(body.lists.seguindo, shared.body.lists.seguindo, 'another screen saved during the debounce')
  t.alike(body.lists.salvos.rows.map((r) => r.post.seq), Array.from({ length: 30 }, (_, i) => i + 2), 'filter before the cap')
  await h.render().unsave(entry(author, 2))
  h.render()
  h.flush()
  t.absent(h.writes[1].snapshot.body.lists.salvos.rows.some((r) => r.post.seq === 2))
  t.is(h.writes[1].gen, 0, 'removal keeps the live pass generation')
  h.bump()
  await h.render().unsave(entry(author, 3))
  h.render()
  h.flush()
  t.is(h.writes.length, 2, 'a removal cannot revive a purged pass')
})

test('generation is captured before hints and a live request, never at settlement', async (t) => {
  let release
  const hints = new Promise((resolve) => { release = resolve })
  const h = await harness({ lookupHints: () => hints })
  const pass = h.render().read(false)
  h.bump()
  release({})
  await tick()
  h.answer(0, [post(author, 1)])
  await pass
  t.is(h.timers.size, 0, 'a purge during hints refuses to arm')
  h.flush()
  t.is(h.writes.length, 0)
  const waiting = await harness()
  const read = waiting.render().read(false)
  await tick()
  waiting.bump()
  waiting.answer(0, [post(author, 1)])
  await read
  t.is(waiting.timers.size, 0, 'a purge while diary.peek waits refuses to arm')
})

test('a newly saved ref joins the live snapshot and keeps its read generation', async (t) => {
  const h = await harness()
  h.blocks('ok')
  const pass = h.render().read(false)
  await tick()
  h.answer(0, [post(author, 1), post(author, 2)])
  await pass
  h.render()
  h.flush()
  h.saved.entries = [entry(other, 3), ...h.saved.entries]
  h.render()
  await tick()
  t.is(h.requests.length, 2, 'only the missing ref is read')
  h.answer(1, [post(other, 3)])
  await tick()
  h.render()
  h.flush()
  t.alike(h.writes[1].snapshot.body.lists.salvos.rows.map((r) => r.ref), [other + ':3', author + ':2', author + ':1'])
  h.saved.entries = [entry(other, 4), ...h.saved.entries]
  h.render()
  await tick()
  h.bump()
  h.answer(2, [post(other, 4)])
  await tick()
  h.render()
  h.flush()
  t.is(h.writes.length, 2, 'a purge during the late read refuses its save')
})

test('save time rechecks generation and the current binding and cancels on unmount', async (t) => {
  for (const change of [
    (h) => h.bump(),
    (h) => { h.node.passkey.status.unlocked = false },
    (h) => { h.node.passkey.status.publicKey = other },
    (h) => { h.node.config.origin = 'https://other.test' },
    (h) => { h.node.config.association = other },
    (h) => { h.act({ kind: 'page' }); h.render() },
    (h) => h.unmount()
  ]) {
    const h = await harness()
    const pass = h.render().read(false)
    await tick()
    h.answer(0, [post(author, 1)])
    await pass
    change(h)
    h.flush()
    t.is(h.writes.length, 0)
  }
})

test('cached rows offer no actions and keep photo persistence unchanged', (t) => {
  t.ok(source.includes('data={ready ? rows : []}'), 'the list draws gated rows')
  t.ok(source.includes('seq={cached ? undefined : post.seq}'), 'no implicit save action in PostRow')
  t.ok(source.includes("onOpen={!cached && typeof onOpenThread === 'function'"))
  t.ok(source.includes("onOpenAuthor={!cached && typeof onOpenMember === 'function'"))
  t.ok(source.includes('link={!cached && origin ?'))
  t.ok(source.includes('onNotice={cached ? undefined : onToast}'))
  t.ok(source.includes('persistMedia={false}'))
  t.absent(source.includes('newItems='), 'saved order needs no new-items pill')
})

test('chunks preserve only identities verified during the current read pass', async (t) => {
  for (const late of [false, true]) {
    for (const hintedFirst of [false, true]) {
      const posts = Array.from({ length: 30 }, (_, i) => post(author, i + 1))
      const h = await harness({ entries: late ? [] : posts.map((p) => entry(author, p.seq)) })
      if (late) {
        await h.render().read(false)
        h.render()
        h.saved.entries = posts.map((p) => entry(author, p.seq))
        h.render()
      }
      const pass = late ? null : h.render().read(false)
      await tick()
      t.is(h.requests.length, 2)
      const identity = { name: 'Live name', avatar: { d: 'ee'.repeat(32), mime: 'image/jpeg', bytes: 12 } }
      const answer = (i, hinted) => {
        const records = seedPeeked(posts.filter((p) => h.requests[i].params.seqs.includes(p.seq)).map(row)).get(author)
        h.requests[i].resolve({ ...records, profile: hinted ? identity : null, username: hinted ? 'live_name' : null })
      }
      answer(hintedFirst ? 0 : 1, hintedFirst)
      await tick()
      if (!hintedFirst && !late) {
        const partial = h.render().load.peeked.get(author)
        t.is(partial.profile, null, 'a hintless answer never promotes the seeded profile')
        t.is(partial.username, null)
      }
      answer(hintedFirst ? 1 : 0, !hintedFirst)
      if (pass) await pass
      else await tick()
      const result = h.render().load.peeked.get(author)
      t.alike(result.profile, identity, 'name and avatar survive either chunk order')
      t.is(result.username, 'live_name')
      t.is(result.entries.length, 30)
      if (!late) {
        const refresh = h.render().read(true)
        await tick()
        answer(2, false)
        answer(3, false)
        await refresh
        const refreshed = h.render().load.peeked.get(author)
        t.is(refreshed.profile, null, 'a new pass cannot reuse the earlier live identity')
        t.is(refreshed.username, null)
      }
    }
  }
})

test('a quoted saved ref confirmed in this pass is never read or evicted again', async (t) => {
  for (const outcome of ['failed', 'empty']) {
    const parent = post(author, 1, { quote: { author: other, seq: 1 } })
    const quoted = post(other, 1, { text: 'confirmed live' })
    const h = await harness({ entries: [entry(author, 1), entry(other, 1)], rows: [row(parent), row(quoted)] })
    const pass = h.render().read(false)
    await tick()
    h.answer(0, [parent])
    h.answer(1, [quoted])
    await tick()
    t.is(h.requests.length, 2, 'both saved refs were already confirmed')
    for (let i = 2; i < h.requests.length; i++) {
      if (outcome === 'failed') h.requests[i].reject(new Error('offline'))
      else h.answer(i, [])
    }
    await pass
    t.alike(h.render().rows.map((r) => [r.ref, r.kind]), [[author + ':1', 'post'], [other + ':1', 'post']])
    h.blocks('ok')
    h.render()
    h.flush()
    t.alike(h.writes[0].snapshot.body.lists.salvos.rows.map((r) => r.ref), [author + ':1', other + ':1'], 'the quoted saved post stays in the stored copy')
  }
})

test('late hintless reads preserve identities verified by the current main pass', async (t) => {
  const h = await harness({ entries: [entry(author, 1)] })
  const identity = { name: 'Live name', username: 'live_name' }
  const pass = h.render().read(false)
  await tick()
  h.answer(0, [post(author, 1, identity)])
  await pass
  h.render()
  h.saved.entries = [entry(author, 2), ...h.saved.entries]
  h.render()
  await tick()
  t.is(h.requests.length, 2, 'the new save gets one hintless read')
  h.answer(1, [post(author, 2, { name: null, username: null })])
  await tick()
  const state = h.render()
  t.alike(state.rows.map((r) => [r.post.name, r.post.username]), [[identity.name, identity.username], [identity.name, identity.username]])
  h.blocks('ok')
  h.render()
  h.flush()
  t.alike(h.writes[0].snapshot.body.lists.salvos.rows.map((r) => [r.post.name, r.post.username]), [[identity.name, identity.username], [identity.name, identity.username]])
})

test('quote refreshes replace edits, evict confirmed deletions and preserve failed reads and identities', async (t) => {
  const { lookupPost } = await import('../src/thread.js')
  const parent = post(author, 1, { quote: { author: other, seq: 1 } })
  const h = await harness({ entries: [entry(author, 1)], rows: [row(parent)] })
  for (const [round, text] of ['original', 'edited', null, 'restored', 'failed'].entries()) {
    const pass = h.render().read(round > 0)
    await tick()
    h.answer(round * 2, [parent])
    await tick()
    t.is(h.requests.length, round * 2 + 2, 'the quote is requested again in this pass')
    const quoteRequest = h.requests[round * 2 + 1]
    if (!quoteRequest) return
    t.is(quoteRequest.params.author, other)
    if (text === 'failed') quoteRequest.reject(new Error('offline'))
    else h.answer(round * 2 + 1, text === null ? [] : [post(other, 1, { text, name: 'Quoted name', username: 'quoted_name' })])
    await pass
    const quote = lookupPost(h.render().load.peeked, other + ':1')
    if (text === null) t.is(quote, null, 'a confirmed deletion removes the earlier copy')
    else {
      t.is(quote?.text, text === 'failed' ? 'restored' : text, 'only a successful answer replaces the earlier record')
      t.is(quote?.name, 'Quoted name', 'a failed read preserves the quoted author profile')
      t.is(quote?.username, 'quoted_name', 'a failed read preserves the quoted author username')
    }
  }
})

test('an all-failed first read exposes retry even when cached posts passed the block gate', async (t) => {
  const h = await harness()
  h.blocks('ok')
  t.is(h.render().v.view, 'ready')
  const pass = h.render().read(false)
  await tick()
  h.requests[0].reject(new Error('offline'))
  await pass
  const state = h.render()
  t.is(state.rows.length, 2, 'cached rows still exist')
  t.is(state.load.phase, 'error')
  t.is(state.v.view, 'error', 'the cached paint cannot mask retry')
  t.ok(source.includes("v.view === 'error') empty = <ErrorState"))
  t.ok(source.includes('onRetry={() => read(false)}'))
  const retry = state.read(false)
  await tick()
  h.answer(1, [post(author, 1)])
  await retry
  t.is(h.render().v.view, 'ready')
})

test('no save before block.list answered', async (t) => {
  const h = await harness({ entries: [entry(author, 1)] })
  const pass = h.render().read(false)
  await tick()
  h.answer(0, [post(author, 1)])
  await pass
  h.render()
  h.flush()
  t.is(h.writes.length, 0, 'a pending block list writes nothing')
})

test('saved rows batch author hints and retain companion thumbnails for old and live rows', async (t) => {
  const calls = []
  const { poolMap } = await import('../src/engagement.js')
  const lookupHints = extract(source, 'lookupHints', {
    HINT_AUTHORS_MAX: 10,
    HINT_WIDTH: 2,
    poolMap,
    fetchMember: async (author) => {
      calls.push([author])
      return { ok: true, value: { profileSeq: 2, usernameSeq: 3 } }
    },
    fetchMembers: async (authors) => {
      calls.push(authors)
      return authors.map((a) => a === other ? { ok: false } : { ok: true, value: { profileSeq: 2, usernameSeq: 3 } })
    }
  })
  const list = [entry(author, 3), entry(other, 4), entry(author, 5), entry(owner, 2)]
  t.alike(await lookupHints(list, (a) => a === owner, () => true), { [author]: { profileSeq: 2, usernameSeq: 3 } })
  t.alike(calls, [[author, other]], 'unique, unblocked authors share the lookup')
  t.alike(await lookupHints(list, () => false, () => false), {})
  t.is(calls.length, 1)
  const thumbs = [null, { untrusted: true }]
  const seeded = seedPeeked([row(post(author, 3, { thumbs })), row(post(author, 2))])
  t.is(seeded.get(author).entries[0].thumbs, thumbs)
  t.absent(Object.hasOwn(seeded.get(author).entries[1], 'thumbs'))
  t.ok(source.includes('thumbs={post.thumbs}'))
  t.ok(source.includes('thumbs: q.thumbs'))
})
