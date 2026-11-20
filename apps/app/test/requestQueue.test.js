'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const load = () => import('../src/requestQueue.js')

function heldSend () {
  const calls = []
  let active = 0
  let peak = 0
  return {
    calls,
    get peak () { return peak },
    send (method, params) {
      active++
      peak = Math.max(peak, active)
      return new Promise((resolve, reject) => {
        calls.push({
          method,
          params,
          release (result = params) {
            active--
            resolve(result)
          },
          fail (err) {
            active--
            reject(err)
          }
        })
      })
    }
  }
}

async function releaseAll (held, pending) {
  for (let i = 0; i < pending.length; i++) {
    held.calls[i].release()
    await pending[i]
  }
  return Promise.all(pending)
}

// maxInFlight is 5 so one of the 6 total slots stays free for a sync control,
// and two of the client's 8 stay for the identity calls and the connect-time
// sync.status outside the queue.
test('20 boot requests settle with at most five sends and FIFO across reads and writes', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  const methods = Array.from({ length: 20 }, (_, i) => i % 2 ? 'post.create' : 'feed.read')
  const pending = methods.map((method, i) => queue.run(method, { i }, held.send))
  t.is(held.calls.length, 5)
  const results = await releaseAll(held, pending)
  t.is(held.peak, 5)
  t.alike(held.calls.map((c) => c.method), methods)
  t.alike(held.calls.map((c) => c.params.i), methods.map((_, i) => i))
  t.alike(results, methods.map((_, i) => ({ i })))
})

// A control used to stack an extra send on the reads. It now shares maxTotal (6) and still skips ahead of waiters.
test('sync controls bypass five active requests and their waiters', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  const pending = Array.from({ length: 6 }, (_, i) => queue.run('feed.read', { i }, held.send))
  for (const method of ['sync.start', 'sync.stop', 'sync.status']) {
    const control = queue.run(method, {}, held.send)
    t.is(held.calls.at(-1).method, method)
    held.calls.at(-1).release()
    await control
    t.is(held.calls.filter((c) => c.method === 'feed.read').length, 5)
  }
  t.is(held.peak, 6)
  for (let i = 0; i < 5; i++) {
    held.calls[i].release()
    await pending[i]
  }
  held.calls.at(-1).release()
  await pending[5]
  t.is(held.calls.at(-1).params.i, 5)
})

// Rejection comes at the 30th request (5 in flight + 24 waiting).
test('the 30th request rejects when five are active and 24 are waiting', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  const pending = Array.from({ length: 29 }, (_, i) => queue.run('feed.read', { i }, held.send))
  const err = await queue.run('post.create', {}, held.send).catch((err) => err)
  t.ok(err instanceof Error)
  t.is(err.code, 'USAGE')
  t.is(err.message, 'pedidos demais em andamento')
  t.is(held.calls.length, 5)
  await releaseAll(held, pending)
  t.is(held.calls.length, 29)
})

// Five reads stuck during a seeder outage must not push sync controls past maxTotal.
// The first control leaves at once. The other two leave, in order, only as earlier
// controls settle, and ahead of ordinary reads that are still queued.
test('stuck reads keep sync controls within six sends and ahead of queued reads', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  for (let i = 0; i < 5; i++) queue.run('feed.read', { i }, held.send)
  for (let i = 0; i < 3; i++) queue.run('post.create', { i }, held.send)
  const methods = ['sync.start', 'sync.status', 'sync.stop']
  const controls = methods.map((method) => queue.run(method, {}, held.send))
  t.is(held.calls.length, 6, 'the first control goes out immediately')
  t.is(held.calls[5].method, 'sync.start')
  t.is(held.peak, 6, 'send never sees more than 6 calls in flight')
  t.is(held.calls.filter((c) => c.method === 'post.create').length, 0)
  held.calls[5].release()
  await controls[0]
  t.is(held.calls.length, 7)
  t.is(held.calls[6].method, 'sync.status', 'the next control leaves before a queued read')
  held.calls[6].release()
  await controls[1]
  t.is(held.calls.length, 8)
  t.is(held.calls[7].method, 'sync.stop')
  held.calls[7].release()
  await controls[2]
  t.is(held.calls.length, 8, 'queued reads stay behind the control lane')
  t.alike(held.calls.map((c) => c.method), [
    'feed.read', 'feed.read', 'feed.read', 'feed.read', 'feed.read',
    'sync.start', 'sync.status', 'sync.stop'
  ])
  t.is(held.peak, 6)
})

test('a freed read slot serves a waiting control before a queued read and never exceeds six', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  const reads = Array.from({ length: 5 }, (_, i) => queue.run('feed.read', { i }, held.send))
  const first = queue.run('sync.start', {}, held.send)
  t.is(held.calls.length, 6)
  const status = queue.run('sync.status', {}, held.send)
  const stop = queue.run('sync.stop', {}, held.send)
  queue.run('post.create', { i: 'w' }, held.send)
  t.is(held.calls.length, 6, 'controls and the write wait while six are in flight')
  held.calls[0].release()
  await reads[0]
  t.is(held.calls.length, 7)
  t.is(held.calls[6].method, 'sync.status')
  t.is(held.calls.filter((c) => c.method === 'post.create').length, 0)
  t.is(held.peak, 6)
  held.calls[6].release()
  await status
  held.calls[7].release()
  await stop
  t.is(held.peak, 6)
  held.calls[5].release()
  await first
})

