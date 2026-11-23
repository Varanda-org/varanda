'use strict'

// src/storeRelease.js: the build Google Play serves, read from the
// installation, and the Android store notice built on it. Runs without
// React or native APIs.
const test = require('brittle')

const load = () => import('../src/storeRelease.js')

const ORIGIN = 'https://bora.example'
const URL_OK = ORIGIN + '/.well-known/app-release.json'
const body = (build) => JSON.stringify({ v: 1, android: { build } })

function headers (map) {
  return { get: (name) => (Object.prototype.hasOwnProperty.call(map, name.toLowerCase()) ? map[name.toLowerCase()] : null) }
}

// A fetch Response: a body stream by default, or only text() (React Native).
function response ({ status = 200, type = 'application/json', text = body(5), url = URL_OK, redirected = false, stream = true, length, chunks } = {}) {
  const map = {}
  if (type !== null) map['content-type'] = type
  if (length !== undefined) map['content-length'] = length
  else if (typeof text === 'string') map['content-length'] = String(text.length)
  const res = { status, url, redirected, headers: headers(map), cancelled: false }
  if (stream) {
    const parts = (chunks || [text]).map((part) => Uint8Array.from(Buffer.from(part, 'latin1')))
    res.body = {
      cancel () { res.cancelled = true; return Promise.resolve() },
      getReader () {
        return {
          read: async () => (parts.length > 0 ? { done: false, value: parts.shift() } : { done: true }),
          cancel () { res.cancelled = true; return Promise.resolve() }
        }
      }
    }
  } else {
    res.text = async () => text
  }
  return res
}

