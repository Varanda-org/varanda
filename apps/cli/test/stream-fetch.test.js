'use strict'

// apps/cli/lib/account/stream-fetch.js against two loopback fixtures. They are
// plain HTTP on 127.0.0.1, reached through an injected request (each name
// mapped to its fixture's port), lookup and address allowlist: no socket
// leaves loopback, and the default https target is the one under test.

const test = require('brittle')
const http = require('node:http')
const { Writable, PassThrough } = require('node:stream')
const { httpsTarget } = require('../lib/account/safe-fetch')
const { createStreamFetch, parseRange, readCapped, pipeCapped } = require('../lib/account/stream-fetch')

const KEY = 'chave-sentinela-stream-42'
const UA = 'Varanda-teste/1'
const ALLOWED_HEADERS = ['host', 'connection', 'user-agent', 'accept', 'range']
const BYTES = Buffer.from(Array.from({ length: 100 }, (_, i) => i))

function fixture (name) {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://' + name)
    const closed = new Promise((resolve) => req.socket.once('close', resolve))
    seen.push({ path: url.pathname, headers: req.headers, closed })
    route(url, req, res)
  })
  const timers = new Set()
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn() }, ms)
    timers.add(id)
  }
  function route (url, req, res) {
    const p = url.pathname
    if (p === '/start') {
      res.writeHead(302, { Location: url.searchParams.get('to') })
      return res.end()
    }
    const hops = p.match(/^\/r\/(\d+)$/)
    if (hops) {
      const n = Number(hops[1])
      if (n > 0) {
        res.writeHead(302, { Location: '/r/' + (n - 1) })
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      return res.end('fim')
    }
    if (p === '/song') {
      res.writeHead(206, { 'Content-Type': 'audio/mpeg; charset=binary', 'Content-Range': 'bytes 0-3/10', 'Content-Length': '4' })
      return res.end('abcd')
    }
    if (p === '/bytes') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(BYTES.length) })
      return res.end(BYTES)
    }
    if (p === '/open') {
      // Far more than any cap here, and never ends.
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      return res.write(Buffer.alloc(4096, 1))
    }
    if (p === '/stall') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      return res.write(Buffer.alloc(5, 2))
    }
    if (p === '/drip') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      const tick = () => {
        if (res.destroyed || res.writableEnded) return
        res.write(Buffer.alloc(1, 3))
        later(tick, 20)
      }
      return tick()
    }
    if (p === '/cut') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      res.write(Buffer.alloc(5, 4))
      return later(() => res.destroy(), 50)
    }
    if (p === '/far') {
      res.writeHead(416, { 'Content-Range': 'bytes */100' })
      return res.end()
    }
    if (p === '/far-bare') {
      res.writeHead(416)
      return res.end()
    }
    if (p === '/boom') {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      return res.end('falha')
    }
    if (p === '/hang') return
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('nada')
  }
  return {
    seen,
    async listen () {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      return server.address().port
    },
    close: () => new Promise((resolve) => {
      for (const id of timers) clearTimeout(id)
      server.closeAllConnections()
      server.close(resolve)
    })
  }
}

// inside.test answers a dialable loopback address first and a private one
// second: only the guarded lookup, which needs every address to pass, keeps
// the socket from opening to fixture b.
const ADDRESSES = { 'a.test': ['127.0.0.1'], 'b.test': ['127.0.0.1'], 'inside.test': ['127.0.0.1', '10.0.0.5'] }

async function setup (t, options = {}) {
  const a = fixture('a.test')
  const b = fixture('b.test')
  const ports = { 'a.test': await a.listen(), 'b.test': await b.listen() }
  ports['inside.test'] = ports['b.test']
  t.teardown(async () => {
    await a.close()
    await b.close()
  })
  const open = createStreamFetch({
    request: (opts) => http.request({ ...opts, port: ports[opts.hostname] || 1 }),
    lookup: (host, opts, cb) => {
      const list = ADDRESSES[host]
      if (list === undefined) {
        const err = new Error('ENOTFOUND')
        err.code = 'ENOTFOUND'
        return cb(err)
      }
      cb(null, list.map((address) => ({ address, family: 4 })))
    },
    allowAddress: (ip) => ip === '127.0.0.1',
    firstTarget: httpsTarget,
    userAgent: UA,
    ...options
  })
  return { a, b, open }
}

