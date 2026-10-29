'use strict'

// The blob URL LRU: eviction revokes, one shared load per key, and at most
// four loads at once. A deletion drops keys by media interval, including a
// load that is still in flight.
const test = require('brittle')
const load = () => import('../src/media/cache.js')

const tick = () => new Promise((resolve) => setImmediate(resolve))

function deferred () {
  const out = {}
  out.promise = new Promise((resolve, reject) => { out.resolve = resolve; out.reject = reject })
  return out
}

const hex = (ch) => ch.repeat(64)

function photo (core, start, blocks, sha) {
  return { core, start, blocks, sha256: hex(sha) }
}

test('retryDelay: 2 s, 5 s, 15 s for retryable failures, then stop', async (t) => {
  const { retryDelay, RETRY_DELAYS_MS } = await load()
  t.alike(Array.from(RETRY_DELAYS_MS), [2000, 5000, 15000])
  const notYet = Object.assign(new Error('indisponível'), { retryable: true })
  t.is(retryDelay(notYet, 0), 2000)
  t.is(retryDelay(notYet, 1), 5000)
  t.is(retryDelay(notYet, 2), 15000)
  t.is(retryDelay(notYet, 3), null, 'stops after three')
  t.is(retryDelay(notYet, -1), null)
  t.is(retryDelay(new Error('conteúdo não confere'), 0), null, 'mismatch never retried')
  t.is(retryDelay(null, 0), null)
})

test('mediaKey joins core, start, blocks and sha256', async (t) => {
  const { mediaKey } = await load()
  t.is(mediaKey({ core: 'a', start: 1, blocks: 2, sha256: 'b' }), 'a:1:2:b')
})

test('LRU eviction revokes the least recently used URL', async (t) => {
  const { createMediaCache } = await load()
  const revoked = []
  const cache = createMediaCache({ max: 2, revoke: (url) => revoked.push(url) })
  await cache.get('a', async () => 'blob:a')
  await cache.get('b', async () => 'blob:b')
  t.is(cache.peek('a'), 'blob:a', 'a becomes most recent')
  await cache.get('c', async () => 'blob:c')
  t.alike(revoked, ['blob:b'])
  t.is(cache.peek('b'), null)
  t.is(cache.size, 2)
  cache.clear()
  t.alike(revoked.sort(), ['blob:a', 'blob:b', 'blob:c'])
})

test('one shared in-flight load per key; failures are not cached', async (t) => {
  const { createMediaCache } = await load()
  const cache = createMediaCache({ revoke: () => {} })
  let calls = 0
  const d = deferred()
  const loader = () => { calls++; return d.promise }
  const p1 = cache.get('k', loader)
  const p2 = cache.get('k', loader)
  t.is(p1, p2)
  await tick()
  d.resolve('blob:k')
  t.is(await p1, 'blob:k')
  t.is(calls, 1)
  t.is(await cache.get('k', loader), 'blob:k')
  t.is(calls, 1, 'hit does not reload')

  let fails = 0
  await t.exception(() => cache.get('bad', async () => { fails++; throw new Error('x') }))
  t.is(await cache.get('bad', async () => { fails++; return 'blob:ok' }), 'blob:ok')
  t.is(fails, 2, 'retried after a failure')
})

test('at most four loads run at once', async (t) => {
  const { createMediaCache } = await load()
  const cache = createMediaCache({ revoke: () => {} })
  const gates = []
  let running = 0
  let peak = 0
  const loader = (i) => () => {
    running++
    peak = Math.max(peak, running)
    const g = deferred()
    gates[i] = g
    return g.promise.finally(() => { running-- })
  }
  const all = []
  for (let i = 0; i < 6; i++) all.push(cache.get('k' + i, loader(i)))
  await tick()
  t.is(running, 4)
  t.is(cache.active, 4)
  t.is(cache.waiting, 2)
  gates[0].resolve('blob:0')
  await tick()
  await tick()
  t.is(running, 4, 'the fifth started')
  t.ok(gates[4], 'fifth loader called')
  t.absent(gates[5], 'sixth still waiting')
  for (let i = 1; i < 5; i++) gates[i].resolve('blob:' + i)
  await tick()
  await tick()
  gates[5].resolve('blob:5')
  t.alike(await Promise.all(all), ['blob:0', 'blob:1', 'blob:2', 'blob:3', 'blob:4', 'blob:5'])
  t.is(peak, 4)
})

