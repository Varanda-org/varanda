'use strict'

// Public preview of one post before sign-in (src/postPreview.js).
const test = require('brittle')

const load = () => import('../src/postPreview.js')
const HEX = 'ab'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const POST = { author: HEX, seq: 7 }
const URL_OK = ORIGIN + '/p/' + HEX + '/7/previa'

function base (extra) {
  return Object.assign({
    v: 1,
    name: 'Ana',
    username: 'ana',
    date: '14/11/2026',
    text: 'oi',
    photoCount: 0,
    morePhotos: 0,
    video: false,
    relation: null,
    card: null
  }, extra)
}

function response (body, opts = {}) {
  return {
    status: opts.status || 200,
    redirected: opts.redirected,
    url: opts.url === undefined ? URL_OK : opts.url,
    headers: opts.headers,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body)
  }
}

// Replaces fetch for one test and records each call.
function stub (t, impl) {
  const calls = []
  const saved = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return impl(url, init)
  }
  t.teardown(() => { globalThis.fetch = saved })
  return calls
}

async function run (t, body, opts) {
  const { fetchPostPreview } = await load()
  const calls = stub(t, () => response(body, opts))
  const out = await fetchPostPreview({ origin: ORIGIN, post: POST })
  t.is(calls.length, 1)
  return out
}

test('valid text-only post', async (t) => {
  const out = await run(t, { post: base() })
  t.alike(out, { name: 'Ana', username: 'ana', date: '14/11/2026', text: 'oi', photoCount: 0, morePhotos: 0, video: false, relation: null, card: null })
})

test('valid photos, video and card posts', async (t) => {
  const p = await run(t, { post: base({ photoCount: 4, morePhotos: 6, relation: 'quote' }) })
  t.is(p.photoCount, 4)
  t.is(p.morePhotos, 6)
  t.is(p.relation, 'quote')
  const v = await run(t, { post: base({ video: true, photoCount: 1, relation: 'reply', name: null, username: null }) })
  t.is(v.video, true)
  t.is(v.name, null)
  t.is(v.username, null)
  const c = await run(t, { post: base({ card: { title: 'T', host: 'ex.com', x: 1 } }) })
  t.alike(c.card, { title: 'T', host: 'ex.com' })
})

test('request: one GET, init exactly method/credentials/redirect/signal', async (t) => {
  const { fetchPostPreview } = await load()
  const calls = stub(t, () => response({ post: null }))
  t.is(await fetchPostPreview({ origin: ORIGIN, post: POST }), null)
  t.is(calls.length, 1)
  t.is(calls[0].url, URL_OK)
  t.alike(Object.keys(calls[0].init).sort(), ['credentials', 'method', 'redirect', 'signal'])
  t.is(calls[0].init.method, 'GET')
  t.is(calls[0].init.credentials, 'omit')
  t.is(calls[0].init.redirect, 'error')
  t.absent('cache' in calls[0].init)
  t.absent('headers' in calls[0].init)
})

test('null for statuses, redirects and odd bodies', async (t) => {
  t.is(await run(t, 'Not Found', { status: 404 }), null)
  t.is(await run(t, { post: base() }, { status: 500 }), null)
  t.is(await run(t, { post: base() }, { redirected: true }), null)
  t.is(await run(t, { post: base() }, { url: 'https://evil.example/p/' + HEX + '/7/previa' }), null)
  t.is(await run(t, { post: base() }, { url: ORIGIN + '/p/' + HEX + '/8/previa' }), null)
  t.is(await run(t, { post: base() }, { url: URL_OK + '?_=1' }), null)
  t.ok(await run(t, { post: base() }, { url: '' }))
  t.is(await run(t, '<html>oi</html>'), null)
  t.is(await run(t, [{ post: base() }]), null)
  t.is(await run(t, { post: [base()] }), null)
  t.is(await run(t, { post: base({ v: 2 }) }), null)
  t.is(await run(t, ' '.repeat(65537)), null)
})

test('null for malformed fields', async (t) => {
  const bad = [
    { photoCount: 5 }, { photoCount: 1.5 }, { morePhotos: -1 },
    { video: true, photoCount: 2 }, { video: true, morePhotos: 1 }, { video: 'yes' },
    { relation: 'repost' }, { card: { title: 'x' } }, { card: [] }, { text: 3 },
    { name: 1 }, { username: {} }, { date: null }
  ]
  for (const b of bad) t.is(await run(t, { post: base(b) }), null, JSON.stringify(b))
})

