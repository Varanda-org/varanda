'use strict'

// apps/cli/lib/account/preview-routes.js through the real account server,
// against a loopback fixture site. The fixture is plain HTTP on 127.0.0.1,
// reached only through an injected request (every port mapped to the
// fixture), lookup and address allowlist: no socket leaves loopback, and the
// production address check is shown to refuse that same fixture.

const test = require('brittle')
const http = require('node:http')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { signInvite } = require('@varanda/core/lib/invite')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { createAccountServer } = require('../lib/account/server')
const { openTermsStore } = require('../lib/account/terms-store')
const { parseGifConfig } = require('../lib/account/gif-routes')
const { publicAddress, httpsTarget } = require('../lib/account/safe-fetch')
const { cardFromPage, sniffImage, DEADLINE_MS, PAGE_CAP, IMAGE_CAP, MAX_TITLE, MAX_DESC, PREVIEWS_PER_DAY, MAX_INFLIGHT_PER_MEMBER, USER_AGENT } = require('../lib/account/preview-routes')
const { FINISH_LIMIT } = require('../lib/account/member-session')
const { validLinkCard } = require('@varanda/core/lib/link-card')

const ORIGIN = 'https://varanda.test'
const SITE = 'https://preview.test'
const TITLE = 'Titulo sentinela da pagina'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])

function page (head, body = '') {
  return '<!doctype html><html><head>' + head + '</head><body>' + body + '</body></html>'
}

function fixtureSite () {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://preview.test')
    seen.push({ path: url.pathname, search: url.search, host: req.headers.host, headers: req.headers })
    const html = (text, extra = {}) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extra })
      res.end(text)
    }
    const go = (location) => {
      res.writeHead(302, { Location: location })
      res.end()
    }
    switch (url.pathname) {
      case '/page':
        return html(page('<title>fallback</title><meta property="og:title" content="' + TITLE + '"><meta property="og:description" content="Uma &amp; outra"><meta property="og:image" content="/img.png">'))
      case '/plain':
        return html(page('<!-- <meta property="og:title" content="comentario"> --><script>var s = \'<meta property="og:title" content="script">\'</script><style>/* <meta property="og:description" content="estilo"> */</style><title>So o &lt;titulo&gt; &#x1F600;</title><meta name="description" content=\'desc simples\'>'))
      case '/long':
        return html(page('<meta property="og:title" content="' + 'a\u0001b\u0007'.repeat(60) + '🐱'.repeat(100) + '"><meta content="' + 'd'.repeat(400) + '" property="og:description">'))
      case '/big': {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        const chunk = Buffer.alloc(64 * 1024, 0x61)
        for (let i = 0; i < 9; i++) res.write(chunk)
        return res.end()
      }
      case '/bigdeclared':
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': String(PAGE_CAP + 1) })
        return res.end()
      case '/json':
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end('{"title":"x"}')
      case '/gzip':
        return html(page('<title>x</title>'), { 'Content-Encoding': 'gzip' })
      case '/r1': return go('/page')
      case '/r2': return go('/r1')
      case '/r3': return go('/r2')
      case '/r4': return go('/r3')
      case '/toprivate': return go('https://private.test/page')
      case '/toip': return go('https://127.0.0.1/page')
      case '/tohttp': return go('http://preview.test/page')
      case '/toport': return go('https://preview.test:8443/page')
      case '/tocross': return go('https://img.test/page')
      case '/topipe': return go('/a|b')
      case '/tolong': return go('/page?' + 'q'.repeat(300))
      case '/a|b': return html(page('<title>pipe</title>'))
      case '/slow': return undefined
      case '/bigimg': return html(page('<title>t</title><meta property="og:image" content="https://img.test/huge.png">'))
      case '/svgimg': return html(page('<title>t</title><meta property="og:image" content="/x.svg">'))
      case '/fakeimg': return html(page('<title>t</title><meta property="og:image" content="/fake.png">'))
      case '/privimg': return html(page('<title>t</title><meta property="og:image" content="https://private.test/img.png">'))
      case '/httpimg': return html(page('<title>t</title><meta property="og:image" content="http://preview.test/img.png">'))
      case '/bidi':
        return html(page('<meta property="og:title" content="a\u202eb\u2066c&#x202D;d\u2028e"><meta property="og:description" content="x&#x2069;y\u0085z">'))
      case '/quoted':
        return html(page('<meta property="og:title" content="A > B"><title>Fallback</title><meta name="description" content="Desc > ok">'))
      case '/emptyog':
        return html(page('<meta property="og:title" content=""><meta property="og:description" content="  "><title>Fallback</title><meta name="description" content="Desc reserva">'))
      case '/ampimg':
        return html(page('<title>t</title><meta property="og:image" content="/img.png?a=1&amp;b=2">'))
      case '/img.png':
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(PNG)
      case '/huge.png':
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(Buffer.concat([PNG, Buffer.alloc(IMAGE_CAP)]))
      case '/x.svg':
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        return res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
      case '/fake.png':
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end('<html>not a png</html>')
      default:
        res.writeHead(404)
        res.end()
    }
  })
  return {
    seen,
    async listen () {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      return server.address().port
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
  }
}