test('an aborted waiting control is never sent and rejects with AbortError', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  for (let i = 0; i < 5; i++) queue.run('feed.read', { i }, held.send)
  queue.run('sync.start', {}, held.send)
  const controller = new AbortController()
  const waiting = queue.run('sync.stop', {}, held.send, { signal: controller.signal }).catch((err) => err)
  controller.abort()
  const err = await waiting
  t.is(err.name, 'AbortError')
  t.is(err.queued, true, 'marked as never sent')
  held.calls[0].release()
  await Promise.resolve()
  t.absent(held.calls.some((c) => c.method === 'sync.stop'))
})

test('clear rejects a waiting control with the reason and never sends it', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  for (let i = 0; i < 5; i++) queue.run('feed.read', { i }, held.send)
  queue.run('sync.start', {}, held.send)
  const waiting = queue.run('sync.status', {}, held.send).catch((err) => err)
  const reason = new Error('sem conexão com o nó')
  queue.clear(reason)
  const err = await waiting
  t.is(err.message, reason.message)
  t.is(err.queued, true, 'marked as never sent')
  held.calls[0].release()
  await Promise.resolve()
  t.absent(held.calls.some((c) => c.method === 'sync.status'))
})

test('an aborted waiter is never sent and frees its waiting slot', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue({ maxInFlight: 1, maxWaiting: 1 })
  const held = heldSend()
  const first = queue.run('feed.read', { i: 0 }, held.send)
  const controller = new AbortController()
  const cancelled = queue.run('post.create', { i: 1 }, held.send, { signal: controller.signal }).catch((err) => err)
  controller.abort()
  t.is((await cancelled).name, 'AbortError')
  const next = queue.run('feed.read', { i: 2 }, held.send)
  await releaseAll(held, [first, next])
  t.alike(held.calls.map((c) => c.params.i), [0, 2])
})

test('an already aborted call never sends; abort after send leaves the result alone', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  const controller = new AbortController()
  const first = queue.run('post.create', {}, held.send, { signal: controller.signal })
  controller.abort()
  const err = await queue.run('feed.read', {}, held.send, { signal: controller.signal }).catch((err) => err)
  t.is(err.name, 'AbortError')
  t.is(held.calls.length, 1)
  held.calls[0].release('sent')
  t.is(await first, 'sent')
})

test('clear rejects every waiter once with the given reason and never drains them', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue({ maxInFlight: 1 })
  const held = heldSend()
  const first = queue.run('post.create', {}, held.send)
  const controller = new AbortController()
  let rejected = 0
  const waiting = Array.from({ length: 3 }, () => queue.run('feed.read', {}, held.send, { signal: controller.signal }).catch((err) => {
    rejected++
    return err
  }))
  const reason = Object.assign(new Error('sem conexão com o nó'), { code: 'CLOSED' })
  queue.clear(reason)
  queue.clear(new Error('segunda limpeza'))
  controller.abort()
  for (const result of await Promise.all(waiting)) {
    t.is(result.message, reason.message)
    t.is(result.code, 'CLOSED')
    t.is(result.queued, true)
  }
  held.calls[0].release('original result')
  t.is(await first, 'original result')
  t.is(rejected, 3)
  t.is(held.calls.length, 1)
})

test('failed mutations reject once without retries and release the next FIFO send', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue({ maxInFlight: 1 })
  const held = heldSend()
  const first = queue.run('post.create', {}, held.send).catch((err) => err)
  const reason = Object.assign(new Error('conexão encerrada'), { code: 'CLOSED', uncertain: true })
  let throws = 0
  const second = queue.run('post.create', {}, () => {
    throws++
    throw reason
  }).catch((err) => err)
  const third = queue.run('feed.read', {}, held.send)
  held.calls[0].fail(reason)
  t.is(await first, reason)
  t.is(await second, reason)
  t.is(throws, 1)
  t.alike(held.calls.map((c) => c.method), ['post.create', 'feed.read'])
  held.calls[1].release('next')
  t.is(await third, 'next')
})

test('custom bypass and zero waiting capacity still allow immediate sends', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue({ maxInFlight: 1, maxWaiting: 0, bypass: ['node.info'] })
  const held = heldSend()
  const first = queue.run('feed.read', {}, held.send)
  const rejected = await queue.run('sync.status', {}, held.send).catch((err) => err)
  t.is(rejected.code, 'USAGE')
  t.is(await queue.run('node.info', {}, () => 'info'), 'info')
  const reason = new Error('falhou')
  t.is(await queue.run('node.info', {}, () => { throw reason }).catch((err) => err), reason)
  held.calls[0].release()
  await first
})

function providerRequests (createRequestQueue) {
  const source = fs.readFileSync(path.join(__dirname, '../src/node.js'), 'utf8')
  const extractCallback = (name, deps) => {
    const start = source.indexOf('  const ' + name + ' = useCallback(')
    const end = source.indexOf('\n  }, [' + deps + '])', start)
    return source.slice(start, end + ('\n  }, [' + deps + '])').length)
  }
  // Exercise the provider callbacks without loading React Native or a transport.
  return vm.runInThisContext(`(createRequestQueue) => {
    const useCallback = (fn) => fn
    const connRef = { current: null }
    const requestQueueRef = { current: null }
    const awaitingRef = { current: 0 }
    const startingRef = { current: 0 }
    const counts = { begin: 0, end: 0, spans: 0, slow: 0 }
    const idleRef = { current: { begin () { counts.begin++ }, end () { counts.end++ } } }
    const marks = { span () { counts.spans++ } }
    const slowRequestLine = () => {
      counts.slow++
      return null
    }
    const extendWait = () => {}
    const setStarting = () => {}
    const noConnection = () => Promise.reject(Object.assign(new Error('sem conexão com o nó'), { code: 'CLOSED' }))
    ${extractCallback('setConnection', '')}
    ${extractCallback('request', 'extendWait')}
    return { setConnection, request, counts, startingRef }
  }`)(createRequestQueue)
}

