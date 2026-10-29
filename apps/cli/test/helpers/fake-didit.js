'use strict'

// Loopback fake of the Didit verification API, shared by the client, route and
// end-to-end tests. Nothing here touches the network: the server listens on
// 127.0.0.1 port 0 and loopbackFetch refuses every URL outside it.
//
// const fake = await startFakeDidit()
//   fake.base     'http://127.0.0.1:<port>', pass as endpoints.base
//   fake.seen     every request, in order: { method, path, headers, body }
//                 (body is the parsed JSON when it parses, else the raw string)
//   fake.script(handlers)
//                 replaces the routes. `handlers` is either a function
//                 (req, res, ctx) or a map with any of:
//                   create   POST   /v3/session/
//                   decision GET    /v3/session/:id/decision/
//                   remove   DELETE /v3/session/:id/delete/
//                 each called as (req, res, ctx) with ctx = { id, body, json }.
//                 ctx.json(res, code, obj) writes a JSON response. A map only
//                 replaces the routes it names; unknown paths answer 404.
//   fake.sessions Map of session id -> decision JSON used by the default
//                 decision route (default: { status: 'Not Started' }).
//   fake.close()  closes the server and its connections.
//
// Defaults: create answers 201 with a fresh session id and a hosted https url
// (plus a session_token the client must drop); decision answers from
// fake.sessions; remove answers 200 and forgets the session.
//
// loopbackFetch(base) returns a fetch that throws for any URL not under base.

const http = require('node:http')
const crypto = require('node:crypto')

const SESSION_TOKEN = 'tok-fake-didit-session-token'
const DECISION_RE = /^\/v3\/session\/([^/]+)\/decision\/$/
const DELETE_RE = /^\/v3\/session\/([^/]+)\/delete\/$/

function json (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

async function startFakeDidit () {
  const seen = []
  const sessions = new Map()
  let counter = 0

  const defaults = {
    create (req, res, ctx) {
      const id = 'sess-' + (++counter) + '-' + crypto.randomBytes(4).toString('hex')
      sessions.set(id, { status: 'Not Started' })
      json(res, 201, {
        session_id: id,
        session_number: counter,
        session_token: SESSION_TOKEN,
        url: 'https://verify.didit.test/session/' + id,
        status: 'Not Started'
      })
    },
    decision (req, res, ctx) {
      if (!sessions.has(ctx.id)) return json(res, 404, { detail: 'Not found.' })
      json(res, 200, { session_id: ctx.id, ...sessions.get(ctx.id) })
    },
    remove (req, res, ctx) {
      if (!sessions.has(ctx.id)) return json(res, 404, { detail: 'Not found.' })
      sessions.delete(ctx.id)
      json(res, 200, {})
    }
  }
  let routes = { ...defaults }
  let handler = null

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = raw
      try { body = JSON.parse(raw) } catch {}
      const path = new URL(req.url, 'http://127.0.0.1').pathname
      seen.push({ method: req.method, path, headers: req.headers, body })
      const ctx = { id: null, body, json }
      if (handler) return handler(req, res, ctx)
      if (req.method === 'POST' && path === '/v3/session/') return routes.create(req, res, ctx)
      let m = DECISION_RE.exec(path)
      if (req.method === 'GET' && m) {
        ctx.id = decodeURIComponent(m[1])
        return routes.decision(req, res, ctx)
      }
      m = DELETE_RE.exec(path)
      if (req.method === 'DELETE' && m) {
        ctx.id = decodeURIComponent(m[1])
        return routes.remove(req, res, ctx)
      }
      res.writeHead(404).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port

  function script (handlers) {
    if (typeof handlers === 'function') {
      handler = handlers
      return
    }
    handler = null
    routes = { ...defaults, ...(handlers || {}) }
  }

  function close () {
    return new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }

  return { base, seen, sessions, script, close }
}

// A fetch that refuses any origin other than the fake, so a wrong default can
// never reach the real network.
function loopbackFetch (base) {
  return (url, init) => {
    if (!String(url).startsWith(base + '/')) throw new Error('non-loopback request')
    return globalThis.fetch(url, init)
  }
}

module.exports = { startFakeDidit, loopbackFetch, SESSION_TOKEN }