function transportFor (port, { allowlist = true, deadlineMs } = {}) {
  const names = { 'preview.test': '127.0.0.1', 'img.test': '127.0.0.1', 'private.test': '10.0.0.1' }
  const t = {
    // Every target is https on 443; the fixture speaks plain HTTP on its own port.
    request: (opts) => http.request({ ...opts, port }),
    lookup: (host, opts, cb) => {
      if (Object.hasOwn(names, host)) return cb(null, [{ address: names[host], family: 4 }])
      const err = new Error('ENOTFOUND')
      err.code = 'ENOTFOUND'
      cb(err)
    }
  }
  if (allowlist) t.allowAddress = (ip) => ip === '127.0.0.1'
  if (deadlineMs !== undefined) t.deadlineMs = deadlineMs
  return t
}

async function setup (t, { allowlist = true, deadlineMs, preview, accepted = true } = {}) {
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const site = fixtureSite()
  const port = await site.listen()
  const association = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const member = crypto.keyPair()
  const memberHex = b4a.toString(member.publicKey, 'hex')
  const logs = []
  const linked = new Set([memberHex])
  const blocked = new Set()
  const store = { start () {}, status: (m) => ({ linked: linked.has(m) }) }
  const moderation = { blocked: () => [...blocked].map((m) => ({ member: m })) }
  const google = { authorizeUrl () {}, exchange () {} }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-preview-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const terms = openTermsStore(dir)
  if (accepted) terms.accept({ member: memberHex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  const gif = parseGifConfig({ apiUrl: 'https://gif.test/v1', apiKey: 'chave-gif' })
  const opts = { association, origin: ORIGIN, google, store, terms, log: (e) => logs.push(e), gif, previewTransport: transportFor(port, { allowlist, deadlineMs }), moderation, now, ratePerSecond: 10000, burst: 10000 }
  if (preview !== undefined) opts.preview = preview
  const server = createAccountServer(opts)
  const svc = await server.listen({ port: 0 })
  t.teardown(async () => {
    await svc.close()
    await site.close()
  })

  function call (method, pathname, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const text = body === undefined ? null : JSON.stringify(body)
      const h = { ...headers }
      if (text !== null) {
        h['Content-Type'] = 'application/json'
        h.Origin = ORIGIN
        h['Content-Length'] = Buffer.byteLength(text)
      }
      const req = http.request({ host: '127.0.0.1', port: svc.port, method, path: pathname, headers: h }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          let json = null
          try { json = JSON.parse(raw.toString('utf8')) } catch {}
          resolve({ status: res.statusCode, raw, json })
        })
      })
      req.on('error', reject)
      if (text !== null) req.write(text)
      req.end()
    })
  }

  function signed (feature, nonce, kp = member) {
    const hex = b4a.toString(kp.publicKey, 'hex')
    return { member: hex, nonce, signature: signInvite({ action: 'summary', nonce, member: hex, association }, kp) }
  }

  async function nonceFor (feature, hex = memberHex) {
    return (await call('POST', '/account/' + feature + '/session/start', { body: { member: hex } })).json.nonce
  }

  async function login (feature = 'preview', kp = member) {
    const hex = b4a.toString(kp.publicKey, 'hex')
    const start = await call('POST', '/account/' + feature + '/session/start', { body: { member: hex } })
    if (start.status !== 200) return { start }
    const finish = await call('POST', '/account/' + feature + '/session/finish', { body: signed(feature, start.json.nonce, kp) })
    return { start, finish, token: finish.json && finish.json.token }
  }

  function fetchPreview (token, body) {
    return call('POST', '/account/preview', { body, headers: token === null ? {} : { Authorization: 'Bearer ' + token } })
  }

  return { site, call, login, signed, nonceFor, fetchPreview, logs, server, member, memberHex, linked, blocked, clock }
}

