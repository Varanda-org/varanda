'use strict'

// The periodic rotation policy (lib/group-rekey.js): every boundary of the
// due decision, the facts read from a group's cores and the in-memory gate.
const test = require('brittle')
const grp = require('../lib/group')
const {
  REKEY_PERIOD_MS, REKEY_RECORDS, REKEY_MAX_SCALE, REKEY_OTHER_WAIT_MS, REKEY_JITTER_MS, REKEY_CHECK_MS,
  rekeyScale, rekeyDue, epochFacts, createRekeyGate
} = require('../lib/group-rekey')

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-11-01T00:00:00.000Z')
const E = { writer: 'aa'.repeat(32), seq: 1 }
const ROOM = { length: 10, bytes: 1000, maxBlocks: 1000, maxBytes: 100000 }

// A group of `entitled` writers whose epoch opened at T0 with `n` envelopes
// written at T0 + 1 s each.
function input (over = {}) {
  const n = over.n === undefined ? 1 : over.n
  return {
    rekeyPending: false,
    epoch: E,
    epochAt: T0,
    sealedAts: Array.from({ length: n }, (_, i) => T0 + 1000 * (i + 1)),
    entitled: 1,
    ownEpoch: true,
    now: T0,
    jitter: 0,
    log: ROOM,
    ...over
  }
}

test('scale: 1 to 8 by entitled writers, 64 per step', (t) => {
  t.is(rekeyScale(0), 1)
  t.is(rekeyScale(1), 1)
  t.is(rekeyScale(64), 1)
  t.is(rekeyScale(65), 2)
  t.is(rekeyScale(128), 2)
  t.is(rekeyScale(129), 3)
  t.is(rekeyScale(512), 8)
  t.is(rekeyScale(513), REKEY_MAX_SCALE, 'capped')
  t.is(rekeyScale(100000), 8)
  t.is(rekeyScale(-3), 1)
  t.is(rekeyScale(NaN), 1)
})

test('age: due at T x s from the epoch\'s first block, s = 1, 2 and 8', (t) => {
  for (const [entitled, s] of [[1, 1], [64, 1], [65, 2], [128, 2], [512, 8], [600, 8]]) {
    const due = T0 + REKEY_PERIOD_MS * s
    const before = rekeyDue(input({ entitled, now: due - 1 }))
    t.is(before.due, false, entitled + ' writers: not due 1 ms before')
    t.is(before.at, due, entitled + ' writers: due at T x ' + s)
    t.is(before.reason, 'young')
    const at = rekeyDue(input({ entitled, now: due }))
    t.alike(at, { due: true, at: due, reason: 'age' }, entitled + ' writers: due at exactly T x ' + s)
  }
  t.is(REKEY_PERIOD_MS, 7 * DAY, 'T is 7 days')
})

test('count: due at N x s envelopes, s = 1, 2 and 8', (t) => {
  t.is(REKEY_RECORDS, 1000, 'N is 1000')
  for (const [entitled, s] of [[1, 1], [65, 2], [512, 8]]) {
    const n = REKEY_RECORDS * s
    const now = T0 + DAY
    const under = rekeyDue(input({ entitled, n: n - 1, now }))
    t.is(under.due, false, (n - 1) + ' envelopes: not due')
    t.is(under.at, T0 + REKEY_PERIOD_MS * s, 'the age still sets the date')
    const at = rekeyDue(input({ entitled, n, now }))
    t.is(at.due, true, n + ' envelopes: due')
    t.is(at.reason, 'count')
    t.is(at.at, T0 + 1000 * n, 'due since the Nth envelope\'s at')
  }
})

test('an idle group never rotates, however old', (t) => {
  const r = rekeyDue(input({ n: 0, now: T0 + 365 * DAY }))
  t.alike(r, { due: false, at: null, reason: 'idle' })
})

test('rekey-pending and a null epoch never rotate periodically', (t) => {
  const late = T0 + 365 * DAY
  t.alike(rekeyDue(input({ rekeyPending: true, now: late })), { due: false, at: null, reason: 'rekey-pending' })
  t.alike(rekeyDue(input({ epoch: null, now: late })), { due: false, at: null, reason: 'no-epoch' })
})

