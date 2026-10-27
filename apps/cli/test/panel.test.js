'use strict'

// The moderation panel's static assets (apps/cli/lib/account/panel), served
// by mod-routes.js under a CSP without inline code. app.js is required under
// Node with an injected fake document and fetch.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { REASON_LABELS } = require('@varanda/core/lib/report')

const DIR = path.join(__dirname, '..', 'lib', 'account', 'panel')
const APP = path.join(DIR, 'app.js')
const panel = require(APP)

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
// Bidi controls built at run time: never raw in source (orchestrator rule).
const RLO = String.fromCodePoint(0x202e)
const LRI = String.fromCodePoint(0x2066)
const PDI = String.fromCodePoint(0x2069)

// A minimal DOM: just what app.js's builders use.
class FakeNode {
  constructor (doc, tag) {
    this.ownerDocument = doc
    this.tagName = tag.toUpperCase()
    this.children = []
    this.attributes = {}
    this.listeners = {}
    this.className = ''
    this.disabled = false
    this.value = ''
    this._text = ''
  }

  set textContent (v) {
    this.children = []
    this._text = String(v)
  }

  get textContent () {
    return this._text + this.children.map((c) => c.textContent).join('')
  }

  get innerHTML () {
    throw new Error('innerHTML must never be used')
  }

  set innerHTML (v) {
    throw new Error('innerHTML must never be used')
  }

  appendChild (c) {
    this.children.push(c)
    return c
  }

  replaceChildren () {
    this.children = []
    this._text = ''
  }

  setAttribute (k, v) {
    this.attributes[k] = String(v)
  }

  getAttribute (k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null
  }

  addEventListener (type, fn) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(fn)
  }

  click () {
    if (this.disabled) return
    for (const fn of this.listeners.click || []) fn({ type: 'click' })
  }
}

function fakeDocument () {
  const doc = { created: [] }
  const main = new FakeNode(doc, 'main')
  doc.getElementById = (id) => (id === 'app' ? main : null)
  doc.createElement = (tag) => {
    const n = new FakeNode(doc, tag)
    doc.created.push(n)
    return n
  }
  doc.write = () => { throw new Error('document.write must never be used') }
  doc.main = main
  return doc
}

// C0 (except TAB/LF), DEL, C1, zero-width/marks, bidi embeddings and
// isolates, BOM: the orchestrator's raw-character scan.
function isRawInvisible (ch) {
  const cp = ch.codePointAt(0)
  return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
}

function walk (node, out = []) {
  out.push(node)
  for (const c of node.children) walk(c, out)
  return out
}

function buttons (doc, text) {
  return walk(doc.main).filter((n) => n.tagName === 'BUTTON' && n.textContent === text)
}

