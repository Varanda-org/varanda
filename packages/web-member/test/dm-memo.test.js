'use strict'

// The fold memo of the direct message engine (lib/dm.js folded) and the
// store's version and ops (lib/dm-store.js): a read with nothing changed
// folds once, any change refolds, results match an unmemoized engine, and
// nothing outlives a lock. No network: rows are filed straight into the
// store, and the engine never dials.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const dmFold = require('@varanda/core/lib/dm-fold')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createDmEngine } = require('../lib/dm')
const { createDmStore } = require('../lib/dm-store')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')

const OWN = 'cd'.repeat(32)
const PEERS = ['a1', 'b2', 'c3', 'd4'].map((b) => b.repeat(32))
const ASSOC = b4a.toString(generateAssociationKeyPair().publicKey, 'hex')

function deepFreeze (v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze(v[k])
  }
  return v
}

// opts.memo false: the store reports a new version on every read, so the
// engine never reuses a fold (the reference).
function engineFor ({ memo = true } = {}) {
  const storage = memoryNodeStorage()
  const counts = { folds: 0, snapshots: 0 }
  let local = null
  let tick = 0
  const engine = createDmEngine({
    storage,
    association: ASSOC,
    seederUrl: 'ws://127.0.0.1:9',
    createSocket: () => { throw new Error('no network in this test') },
    limits: {
      fold: (args) => {
        counts.folds++
        return deepFreeze(dmFold.fold(args))
      }
    },
    createStore: (opts) => {
      const s = createDmStore(opts)
      local = {
        ...s,
        snapshot: () => {
          counts.snapshots++
          return s.snapshot()
        },
        version: memo ? s.version : () => ++tick
      }
      return local
    }
  })
  return { engine, storage, counts, store: () => local }
}

function msg (filedAt, { peer, mine = false, at, text = 'oi' }) {
  return { t: 'msg', id: b4a.toString(crypto.randomBytes(16), 'hex'), peer, from: mine ? OWN : peer, text, replyTo: null, at, mine, filedAt }
}

function ctl (filedAt, peer, op) {
  return { t: 'ctl', id: b4a.toString(crypto.randomBytes(16), 'hex'), op, peer, at: '2026-11-10T10:00:00.000Z', filedAt }
}

// A small deterministic generator, so a failure replays.
function prng (seed) {
  let x = seed >>> 0
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
}

test('reads with nothing changed fold once; an append, a seen change and a follow change each refold', async (t) => {
  const { engine, storage, counts, store: local } = engineFor()
  t.teardown(() => engine.close())
  await engine.unlock(crypto.randomBytes(32))
  await local().append([msg(local().nextFiled(), { peer: PEERS[0], at: '2026-11-10T09:00:00.000Z' })])
  counts.folds = 0
  counts.snapshots = 0

  const a = await engine.list(OWN, { folder: 'request' })
  const b = await engine.list(OWN, { folder: 'request' })
  const th = await engine.thread(OWN, { peer: PEERS[0] })
  t.is(counts.folds, 1, 'two dm.list and a dm.thread fold once')
  t.is(counts.snapshots, 1, 'the rows are copied once')
  t.alike(a, b)
  t.is(a.conversations.length, 1)
  t.is(th.messages.length, 1)
  t.is(th.folder, 'request')
  t.is(engine.foldMemoSize, 1)

  await local().append([msg(local().nextFiled(), { peer: PEERS[0], at: '2026-11-10T09:01:00.000Z' })])
  t.is((await engine.thread(OWN, { peer: PEERS[0] })).messages.length, 2, 'an append is seen at once')
  t.is(counts.folds, 2, 'an append refolds')

  t.ok((await engine.list(OWN, { folder: 'request' })).requests, 'unread before seen')
  await engine.seen(OWN, PEERS[0])
  const folds = counts.folds
  const after = await engine.list(OWN, { folder: 'request' })
  t.is(counts.folds, folds + 1, 'a seen change refolds')
  t.absent(after.conversations[0].unread, 'seen once dm.seen ran')

  await store.writeFollows(storage, [PEERS[0]])
  const inbox = await engine.list(OWN)
  t.is(counts.folds, folds + 2, 'a follow change refolds')
  t.is(inbox.conversations.length, 1, 'a followed peer is in the inbox')
  t.is((await engine.list(OWN, { folder: 'request' })).conversations.length, 0)
  t.is(counts.folds, folds + 2, 'and is then reused')

  await engine.list(OWN)
  await engine.list(PEERS[3])
  t.is(counts.folds, folds + 3, 'another self key refolds')
})

test('a block op refolds and dm.thread reads it from the shared ops', async (t) => {
  const { engine, counts, store: local } = engineFor()
  t.teardown(() => engine.close())
  await engine.unlock(crypto.randomBytes(32))
  await local().append([msg(local().nextFiled(), { peer: PEERS[1], at: '2026-11-10T09:00:00.000Z' })])
  t.absent((await engine.thread(OWN, { peer: PEERS[1] })).blocked)
  const folds = counts.folds
  await local().append([ctl(local().nextFiled(), PEERS[1], 'blocked')])
  const th = await engine.thread(OWN, { peer: PEERS[1] })
  t.ok(th.blocked, 'blocked at once')
  t.is(counts.folds, folds + 1)
})