test('preview: on by default, and off answers the policy and 404 feature-off elsewhere', async (t) => {
  const on = await setup(t)
  t.alike((await on.call('GET', '/account/preview/policy')).json, { enabled: true })
  const off = await setup(t, { preview: false })
  const policy = await off.call('GET', '/account/preview/policy')
  t.is(policy.status, 200)
  t.alike(policy.json, { enabled: false })
  for (const [method, p, body] of [['POST', '/account/preview', { url: SITE + '/page' }], ['POST', '/account/preview/session/start', { member: 'a'.repeat(64) }], ['GET', '/account/preview/other']]) {
    const res = await off.call(method, p, { body })
    t.is(res.status, 404, method + ' ' + p)
    t.alike(res.json, { error: 'feature-off' })
  }
})

test('preview: reads og tags inertly and returns the og:image bytes', async (t) => {
  const { login, fetchPreview, site } = await setup(t)
  const { token } = await login()
  const res = await fetchPreview(token, { url: SITE + '/page' })
  t.is(res.status, 200)
  t.alike(Object.keys(res.json).sort(), ['desc', 'host', 'image', 'title', 'url'])
  t.is(res.json.url, SITE + '/page')
  t.is(res.json.host, 'preview.test')
  t.is(res.json.title, TITLE, 'og:title wins over <title>')
  t.is(res.json.desc, 'Uma & outra', 'entities decoded')
  t.alike(res.json.image, { mime: 'image/png', bytes: PNG.toString('base64') })

  const hit = site.seen.find((s) => s.path === '/page')
  t.is(hit.headers['user-agent'], USER_AGENT)
  for (const name of ['cookie', 'authorization', 'referer', 'origin', 'x-forwarded-for']) t.absent(hit.headers[name], 'no ' + name + ' forwarded')

  const plain = await fetchPreview(token, { url: SITE + '/plain' })
  t.is(plain.status, 200)
  t.is(plain.json.title, 'So o <titulo> 😀', 'comment, script and style skipped; <title> used')
  t.is(plain.json.desc, 'desc simples', 'meta description as the fallback')
  t.is(plain.json.image, null)
})

test('preview: title and desc are cut to the card limits with control characters gone', async (t) => {
  const { login, fetchPreview } = await setup(t)
  const { token } = await login()
  const res = await fetchPreview(token, { url: SITE + '/long' })
  t.is(res.status, 200)
  t.is([...res.json.title].length, MAX_TITLE)
  t.ok(res.json.title.startsWith('abab'), 'control characters stripped')
  t.absent(/[\u0000-\u001f\u007f-\u009f]/.test(res.json.title)) // eslint-disable-line no-control-regex
  t.is(res.json.desc, 'd'.repeat(MAX_DESC))
})

