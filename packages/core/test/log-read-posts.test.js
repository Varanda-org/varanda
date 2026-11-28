'use strict'

// log.read `posts` on the node session (lib/session.js, docs/rpc.md 5.12):
// the window and entriesTruncated count post and repost records only.
const test = require('brittle')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')
const storeLib = require('../lib/store')
const { postRecord, likeRecord, repostRecord, followRecord, profileRecord, deleteRecord, postEditRecord } = require('../lib/records')

const BOOTSTRAP = ['127.0.0.1:49737']
const OTHER = 'ab'.repeat(32)
const TARGET = { author: OTHER, seq: 1 }

async function member (t) {
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const dataDir = tmpDir(t)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  return { session, publicKey, dataDir, ...link }
}

async function appendDirect (dataDir, records) {
  const s = await storeLib.openStore(dataDir)
  try {
    const diary = await storeLib.openDiary(s)
    for (const r of records) await storeLib.appendRecord(diary, r)
  } finally {
    await s.close()
  }
}

function noise (n) {
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
  const m = await member(t)
  // seq 1 post, 2..41 noise, 42 post, 43 repost on, 44 post, 45 repost off,
  // 46 the edit of seq 1, 47..51 noise.
  await appendDirect(m.dataDir, [
    postRecord({ text: 'a' }),
    ...noise(40),
    postRecord({ text: 'b' }),
    repostRecord({ to: TARGET, on: true }),
    postRecord({ text: 'c' }),
    repostRecord({ to: TARGET, on: false }),
    postEditRecord({ seq: 1, text: 'a editada' }),
    ...noise(5)
  ])

  const plain = await m.call('log.read', {})
  t.alike(seqs(plain), Array.from({ length: 20 }, (_, i) => 32 + i), 'without posts: the newest 20 blocks, as before')
  t.alike(plain.invalid, [])
  t.is(plain.entriesTruncated, 32)
  t.alike(await m.call('log.read', { posts: false }), plain, 'posts: false is the same answer')
  t.alike(await m.call('log.read', { limit: 3, before: 99 }), await m.call('log.read', { limit: 3 }), 'a before past the length still clamps')

  const page = await m.call('log.read', { posts: true })
  t.alike(seqs(page), [1, 42, 43, 44, 45], 'the three posts and both reposts')
  t.alike(page.invalid, [])
  t.is(page.entriesTruncated, 0, 'no older publication')
  t.alike([page.entries[2].record.on, page.entries[4].record.on], [true, false], 'repost on and off')
  t.alike([page.entries[0].record.text, page.entries[0].edited], ['a editada', true], 'the edit at seq 46 is outside the window and still applied')

  const small = await m.call('log.read', { posts: true, limit: 2 })
  t.alike(seqs(small), [44, 45])
  t.is(small.entriesTruncated, 3)
  const next = await m.call('log.read', { posts: true, limit: 2, before: 44 })
  t.alike(seqs(next), [42, 43], 'before stays an exclusive seq bound')
  t.is(next.entriesTruncated, 1)
  const last = await m.call('log.read', { posts: true, limit: 2, before: 42 })
  t.alike(seqs(last), [1])
  t.is(last.entriesTruncated, 0)
  t.alike(await m.call('log.read', { posts: true, limit: 2, before: 999 }), small, 'a before past the length is the newest page')
})

test('log.read posts: 35 posts among likes page as 30 then 5, no overlap; a deleted post is absent', async (t) => {
  const m = await member(t)
  const records = []
  for (let i = 0; i < 35; i++) {
    records.push(postRecord({ text: 'p' + i }))
    records.push(likeRecord({ to: TARGET, on: i % 2 === 0 }))
  }
  records.push(postRecord({ text: 'apagada' }))
  records.push(deleteRecord({ seq: 71 }))
  await appendDirect(m.dataDir, records)
  const postSeqs = Array.from({ length: 35 }, (_, i) => 1 + 2 * i)

  const plain = await m.call('log.read', { limit: 5 })
  t.alike(plain.invalid, [{ seq: 71, reason: 'deleted' }], 'without posts the deleted slot is invalid, as before')

  const first = await m.call('log.read', { posts: true, limit: 30 })
  t.is(first.entries.length, 30)
  t.alike(first.invalid, [], 'the deleted post is not in invalid')
  t.absent(seqs(first).includes(71), 'nor in entries')
  t.is(first.entriesTruncated, 5)
  const second = await m.call('log.read', { posts: true, limit: 30, before: Math.min(...seqs(first)) })
  t.is(second.entries.length, 5)
  t.is(second.entriesTruncated, 0)
  t.alike([...seqs(second), ...seqs(first)], postSeqs, 'every post once, in order, no overlap')
})

test('log.read posts: only a boolean', async (t) => {
  const m = await member(t)
  t.alike(await failure(m.call('log.read', { posts: 'yes' })), { code: 'USAGE', message: 'parâmetro inválido: posts' })
})
