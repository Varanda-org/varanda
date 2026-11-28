'use strict'

const test = require('brittle')
const load = () => import('../src/media/prefetch.js')
const descriptor = start => Object.freeze({ core: 'a'.repeat(64), start: start + 1, blocks: 1, bytes: 1000, sha256: 'b'.repeat(64), mime: 'image/jpeg', width: 100, height: 100 })
const rows = Object.freeze(Array.from({ length: 12 }, (_, i) => Object.freeze({ author: 'a'.repeat(64), media: Object.freeze([descriptor(i)]), thumbs: Object.freeze([descriptor(i + 100)]) })))

test('prefetch starts after the last visible row and defaults to six rows', async t => {
  const { planPrefetch } = await load()
  t.alike(planPrefetch({ rows, lastVisible: 2 }), rows.slice(3, 9).flatMap(row => row.thumbs))
  t.alike(planPrefetch({ rows, lastVisible: -1, ahead: 2 }), [rows[0].thumbs[0], rows[1].thumbs[0]])
})

test('prefetch caps descriptors even within a single row', async t => {
  const { planPrefetch } = await load()
  const thumbs = rows.flatMap(row => row.thumbs)
  const media = rows.flatMap(row => row.media)
  t.alike(planPrefetch({ rows: [{ media, thumbs }], lastVisible: -1 }), thumbs.slice(0, 8))
  for (const max of [0, 1, 3, 8, 20]) {
    const plan = planPrefetch({ rows: [{ media, thumbs }], lastVisible: -1, max })
    t.ok(plan.length <= max)
    t.alike(plan, thumbs.slice(0, max))
  }
})

test('prefetch deduplicates descriptor values regardless of property order', async t => {
  const { planPrefetch } = await load()
  const a = descriptor(0)
  const copy = Object.fromEntries(Object.entries(a).reverse())
  const b = descriptor(1)
  const otherCore = { ...a, core: 'c'.repeat(64) }
  const input = [{ media: [descriptor(20), descriptor(21), descriptor(22)], thumbs: [a, a, copy] }, { media: [descriptor(23), descriptor(24), descriptor(25), descriptor(26)], thumbs: [copy, b, otherCore, b] }]
  const plan = planPrefetch({ rows: input, lastVisible: -1, max: 3 })
  t.alike(plan, [a, b, otherCore])
  t.is(plan[0], a)
  t.is(plan.length, new Set(plan).size)
})

test('empty rows count toward ahead and list boundaries stop the plan', async t => {
  const { planPrefetch } = await load()
  const a = descriptor(0)
  const input = [null, {}, { media: null }, { media: [null, descriptor(20)], thumbs: [null, a] }]
  t.alike(planPrefetch({ rows: input, lastVisible: -1, ahead: 3 }), [])
  t.alike(planPrefetch({ rows: input, lastVisible: -1, ahead: 4 }), [a])
  t.alike(planPrefetch({ rows, lastVisible: 10 }), rows[11].thumbs)
  t.alike(planPrefetch({ rows, lastVisible: 11 }), [])
  t.alike(planPrefetch({ rows: [], lastVisible: -1 }), [])
  t.alike(planPrefetch({ rows, lastVisible: 0, ahead: 0 }), [])
  t.alike(planPrefetch({ rows, lastVisible: 0, ahead: -1 }), [])
  t.alike(planPrefetch({ rows, lastVisible: 0, max: -1 }), [])
})

test('prefetch keeps inputs intact and returns a fresh plan', async t => {
  const { planPrefetch } = await load()
  const args = Object.freeze({ rows, lastVisible: 0 })
  const first = planPrefetch(args)
  first.pop()
  t.alike(planPrefetch(args), rows.slice(1, 7).flatMap(row => row.thumbs))
  t.is(rows.length, 12)
})