function response (status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

// routes: { 'GET /account/mod/api/me': (opts) => [status, body], ... }
function fakeFetch (routes) {
  const calls = []
  const fetch = async (url, opts) => {
    calls.push({ url, opts })
    const key = opts.method + ' ' + url
    const route = routes[key]
    if (!route) return response(404, { error: 'nao-encontrado' })
    const [status, body] = route(opts)
    return response(status, body)
  }
  return { fetch, calls }
}

function env (doc, fetch, extra = {}) {
  const assigned = []
  const replaced = []
  const e = {
    document: doc,
    fetch,
    location: { search: '', pathname: '/account/mod/', assign: (u) => assigned.push(u) },
    history: { replaceState: (s, t, u) => replaced.push(u) },
    confirm: () => true,
    ...extra
  }
  e.assigned = assigned
  e.replaced = replaced
  return e
}

const ME = { email: 'mod@example.org', published: { seq: 3, at: '2026-10-20T10:00:00.000Z' }, open: 1, pending: 0 }

function signedIn (openReports, blocked = { published: { seq: 3, at: '2026-10-20T10:00:00.000Z' }, blocked: [], pending: [] }) {
  return {
    'GET /account/mod/api/me': () => [200, ME],
    'GET /account/mod/api/reports?estado=aberta': () => [200, { reports: openReports, truncated: false }],
    'GET /account/mod/api/reports?estado=decidida': () => [200, { reports: [], truncated: false }],
    'GET /account/mod/api/blocked': () => [200, blocked]
  }
}

function report (fields = {}) {
  return {
    id: 'r1abcdefghijklmnopqrst',
    at: '2026-10-21T12:00:00.000Z',
    kind: 'post',
    target: A,
    seq: 4,
    quote: 'oi',
    reason: 'spam',
    text: '',
    reporter: { member: B, username: 'ana' },
    reported: { member: A, username: '', linked: true },
    status: 'aberta',
    decidedBy: null,
    decidedAt: null,
    note: '',
    ...fields
  }
}

test('index.html: viewport meta, external assets only, no inline code, no form', async (t) => {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
  t.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'))
  t.ok(html.includes('lang="pt-BR"'))
  t.ok(html.includes('<link rel="stylesheet" href="/account/mod/app.css">'))
  t.ok(html.includes('<script src="/account/mod/app.js" defer></script>'))
  t.ok(/<main id="app"><\/main>/.test(html), 'empty main')
  t.absent(html.includes('Entrar com Google'), 'the login button is rendered by the script')
  t.absent(/<script\b[^>]*>[^<]/i.test(html), 'no script body')
  t.is((html.match(/<script\b/gi) || []).length, 1)
  t.absent(/\son[a-z]+\s*=/i.test(html), 'no inline event handler')
  t.absent(/<form/i.test(html))
  t.absent(/style=/i.test(html))
  t.absent(/<style/i.test(html))
  t.absent(/https?:\/\//i.test(html), 'no external resource')
})

test('app.js and app.css: global line, no HTML sinks, no storage, no external resource', async (t) => {
  const src = fs.readFileSync(APP, 'utf8')
  t.is(src.split('\n')[0], '/* global document, fetch, location, history, confirm */')
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'localStorage', 'sessionStorage', 'http://', 'https://']) {
    t.absent(src.includes(bad), 'app.js has no ' + bad)
  }
  t.absent(Array.from(src).some(isRawInvisible), 'no raw control or bidi characters')
  const css = fs.readFileSync(path.join(DIR, 'app.css'), 'utf8')
  t.absent(/url\(|@import|https?:/i.test(css), 'no external resource in css')
  t.ok(/max-width:\s*32rem/.test(css))
  t.ok(/min-height:\s*44px/.test(css))
})

test('pure helpers', async (t) => {
  t.alike(panel.REASON_LABELS, { ...REASON_LABELS }, 'same labels as packages/core/lib/report.js')
  t.is(panel.reasonLabel('assedio'), 'assédio')
  t.is(panel.reasonLabel('__proto__'), 'motivo desconhecido')
  t.is(panel.formatDate('nope'), '')
  t.is(panel.formatDate(null), '')
  t.ok(panel.formatDate('2026-10-21T12:00:00.000Z').length > 0)
  t.is(panel.nextAction(401), 'login')
  t.is(panel.nextAction(200), 'ok')
  t.is(panel.nextAction(409), 'error')
  t.is(panel.shortKey(A), 'aaaaaaaa…')
  t.is(panel.who(A, 'ana'), '@ana')

  const s = panel.buildState({
    me: ME,
    open: { reports: [report(), { id: '../x' }], truncated: true },
    decided: { reports: [] },
    blocked: {
      published: { seq: 3, at: '2026-10-20T10:00:00.000Z' },
      blocked: [{ member: C, username: '', reportIds: [] }],
      pending: [
        { id: 'c1', op: 'unblock', member: C, username: '', by: 'x', at: '2026-10-22T00:00:00.000Z', reportIds: [], claimedAt: null },
        { id: 'c2', op: 'block', member: A, username: '', by: 'x', at: '2026-10-22T00:00:01.000Z', reportIds: [], claimedAt: '2026-10-22T01:00:00.000Z' }
      ]
    }
  })
  t.is(s.open.reports.length, 1, 'a row with an unusable id is dropped')
  t.is(s.open.truncated, true)
  t.is(s.published.seq, 3)
  t.is(s.net.get(C).blocked, false)
  t.is(s.net.get(A).blocked, true)
  t.is(s.net.get(A).changes[0].claimed, true)
  t.is(panel.buildState({ me: ME, blocked: { published: null, blocked: [], pending: [] } }).published.seq, 3, 'falls back to me.published')
  t.is(panel.buildState({ me: { email: 'x', published: null }, blocked: { published: null } }).published, null)
})

test('a 401 renders the login button and the mapped ?erro notice', async (t) => {
  const doc = fakeDocument()
  const { fetch, calls } = fakeFetch({ 'GET /account/mod/api/me': () => [401, { error: 'nao-autorizado' }] })
  const e = env(doc, fetch)
  e.location.search = '?erro=nao-autorizado'
  await panel.createPanel(e).start()
  t.is(calls[0].opts.credentials, 'same-origin')
  t.is(calls[0].opts.cache, 'no-store')
  t.alike(e.replaced, ['/account/mod/'], 'the query is removed')
  const login = buttons(doc, 'Entrar com Google')
  t.is(login.length, 1)
  t.ok(doc.main.textContent.includes('Esta conta Google não está na lista de moderação.'))
  login[0].click()
  t.alike(e.assigned, ['/account/mod/login'])
})

test('?erro=sem-diario asks for the Google account linked to the diary', async (t) => {
  const doc = fakeDocument()
  const { fetch } = fakeFetch({ 'GET /account/mod/api/me': () => [401, { error: 'nao-autorizado' }] })
  const e = env(doc, fetch)
  e.location.search = '?erro=sem-diario'
  await panel.createPanel(e).start()
  t.is(panel.LOGIN_ERRORS['sem-diario'], 'Entre no painel com a conta Google vinculada ao seu diário.')
  t.ok(doc.main.textContent.includes('Entre no painel com a conta Google vinculada ao seu diário.'))
  t.is(buttons(doc, 'Entrar com Google').length, 1)
})

test('an unknown ?erro value is never echoed', async (t) => {
  const doc = fakeDocument()
  const { fetch } = fakeFetch({ 'GET /account/mod/api/me': () => [401, { error: 'nao-autorizado' }] })
  const e = env(doc, fetch)
  e.location.search = '?erro=qualquer-coisa'
  await panel.createPanel(e).start()
  t.absent(doc.main.textContent.includes('qualquer-coisa'))
  t.is(buttons(doc, 'Entrar com Google').length, 1)
})

test('a hostile quote renders as inert text and creates no element', async (t) => {
  const doc = fakeDocument()
  const quote = '<script>alert(1)</script><img src=x onerror=alert(1)> ' + RLO + 'olleh' + LRI + 'x' + PDI
  const text = '<b>' + RLO + 'gnorw'
  const { fetch } = fakeFetch(signedIn([report({ quote, text, reporter: { member: B, username: '<i>' } })]))
  await panel.createPanel(env(doc, fetch)).start()
  const tags = new Set(doc.created.map((n) => n.tagName))
  for (const bad of ['SCRIPT', 'IMG', 'B', 'I', 'IFRAME', 'STYLE', 'LINK']) t.absent(tags.has(bad), 'no ' + bad + ' element')
  const nodes = walk(doc.main)
  const q = nodes.find((n) => n._text === quote)
  t.ok(q, 'the quote is one textContent value, byte for byte')
  t.is(q.tagName, 'BLOCKQUOTE')
  t.is(q.className, 'untrusted')
  t.is(q.getAttribute('dir'), 'auto')
  t.is(q.children.length, 0)
  t.ok(nodes.find((n) => n._text === text && n.className === 'untrusted'), 'the comment too')
  t.ok(doc.main.textContent.includes('denunciada por: @<i>'), 'the username is text too')
  t.ok(doc.main.textContent.includes('Texto enviado por quem denunciou, não conferido.'))
  t.absent(doc.main.textContent.includes('O servidor não abre o diário'), 'the old claim is gone')
  t.ok(doc.main.textContent.includes('O bloqueio vale para a conta inteira, incluindo suas publicações.'))
  t.ok(doc.main.textContent.includes('mod@example.org'))
})

test('decide POSTs JSON with credentials after confirm, then refetches', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([report()])
  let decided = null
  routes['POST /account/mod/api/reports/r1abcdefghijklmnopqrst/decide'] = (opts) => {
    decided = opts
    return [200, { ok: true }]
  }
  const { fetch, calls } = fakeFetch(routes)
  const asked = []
  const e = env(doc, fetch, { confirm: (q) => { asked.push(q); return true } })
  const p = panel.createPanel(e)
  await p.start()
  const textarea = walk(doc.main).find((n) => n.tagName === 'TEXTAREA')
  t.is(textarea.getAttribute('maxlength'), '280')
  textarea.value = 'spam repetido'
  buttons(doc, 'Bloquear')[0].click()
  await p.settled()
  t.ok(decided, 'decide was called')
  t.is(decided.method, 'POST')
  t.is(decided.credentials, 'same-origin')
  t.is(decided.cache, 'no-store')
  t.is(decided.headers['Content-Type'], 'application/json')
  t.alike(JSON.parse(decided.body), { decision: 'bloquear', note: 'spam repetido' })
  t.is(asked.length, 1)
  t.ok(asked[0].includes('O bloqueio vale para a conta inteira'))
  t.ok(doc.main.textContent.includes('Decisão registrada. Ela vale quando a operação assinar e publicar.'))
  t.is(calls.filter((c) => c.url === '/account/mod/api/me').length, 2, 'the queue is refetched')
})