test('provider bookkeeping counts only sent requests, including bypass and failures', async (t) => {
  const { createRequestQueue } = await load()
  const provider = providerRequests(createRequestQueue)
  const held = heldSend()
  provider.setConnection({ request: held.send })
  const pending = Array.from({ length: 8 }, (_, i) => provider.request('feed.read', { i }))
  // Five reads fit maxInFlight. The other three wait, so begin stays at 5 until they are sent.
  t.alike(provider.counts, { begin: 5, end: 0, spans: 0, slow: 0 })
  const control = provider.request('sync.start', {}).catch((err) => err)
  t.is(provider.startingRef.current, 1)
  const reason = new Error('falhou')
  held.calls[5].fail(reason)
  t.is(await control, reason)
  t.is(provider.startingRef.current, 0)
  // The bypass send is the 6th call (5 reads plus sync.start), and its failure is counted.
  t.alike(provider.counts, { begin: 6, end: 1, spans: 1, slow: 1 })
  for (let i = 0; i < 5; i++) {
    held.calls[i].release()
    await pending[i]
  }
  for (let i = 5; i < 8; i++) {
    held.calls[i + 1].release()
    await pending[i]
  }
  t.alike(provider.counts, { begin: 9, end: 9, spans: 9, slow: 9 })
})

test('provider replacement and drop clear old waiters without moving them to the new connection', async (t) => {
  const { createRequestQueue } = await load()
  const provider = providerRequests(createRequestQueue)
  for (const replacement of [true, false]) {
    const old = heldSend()
    provider.setConnection({ request: old.send })
    // Five sends fill maxInFlight, so the next call is the waiter this test drops.
    const pending = Array.from({ length: 5 }, () => provider.request('feed.read', {}))
    const waiting = provider.request('post.create', {}).catch((err) => err)
    const next = heldSend()
    provider.setConnection(replacement ? { request: next.send } : null)
    const err = await waiting
    t.is(err.code, 'CLOSED')
    t.absent(err.uncertain)
    t.is(next.calls.length, 0)
    await releaseAll(old, pending)
    t.is(old.calls.length, 5)
    if (replacement) {
      const fresh = provider.request('feed.read', {})
      t.is(next.calls.length, 1)
      next.calls[0].release()
      await fresh
    } else {
      t.is((await provider.request('feed.read', {}).catch((err) => err)).code, 'CLOSED')
    }
    // Each connection sends 5 reads, plus one fresh read after the replacement, so the totals are 6 and then 11.
    t.alike(provider.counts, replacement
      ? { begin: 6, end: 6, spans: 6, slow: 6 }
      : { begin: 11, end: 11, spans: 11, slow: 11 })
  }
})