test('prefetch: odd window inputs fall back, and clips are never planned', async t => {
  const { planPrefetch } = await load()
  t.alike(planPrefetch({ rows, lastVisible: null, ahead: 1 }), [rows[0].thumbs[0]], 'null means nothing visible yet')
  t.alike(planPrefetch({ rows, lastVisible: undefined, ahead: 1 }), [rows[0].thumbs[0]])
  t.alike(planPrefetch({ rows, lastVisible: 1.5, ahead: 1 }), [rows[2].thumbs[0]], 'a fraction is floored')
  t.alike(planPrefetch({ rows, lastVisible: 2, ahead: null }), rows.slice(3, 9).flatMap(row => row.thumbs), 'null ahead is the default')
  t.alike(planPrefetch({ rows, lastVisible: -1, ahead: 1, max: NaN }), [rows[0].thumbs[0]], 'NaN max is the default')
  const clip = Object.freeze({ ...descriptor(50), mime: 'video/mp4' })
  t.alike(planPrefetch({ rows: [{ media: [descriptor(40), clip], thumbs: [descriptor(41), descriptor(42)] }], lastVisible: -1 }), [], 'no thumbnail beside a video')
  t.alike(planPrefetch({ rows: null, lastVisible: 0 }), [])
})

const tick = () => new Promise(resolve => setImmediate(resolve))

function deferred () {
  const out = {}
  out.promise = new Promise((resolve, reject) => { out.resolve = resolve; out.reject = reject })
  return out
}

async function fixture () {
  const { createMediaCache, mediaKey } = await import('../src/media/cache.js')
  const { createThumbnailPrefetch } = await load()
  const timers = new Set()
  const revoked = []
  const cache = createMediaCache({
    revoke: url => revoked.push(url),
    defer: fn => { timers.add(fn); return fn },
    cancelDefer: fn => timers.delete(fn)
  })
  const flush = async () => {
    for (let i = 0; i < 2; i++) {
      for (const fn of [...timers]) { timers.delete(fn); fn() }
      await tick()
    }
  }
  const calls = []
  const starts = []
  const fetch = (author, d, signal) => {
    const gate = deferred()
    starts.push('prefetch')
    calls.push({ author, d, signal, gate })
    signal.addEventListener('abort', () => gate.reject(new Error('cancelado')))
    return gate.promise
  }
  const options = {
    cache,
    load: (author, d) => signal => fetch(author, d, signal),
    defer: fn => { timers.add(fn); return fn },
    cancelDefer: fn => timers.delete(fn)
  }
  const lane = createThumbnailPrefetch(options)
  return { cache, mediaKey, lane, calls, starts, flush, revoked, timers, options, another: () => createThumbnailPrefetch(options) }
}

test('the next six thumbnails start after visible requests, two at a time, and later loads hit', async t => {
  const { cache, mediaKey, lane, calls, starts, flush } = await fixture()
  lane.update({ rows, lastVisible: 2 })
  const visible = cache.get(mediaKey(rows[2].media[0]), async () => { starts.push('visible'); return 'blob:visible' })
  t.is(calls.length, 0, 'prefetch is deferred')
  await flush()
  t.alike(starts, ['visible', 'prefetch', 'prefetch'])
  t.is(await visible, 'blob:visible')
  t.is(calls.length, 2, 'only two thumbnails start')
  for (let i = 0; i < 6; i += 2) {
    t.alike(calls.slice(i).map(call => call.d), rows.slice(3 + i, 5 + i).flatMap(row => row.thumbs))
    for (const call of calls.slice(i)) call.gate.resolve('blob:' + call.d.start)
    await tick()
    await flush()
  }
  t.is(calls.length, 6, 'no seventh row or full size')
  let misses = 0
  for (const row of rows.slice(3, 9)) {
    const d = row.thumbs[0]
    t.is(await cache.get(mediaKey(d), () => { misses++; return 'blob:miss' }), 'blob:' + d.start)
  }
  t.is(misses, 0, 'later thumbnail loads make no request')
  lane.cancel()
})