test('a declined confirm sends nothing', async (t) => {
  const doc = fakeDocument()
  const { fetch, calls } = fakeFetch(signedIn([report()]))
  const p = panel.createPanel(env(doc, fetch, { confirm: () => false }))
  await p.start()
  const before = calls.length
  buttons(doc, 'Descartar')[0].click()
  await p.settled()
  t.is(calls.length, before)
})

test('a 401 on a later call returns to the login view', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([report()])
  routes['POST /account/mod/api/reports/r1abcdefghijklmnopqrst/decide'] = () => [401, { error: 'nao-autorizado' }]
  const { fetch } = fakeFetch(routes)
  const p = panel.createPanel(env(doc, fetch))
  await p.start()
  t.ok(p.state)
  buttons(doc, 'Descartar')[0].click()
  await p.settled()
  t.is(p.state, null, 'the state is cleared')
  t.is(buttons(doc, 'Entrar com Google').length, 1)
  t.absent(doc.main.textContent.includes('mod@example.org'), 'nothing of the old view is left')
  t.absent(doc.main.textContent.includes('oi'))
})

test('a pending block disables Bloquear; tabs show pending, blocked and history', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([report()], {
    published: { seq: 3, at: '2026-10-20T10:00:00.000Z' },
    blocked: [{ member: C, username: 'carla', reportIds: [] }],
    pending: [
      { id: 'c1', op: 'block', member: A, username: '', by: 'x', at: '2026-10-22T00:00:00.000Z', reportIds: [], claimedAt: '2026-10-22T01:00:00.000Z' }
    ]
  })
  routes['GET /account/mod/api/reports?estado=decidida'] = () => [200, { reports: [report({ id: 'r2', status: 'descartar', decidedAt: '2026-10-22T00:00:00.000Z' })], truncated: false }]
  let cancelled = null
  routes['POST /account/mod/api/pending/c1/cancel'] = (opts) => { cancelled = opts; return [200, { change: null }] }
  let unblocked = null
  routes['POST /account/mod/api/unblock'] = (opts) => { unblocked = opts; return [200, { change: null }] }
  const { fetch } = fakeFetch(routes)
  const asked = []
  const p = panel.createPanel(env(doc, fetch, { confirm: (q) => { asked.push(q); return true } }))
  await p.start()
  t.ok(doc.main.textContent.includes('aguardando assinatura do operador'))
  t.is(buttons(doc, 'Bloquear')[0].disabled, true)

  buttons(doc, 'Pendentes')[0].click()
  t.ok(doc.main.textContent.includes('As decisões só valem depois que a associação rodar `varanda mod apply` e publicar a lista.'))
  t.ok(doc.main.textContent.includes('enviada para assinatura'))
  buttons(doc, 'cancelar')[0].click()
  await p.settled()
  t.ok(asked[0].includes('a operação vai desfazer esta decisão na próxima assinatura'))
  t.is(cancelled.method, 'POST')
  t.alike(JSON.parse(cancelled.body), {})

  buttons(doc, 'Bloqueadas')[0].click()
  t.ok(doc.main.textContent.includes('última lista confirmada pela operação: nº 3'))
  t.ok(doc.main.textContent.includes('@carla'))
  buttons(doc, 'Desbloquear')[0].click()
  await p.settled()
  t.alike(JSON.parse(unblocked.body), { member: C })

  buttons(doc, 'Histórico')[0].click()
  t.ok(doc.main.textContent.includes('descartada'))
})