function fetcher (answer) {
  const calls = []
  const f = (url, opts) => {
    calls.push({ url, opts })
    return typeof answer === 'function' ? answer(url, opts) : Promise.resolve(answer)
  }
  f.calls = calls
  return f
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('parseStoreRelease accepts exactly the contract', async (t) => {
  const { parseStoreRelease, MAX_STORE_BUILD, MAX_STORE_RELEASE_BYTES } = await load()
  t.is(MAX_STORE_BUILD, 999999999)
  t.is(MAX_STORE_RELEASE_BYTES, 256)
  t.is(parseStoreRelease('{"v":1,"android":{"build":7}}'), 7)
  t.is(parseStoreRelease(' {\n "android": { "build": 12 },\n "v": 1\n}\n'), 12, 'key order and whitespace are free')
  t.is(parseStoreRelease(body(1)), 1, 'lower bound')
  t.is(parseStoreRelease(body(999999999)), 999999999, 'upper bound')
  for (const build of [0, -1, 1000000000, 1.5, '5', null, true, [], {}, 1e21]) {
    t.is(parseStoreRelease(body(build)), null, 'build ' + JSON.stringify(build))
  }
})

test('parseStoreRelease refuses extra keys, wrong types and oversize text', async (t) => {
  const { parseStoreRelease } = await load()
  const bad = [
    '{"v":1,"android":{"build":5},"ios":{"build":5}}',
    '{"v":1,"android":{"build":5,"min":1}}',
    '{"v":1,"android":{"build":5},"__proto__":{}}',
    '{"v":1,"android":{"build":5,"__proto__":{}}}',
    '{"v":2,"android":{"build":5}}',
    '{"v":"1","android":{"build":5}}',
    '{"android":{"build":5}}',
    '{"v":1}',
    '{"v":1,"android":{}}',
    '{"v":1,"android":[5]}',
    '{"v":1,"android":null}',
    '[{"v":1,"android":{"build":5}}]',
    'null',
    '5',
    '',
    '{"v":1,"android":{"build":5}',
    '{"v":1,"android":{"build":"é"}}',
    body(5) + ' '.repeat(257 - body(5).length)
  ]
  for (const text of bad) t.is(parseStoreRelease(text), null, JSON.stringify(text).slice(0, 60))
  t.is(parseStoreRelease(body(5) + ' '.repeat(256 - body(5).length)), 5, '256 bytes is the limit')
  for (const value of [undefined, null, 5, {}, Buffer.from(body(5))]) t.is(parseStoreRelease(value), null)
})

test('storeUpdate: a newer served build on a Google Play install only', async (t) => {
  const { storeUpdate } = await load()
  t.is(storeUpdate({ fromPlay: true, installed: 5, served: 4 }), false, 'lower')
  t.is(storeUpdate({ fromPlay: true, installed: 5, served: 5 }), false, 'equal')
  t.is(storeUpdate({ fromPlay: true, installed: 5, served: 6 }), true, 'higher')
  t.is(storeUpdate({ fromPlay: false, installed: 5, served: 6 }), false, 'not from Play')
  t.is(storeUpdate({ fromPlay: 'true', installed: 5, served: 6 }), false)
  t.is(storeUpdate({ fromPlay: true, installed: 5, served: 1000000000 }), false, 'served out of range')
  for (const installed of [undefined, null, 0, -1, 1.5, '5', NaN]) {
    t.is(storeUpdate({ fromPlay: true, installed, served: 6 }), false, 'installed ' + String(installed))
  }
  const throwing = new Proxy({}, { get () { throw new Error('blocked') } })
  for (const arg of [undefined, null, 1, throwing]) t.is(storeUpdate(arg), false)
})

test('fetchStoreRelease makes no request without an installation', async (t) => {
  const { fetchStoreRelease } = await load()
  const f = fetcher(response())
  for (const installation of [undefined, null, '', 5]) {
    t.is(await fetchStoreRelease({ installation, fetch: f }), null)
  }
  t.is(f.calls.length, 0)
})

test('fetchStoreRelease reads the fixed path with credentials omitted and redirects refused', async (t) => {
  const { fetchStoreRelease } = await load()
  const f = fetcher(response({ text: body(42) }))
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: f }), 42)
  t.is(f.calls.length, 1)
  t.is(f.calls[0].url, URL_OK)
  t.is(f.calls[0].opts.credentials, 'omit')
  t.is(f.calls[0].opts.redirect, 'error')
  t.ok(f.calls[0].opts.signal, 'abortable')
  t.absent('cache' in f.calls[0].opts, 'no cache option (React Native would add a query)')
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: fetcher(response({ text: body(42), stream: false })) }), 42, 'text() body with a declared length')
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: fetcher(response({ chunks: ['{"v":1,"andr', 'oid":{"build":9}}'] })) }), 9, 'chunked stream')
})

test('fetchStoreRelease: redirects, statuses and content types are no information', async (t) => {
  const { fetchStoreRelease } = await load()
  const cases = [
    { redirected: true },
    { url: 'https://other.example/.well-known/app-release.json' },
    { url: ORIGIN + '/elsewhere.json' },
    { url: ORIGIN + '/.well-known/app-release.json?x=1' },
    { url: 'https://user:pw@bora.example/.well-known/app-release.json' },
    { url: 'not a url' },
    { status: 404 },
    { status: 500 },
    { status: 304 },
    { type: 'text/html' },
    { type: null },
    { text: '<html>' + body(9) }
  ]
  for (const c of cases) {
    const res = response({ text: body(9), ...c })
    t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: fetcher(res) }), null, JSON.stringify(c))
  }
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: fetcher(response({ url: '' })) }), 5, 'no final url (React Native) is the request url')
})

test('fetchStoreRelease: an oversize body is cut off', async (t) => {
  const { fetchStoreRelease } = await load()
  const big = response({ chunks: ['{"v":1,"android":{"build":5}}', ' '.repeat(300)] })
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: fetcher(big) }), null)
  t.ok(big.cancelled, 'the stream is cancelled')
  for (const length of [undefined, '257', '1e3', '-1', '']) {
    const res = response({ stream: false })
    if (length === undefined) res.headers = headers({ 'content-type': 'application/json' })
    else res.headers = headers({ 'content-type': 'application/json', 'content-length': length })
    t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: fetcher(res) }), null, 'content-length ' + String(length))
  }
  const lying = response({ stream: false, text: body(5) + ' '.repeat(300), length: '30' })
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: fetcher(lying) }), null, 'a short declared length does not lift the bound')
})

