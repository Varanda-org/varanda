'use strict'

// log.read `posts` on the browser node (docs/rpc.md 5.12): the window and
// entriesTruncated count post and repost records only, so a page of likes
// never reaches the Publicações tab empty. Loopback only.
const test = require('brittle')
const assert = require('node:assert/strict')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const { WebSocket } = require('ws')
const { testnet } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, profileRecord, postRecord, likeRecord, repostRecord, followRecord, deleteRecord, postEditRecord } = require('@varanda/core/lib/records')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')

const OTHER = 'ab'.repeat(32)
const TARGET = { author: OTHER, seq: 1 }

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// A certified own diary with `make(key)`'s records appended before any node
// opens it, then a node on it.
async function prepared (t, make) {
  const assoc = association()
  const keyPair = crypto.keyPair()
  const storage = memoryNodeStorage()
  const ctx = { storage, association: assoc.hex, keyPair }
  const { publicKey } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: publicKey }, assoc.kp))
  const records = make(publicKey)
  // appendRecords takes at most 8 records at a time.
  await member.withIdentity(ctx, async ({ diary }) => {
    for (let i = 0; i < records.length; i += 8) await store.appendRecords(diary, records.slice(i, i + 8))
  })
  const port = await deadPort()
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node)
  return { web, storage, assoc, key: publicKey }
}

// 40 records that are not publications: likes (on and off), follows and
// profiles.
function noise (n = 40) {
  const out = []
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) out.push(likeRecord({ to: TARGET, on: i % 2 === 0 }))
    else if (i % 3 === 1) out.push(followRecord({ key: OTHER, on: i % 2 === 0 }))
    else out.push(profileRecord({ name: 'Bia ' + i, bio: '' }))
  }
  return out
}

const seqs = (page) => page.entries.map((e) => e.seq)

test('log.read posts: the posts and both reposts behind 40 other records, an edit outside the window still applied', async (t) => {
  await testnet(t)
  // seq 1 post, 2..41 noise, 42 post, 43 repost on, 44 post, 45 repost off,
  // 46 the edit of seq 1, 47..51 likes.
  const { web } = await prepared(t, () => [
    postRecord({ text: 'a' }),
    ...noise(),
    postRecord({ text: 'b' }),
    repostRecord({ to: TARGET, on: true }),
    postRecord({ text: 'c' }),
    repostRecord({ to: TARGET, on: false }),
    postEditRecord({ seq: 1, text: 'a editada' }),
    ...noise(5)
  ])

  const plain = await web.request('log.read', {})
  t.alike(seqs(plain), Array.from({ length: 20 }, (_, i) => 32 + i), 'without posts: the newest 20 blocks, as before')
  t.alike(plain.invalid, [])
  t.is(plain.entriesTruncated, 32)
  t.alike(await web.request('log.read', { posts: false }), plain, 'posts: false is the same answer')

  const page = await web.request('log.read', { posts: true })
  t.alike(seqs(page), [1, 42, 43, 44, 45], 'the three posts and both reposts')
  t.alike(page.invalid, [])
  t.is(page.entriesTruncated, 0, 'no older publication')
  t.alike(page.entries.map((e) => e.record.type), ['post', 'post', 'repost', 'post', 'repost'])
  t.alike([page.entries[2].record.on, page.entries[4].record.on], [true, false], 'repost on and off')
  t.alike([page.entries[0].record.text, page.entries[0].edited], ['a editada', true], 'the edit at seq 46 is outside the window and still applied')

  const small = await web.request('log.read', { posts: true, limit: 2 })
  t.alike(seqs(small), [44, 45])
  t.is(small.entriesTruncated, 3, 'the older publications')
  const next = await web.request('log.read', { posts: true, limit: 2, before: 44 })
  t.alike(seqs(next), [42, 43], 'before stays an exclusive seq bound')
  t.is(next.entriesTruncated, 1)
  const last = await web.request('log.read', { posts: true, limit: 2, before: 42 })
  t.alike(seqs(last), [1])
  t.is(last.entriesTruncated, 0)
})