test('visible requests queued after prefetch start first and retain all four normal slots', async t => {
  const { cache, lane, calls, flush } = await fixture()
  lane.update({ rows, lastVisible: 0 })
  const gates = Array.from({ length: 5 }, deferred)
  const started = []
  const visible = gates.map((gate, i) => cache.get('visible:' + i, () => { started.push(i); return gate.promise }))
  await flush()
  t.alike(started, [0, 1, 2, 3])
  t.is(calls.length, 0, 'a queued visible request blocks the prefetch queue')
  gates[0].resolve('blob:0')
  await tick()
  await flush()
  t.alike(started, [0, 1, 2, 3, 4], 'the later visible request started first')
  t.is(calls.length, 2)
  t.is(cache.active, 4, 'the two prefetches consume none of the four visible slots')
  const later = cache.get('later', () => { started.push(5); return 'blob:later' })
  calls[0].gate.resolve('blob:thumb')
  await tick()
  await flush()
  t.is(calls.length, 2, 'queued visible work still wins after a prefetch completes')
  gates[1].resolve('blob:1')
  await tick()
  t.is(await later, 'blob:later')
  for (let i = 2; i < gates.length; i++) gates[i].resolve('blob:' + i)
  await Promise.all(visible)
  lane.cancel()
  await tick()
})

test('two lists share a two-prefetch bound; moving and unmounting drop queues and abort flights', async t => {
  const { lane, another, calls, flush, timers } = await fixture()
  const second = another()
  lane.update({ rows, lastVisible: 0 })
  second.update({ rows, lastVisible: 6 })
  await flush()
  t.is(calls.length, 2, 'two globally, not two per list')
  lane.update({ rows, lastVisible: 10 })
  t.ok(calls.every(call => call.signal.aborted), 'old in-flight requests aborted on a range change')
  await flush()
  await flush()
  t.is(calls.length, 4)
  t.alike(calls.slice(2).map(call => call.d), rows.slice(7, 9).flatMap(row => row.thumbs), 'old queued thumbnails never started')
  second.cancel()
  lane.cancel()
  await tick()
  await flush()
  t.ok(calls.every(call => call.signal.aborted), 'unmount aborts every remaining flight')
  t.is(calls.length, 4, 'unmount drops the new queued plan too')
  t.is(timers.size, 0)
})

test('a visible load takes over a prefetched key and survives list cancellation', async t => {
  const { cache, mediaKey, lane, calls, flush } = await fixture()
  lane.update({ rows, lastVisible: 0 })
  await flush()
  const first = calls[0]
  let extra = 0
  const visible = cache.get(mediaKey(first.d), () => { extra++; return 'blob:duplicate' }).catch(err => err)
  t.absent(first.signal.aborted, 'the running prefetch is adopted')
  lane.cancel()
  t.absent(first.signal.aborted, 'list cancellation is detached')
  first.gate.resolve('blob:visible')
  t.is(await visible, 'blob:visible')
  t.is(cache.peek(mediaKey(first.d)), 'blob:visible')
  t.is(extra, 0, 'one request total for the adopted key')
})

test('a canceled fetch that ignores abort cannot populate the cache or exceed the flight bound', async t => {
  const { cache, mediaKey, flush, revoked } = await fixture()
  const signals = []
  const gates = Array.from({ length: 3 }, deferred)
  const stops = gates.map((gate, i) => cache.prefetch(mediaKey(descriptor(i)), signal => { signals.push(signal); return gate.promise }))
  await flush()
  stops[0]()
  await flush()
  t.ok(signals[0].aborted)
  t.is(signals.length, 2, 'an ignored abort still occupies its prefetch slot')
  gates[0].resolve('blob:late')
  await tick()
  await flush()
  t.is(signals.length, 3)
  t.alike(revoked, ['blob:late'])
  t.is(cache.peek(mediaKey(descriptor(0))), null)
  stops.forEach(stop => stop())
  gates[1].resolve('blob:late2')
  gates[2].resolve('blob:late3')
  await tick()
})