test('no published list and an empty queue show their fixed messages', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([], { published: null, blocked: [], pending: [] })
  routes['GET /account/mod/api/me'] = () => [200, { ...ME, published: null }]
  const { fetch } = fakeFetch(routes)
  const p = panel.createPanel(env(doc, fetch))
  await p.start()
  t.ok(doc.main.textContent.includes('Nenhuma denúncia aberta.'))
  buttons(doc, 'Bloqueadas')[0].click()
  t.ok(doc.main.textContent.includes('A lista publicada ainda não foi confirmada neste painel. A operação precisa rodar mod apply.'))
})

test('truncated queue and logout', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([report()])
  routes['GET /account/mod/api/reports?estado=aberta'] = () => [200, { reports: [report()], truncated: true }]
  let out = null
  routes['POST /account/mod/logout'] = (opts) => { out = opts; return [200, { ok: true }] }
  const { fetch } = fakeFetch(routes)
  const p = panel.createPanel(env(doc, fetch))
  await p.start()
  t.ok(doc.main.textContent.includes('Há mais denúncias depois destas.'))
  buttons(doc, 'Sair')[0].click()
  await p.settled()
  t.is(out.method, 'POST')
  t.is(out.headers['Content-Type'], 'application/json')
  t.is(p.state, null)
  t.is(buttons(doc, 'Entrar com Google').length, 1)
})