test('an epoch at in the future counts as now', (t) => {
  const now = T0 + DAY
  const r = rekeyDue(input({ epochAt: T0 + 100 * DAY, now }))
  t.is(r.due, false)
  t.is(r.at, now + REKEY_PERIOD_MS, 'the age starts now, not in the future')
  // Envelopes from the future count as written now.
  const future = Array.from({ length: REKEY_RECORDS }, () => T0 + 100 * DAY)
  const c = rekeyDue(input({ sealedAts: future, now }))
  t.alike(c, { due: true, at: now, reason: 'count' })
  // An unknown first-block at also starts the age now.
  t.is(rekeyDue(input({ epochAt: null, now })).at, now + REKEY_PERIOD_MS)
})

test('tie-break: the opener rotates when due, another distributor waits 48 h plus its jitter', (t) => {
  const due = T0 + REKEY_PERIOD_MS
  t.is(rekeyDue(input({ now: due })).due, true, 'own epoch: at once')
  t.is(REKEY_OTHER_WAIT_MS, 48 * 60 * 60 * 1000)
  t.is(REKEY_JITTER_MS, 6 * 60 * 60 * 1000)
  for (const jitter of [0, 0.5, 0.999999]) {
    const wait = due + REKEY_OTHER_WAIT_MS + Math.floor(jitter * REKEY_JITTER_MS)
    const before = rekeyDue(input({ ownEpoch: false, jitter, now: wait - 1 }))
    t.alike(before, { due: false, at: wait, reason: 'waiting' }, 'jitter ' + jitter + ': waits')
    t.ok(before.at >= due + REKEY_OTHER_WAIT_MS && before.at < due + REKEY_OTHER_WAIT_MS + REKEY_JITTER_MS, 'within the jitter bounds')
    t.is(rekeyDue(input({ ownEpoch: false, jitter, now: wait })).due, true, 'jitter ' + jitter + ': due after the wait')
  }
  // Out-of-range jitter is clamped.
  t.is(rekeyDue(input({ ownEpoch: false, jitter: 7, now: due })).at, due + REKEY_OTHER_WAIT_MS + REKEY_JITTER_MS)
  t.is(rekeyDue(input({ ownEpoch: false, jitter: -1, now: due })).at, due + REKEY_OTHER_WAIT_MS)
  // The count trigger waits from the Nth envelope too, not from each check.
  const nth = T0 + 1000 * REKEY_RECORDS
  const counted = rekeyDue(input({ ownEpoch: false, n: REKEY_RECORDS, now: nth + DAY }))
  t.alike(counted, { due: false, at: nth + REKEY_OTHER_WAIT_MS, reason: 'waiting' })
})

test('backdated envelopes count from the epoch\'s at: a non-opener still waits, as with honest dates', (t) => {
  const now = T0 + DAY
  const honest = rekeyDue(input({ ownEpoch: false, sealedAts: Array.from({ length: REKEY_RECORDS }, (_, i) => now - REKEY_RECORDS + i), now }))
  t.is(honest.reason, 'waiting', 'honest dates: waits')
  t.ok(honest.at > now)
  const backdated = rekeyDue(input({ ownEpoch: false, sealedAts: Array.from({ length: REKEY_RECORDS }, () => 0), now }))
  t.alike(backdated, { due: false, at: T0 + REKEY_OTHER_WAIT_MS, reason: 'waiting' }, 'dated 1970: counted at the epoch\'s at, still waiting')
  t.ok(backdated.at > now, 'not due at once')
  // The opener's count due moment is clamped the same way.
  t.alike(rekeyDue(input({ sealedAts: Array.from({ length: REKEY_RECORDS }, () => 0), now })), { due: true, at: T0, reason: 'count' })
})

test('log reserve: under 10% of blocks or bytes left, no periodic rotation', (t) => {
  const now = T0 + REKEY_PERIOD_MS
  const at10 = { length: 900, bytes: 90000, maxBlocks: 1000, maxBytes: 100000 }
  t.is(rekeyDue(input({ now, log: at10 })).due, true, 'exactly 10% left of both: still rotates')
  t.alike(rekeyDue(input({ now, log: { ...at10, length: 901 } })), { due: false, at: null, reason: 'log-reserve' }, 'blocks under 10%')
  t.alike(rekeyDue(input({ now, log: { ...at10, bytes: 90001 } })), { due: false, at: null, reason: 'log-reserve' }, 'bytes under 10%')
  t.is(rekeyDue(input({ now, log: { length: NaN } })).reason, 'log-reserve', 'an unknown budget keeps the reserve')
  t.is(rekeyDue(input({ now, log: null })).due, true, 'no log given: not checked')
})