test('a transient load is stored once per key and evicted and revoked as usual', async (t) => {
  const { createMediaCache } = await load()
  const revoked = []
  const cache = createMediaCache({ max: 2, revoke: (u) => revoked.push(u) })
  let loads = 0
  const transient = (u) => () => { loads++; return Promise.resolve(u) }
  t.is(await cache.get('a', transient('blob:a')), 'blob:a')
  t.is(await cache.get('a', transient('blob:a2')), 'blob:a', 'same key, one entry')
  t.is(loads, 1)
  t.is(cache.size, 1)
  await cache.get('b', transient('blob:b'))
  await cache.get('c', transient('blob:c'))
  t.alike(revoked, ['blob:a'], 'oldest evicted and revoked')
  t.is(cache.peek('a'), null)
})

test('revoke drops a cached hit and does not fetch that key again', async (t) => {
  const { createMediaCache, mediaKey } = await load()
  const revoked = []
  const cache = createMediaCache({ revoke: (url) => revoked.push(url) })
  const core = hex('1')
  const hit = photo(core, 4, 3, 'a')
  const near = photo(core, 7, 1, 'b')
  const other = photo(hex('2'), 4, 3, 'c')
  const hitKey = mediaKey(hit)
  const nearKey = mediaKey(near)
  const otherKey = mediaKey(other)
  await cache.get(hitKey, async () => 'blob:hit')
  await cache.get(nearKey, async () => 'blob:near')
  await cache.get(otherKey, async () => 'blob:other')
  // [6, 7) overlaps the hit [4, 7) and stops before the neighbour [7, 8).
  cache.revoke([{ core, start: 6, blocks: 1 }])
  t.is(cache.peek(hitKey), null)
  t.is(cache.peek(nearKey), 'blob:near', 'a range that does not overlap stays')
  t.is(cache.peek(otherKey), 'blob:other', 'another core stays')
  t.alike(revoked, ['blob:hit'])
  let calls = 0
  await t.exception(() => cache.get(hitKey, async () => { calls++; return 'blob:again' }))
  t.is(calls, 0, 'a revoked key is not fetched again')
  cache.revoke(null)
  cache.revoke([])
  cache.revoke([{ core: 'zz', start: 1, blocks: 1 }])
  t.is(cache.peek(nearKey), 'blob:near', 'junk ranges revoke nothing')
})

test('revoke drops an in-flight load and does not start a queued one', async (t) => {
  const { createMediaCache, mediaKey } = await load()
  const revoked = []
  const cache = createMediaCache({ concurrency: 1, revoke: (url) => revoked.push(url) })
  const core = hex('4')
  const gone = photo(core, 10, 2, 'a')
  const stay = photo(core, 20, 1, 'b')
  const mid = photo(core, 30, 2, 'c')
  const goneKey = mediaKey(gone)
  const stayKey = mediaKey(stay)
  const midKey = mediaKey(mid)

  const gate = deferred()
  let stayCalls = 0
  const staying = cache.get(stayKey, () => { stayCalls++; return gate.promise })
  await tick()
  t.is(stayCalls, 1, 'the only slot is taken')

  let goneCalls = 0
  const leaving = cache.get(goneKey, () => { goneCalls++; return Promise.resolve('blob:gone') })
  await tick()
  t.is(goneCalls, 0, 'still queued')
  cache.revoke([{ core, start: 11, blocks: 1 }])
  gate.resolve('blob:stay')
  t.is(await staying, 'blob:stay', 'an unrelated load is stored')
  await t.exception(() => leaving)
  t.is(goneCalls, 0, 'the queued load never started')
  t.is(cache.peek(goneKey), null)
  t.is(cache.peek(stayKey), 'blob:stay')

  const gate2 = deferred()
  let ran = 0
  const running = cache.get(midKey, () => { ran++; return gate2.promise })
  await tick()
  await tick()
  await tick()
  t.is(ran, 1, 'the load is in flight')
  cache.revoke([{ core, start: 30, blocks: 1 }])
  gate2.resolve('blob:late')
  await t.exception(() => running)
  t.is(cache.peek(midKey), null, 'the late URL is not stored')
  t.alike(revoked, ['blob:late'])
  let again = 0
  await t.exception(() => cache.get(midKey, async () => { again++; return 'blob:no' }))
  t.is(again, 0, 'not fetched again')
})

