'use strict'

// block.list and mute.list on the browser node answer off the serial chain,
// behind every block or mute write that arrived before them (lib/session.js
// listWrite). Loopback only.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const seenBlob = require('@varanda/core/lib/seen-blob')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { createBrowserSession } = require('../lib/session')
const { memoryNodeStorage } = require('../lib/node-storage')
const { connectClient, errorOf } = require('./helpers/session')
const ops = require('../lib/member-ops')

const hex = (buf) => b4a.toString(buf, 'hex')
const X = 'ab'.repeat(32)
const Y = 'cd'.repeat(32)
const Z = 'ef'.repeat(32)

async function sessionNode (t, { timeoutMs = 60000 } = {}) {
  const assoc = generateAssociationKeyPair()
  const keyPair = crypto.keyPair()
  const storage = memoryNodeStorage()
  const association = hex(assoc.publicKey)
  const key = hex(keyPair.publicKey)
  const ctx = { storage, association, keyPair }
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  const node = createBrowserNode({ storage, association, seederUrl: 'ws://127.0.0.1:9/seeder', createSocket: () => { throw new Error('unexpected socket') }, writeGate: false })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs })
  await web.request('node.info')
  return { node, web, keyPair, key, association }
}

// Holds every follow.list on the chain until the returned release().
function holdChain (t) {
  const followList = ops.followList
  let release
  const held = new Promise((resolve) => { release = resolve })
  ops.followList = async (...args) => {
    await held
    return followList(...args)
  }
  t.teardown(() => { ops.followList = followList })
  return () => {
    ops.followList = followList
    release()
  }
}

// 'done' when p settles within ms, else 'pending'.
function within (p, ms) {
  return Promise.race([
    p.then(() => 'done', () => 'done'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms))
  ])
}

function sealedBlocks (s, blocks) {
  const id = { own: s.key, association: s.association }
  const seenKey = seenBlob.seenKeyFromSeed(s.keyPair.secretKey.subarray(0, 32), id.association, id.own)
  const doc = { gen: 1, member: id.own, association: id.association, avisos: { own: [], pages: {} }, dm: [], groups: [], blocks, testimonials: [], moments: [] }
  return b4a.toString(seenBlob.seal(doc, seenKey), 'base64')
}

test('block.list and mute.list answer while an unrelated request holds the chain', async (t) => {
  const s = await sessionNode(t)
  await s.web.request('block.set', { key: X, on: true })
  await s.web.request('mute.set', { key: Y, on: true })
  const release = holdChain(t)
  const busy = s.web.request('follow.list', {})
  const blocks = s.web.request('block.list')
  const mutes = s.web.request('mute.list')
  t.is(await within(blocks, 2000), 'done', 'block.list does not wait behind the chain')
  t.is(await within(mutes, 2000), 'done', 'mute.list does not wait behind the chain')
  t.alike((await blocks).keys, [X])
  t.alike((await mutes).keys, [Y])
  t.is(await within(busy, 50), 'pending', 'the held request is still on the chain')
  release()
  await busy
})

test('a list sent after a queued block.set, mute.set or seen.merge waits for it and sees its key', async (t) => {
  const s = await sessionNode(t)
  const release = holdChain(t)
  const busy = s.web.request('follow.list', {})
  const set = s.web.request('block.set', { key: X, on: true })
  const mute = s.web.request('mute.set', { key: Y, on: true })
  const merge = s.web.request('seen.merge', { blob: sealedBlocks(s, [{ key: Z, on: true, t: 100 }]), avisos: { own: [] }, unchanged: false })
  const blocks = s.web.request('block.list')
  const mutes = s.web.request('mute.list')
  t.is(await within(blocks, 300), 'pending', 'block.list waits for the writes queued before it')
  t.is(await within(mutes, 50), 'pending', 'mute.list too')
  release()
  await busy
  t.is((await set).changed, true)
  t.is((await mute).changed, true)
  t.is((await merge).blocksChanged, true)
  t.alike((await blocks).keys.sort(), [X, Z].sort(), 'the block.set and the seen.merge blocks are in')
  t.alike((await mutes).keys, [Y])
})

test('a block.set whose client timed out still comes before a later block.list', async (t) => {
  const s = await sessionNode(t, { timeoutMs: 1500 })
  const release = holdChain(t)
  const busy = errorOf(s.web.request('follow.list', {}))
  const set = errorOf(s.web.request('block.set', { key: X, on: true }))
  const lost = await set
  t.is(lost && lost.code, 'TIMEOUT', 'the client gave up on block.set')
  const blocks = s.web.request('block.list')
  t.is(await within(blocks, 200), 'pending', 'the node still runs it, and the list waits')
  release()
  await busy
  t.alike((await blocks).keys, [X])
})

test('a failed block write does not fail the list', async (t) => {
  const s = await sessionNode(t)
  const err = await errorOf(s.web.request('block.set', { key: s.key, on: true }))
  t.is(err && err.code, 'USAGE')
  t.alike((await s.web.request('block.list')).keys, [])
})

test('block.list and mute.list after close answer LOCKED', async (t) => {
  const assoc = generateAssociationKeyPair()
  const session = createBrowserSession({ storage: memoryNodeStorage(), association: hex(assoc.publicKey), seederUrl: 'ws://127.0.0.1:9/seeder', createSocket: () => null })
  await session.close()
  for (const method of ['block.list', 'mute.list']) {
    const err = await errorOf(session.handlers[method]({}))
    t.alike([err && err.code, err && err.message], ['LOCKED', 'sessão encerrada'], method)
  }
})