// An identity change (lock, sign out, another passkey) on the same
// connection: a request still waiting was asked for under the old identity,
// and sent later the node would sign it with the new one.
test('an identity operation drops the waiting requests before it is dispatched', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'node.js'), 'utf8')
  const start = source.indexOf('const passkeyOp = useCallback((name, arg) => {')
  t.ok(start > 0, 'fixture: passkeyOp found')
  const body = source.slice(start, source.indexOf('let pending', start))
  t.ok(/if \(IDENTITY_OPS\.has\(name\) && requestQueueRef\.current\) \{\s*requestQueueRef\.current\.clear\(/.test(body), 'the queue is cleared for an identity operation')
  const dispatch = source.indexOf('pending = ARG_OPS.has(op) ? conn.identity[op](arg) : conn.identity[op]()', start)
  t.ok(dispatch > start + body.length, 'the clear comes before the operation is dispatched')
  t.ok(/IDENTITY_OPS = new Set\(\[[^\]]*'lock'[^\]]*'signOut'[^\]]*'reset'/.test(source) && /IDENTITY_OPS = new Set\(\['unlock'/.test(source), 'lock, sign out, reset and unlock are identity operations')
})

test('clear leaves in-flight sends alone and the queue usable', async (t) => {
  const { createRequestQueue } = await load()
  const q = createRequestQueue({ maxInFlight: 1 })
  const held = heldSend()
  const first = q.run('post.create', { text: 'a' }, held.send)
  const second = q.run('post.create', { text: 'b' }, held.send)
  q.clear(Object.assign(new Error('a identidade mudou antes do envio'), { code: 'CLOSED' }))
  t.is((await second.catch((err) => err)).code, 'CLOSED', 'the waiting request is dropped')
  t.is(held.calls.length, 1, 'only the in-flight request was ever sent')
  held.calls[0].release()
  await first
  const third = q.run('feed.read', {}, held.send)
  t.is(held.calls.length, 2, 'the queue keeps working after the clear')
  held.calls[1].release()
  await third
})

test('a new visible request starts before waiting background ones', async (t) => {
  const { createRequestQueue } = await load()
  const q = createRequestQueue({ maxInFlight: 1 })
  const held = heldSend()
  const first = q.run('feed.read', {}, held.send)
  const bg = q.run('notices.read', { n: 1 }, held.send, { priority: 'background' })
  const vis = q.run('feed.read', { n: 2 }, held.send)
  held.calls[0].release()
  await first
  t.is(held.calls.length, 2, 'one more request started')
  t.alike(held.calls[1].params, { n: 2 }, 'the visible one went first')
  held.calls[1].release()
  await vis
  held.calls[2].release()
  await bg
})

test('at most two background requests are in flight', async (t) => {
  const { createRequestQueue } = await load()
  const q = createRequestQueue()
  const held = heldSend()
  const pending = Array.from({ length: 5 }, (_, i) => q.run('notices.read', { i }, held.send, { priority: 'background' }))
  t.is(held.calls.length, 2, 'two started')
  const vis = q.run('feed.read', {}, held.send)
  t.is(held.calls.length, 3, 'a visible request still starts')
  held.calls[0].release()
  await pending[0]
  t.is(held.calls.length, 4, 'the next background one starts as one ends')
  held.calls[1].release(); held.calls[2].release(); held.calls[3].release()
  await Promise.all([pending[1], vis, pending[2]])
  held.calls[4].release()
  await pending[3]
  held.calls[5].release()
  await pending[4]
  t.ok(held.peak <= 4, 'never more than 2 background plus the visible one')
})

test('waiting background requests count against the limit while visible slots are free', async (t) => {
  const { createRequestQueue } = await load()
  const q = createRequestQueue({ maxWaiting: 3 })
  const held = heldSend()
  const pending = Array.from({ length: 5 }, (_, i) => q.run('notices.read', { i }, held.send, { priority: 'background' }))
  t.is(held.calls.length, 2, 'two in flight, three waiting')
  await t.exception(q.run('notices.read', { i: 5 }, held.send, { priority: 'background' }), /pedidos demais em andamento/, 'a fourth waiter is refused')
  const vis = q.run('feed.read', {}, held.send)
  t.is(held.calls.length, 3, 'a visible request that can start now is never refused')
  // Release every send as it starts, until all six settled.
  let released = 0
  const all = Promise.all([...pending, vis])
  while (released < 6) {
    if (released < held.calls.length) held.calls[released++].release()
    await new Promise((resolve) => setImmediate(resolve))
  }
  await all
})

test('promote moves a waiting entry and ignores one in flight', async (t) => {
  const { createRequestQueue } = await load()
  const q = createRequestQueue({ maxInFlight: 1 })
  const held = heldSend()
  const running = q.run('notices.read', { n: 0 }, held.send, { priority: 'background', token: 'a' })
  const waitingBg = q.run('notices.read', { n: 1 }, held.send, { priority: 'background', token: 'b' })
  const later = q.run('feed.read', { n: 2 }, held.send)
  t.is(q.promote('a'), false, 'in flight is not touched')
  t.is(q.promote('zzz'), false, 'unknown token')
  t.is(q.promote('b'), true, 'waiting entry promoted')
  held.calls[0].release()
  await running
  t.alike(held.calls[1].params, { n: 2 }, 'the promoted entry joins the end of the visible lane')
  held.calls[1].release()
  await later
  t.alike(held.calls[2].params, { n: 1 }, 'then it is sent')
  held.calls[2].release()
  await waitingBg
  t.is(held.calls.length, 3, 'nothing was resent')
})

test('abort removes a waiting entry of either lane and the limit counts both', async (t) => {
  const { createRequestQueue } = await load()
  const q = createRequestQueue({ maxInFlight: 1, maxWaiting: 2 })
  const held = heldSend()
  const first = q.run('feed.read', {}, held.send)
  const ac = new AbortController()
  const bg = q.run('notices.read', {}, held.send, { priority: 'background', signal: ac.signal })
  const vis = q.run('feed.read', {}, held.send)
  const over = await q.run('feed.read', {}, held.send).catch((err) => err)
  t.is(over.message, 'pedidos demais em andamento', 'both lanes count toward the limit')
  ac.abort()
  t.is((await bg.catch((err) => err)).name, 'AbortError', 'background entry aborted')
  const ac2 = new AbortController()
  const vis2 = q.run('feed.read', {}, held.send, { signal: ac2.signal })
  ac2.abort()
  t.is((await vis2.catch((err) => err)).name, 'AbortError', 'visible entry aborted')
  held.calls[0].release()
  await first
  held.calls[1].release()
  await vis
  t.is(held.calls.length, 2, 'aborted entries were never sent')
})

test('notSent marks only requests that never reached send', async (t) => {
  const { createRequestQueue, notSent } = await load()
  const queue = createRequestQueue({ maxInFlight: 1, maxTotal: 1 })
  const held = heldSend()
  const sent = queue.run('sync.start', {}, held.send).catch((err) => err)
  const controller = new AbortController()
  const aborted = queue.run('sync.stop', {}, held.send, { signal: controller.signal }).catch((err) => err)
  const cleared = queue.run('sync.status', {}, held.send).catch((err) => err)
  controller.abort()
  queue.clear(Object.assign(new Error('a identidade mudou antes do envio'), { code: 'CLOSED' }))
  held.calls[0].fail(Object.assign(new Error('conexão encerrada'), { code: 'CLOSED', uncertain: true }))
  t.ok(notSent(await aborted), 'an aborted waiter')
  t.ok(notSent(await cleared), 'a cleared waiter')
  t.absent(notSent(await sent), 'a sent request that failed')
  t.absent(notSent(null))
  t.absent(notSent('falhou'))
  t.is(held.calls.length, 1)
})

// The auto-sync callbacks and the hidden-stop effect of node.js, run against
// the real queue with stubbed React state, so the callers' handling of a
// request that was never sent is exercised and not only pinned by its text.
function autoSyncProvider ({ createRequestQueue, notSent }, policy) {
  const source = fs.readFileSync(path.join(__dirname, '../src/node.js'), 'utf8')
  const extractCallback = (name, deps) => {
    const start = source.indexOf('  const ' + name + ' = useCallback(')
    const end = source.indexOf('\n  }, [' + deps + '])', start)
    if (start === -1 || end === -1) throw new Error('fixture: ' + name + ' not found')
    return source.slice(start, end + ('\n  }, [' + deps + '])').length)
  }
  const hiddenStart = source.indexOf('  useEffect(() => {', source.indexOf('  // The only visibility stop path.'))
  const hiddenEnd = source.indexOf('\n  }, [phase, visible, sync.active', hiddenStart)
  if (hiddenStart === -1 || hiddenEnd === -1) throw new Error('fixture: hidden stop effect not found')
  const hidden = source.slice(hiddenStart, source.indexOf('\n', hiddenEnd + 1))
  const mediaCalls = (source.match(/^const MEDIA_RPC_CALLS = new Set\(\[[^\]]*\]\)$/m) || ['const MEDIA_RPC_CALLS = new Set()'])[0]
  return vm.runInThisContext(`(createRequestQueue, notSent, policy) => {
    const { startFailure, shouldStopForHidden, reconcileIdle, FIRST_BACKOFF_MS, MAX_BACKOFF_MS } = policy
    const useCallback = (fn) => fn
    const effects = []
    const useEffect = (fn) => { effects.push(fn) }
    const ref = (current) => ({ current })
    const phase = 'ready'
    // Only read by the effect's dependency list.
    const visible = true
    const sync = { active: null }
    const starting = false
    const reconciling = false
    const autoTick = 0
    const signals = { idleSince: null }
    const connRef = ref(null)
    const requestQueueRef = ref(null)
    const awaitingRef = ref(0)
    const startingRef = ref(0)
    const autoInflightRef = ref(false)
    const autoAbortRef = ref(null)
    const runStartedAtRef = ref(0)
    const epochRef = ref(0)
    const pkGenRef = ref(0)
    const reconcilingRef = ref(false)
    const visibleRef = ref(true)
    const hiddenStopRef = ref({ attempts: 0, retry: false })
    const syncRef = ref({ active: null, lines: [], stopped: null })
    const signalsRef = ref({ runId: null, idleSince: null })
    const failureUntilRef = ref(0)
    const idleUntilRef = ref(0)
    const backoffMsRef = ref(0)
    const gaveUpRef = ref(false)
    const idleRef = ref({ begin () {}, end () {} })
    const log = { backoff: [], ticks: 0, failWaits: 0 }
    const marks = { span () {} }
    const slowRequestLine = () => null
    const extendWait = () => {}
    const setStarting = () => {}
    const appendLine = (prev) => prev
    const setSync = (next) => { syncRef.current = typeof next === 'function' ? next(syncRef.current) : next }
    const noConnection = () => Promise.reject(Object.assign(new Error('sem conexão com o nó'), { code: 'CLOSED' }))
    const setWait = (until) => { awaitingRef.current = until }
    const setRecon = (on) => { reconcilingRef.current = on }
    const setBackoff = (parts) => { log.backoff.push(parts) }
    const adoptSignals = () => {}
    const trackWaits = () => {}
    const failWaits = () => { log.failWaits++ }
    const resetSignals = (next) => { signalsRef.current = next }
    const endIdle = (signals) => signals
    const setGaveUp = () => {}
    const setAutoTick = () => { log.ticks++ }
    const stillCurrent = (conn, ep, gen) => connRef.current === conn && epochRef.current === ep && pkGenRef.current === gen
    ${mediaCalls}
    ${extractCallback('setConnection', '')}
    ${extractCallback('request', 'extendWait')}
    ${extractCallback('reconcile', 'request, stillCurrent, setWait, setRecon, setBackoff, adoptSignals, trackWaits, failWaits')}
    ${extractCallback('autoStart', 'request, stillCurrent, reconcile, setBackoff, resetSignals, trackWaits, failWaits')}
    ${source.includes('  const mediaCall = useCallback(') ? extractCallback('mediaCall', '') : 'const mediaCall = () => { throw new Error(\'no mediaCall\') }'}
    ${hidden}
    const refs = { connRef, requestQueueRef, startingRef, autoInflightRef, reconcilingRef, visibleRef, hiddenStopRef, syncRef, signalsRef, backoffMsRef, epochRef }
    return { refs, log, setConnection, request, reconcile, autoStart, mediaCall, hidden: effects[0] }
  }`)(createRequestQueue, notSent, policy)
}