const OPTS = { accept: 'audio/*', connectMs: 2000 }

// The rejection carries the short token, and is returned for its fields.
async function rejectsWith (t, promise, token, message = token) {
  try {
    await promise
    t.fail(message + ': resolved')
  } catch (err) {
    t.is(err.message, token, message)
    return err
  }
}

test('a redirect keeps Range and the fixed headers but drops firstHeaders', async (t) => {
  const { a, b, open } = await setup(t)
  const got = await open('https://a.test/start?to=' + encodeURIComponent('https://b.test/song'), {
    ...OPTS,
    firstHeaders: { 'X-Api-Key': KEY },
    range: 'bytes=0-3'
  })
  t.is(got.status, 206)
  t.is(got.headers['content-range'], 'bytes 0-3/10')
  t.is(got.type, 'audio/mpeg')
  t.is(got.url, 'https://b.test/song')
  t.is((await readCapped(got.stream, 16)).toString(), 'abcd')

  t.is(a.seen.length, 1)
  t.is(a.seen[0].headers['x-api-key'], KEY)
  t.is(a.seen[0].headers.range, 'bytes=0-3')
  t.is(b.seen.length, 1)
  const hb = b.seen[0].headers
  t.is(hb['x-api-key'], undefined)
  t.is(hb.range, 'bytes=0-3')
  t.is(hb['user-agent'], UA)
  t.is(hb.accept, 'audio/*')
  t.alike(Object.keys(hb).filter((k) => !ALLOWED_HEADERS.includes(k)), [])
  t.ok(!JSON.stringify(hb).includes(KEY))
})

test('a malformed Range is not sent, and firstHeaders cannot replace the fixed headers', async (t) => {
  const { a, open } = await setup(t)
  for (const range of ['bytes=0-1,4-5', 'bytes=-500', 'bytes=1234567890123-', 'items=0-1', 5]) {
    const got = await open('https://a.test/bytes', {
      ...OPTS,
      firstHeaders: { 'user-agent': 'intruso', RANGE: 'bytes=0-1', accept: 'text/html', 'X-Api-Key': KEY },
      range
    })
    got.destroy()
  }
  t.is(a.seen.length, 5)
  for (const s of a.seen) {
    t.is(s.headers.range, undefined)
    t.is(s.headers['user-agent'], UA)
    t.is(s.headers.accept, 'audio/*')
    t.is(s.headers['x-api-key'], KEY)
  }
})

test('the first hop must pass firstTarget', async (t) => {
  const { a, b, open } = await setup(t, {
    firstTarget: (href) => href.startsWith('https://a.test/') ? httpsTarget(href) : null
  })
  await rejectsWith(t, open('https://b.test/bytes', OPTS), 'destino')
  const got = await open('https://a.test/bytes', OPTS)
  t.is(got.status, 200)
  t.is((await readCapped(got.stream, 1000)).length, BYTES.length)
  t.is(a.seen.length, 1)
  t.is(b.seen.length, 0)
  // A redirect is judged by nextTarget, which admits b.test.
  const moved = await open('https://a.test/start?to=' + encodeURIComponent('https://b.test/bytes'), OPTS)
  t.is(moved.url, 'https://b.test/bytes')
  t.alike(await readCapped(moved.stream, 1000), BYTES)
  t.is(b.seen.length, 1)
})

test('every redirect must pass nextTarget', async (t) => {
  const { b, open } = await setup(t, {
    nextTarget: (href) => href.startsWith('https://a.test/') ? httpsTarget(href) : null
  })
  await rejectsWith(t, open('https://a.test/start?to=' + encodeURIComponent('https://b.test/bytes'), OPTS), 'destino')
  t.is(b.seen.length, 0)
})