test('preview: only an https URL on a dotted hostname, at most 300 characters, body exactly { url }', async (t) => {
  const { login, fetchPreview, site } = await setup(t)
  const { token } = await login()
  for (const url of ['http://preview.test/page', 'https://127.0.0.1/page', 'https://[::1]/page', 'https://localhost/page', 'https://preview.test:8443/page', 'https://u:p@preview.test/page', 'ftp://preview.test/', 'javascript:alert(1)', 'https://preview.test/' + 'a'.repeat(300), ' https://preview.test/page', 'https://preview.test/\npage', '', 7, null]) {
    const res = await fetchPreview(token, { url })
    t.is(res.status, 400, JSON.stringify(url))
    t.is(res.json.error, 'pedido-invalido')
  }
  t.is((await fetchPreview(token, {})).status, 400, 'missing url')
  t.is((await fetchPreview(token, { url: SITE + '/page', extra: 1 })).status, 400, 'only url')
  t.is(site.seen.length, 0, 'nothing refused reached the site')
  t.is((await fetchPreview(token, { url: SITE + ':443/page' })).status, 200, 'the default port spelled out is the same URL')
})

test('preview: bidi controls, line separators and C1 controls never reach title or desc', async (t) => {
  const { login, fetchPreview } = await setup(t)
  const { token } = await login()
  const res = await fetchPreview(token, { url: SITE + '/bidi' })
  t.is(res.status, 200)
  t.is(res.json.title, 'abcd e')
  t.is(res.json.desc, 'xyz')
  t.ok(validLinkCard({ url: res.json.url, host: res.json.host, title: res.json.title, desc: res.json.desc, image: null }), 'core accepts the card')
})

test('preview: a > inside a quoted attribute does not end the tag, and an empty og value falls back', async (t) => {
  const { login, fetchPreview } = await setup(t)
  const { token } = await login()
  const quoted = await fetchPreview(token, { url: SITE + '/quoted' })
  t.is(quoted.json.title, 'A > B')
  t.is(quoted.json.desc, 'Desc > ok')
  const empty = await fetchPreview(token, { url: SITE + '/emptyog' })
  t.is(empty.json.title, 'Fallback', 'an empty og:title is absent')
  t.is(empty.json.desc, 'Desc reserva', 'a blank og:description is absent')
})

test('preview: the og:image URL has its entities decoded before it is resolved', async (t) => {
  const { login, fetchPreview, site } = await setup(t)
  const { token } = await login()
  const res = await fetchPreview(token, { url: SITE + '/ampimg' })
  t.alike(res.json.image, { mime: 'image/png', bytes: PNG.toString('base64') })
  t.is(site.seen.find((s) => s.path === '/img.png').search, '?a=1&b=2')
})

test('preview: a URL core would refuse as a card is refused before any fetch', async (t) => {
  const { login, fetchPreview, site } = await setup(t)
  const { token } = await login()
  for (const url of ['https://preview.test/a|b', 'https://preview.test/?q={x}', 'https://under_score.test/page', 'https://10.0.0.1/x']) {
    const res = await fetchPreview(token, { url })
    t.is(res.status, 400, url)
  }
  t.is(site.seen.length, 0)
  const frag = await fetchPreview(token, { url: SITE + '/page#topo' })
  t.is(frag.status, 200)
  t.is(frag.json.url, SITE + '/page#topo', 'the fragment is kept, as core keeps it')
})

test('preview: every answer for a hostile page passes core validLinkCard', async (t) => {
  const { login, fetchPreview } = await setup(t)
  const { token } = await login()
  for (const p of ['/page', '/plain', '/long', '/bidi', '/quoted', '/emptyog', '/ampimg']) {
    const res = await fetchPreview(token, { url: SITE + p })
    t.is(res.status, 200, p)
    const card = { url: res.json.url, host: res.json.host, title: res.json.title ?? '', desc: res.json.desc ?? '', image: null }
    t.ok(validLinkCard(card), p)
  }
})

test('preview: redirects to http, an IP literal, another port or a private address are refused', async (t) => {
  const { login, fetchPreview, site } = await setup(t)
  const { token } = await login()
  for (const p of ['/toprivate', '/toip', '/tohttp', '/toport']) {
    const res = await fetchPreview(token, { url: SITE + p })
    t.is(res.status, 503, p)
    t.alike(res.json, { error: 'indisponivel' })
  }
  t.alike(site.seen.map((s) => s.path), ['/toprivate', '/toip', '/tohttp', '/toport'], 'no redirect target was dialled')
})