test('results match an unmemoized engine across messages, ops, deletes, blocks, seen and follows', async (t) => {
  const prf = crypto.randomBytes(32)
  const m = engineFor()
  const r = engineFor({ memo: false })
  t.teardown(() => Promise.all([m.engine.close(), r.engine.close()]))
  await m.engine.unlock(prf)
  await r.engine.unlock(prf)
  const rand = prng(20261110)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  let filed = 1
  let follows = []
  let mismatches = 0
  // What the sequence reached, so it is known to cover every case.
  const seenStates = new Set()

  async function both (fn) {
    await fn(m)
    await fn(r)
  }

  async function view (e) {
    const out = { inbox: await e.engine.list(OWN, { limit: 50 }), requests: await e.engine.list(OWN, { folder: 'request', limit: 50 }) }
    for (const p of PEERS) out[p] = await e.engine.thread(OWN, { peer: p, limit: 50 })
    return out
  }

  for (let step = 0; step < 120; step++) {
    const roll = rand()
    const peer = pick(PEERS)
    if (roll < 0.45) {
      const at = new Date(Date.UTC(2026, 10, 10, 9, Math.floor(rand() * 600))).toISOString()
      const row = msg(filed++, { peer, mine: rand() < 0.3, at, text: 'm' + step })
      await both((e) => e.store().append([row]))
    } else if (roll < 0.7) {
      const row = ctl(filed++, peer, pick(['accepted', 'declined', 'blocked', 'unblocked', 'deleted']))
      await both((e) => e.store().append([row]))
    } else if (roll < 0.85) {
      await both((e) => e.engine.seen(OWN, peer))
    } else {
      follows = rand() < 0.5 ? [...new Set([...follows, peer])] : follows.filter((k) => k !== peer)
      await both((e) => store.writeFollows(e.storage, follows))
    }
    // Every other step reads twice, so the memo is hit between changes too.
    const reads = step % 2 === 0 ? 2 : 1
    for (let i = 0; i < reads; i++) {
      const [a, b] = [await view(m), await view(r)]
      if (b.inbox.conversations.length > 0) seenStates.add('inbox')
      if (b.requests.conversations.length > 0) seenStates.add('request')
      if (PEERS.some((p) => b[p].blocked)) seenStates.add('blocked')
      if (PEERS.some((p) => b[p].messages.length === 0)) seenStates.add('empty')
      if (b.inbox.conversations.some((c) => c.unread) || b.requests.conversations.some((c) => c.unread)) seenStates.add('unread')
      if (b.inbox.conversations.some((c) => !c.unread)) seenStates.add('read')
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        mismatches++
        t.alike(a, b, 'step ' + step)
      }
    }
  }
  t.is(mismatches, 0, 'every read deep-equal to the unmemoized engine')
  t.alike([...seenStates].sort(), ['blocked', 'empty', 'inbox', 'read', 'request', 'unread'], 'the sequence covered every state')
  t.ok(m.counts.folds < r.counts.folds / 2, 'the memo saved folds (' + m.counts.folds + ' vs ' + r.counts.folds + ')')
  t.is(r.engine.foldMemoSize, 0, 'the reference remembers nothing')
})

test('after lock nothing is returned and the memo is empty; a new unlock folds again', async (t) => {
  const prf = crypto.randomBytes(32)
  const { engine, counts, store: local } = engineFor()
  t.teardown(() => engine.close())
  await engine.unlock(prf)
  await local().append([msg(local().nextFiled(), { peer: PEERS[2], at: '2026-11-10T09:00:00.000Z' })])
  await engine.list(OWN, { folder: 'request' })
  t.is(engine.foldMemoSize, 1)
  engine.lock()
  t.is(engine.foldMemoSize, 0, 'the memo is empty after lock')
  await t.exception(engine.list(OWN, { folder: 'request' }), /bloqueada/)
  await t.exception(engine.thread(OWN, { peer: PEERS[2] }), /bloqueada/)
  t.exception(() => local().ops(), /bloqueada/)
  t.is(engine.foldMemoSize, 0)

  const folds = counts.folds
  await engine.unlock(prf)
  t.is((await engine.list(OWN, { folder: 'request' })).conversations.length, 1, 'the rows load again')
  t.is(counts.folds, folds + 1, 'nothing from before the lock is reused')
})

test('a superseded engine unlock leaves no memo', async (t) => {
  const { engine } = engineFor()
  t.teardown(() => engine.close())
  const first = engine.unlock(crypto.randomBytes(32))
  const second = engine.unlock(crypto.randomBytes(32))
  await Promise.allSettled([first, second])
  await engine.list(OWN)
  t.is(engine.foldMemoSize, 1)
  const third = engine.unlock(crypto.randomBytes(32))
  t.is(engine.foldMemoSize, 0, 'a new unlock drops the memo at once')
  await third
})

test('store: version moves on load, append and lock; ops is shared and frozen per version', async (t) => {
  const s = createDmStore({ storage: memoryNodeStorage() })
  const v0 = s.version()
  await s.unlock(new Uint8Array(32).fill(3))
  const v1 = s.version()
  t.ok(v1 > v0, 'load bumps')
  t.is(s.ops().length, 0)
  t.is(s.ops(), s.ops(), 'the same array while nothing changed')
  await s.append([ctl(s.nextFiled(), PEERS[0], 'blocked')])
  const v2 = s.version()
  t.ok(v2 > v1, 'append bumps')
  const ops = s.ops()
  t.is(ops.length, 1)
  t.ok(Object.isFrozen(ops) && Object.isFrozen(ops[0]), 'frozen')
  t.exception.all(() => ops.push({}), /not extensible/, 'a caller cannot add to it')
  t.alike(ops, s.snapshot().ops, 'the same rows as snapshot')
  const token = s.seenToken('x')
  t.is(s.seenToken('x'), token)
  s.lock()
  t.ok(s.version() > v2, 'lock bumps')
  t.exception(() => s.ops(), /bloqueada/)
  t.exception(() => s.seenToken('x'), /bloqueada/)
  await s.unlock(new Uint8Array(32).fill(4))
  t.not(s.seenToken('x'), token, 'tokens follow the key')
  t.is(s.ops().length, 0, 'another key reads none of the old rows')
  await s.close()
})
