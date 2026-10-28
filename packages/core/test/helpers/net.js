'use strict'

// In-process hyperdht testnet for core tests (same rules as
// apps/cli/test/helpers/net.js): every DHT binds loopback only and the public
// DHT is never touched. The testnet is destroyed by a forced teardown with
// order Infinity, after the tests' own closes (order 0) and the tmp-dir
// removal (100). until() polls a predicate with a deadline. newSession and
// connect drive a node session (lib/session.js) through a real @varanda/rpc
// dispatcher + client pair wired in memory.
const TIMED_OUT = Symbol('timed out')

async function testnet (t, size = 3) {
  const raw = await require('hyperdht/testnet')(size)
  const bootstrap = raw.bootstrap.map(({ host, port }) => {
    const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    return h + ':' + port
  })
  t.teardown(() => raw.destroy(), { order: Infinity, force: true })
  return { bootstrap, raw }
}

function localSwarmOptions (bootstrap) {
  return { bootstrap, host: '127.0.0.1' }
}

// Polls predicate (sync or async) until it returns a truthy value; rejects
// with Error('tempo esgotado: ' + name) at the deadline, and at once when
// the predicate throws.
async function until (predicate, { timeoutMs = 15000, intervalMs = 25, name = 'condição' } = {}) {
  const deadline = Date.now() + timeoutMs
  const timeoutError = () => new Error('tempo esgotado: ' + name)
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw timeoutError()
    let timer
    const expired = new Promise((resolve) => {
      timer = setTimeout(resolve, remaining, TIMED_OUT)
    })
    const attempt = Promise.resolve().then(predicate)
    let result
    try {
      result = await Promise.race([attempt, expired])
    } finally {
      clearTimeout(timer)
    }
    if (result === TIMED_OUT) {
      attempt.catch(() => {})
      throw timeoutError()
    }
    if (result) return result
    const wait = Math.min(intervalMs, deadline - Date.now())
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

// ---- node session over an in-memory RPC link ----

// Drives a node session through a real @varanda/rpc dispatcher + client pair
// wired in memory, so every request, response and event crosses the
// contract's validation exactly as over IPC or the WebSocket. Every text the
// server sends is recorded in `wire` for the path-leak scan.
const wire = []

function newSession (t, opts) {
  const { createSession } = require('../../lib/session')
  const internal = []
  const session = createSession({
    onInternalError: (err) => internal.push(err),
    ...opts
  })
  t.teardown(() => session.close(), { force: true })
  session.internal = internal
  return session
}

async function connect (t, session) {
  const { createServerDispatcher, createClient, EVENTS } = require('@varanda/rpc')
  let client = null
  const protocolErrors = []
  const dispatcher = createServerDispatcher({
    handlers: session.handlers,
    send: (message, text) => {
      wire.push(text)
      queueMicrotask(() => client.receive(JSON.parse(text)))
    },
    onProtocolError: (e) => protocolErrors.push(e)
  })
  client = createClient({
    send: (message, text) => queueMicrotask(() => dispatcher.receive(JSON.parse(text))),
    timeoutMs: 90000
  })
  const events = []
  for (const name of EVENTS) client.on(name, (data) => events.push({ event: name, data }))
  session.attach(dispatcher.emit)
  t.teardown(() => {
    client.close()
    dispatcher.close()
  }, { force: true })
  await client.request('session.open')
  const call = (method, params) => client.request(method, params)
  return { client, dispatcher, events, call, protocolErrors }
}

// The { code, message } of a rejected request, or null when it resolved.
async function failure (promise) {
  try {
    await promise
  } catch (err) {
    return { code: err.code, message: err.message }
  }
  return null
}

// No server text of the file carries the temp root or a '/'.
function scanWire (t, root) {
  t.ok(wire.length > 0, 'messages were recorded (' + wire.length + ')')
  // A media mime (a profile avatar's 'image/webp') is the one '/' allowed.
  const mime = /"mime":"image\/(?:jpeg|png|webp|gif)"/g
  const leaks = wire.filter((text) => text.includes(root) || text.replace(mime, '').includes('/'))
  t.alike(leaks, [], 'no response or event carries a path')
}

module.exports = { testnet, localSwarmOptions, until, newSession, connect, failure, scanWire, wire }
