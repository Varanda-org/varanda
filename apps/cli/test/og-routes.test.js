'use strict'

// apps/cli/lib/account/og-routes.js through the real account server on
// 127.0.0.1, with a real invites store in a temporary directory.

const test = require('brittle')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { DESIGNS } = require('@varanda/rpc')
const { createAccountServer } = require('../lib/account/server')
const { openInvitesStore, newCode, inviteId, INVITE_TTL_MS } = require('../lib/account/invites-store')
const { escapeHtml, ogPage, GENERIC_TITLE, DESCRIPTION, CSP } = require('../lib/account/og-routes')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function setup (t, { invites: withInvites = true } = {}) {
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const usedIds = new Set()
  const invites = withInvites ? openInvitesStore(dir, { now, perWeek: 5, isUsed: (id) => usedIds.has(id) }) : null
  const names = new Map()
  const store = {
    start () {},
    status: (m) => (names.has(m) ? { linked: true, username: names.get(m) } : { linked: false })
  }
  const logs = []
  const google = { authorizeUrl () {}, exchange () {} }
  const association = hex(crypto.keyPair().publicKey)
  const server = createAccountServer({ association, origin: ORIGIN, google, store, invites, log: (e) => logs.push(e), now, ratePerSecond: 100000, burst: 100000 })
  const svc = await server.listen({ port: 0 })
  t.teardown(() => svc.close())

  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 })
  t.teardown(() => agent.destroy())

  function call (method, pathname, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: svc.port, method, path: pathname, headers, agent }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  async function inviteFrom (username) {
    const member = hex(crypto.keyPair().publicKey)
    if (username !== null) names.set(member, username)
    const { code } = await invites.issue(member)
    return { member, code }
  }

  return { call, inviteFrom, invites, usedIds, clock, logs }
}

function meta (html, key) {
  const m = new RegExp('<meta (?:property|name)="' + key.replace(/[.:]/g, '\\$&') + '" content="([^"]*)">').exec(html)
  return m === null ? null : m[1]
}

function generic (t, res, image = ORIGIN + '/og/convite.png', msg = '') {
  t.is(res.status, 200, msg + ' status')
  t.is(meta(res.text, 'og:title'), GENERIC_TITLE, msg + ' generic title')
  t.is(meta(res.text, 'og:image'), image, msg + ' image')
}