test('clear and range revocation cancel prefetches without retries or stale cache entries', async t => {
  for (const revoke of [false, true]) {
    const { cache, lane, calls, flush } = await fixture()
    lane.update({ rows, lastVisible: 0 })
    await flush()
    if (revoke) cache.revoke([{ core: rows[0].thumbs[0].core, start: 1, blocks: 1000 }])
    else cache.clear()
    t.ok(calls.every(call => call.signal.aborted))
    await tick()
    await flush()
    t.is(calls.length, 2, 'no queued work or retry after purge')
    t.is(cache.size, 0)
    lane.cancel()
  }
})

test('prefetch rejects peer descriptors that the row cannot use', async t => {
  const { planPrefetch } = await load()
  const full = descriptor(20)
  const thumb = descriptor(40)
  const badRows = [
    { media: [full] },
    { media: [full], thumbs: [thumb, thumb] },
    { media: [full], thumbs: [null] },
    { media: [{ ...full, mime: 'image/gif' }], thumbs: [thumb] },
    { media: [full, { ...full, mime: 'video/mp4' }], thumbs: [thumb, null] },
    { media: [full], thumbs: [full] },
    { media: [full, thumb], thumbs: [thumb, null] },
    { media: [{ ...full, start: 0 }], thumbs: [thumb] },
    ...[{ start: 0 }, { width: 641 }, { bytes: 65537, blocks: 3 }, { mime: 'image/png' }, { sha256: 'bad' }, { extra: true }].map(over => ({ media: [full], thumbs: [{ ...thumb, ...over }] }))
  ]
  for (const row of badRows) t.alike(planPrefetch({ rows: [row], lastVisible: -1 }), [])
  const { lane, calls, flush } = await fixture()
  for (const author of [undefined, '', 'invalid']) lane.update({ rows: [{}, { media: [full], thumbs: [thumb], author }], lastVisible: 0 })
  await flush()
  t.is(calls.length, 0, 'invalid authors never fetch')
  lane.cancel()
})

test('prefetch verifies hashes and decoded thumbnail bounds before caching, and forwards abort to fetch', async t => {
  const { createHash, webcrypto } = require('node:crypto')
  const rpc = require('@varanda/rpc')
  const { fetchMedia } = await import('../src/media/fetch.js')
  const { prefetchLoad } = await import('../src/media/prefetchLoad.js')
  const { thumbBoundsOk } = await import('../src/media/variant.js')
  const { createThumbnailPrefetch } = await load()
  for (const mode of ['ok', 'hash', 'bounds', 'abort']) {
    const { cache, mediaKey, flush, options } = await fixture()
    const bytes = new Uint8Array(100)
    bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])
    if (mode === 'bounds') { bytes[9] = 0x02; bytes[10] = 0x81 }
    const d = { ...descriptor(40), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    if (mode === 'hash') d.sha256 = '0'.repeat(64)
    const hashed = deferred()
    const subtle = {
      digest: async (...args) => {
        try { return await webcrypto.subtle.digest(...args) } finally { hashed.resolve() }
      }
    }
    let init
    let urls = 0
    const fetch = async (url, options) => {
      init = options
      if (mode === 'abort') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      return { status: 200, arrayBuffer: async () => bytes.buffer }
    }
    const lane = createThumbnailPrefetch({
      ...options,
      load: prefetchLoad({
        generation: () => 0,
        fetchMedia,
        mediaFetch: () => fetch,
        mediaHashDeps: () => ({ subtle }),
        thumbBytesOk: bytes => thumbBoundsOk(rpc.mediaBounds(bytes, 'image/jpeg')),
        urlFromBytes: () => { urls++; return 'blob:verified' }
      })
    })
    lane.update({ rows: [{}, { author: rows[0].author, media: [descriptor(1)], thumbs: [d] }], lastVisible: 0 })
    await flush()
    if (mode === 'abort') {
      lane.cancel()
      t.ok(init.signal.aborted, 'fetch.js forwards the cancellation to the transport')
    }
    if (mode !== 'abort') await hashed.promise
    await tick()
    t.is(urls, mode === 'ok' ? 1 : 0, mode + ': only verified, bounded bytes become a URL')
    t.is(cache.peek(mediaKey(d)), mode === 'ok' ? 'blob:verified' : null, mode + ': cache admission')
    lane.cancel()
  }
})