test('revoke matches an avatar key by the same core and interval', async (t) => {
  const { createMediaCache } = await load()
  const { avatarKey } = await import('../src/media/avatar.js')
  const revoked = []
  const cache = createMediaCache({ revoke: (url) => revoked.push(url) })
  const core = hex('6')
  const face = {
    core,
    mime: 'image/jpeg',
    start: 8,
    blocks: 2,
    bytes: 100,
    sha256: hex('e'),
    width: 512,
    height: 512
  }
  const keep = { ...face, start: 10, blocks: 1, sha256: hex('d') }
  const faceKey = avatarKey(hex('f'), face)
  const keepKey = avatarKey(hex('f'), keep)
  await cache.get(faceKey, async () => 'blob:face')
  await cache.get(keepKey, async () => 'blob:keep')
  cache.revoke([{ core, start: 9, blocks: 1 }])
  t.is(cache.peek(faceKey), null)
  t.is(cache.peek(keepKey), 'blob:keep', 'the next interval stays')
  t.alike(revoked, ['blob:face'])
})

test('tombstoneRanges keeps a range a surviving record shows', async (t) => {
  const { tombstoneRanges } = await load()
  const core = hex('8')
  const other = hex('9')
  const at = '2026-10-29T00:00:00.000Z'
  const range = { core, start: 1, blocks: 1 }
  const shared = { core, start: 5, blocks: 2 }
  // The lower tombstone is listed first: the fold walks the highest seq down.
  t.alike(tombstoneRanges([
    { seq: 4, record: { type: 'delete', seq: 2, at, media: [range] } },
    { seq: 6, record: { type: 'delete', seq: 4, at } }
  ], [2]), [], 'a deleted tombstone has no effect')

  const entries = [
    { seq: 2, record: { type: 'post', text: 'gone', media: [range, shared] } },
    { seq: 3, record: { type: 'post', text: 'stays', media: [{ core, start: 6, blocks: 1 }] } },
    { seq: 5, record: { type: 'profile', name: 'Ana', bio: '', at, avatar: { core, start: 20, blocks: 1 } } },
    { seq: 7, record: { type: 'delete', seq: 2, at, media: [range, shared, { core, start: 20, blocks: 1 }, range] } }
  ]
  t.alike(tombstoneRanges(entries, [2]), [range], 'the shared block and the live avatar stay')
  t.alike(tombstoneRanges(entries, [9]), [])
  t.alike(tombstoneRanges(null, [2]), [])
  const pair = [
    { seq: 9, record: { type: 'delete', seq: 1, at, media: [{ core: other, start: 1, blocks: 1 }] } },
    { seq: 10, record: { type: 'delete', seq: 2, at, media: [{ core: other, start: 3, blocks: 1 }] } }
  ]
  t.alike(tombstoneRanges(pair, [1, 2]).map((r) => r.start).sort(), [1, 3], 'both halves of a pair')
})