test('preview: at most 3 redirects', async (t) => {
  const { login, fetchPreview } = await setup(t)
  const { token } = await login()
  const three = await fetchPreview(token, { url: SITE + '/r3' })
  t.is(three.status, 200)
  t.is(three.json.url, SITE + '/page', 'the answer names the final page, not the link the member gave')
  t.is(three.json.title, TITLE)
  t.is((await fetchPreview(token, { url: SITE + '/r4' })).status, 503, 'a fourth redirect')
})

test('preview: a cross-host redirect answers the final URL and host, never the link sent', async (t) => {
  const { login, fetchPreview, site, logs } = await setup(t)
  const { token } = await login()
  const res = await fetchPreview(token, { url: SITE + '/tocross' })
  t.is(res.status, 200)
  t.is(res.json.url, 'https://img.test/page', 'the final URL')
  t.is(res.json.host, 'img.test', 'the final host')
  t.is(res.json.title, TITLE)
  t.ok(validLinkCard({ url: res.json.url, host: res.json.host, title: res.json.title, desc: res.json.desc, image: null }))
  t.ok(site.seen.some((s) => s.path === '/page' && s.host.startsWith('img.test')), 'the page came from the final host')
  for (const p of ['/topipe', '/tolong']) {
    const refused = await fetchPreview(token, { url: SITE + p })
    t.is(refused.status, 503, p + ': a final URL no card may carry')
    t.alike(refused.json, { error: 'indisponivel' })
  }
  t.ok(logs.some((e) => e.event === 'preview' && e.reason === 'destino'))
})

test('preview: the production address check refuses the loopback site and private names', async (t) => {
  const { login, fetchPreview, site } = await setup(t, { allowlist: false })
  const { token } = await login()
  t.is((await fetchPreview(token, { url: SITE + '/page' })).status, 503, 'a name that resolves to 127.0.0.1')
  t.is((await fetchPreview(token, { url: 'https://private.test/page' })).status, 503, 'a name that resolves to 10.0.0.1')
  t.is(site.seen.length, 0, 'no socket reached the site')
  t.absent(publicAddress('127.0.0.1'))
  t.is(httpsTarget('https://127.0.0.1/'), null, 'an IP literal never gets past the target check')
  t.is(httpsTarget('http://preview.test/'), null)
})

test('preview: body cap, non-HTML, encoded bodies and the deadline answer 503', async (t) => {
  const { login, fetchPreview } = await setup(t, { deadlineMs: 300 })
  const { token } = await login()
  for (const p of ['/big', '/bigdeclared', '/json', '/gzip', '/slow', '/missing']) {
    const res = await fetchPreview(token, { url: SITE + p })
    t.is(res.status, 503, p)
    t.alike(res.json, { error: 'indisponivel' })
  }
  t.is(DEADLINE_MS, 5000, 'the production deadline is 5 s')
  t.is(PAGE_CAP, 512 * 1024)
})

test('preview: the image is capped, must be a real raster image and follows the same guards', async (t) => {
  const { login, fetchPreview } = await setup(t)
  const { token } = await login()
  for (const p of ['/bigimg', '/svgimg', '/fakeimg', '/privimg', '/httpimg']) {
    const res = await fetchPreview(token, { url: SITE + p })
    t.is(res.status, 200, p)
    t.is(res.json.title, 't')
    t.is(res.json.image, null, p + ' has no image')
  }
  t.is(IMAGE_CAP, 256 * 1024)
})

test('preview: logs carry counts only, never the URL, title or token', async (t) => {
  const { login, fetchPreview, logs } = await setup(t)
  const { token } = await login()
  await fetchPreview(token, { url: SITE + '/page' })
  await fetchPreview(token, { url: SITE + '/json' })
  const text = JSON.stringify(logs)
  for (const secret of ['preview.test', '/page', '/json', TITLE, token]) t.absent(text.includes(secret), 'no ' + secret.slice(0, 12))
  const mine = logs.filter((e) => e.event === 'preview')
  t.ok(mine.length >= 3)
  t.ok(mine.every((e) => Object.keys(e).every((k) => k === 'event' || k === 'reason')), 'count events only')
  t.alike(mine.map((e) => e.reason), ['sessao', 'previa-imagem', 'indisponivel'])
})