test('pageshow from the back/forward cache refetches the queue', async (t) => {
  const doc = fakeDocument()
  const { fetch, calls } = fakeFetch(signedIn([report()]))
  let onShow = null
  const p = panel.createPanel(env(doc, fetch, { onPageShow: (fn) => { onShow = fn } }))
  await p.start()
  const before = calls.length
  onShow({ persisted: true })
  await p.settled()
  t.ok(calls.length > before)
})

function textareas (doc) {
  return walk(doc.main).filter((n) => n.tagName === 'TEXTAREA')
}

function typeInto (node, value) {
  node.value = value
  for (const fn of node.listeners.input || []) fn({ type: 'input' })
}

const R1 = 'r1abcdefghijklmnopqrst'
const R2 = 'r2abcdefghijklmnopqrst'

test('a failed decide keeps the typed note and the retry sends it', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([report({ id: R1 }), report({ id: R2 })])
  const bodies = []
  let fail = true
  routes['POST /account/mod/api/reports/' + R1 + '/decide'] = (opts) => {
    bodies.push(JSON.parse(opts.body))
    return fail ? [409, { error: 'nao-encontrado' }] : [200, { report: null, change: null }]
  }
  const { fetch } = fakeFetch(routes)
  const p = panel.createPanel(env(doc, fetch))
  await p.start()
  typeInto(textareas(doc)[0], 'nota um')
  typeInto(textareas(doc)[1], 'nota dois')
  buttons(doc, 'Descartar')[0].click()
  await p.settled()
  t.ok(doc.main.textContent.includes('não encontrada'), 'the failure is shown')
  t.is(textareas(doc)[0].value, 'nota um', 'the note survives the re-render')
  t.is(textareas(doc)[1].value, 'nota dois', 'the other draft survives too')
  fail = false
  buttons(doc, 'Descartar')[0].click()
  await p.settled()
  t.alike(bodies.map((b) => b.note), ['nota um', 'nota um'], 'the retry sent the note')
})

test('a successful decide clears only that report draft', async (t) => {
  const doc = fakeDocument()
  let open = [report({ id: R1 }), report({ id: R2 })]
  const routes = signedIn(open)
  routes['GET /account/mod/api/reports?estado=aberta'] = () => [200, { reports: open, truncated: false }]
  routes['POST /account/mod/api/reports/' + R1 + '/decide'] = () => {
    open = open.filter((r) => r.id !== R1)
    return [200, { report: null, change: null }]
  }
  const { fetch } = fakeFetch(routes)
  const p = panel.createPanel(env(doc, fetch))
  await p.start()
  typeInto(textareas(doc)[0], 'nota um')
  typeInto(textareas(doc)[1], 'nota dois')
  buttons(doc, 'Descartar')[0].click()
  await p.settled()
  t.is(textareas(doc).length, 1)
  t.is(textareas(doc)[0].value, 'nota dois', 'the other report keeps its draft')
})

test('a draft is dropped when its report no longer appears, and does not return', async (t) => {
  const doc = fakeDocument()
  let open = [report({ id: R1 })]
  const routes = signedIn(open)
  routes['GET /account/mod/api/reports?estado=aberta'] = () => [200, { reports: open, truncated: false }]
  const { fetch } = fakeFetch(routes)
  let onShow = null
  const p = panel.createPanel(env(doc, fetch, { onPageShow: (fn) => { onShow = fn } }))
  await p.start()
  typeInto(textareas(doc)[0], 'velha')
  open = []
  onShow({ persisted: true })
  await p.settled()
  open = [report({ id: R1 })]
  onShow({ persisted: true })
  await p.settled()
  t.is(textareas(doc)[0].value, '', 'no stale draft comes back')
})

test('ja-revertido, expirado and defasado show fixed messages, never the token', async (t) => {
  for (const [token, msg] of [
    ['ja-revertido', 'Essa decisão já foi desfeita por outra mais recente.'],
    ['expirado', 'a sessão expirou, entre de novo'],
    ['defasado', 'a lista mudou, recarregue o painel e tente de novo'],
    ['qualquer-token', 'erro no servidor']
  ]) {
    const doc = fakeDocument()
    const routes = signedIn([], {
      published: { seq: 3, at: '2026-10-20T10:00:00.000Z' },
      blocked: [],
      pending: [{ id: 'c1', op: 'block', member: A, username: '', by: 'x', at: '2026-10-22T00:00:00.000Z', reportIds: [], claimedAt: null }]
    })
    routes['POST /account/mod/api/pending/c1/cancel'] = () => [409, { error: token }]
    const { fetch } = fakeFetch(routes)
    const p = panel.createPanel(env(doc, fetch))
    await p.start()
    buttons(doc, 'Pendentes')[0].click()
    buttons(doc, 'cancelar')[0].click()
    await p.settled()
    t.ok(doc.main.textContent.includes(msg), token)
    t.absent(doc.main.textContent.includes(token), 'token not echoed: ' + token)
  }
})