test('revokeMedia releases the same range in every live cache', async (t) => {
  const { createMediaCache, mediaKey, revokeMedia } = await load()
  const revoked = []
  const a = createMediaCache({ revoke: (url) => revoked.push(url) })
  const b = createMediaCache({ revoke: (url) => revoked.push(url) })
  const core = hex('7')
  const key = mediaKey(photo(core, 1, 1, 'a'))
  await a.get(key, async () => 'blob:a')
  await b.get(key, async () => 'blob:b')
  revokeMedia([{ core, start: 1, blocks: 1 }])
  t.is(a.peek(key), null)
  t.is(b.peek(key), null)
  t.alike(revoked, ['blob:a', 'blob:b'])
})

test('revokeDeletedMedia revokes tombstone ranges and leaves a survivor', async (t) => {
  const { createMediaCache, mediaKey, revokeDeletedMedia } = await load()
  const revoked = []
  const cache = createMediaCache({ revoke: (url) => revoked.push(url) })
  const core = hex('a')
  const freed = photo(core, 1, 1, 'b')
  const kept = photo(core, 4, 1, 'c')
  const freedKey = mediaKey(freed)
  const keptKey = mediaKey(kept)
  await cache.get(freedKey, async () => 'blob:freed')
  await cache.get(keptKey, async () => 'blob:kept')
  const at = '2026-10-29T00:00:00.000Z'
  let reads = 0
  await revokeDeletedMedia(async (method, params) => {
    t.is(method, 'log.read')
    reads++
    t.is(params.before, undefined)
    return {
      entries: [
        { seq: 3, record: { type: 'post', media: [{ core, start: 4, blocks: 2 }] } },
        { seq: 8, record: { type: 'delete', seq: 2, at, media: [{ core, start: 1, blocks: 1 }, { core, start: 4, blocks: 1 }] } }
      ],
      invalid: [{ seq: 2, reason: 'deleted' }],
      entriesTruncated: 2
    }
  }, [2])
  t.is(reads, 1, 'the tombstone is on the newest page')
  t.is(cache.peek(freedKey), null)
  t.is(cache.peek(keptKey), 'blob:kept', 'a block the survivor still shows stays')
  t.alike(revoked, ['blob:freed'])
})

test('revokeDeletedMedia reads on until the effective tombstone', async (t) => {
  const { createMediaCache, mediaKey, revokeDeletedMedia } = await load()
  const revoked = []
  const cache = createMediaCache({ revoke: (url) => revoked.push(url) })
  const core = hex('b')
  const key = mediaKey(photo(core, 2, 1, 'd'))
  await cache.get(key, async () => 'blob:old')
  const at = '2026-10-29T00:00:00.000Z'
  const calls = []
  await revokeDeletedMedia(async (method, params) => {
    t.is(method, 'log.read')
    calls.push(params.before)
    if (calls.length === 1) {
      return {
        entries: [{ seq: 40, record: { type: 'delete', seq: 30, at } }],
        invalid: [],
        entriesTruncated: 20
      }
    }
    return {
      entries: [{ seq: 20, record: { type: 'delete', seq: 4, at, media: [{ core, start: 2, blocks: 1 }] } }],
      invalid: [],
      entriesTruncated: 10
    }
  }, [4], 36)
  t.alike(calls, [undefined, 40])
  t.is(cache.peek(key), null)
  t.alike(revoked, ['blob:old'])
})

test('revokeDeletedMedia ignores a failed read', async (t) => {
  const { createMediaCache, mediaKey, revokeDeletedMedia } = await load()
  const cache = createMediaCache({ revoke: () => {} })
  const key = mediaKey(photo(hex('c'), 1, 1, 'e'))
  await cache.get(key, async () => 'blob:keep')
  await revokeDeletedMedia(async () => { throw new Error('falhou') }, [1])
  t.is(cache.peek(key), 'blob:keep')
})