test('preview: a GIF nonce or token never works at preview, and a preview one never at GIF', async (t) => {
  const { call, signed, nonceFor, login, fetchPreview } = await setup(t)
  const gifNonce = await nonceFor('gif')
  const crossed = await call('POST', '/account/preview/session/finish', { body: signed('gif', gifNonce) })
  t.is(crossed.status, 404, 'a GIF nonce at preview finish')
  t.is(crossed.json.error, 'expirado')
  const previewNonce = await nonceFor('preview')
  const back = await call('POST', '/account/gif/session/finish', { body: signed('preview', previewNonce) })
  t.is(back.status, 404, 'a preview nonce at GIF finish')
  t.is(back.json.error, 'expirado')

  const gif = await login('gif')
  t.is(gif.finish.status, 200)
  t.is((await fetchPreview(gif.token, { url: SITE + '/page' })).status, 401, 'a GIF token at preview')
  const prev = await login('preview')
  t.is(prev.finish.status, 200)
  t.is((await call('POST', '/account/gif/search', { body: { q: 'gato' }, headers: { Authorization: 'Bearer ' + prev.token } })).status, 401, 'a preview token at GIF search')
  t.is((await fetchPreview(prev.token, { url: SITE + '/page' })).status, 200)
})

test('preview: a session needs a linked member, the current terms and Authorization Bearer', async (t) => {
  const { login, fetchPreview, call } = await setup(t)
  const stranger = await login('preview', crypto.keyPair())
  t.is(stranger.start.status, 403)
  t.is(stranger.start.json.error, 'nao-vinculado')
  const { token } = await login()
  t.is((await fetchPreview(null, { url: SITE + '/page' })).status, 401)
  t.is((await fetchPreview('A'.repeat(43), { url: SITE + '/page' })).status, 401, 'unknown token')
  t.is((await call('POST', '/account/preview', { body: { url: SITE + '/page' }, headers: { Authorization: 'Basic ' + token } })).status, 401, 'other scheme')

  const pending = await setup(t, { accepted: false })
  const { finish } = await pending.login()
  t.is(finish.status, 409)
  t.alike(finish.json, { error: 'termos-pendentes' })
})

test('preview: a verified nonce works once, and forged finishes never block the member', async (t) => {
  const { call, signed, nonceFor, memberHex } = await setup(t)
  const held = await nonceFor('preview')
  const statuses = new Set()
  for (let i = 0; i < FINISH_LIMIT * 2; i++) {
    statuses.add((await call('POST', '/account/preview/session/finish', { body: { member: memberHex, nonce: crypto.randomBytes(32).toString('base64url'), signature: 'b'.repeat(128) } })).status)
    statuses.add((await call('POST', '/account/preview/session/finish', { body: { member: memberHex, nonce: held, signature: 'b'.repeat(128) } })).status)
  }
  t.alike([...statuses].sort(), [400, 404], 'never 429')
  const body = signed('preview', held)
  t.is((await call('POST', '/account/preview/session/finish', { body })).status, 200)
  const again = await call('POST', '/account/preview/session/finish', { body })
  t.is(again.status, 404, 'single use')
  t.is(again.json.error, 'expirado')
})

test('preview: the finish limit counts verified finishes and answers limite-previa', async (t) => {
  const { call, signed, nonceFor, server } = await setup(t)
  for (let i = 0; i < FINISH_LIMIT; i++) {
    const res = await call('POST', '/account/preview/session/finish', { body: signed('preview', await nonceFor('preview')) })
    if (res.status !== 200) {
      t.fail('finish ' + i + ' answered ' + res.status)
      return
    }
  }
  t.is(server.previewStats().spent, FINISH_LIMIT)
  const over = await call('POST', '/account/preview/session/finish', { body: signed('preview', await nonceFor('preview')) })
  t.is(over.status, 429)
  t.alike(over.json, { error: 'limite-previa' })
  t.is(server.previewStats().spent, FINISH_LIMIT, 'the nonce over the limit was not spent')
  t.is(server.gifStats().spent, 0, 'the GIF session is separate')
})