const flush = () => new Promise((resolve) => setImmediate(resolve))
const identityChanged = () => Object.assign(new Error('a identidade mudou antes do envio'), { code: 'CLOSED' })

// Five reads and one sync.status fill the six slots, so the next control waits.
function fillSlots (provider) {
  const pending = Array.from({ length: 5 }, (_, i) => provider.request('feed.read', { i }))
  pending.push(provider.request('sync.status', {}))
  return pending
}

async function loadProvider () {
  const policy = await import('../src/autoSyncPolicy.js')
  return autoSyncProvider(await load(), policy)
}

test('reconcile asks sync.status again when an identity clear dropped it unsent', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  provider.setConnection({ request: held.send })
  fillSlots(provider)
  const out = provider.reconcile()
  t.is(provider.refs.reconcilingRef.current, true)
  t.is(held.calls.length, 6, 'the status read waits in the queue')
  provider.refs.requestQueueRef.current.clear(identityChanged())
  await flush()
  t.is(provider.refs.reconcilingRef.current, true, 'the run is still unknown')
  held.calls[0].release()
  await flush()
  t.is(held.calls.length, 7, 'the read is sent again once a slot frees')
  if (held.calls.length < 7) return
  t.is(held.calls[6].method, 'sync.status')
  const st = { state: 'idle' }
  held.calls[6].release(st)
  t.is(await out, st)
  t.is(provider.refs.reconcilingRef.current, false, 'an authoritative answer ends reconciling')
  t.is(held.calls.filter((c) => c.method === 'sync.status').length, 2, 'the filler and one reconcile read, never a duplicate')
})

