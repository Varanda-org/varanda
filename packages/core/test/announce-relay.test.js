'use strict'

// The paced announce relay (lib/announce-relay.js, issue #67): a fake bucket
// and fake timers, so nothing depends on wall-clock timing.
const test = require('brittle')
const { createAnnounceRelay, RELAY_ANNOUNCE_BURST, RELAY_ANNOUNCE_RATE } = require('../lib/announce-relay')
const { Seeder } = require('../lib/seeder')

const key = (i) => i.toString(16).padStart(64, '0')
const cert = { v: 1 }

function fakeBucket (tokens) {
  const b = {
    tokens,
    take () {
      if (b.tokens < 1) return false
      b.tokens--
      return true
    },
    waitMs: () => 250
  }
  return b
}

function fakeTimers () {
  const pending = new Map()
  let id = 0
  return {
    pending,
    setTimer (fn, ms) {
      const h = { id: ++id, ms }
      pending.set(h, fn)
      return h
    },
    clearTimer (h) { pending.delete(h) },
    fire () {
      const all = [...pending]
      pending.clear()
      for (const [, fn] of all) fn()
    }
  }
}

// next() over a fixed list of keys, skipping those the relay already has.
function listNext (keys) {
  return (has) => {
    for (const k of keys) if (!has(k)) return { key: k, cert }
    return null
  }
}

test('constants stay under the receiver limits with room for the own announce', (t) => {
  t.ok(RELAY_ANNOUNCE_BURST + 1 <= Seeder.ANNOUNCE_BURST / 2)
  t.ok(RELAY_ANNOUNCE_RATE <= Seeder.ANNOUNCE_RATE / 2)
})

test('sends the burst, then waits for tokens', (t) => {
  const sent = []
  const timers = fakeTimers()
  const bucket = fakeBucket(3)
  const keys = [1, 2, 3, 4, 5].map(key)
  const relay = createAnnounceRelay({ send: (m) => sent.push(m), next: listNext(keys), bucket, maxOutstanding: 100, ...timers })
  relay.kick()
  t.is(sent.length, 3)
  t.alike(sent[0], { type: 'announce', key: keys[0], cert })
  t.is(timers.pending.size, 1, 'one timer waits for a token')
  relay.kick()
  t.is(timers.pending.size, 1, 'a kick while waiting adds no timer')
  bucket.tokens = 1
  timers.fire()
  t.is(sent.length, 4)
  bucket.tokens = 5
  timers.fire()
  t.is(sent.length, 5)
  t.is(timers.pending.size, 0, 'an idle relay holds no timer')
})

test('each key at most once, across kicks', (t) => {
  const sent = []
  const keys = [1, 2].map(key)
  const relay = createAnnounceRelay({ send: (m) => sent.push(m), next: listNext(keys), bucket: fakeBucket(100), ...fakeTimers() })
  relay.kick()
  relay.kick()
  relay.kick()
  t.alike(sent.map((m) => m.key), keys)
})

test('a next() that returns a key already offered ends the pass', (t) => {
  const sent = []
  const relay = createAnnounceRelay({ send: (m) => sent.push(m), next: () => ({ key: key(1), cert }), bucket: fakeBucket(100), ...fakeTimers() })
  relay.kick()
  relay.kick()
  t.is(sent.length, 1)
})

test('an invalid candidate is never sent', (t) => {
  const sent = []
  const cands = [{ key: 'xyz', cert }, { key: key(1), cert: null }, { key: 'ab'.repeat(32).toUpperCase(), cert }]
  for (const c of cands) {
    const relay = createAnnounceRelay({ send: (m) => sent.push(m), next: () => c, bucket: fakeBucket(100), ...fakeTimers() })
    relay.kick()
  }
  t.is(sent.length, 0)
})

test('skip retires a key', (t) => {
  const sent = []
  const keys = [1, 2].map(key)
  const relay = createAnnounceRelay({ send: (m) => sent.push(m), next: listNext(keys), bucket: fakeBucket(100), ...fakeTimers() })
  relay.skip(keys[0])
  relay.kick()
  t.alike(sent.map((m) => m.key), [keys[1]])
})