test('moving one row keeps the running key and unchanged updates keep the timer', async t => {
  const { lane, calls, flush, timers } = await fixture()
  lane.update({ rows, lastVisible: 0 })
  const timer = [...timers][0]
  lane.update({ rows, lastVisible: 0 })
  t.is([...timers][0], timer, 'unchanged plan does not postpone its start')
  await flush()
  lane.update({ rows, lastVisible: 1 })
  t.ok(calls[0].signal.aborted, 'the key leaving the window is cancelled')
  t.absent(calls[1].signal.aborted, 'the key still planned survives the update')
  await flush()
  t.is(calls.filter(call => call.d === rows[2].thumbs[0]).length, 1, 'no restart of the retained key')
  lane.cancel()
  await tick()
})

test('a burst starts only the final plan after the 150 ms trailing timer', async t => {
  const { createThumbnailPrefetch } = await load()
  const timers = new Map()
  const starts = []
  const lane = createThumbnailPrefetch({
    cache: { prefetch: key => { starts.push(key); return () => {} } },
    load: () => () => {},
    defer: (fn, ms) => { timers.set(fn, ms); return fn },
    cancelDefer: fn => timers.delete(fn)
  })
  for (let lastVisible = 0; lastVisible < 4; lastVisible++) lane.update({ rows, lastVisible })
  t.is(starts.length, 0, 'a fling starts no intermediate request')
  t.alike([...timers.values()], [150], 'one short trailing timer')
  for (const fn of timers.keys()) fn()
  const { mediaKey } = await import('../src/media/cache.js')
  t.alike(starts, rows.slice(4, 10).map(row => mediaKey(row.thumbs[0])), 'only the final window starts once')
  lane.cancel()
})

test('visibility waits for a callback, resets on rows, and disable or unmount cancels', async t => {
  const { createThumbnailPrefetch } = await load()
  const { options, calls, flush, timers } = await fixture()
  const mounted = { current: true }
  const lane = createThumbnailPrefetch({ ...options, mounted })
  const info = { viewableItems: [{ isViewable: true, index: 0 }] }
  const persistOf = () => false
  lane.configure({ rows, enabled: true, persistOf })
  await flush()
  t.is(calls.length, 0, 'no work before the first viewability callback')
  lane.viewable(info)
  t.is(calls.length, 0, 'the callback still waits for the trailing timer')
  await flush()
  t.is(calls.length, 2)
  lane.configure({ rows: rows.slice(1), enabled: true, persistOf })
  t.ok(calls.every(call => call.signal.aborted), 'old rows are cancelled')
  await flush()
  t.is(calls.length, 2, 'new rows never reuse the previous visible index')
  lane.viewable(info)
  await flush()
  t.is(calls.length, 4, 'new rows require a fresh callback')
  lane.configure({ rows, enabled: false, persistOf })
  lane.viewable(info)
  await flush()
  t.ok(calls.every(call => call.signal.aborted), 'disable cancels running loads')
  t.is(calls.length, 4, 'disabled callbacks cannot queue work')
  lane.configure({ rows, enabled: true, persistOf })
  lane.viewable(info)
  await flush()
  mounted.current = false
  lane.cancel()
  lane.viewable(info)
  lane.update({ rows, lastVisible: 5 })
  await flush()
  t.ok(calls.every(call => call.signal.aborted), 'unmount cancels running loads')
  t.is(calls.length, 6, 'callbacks after unmount cannot queue work')
  t.is(timers.size, 0, 'no timer survives unmount')
})

