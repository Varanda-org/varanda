'use strict'

const test = require('brittle')
const http = require('http')
const https = require('https')
const { createBareFetch } = require('../worklet/bare-fetch')

const fetch = createBareFetch({ http, https })

async function serve (t, handler) {
  const sockets = new Set()
  const server = http.createServer(handler)
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    for (const s of sockets) s.destroy()
    server.close(() => resolve())
  }))
  return 'http://127.0.0.1:' + server.address().port
}

test('200 with Content-Length streams through getReader', async (t) => {
  const origin = await serve(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': '6', 'X-Thing': 'a' })
    res.write('abc')
    setTimeout(() => res.end('def'), 20)
  })
  const res = await fetch(origin + '/x')
  t.is(res.status, 200)
  t.is(res.ok, true)
  t.is(res.redirected, false)
  t.is(res.headers.get('content-length'), '6')
  t.is(res.headers.get('Content-Length'), '6', 'header lookup is case-insensitive')
  t.is(res.headers.get('X-THING'), 'a')
  t.is(res.headers.get('missing'), null)
  const reader = res.body.getReader()
  const parts = []
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    t.ok(step.value instanceof Uint8Array)
    parts.push(Buffer.from(step.value))
  }
  t.is(Buffer.concat(parts).toString(), 'abcdef')
})

test('arrayBuffer reads the whole body', async (t) => {
  const origin = await serve(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': '3' })
    res.end('xyz')
  })
  const res = await fetch(origin + '/')
  t.is(Buffer.from(await res.arrayBuffer()).toString(), 'xyz')
})

test('arrayBuffer refuses a declared length past 16 MiB', async (t) => {
  const origin = await serve(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': String(16 * 1024 * 1024 + 1) })
    res.write('a')
  })
  const res = await fetch(origin + '/')
  await t.exception.all(res.arrayBuffer(), /too large/)
})

test('cancel stops the stream', async (t) => {
  let closed = null
  const gone = new Promise((resolve) => { closed = resolve })
  let timer = null
  const origin = await serve(t, (req, res) => {
    res.writeHead(200)
    timer = setInterval(() => res.write('chunk'), 5)
    res.on('close', () => {
      clearInterval(timer)
      closed()
    })
  })
  const res = await fetch(origin + '/')
  const reader = res.body.getReader()
  const first = await reader.read()
  t.is(first.done, false)
  await reader.cancel()
  await t.exception.all(reader.read(), /cancelled/)
  await gone
  t.pass('server saw the connection close')
})

test('302 is returned as-is and never followed', async (t) => {
  let hits = 0
  const origin = await serve(t, (req, res) => {
    hits++
    res.writeHead(302, { Location: '/elsewhere' })
    res.end()
  })
  const res = await fetch(origin + '/start')
  t.is(res.status, 302)
  t.is(res.ok, false)
  t.is(res.redirected, false)
  t.is(res.headers.get('location'), '/elsewhere')
  await res.body.cancel()
  t.is(hits, 1)
})

test('only GET and HEAD are allowed', async (t) => {
  let hits = 0
  const origin = await serve(t, (req, res) => {
    hits++
    res.end()
  })
  await t.exception.all(fetch(origin + '/', { method: 'POST' }), /method not allowed/)
  const head = await fetch(origin + '/', { method: 'HEAD' })
  t.is(head.status, 200)
  const step = await head.body.getReader().read()
  t.is(step.done, true)
  t.is(hits, 1)
})

test('plain http only to a loopback host; no other schemes', async (t) => {
  await t.exception.all(fetch('http://example.com/x'), /url not allowed/)
  await t.exception.all(fetch('http://10.0.0.1/x'), /url not allowed/)
  await t.exception.all(fetch('ftp://127.0.0.1/x'), /url not allowed/)
  await t.exception.all(fetch('https://user:pw@127.0.0.1/x'), /credentials not allowed/)
  await t.exception.all(fetch('not a url'), /invalid url/)
})

test('cookie, credential, referrer and cache options are ignored', async (t) => {
  let seen = null
  const origin = await serve(t, (req, res) => {
    seen = req.headers
    res.end('ok')
  })
  const res = await fetch(origin + '/', { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
  t.is(res.status, 200)
  await res.arrayBuffer()
  t.absent(seen.cookie)
  t.absent(seen.referer)
  t.absent(seen.authorization)
})

test('idle timeout fires on a stalled server', async (t) => {
  const quick = createBareFetch({ http, https, idleMs: 100, timeoutMs: 5000 })
  const origin = await serve(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': '10' })
    res.write('ab')
  })
  const res = await quick(origin + '/')
  const reader = res.body.getReader()
  const first = await reader.read()
  t.is(Buffer.from(first.value).toString(), 'ab')
  await t.exception.all(reader.read(), /idle timeout/)
})

test('idle timeout before any response rejects the fetch', async (t) => {
  const quick = createBareFetch({ http, https, idleMs: 100, timeoutMs: 5000 })
  const origin = await serve(t, () => {})
  await t.exception.all(quick(origin + '/'), /idle timeout/)
})

test('overall timeout ends a trickling body', async (t) => {
  const quick = createBareFetch({ http, https, idleMs: 1000, timeoutMs: 200 })
  let timer = null
  const origin = await serve(t, (req, res) => {
    res.writeHead(200)
    timer = setInterval(() => res.write('.'), 20)
    res.on('close', () => clearInterval(timer))
  })
  const res = await quick(origin + '/')
  const reader = res.body.getReader()
  await t.exception.all((async () => { for (;;) { const s = await reader.read(); if (s.done) return } })(), /timeout/)
})
