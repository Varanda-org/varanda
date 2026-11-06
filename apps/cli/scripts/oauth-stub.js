'use strict'

// A stand-in for apps/cli/lib/account/google.js in the hosted lab
// (scripts/hosted-lab.js): the same { authorizeUrl, exchange } contract that
// createAccountServer takes, with no Google at all. The authorize page,
// served on its own loopback listener, offers three lab people; each one
// answers a distinct sub ('lab-<n>') and e-mail ('lab<n>@example.test'),
// because store.js refuses one sub linked to two members ('conta-vinculada').
// The PKCE challenge is still checked at the exchange and every code is used
// once, so the account service's own flow runs as it does against Google.
// Lab only: nothing here is wired into the CLI.

const http = require('node:http')
const nodeCrypto = require('node:crypto')

const PEOPLE = [1, 2, 3]
const CODE_TTL_MS = 120 * 1000
const MAX_CODES = 100
const PARAM_RE = /^[A-Za-z0-9_-]{1,256}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const REFUSED = Object.freeze({ ok: false })

function base64url (buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function challengeOf (verifier) {
  return base64url(nodeCrypto.createHash('sha256').update(verifier).digest())
}

function escapeHtml (text) {
  return String(text).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';')
}

function personOf (n) {
  return { sub: 'lab-' + n, email: 'lab' + n + '@example.test' }
}

// createOAuthStub({ redirectUri, now }) -> { authorizeUrl, exchange,
// listen({ host, port }) -> Promise<{ host, port, url, close }>, people }.
// redirectUri is the account service's callback (origin + '/account/callback').
function createOAuthStub ({ redirectUri, now = Date.now } = {}) {
  if (typeof redirectUri !== 'string' || !/^https?:\/\/[^/]+\/account\/callback$/.test(redirectUri)) {
    throw new TypeError('redirectUri inválido')
  }
  const codes = new Map()
  let base = null

  function sweep () {
    const t = now()
    for (const [code, entry] of codes) if (entry.expires <= t) codes.delete(code)
  }

  function authorizeUrl ({ state, codeChallenge } = {}) {
    if (base === null) throw new Error('oauth-stub: listen first')
    if (typeof state !== 'string' || state.length === 0) throw new Error('oauth-stub: state ausente')
    if (typeof codeChallenge !== 'string' || codeChallenge.length === 0) throw new Error('oauth-stub: code_challenge ausente')
    const url = new URL(base + '/authorize')
    url.search = new URLSearchParams({ state, code_challenge: codeChallenge }).toString()
    return url.toString()
  }

  async function exchange ({ code, codeVerifier } = {}) {
    if (typeof code !== 'string' || typeof codeVerifier !== 'string' || codeVerifier.length === 0) return REFUSED
    sweep()
    const entry = codes.get(code)
    if (entry === undefined) return REFUSED
    codes.delete(code)
    if (challengeOf(codeVerifier) !== entry.challenge) return REFUSED
    return { ok: true, ...personOf(entry.person) }
  }

  function page (state, challenge) {
    const items = PEOPLE.map((n) => {
      const q = new URLSearchParams({ state, code_challenge: challenge, person: String(n) }).toString()
      return '<li><a href="/choose?' + escapeHtml(q) + '">Pessoa ' + n + '</a> (' + escapeHtml(personOf(n).email) + ')</li>'
    }).join('')
    return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Laboratório Varanda</title></head><body><h1>Entrar no laboratório</h1>' +
      '<p>Escolha quem você é neste teste. Nenhuma conta Google é usada.</p><ul>' + items + '</ul></body></html>'
  }

  function handle (req, res) {
    // The stub runs inside the lab's process: a request target URL cannot
    // parse (e.g. '//[/') must answer 400, not throw and stop the whole lab.
    let url
    try {
      url = new URL(req.url, 'http://stub')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('pedido inválido')
    }
    const state = url.searchParams.get('state')
    const challenge = url.searchParams.get('code_challenge')
    if (req.method !== 'GET' || !PARAM_RE.test(state || '') || !PARAM_RE.test(challenge || '')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('pedido inválido')
    }
    if (url.pathname === '/authorize') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(page(state, challenge))
    }
    const person = Number(url.searchParams.get('person'))
    if (url.pathname === '/choose' && PEOPLE.includes(person)) {
      sweep()
      if (codes.size >= MAX_CODES) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('ocupado')
      }
      const code = base64url(nodeCrypto.randomBytes(24))
      codes.set(code, { challenge, person, expires: now() + CODE_TTL_MS })
      const to = new URL(redirectUri)
      to.search = new URLSearchParams({ state, code }).toString()
      res.writeHead(302, { location: to.toString(), 'cache-control': 'no-store' })
      return res.end()
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('não encontrado')
  }

  function listen ({ host = '127.0.0.1', port = 0 } = {}) {
    if (!LOOPBACK_HOSTS.has(host)) throw new TypeError('oauth-stub: só 127.0.0.1 ou localhost')
    const server = http.createServer(handle)
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        const bound = server.address().port
        base = 'http://' + host + ':' + bound
        const close = () => new Promise((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
        resolve({ host, port: bound, url: base, close })
      })
    })
  }

  return { authorizeUrl, exchange, listen, people: PEOPLE.map(personOf) }
}

module.exports = { createOAuthStub, challengeOf }