test('an auto start dropped unsent arms no failure backoff', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  provider.setConnection({ request: held.send })
  fillSlots(provider)
  provider.autoStart()
  t.is(provider.refs.startingRef.current, 1)
  t.is(provider.refs.autoInflightRef.current, true)
  provider.refs.requestQueueRef.current.clear(identityChanged())
  await flush()
  t.is(provider.refs.autoInflightRef.current, false)
  t.is(provider.refs.startingRef.current, 0)
  t.alike(provider.log.backoff, [], 'no backoff for a start that never went out')
  t.is(provider.refs.backoffMsRef.current, 0)
  t.is(provider.log.ticks, 1, 'the start gate is evaluated again')
  t.absent(held.calls.some((c) => c.method === 'sync.start'))
})

test('a hidden-page stop dropped unsent gives its attempt back and goes out on the next evaluation', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  provider.setConnection({ request: held.send })
  provider.refs.visibleRef.current = false
  provider.refs.syncRef.current = { active: { runId: 'r1', once: false }, lines: [], stopped: null }
  fillSlots(provider)
  provider.hidden()
  t.is(provider.refs.hiddenStopRef.current.attempts, 1)
  provider.refs.requestQueueRef.current.clear(identityChanged())
  await flush()
  t.is(provider.refs.hiddenStopRef.current.attempts, 0, 'the unsent attempt is not counted')
  t.is(provider.log.ticks, 1, 'the stop is decided again')
  provider.hidden()
  held.calls[0].release()
  await flush()
  t.is(held.calls.length, 7, 'the stop reaches the node')
  if (held.calls.length < 7) return
  t.is(held.calls[6].method, 'sync.stop')
  t.is(provider.refs.hiddenStopRef.current.attempts, 1)
})

test('hiding the page aborts an auto start still waiting in the queue, then the stop proceeds', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  provider.setConnection({ request: held.send })
  const fillers = fillSlots(provider)
  provider.autoStart()
  // The node kept the continuous intent over the idle gap: a hidden page releases it.
  provider.refs.signalsRef.current = { runId: null, idleSince: 1 }
  provider.refs.visibleRef.current = false
  provider.hidden()
  t.is(provider.refs.hiddenStopRef.current.attempts, 0, 'no stop while the start is still pending')
  await flush()
  t.is(provider.refs.autoInflightRef.current, false)
  t.is(provider.refs.startingRef.current, 0)
  t.alike(provider.log.backoff, [], 'the aborted start is not a failure')
  provider.hidden()
  t.is(provider.refs.hiddenStopRef.current.attempts, 1, 'the stop logic runs as with no start pending')
  for (let i = 0; i < fillers.length; i++) {
    held.calls[i].release()
    await fillers[i]
  }
  await flush()
  t.absent(held.calls.some((c) => c.method === 'sync.start'), 'the start is never sent on the hidden page')
  t.ok(held.calls.some((c) => c.method === 'sync.stop'))
})

test('hiding the page leaves an auto start already handed to send alone', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  provider.setConnection({ request: held.send })
  provider.autoStart()
  t.is(held.calls[0].method, 'sync.start', 'sent at once')
  provider.refs.visibleRef.current = false
  provider.refs.syncRef.current = { active: { runId: 'r1', once: false }, lines: [], stopped: null }
  provider.hidden()
  t.is(provider.refs.hiddenStopRef.current.attempts, 0, 'the stop waits for the start in flight')
  held.calls[0].release({ runId: 'r1' })
  await flush()
  t.is(provider.refs.autoInflightRef.current, false)
  t.alike(provider.log.backoff, [])
  provider.hidden()
  t.is(held.calls.at(-1).method, 'sync.stop', 'then the stop goes out')
})

test('media calls that reach the node share the queue budget; local file calls do not wait', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  const media = {
    read: (ref) => held.send('media.readFile', ref),
    upload: (args) => held.send('media.uploadFile', args),
    forgetReadFile: (name) => 'forgot ' + name,
    sharesClient: true
  }
  provider.setConnection({ request: held.send, media })
  const fillers = fillSlots(provider)
  const upload = provider.mediaCall('upload', { mime: 'image/jpeg' }).catch((err) => err)
  provider.refs.requestQueueRef.current.clear(identityChanged())
  t.is((await upload).code, 'CLOSED', 'a waiting upload is dropped by an identity clear')
  const photo = provider.mediaCall('read', { kind: 'moment', author: 'a', seq: 1 })
  t.is(held.calls.length, 6, 'the read waits while six are in flight')
  t.is(provider.mediaCall('forgetReadFile', 'x'), 'forgot x', 'deleting a local file is not queued')
  held.calls[0].release()
  await fillers[0]
  t.is(held.calls[6].method, 'media.readFile')
  held.calls[6].release({ name: 'r' })
  t.alike(await photo, { name: 'r' })
  t.ok(held.peak <= 6, 'never more than six requests from the queue')
  t.is(held.calls.filter((c) => c.method === 'media.uploadFile').length, 0)
})