test('a list without a keep policy never prefetches', async t => {
  const { createThumbnailPrefetch } = await load()
  const { options, calls, flush } = await fixture()
  const lane = createThumbnailPrefetch(options)
  const info = { viewableItems: [{ isViewable: true, index: 0 }] }
  lane.configure({ rows, enabled: true })
  lane.viewable(info)
  await flush()
  t.is(calls.length, 0, 'no persistOf, no prefetch')
  lane.configure({ rows, enabled: true, persistOf: () => false })
  lane.viewable(info)
  await flush()
  t.is(calls.length, 2, 'a stated policy turns the lane on')
  lane.cancel()
  await tick()
})

test('a key skipped while another list owned it is retried on the next update', async t => {
  const { lane, another, calls, flush } = await fixture()
  const other = another()
  lane.update({ rows, lastVisible: 0 })
  await flush()
  t.is(calls.length, 2)
  other.update({ rows, lastVisible: 0 })
  await flush()
  t.is(calls.length, 2, 'owned keys are not fetched twice')
  lane.cancel()
  await tick()
  other.update({ rows, lastVisible: 0 })
  await flush()
  t.is(calls.length, 4, 'the second list takes the freed keys')
  other.cancel()
  await tick()
})

test('non-retryable prefetch failures are remembered but retries and cancellations are not', async t => {
  const { cache, flush } = await fixture()
  for (const [key, err, expected] of [
    ['bad', new Error('foto inválida'), 1],
    ['retry', Object.assign(new Error('sem conexão'), { retryable: true }), 2],
    ['cancel', new Error('cancelado'), 2],
    ['abort', Object.assign(new Error('aborted'), { name: 'AbortError' }), 2]
  ]) {
    let calls = 0
    const load = () => { calls++; throw err }
    cache.prefetch(key, load)
    await flush()
    cache.prefetch(key, load)
    await flush()
    t.is(calls, expected, key + ': speculative failures do not loop')
  }
  let visible = 0
  t.is(await cache.get('bad', () => { visible++; return 'blob:manual' }), 'blob:manual')
  t.is(visible, 1, 'visible loads can still try a failed prefetch key')
  for (let i = 0; i < 129; i++) {
    cache.prefetch('bounded:' + i, () => { throw new Error('invalid') })
    await flush()
  }
  let evicted = 0
  cache.prefetch('bounded:0', () => { evicted++; return 'blob:oldest' })
  await flush()
  t.is(evicted, 1, 'the remembered failure set is bounded')
})

test('queued prefetches yield to visible loads and adopted loads honor purge', async t => {
  for (const mode of ['queued', 'clear', 'revoke']) {
    const { cache, mediaKey, flush, revoked } = await fixture()
    const key = mediaKey(descriptor(1))
    const gate = deferred()
    let speculative = 0
    cache.prefetch(key, () => { speculative++; return gate.promise })
    if (mode !== 'queued') await flush()
    let visible = 0
    const pending = cache.get(key, () => { visible++; return 'blob:fresh' })
    if (mode === 'clear') cache.clear()
    if (mode === 'revoke') cache.revoke([descriptor(1)])
    gate.resolve('blob:stale')
    if (mode === 'revoke') await t.exception(pending, /apagada/)
    else t.is(await pending, 'blob:fresh', mode + ': visible result')
    await flush()
    t.is(speculative, mode === 'queued' ? 0 : 1, mode + ': no speculative restart')
    t.is(visible, mode === 'revoke' ? 0 : 1, mode + ': visible request count')
    if (mode !== 'queued') t.alike(revoked, ['blob:stale'], mode + ': stale URL released')
  }
})

async function loadFixture (overrides = {}) {
  const { prefetchLoad } = await import('../src/media/prefetchLoad.js')
  const calls = { fetch: [], keep: [], validate: [], read: [] }
  const bytes = new Uint8Array(1000)
  let gen = 0
  const deps = {
    keptUrl: (...args) => { calls.read.push(args); return null },
    keptBytes: async () => null,
    keep: (...args) => { calls.keep.push(args); return 'file:kept' },
    generation: () => gen,
    fetchMedia: async (...args) => { calls.fetch.push(args); return bytes },
    urlFromBytes: () => 'blob:bytes',
    thumbBytesOk: (...args) => { calls.validate.push(args); return true },
    mediaHashDeps: () => ({ subtle: 'hash' }),
    mediaFetch: () => 'transport',
    ...overrides
  }
  return { build: prefetchLoad(deps), calls, bytes, bump: () => { gen++ } }
}

