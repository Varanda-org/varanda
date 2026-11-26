'use strict'

// export.read on the browser node (docs/rpc.md 5.180), through lib/session.js,
// lib/node.js and an in-memory client. No seeder: the node is offline.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { MAX_MESSAGE, EXPORT_PAGE_MAX } = require('@varanda/rpc')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { connectClient, errorOf } = require('./helpers/session')

const OFFLINE_URL = 'ws://127.0.0.1:9/seeder'
const KEYS = ['key', 'head', 'follows', 'entries', 'invalid', 'next']

function noop () {}

function nodeOf (t, assoc, storage) {
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: OFFLINE_URL,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  return node
}

async function setup (t, { identity = true } = {}) {
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: b4a.toString(kp.publicKey, 'hex') }
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const node = nodeOf(t, assoc, storage)
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 60000 })
  let key = null
  if (identity) {
    key = (await web.request('identity.create')).publicKey
    await web.request('cert.add', { cert: createCert({ member: key }, assoc.kp) })
  }
  return { assoc, storage, keyPair, node, web, key }
}

// Calls export.read from {} following next to the end; every response is
// checked against MAX_MESSAGE and the six-key shape.
async function walk (t, web) {
  const pages = []
  let params = {}
  for (let i = 0; i < 100; i++) {
    const r = await web.request('export.read', params)
    t.alike(Object.keys(r).sort(), [...KEYS].sort(), 'six keys')
    t.ok(Buffer.byteLength(JSON.stringify(r)) < MAX_MESSAGE, 'page under MAX_MESSAGE')
    pages.push({ params, r })
    if (r.next === null) return pages
    params = r.next
  }
  throw new Error('the walk does not end')
}

test('export.read: head, follows and a diary of large posts walk to the end', async (t) => {
  const { web, key, keyPair } = await setup(t)
  const F1 = 'f'.repeat(64)
  const F2 = 'e'.repeat(64)
  const B = 'b'.repeat(64)
  const M = 'c'.repeat(64)
  await web.request('follow.add', { key: F1 })
  await web.request('follow.add', { key: F2 })
  await web.request('block.set', { key: B, on: true })
  await web.request('mute.set', { key: M, on: true })
  const big = '\u{1F600}'.repeat(1000)
  for (let i = 0; i < 70; i++) await web.request('post.create', { text: big })
  await web.request('post.delete', { to: key + ':30' })

  const pages = await walk(t, web)
  const first = pages[0].r
  t.is(first.key, key)
  t.is(first.head.format, 'varanda-export')
  t.is(first.head.follows, 2)
  t.alike(first.head.blocked, [B])
  t.alike(first.head.muted, [M])
  t.alike(first.next, { part: 'follows', offset: 0, until: first.head.length })
  t.alike(first.follows, [])

  const follows = pages.filter((p) => p.params.part === 'follows').flatMap((p) => p.r.follows)
  t.is(follows.length, 2)
  t.alike(follows.slice().sort(), [F2, F1].sort())

  const diary = pages.filter((p) => p.params.part === 'diary')
  t.ok(diary.length >= 2, 'at least two diary pages')
  const seqs = []
  const invalid = []
  for (const { r } of diary) {
    t.is(r.head, null)
    t.ok(r.entries.length + r.invalid.length <= EXPORT_PAGE_MAX)
    for (const e of r.entries) seqs.push(e.seq)
    for (const i of r.invalid) {
      seqs.push(i.seq)
      invalid.push(i)
    }
  }
  // Pages follow each other: every seq of a page is above every seq of the
  // page before it.
  let floor = -1
  for (const { r } of diary) {
    const page = [...r.entries, ...r.invalid].map((e) => e.seq)
    t.ok(Math.min(...page) > floor, 'pages ascend')
    floor = Math.max(...page)
  }
  t.is(new Set(seqs).size, seqs.length, 'every seq once')
  t.is(seqs.length, first.head.length, 'the whole diary')
  t.ok(seqs.length > 30)
  t.alike(invalid, [{ seq: 30, reason: 'deleted' }])
  const all = JSON.stringify(pages)
  const secret = keyPair.secretKey
  for (const bytes of [secret, secret.subarray(0, 32)]) {
    for (const enc of ['hex', 'base64']) t.absent(all.includes(b4a.toString(bytes, enc)), 'no secret as ' + enc)
    t.absent(all.includes(b4a.toString(bytes, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), 'no secret as base64url')
  }
})

test('export.read: a locked node (reopened, no key) still answers', async (t) => {
  const first = await setup(t)
  await first.web.request('mute.set', { key: 'c'.repeat(64), on: true })
  await first.web.request('post.create', { text: 'um' })
  await first.node.close()
  const again = nodeOf(t, first.assoc, first.storage)
  const web = await connectClient(again, { timeoutMs: 60000 })
  t.ok(await errorOf(web.request('post.create', { text: 'dois' })), 'the reopened node is locked')
  const pages = await walk(t, web)
  t.is(pages[0].r.key, first.key)
  t.alike(pages[0].r.head.muted, ['c'.repeat(64)])
  const seqs = pages.flatMap(({ r }) => [...r.entries, ...r.invalid].map((e) => e.seq))
  t.alike(seqs, Array.from({ length: pages[0].r.head.length }, (_, i) => i), 'every block exported while locked')
  t.ok(pages.some(({ r }) => r.entries.some((e) => e.record.type === 'post' && e.record.text === 'um')), 'the post is in the export')
})

test('export.read: no identity is NOT_FOUND', async (t) => {
  const { web } = await setup(t, { identity: false })
  const err = await errorOf(web.request('export.read', {}))
  t.is(err.code, 'NOT_FOUND')
  t.is(err.message, 'identidade não encontrada')
})