test('null for photo counts and cards the seeder never sends, no clamping', async (t) => {
  const bad = [
    { photoCount: 4, morePhotos: 7 }, { photoCount: 4, morePhotos: 9 },
    { photoCount: 0, morePhotos: 1 }, { photoCount: 3, morePhotos: 2 },
    { card: { title: '', host: '' } }
  ]
  for (const b of bad) t.is(await run(t, { post: base(b) }), null, JSON.stringify(b))
  const good = [
    { photoCount: 4, morePhotos: 6 }, { photoCount: 4, morePhotos: 0 }, { photoCount: 2, morePhotos: 0 }
  ]
  for (const g of good) {
    const out = await run(t, { post: base(g) })
    t.is(out && out.photoCount, g.photoCount, JSON.stringify(g))
    t.is(out && out.morePhotos, g.morePhotos, JSON.stringify(g))
  }
  const title = await run(t, { post: base({ card: { title: 'T', host: '' } }) })
  t.alike(title && title.card, { title: 'T', host: '' })
  const host = await run(t, { post: base({ card: { title: '', host: 'ex.com' } }) })
  t.alike(host && host.card, { title: '', host: 'ex.com' })
})

test('extra keys dropped, strings capped, ISO date blanked', async (t) => {
  const out = await run(t, {
    post: base({
      evil: 1,
      text: 'a'.repeat(2000),
      name: 'n'.repeat(200),
      username: 'u'.repeat(100),
      date: '2026-11-14',
      card: { title: 't'.repeat(400), host: 'h'.repeat(400) }
    })
  })
  t.alike(Object.keys(out).sort(), ['card', 'date', 'morePhotos', 'name', 'photoCount', 'relation', 'text', 'username', 'video'])
  t.is(out.text.length, 1000)
  t.is(out.name.length, 80)
  t.is(out.username.length, 40)
  t.is(out.card.title.length, 300)
  t.is(out.card.host.length, 300)
  t.is(out.date, '')
})

test('thrown fetch resolves null', async (t) => {
  const { fetchPostPreview } = await load()
  stub(t, () => { throw new Error('down') })
  t.is(await fetchPostPreview({ origin: ORIGIN, post: POST }), null)
})