test('a redirect to a non-public address is refused before any socket opens', async (t) => {
  const { b, open } = await setup(t)
  await rejectsWith(t, open('https://a.test/start?to=' + encodeURIComponent('https://inside.test/bytes'), OPTS), 'rede')
  t.is(b.seen.length, 0)
})

test('a redirect to an IP literal, plain http, credentials or another port is refused', async (t) => {
  const { b, open } = await setup(t)
  const targets = [
    'https://127.0.0.1/bytes',
    'https://[::1]/bytes',
    'http://b.test/bytes',
    'https://user:pw@b.test/bytes',
    'https://b.test:8443/bytes',
    'https://localhost/bytes'
  ]
  for (const to of targets) {
    await rejectsWith(t, open('https://a.test/start?to=' + encodeURIComponent(to), OPTS), 'destino', to)
  }
  t.is(b.seen.length, 0)
})

test('three redirects are followed and a fourth is refused', async (t) => {
  const { a, open } = await setup(t)
  const got = await open('https://a.test/r/3', OPTS)
  t.is(got.status, 200)
  t.is(got.url, 'https://a.test/r/0')
  t.is((await readCapped(got.stream, 16)).toString(), 'fim')
  t.is(a.seen.length, 4)
  await rejectsWith(t, open('https://a.test/r/4', OPTS), 'redirecionamentos')
  t.is(a.seen.length, 8)
})

test('a status other than 200 or 206 rejects and closes the socket', async (t) => {
  const { a, open } = await setup(t)
  const missing = await rejectsWith(t, open('https://a.test/missing', OPTS), 'status')
  await a.seen[0].closed
  t.pass('upstream socket closed')
  t.is(missing.status, 404)
  t.absent('contentRange' in missing, 'only a 416 names a range')
})

test('a status rejection carries the status, and a 416 its Content-Range', async (t) => {
  const { open } = await setup(t)
  const boom = await rejectsWith(t, open('https://a.test/boom', OPTS), 'status')
  t.is(boom.status, 500)
  t.absent('contentRange' in boom)
  const far = await rejectsWith(t, open('https://a.test/far', { ...OPTS, range: 'bytes=500-' }), 'status')
  t.is(far.status, 416)
  t.is(far.contentRange, 'bytes */100')
  const bare = await rejectsWith(t, open('https://a.test/far-bare', { ...OPTS, range: 'bytes=500-' }), 'status')
  t.is(bare.status, 416)
  t.is(bare.contentRange, null)
})

test('the connect deadline rejects and closes the socket', async (t) => {
  const { a, open } = await setup(t)
  const started = Date.now()
  await rejectsWith(t, open('https://a.test/hang', { ...OPTS, connectMs: 150 }), 'prazo')
  t.ok(Date.now() - started >= 140)
  await a.seen[0].closed
  t.pass('upstream socket closed')
})

test('destroy() tears down an open response', async (t) => {
  const { a, open } = await setup(t)
  const got = await open('https://a.test/open', OPTS)
  got.destroy()
  await a.seen[0].closed
  t.pass('upstream socket closed')
})

test('parseRange', (t) => {
  t.alike(parseRange('bytes=0-'), { start: 0, end: null })
  t.alike(parseRange('bytes=10-20'), { start: 10, end: 20 })
  t.alike(parseRange('bytes=5-5'), { start: 5, end: 5 })
  t.alike(parseRange('bytes=999999999999-999999999999'), { start: 999999999999, end: 999999999999 })
  t.is(parseRange('bytes=20-10'), null)
  t.is(parseRange('bytes=-10'), null)
  t.is(parseRange('bytes=0-1,3-4'), null)
  t.is(parseRange('bytes=1234567890123-'), null)
  t.is(parseRange('bytes= 0-1'), null)
  t.is(parseRange('Bytes=0-1'), null)
  t.is(parseRange(''), null)
  t.is(parseRange(null), null)
  t.is(parseRange(7), null)
})

