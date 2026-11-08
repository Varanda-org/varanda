'use strict'

// The member's own block list (lib/member-block.js) and the feed and peek
// rules that read it.
const test = require('brittle')
const { BLOCK_MAX } = require('@varanda/rpc')
const { UNBLOCKS_MAX, normalizeBlocks, blockedKeys, applyBlock } = require('../lib/member-block')
const { buildFeed } = require('../lib/feed')
const { diaryPeek } = require('../lib/peek')
const { memberCertRecord } = require('../lib/records')
const { createCert, generateAssociationKeyPair } = require('../lib/cert')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation } = require('../lib/assoc')

const key = (i) => i.toString(16).padStart(64, '0')
const A = key(1)
const B = key(2)

test('a block adds the key and an unblock removes it', (t) => {
  const on = applyBlock([], A, true, 100)
  t.ok(on.changed)
  t.alike(on.entries, [{ key: A, on: true, t: 100 }])
  t.alike([...blockedKeys(on.entries)], [A])

  const off = applyBlock(on.entries, A, false, 200)
  t.ok(off.changed)
  t.alike(off.entries, [{ key: A, on: false, t: 200 }], 'the unblock stays as an entry')
  t.is(blockedKeys(off.entries).size, 0)
})

test('the same state again changes nothing', (t) => {
  t.absent(applyBlock([], A, false, 100).changed, 'unblocking someone never blocked writes nothing')
  const on = applyBlock([], A, true, 100)
  const again = applyBlock(on.entries, A, true, 500)
  t.absent(again.changed)
  t.alike(again.entries, on.entries, 'the first time stays')
})

test('a change wins over the last one even with a clock behind', (t) => {
  const on = applyBlock([], A, true, 1000)
  const off = applyBlock(on.entries, A, false, 5)
  t.alike(off.entries, [{ key: A, on: false, t: 1001 }])
  const back = applyBlock(off.entries, A, true, 5)
  t.alike(back.entries, [{ key: A, on: true, t: 1002 }])
})

test('a new block past the limit is refused and an old one can still be undone', (t) => {
  const full = []
  for (let i = 0; i < BLOCK_MAX; i++) full.push({ key: key(i + 10), on: true, t: i })
  const r = applyBlock(full, A, true, 9999)
  t.ok(r.full)
  t.absent(r.changed)
  t.is(blockedKeys(r.entries).size, BLOCK_MAX)
  t.ok(applyBlock(full, key(10), false, 9999).changed)
})

test('stored data: invalid entries are dropped, one entry per key, the newest wins', (t) => {
  const out = normalizeBlocks([
    null,
    'x',
    { key: 'A'.repeat(64), on: true, t: 1 },
    { key: 'zz', on: true, t: 1 },
    { key: A, on: 'yes', t: 1 },
    { key: A, on: true, t: -1 },
    { key: A, on: true, t: 1.5 },
    { key: A, on: true, t: 4294967296 },
    { key: A, on: true, t: 5, extra: 'dropped' },
    { key: A, on: false, t: 9 },
    { key: B, on: true, t: 7 }
  ])
  t.alike(out, [{ key: B, on: true, t: 7 }, { key: A, on: false, t: 9 }])
  t.alike(normalizeBlocks(null), [])
  t.alike(normalizeBlocks('x'), [])
  t.is(blockedKeys(undefined).size, 0)
})

test('at equal times the block wins, whatever the order', (t) => {
  const on = { key: A, on: true, t: 5 }
  const off = { key: A, on: false, t: 5 }
  t.alike(normalizeBlocks([on, off]), [on])
  t.alike(normalizeBlocks([off, on]), [on])
})

test('the caps keep the newest entries of each kind', (t) => {
  const list = []
  for (let i = 0; i < UNBLOCKS_MAX + 5; i++) list.push({ key: key(i + 1), on: false, t: i })
  const kept = normalizeBlocks(list)
  t.is(kept.length, UNBLOCKS_MAX)
  t.is(kept[0].t, 5, 'the oldest unblocks went first')

  const active = []
  for (let i = 0; i < BLOCK_MAX + 3; i++) active.push({ key: key(i + 1), on: true, t: i })
  const cut = normalizeBlocks(active)
  t.is(cut.length, BLOCK_MAX)
  t.is(cut[0].t, 3)
})

const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-02T00:00:00.000Z'
const T3 = '2026-01-03T00:00:00.000Z'
const post = (text, at) => ({ type: 'post', text, at, replyTo: null })
const repost = (author, seq, at) => ({ type: 'repost', to: { author, seq }, on: true, at })

function diaryOf (assoc, seed) {
  const k = seed.toString(16).padStart(64, '0')
  return { key: k, cert: memberCertRecord(createCert({ member: k }, assoc)) }
}

test('buildFeed: a repost of a hidden author leaves the feed before the page is cut', (t) => {
  const assoc = generateAssociationKeyPair()
  const association = assoc.publicKey.toString('hex')
  const X = diaryOf(assoc, 1)
  const Y = diaryOf(assoc, 2)
  const logs = [{
    key: Y.key,
    entries: [
      { seq: 0, record: Y.cert },
      { seq: 1, record: post('antes', T1) },
      { seq: 2, record: repost(X.key, 5, T2) },
      { seq: 3, record: repost(Y.key, 1, T3) }
    ]
  }]
  const now = Date.parse(T3) + 1000
  const open = buildFeed({ logs, association, now })
  t.alike(open.items.map((i) => i.kind + ':' + i.seq), ['post:1', 'repost:2', 'repost:3'])
  const hidden = new Set([X.key])
  const cut = buildFeed({ logs, association, now, hidden })
  t.alike(cut.items.map((i) => i.kind + ':' + i.seq), ['post:1', 'repost:3'])
  const page = buildFeed({ logs, association, now, hidden, limit: 2 })
  t.alike(page.items.map((i) => i.kind + ':' + i.seq), ['post:1', 'repost:3'], 'a full page, not one row short')
})

test('diaryPeek: a repost of a hidden author is not one of the diary\'s rows', (t) => {
  const assoc = generateAssociationKeyPair()
  const association = assoc.publicKey.toString('hex')
  const X = diaryOf(assoc, 1)
  const Y = diaryOf(assoc, 2)
  const entries = [
    { seq: 0, record: Y.cert },
    { seq: 1, record: post('oi', T1) },
    { seq: 2, record: repost(X.key, 5, T2) }
  ]
  const input = { key: Y.key, length: 3, entries, fetched: new Set([0, 1, 2]), association, now: Date.parse(T3) }
  t.alike(diaryPeek(input).posts.map((p) => p.kind + ':' + p.seq), ['repost:2', 'post:1'])
  t.alike(diaryPeek({ ...input, hidden: new Set([X.key]) }).posts.map((p) => p.kind + ':' + p.seq), ['post:1'])
})

test('the core node refuses block.set and block.list before anything opens', async (t) => {
  const NO = { code: 'USAGE', message: 'bloqueio de membros disponível só no navegador' }
  const dataDir = tmpDir(t)
  const assocDir = require('node:path').join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: ['127.0.0.1:49737'] })
  await connect(t, session)
  t.alike(await failure(session.handlers['block.set']({ key: A, on: true })), NO)
  t.alike(await failure(session.handlers['block.list']({})), NO)
})