function hangingBody (init) {
  return {
    status: 200,
    url: URL_OK,
    text: () => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
}

test('timeout during the body read', async (t) => {
  const { fetchPostPreview } = await load()
  stub(t, (url, init) => hangingBody(init))
  t.is(await fetchPostPreview({ origin: ORIGIN, post: POST, timeoutMs: 20 }), null)
})

test('caller abort: before and during the read', async (t) => {
  const { fetchPostPreview } = await load()
  const calls = stub(t, (url, init) => hangingBody(init))
  const pre = new AbortController()
  pre.abort()
  t.is(await fetchPostPreview({ origin: ORIGIN, post: POST, signal: pre.signal }), null)
  t.is(calls.length, 0)
  const mid = new AbortController()
  const p = fetchPostPreview({ origin: ORIGIN, post: POST, signal: mid.signal })
  setTimeout(() => mid.abort(), 10)
  t.is(await p, null)
  t.is(calls.length, 1)
})

test('invalid origin or target makes no request', async (t) => {
  const { fetchPostPreview, previewUrl } = await load()
  const calls = stub(t, () => response({ post: base() }))
  const origins = ['', null, undefined, ORIGIN + '/', ORIGIN + '/x', ORIGIN + '?a', 'http://example.com', 'ftp://x.y', '/p']
  for (const o of origins) t.is(await fetchPostPreview({ origin: o, post: POST }), null)
  const posts = [null, {}, { author: HEX, seq: 0 }, { author: 'zz', seq: 1 }, { author: HEX, seq: '1x' }]
  for (const p of posts) t.is(await fetchPostPreview({ origin: ORIGIN, post: p }), null)
  t.is(await fetchPostPreview(), null)
  t.is(calls.length, 0)
  t.is(previewUrl('http://localhost:8080', POST), 'http://localhost:8080/p/' + HEX + '/7/previa')
})

test('photoUrl: only foto/1..4 from origin and target', async (t) => {
  const { photoUrl } = await load()
  for (let n = 1; n <= 4; n++) t.is(photoUrl(ORIGIN, POST, n), ORIGIN + '/p/' + HEX + '/7/foto/' + n)
  for (const n of [0, 5, 1.5, '1', -1, NaN]) t.is(photoUrl(ORIGIN, POST, n), null)
  t.is(photoUrl(ORIGIN + '/', POST, 1), null)
  t.is(photoUrl(ORIGIN, { author: HEX, seq: 0 }, 1), null)
})

function headers (map) {
  return { get: (k) => Object.prototype.hasOwnProperty.call(map, k.toLowerCase()) ? map[k.toLowerCase()] : null }
}

test('Content-Length over the cap answers null without reading the body', async (t) => {
  const { fetchPostPreview } = await load()
  let read = 0
  stub(t, () => ({
    status: 200,
    url: URL_OK,
    headers: headers({ 'content-length': '65537' }),
    text: async () => { read++; return JSON.stringify({ post: base() }) }
  }))
  t.is(await fetchPostPreview({ origin: ORIGIN, post: POST }), null)
  t.is(read, 0)
})

test('Content-Length at the cap, odd or absent still reads', async (t) => {
  t.ok(await run(t, { post: base() }, { headers: headers({ 'content-length': '65536' }) }))
  t.ok(await run(t, { post: base() }, { headers: headers({ 'content-length': 'abc' }) }))
  t.ok(await run(t, { post: base() }, { headers: headers({}) }))
  t.ok(await run(t, { post: base() }, { headers: {} }))
})

// JSON for { post: base({ text }) } padded with filler to exactly `bytes` UTF-8 bytes.
function sized (bytes, ch) {
  const head = JSON.stringify({ post: base() }).slice(0, -1) + ',"pad":"'
  const tail = '"}'
  const per = Buffer.byteLength(ch)
  const room = bytes - Buffer.byteLength(head + tail)
  return head + ch.repeat(Math.floor(room / per)) + 'a'.repeat(room % per) + tail
}

test('size cap counts UTF-8 bytes, not UTF-16 units', async (t) => {
  const over = sized(91150, '\u00e9')
  t.ok(over.length < 65536)
  t.is(Buffer.byteLength(over), 91150)
  t.is(await run(t, over), null)
  const cjk = sized(65537, '\u4e2d')
  t.ok(cjk.length < 65536)
  t.is(await run(t, cjk), null)
  const exact = sized(65536, '\u4e2d')
  t.is(Buffer.byteLength(exact), 65536)
  t.ok(await run(t, exact))
  t.is(await run(t, sized(65537, 'a')), null)
  t.ok(await run(t, sized(65536, 'a')))
})

test('caps cut by code point, never half an emoji', async (t) => {
  const e = '\u{1F600}'
  const whole = await run(t, { post: base({ text: 'a'.repeat(999) + e }) })
  t.is(whole.text, 'a'.repeat(999) + e)
  const cut = await run(t, { post: base({ text: 'a'.repeat(1000) + e }) })
  t.is(cut.text, 'a'.repeat(1000))
  const n = await run(t, { post: base({ name: 'n'.repeat(79) + e, username: 'u'.repeat(39) + e }) })
  t.is(n.name, 'n'.repeat(79) + e)
  t.is(n.username, 'u'.repeat(39) + e)
  const m = await run(t, { post: base({ name: 'n'.repeat(80) + e, username: 'u'.repeat(40) + e, card: { title: 't'.repeat(299) + e + e, host: 'h'.repeat(300) + e } }) })
  t.is(m.name, 'n'.repeat(80))
  t.is(m.username, 'u'.repeat(40))
  t.is(m.card.title, 't'.repeat(299) + e)
  t.is(m.card.host, 'h'.repeat(300))
  for (const out of [whole, cut, n, m]) {
    for (const s of [out.text, out.name, out.username, out.card && out.card.title, out.card && out.card.host]) {
      if (typeof s === 'string') t.absent(/[\ud800-\udbff]$/.test(s), 'no lone high surrogate at the end')
    }
  }
})

// The request's own signal, as fetch received it, once the call has answered.
async function signalAfter (t, makeResponse) {
  const { fetchPostPreview } = await load()
  const calls = stub(t, makeResponse)
  const out = await fetchPostPreview({ origin: ORIGIN, post: POST })
  t.is(calls.length, 1)
  return { out, signal: calls[0].init.signal }
}

test('an early return aborts the request so the body stops downloading', async (t) => {
  const long = await signalAfter(t, () => response({ post: base() }, { headers: headers({ 'content-length': '65537' }) }))
  t.is(long.out, null)
  t.ok(long.signal.aborted, 'oversized Content-Length')
  const missing = await signalAfter(t, () => response('Not Found', { status: 404 }))
  t.is(missing.out, null)
  t.ok(missing.signal.aborted, 'status 404')
  const moved = await signalAfter(t, () => response({ post: base() }, { redirected: true }))
  t.is(moved.out, null)
  t.ok(moved.signal.aborted, 'redirected answer')
  const ok = await signalAfter(t, () => response({ post: base() }))
  t.is(ok.out && ok.out.name, 'Ana', 'a read body still parses')
})
