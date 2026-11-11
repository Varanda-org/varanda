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

test('20 boot requests settle with at most seven sends and FIFO across reads and writes', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  const methods = Array.from({ length: 20 }, (_, i) => i % 2 ? 'post.create' : 'feed.read')
  const pending = methods.map((method, i) => queue.run(method, { i }, held.send))
  t.is(held.calls.length, 7)
  const results = await releaseAll(held, pending)
  t.is(held.peak, 7)
  t.alike(held.calls.map((c) => c.method), methods)
  t.alike(held.calls.map((c) => c.params.i), methods.map((_, i) => i))
  t.alike(results, methods.map((_, i) => ({ i })))
})

test('sync controls bypass seven active requests and their waiters', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  const pending = Array.from({ length: 8 }, (_, i) => queue.run('feed.read', { i }, held.send))
  for (const method of ['sync.start', 'sync.stop', 'sync.status']) {
    const control = queue.run(method, {}, held.send)
    t.is(held.calls.at(-1).method, method)
    held.calls.at(-1).release()
    await control
    t.is(held.calls.filter((c) => c.method === 'feed.read').length, 7)
  }
  t.is(held.peak, 8)
  for (let i = 0; i < 7; i++) {
    held.calls[i].release()
    await pending[i]
  }
  held.calls.at(-1).release()
  await pending[7]
  t.is(held.calls.at(-1).params.i, 7)
})

test('the 32nd request rejects when seven are active and 24 are waiting', async (t) => {
  const { createRequestQueue } = await load()
  const queue = createRequestQueue()
  const held = heldSend()
  const pending = Array.from({ length: 31 }, (_, i) => queue.run('feed.read', { i }, held.send))
  const err = await queue.run('post.create', {}, held.send).catch((err) => err)
  t.ok(err instanceof Error)
  t.is(err.code, 'USAGE')
  t.is(err.message, 'pedidos demais em andamento')
  t.is(held.calls.length, 7)
  await releaseAll(held, pending)
  t.is(held.calls.length, 31)
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
  for (const result of await Promise.all(waiting)) t.is(result, reason)
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
  t.alike(provider.counts, { begin: 7, end: 0, spans: 0, slow: 0 })
  const control = provider.request('sync.start', {}).catch((err) => err)
  t.is(provider.startingRef.current, 1)
  const reason = new Error('falhou')
  held.calls[7].fail(reason)
  t.is(await control, reason)
  t.is(provider.startingRef.current, 0)
  t.alike(provider.counts, { begin: 8, end: 1, spans: 1, slow: 1 })
  for (let i = 0; i < 7; i++) {
    held.calls[i].release()
    await pending[i]
  }
  held.calls[8].release()
  await pending[7]
  t.alike(provider.counts, { begin: 9, end: 9, spans: 9, slow: 9 })
})

test('provider replacement and drop clear old waiters without moving them to the new connection', async (t) => {
  const { createRequestQueue } = await load()
  const provider = providerRequests(createRequestQueue)
  for (const replacement of [true, false]) {
    const old = heldSend()
    provider.setConnection({ request: old.send })
    const pending = Array.from({ length: 7 }, () => provider.request('feed.read', {}))
    const waiting = provider.request('post.create', {}).catch((err) => err)
    const next = heldSend()
    provider.setConnection(replacement ? { request: next.send } : null)
    const err = await waiting
    t.is(err.code, 'CLOSED')
    t.absent(err.uncertain)
    t.is(next.calls.length, 0)
    await releaseAll(old, pending)
    t.is(old.calls.length, 7)
    if (replacement) {
      const fresh = provider.request('feed.read', {})
      t.is(next.calls.length, 1)
      next.calls[0].release()
      await fresh
    } else {
      t.is((await provider.request('feed.read', {}).catch((err) => err)).code, 'CLOSED')
    }
    t.alike(provider.counts, replacement
      ? { begin: 8, end: 8, spans: 8, slow: 8 }
      : { begin: 15, end: 15, spans: 15, slow: 15 })
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