test('max bounds announced plus skipped keys for good', (t) => {
  const sent = []
  const keys = [1, 2, 3, 4, 5].map(key)
  const relay = createAnnounceRelay({ send: (m) => sent.push(m), next: listNext(keys), bucket: fakeBucket(100), max: 3, ...fakeTimers() })
  relay.skip(keys[0])
  relay.kick()
  t.alike(sent.map((m) => m.key), [keys[1], keys[2]])
  relay.skip(keys[3])
  t.is(relay.size(), 3, 'a full set takes no more keys')
  relay.kick()
  t.is(sent.length, 2)
})

test('waits while the channel holds queued sends', (t) => {
  const sent = []
  const timers = fakeTimers()
  let backlog = 1
  const keys = [1, 2, 3].map(key)
  const relay = createAnnounceRelay({
    send: (m) => {
      sent.push(m)
      backlog++ // each announce waits in the channel's queue
    },
    next: listNext(keys),
    queued: () => backlog,
    bucket: fakeBucket(100),
    ...timers
  })
  relay.kick()
  t.is(sent.length, 0, 'nothing while our inventory is queued')
  t.is(timers.pending.size, 1)
  backlog = 0
  timers.fire()
  t.is(sent.length, 1, 'one announce, then it waits for it to leave')
  backlog = 0
  timers.fire()
  t.is(sent.length, 2)
})

test('stop cancels the timer and later kicks', (t) => {
  const sent = []
  const timers = fakeTimers()
  const relay = createAnnounceRelay({ send: (m) => sent.push(m), next: listNext([key(1), key(2)]), bucket: fakeBucket(0), ...timers })
  relay.kick()
  t.is(timers.pending.size, 1)
  relay.stop()
  t.is(timers.pending.size, 0)
  relay.kick()
  relay.skip(key(1))
  t.is(sent.length, 0)
  t.is(relay.size(), 0)
  t.ok(relay.stopped())
})

test('a send that fails, or a next() that throws, stops the relay', (t) => {
  const keys = [1, 2].map(key)
  let calls = 0
  const a = createAnnounceRelay({ send: () => { calls++; return false }, next: listNext(keys), bucket: fakeBucket(100), ...fakeTimers() })
  a.kick()
  t.is(calls, 1)
  t.ok(a.stopped())
  const errors = []
  const b = createAnnounceRelay({ send: () => true, next: () => { throw new Error('x') }, bucket: fakeBucket(100), onerror: (e) => errors.push(e), ...fakeTimers() })
  b.kick()
  t.ok(b.stopped())
  t.is(errors.length, 1)
})

test('a skip inside next() that fills the set ends the relay at max', (t) => {
  const sent = []
  let relay = null
  relay = createAnnounceRelay({
    send: (m) => sent.push(m),
    next: (has) => {
      if (!has(key(1))) relay.skip(key(1)) // retires the last free slot
      return has(key(2)) ? null : { key: key(2), cert }
    },
    bucket: fakeBucket(100),
    max: 1,
    ...fakeTimers()
  })
  relay.kick()
  t.is(sent.length, 0, 'nothing past max')
  t.is(relay.size(), 1)
})

test('at most maxOutstanding unanswered announces; an answer frees a slot', (t) => {
  const sent = []
  const timers = fakeTimers()
  let clock = 0
  const keys = [1, 2, 3, 4].map(key)
  const relay = createAnnounceRelay({
    send: (m) => sent.push(m),
    next: listNext(keys),
    bucket: fakeBucket(100),
    maxOutstanding: 2,
    settleMs: 1000,
    now: () => clock,
    ...timers
  })
  relay.kick()
  t.is(sent.length, 2, 'two in flight')
  t.is(timers.pending.size, 1, 'waits for an answer or the settle time')
  relay.settle(key(9)) // a key never announced frees nothing
  t.is(sent.length, 2)
  relay.settle(keys[0])
  t.is(sent.length, 3, 'an answer frees a slot at once')
  clock = 1000
  timers.fire()
  t.is(sent.length, 4, 'an unanswered announce frees its slot after settleMs')
})