test('the decision needs a clock', (t) => {
  t.exception.all(() => rekeyDue({ epoch: E }), /now required/)
})

test('gate: one check per group per hour, a clock going back never locks it', (t) => {
  let now = T0
  const gate = createRekeyGate({ now: () => now, random: () => 0.25 })
  t.is(REKEY_CHECK_MS, 60 * 60 * 1000)
  t.ok(gate.ready('g'), 'never checked')
  gate.checked('g')
  t.absent(gate.ready('g'), 'just checked')
  t.ok(gate.ready('h'), 'another group is free')
  t.is(gate.readyAt('h'), T0, 'free now')
  t.is(gate.readyAt('g'), T0 + REKEY_CHECK_MS, 'free an hour after the check')
  now += REKEY_CHECK_MS - 1
  t.absent(gate.ready('g'), 'one ms short of the hour')
  t.is(gate.readyAt('g'), T0 + REKEY_CHECK_MS)
  now += 1
  t.ok(gate.ready('g'), 'an hour later')
  t.is(gate.readyAt('g'), now)
  gate.checked('g')
  now -= 10 * DAY
  t.ok(gate.ready('g'), 'clock went back')
  t.is(gate.readyAt('g'), now)
  t.is(gate.now(), now)
})

test('gate: the jitter is drawn once per epoch from the random source', (t) => {
  const draws = [0.1, 0.9, 0.5]
  const gate = createRekeyGate({ now: () => T0, random: () => draws.shift() })
  t.is(gate.jitter('g', E), 0.1)
  t.is(gate.jitter('g', E), 0.1, 'same epoch, same jitter')
  t.is(gate.jitter('g', { writer: E.writer, seq: 9 }), 0.9, 'a new epoch draws again')
  t.is(gate.jitter('h', E), 0.5, 'per group')
  const odd = createRekeyGate({ now: () => T0, random: () => 3 })
  t.is(odd.jitter('g', E), 1, 'clamped')
})

test('gate: bounded memory, the oldest group goes first', (t) => {
  const now = T0
  const gate = createRekeyGate({ now: () => now, max: 2 })
  gate.checked('a')
  gate.checked('b')
  gate.checked('c')
  t.ok(gate.ready('a'), 'a forgotten')
  t.absent(gate.ready('b'))
  t.absent(gate.ready('c'))
})

test('facts: epoch at and the counted, valid envelopes under it', (t) => {
  const G = 'cc'.repeat(32)
  const W = 'dd'.repeat(32)
  const X = 'ee'.repeat(32)
  const kid = { writer: G, seq: 1 }
  const other = { writer: W, seq: 4 }
  const nonce = '00'.repeat(24)
  const box = Buffer.alloc(40).toString('base64')
  const at = (d) => new Date(T0 + d * DAY).toISOString()
  const first = grp.groupKey({ kid: null, basis: [], keys: [{ writer: G, sealed: Buffer.alloc(96).toString('base64') }], commit: 'ab'.repeat(32), at: at(0) })
  const sealed = (k, d) => grp.groupSealed({ kid: k, nonce, box, at: at(d) })
  const logs = [
    { key: G, entries: [{ seq: 0, record: { type: 'group-header' } }, { seq: 1, record: first }, { seq: 2, record: sealed(kid, 1) }] },
    { key: W, entries: [{ seq: 1, record: sealed(kid, 2) }, { seq: 2, record: sealed(other, 3) }, { seq: 3, record: { ...sealed(kid, 4), extra: 1 } }] },
    { key: X, entries: [{ seq: 1, record: sealed(kid, 5) }] }
  ]
  const facts = epochFacts({ logs, counted: new Set([G, W]), root: G, epoch: kid })
  t.is(facts.epochAt, T0)
  t.alike(facts.sealedAts, [T0 + DAY, T0 + 2 * DAY], 'other epochs, invalid records and uncounted writers left out')
  t.alike(epochFacts({ logs, counted: new Set([G]), root: G, epoch: null }), { epochAt: null, sealedAts: [] })
})