test('preview: 60 previews per member per day; only a refused address gives the count back', async (t) => {
  const { login, fetchPreview, clock } = await setup(t)
  let { token } = await login()
  for (let i = 0; i < PREVIEWS_PER_DAY; i++) {
    const res = await fetchPreview(token, { url: 'https://private.test/page' })
    if (res.status !== 503) {
      t.fail('refused preview ' + i + ' answered ' + res.status)
      return
    }
  }
  for (let i = 0; i < PREVIEWS_PER_DAY; i++) {
    const res = await fetchPreview(token, { url: SITE + '/plain' })
    if (res.status !== 200) {
      t.fail('preview ' + i + ' answered ' + res.status)
      return
    }
  }
  const over = await fetchPreview(token, { url: SITE + '/plain' })
  t.is(over.status, 429)
  t.alike(over.json, { error: 'limite-previa' })

  clock.offset += 25 * 3600 * 1000
  token = (await login()).token
  for (let i = 0; i < PREVIEWS_PER_DAY; i++) {
    const res = await fetchPreview(token, { url: SITE + '/json' })
    if (res.status !== 503) {
      t.fail('failing preview ' + i + ' answered ' + res.status)
      return
    }
  }
  const spent = await fetchPreview(token, { url: SITE + '/plain' })
  t.is(spent.status, 429, 'a target the member chose that fails after its address was admitted stays counted')
  t.alike(spent.json, { error: 'limite-previa' })
})