// A body stream that counts reads: yields chunks from next(i), one per
// macrotask so timers still run, until next returns null or end() is called.
function countingStream (next, { length } = {}) {
  const map = { 'content-type': 'application/json' }
  if (length !== undefined) map['content-length'] = length
  const res = { status: 200, url: URL_OK, redirected: false, headers: headers(map), cancelled: false, reads: 0, ended: false }
  res.end = () => { res.ended = true }
  res.body = {
    cancel () { res.cancelled = true; return Promise.resolve() },
    getReader () {
      return {
        read: () => new Promise((resolve) => setImmediate(() => {
          const value = res.ended || res.cancelled ? null : next(res.reads++)
          resolve(value === null ? { done: true } : { done: false, value })
        })),
        cancel () { res.cancelled = true; return Promise.resolve() }
      }
    }
  }
  return res
}

test('fetchStoreRelease: a stream past the cap is aborted without reading the rest', async (t) => {
  const { fetchStoreRelease } = await load()
  let signal = null
  const res = countingStream(() => new Uint8Array(200).fill(0x20))
  t.teardown(res.end)
  const got = await fetchStoreRelease({ installation: ORIGIN, fetch: (url, opts) => { signal = opts.signal; return Promise.resolve(res) } })
  t.is(got, null)
  t.is(res.reads, 2, 'stops at the read that crosses 256 bytes')
  t.ok(res.cancelled, 'the reader is cancelled')
  t.ok(signal.aborted, 'the request itself is aborted')
})

test('fetchStoreRelease: a declared length past the cap on a stream is refused before any read', async (t) => {
  const { fetchStoreRelease } = await load()
  for (const length of ['257', '1e3', '-1', '']) {
    let signal = null
    const res = countingStream(() => Uint8Array.from(Buffer.from(body(5))), { length })
    t.teardown(res.end)
    t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: (url, opts) => { signal = opts.signal; return Promise.resolve(res) } }), null, 'content-length ' + length)
    t.is(res.reads, 0, 'nothing read for ' + length)
    t.ok(signal.aborted)
  }
  // No declared length (chunked, or a gzip body the HTTP client decoded):
  // the stream count is the bound.
  const plain = countingStream((i) => (i === 0 ? Uint8Array.from(Buffer.from(body(8))) : null))
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: () => Promise.resolve(plain) }), 8)
})

test('fetchStoreRelease: an endless run of empty chunks ends in null', async (t) => {
  const { fetchStoreRelease, MAX_STORE_RELEASE_READS } = await load()
  t.is(MAX_STORE_RELEASE_READS, 512)
  let signal = null
  const res = countingStream(() => new Uint8Array(0))
  t.teardown(res.end)
  let readsAtEnd = -1
  const got = await fetchStoreRelease({
    installation: ORIGIN,
    timeoutMs: 5000,
    fetch: (url, opts) => { signal = opts.signal; return Promise.resolve(res) }
  }).then((value) => { readsAtEnd = res.reads; return value })
  t.is(got, null)
  t.is(readsAtEnd, MAX_STORE_RELEASE_READS, 'ends at the read cap, not at the timeout')
  t.ok(res.cancelled, 'the reader is cancelled')
  t.ok(signal.aborted, 'the request is aborted')
  const mixed = countingStream((i) => (i < 100 ? new Uint8Array(0) : i === 100 ? Uint8Array.from(Buffer.from(body(3))) : null))
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: () => Promise.resolve(mixed) }), 3, 'empty chunks among real ones are skipped')
})

test('fetchStoreRelease: a fetch that refuses redirects (expo/fetch) gives no information', async (t) => {
  const { fetchStoreRelease } = await load()
  let followed = 0
  const expoLike = (url, opts) => {
    if (opts.redirect === 'error') return Promise.reject(new Error("Redirect is not allowed when redirect mode is 'error'"))
    followed++
    return Promise.resolve(response({ url: 'https://other.example/.well-known/app-release.json', text: body(9) }))
  }
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: expoLike }), null)
  t.is(followed, 0, 'never asked to follow')
})

