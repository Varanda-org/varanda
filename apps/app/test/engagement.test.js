// Optimistic like/repost state, index counts and second-pass refs (engagement.js).
'use strict'

const test = require('brittle')
const load = () => import('../src/engagement.js')

const R1 = 'ab'.repeat(32) + ':1'
const R2 = 'cd'.repeat(32) + ':2'

function deferred () {
  let resolve
  let reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('poolMap starts each item once, two at a time, and waits for all to settle', async (t) => {
  const { poolMap } = await load()
  const gates = Array.from({ length: 4 }, deferred)
  const started = []
  const settled = []
  let done = false
  const run = poolMap([0, 1, 2, 3], 2, async (item) => {
    started.push(item)
    try {
      await gates[item].promise
    } catch {}
    settled.push(item)
  }).then(() => { done = true })
  await tick()
  t.alike(started, [0, 1], 'the third waits for a slot')
  t.absent(done)
  gates[1].reject(new Error('read failed'))
  await tick()
  t.alike(started, [0, 1, 2], 'a caught failure releases the worker')
  gates[2].resolve()
  await tick()
  t.alike(started, [0, 1, 2, 3], 'each item starts once')
  gates[3].resolve()
  await tick()
  t.absent(done, 'still waits for the first item')
  gates[0].resolve()
  await run
  t.ok(done)
  t.alike(settled, [1, 2, 3, 0])
})

test('poolMap width one is sequential and an empty pool does not call fn', async (t) => {
  const { poolMap } = await load()
  const gates = Array.from({ length: 3 }, deferred)
  const started = []
  const run = poolMap([0, 1, 2], 1, async (item) => {
    started.push(item)
    await gates[item].promise
  })
  for (let i = 0; i < gates.length; i++) {
    await tick()
    t.alike(started, Array.from({ length: i + 1 }, (_, j) => j))
    gates[i].resolve()
  }
  await run
  await poolMap([], 2, () => t.fail('empty pool called fn'))
})

test('two pools share a limiter of two slots in FIFO order', async (t) => {
  const { createLimiter, poolMap } = await load()
  const limiter = createLimiter(2)
  const gates = Array.from({ length: 6 }, deferred)
  const started = []
  let active = 0
  let peak = 0
  const read = (item) => limiter.run(async () => {
    active++
    peak = Math.max(peak, active)
    started.push(item)
    await gates[item].promise
    active--
  })
  const a = poolMap([0, 1, 4], 2, read)
  const b = poolMap([2, 3, 5], 2, read)
  await tick()
  t.alike(started, [0, 1], 'the second pool shares the occupied slots')
  for (let i = 0; i < gates.length; i++) {
    gates[i].resolve()
    await tick()
    t.alike(started, Array.from({ length: Math.min(i + 3, 6) }, (_, j) => j), 'queued calls start in FIFO order')
    t.ok(active <= 2, 'no third call runs')
  }
  await Promise.all([a, b])
  t.is(peak, 2)
  t.is(active, 0)
})

test('a throwing or rejecting limiter call frees its slot for the next call', async (t) => {
  const { createLimiter } = await load()
  const limiter = createLimiter(1)
  const gate = deferred()
  const started = []
  const failure = new Error('read failed')
  const first = limiter.run(() => {
    started.push(0)
    return gate.promise
  })
  const throwing = limiter.run(() => {
    started.push(1)
    throw failure
  }).catch((err) => err)
  const rejecting = limiter.run(async () => {
    started.push(2)
    throw failure
  }).catch((err) => err)
  const last = limiter.run(() => {
    started.push(3)
    return 'last'
  })
  t.alike(started, [0], 'all later calls wait')
  gate.resolve('first')
  t.alike(await Promise.all([first, throwing, rejecting, last]), ['first', failure, failure, 'last'])
  t.alike(started, [0, 1, 2, 3], 'both failures release the slot in FIFO order')
})

test('front limiter calls run before queued background calls, each lane FIFO', async (t) => {
  const { createLimiter } = await load()
  const limiter = createLimiter(1)
  const gate = deferred()
  const started = []
  const run = (id, opts) => limiter.run(() => { started.push(id) }, opts)
  const first = limiter.run(() => {
    started.push('busy')
    return gate.promise
  })
  const all = [run('back1'), run('back2'), run('front1', { front: true }), run('front2', { front: true })]
  t.alike(started, ['busy'], 'all wait for the busy slot')
  gate.resolve()
  await Promise.all([first, ...all])
  t.alike(started, ['busy', 'front1', 'front2', 'back1', 'back2'])
})

test('applyToggle returns a new state and never mutates', async (t) => {
  const { emptyState, applyToggle, fromRead } = await load()
  const s0 = emptyState()
  const s1 = applyToggle(s0, 'like', R1, true)
  t.ok(s1.liked.has(R1))
  t.is(s0.liked.size, 0, 'input untouched')
  const s2 = applyToggle(s1, 'repost', R1, true)
  t.ok(s2.reposted.has(R1) && s2.liked.has(R1))
  t.not(s2.liked, s1.liked, 'sets are copies')
  const s3 = applyToggle(s2, 'like', R1, false)
  t.absent(s3.liked.has(R1))
  t.ok(s2.liked.has(R1))
  t.is(applyToggle(s3, 'curtir', R1, true), s3, 'unknown kind')
  const read = fromRead({ liked: [R1, 5], reposted: [R2] })
  t.alike([...read.liked], [R1])
  t.alike([...read.reposted], [R2])
  t.is(fromRead(null).liked.size, 0)
})

test('countsAfter never goes below 0 and null stays null', async (t) => {
  const { countsAfter } = await load()
  const c = Object.freeze({ replies: 1, likes: 0, reposts: 2, quotes: 0 })
  t.alike(countsAfter(c, 'like', 1), { replies: 1, likes: 1, reposts: 2, quotes: 0 })
  t.alike(countsAfter(c, 'like', -1), { ...c, likes: 0 })
  t.alike(countsAfter(c, 'repost', -1), { ...c, reposts: 1 })
  t.is(countsAfter(null, 'like', 1), null)
  t.is(countsAfter(c, 'quote', 1), c)
})

test('mergeCounts lets the fetched counts win', async (t) => {
  const { mergeCounts } = await load()
  const a = { replies: 0, likes: 1, reposts: 0, quotes: 0 }
  const b = { replies: 3, likes: 2, reposts: 0, quotes: 0 }
  const map = new Map([[R1, a]])
  const merged = mergeCounts(map, { [R1]: b, [R2]: a })
  t.is(merged.get(R1), b)
  t.is(merged.get(R2), a)
  t.is(map.get(R1), a, 'input untouched')
  t.is(mergeCounts(map, new Map([[R2, b]])).get(R2), b)
  t.is(mergeCounts(null, null).size, 0)
})

test('secondPassRefs: quote and reply parent, one level, deduped', async (t) => {
  const { secondPassRefs } = await load()
  const A = 'ab'.repeat(32)
  const B = 'cd'.repeat(32)
  const C = 'ef'.repeat(32)
  // A repost resolves to the original: a reply's parent is the second pass.
  const reply = Object.freeze({ author: A, seq: 4, text: 'oi', replyTo: Object.freeze({ author: B, seq: 2 }), quote: null })
  t.alike(secondPassRefs([reply]), [B + ':2'], 'reposted reply')
  // The quoted post's own quote is a further level and is not followed.
  const quoted = { author: A, seq: 5, quote: { author: C, seq: 1, quote: { author: B, seq: 9 } } }
  t.alike(secondPassRefs([quoted]), [C + ':1'], 'reposted quote')
  t.alike(secondPassRefs([{ author: A, seq: 1, text: 'plain', replyTo: null, quote: null }]), [], 'plain post')
  t.alike(secondPassRefs([
    null,
    { quote: null, replyTo: undefined },
    { quote: { seq: 1 }, replyTo: { author: B, seq: 0 } },
    { replyTo: { author: B, seq: 1.5 } },
    { quote: { author: 1, seq: 2 } }
  ]), [], 'missing ref')
  t.alike(secondPassRefs([{ quote: { seq: 1 }, replyTo: { author: B, seq: 3 } }]), [B + ':3'], 'missing quote keeps the parent')
  const again = { quote: { author: C.toUpperCase(), seq: 1 }, replyTo: { author: B, seq: 2 } }
  t.alike(secondPassRefs([quoted, again, reply, quoted]), [C + ':1', B + ':2'], 'deduped')
  t.alike(secondPassRefs(null), [])
})