test('readCapped rejects past the cap and closes the socket', async (t) => {
  const { a, open } = await setup(t)
  const got = await open('https://a.test/bytes', OPTS)
  await rejectsWith(t, readCapped(got.stream, 99), 'grande')
  await a.seen[0].closed
  const again = await open('https://a.test/bytes', OPTS)
  t.alike(await readCapped(again.stream, 100), BYTES)
})

test('readCapped rejects at once a stream torn down before it was called', async (t) => {
  const bounded = (promise) => Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('sem-resposta')), 500))
  ])
  const gone = new PassThrough()
  gone.destroy()
  await new Promise((resolve) => gone.once('close', resolve))
  await rejectsWith(t, bounded(readCapped(gone, 16)), 'rede', 'destroyed')

  const failed = new PassThrough()
  failed.on('error', () => {})
  failed.destroy(new Error('x'))
  await new Promise((resolve) => failed.once('close', resolve))
  await rejectsWith(t, bounded(readCapped(failed, 16)), 'rede', 'errored')
})

// A relay in front of the fixtures: each request opens `path` upstream and
// pipes it to the client through pipeCapped with `opts`.
// Without `opts.size` the response has no Content-Length, so it is chunked.
async function relay (t, open, path, opts) {
  const calls = []
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const server = http.createServer(async (req, res) => {
    const up = await open('https://a.test' + path, OPTS)
    const headers = { 'Content-Type': up.type }
    if (opts.size != null) headers['Content-Length'] = opts.size
    res.writeHead(200, headers)
    pipeCapped(up.stream, res, {
      ...opts,
      onDone: (reason, bytes, skipped) => {
        calls.push(reason)
        resolveDone({ reason, bytes, skipped })
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }))
  return { port: server.address().port, done, calls }
}

function get (port, { abortAfter = 0 } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.on('data', (c) => {
        chunks.push(c)
        if (abortAfter > 0 && Buffer.concat(chunks).length >= abortAfter) req.destroy()
      })
      res.on('end', () => resolve({ body: Buffer.concat(chunks), complete: true }))
      res.on('error', () => resolve({ body: Buffer.concat(chunks), complete: false }))
      res.on('close', () => resolve({ body: Buffer.concat(chunks), complete: false }))
    })
    req.on('error', () => resolve({ body: Buffer.concat(chunks), complete: false }))
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('pipeCapped discards skip bytes and ends with the upstream', async (t) => {
  const { a, open } = await setup(t)
  const r = await relay(t, open, '/bytes', { skip: 10, cap: 1000, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'end', bytes: 90, skipped: 10 })
  t.ok(out.complete)
  t.alike(out.body, BYTES.subarray(10))
  await a.seen[0].closed
  await settle()
  t.alike(r.calls, ['end'])
})

test('pipeCapped skip larger than the body sends nothing', async (t) => {
  const { open } = await setup(t)
  const r = await relay(t, open, '/bytes', { skip: 500, cap: 1000, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'end', bytes: 0, skipped: 100 })
  t.is(out.body.length, 0)
})

test('pipeCapped stops at the cap and ends the upstream socket', async (t) => {
  const { a, open } = await setup(t)
  const r = await relay(t, open, '/open', { skip: 6, cap: 10, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'cap', bytes: 10, skipped: 6 })
  t.alike(out.body, Buffer.alloc(10, 1))
  await a.seen[0].closed
  await settle()
  t.alike(r.calls, ['cap'])
})

test('pipeCapped stops when the upstream stalls and ends its socket', async (t) => {
  const { a, open } = await setup(t)
  const r = await relay(t, open, '/stall', { cap: 1000, stallMs: 150, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'stall', bytes: 5, skipped: 0 })
  t.absent(out.complete)
  await a.seen[0].closed
  await settle()
  t.alike(r.calls, ['stall'])
})

test('pipeCapped stops when the client stops reading and ends the upstream socket', async (t) => {
  const { a, open } = await setup(t)
  const got = await open('https://a.test/open', OPTS)
  let reason = null
  let calls = 0
  let destroyed = false
  // Takes one chunk and never acknowledges it, like a reader that stopped.
  const sink = new Writable({
    highWaterMark: 1,
    write () {},
    destroy (err, cb) {
      destroyed = true
      cb(err)
    }
  })
  await new Promise((resolve) => {
    pipeCapped(got.stream, sink, {
      cap: 1 << 20,
      stallMs: 150,
      totalMs: 5000,
      onDone: (r) => {
        calls++
        reason = r
        resolve()
      }
    })
  })
  t.is(reason, 'stall')
  t.ok(destroyed)
  await a.seen[0].closed
  await settle()
  t.is(calls, 1)
})

test('pipeCapped stops at the total deadline and ends the upstream socket', async (t) => {
  const { a, open } = await setup(t)
  const started = Date.now()
  const r = await relay(t, open, '/drip', { cap: 1000, stallMs: 1000, totalMs: 200 })
  const out = await get(r.port)
  const { reason, bytes } = await r.done
  t.is(reason, 'total')
  t.ok(bytes > 0 && bytes < 1000)
  t.ok(Date.now() - started >= 190)
  t.absent(out.complete)
  await a.seen[0].closed
  await settle()
  t.alike(r.calls, ['total'])
})

test('pipeCapped stops when the client aborts and ends the upstream socket', async (t) => {
  const { a, open } = await setup(t)
  const r = await relay(t, open, '/drip', { cap: 1000, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port, { abortAfter: 2 })
  t.absent(out.complete)
  const { reason } = await r.done
  t.is(reason, 'client')
  await a.seen[0].closed
  await settle()
  t.alike(r.calls, ['client'])
})

test('pipeCapped stops when the upstream closes early', async (t) => {
  const { open } = await setup(t)
  const r = await relay(t, open, '/cut', { cap: 1000, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'upstream', bytes: 5, skipped: 0 })
  t.absent(out.complete)
  await settle()
  t.alike(r.calls, ['upstream'])
})

test('pipeCapped: a chunk that reaches the cap exactly ends at once while the upstream stays open', async (t) => {
  const { a, open } = await setup(t)
  const started = Date.now()
  // /open sends 4096 bytes and never ends: only the cap can stop it early.
  const r = await relay(t, open, '/open', { cap: 4096, stallMs: 3000, totalMs: 10000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'cap', bytes: 4096, skipped: 0 })
  t.ok(Date.now() - started < 2000, 'long before the stall deadline')
  t.alike(out.body, Buffer.alloc(4096, 1))
  await a.seen[0].closed
})

test('pipeCapped: a cut of a chunked response reaches the client incomplete', async (t) => {
  const { open } = await setup(t)
  const r = await relay(t, open, '/open', { cap: 10, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'cap', bytes: 10, skipped: 0 })
  t.alike(out.body, Buffer.alloc(10, 1), 'what was written arrives')
  t.is(out.complete, false, 'no terminating chunk')
})

test('pipeCapped: a cap equal to the declared size is a complete body', async (t) => {
  const { open } = await setup(t)
  const r = await relay(t, open, '/open', { cap: 10, size: 10, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'cap', bytes: 10, skipped: 0 })
  t.alike(out.body, Buffer.alloc(10, 1))
  t.is(out.complete, true)
})

test('pipeCapped: a cut of a sized response is short and incomplete', async (t) => {
  const { open } = await setup(t)
  const r = await relay(t, open, '/open', { cap: 10, size: 20, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'cap', bytes: 10, skipped: 0 })
  t.alike(out.body, Buffer.alloc(10, 1))
  t.is(out.complete, false)
})

test('pipeCapped: skipped counts what arrived when the upstream closes mid-skip', async (t) => {
  const { open } = await setup(t)
  // /cut sends 5 bytes and then drops the connection.
  const r = await relay(t, open, '/cut', { skip: 50, cap: 1000, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'upstream', bytes: 0, skipped: 5 })
  t.is(out.body.length, 0)
})

// A client that takes what it is given and never acknowledges any of it, so
// nothing written ever flushes.
function stuckClient () {
  const state = { destroyed: false }
  state.sink = new Writable({
    highWaterMark: 1 << 16,
    write () {},
    destroy (err, cb) {
      state.destroyed = true
      cb(err)
    }
  })
  return state
}

async function guarded (t, feed, opts) {
  const up = new PassThrough()
  const client = stuckClient()
  const calls = []
  const started = Date.now()
  const done = new Promise((resolve) => {
    pipeCapped(up, client.sink, {
      ...opts,
      onDone: (reason, bytes, skipped) => {
        calls.push({ reason, bytes, skipped, at: Date.now() - started, destroyed: client.destroyed })
        resolve()
      }
    })
  })
  feed(up)
  await new Promise((resolve) => setTimeout(resolve, Math.min(opts.stallMs, opts.totalMs) / 2))
  t.is(calls.length, 0, 'onDone waits while the response has not flushed')
  t.absent(client.destroyed, 'the response is still open')
  await done
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.is(calls.length, 1, 'onDone ran once')
  t.ok(calls[0].destroyed, 'the response was destroyed before onDone')
  const deadline = Math.min(opts.stallMs, opts.totalMs)
  t.ok(calls[0].at >= deadline - 10, 'only after the first deadline: ' + calls[0].at + ' ms')
  t.ok(up.destroyed, 'the upstream was destroyed')
  return calls[0]
}

test('pipeCapped: a client that stops reading after the end is destroyed at the flush deadline', async (t) => {
  const got = await guarded(t, (up) => up.end(Buffer.alloc(10, 1)), { cap: 1000, stallMs: 200, totalMs: 5000 })
  t.is(got.reason, 'stall')
  t.is(got.bytes, 10)
})

test('pipeCapped: a client that stops reading after a cut is destroyed at the flush deadline', async (t) => {
  const got = await guarded(t, (up) => up.write(Buffer.alloc(20, 1)), { cap: 10, stallMs: 200, totalMs: 5000 })
  t.is(got.reason, 'stall')
  t.is(got.bytes, 10)
})

test('pipeCapped: the total deadline still bounds a response that is flushing', async (t) => {
  const got = await guarded(t, (up) => up.end(Buffer.alloc(10, 1)), { cap: 1000, stallMs: 400, totalMs: 300 })
  t.is(got.reason, 'total')
})

// A client that reads everything; reports whether `res` was ended or only
// destroyed, which a sized body that arrived whole cannot show on the wire.
async function endedOrCut (opts) {
  const up = new PassThrough()
  const state = { finished: false }
  const sink = new Writable({ write (chunk, enc, cb) { cb() } })
  sink.on('finish', () => { state.finished = true })
  const done = new Promise((resolve) => {
    pipeCapped(up, sink, { ...opts, onDone: (reason, bytes) => resolve({ reason, bytes }) })
  })
  up.write(Buffer.alloc(20, 1))
  const got = await done
  return { ...got, finished: state.finished, destroyed: sink.destroyed }
}

test('pipeCapped: a cap equal to size ends the response, any other cap destroys it unended', async (t) => {
  const whole = await endedOrCut({ cap: 10, size: 10, stallMs: 1000, totalMs: 5000 })
  t.alike({ reason: whole.reason, bytes: whole.bytes, finished: whole.finished }, { reason: 'cap', bytes: 10, finished: true })
  const cut = await endedOrCut({ cap: 10, size: null, stallMs: 1000, totalMs: 5000 })
  t.alike({ reason: cut.reason, bytes: cut.bytes, finished: cut.finished, destroyed: cut.destroyed }, { reason: 'cap', bytes: 10, finished: false, destroyed: true })
})

test('pipeCapped: an upstream that ends at the declared size is a complete body', async (t) => {
  const { open } = await setup(t)
  const r = await relay(t, open, '/bytes', { cap: 1000, size: 100, stallMs: 1000, totalMs: 5000 })
  const out = await get(r.port)
  t.alike(await r.done, { reason: 'end', bytes: 100, skipped: 0 })
  t.alike(out.body, BYTES)
  t.is(out.complete, true)
})

// A keep-alive client: an ended short body would leave it waiting on a
// socket that stays usable, so it gives up after `waitMs` and says so.
function getKeepAlive (t, port, waitMs) {
  const agent = new http.Agent({ keepAlive: true })
  t.teardown(() => agent.destroy())
  return new Promise((resolve) => {
    const chunks = []
    const finish = (complete) => resolve({ body: Buffer.concat(chunks), complete })
    const timer = setTimeout(() => finish('waiting'), waitMs)
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { clearTimeout(timer); finish(true) })
      res.on('error', () => { clearTimeout(timer); finish(false) })
      res.on('aborted', () => { clearTimeout(timer); finish(false) })
    })
    req.on('error', () => { clearTimeout(timer); finish(false) })
  })
}

