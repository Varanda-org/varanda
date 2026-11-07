'use strict'

// The in-app web node (apps/app/worklet) runs this session inside Bare, whose
// WebCrypto has no HKDF. The session takes the worklet's HKDF for every key
// derived from the PRF of setKeyPair; without it the direct message store
// stayed locked and the app listed no conversation.
const test = require('brittle')
const net = require('net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const nodeCrypto = require('crypto')
const { WebSocket } = require('ws')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { hkdfSha256 } = require('../lib/hkdf')
const { connectClient } = require('./helpers/session')

const LOCKED = 'identidade bloqueada: entre com a passkey'

const injectedHkdf = (ikm, salt, info, length) => hkdfSha256(ikm, salt, info, length, {
  hmac: (k, d) => new Uint8Array(nodeCrypto.createHmac('sha256', k).update(d).digest())
})

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// WebCrypto as Bare has it: no HKDF import. Restored on teardown.
function withoutWebCryptoHkdf (t) {
  const subtle = globalThis.crypto.subtle
  const importKey = subtle.importKey
  subtle.importKey = function (format, data, algorithm, ...rest) {
    const name = typeof algorithm === 'string' ? algorithm : algorithm && algorithm.name
    if (name === 'HKDF') return Promise.reject(new Error('HKDF indisponível'))
    return importKey.call(this, format, data, algorithm, ...rest)
  }
  t.teardown(() => { subtle.importKey = importKey })
}

async function lockedOrList (t, options) {
  const port = await deadPort()
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: b4a.toString(generateAssociationKeyPair().publicKey, 'hex'),
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: () => {},
    writeGate: false,
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: new Uint8Array(nodeCrypto.randomBytes(32)) })
  const web = await connectClient(node)
  await web.request('identity.create')
  return web.request('dm.list', { folder: 'inbox' }).then((r) => r, (err) => err)
}

test('without WebCrypto HKDF, the injected hkdf unlocks the direct messages', async (t) => {
  withoutWebCryptoHkdf(t)
  const out = await lockedOrList(t, { hkdf: injectedHkdf })
  t.is(out instanceof Error ? out.message : null, null, 'dm.list answers')
  t.alike(out.conversations, [])
})

test('without WebCrypto HKDF and no injected hkdf, the direct messages stay locked', async (t) => {
  withoutWebCryptoHkdf(t)
  const err = await lockedOrList(t, {})
  t.is(err.message, LOCKED)
})

test('the injected hkdf is not needed where WebCrypto has HKDF', async (t) => {
  const out = await lockedOrList(t, {})
  t.alike(out.conversations, [])
})
