// Test helpers for the browser node: the in-memory client side, wired to a
// lib/node.js node exactly as apps/app src/client/browser.js wires it (JSON
// text both ways, delivered on a microtask), plus a recorder of the events.
const { createClient, parseMessage, EVENTS, MAX_MESSAGE } = require('@varanda/rpc')

async function connectClient (node, { timeoutMs } = {}) {
  const events = []
  let port = null
  const client = createClient({
    send: (message, text) => queueMicrotask(() => { if (port !== null) port.receive(text) }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  })
  port = node.connect((text) => queueMicrotask(() => {
    const parsed = parseMessage(text, MAX_MESSAGE)
    if (parsed.ok) client.receive(parsed.value)
  }), { onClose: () => client.close() })
  for (const name of EVENTS) client.on(name, (data) => events.push({ name, data }))
  await client.request('session.open', {})
  return { client, port, events, request: (method, params = {}) => client.request(method, params) }
}

// Resolves with the sync.stopped data of runId (polls the recorded events).
async function stoppedOf (events, runId, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ev = events.find((e) => e.name === 'sync.stopped' && e.data.runId === runId)
    if (ev) return ev.data
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('tempo esgotado: sync.stopped ' + runId)
}

// The error a promise rejects with (or null when it resolves).
function errorOf (p) {
  return p.then(() => null, (err) => err)
}

module.exports = { connectClient, stoppedOf, errorOf }