test('pipeCapped: an upstream that ends short of the declared size is a cut', async (t) => {
  const { open } = await setup(t)
  // /bytes ends normally after 100 bytes, short of the 150 declared.
  const r = await relay(t, open, '/bytes', { cap: 1000, size: 150, stallMs: 1000, totalMs: 5000 })
  const out = await getKeepAlive(t, r.port, 1500)
  t.alike(await r.done, { reason: 'upstream', bytes: 100, skipped: 0 })
  t.alike(out.body, BYTES, 'what was written arrives')
  t.is(out.complete, false, 'the socket is destroyed, not left waiting')
})

test('pipeCapped: a short end of a sized body destroys the response unended', async (t) => {
  const up = new PassThrough()
  const state = { finished: false }
  const sink = new Writable({ write (chunk, enc, cb) { cb() } })
  sink.on('finish', () => { state.finished = true })
  const done = new Promise((resolve) => {
    pipeCapped(up, sink, { cap: 1000, size: 30, stallMs: 1000, totalMs: 5000, onDone: (reason, bytes) => resolve({ reason, bytes }) })
  })
  up.end(Buffer.alloc(20, 1))
  t.alike(await done, { reason: 'upstream', bytes: 20 })
  t.is(state.finished, false)
  t.is(sink.destroyed, true)
})