test('a pending row with claimedAt shows enviada para assinatura; without it, not', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([], {
    published: { seq: 3, at: '2026-10-20T10:00:00.000Z' },
    blocked: [],
    pending: [{ id: 'c1', op: 'block', member: A, username: '', by: 'x', at: '2026-10-22T00:00:00.000Z', reportIds: [], claimedAt: '2026-10-22T01:00:00.000Z' }]
  })
  const { fetch } = fakeFetch(routes)
  await panel.createPanel(env(doc, fetch)).start()
  buttons(doc, 'Pendentes')[0].click()
  t.ok(doc.main.textContent.includes('enviada para assinatura'))
  const doc2 = fakeDocument()
  const routes2 = signedIn([], {
    published: null,
    blocked: [],
    pending: [{ id: 'c1', op: 'block', member: A, username: '', by: 'x', at: '2026-10-22T00:00:00.000Z', reportIds: [], claimedAt: null }]
  })
  await panel.createPanel(env(doc2, fakeFetch(routes2).fetch)).start()
  buttons(doc2, 'Pendentes')[0].click()
  t.absent(doc2.main.textContent.includes('enviada para assinatura'))
})

// AI triage (report.ia, report.actor, report.publicacao, change.byAi).

function cardsOf (doc) {
  return walk(doc.main).filter((n) => n.className === 'card')
}

test('quote label no longer claims the server never opens the diary', async (t) => {
  t.is(panel.TEXT.quoteLabel, 'Texto enviado por quem denunciou, não conferido.')
  t.absent(fs.readFileSync(APP, 'utf8').includes('O servidor não abre o diário'))
})

test('pure AI helpers: comma decimal, closed reason map, fallback', async (t) => {
  t.is(panel.formatSimilarity(0.93), '0,93')
  t.is(panel.formatSimilarity(0.5), '0,50')
  t.is(panel.formatSimilarity(1.5), '')
  t.is(panel.formatSimilarity('0.9'), '')
  t.is(panel.formatSimilarity(NaN), '')
  t.is(panel.aiReasonLabel('humano-revisou'), 'esta conta tem uma mudança pendente ou uma pessoa já desfez um bloqueio dela')
  t.is(panel.aiReasonLabel('__proto__'), 'sem precedente suficiente')
  t.is(panel.aiReasonLabel('nao-existe'), 'sem precedente suficiente')
  for (const tok of ['frio', 'sem-exemplo', 'margem', 'divergente', 'conta', 'ilegal', 'contexto', 'midia', 'citacao', 'recurso', 'truncado', 'curto', 'sem-vetor', 'teto-bloquear', 'teto-descartar', 'ja-bloqueado', 'sombra', 'erro', 'timeout', 'ausente', 'recusado', 'certificado', 'config', 'humano-revisou', 'ja-decidida', 'lotado', 'exato', 'motivo', 'modelo', 'falha-ia']) {
    t.ok(Object.prototype.hasOwnProperty.call(panel.AI_REASONS, tok), 'label for ' + tok)
    t.not(panel.AI_REASONS[tok], tok, 'not the raw token: ' + tok)
  }
})

test('an AI suggestion renders one line with a comma decimal, never a percentage', async (t) => {
  const doc = fakeDocument()
  const ia = { sugestao: 'bloquear', semelhanca: 0.9312, vizinhos: 3, motivo: 'margem', modo: 'sombra' }
  const { fetch } = fakeFetch(signedIn([report({ ia, actor: null })]))
  await panel.createPanel(env(doc, fetch)).start()
  const lines = walk(doc.main).filter((n) => n.className === 'ai')
  t.is(lines.length, 1)
  t.is(lines[0].textContent, 'Sugestão da IA: bloquear (semelhança 0,93) · modo de observação: a IA só registra, não decide', 'sombra is said')
  t.absent(doc.main.textContent.includes('%'))
  t.absent(doc.main.textContent.includes('0.93'))
  t.is(buttons(doc, 'Bloquear').length, 1, 'block stays on the open card')
  t.is(buttons(doc, 'Descartar').length, 1)
})

