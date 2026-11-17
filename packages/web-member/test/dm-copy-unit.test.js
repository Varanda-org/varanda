'use strict'

// The pure rules of the history copy (lib/dm-copy.js): what a bundle row must
// look like before it is filed, and the limits the maker checks before it
// spends anything. No network.

const test = require('brittle')
const { cleanRow, checkLimits, manifestBytes, LIMITS, TOO_BIG } = require('../lib/dm-copy')
const { createDmStore } = require('../lib/dm-store')
const { memoryNodeStorage } = require('../lib/node-storage')
const { UsageError } = require('@varanda/core/lib/errors')

const SELF = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const AT = '2026-11-03T12:00:00.000Z'
const NO_BLOCKS = new Set()

function msg (extra = {}) {
  return { t: 'msg', id: '1'.repeat(32), peer: PEER, from: PEER, text: 'oi', replyTo: null, fwd: 0, media: null, card: null, at: AT, mine: false, n: 0, ...extra }
}

function reaction (extra = {}) {
  return { t: 'rx', id: '2'.repeat(32), peer: PEER, from: PEER, to: SELF, target: { from: SELF, id: '3'.repeat(32), digest: 'c'.repeat(64) }, emoji: '❤️', rev: 1, at: AT, mine: false, n: 1, ...extra }
}

test('a plain row passes; the same checks as a received row refuse the rest', (t) => {
  t.ok(cleanRow(msg(), SELF, NO_BLOCKS), 'a received message')
  t.ok(cleanRow(msg({ from: SELF, peer: PEER, mine: true }), SELF, NO_BLOCKS), 'an own message')
  t.ok(cleanRow(reaction(), SELF, NO_BLOCKS), 'a reaction')
  t.ok(cleanRow({ t: 'ctl', id: '4'.repeat(32), op: 'accepted', peer: PEER, at: AT, n: 2 }, SELF, NO_BLOCKS), 'an op')

  t.is(cleanRow(msg({ text: 'a\u0007b' }), SELF, NO_BLOCKS), null, 'a control character')
  t.is(cleanRow(msg({ text: 'a\ud800b' }), SELF, NO_BLOCKS), null, 'a lone surrogate')
  t.is(cleanRow(msg({ text: 'x'.repeat(1001) }), SELF, NO_BLOCKS), null, 'more than 1000 code points')
  t.ok(cleanRow(msg({ text: 'x'.repeat(1000) }), SELF, NO_BLOCKS), 'exactly 1000 code points')
  t.is(cleanRow(msg({ text: '' }), SELF, NO_BLOCKS), null, 'empty text with no photo')
  t.is(cleanRow(msg({ at: '2026-11-03' }), SELF, NO_BLOCKS), null, 'a time that is not canonical ISO')
  t.is(cleanRow(msg({ at: '2026-11-03T12:00:00Z' }), SELF, NO_BLOCKS), null, 'an ISO time without milliseconds')
  t.is(cleanRow(msg({ mine: true }), SELF, NO_BLOCKS), null, 'mine without the own key as sender')
  t.is(cleanRow(msg({ from: SELF, mine: false }), SELF, NO_BLOCKS), null, 'the own key as sender, not mine')
  t.is(cleanRow(msg({ peer: SELF, from: SELF, mine: true }), SELF, NO_BLOCKS), null, 'peer is the own key')
  t.is(cleanRow(msg({ peer: 'c'.repeat(64) }), SELF, NO_BLOCKS), null, 'a received message whose peer is not its sender')
  t.is(cleanRow({ ...msg(), n: -1 }, SELF, NO_BLOCKS), null, 'a bad position')
  t.is(cleanRow(reaction({ at: 'ontem' }), SELF, NO_BLOCKS), null, 'a reaction with a bad time')
  t.is(cleanRow(reaction({ mine: true }), SELF, NO_BLOCKS), null, 'a reaction with a wrong mine')
})

test('a sender the member or the association blocks is not filed', (t) => {
  const blocked = new Set([PEER])
  t.is(cleanRow(msg(), SELF, blocked), null, 'a blocked sender')
  t.is(cleanRow(reaction(), SELF, blocked), null, 'a blocked sender reaction')
  t.ok(cleanRow(msg({ from: SELF, peer: PEER, mine: true }), SELF, blocked), 'an own message to a blocked peer stays')
  t.ok(cleanRow({ t: 'ctl', id: '4'.repeat(32), op: 'blocked', peer: PEER, at: AT, n: 2 }, SELF, blocked), 'the block op itself stays')
})

test('shownAt is a bounded safe integer on a message row, and the store keeps it', async (t) => {
  t.is(cleanRow(msg({ shownAt: 1700000000000 }), SELF, NO_BLOCKS).row.shownAt, 1700000000000, 'kept')
  t.is(cleanRow(msg({ shownAt: -1 }), SELF, NO_BLOCKS), null, 'negative')
  t.is(cleanRow(msg({ shownAt: 1.5 }), SELF, NO_BLOCKS), null, 'fractional')
  t.is(cleanRow(msg({ shownAt: '17' }), SELF, NO_BLOCKS), null, 'not a number')
  t.is(cleanRow(msg({ shownAt: 9e15 }), SELF, NO_BLOCKS), null, 'past the time bound')

  const s = createDmStore({ storage: memoryNodeStorage() })
  await s.unlock(new Uint8Array(32).fill(7))
  await s.loaded()
  t.teardown(() => s.close(), { force: true })
  const shown = { ...msg({ shownAt: 1700000000000 }), filedAt: 5 }
  delete shown.n
  await s.append([shown])
  t.is(s.snapshot().messages[0].shownAt, 1700000000000, 'the store holds it')
  const plain = { ...msg({ id: '9'.repeat(32) }), filedAt: 6 }
  delete plain.n
  await s.append([plain])
  t.is(s.snapshot().messages.find((m) => m.id === '9'.repeat(32)).shownAt, undefined, 'a row without it stays without')
})

test('the maker refuses what the reader would drop, before it spends anything', (t) => {
  const row = { n: 0, t: 'msg', text: 'x' }
  const rows = (n) => Array.from({ length: n }, () => row)
  t.execution(() => checkLimits([rows(3)]), 'a small history')
  t.execution(() => checkLimits([rows(0), rows(2)]), 'an empty store counts for nothing')
  const small = { rows: 4, parts: 2, stores: 2, manifest: LIMITS.manifest }
  t.execution(() => checkLimits([rows(4), rows(1)], small), 'at the limits')
  for (const [sets, why] of [[[rows(5)], 'rows in a store'], [[rows(1), rows(1), rows(1)], 'stores']]) {
    try {
      checkLimits(sets, small)
      t.fail(why)
    } catch (err) {
      t.ok(err instanceof UsageError && err.message === TOO_BIG, why)
    }
  }
  const big = Array.from({ length: 3 }, () => ({ n: 0, t: 'msg', text: 'y'.repeat(600000) }))
  try {
    checkLimits([big], { ...small, rows: 10, parts: 1 })
    t.fail('parts')
  } catch (err) {
    t.ok(err instanceof UsageError && err.message === TOO_BIG, 'parts in a store')
  }
  t.ok(manifestBytes(LIMITS.stores, LIMITS.parts * LIMITS.stores) > LIMITS.manifest, 'the widest manifest would not fit the reader')
  try {
    checkLimits([rows(1)], { ...small, manifest: 100 })
    t.fail('manifest')
  } catch (err) {
    t.ok(err instanceof UsageError, 'a manifest over its limit')
  }
})