test('preview: at most 2 previews in flight per member, besides the global cap', async (t) => {
  const { login, fetchPreview, site } = await setup(t, { deadlineMs: 1500 })
  const { token } = await login()
  t.is(MAX_INFLIGHT_PER_MEMBER, 2)
  const slow = [fetchPreview(token, { url: SITE + '/slow' }), fetchPreview(token, { url: SITE + '/slow' })]
  while (site.seen.filter((s) => s.path === '/slow').length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
  const third = await fetchPreview(token, { url: SITE + '/plain' })
  t.is(third.status, 503, 'a third concurrent preview')
  t.alike(third.json, { error: 'indisponivel' })
  t.absent(site.seen.some((s) => s.path === '/plain'), 'the third never reached the site')
  for (const res of await Promise.all(slow)) t.is(res.status, 503)
  t.is((await fetchPreview(token, { url: SITE + '/plain' })).status, 200, 'the slots are freed')
})

test('preview: a session is re-checked, and a blocked or unlinked member loses it', async (t) => {
  const { login, fetchPreview, blocked, linked, clock, memberHex, logs } = await setup(t)
  const first = await login()
  t.is((await fetchPreview(first.token, { url: SITE + '/plain' })).status, 200)
  blocked.add(memberHex)
  clock.offset += 61 * 1000
  t.is((await fetchPreview(first.token, { url: SITE + '/plain' })).status, 401)
  t.is((await login()).start.status, 403, 'a blocked member gets no nonce')
  blocked.delete(memberHex)
  t.is((await fetchPreview(first.token, { url: SITE + '/plain' })).status, 401, 'the session was dropped')

  const second = await login()
  linked.delete(memberHex)
  clock.offset += 61 * 1000
  t.is((await fetchPreview(second.token, { url: SITE + '/plain' })).status, 401, 'unlinked')
  t.ok(logs.some((e) => e.event === 'preview' && e.reason === 'sessao-revogada'))
})

test('preview: cardFromPage reads with parseOg and the final URL; sniffImage is inert', (t) => {
  t.alike(cardFromPage('<meta property="og:title" content="a"', SITE + '/x'), { url: SITE + '/x', host: 'preview.test', title: '', desc: '', imageUrl: null }, 'an unclosed tag ends the scan; empty fields are strings')
  t.is(cardFromPage('<script>' + '<meta property="og:title" content="x">'.repeat(10), SITE + '/').title, '', 'an unclosed script hides the rest')
  t.is(cardFromPage('<META PROPERTY=og:title CONTENT=sem-aspas>', SITE + '/').title, 'sem-aspas')
  t.is(cardFromPage('<meta property="og:title" content="first"><meta property="og:title" content="second">', SITE + '/').title, 'first')
  t.is(cardFromPage('<meta property="og:image" content="/a?x=1&amp;y=2"><title>t</title>', SITE + '/p/q').imageUrl, SITE + '/a?x=1&y=2', 'decoded, then resolved against the final URL')
  t.is(cardFromPage('<title>t</title>', 'https://127.0.0.1/'), null, 'a final URL no card may carry')
  t.is(cardFromPage('<title>t</title>', SITE + ':8443/'), null, 'another port')
  t.is(cardFromPage('<title>t</title>', SITE + '/' + 'a'.repeat(300)), null, 'too long')
  t.is(sniffImage(PNG), 'image/png')
  t.is(sniffImage(Buffer.from('<svg>')), null)
})

test('preview: the app and the service build the same card from the same page', async (t) => {
  const { extractPreview } = await import('../../app/src/preview.js')
  const pages = [
    '<title>fallback</title><meta property="og:title" content="' + TITLE + '"><meta property="og:description" content="Uma &amp; outra"><meta property="og:image" content="/img.png">',
    '<!-- <meta property="og:title" content="c"> --><script>var s = \'<meta property="og:title" content="s">\'</script><title>So o &lt;titulo&gt; &#x1F600;</title><meta name="description" content=\'desc\'>',
    '<title>Using the <script> tag</title><meta property=og:description content="&#x200B;"><meta name=description content="D &AMP; E">',
    '<meta property=og:title content="&#x202E;&#x200F;"><meta property=og:title content="Second"><meta property=og:image content="http://x.test/a.png"><meta property=og:image content="//img.test/b.png#f">',
    '<template><template></template><meta property=og:title content=Hidden></template><textarea><title>No</title></textarea><title>A&#0;B&nbsp;C</title>',
    '<meta property=og:title content="' + 'a‮b'.repeat(100) + '"><meta property=og:description content="' + '\u{1F600}'.repeat(200) + '">'
  ]
  for (const url of [SITE + '/page', SITE + '/page#topo', 'https://img.test/a?b=c']) {
    for (const html of pages) {
      const app = extractPreview(html, url)
      const svc = cardFromPage(html, url)
      t.alike({ url: svc.url, host: svc.host, title: svc.title ?? '', desc: svc.desc ?? '', imageUrl: svc.imageUrl }, app, html.slice(0, 40))
    }
  }
})

test('preview: a replayed or refused finish never charges the finish limit', async (t) => {
  const { call, signed, nonceFor } = await setup(t)
  const body = signed('preview', await nonceFor('preview'))
  t.is((await call('POST', '/account/preview/session/finish', { body })).status, 200)
  for (let i = 0; i < FINISH_LIMIT * 2; i++) {
    const again = await call('POST', '/account/preview/session/finish', { body })
    if (again.status !== 404) return t.fail('replay ' + i + ' answered ' + again.status)
  }
  for (let i = 1; i < FINISH_LIMIT; i++) {
    const res = await call('POST', '/account/preview/session/finish', { body: signed('preview', await nonceFor('preview')) })
    if (res.status !== 200) return t.fail('fresh finish ' + i + ' answered ' + res.status)
  }
  t.is((await call('POST', '/account/preview/session/finish', { body: signed('preview', await nonceFor('preview')) })).status, 429)

  const pending = await setup(t, { accepted: false })
  for (let i = 0; i < FINISH_LIMIT + 2; i++) {
    const res = await pending.call('POST', '/account/preview/session/finish', { body: pending.signed('preview', await pending.nonceFor('preview')) })
    if (res.status !== 409) return t.fail('pending terms ' + i + ' answered ' + res.status)
  }
  t.pass('refused finishes never reached 429')
})