test('an exact-match suggestion names its reason', async (t) => {
  const doc = fakeDocument()
  const ia = { sugestao: 'descartar', semelhanca: 1, vizinhos: 1, motivo: 'exato', modo: 'auto' }
  const { fetch } = fakeFetch(signedIn([report({ ia })]))
  await panel.createPanel(env(doc, fetch)).start()
  t.ok(doc.main.textContent.includes('Sugestão da IA: descartar (semelhança 1,00) · igual a um caso já decidido'))
})

test('an abstention shows its Portuguese label; an unknown token falls back and is not echoed', async (t) => {
  const doc = fakeDocument()
  const { fetch } = fakeFetch(signedIn([
    report({ id: R1, ia: { sugestao: null, semelhanca: null, vizinhos: 0, motivo: 'frio', modo: 'auto' } }),
    report({ id: R2, ia: { sugestao: 'apagar', semelhanca: 0.4, vizinhos: 0, motivo: 'xyz-token', modo: 'auto' } })
  ]))
  await panel.createPanel(env(doc, fetch)).start()
  const lines = walk(doc.main).filter((n) => n.className === 'ai').map((n) => n.textContent)
  t.alike(lines, [
    'A IA não sugeriu nada: ainda há poucas decisões para comparar',
    'A IA não sugeriu nada: sem precedente suficiente'
  ])
  t.absent(doc.main.textContent.includes('xyz-token'))
  t.absent(doc.main.textContent.includes('apagar'))
})

test('the verified post renders as text with its notes; a bad shape is ignored', async (t) => {
  const doc = fakeDocument()
  const texto = 'linha um\n<b>linha dois</b>'
  const { fetch } = fakeFetch(signedIn([
    report({ id: R1, publicacao: { texto, midia: true, citacao: true } }),
    report({ id: R2, publicacao: { texto: 'x'.repeat(1001), midia: false, citacao: false } })
  ]))
  await panel.createPanel(env(doc, fetch)).start()
  const [c1, c2] = cardsOf(doc)
  t.ok(c1.textContent.includes('Publicação lida no semeador'))
  const q = walk(c1).find((n) => n._text === texto)
  t.ok(q, 'the post is one textContent value')
  t.is(q.className, 'untrusted')
  t.is(q.children.length, 0)
  t.ok(c1.textContent.includes('A publicação tem fotos; a IA não vê imagens.'))
  t.ok(c1.textContent.includes('A publicação cita outra; confira no app.'))
  t.absent(doc.created.some((n) => n.tagName === 'B'))
  t.absent(c2.textContent.includes('Publicação lida no semeador'), 'over 1000 code points is ignored')

  for (const bad of [null, 'texto', [], { texto: 1, midia: false, citacao: false }, { texto: 'a', midia: 'sim', citacao: false }, { texto: 'a' }]) {
    const d = fakeDocument()
    await panel.createPanel(env(d, fakeFetch(signedIn([report({ publicacao: bad })])).fetch)).start()
    t.absent(d.main.textContent.includes('Publicação lida no semeador'), 'ignored: ' + JSON.stringify(bad))
  }
})

test('Histórico says pela IA or por uma pessoa, and never shows an e-mail', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([])
  routes['GET /account/mod/api/reports?estado=decidida'] = () => [200, {
    reports: [
      report({ id: R1, status: 'bloquear', actor: 'ia', decidedBy: null, decidedAt: '2026-10-22T00:00:00.000Z', publicacao: { texto: 'lido', midia: false, citacao: false } }),
      report({ id: R2, status: 'descartar', actor: 'pessoa', decidedAt: '2026-10-22T00:00:00.000Z' }),
      report({ id: 'r3abcdefghijklmnopqrst', status: 'descartar', decidedAt: '2026-10-22T00:00:00.000Z' })
    ],
    truncated: false
  }]
  const { fetch } = fakeFetch(routes)
  await panel.createPanel(env(doc, fetch)).start()
  buttons(doc, 'Histórico')[0].click()
  const cards = cardsOf(doc)
  t.is(cards.length, 3)
  t.ok(cards[0].textContent.includes(' · pela IA'))
  t.ok(cards[0].textContent.includes('Publicação lida no semeador'))
  t.ok(cards[1].textContent.includes(' · por uma pessoa'))
  t.ok(cards[2].textContent.includes(' · por uma pessoa'), 'a missing actor on a decided report is a person')
  for (const c of cards) t.absent(c.textContent.includes('@'), 'no e-mail or handle in a history card')
  t.is(buttons(doc, 'Bloquear').length, 0, 'no decision buttons in history')
  t.is(buttons(doc, 'Descartar').length, 0)
})