test('fetchStoreRelease: offline and a timeout are no information', async (t) => {
  const { fetchStoreRelease } = await load()
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: () => Promise.reject(new TypeError('Network request failed')) }), null, 'offline')
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: () => { throw new Error('sync') } }), null, 'a throwing fetch')
  t.is(await fetchStoreRelease({ installation: ORIGIN, fetch: () => Promise.resolve(null) }), null, 'no response')

  let signal = null
  let fire = null
  let cleared = 0
  const pending = fetchStoreRelease({
    installation: ORIGIN,
    // Never settles, even on abort: the timer alone must end the wait.
    fetch: (url, opts) => { signal = opts.signal; return new Promise(() => {}) },
    timeoutMs: 1234,
    setTimeout: (fn, ms) => { t.is(ms, 1234); fire = fn; return 'timer' },
    clearTimeout: (id) => { if (id === 'timer') cleared++ }
  })
  await settle()
  t.ok(fire, 'a timer is armed')
  fire()
  t.is(await pending, null, 'timeout')
  t.ok(signal.aborted, 'the request is aborted')
  t.is(cleared, 1, 'the timer is cleared')
})

function watchHarness (overrides = {}) {
  const clock = { now: 1000000 }
  const active = new Set()
  const states = []
  let installation = ORIGIN
  let served = body(6)
  const f = fetcher(() => (served instanceof Error ? Promise.reject(served) : Promise.resolve(response({ text: served }))))
  const opts = {
    build: { versionCode: 5, fromPlay: true },
    origin: () => installation,
    onChange: (s) => states.push(s.update),
    onActive: (fn) => { active.add(fn); return () => active.delete(fn) },
    fetch: f,
    now: () => clock.now,
    ...overrides
  }
  return {
    opts,
    clock,
    active,
    states,
    fetches: f.calls,
    foreground: () => { for (const fn of [...active]) fn() },
    setInstallation: (value) => { installation = value },
    serve: (value) => { served = value }
  }
}

test('watchStoreRelease: lower, equal and higher served builds', async (t) => {
  const { watchStoreRelease } = await load()
  const RELEASE_FOCUS_MIN_MS = 60000
  const h = watchHarness()
  const stop = watchStoreRelease(h.opts)
  await settle()
  t.is(h.fetches.length, 1, 'checks at start')
  t.alike(h.states, [true], 'higher')
  h.serve(body(5))
  h.clock.now += RELEASE_FOCUS_MIN_MS
  h.foreground()
  await settle()
  t.alike(h.states, [true, false], 'equal clears the notice')
  h.serve(body(4))
  h.clock.now += RELEASE_FOCUS_MIN_MS
  h.foreground()
  await settle()
  t.alike(h.states, [true, false], 'lower: unchanged state is not reported again')
  t.is(h.fetches.length, 3)
  stop()
})

test('watchStoreRelease: the cooldown spaces foreground checks', async (t) => {
  const { watchStoreRelease } = await load()
  const h = watchHarness()
  const stop = watchStoreRelease(h.opts)
  await settle()
  t.is(h.fetches.length, 1)
  h.clock.now += 59999
  h.foreground()
  h.foreground()
  await settle()
  t.is(h.fetches.length, 1, 'inside the cooldown: no request')
  h.clock.now += 1
  h.foreground()
  h.foreground()
  await settle()
  t.is(h.fetches.length, 2, 'one request after the cooldown, however many events')
  stop()
})

