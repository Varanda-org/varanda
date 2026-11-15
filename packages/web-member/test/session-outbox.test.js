'use strict'

// outbox.seal / outbox.open (docs/rpc.md 5.124 and 5.125) on the browser
// session: the key follows the identity, and a lock forgets it.
const test = require('brittle')
const net = require('net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const nodeCrypto = require('crypto')
const { WebSocket } = require('ws')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { createBrowserSession } = require('../lib/session')
const { memoryNodeStorage } = require('../lib/node-storage')
const { outboxKeyFromPrf, OUTBOX_HKDF_INFO } = require('../lib/passkey')
const { openOutbox } = require('../lib/outbox-seal')
const { connectClient, errorOf } = require('./helpers/session')

const LOCKED = 'identidade bloqueada: entre com a passkey'
const WRONG_AUTHOR = 'item da fila de saída de outra identidade'
const BAD_BOX = 'item da fila de saída inválido'

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function setup (t) {
  const port = await deadPort()
  const association = b4a.toString(generateAssociationKeyPair().publicKey, 'hex')
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: () => {},
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  const web = await connectClient(node)
  return { node, web, association }
}

const prf = () => new Uint8Array(nodeCrypto.randomBytes(32))

function itemOf (pair, association) {
  return {
    id: '0123456789abcdef',
    author: b4a.toString(pair.publicKey, 'hex'),
    association,
    kind: 'post',
    to: null,
    text: 'escrito sem conexão',
    writtenAt: '2026-11-15T12:00:00.000Z'
  }
}

const openParams = (box, { to, text, ...rest }) => ({ box, ...rest })

async function refused (t, p, message, label) {
  const err = await errorOf(p)
  t.is(err && err.code, 'USAGE', label)
  t.is(err && err.message, message, label)
}

test('seal and open on the unlocked identity', async (t) => {
  const { node, web, association } = await setup(t)
  const pair = crypto.keyPair()
  await node.setKeyPair(pair, { prf: prf() })
  const item = itemOf(pair, association)
  const { box } = await web.request('outbox.seal', item)
  t.is(typeof box, 'string')
  t.absent(box.includes('conexão'))
  t.alike(await web.request('outbox.open', openParams(box, item)), { to: null, text: item.text })
  const reply = { ...item, kind: 'reply', to: b4a.toString(pair.publicKey, 'hex') + ':3' }
  const r = await web.request('outbox.seal', reply)
  t.alike(await web.request('outbox.open', openParams(r.box, reply)), { to: reply.to, text: reply.text })
  await refused(t, web.request('outbox.open', openParams(r.box, { ...reply, id: 'fedcba9876543210' })), BAD_BOX, 'another id')
  await refused(t, web.request('outbox.open', openParams(box, { ...item, writtenAt: '2026-11-15T12:00:01.000Z' })), BAD_BOX, 'another writtenAt')
  await refused(t, web.request('outbox.open', openParams('AAAA' + box.slice(4), item)), BAD_BOX, 'a changed nonce')
})

test('locked before any unlock, and without the PRF', async (t) => {
  const { node, web, association } = await setup(t)
  const pair = crypto.keyPair()
  const item = itemOf(pair, association)
  await refused(t, web.request('outbox.seal', item), LOCKED, 'seal before unlock')
  await refused(t, web.request('outbox.open', openParams('AAAAAAAA', item)), LOCKED, 'open before unlock')
  await node.setKeyPair(pair)
  await refused(t, web.request('outbox.seal', item), LOCKED, 'seal with no PRF')
})

test('another author is refused before anything is opened', async (t) => {
  const { node, web, association } = await setup(t)
  const pair = crypto.keyPair()
  await node.setKeyPair(pair, { prf: prf() })
  const item = itemOf(pair, association)
  const { box } = await web.request('outbox.seal', item)
  const other = { ...item, author: b4a.toString(crypto.keyPair().publicKey, 'hex') }
  await refused(t, web.request('outbox.seal', other), WRONG_AUTHOR, 'seal')
  await refused(t, web.request('outbox.open', openParams(box, other)), WRONG_AUTHOR, 'open')
  await refused(t, web.request('outbox.open', openParams('AAAAAAAA', other)), WRONG_AUTHOR, 'open of a bad box')
})

test('a lock forgets the key: the same identity under another PRF cannot open', async (t) => {
  const { node, web, association } = await setup(t)
  const pair = crypto.keyPair()
  const first = prf()
  await node.setKeyPair(pair, { prf: first })
  const item = itemOf(pair, association)
  const { box } = await web.request('outbox.seal', item)

  await node.clearKeyPair()
  await refused(t, web.request('outbox.open', openParams(box, item)), LOCKED, 'open after lock')
  await refused(t, web.request('outbox.seal', item), LOCKED, 'seal after lock')

  await node.setKeyPair(pair, { prf: prf() })
  await refused(t, web.request('outbox.open', openParams(box, item)), BAD_BOX, 'a cached key would still open it')

  await node.setKeyPair(pair, { prf: first })
  t.alike(await web.request('outbox.open', openParams(box, item)), { to: null, text: item.text }, 'the same PRF opens it again')

  await node.reset()
  await refused(t, web.request('outbox.open', openParams(box, item)), LOCKED, 'open after reset')
  await node.setKeyPair(pair, { prf: prf() })
  await refused(t, web.request('outbox.open', openParams(box, item)), BAD_BOX, 'reset forgot the key too')
})

test('the session lists both methods; the key never appears in a result', async (t) => {
  const session = createBrowserSession({
    storage: memoryNodeStorage(),
    association: 'cd'.repeat(32),
    seederUrl: 'ws://127.0.0.1:1/seeder',
    createSocket: () => { throw new Error('no network in this test') },
    onInternalError: () => {}
  })
  t.teardown(() => session.close())
  t.is(typeof session.handlers['outbox.seal'], 'function')
  t.is(typeof session.handlers['outbox.open'], 'function')
  const pair = crypto.keyPair()
  const p = prf()
  await session.setKeyPair(pair, { prf: p })
  const item = itemOf(pair, 'cd'.repeat(32))
  const sealed = await session.handlers['outbox.seal'](item)
  t.alike(Object.keys(sealed), ['box'])
  const opened = await session.handlers['outbox.open'](openParams(sealed.box, item))
  t.alike(Object.keys(opened).sort(), ['text', 'to'])
  const hex = b4a.toString(p, 'hex')
  t.absent(JSON.stringify([sealed, opened]).includes(hex), 'no PRF in the results')
})

// A session whose outbox derivation waits for `release()`; every other HKDF
// (group box keys on unlock) runs at once.
function heldSession (t) {
  let gate = null
  const hkdf = async (ikm, salt, info, length) => {
    if (gate !== null && b4a.equals(info, OUTBOX_HKDF_INFO)) {
      const wait = gate.promise
      gate.started()
      await wait
    }
    return new Uint8Array(nodeCrypto.hkdfSync('sha256', ikm, salt, info, length))
  }
  const session = createBrowserSession({
    storage: memoryNodeStorage(),
    association: 'cd'.repeat(32),
    seederUrl: 'ws://127.0.0.1:1/seeder',
    createSocket: () => { throw new Error('no network in this test') },
    onInternalError: () => {},
    hkdf
  })
  t.teardown(() => session.close())
  // Holds the next outbox derivation: `waiting` settles once it waits.
  const held = () => {
    let release = null
    const promise = new Promise((resolve) => { release = resolve })
    let started = null
    const waiting = new Promise((resolve) => { started = resolve })
    gate = { promise, started }
    return { waiting, release: () => { gate = null; release() } }
  }
  return { session, held }
}

// What the box opens to under the key of `p` (null when it does not open).
async function openedUnder (box, p, item) {
  const key = await outboxKeyFromPrf(p)
  try {
    return openOutbox(key, box, openParams(box, item))
  } catch {
    return null
  } finally {
    key.fill(0)
  }
}

// The box opens under the key of `p`: the session sealed with that key.
async function sealedUnder (t, box, p, item, label) {
  t.alike(await openedUnder(box, p, item), { to: null, text: item.text }, label)
}

test('a lock and a new unlock during the outbox derivation: LOCKED, the stale key is not kept', async (t) => {
  const { session, held } = heldSession(t)
  const pair = crypto.keyPair()
  const first = prf()
  await session.setKeyPair(pair, { prf: first })
  const item = itemOf(pair, 'cd'.repeat(32))
  const gate = held()
  const p = errorOf(session.handlers['outbox.seal'](item))
  await gate.waiting
  await session.clearKeyPair()
  const second = prf()
  await session.setKeyPair(pair, { prf: second })
  gate.release()
  const err = await p
  t.is(err && err.code, 'USAGE')
  t.is(err && err.message, LOCKED, 'the derivation straddled a lock')
  const { box } = await session.handlers['outbox.seal'](item)
  await sealedUnder(t, box, second, item, 'sealed under the PRF unlocked now')
  t.is(await openedUnder(box, first, item), null, 'not under the PRF derived before the lock')
})

test('an identity switch during the outbox derivation: refused, the previous key is not kept', async (t) => {
  const { session, held } = heldSession(t)
  const pair = crypto.keyPair()
  await session.setKeyPair(pair, { prf: prf() })
  const item = itemOf(pair, 'cd'.repeat(32))
  const gate = held()
  const p = errorOf(session.handlers['outbox.seal'](item))
  await gate.waiting
  const other = crypto.keyPair()
  const otherPrf = prf()
  await session.setKeyPair(other, { prf: otherPrf })
  gate.release()
  const err = await p
  t.is(err && err.code, 'USAGE')
  t.is(err && err.message, WRONG_AUTHOR, 'the caller is no longer the unlocked identity')
  const mine = itemOf(other, 'cd'.repeat(32))
  const { box } = await session.handlers['outbox.seal'](mine)
  await sealedUnder(t, box, otherPrf, mine, 'sealed under the new identity\'s PRF')
})

test('an identity switch and back during the outbox derivation: LOCKED, no key kept', async (t) => {
  const { session, held } = heldSession(t)
  const pair = crypto.keyPair()
  await session.setKeyPair(pair, { prf: prf() })
  const item = itemOf(pair, 'cd'.repeat(32))
  const gate = held()
  const p = errorOf(session.handlers['outbox.seal'](item))
  await gate.waiting
  await session.setKeyPair(crypto.keyPair(), { prf: prf() })
  const back = prf()
  await session.setKeyPair(pair, { prf: back })
  gate.release()
  const err = await p
  t.is(err && err.code, 'USAGE')
  t.is(err && err.message, LOCKED, 'the derivation straddled two identity changes')
  const { box } = await session.handlers['outbox.seal'](item)
  await sealedUnder(t, box, back, item, 'sealed under the PRF unlocked now')
})