test('Histórico: mostrar mais appends the next page without reading the other lists again', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([])
  const row = (id) => report({ id, status: 'descartar', decidedAt: '2026-10-22T00:00:00.000Z' })
  routes['GET /account/mod/api/reports?estado=decidida'] = () => [200, { reports: [row('d1abcdefghijklmnopqrst'), row('d2abcdefghijklmnopqrst')], truncated: true }]
  routes['GET /account/mod/api/reports?estado=decidida&antes=d2abcdefghijklmnopqrst'] = () => [200, { reports: [row('d2abcdefghijklmnopqrst'), row('d3abcdefghijklmnopqrst')], truncated: false }]
  const { fetch, calls } = fakeFetch(routes)
  const p = panel.createPanel(env(doc, fetch))
  await p.start()
  buttons(doc, 'Histórico')[0].click()
  t.is(cardsOf(doc).length, 2)
  t.ok(doc.main.textContent.includes('Há mais decisões antes destas.'))
  const before = calls.length
  buttons(doc, 'mostrar mais')[0].click()
  await p.settled()
  t.is(cardsOf(doc).length, 3, 'a repeated row is not shown twice')
  t.absent(doc.main.textContent.includes('Há mais decisões antes destas.'))
  t.is(buttons(doc, 'mostrar mais').length, 0, 'no button on the last page')
  t.alike(calls.slice(before).map((c) => c.url), ['/account/mod/api/reports?estado=decidida&antes=d2abcdefghijklmnopqrst'])
})

test('Histórico: a failed mostrar mais keeps the rows and shows the error', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([])
  routes['GET /account/mod/api/reports?estado=decidida'] = () => [200, { reports: [report({ id: 'd1abcdefghijklmnopqrst', status: 'descartar', decidedAt: '2026-10-22T00:00:00.000Z' })], truncated: true }]
  routes['GET /account/mod/api/reports?estado=decidida&antes=d1abcdefghijklmnopqrst'] = () => [400, { error: 'pedido-invalido' }]
  const { fetch } = fakeFetch(routes)
  const p = panel.createPanel(env(doc, fetch))
  await p.start()
  buttons(doc, 'Histórico')[0].click()
  buttons(doc, 'mostrar mais')[0].click()
  await p.settled()
  t.is(cardsOf(doc).length, 1)
  t.ok(doc.main.textContent.includes('pedido inválido'))
  t.is(buttons(doc, 'mostrar mais')[0].disabled, false, 'it can be tried again')
})

test('Pendentes marks a change requested by the AI; cancel still undoes it', async (t) => {
  const doc = fakeDocument()
  const routes = signedIn([], {
    published: { seq: 3, at: '2026-10-20T10:00:00.000Z' },
    blocked: [],
    pending: [
      { id: 'c1', op: 'block', member: A, username: '', by: null, byAi: true, at: '2026-10-22T00:00:00.000Z', reportIds: [], claimedAt: null },
      { id: 'c2', op: 'block', member: C, username: '', by: 'x', at: '2026-10-22T00:00:00.000Z', reportIds: [], claimedAt: null }
    ]
  })
  let cancelled = false
  routes['POST /account/mod/api/pending/c1/cancel'] = () => { cancelled = true; return [200, { change: null }] }
  const { fetch } = fakeFetch(routes)
  const p = panel.createPanel(env(doc, fetch))
  await p.start()
  buttons(doc, 'Pendentes')[0].click()
  const [ca, cc] = cardsOf(doc)
  t.ok(ca.textContent.includes('pedido pela IA'))
  t.absent(cc.textContent.includes('pedido pela IA'), 'missing byAi is false')
  buttons(doc, 'cancelar')[0].click()
  await p.settled()
  t.ok(cancelled)
})

test('old fixtures without the AI fields render unchanged', async (t) => {
  const doc = fakeDocument()
  const { fetch } = fakeFetch(signedIn([report()]))
  const p = panel.createPanel(env(doc, fetch))
  await p.start()
  t.is(walk(doc.main).filter((n) => n.className === 'ai' || n.className === 'verified').length, 0)
  t.absent(doc.main.textContent.includes('IA'))
  t.absent(doc.main.textContent.includes('semeador'))
  t.is(p.state.open.reports[0].actor, null, 'an open report has no actor')
  t.is(p.state.open.reports[0].ai, null)
  t.is(p.state.open.reports[0].verified, null)
})