test('pipeCapped: an upstream destroyed while writes are pending delivers every relayed byte, unended', async (t) => {
  const SIZE = 64 << 20
  const up = new PassThrough()
  let resolveServed
  const serving = new Promise((resolve) => { resolveServed = resolve })
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': SIZE })
    resolveServed(res)
    pipeCapped(up, res, {
      cap: SIZE,
      size: SIZE,
      stallMs: 3000,
      totalMs: 10000,
      onDone: (reason, bytes) => resolveDone({ reason, bytes, ended: res.writableEnded })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }))

  // The client takes the headers and then reads nothing, so the socket fills
  // and later writes wait in the response.
  const responded = new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/', agent: false }, resolve)
    req.on('error', () => {})
  })
  const served = await serving
  const sent = []
  const feed = () => {
    const chunk = Buffer.alloc(64 * 1024, sent.length % 251)
    sent.push(chunk)
    up.write(chunk)
  }
  feed()
  const response = await responded
  // A loopback send buffer grows as ACKs come back (Linux), so a first
  // backpressure can drain by itself: feed until bytes still wait after a pause.
  while (sent.length < 512) {
    if (served.writableNeedDrain) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (served.writableLength > 0) break
    }
    feed()
    await new Promise((resolve) => setImmediate(resolve))
  }
  t.ok(served.writableLength > 0, 'writes are pending when the upstream goes')
  up.destroy()

  const got = await new Promise((resolve) => {
    const chunks = []
    const finish = (complete) => resolve({ body: Buffer.concat(chunks), complete })
    response.on('data', (c) => chunks.push(c))
    response.on('end', () => finish(true))
    response.on('error', () => finish(false))
    response.on('close', () => finish(response.complete))
  })
  const { reason, bytes, ended } = await done
  t.is(reason, 'upstream')
  t.ok(bytes > 0 && bytes < SIZE)
  t.is(got.body.length, bytes, 'every relayed byte reached the client')
  t.ok(got.body.equals(Buffer.concat(sent).subarray(0, bytes)), 'in order and intact')
  t.is(got.complete, false, 'short of Content-Length')
  t.is(ended, false, 'the response was never ended')
})