test('a live invite with a design and a linked inviter names the inviter', async (t) => {
  const { call, inviteFrom, logs } = await setup(t)
  const { code, member } = await inviteFrom('maria')
  const res = await call('GET', '/account/og/convite/' + code + '?c=3', { Host: 'evil.test' })
  t.is(res.status, 421, 'a foreign Host is refused before any route')
  const ok = await call('GET', '/account/og/convite/' + code + '?c=3')
  t.is(ok.status, 200)
  t.is(meta(ok.text, 'og:title'), '@maria te mandou um convite pra Varanda')
  t.ok(ok.text.includes('<title>@maria te mandou um convite pra Varanda</title>'))
  t.is(meta(ok.text, 'og:description'), DESCRIPTION)
  t.is(meta(ok.text, 'og:image'), ORIGIN + '/og/convite-' + DESIGNS[3] + '.png')
  t.is(meta(ok.text, 'og:image:width'), '1200')
  t.is(meta(ok.text, 'og:image:height'), '630')
  t.is(meta(ok.text, 'og:image:alt'), 'Cartão de convite da Varanda')
  t.is(meta(ok.text, 'og:url'), ORIGIN + '/convite/' + code + '?c=3')
  t.is(meta(ok.text, 'og:type'), 'website')
  t.is(meta(ok.text, 'og:site_name'), 'Varanda')
  t.is(meta(ok.text, 'twitter:card'), 'summary_large_image')
  t.is(meta(ok.text, 'robots'), 'noindex')
  t.ok(ok.text.includes('<a href="' + ORIGIN + '/convite/' + code + '?c=3">Abrir o convite</a>'))
  t.absent(/<script|<style|style=|#/.test(ok.text), 'no script, style or fragment')
  t.is(meta(ok.text, 'og:url').includes('evil'), false)
  const last = await call('GET', '/account/og/convite/' + code + '?c=12')
  t.is(meta(last.text, 'og:image'), ORIGIN + '/og/convite-' + DESIGNS[12] + '.png', 'the last design')
  const text = JSON.stringify(logs)
  t.absent(text.includes(code), 'logs never hold the code')
  t.absent(text.includes(member), 'logs never hold the key')
  t.absent(text.includes('maria'), 'logs never hold the username')
  t.alike(logs.filter((e) => e.event === 'og'), [{ event: 'og', reason: 'pessoal' }, { event: 'og', reason: 'pessoal' }])
})

test('no or bad design, dead or malformed codes, unnamed inviters: generic page', async (t) => {
  const { call, inviteFrom, invites, usedIds, clock, logs } = await setup(t)
  const { code } = await inviteFrom('maria')
  const base = '/account/og/convite/' + code

  const none = await call('GET', base)
  generic(t, none, undefined, 'no c')
  t.is(meta(none.text, 'og:url'), ORIGIN + '/convite/' + code, 'no c in og:url')
  for (const q of ['?c=01', '?c=13', '?c=999', '?c=x', '?c=', '?c=1&c=2', '?c=1&x=1', '?x=1&c=1', '?C=1', '?c=-1', '?c=1.0', '?c=%31']) {
    const res = await call('GET', base + q)
    generic(t, res, undefined, q)
    t.is(meta(res.text, 'og:url'), ORIGIN + '/convite/' + code, q + ' og:url')
  }

  const used = await inviteFrom('joana')
  await invites.consume(inviteId(used.code))
  generic(t, await call('GET', '/account/og/convite/' + used.code), undefined, 'used')
  generic(t, await call('GET', '/account/og/convite/' + used.code + '?c=0'), ORIGIN + '/og/convite-' + DESIGNS[0] + '.png', 'used with c')

  const directory = await inviteFrom('ana')
  usedIds.add(inviteId(directory.code))
  generic(t, await call('GET', '/account/og/convite/' + directory.code + '?c=1'), ORIGIN + '/og/convite-' + DESIGNS[1] + '.png', 'used in the directory')

  generic(t, await call('GET', '/account/og/convite/' + newCode()), undefined, 'unknown')
  generic(t, await call('GET', '/account/og/convite/' + newCode() + '?c=2'), ORIGIN + '/og/convite-' + DESIGNS[2] + '.png', 'unknown with c')

  const anon = await inviteFrom(null)
  generic(t, await call('GET', '/account/og/convite/' + anon.code + '?c=2'), ORIGIN + '/og/convite-' + DESIGNS[2] + '.png', 'inviter without a username')

  for (const bad of ['short', code + 'A', code.slice(0, 42) + '!', code + '/', '%3Cscript%3E', '']) {
    const res = await call('GET', '/account/og/convite/' + bad + '?c=3')
    generic(t, res, undefined, 'malformed ' + JSON.stringify(bad))
    t.is(meta(res.text, 'og:url'), ORIGIN + '/', 'malformed og:url')
    t.absent(res.text.includes('%3C') || res.text.includes('<script'), 'nothing echoed')
  }

  clock.offset = INVITE_TTL_MS
  generic(t, await call('GET', base), undefined, 'expired')
  generic(t, await call('GET', base + '?c=3'), ORIGIN + '/og/convite-' + DESIGNS[3] + '.png', 'expired with c')

  invites.fail()
  clock.offset = 0
  generic(t, await call('GET', base + '?c=3'), ORIGIN + '/og/convite-' + DESIGNS[3] + '.png', 'unavailable store')

  t.ok(logs.filter((e) => e.event === 'og').every((e) => e.reason === 'generico'))
  t.absent(JSON.stringify(logs).includes(code))
})

test('open sign-up (no invites store) answers the generic page', async (t) => {
  const { call } = await setup(t, { invites: false })
  generic(t, await call('GET', '/account/og/convite/' + newCode() + '?c=4'), ORIGIN + '/og/convite-' + DESIGNS[4] + '.png')
})

test('headers are exact and HEAD has no body', async (t) => {
  const { call, inviteFrom } = await setup(t)
  const { code } = await inviteFrom('maria')
  const get = await call('GET', '/account/og/convite/' + code + '?c=5')
  const head = await call('HEAD', '/account/og/convite/' + code + '?c=5')
  for (const [name, res] of [['GET', get], ['HEAD', head]]) {
    t.is(res.status, 200, name)
    t.is(res.headers['content-type'], 'text/html; charset=utf-8', name)
    t.is(res.headers['cache-control'], 'no-store', name)
    t.is(res.headers['x-robots-tag'], 'noindex', name)
    t.is(res.headers['x-content-type-options'], 'nosniff', name)
    t.is(res.headers['content-security-policy'], CSP, name)
    t.is(res.headers['content-security-policy'], "default-src 'none'; img-src https:; base-uri 'none'; form-action 'none'", name)
    t.is(res.headers['referrer-policy'], 'no-referrer', name)
    t.is(res.headers['content-length'], String(Buffer.byteLength(get.text)), name)
    t.absent(res.headers['access-control-allow-origin'], name)
  }
  t.is(head.text, '', 'HEAD body is empty')
  t.ok(get.text.length > 0)
  const post = await call('POST', '/account/og/convite/' + code)
  t.is(post.status, 404, 'other methods are not found')
})

test('every interpolated value is escaped', (t) => {
  t.is(escapeHtml('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&#39;f')
  const html = ogPage({ title: '"><script>x</script>', image: 'https://a.test/x.png?a=1&b="2"', url: "https://a.test/'><b>" })
  t.absent(html.includes('<script>'))
  t.absent(html.includes('<b>'))
  t.ok(html.includes('content="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"'))
  t.ok(html.includes('content="https://a.test/x.png?a=1&amp;b=&quot;2&quot;"'))
  t.ok(html.includes('href="https://a.test/&#39;&gt;&lt;b&gt;"'))
})

test('over the global lookup window answers 429', async (t) => {
  const { call, logs } = await setup(t)
  const code = newCode()
  const batch = []
  for (let i = 0; i < 1200; i++) batch.push(call('HEAD', '/account/og/convite/' + code))
  const answers = await Promise.all(batch)
  t.ok(answers.every((r) => r.status === 200), 'the whole window is served')
  const res = await call('GET', '/account/og/convite/' + code + '?c=1')
  t.is(res.status, 429)
  t.alike(JSON.parse(res.text), { error: 'pedido-invalido' })
  t.absent(JSON.stringify(logs).includes(code))
})