test('prefetch load reads kept hits and keeps followed thumbnails with the row policy', async t => {
  const author = rows[0].author
  const d = descriptor(1)
  const signal = new AbortController().signal
  const hit = await loadFixture({ keptUrl: () => 'file:hit' })
  t.is(await hit.build(author, d, true)(signal), 'file:hit')
  t.is(hit.calls.fetch.length, 0, 'a kept URI costs no network')
  const web = await loadFixture({ keptBytes: async () => new Uint8Array(d.bytes) })
  t.is(await web.build(author, d, true)(signal), 'blob:bytes')
  t.is(web.calls.fetch.length, 0, 'kept bytes cost no network')
  t.is(web.calls.validate.length, 1, 'kept bytes are validated')
  for (const persist of [true, false, undefined, 'peek']) {
    const { build, calls, bytes } = await loadFixture()
    await build(author, d, persist)(signal)
    t.is(calls.keep.length, persist === true ? 1 : 0, String(persist) + ': row keep policy and peek gate')
    t.alike(calls.validate, [[bytes, d]], 'every fetched thumbnail is validated')
    t.alike(calls.fetch[0], [author, d, { subtle: 'hash', persist: persist === true, fetch: 'transport', signal }], 'same transport, hash and signal')
    if (persist === true) t.alike(calls.keep[0], ['posts', author, d, bytes])
    if (persist === false || persist === undefined) t.is(calls.read.length, 0, 'transient rows do not read kept copies')
  }
})

test('prefetch load rejects invalid bytes and captures generation before the queue', async t => {
  const author = rows[0].author
  const d = descriptor(1)
  for (const persist of [false, true, 'peek']) {
    const { build, calls } = await loadFixture({ thumbBytesOk: () => false, keptBytes: async () => new Uint8Array(d.bytes) })
    await t.exception(build(author, d, persist)(), /foto inválida/)
    t.is(calls.keep.length, 0, 'invalid bytes are never kept: ' + persist)
  }
  const { build, calls, bump } = await loadFixture()
  const queued = build(author, d, true)
  bump()
  t.is(await queued(), 'blob:bytes')
  t.is(calls.keep.length, 0, 'a purge during the queue prevents keeping')
})

test('the lane passes row and screen persistence policies into the load factory', async t => {
  const { createThumbnailPrefetch } = await load()
  const { options, flush } = await fixture()
  const policies = []
  const lane = createThumbnailPrefetch({
    ...options,
    cache: { prefetch: () => () => {} },
    load: (author, d, persist) => { policies.push(persist); return () => {} }
  })
  const input = [{}, ...[true, false, 'peek', undefined].map((persist, i) => ({ ...rows[i], persist }))]
  lane.update({ rows: input, lastVisible: 0 })
  await flush()
  t.alike(policies, [true, false, 'peek', false], 'unknown defaults to false')
  lane.cancel()
  policies.length = 0
  lane.update({ rows: input, lastVisible: 0, persistOf: row => row.author === rows[0].author })
  await flush()
  t.alike(policies, [true, true, true, true], 'the screen rule matches the rendered rows')
  lane.cancel()
})

