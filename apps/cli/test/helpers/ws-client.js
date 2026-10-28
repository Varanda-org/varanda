'use strict'

// A scripted WebSocket client for the varanda-serve tests: it sends requests,
// waits for responses, events and the close, and records everything the
// server said (also into server.seen, which the tests check for the token).

const WebSocket = require('ws')

const WAIT_MS = 15000

function withTimeout (promise, name, timeoutMs = WAIT_MS) {
  let timer
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(reject, timeoutMs, new Error('tempo esgotado: ' + name))
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

function connect (server, origin) {
  const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/rpc', { origin })
  const client = { ws, messages: [], waiting: new Map(), answers: new Map(), listeners: new Set(), nextId: 1, closed: null }
  client.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  ws.on('error', () => {})
  ws.on('message', (data) => {
    const text = data.toString()
    server.seen.push(text)
    const msg = JSON.parse(text)
    client.messages.push(msg)
    if (msg.id !== undefined && client.waiting.has(msg.id)) {
      client.waiting.get(msg.id)(msg)
      client.waiting.delete(msg.id)
    }
    for (const listener of [...client.listeners]) listener(msg)
  })
  client.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('unexpected-response', (req, res) => reject(new Error('status ' + res.statusCode)))
    ws.once('error', reject)
  })

  // Sends a request without waiting; response(id) resolves it.
  client.send = (method, params = {}) => {
    const id = client.nextId++
    client.answers.set(id, new Promise((resolve) => client.waiting.set(id, resolve)))
    ws.send(JSON.stringify({ v: 1, id, method, params }))
    return id
  }
  client.response = (id) => withTimeout(client.answers.get(id), 'resposta ' + id)
  client.call = (method, params = {}) => client.response(client.send(method, params))

  // The first event with this name (and passing match) already received or
  // still to come, in order of arrival.
  client.event = (name, match = () => true) => {
    const seen = client.messages.find((msg) => msg.event === name && match(msg.data))
    if (seen) return Promise.resolve(seen)
    return withTimeout(new Promise((resolve) => {
      const listener = (msg) => {
        if (msg.event !== name || !match(msg.data)) return
        client.listeners.delete(listener)
        resolve(msg)
      }
      client.listeners.add(listener)
    }), 'evento ' + name)
  }
  client.events = (name) => client.messages.filter((msg) => msg.event === name)
  return client
}

async function openSession (server, origin) {
  const c = connect(server, origin)
  await c.opened
  const r = await c.call('session.open', { token: server.token })
  return { c, r }
}

module.exports = { connect, openSession }