// The value of a promise settled by the next macrotask, or 'pending'.
const settled = (value) => Promise.race([Promise.resolve(value).catch((err) => err), flush().then(() => 'pending')])

test('reconcile stops asking again once the epoch or the connection changed', async (t) => {
  for (const change of ['epoch', 'connection']) {
    const provider = await loadProvider()
    const held = heldSend()
    provider.setConnection({ request: held.send })
    const fillers = fillSlots(provider)
    const out = provider.reconcile()
    t.is(held.calls.length, 6, change + ': the status read waits in the queue')
    const next = heldSend()
    if (change === 'epoch') {
      provider.refs.epochRef.current += 1
      provider.refs.requestQueueRef.current.clear(identityChanged())
    } else {
      provider.setConnection({ request: next.send })
    }
    await flush()
    for (let i = 0; i < fillers.length; i++) {
      held.calls[i].release()
      await fillers[i]
    }
    await flush()
    t.is(held.calls.filter((c) => c.method === 'sync.status').length, 1, change + ': only the filler read went out')
    t.is(next.calls.length, 0, change + ': nothing moves to the new connection')
    t.is(await settled(out), undefined, change + ': reconcile ends without an answer')
  }
})

test('a media write is sent while five reads hang; a media read stays a read', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  const media = {
    read: (ref) => held.send('media.readFile', ref),
    upload: (args) => held.send('media.uploadFile', args),
    putDm: (args) => held.send('dm.putMedia', args),
    putMoment: (args) => held.send('moment.putMedia', args),
    sharesClient: true
  }
  provider.setConnection({ request: held.send, media })
  for (let i = 0; i < 5; i++) provider.request('feed.read', { i })
  // A full waiting backlog of reads must not refuse a write either.
  for (let i = 0; i < 24; i++) provider.request('feed.read', { i: 5 + i }).catch(() => {})
  const upload = provider.mediaCall('upload', { mime: 'image/jpeg' }).catch((err) => err)
  t.is(held.calls.length, 6, 'the upload is sent at once')
  t.is(held.calls.at(-1) && held.calls.at(-1).method, 'media.uploadFile')
  const dm = provider.mediaCall('putDm', { to: 'ab'.repeat(32) }).catch((err) => err)
  const moment = provider.mediaCall('putMoment', { mime: 'image/jpeg' }).catch((err) => err)
  const photo = provider.mediaCall('read', { kind: 'moment', author: 'a', seq: 1 }).catch((err) => err)
  t.is(held.calls.length, 6, 'the total stays at six')
  t.ok(held.peak <= 6)
  if (held.calls.length < 6) return
  held.calls[5].release({ ok: 'u' })
  t.alike(await upload, { ok: 'u' })
  t.is(held.calls[6].method, 'dm.putMedia', 'the next write goes ahead of every waiting read')
  held.calls[6].release({ ok: 'd' })
  t.alike(await dm, { ok: 'd' })
  t.is(held.calls[7].method, 'moment.putMedia')
  held.calls[7].release({ ok: 'm' })
  t.alike(await moment, { ok: 'm' })
  t.is(held.calls.length, 8)
  t.ok(held.peak <= 6)
  t.is((await photo).code, 'USAGE', 'a media read stays a read: refused with the backlog full')
  provider.refs.requestQueueRef.current.clear(identityChanged())
})

test('a waiting media upload dropped by a clear rejects unsent and keeps the reason text', async (t) => {
  const { notSent } = await load()
  const provider = await loadProvider()
  const held = heldSend()
  const media = { upload: (args) => held.send('media.uploadFile', args), sharesClient: true }
  provider.setConnection({ request: held.send, media })
  fillSlots(provider)
  const upload = provider.mediaCall('upload', { mime: 'image/jpeg' }).catch((err) => err)
  t.is(held.calls.length, 6)
  provider.refs.requestQueueRef.current.clear(identityChanged())
  const err = await upload
  t.ok(notSent(err), 'never sent')
  t.is(err.message, 'a identidade mudou antes do envio', 'the screen shows the reason')
  t.absent(err.uncertain, 'not an uncertain upload')
  t.is(held.calls.filter((c) => c.method === 'media.uploadFile').length, 0)
})

test('a handle that does not share the RPC client calls media directly', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  const media = {
    read: (ref) => ({ read: ref }),
    upload: (args) => ({ uploaded: args })
  }
  provider.setConnection({ request: held.send, media })
  fillSlots(provider)
  for (let i = 0; i < 24; i++) provider.request('feed.read', { i }).catch(() => {})
  t.alike(await settled(provider.mediaCall('upload', { n: 1 })), { uploaded: { n: 1 } })
  t.alike(await settled(provider.mediaCall('read', { n: 2 })), { read: { n: 2 } })
})