test('log.read posts: 35 posts among likes page as 30 then 5, no overlap; a deleted post is absent', async (t) => {
  await testnet(t)
  const { web } = await prepared(t, () => {
    const out = []
    for (let i = 0; i < 35; i++) {
      out.push(postRecord({ text: 'p' + i }))
      out.push(likeRecord({ to: TARGET, on: i % 2 === 0 }))
    }
    // seq 71 is a post, deleted by seq 72.
    out.push(postRecord({ text: 'apagada' }))
    out.push(deleteRecord({ seq: 71 }))
    return out
  })
  const postSeqs = Array.from({ length: 35 }, (_, i) => 1 + 2 * i)

  const plain = await web.request('log.read', { limit: 5 })
  t.alike(plain.invalid, [{ seq: 71, reason: 'deleted' }], 'without posts the deleted slot is invalid, as before')

  const first = await web.request('log.read', { posts: true, limit: 30 })
  t.is(first.entries.length, 30)
  t.alike(first.invalid, [], 'the deleted post is not in invalid')
  t.absent(seqs(first).includes(71), 'nor in entries')
  t.is(first.entriesTruncated, 5)
  const second = await web.request('log.read', { posts: true, limit: 30, before: Math.min(...seqs(first)) })
  t.is(second.entries.length, 5)
  t.is(second.entriesTruncated, 0)
  t.alike([...seqs(second), ...seqs(first)], postSeqs, 'every post once, in order, no overlap')
  t.ok(second.entries.concat(first.entries).every((e) => e.record.type === 'post'))
})

test('log.read posts: a followed diary with holes pages by seq over the stored publications', async (t) => {
  await testnet(t)
  const { web, storage, assoc } = await prepared(t, () => [])
  const H = await holeyReplica(t, storage, assoc)
  await web.request('follow.add', { key: H })
  const plain = await web.request('log.read', { author: H, limit: 5 })
  t.alike(seqs(plain), [12, 13, 14, 15, 16], 'without posts: the newest stored blocks')

  const pages = []
  let before
  for (;;) {
    const page = await web.request('log.read', before === undefined ? { author: H, limit: 2, posts: true } : { author: H, limit: 2, posts: true, before })
    pages.push({ seqs: seqs(page), invalid: page.invalid, entriesTruncated: page.entriesTruncated })
    if (page.entriesTruncated === 0 || pages.length > 10) break
    before = Math.min(...seqs(page))
  }
  t.alike(pages, [
    { seqs: [15, 16], invalid: [], entriesTruncated: 3 },
    { seqs: [11, 13], invalid: [], entriesTruncated: 1 },
    { seqs: [2], invalid: [], entriesTruncated: 0 }
  ], 'the island and the malformed block are left out')
  const inHole = await web.request('log.read', { author: H, limit: 5, posts: true, before: 9 })
  t.alike(seqs(inHole), [2], 'a before inside a hole ends at the stored publication below it')
  t.is(inHole.entriesTruncated, 0)
})

test('log.read posts: only a boolean', async (t) => {
  await testnet(t)
  const { web } = await prepared(t, () => [])
  const err = await errorOf(web.request('log.read', { posts: 1 }))
  t.alike([err && err.code, err && err.message], ['USAGE', 'parâmetro inválido: posts'])
})

// A followed diary stored with holes at its full signed length: the prefix
// [0, 5) with a block that does not decode at 3, an island [7, 9) the
// reader does not show, and the newest run [11, 17). Publications at 2, 5,
// 6, 7 (island), 9, 10, 11, 13, 15 (a repost) and 16; stored and shown: 2,
// 11, 13, 15 and 16.
async function holeyReplica (t, storage, assoc) {
  const source = new Hypercore(memoryStorage())
  await source.ready()
  t.teardown(() => source.close(), { force: true })
  const put = (record) => source.append(b4a.from(JSON.stringify(record)))
  const post = (i) => put(postRecord({ text: 'p' + i, at: '2026-01-01T00:00:' + String(10 + i) + '.000Z' }))
  await put(memberCertRecord(createCert({ member: hex(source.key) }, assoc.kp)))
  await put(profileRecord({ name: 'Furada', bio: '' }))
  await post(2)
  await source.append(b4a.from('{oops'))
  await put(likeRecord({ to: TARGET, on: true }))
  await post(5)
  await post(6)
  await post(7)
  await put(likeRecord({ to: TARGET, on: false }))
  await post(9)
  await post(10)
  await post(11)
  await put(likeRecord({ to: TARGET, on: true }))
  await post(13)
  await put(followRecord({ key: OTHER, on: true }))
  await put(repostRecord({ to: TARGET, on: true }))
  await post(16)
  const key = hex(source.key)
  const replica = new Hypercore(storage.core('replica/' + key), source.key)
  await replica.ready()
  const a = source.replicate(true)
  const b = replica.replicate(false)
  a.pipe(b).pipe(a)
  for (const [start, end] of [[0, 5], [7, 9], [11, 17]]) await replica.download({ start, end }).done()
  assert.equal(replica.length, 17)
  a.destroy()
  b.destroy()
  await replica.close()
  return key
}