test('watchStoreRelease: failures are silent and keep the state', async (t) => {
  const { watchStoreRelease } = await load()
  const h = watchHarness()
  const stop = watchStoreRelease(h.opts)
  await settle()
  t.alike(h.states, [true])
  for (const bad of [new TypeError('offline'), '{"v":1,"android":{"build":5},"x":1}', 'not json']) {
    h.serve(bad)
    h.clock.now += 60000
    h.foreground()
    await settle()
  }
  t.is(h.fetches.length, 4, 'failed attempts still count against the cooldown')
  t.alike(h.states, [true], 'no change reported on a failure')
  h.foreground()
  await settle()
  t.is(h.fetches.length, 4)
  stop()
})

test('watchStoreRelease: fromPlay false or no build makes no request and no listener', async (t) => {
  const { watchStoreRelease } = await load()
  for (const build of [{ versionCode: 1, fromPlay: false }, { versionCode: 5, fromPlay: 'true' }, { versionCode: '5', fromPlay: true }, null, undefined]) {
    const h = watchHarness({ build })
    const stop = watchStoreRelease(h.opts)
    await settle()
    t.is(h.fetches.length, 0, 'no request for ' + JSON.stringify(build))
    t.is(h.active.size, 0, 'no listener')
    t.alike(h.states, [])
    stop()
    stop()
  }
})

test('watchStoreRelease: without a fetch, no listener and no request', async (t) => {
  const { watchStoreRelease } = await load()
  for (const fetch of [null, 5]) {
    const h = watchHarness({ fetch })
    const stop = watchStoreRelease(h.opts)
    await settle()
    t.is(h.active.size, 0, 'no listener for ' + String(fetch))
    t.alike(h.states, [])
    stop()
  }
})

test('watchStoreRelease: no installation, no request, and the later check is not spent', async (t) => {
  const { watchStoreRelease } = await load()
  const h = watchHarness()
  h.setInstallation(null)
  const stop = watchStoreRelease(h.opts)
  h.foreground()
  await settle()
  t.is(h.fetches.length, 0, 'no request while the installation is unknown')
  h.setInstallation(ORIGIN)
  h.foreground()
  await settle()
  t.is(h.fetches.length, 1, 'the first known installation is checked at once')
  t.is(h.fetches[0].url, URL_OK)
  stop()
})

test('watchStoreRelease: stop removes the listener and drops a late answer', async (t) => {
  const { watchStoreRelease } = await load()
  let answer = null
  let signal = null
  const h = watchHarness()
  h.opts.fetch = (url, opts) => new Promise((resolve) => { answer = resolve; signal = opts.signal })
  const stop = watchStoreRelease(h.opts)
  t.is(h.active.size, 1)
  t.absent(signal.aborted)
  stop()
  t.is(h.active.size, 0, 'listener removed')
  t.ok(signal.aborted, 'the request in flight is aborted')
  answer(response({ text: body(9) }))
  await settle()
  t.alike(h.states, [], 'late answer dropped')
  h.foreground()
  stop()
})

test('watchStoreRelease: a newer check wins over a late older answer', async (t) => {
  const { watchStoreRelease } = await load()
  const pending = []
  const signals = []
  const h = watchHarness()
  h.opts.fetch = (url, opts) => new Promise((resolve) => { pending.push(resolve); signals.push(opts.signal) })
  const stop = watchStoreRelease(h.opts)
  h.clock.now += 60000
  h.foreground()
  t.is(pending.length, 2)
  t.ok(signals[0].aborted, 'the older request is aborted')
  pending[1](response({ text: body(5) }))
  await settle()
  pending[0](response({ text: body(9) }))
  await settle()
  t.alike(h.states, [false], 'only the newest answer counts')
  stop()
})

test('watchStoreRelease: a throwing callback or origin does not break the watch', async (t) => {
  const { watchStoreRelease } = await load()
  const h = watchHarness()
  let calls = 0
  h.opts.onChange = () => { calls++; throw new Error('callback') }
  const stop = watchStoreRelease(h.opts)
  await settle()
  t.is(calls, 1)
  h.opts.origin = () => { throw new Error('origin') }
  const other = watchStoreRelease(h.opts)
  await settle()
  t.is(h.fetches.length, 1, 'a throwing origin makes no request')
  stop()
  other()
})