test('hiding the page never aborts a once start waiting in the queue', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  provider.setConnection({ request: held.send })
  const fillers = fillSlots(provider)
  provider.autoStart()
  const once = provider.request('sync.start', { once: true, timeoutMs: 1000 })
  provider.refs.visibleRef.current = false
  provider.hidden()
  await flush()
  t.is(provider.refs.autoInflightRef.current, false, 'the auto start was aborted')
  for (let i = 0; i < fillers.length; i++) {
    held.calls[i].release()
    await fillers[i]
  }
  await flush()
  const starts = held.calls.filter((c) => c.method === 'sync.start')
  t.is(starts.length, 1, 'only the once start reached the node')
  if (starts.length !== 1) return
  t.alike(starts[0].params, { once: true, timeoutMs: 1000 })
  starts[0].release({ runId: 'r1' })
  t.alike(await once, { runId: 'r1' })
})

test('an auto start dropped unsent ends the refresh waits while its context is current', async (t) => {
  const provider = await loadProvider()
  const held = heldSend()
  provider.setConnection({ request: held.send })
  fillSlots(provider)
  provider.autoStart()
  provider.refs.requestQueueRef.current.clear(identityChanged())
  await flush()
  t.is(provider.log.failWaits, 1, 'a pull-to-refresh waiting on it ends')
  // The six fillers are still in flight, so this start waits too.
  provider.autoStart()
  provider.refs.epochRef.current += 1
  provider.refs.requestQueueRef.current.clear(identityChanged())
  await flush()
  t.is(provider.log.failWaits, 1, 'not for a context that moved on')
})

test('clear never mutates the reason and accepts a frozen or non-object one', async (t) => {
  const { createRequestQueue, notSent } = await load()
  const queue = createRequestQueue({ maxInFlight: 1 })
  const held = heldSend()
  const first = queue.run('feed.read', {}, held.send)
  const reason = Object.assign(new Error('sem conexão com o nó'), { code: 'CLOSED' })
  const a = queue.run('feed.read', {}, held.send).catch((err) => err)
  const b = queue.run('feed.read', {}, held.send).catch((err) => err)
  queue.clear(reason)
  const [ea, eb] = await Promise.all([a, b])
  t.absent('queued' in reason, 'the caller object is left alone')
  t.ok(ea !== reason && ea !== eb, 'each waiter gets its own error')
  t.ok(ea instanceof Error)
  t.is(ea.message, 'sem conexão com o nó')
  t.is(ea.code, 'CLOSED')
  t.ok(notSent(ea) && notSent(eb))

  const frozen = Object.freeze(Object.assign(new Error('congelado'), { code: 'CLOSED' }))
  const c = queue.run('feed.read', {}, held.send).catch((err) => err)
  t.execution(() => queue.clear(frozen), 'a frozen reason does not throw')
  const ec = await settled(c)
  t.is(ec.message, 'congelado')
  t.is(ec.code, 'CLOSED')
  t.ok(notSent(ec))

  const d = queue.run('feed.read', {}, held.send).catch((err) => err)
  queue.clear('fechado')
  const ed = await d
  t.ok(ed instanceof Error)
  t.is(ed.message, 'fechado')
  t.ok(notSent(ed), 'a non-object reason is still marked as never sent')

  const e = queue.run('feed.read', {}, held.send).catch((err) => err)
  queue.clear()
  t.ok(notSent(await e))
  held.calls[0].release()
  await first
  t.is(held.calls.length, 1)
})

test('backfill gates reject cancelled queued writes and still drain the next entry', async (t) => {
  const { createRequestQueue } = await load()
  for (const priority of ['visible', 'background', 'control']) {
    const queue = createRequestQueue({ maxInFlight: 1, maxTotal: 1 })
    const held = heldSend()
    const first = queue.run('feed.read', {}, held.send)
    const sent = []
    const send = (method) => { sent.push(method); return method }
    let live = true
    const cancelled = queue.run('post.cover', {}, send, { priority, gate: () => live }).catch((err) => err)
    const next = queue.run('next', {}, send, { priority, gate: () => true })
    live = false
    held.calls[0].release()
    await first
    const err = await cancelled
    t.is(err.queued, true, priority + ': never sent')
    t.is(err.name, 'AbortError')
    t.is(await next, 'next', 'the rejected entry consumes no slot')
    t.alike(sent, ['next'])
    const immediate = await queue.run('post.cover', {}, send, { priority, gate: () => false }).catch((err) => err)
    t.is(immediate.queued, true, 'also checked before enqueueing')
    t.alike(sent, ['next'])
  }
})

test('backfill media guards and signals reach the queue but never the handle args', async (t) => {
  for (const sharesClient of [true, false]) {
    const provider = await loadProvider()
    const held = heldSend()
    const sent = []
    const args = { mime: 'image/jpeg' }
    provider.setConnection({ request: held.send, media: { sharesClient, upload: (args) => { sent.push(args); return Promise.resolve('uploaded') } } })
    const fillers = fillSlots(provider)
    let live = sharesClient
    const ctrl = new AbortController()
    const upload = provider.mediaCall('upload', args, { signal: ctrl.signal, gate: () => live }).catch((err) => err)
    live = false
    for (let i = 0; i < fillers.length; i++) {
      held.calls[i].release()
      await fillers[i]
    }
    t.is((await upload).queued, true, 'cancelled before dispatch')
    t.alike(sent, [])
    t.is(await provider.mediaCall('upload', args, { signal: ctrl.signal, gate: () => true }), 'uploaded')
    t.alike(sent, [args], 'options stay out of the payload')
    if (sharesClient) {
      ctrl.abort()
      const err = await provider.mediaCall('upload', args, { signal: ctrl.signal }).catch((err) => err)
      t.is(err.queued, true, 'the queue receives the abort signal')
      t.alike(sent, [args])
    }
  }
})