test('peek prefetch uses only the bounded store after blocks are known', async t => {
  const { setAllowedAuthors, noteBlocksKnown, wipeEpoch, dropAuthors, wipeLocalCaches } = await import('../src/localCaches.js')
  const author = rows[0].author
  const d = descriptor(1)
  setAllowedAuthors([])
  try {
    const before = await loadFixture()
    await before.build(author, d, 'peek')()
    t.is(before.calls.keep.length, 0, 'no peek keep before block.list')
    noteBlocksKnown(wipeEpoch())
    const allowed = await loadFixture()
    t.is(await allowed.build(author, d, 'peek')(), 'file:kept')
    t.is(allowed.calls.keep[0]?.[0], 'peekPosts', 'only the bounded peek kind')
    t.is(allowed.calls.fetch[0][2].persist, false, 'no persistent HTTP cache for peek')
    dropAuthors([author])
    const blocked = await loadFixture({ keptUrl: () => 'file:blocked' })
    t.is(await blocked.build(author, d, 'peek')(), 'blob:bytes', 'blocked kept copies do not answer')
    t.is(blocked.calls.keep.length, 0, 'blocked copies are never kept')
  } finally {
    wipeLocalCaches()
  }
})

test('the lane passes a copy policy through unchanged', async t => {
  const { createThumbnailPrefetch } = await load()
  const { options, flush } = await fixture()
  const policies = []
  const lane = createThumbnailPrefetch({
    ...options,
    cache: { prefetch: () => () => {} },
    load: (author, d, persist) => { policies.push(persist); return () => {} }
  })
  lane.update({ rows: [{}, { ...rows[0], persist: 'copy' }], lastVisible: 0 })
  await flush()
  t.alike(policies, ['copy'], 'a row policy')
  lane.cancel()
  policies.length = 0
  lane.update({ rows: [{}, rows[0]], lastVisible: 0, persistOf: () => 'copy' })
  await flush()
  t.alike(policies, ['copy'], 'a screen policy')
  lane.cancel()
})

test('copy prefetch: loadKept picks the kind, the HTTP cache only for a followed author', async t => {
  const { setAllowedAuthors, noteBlocksKnown, wipeEpoch, dropAuthors, wipeLocalCaches } = await import('../src/localCaches.js')
  const author = rows[0].author
  const stranger = 'c'.repeat(64)
  const d = descriptor(1)
  wipeLocalCaches()
  setAllowedAuthors([author])
  try {
    const followed = await loadFixture()
    t.is(await followed.build(author, d, 'copy')(), 'file:kept')
    t.alike(followed.calls.read.map(args => args[0]), ['posts'], 'a followed author reads the main kind first')
    t.is(followed.calls.keep[0]?.[0], 'posts', 'and keeps there')
    t.is(followed.calls.fetch[0][2].persist, true, 'a followed author may use the HTTP cache')

    const early = await loadFixture()
    t.is(await early.build(stranger, d, 'copy')(), 'blob:bytes')
    t.alike(early.calls.read.map(args => args[0]), ['posts'], 'no copy read before a block list is known')
    t.is(early.calls.keep.length, 0, 'no copy keep before block.list')
    t.is(early.calls.fetch[0][2].persist, false, 'a stranger never reaches the HTTP cache')

    noteBlocksKnown(wipeEpoch())
    const kept = await loadFixture({ keptUrl: (kind) => { kept.calls.read.push([kind]); return kind === 'copyPosts' ? 'file:copy' : null } })
    t.is(await kept.build(stranger, d, 'copy')(), 'file:copy', 'a copy-kind hit answers once blocks are known')
    t.is(kept.calls.fetch.length, 0, 'at no network cost')

    const fresh = await loadFixture()
    t.is(await fresh.build(stranger, d, 'copy')(), 'file:kept')
    t.is(fresh.calls.keep[0]?.[0], 'copyPosts', 'a stranger keeps only to the copy kind')
    t.is(fresh.calls.fetch[0][2].persist, false, 'still no HTTP cache')

    dropAuthors([stranger])
    const blocked = await loadFixture({ keptUrl: () => 'file:blocked' })
    t.is(await blocked.build(stranger, d, 'copy')(), 'blob:bytes', 'a denied author is never answered from disk')
    t.is(blocked.calls.keep.length, 0, 'nor kept')
  } finally {
    wipeLocalCaches()
  }
})
