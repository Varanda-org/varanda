'use strict'

// Connection slots shared by address (issue #32): address grouping and the
// pure slot table, with an injected clock. No network.
const test = require('brittle')
const { PROBATION_MS, IPV6_GROUP_BITS, addressGroup, createSlots } = require('../lib/peer-slots')

function fakeClock (start = 0) {
  const c = { t: start, now: () => c.t }
  return c
}

const certified = (e) => Boolean(e.data && e.data.certified)

// Admits `n` entries of `group`, advancing the clock by `step` after each.
function fill (slots, clock, group, n, step = 1) {
  const out = []
  for (let i = 0; i < n; i++) {
    const r = slots.admit(group)
    if (r === null) throw new Error('fill refused')
    out.push(r.entry)
    clock.t += step
  }
  return out
}

function live (slots) {
  return Array.from(slots.entries())
}

test('constants', (t) => {
  t.is(PROBATION_MS, 10000)
  t.is(IPV6_GROUP_BITS, 64)
})

test('addressGroup', (t) => {
  const table = [
    ['1.2.3.4', '1.2.3.4'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['127.0.0.1', '127.0.0.1'],
    ['01.2.3.4', 'unknown'],
    ['1.2.3.04', 'unknown'],
    ['00.0.0.0', 'unknown'],
    ['256.1.1.1', 'unknown'],
    ['1.2.3.1000', 'unknown'],
    ['1.2.3', 'unknown'],
    ['1.2.3.4.5', 'unknown'],
    ['1.2.3.', 'unknown'],
    ['1..3.4', 'unknown'],
    ['+1.2.3.4', 'unknown'],
    [' 1.2.3.4', 'unknown'],
    ['1.2.3.4 ', 'unknown'],
    ['1.2.3.4%eth0', 'unknown'],
    ['[1.2.3.4]', 'unknown'],
    ['0x1.2.3.4', 'unknown'],
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::FFFF:1.2.3.4', '1.2.3.4'],
    ['::ffff:102:304', '1.2.3.4'],
    ['0:0:0:0:0:ffff:1.2.3.4', '1.2.3.4'],
    ['[::ffff:1.2.3.4]', '1.2.3.4'],
    ['::ffff:01.2.3.4', 'unknown'],
    ['::ffff:256.2.3.4', 'unknown'],
    ['2001:db8:0:1:2:3:4:5', '2001:db8:0:1::/64'],
    ['2001:0db8:0000:0001:0002:0003:0004:0005', '2001:db8:0:1::/64'],
    ['2001:DB8:0:1:FFFF:0:0:1', '2001:db8:0:1::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8:0:1::', '2001:db8:0:1::/64'],
    ['2001:db8:0:1::7', '2001:db8:0:1::/64'],
    ['::2001:db8:0:1:2', '0:0:0:2001::/64'],
    ['1:2:3:4:5:6:7::', '1:2:3:4::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::', '0:0:0:0::/64'],
    ['[2001:db8::1]', '2001:db8:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['[fe80::1%25]', 'fe80:0:0:0::/64'],
    ['fe80::1%', 'unknown'],
    ['fe80::1%a b', 'unknown'],
    ['[2001:db8::1', 'unknown'],
    ['2001:db8::1]', 'unknown'],
    ['1:2:3:4:5:6:7', 'unknown'],
    ['1:2:3:4:5:6:7:8:9', 'unknown'],
    ['1:2:3:4:5:6:7:8::', 'unknown'],
    ['1::2::3', 'unknown'],
    [':::', 'unknown'],
    [':1:2:3:4:5:6:7', 'unknown'],
    ['1:2:3:4:5:6:7:', 'unknown'],
    ['12345::1', 'unknown'],
    ['g::1', 'unknown'],
    ['1.2.3.4::', 'unknown'],
    ['1.2.3.4:1::', 'unknown'],
    ['example.com', 'unknown'],
    ['localhost', 'unknown'],
    ['', 'unknown'],
    ['a'.repeat(1000), 'unknown'],
    [':'.repeat(1000), 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    [16909060, 'unknown'],
    [{ toString: () => '1.2.3.4' }, 'unknown'],
    [['1.2.3.4'], 'unknown']
  ]
  for (const [input, expected] of table) {
    t.is(addressGroup(input), expected, JSON.stringify(String(input)).slice(0, 40) + ' -> ' + expected)
  }
  // Two hosts in one /64 share a group; another /64 does not.
  t.is(addressGroup('2001:db8:0:1::a'), addressGroup('2001:db8:0:1:ffff::b'))
  t.not(addressGroup('2001:db8:0:1::a'), addressGroup('2001:db8:0:2::a'))
})

test('createSlots validates its options', (t) => {
  for (const limit of [undefined, null, 0, -1, 1.5, '2', NaN, Infinity]) {
    t.exception.all(() => createSlots({ limit }), /limit/, 'limit ' + String(limit))
  }
  t.exception.all(() => createSlots(), /limit/, 'no options')
  t.exception.all(() => createSlots({ limit: 1, probationMs: -1 }), /probationMs/)
  t.exception.all(() => createSlots({ limit: 1, now: 3 }), /now/)
  t.exception.all(() => createSlots({ limit: 1, isProtected: true }), /isProtected/)
  t.ok(createSlots({ limit: 1 }))
})

test('admits under the limit, with no victim', (t) => {
  const clock = fakeClock(5)
  const slots = createSlots({ limit: 3, now: clock.now })
  t.is(slots.size, 0)
  const a = slots.admit('1.1.1.1')
  t.alike(a.entry, { group: '1.1.1.1', since: 5, data: null })
  t.is(a.victim, null)
  clock.t = 6
  const b = slots.admit('1.1.1.1')
  const c = slots.admit('2.2.2.2')
  t.is(b.victim, null)
  t.is(c.victim, null)
  t.is(slots.size, 3)
  t.is(slots.count('1.1.1.1'), 2)
  t.is(slots.count('2.2.2.2'), 1)
  t.is(slots.count('3.3.3.3'), 0)
  t.alike(live(slots), [a.entry, b.entry, c.entry], 'insertion order')
  const r = slots.admit(42)
  t.is(r.entry.group, 'unknown', 'a non-string group shares the unknown group')
})

test('full with one group, every entry in probation: refused', (t) => {
  const clock = fakeClock()
  const slots = createSlots({ limit: 4, now: clock.now })
  fill(slots, clock, 'A', 4)
  t.is(slots.admit('A'), null, 'same group refused')
  t.is(slots.size, 4)
  t.is(slots.count('A'), 4)

  // With one slot, another address only gets in by the equal share, after
  // probation.
  const c1 = fakeClock()
  const one = createSlots({ limit: 1, now: c1.now })
  const [a] = fill(one, c1, 'A', 1)
  t.is(one.admit('B'), null, 'other group refused inside probation')
  c1.t = PROBATION_MS
  const r = one.admit('B')
  t.is(r.victim, a, 'equal share after probation')
  t.is(one.count('A'), 0)
  t.is(one.count('B'), 1)
})

test('fair share displaces the newest unprotected entry of the largest group, even in probation', (t) => {
  const clock = fakeClock()
  const slots = createSlots({ limit: 6, now: clock.now, isProtected: certified })
  const as = fill(slots, clock, 'A', 4)
  const bs = fill(slots, clock, 'B', 2)
  const r = slots.admit('C')
  t.ok(r, 'admitted')
  t.is(r.victim, as[3], 'newest of A, the largest group')
  t.absent(live(slots).includes(as[3]))
  t.is(slots.count('A'), 3)
  t.is(slots.count('C'), 1)

  // The newest A is protected: it is never the victim and no longer counts
  // toward A's share, so A (2 unprotected) ties with B and the newest
  // across both goes.
  as[2].data = { certified: true }
  const r2 = slots.admit('D')
  t.is(r2.victim, bs[1], 'protected entry skipped and not counted')
  t.ok(live(slots).includes(as[2]))
  t.ok(live(slots).includes(as[1]) && live(slots).includes(bs[0]))
})

test('protected entries do not count toward their address, so its newcomers still get in', (t) => {
  // A shared address L holds 5 proven entries; another address A fills the
  // rest with 3 young entries. A newcomer of L has no unprotected entry, so
  // A gives way at once (fair share), and so does a later one.
  const clock = fakeClock()
  const slots = createSlots({ limit: 8, now: clock.now, isProtected: certified })
  const ls = fill(slots, clock, 'L', 5)
  for (const e of ls) e.data = { certified: true }
  const as = fill(slots, clock, 'A', 3)
  const r = slots.admit('L')
  t.ok(r, 'the L newcomer is admitted inside A probation')
  t.is(r.victim, as[2], 'by displacing the newest A entry')
  r.entry.data = { certified: true }
  const r2 = slots.admit('L')
  t.ok(r2 && as.includes(r2.victim), 'a second proven L newcomer too')
  t.ok(ls.every((e) => live(slots).includes(e)), 'the proven entries stay')
})

test('groups one apart never swap their established entries', (t) => {
  // X 32, Y 31, U 1, all expired. A Y newcomer may only rotate its own
  // address; redials of the displaced clients never cascade into X.
  const clock = fakeClock()
  const slots = createSlots({ limit: 64, now: clock.now })
  const xs = fill(slots, clock, 'X', 32)
  fill(slots, clock, 'Y', 31)
  const [u] = fill(slots, clock, 'U', 1)
  clock.t += PROBATION_MS
  let group = 'Y'
  for (let i = 0; i < 12; i++) {
    const r = slots.admit(group)
    t.ok(r, 'redial ' + i + ' admitted')
    t.is(r.victim.group, group, 'only its own address rotates (' + i + ')')
    group = r.victim.group
    clock.t += PROBATION_MS
  }
  t.ok(xs.every((e) => live(slots).includes(e)), 'no X entry displaced')
  t.ok(live(slots).includes(u), 'U kept')
  t.is(slots.count('X'), 32)
  t.is(slots.count('Y'), 31)
})

test('protected entries are never displaced; a throwing isProtected counts as unprotected', (t) => {
  const clock = fakeClock()
  const slots = createSlots({ limit: 3, now: clock.now, isProtected: certified })
  const as = fill(slots, clock, 'A', 3)
  for (const e of as) e.data = { certified: true }
  t.is(slots.admit('B'), null, 'fair share finds no candidate')
  clock.t += PROBATION_MS * 10
  t.is(slots.admit('B'), null, 'nor after probation')
  t.is(slots.admit('A'), null, 'nor a rotation of the same address')
  t.alike(live(slots), as)

  const c2 = fakeClock()
  let calls = 0
  const throwing = createSlots({
    limit: 2,
    now: c2.now,
    isProtected: () => {
      calls++
      throw new Error('boom')
    }
  })
  const xs = fill(throwing, c2, 'X', 2)
  const r = throwing.admit('Y')
  t.is(r.victim, xs[1], 'displaced despite the throw')
  t.ok(calls > 0, 'isProtected was consulted')

  const c3 = fakeClock()
  const truthy = createSlots({ limit: 2, now: c3.now, isProtected: () => 1 })
  fill(truthy, c3, 'X', 2)
  t.ok(truthy.admit('Y'), 'only true protects')
})

test('isProtected is evaluated at decision time, with the entry', (t) => {
  const clock = fakeClock()
  const seen = []
  const slots = createSlots({
    limit: 2,
    now: clock.now,
    isProtected: (e) => {
      seen.push(e)
      return certified(e)
    }
  })
  const xs = fill(slots, clock, 'X', 2)
  t.is(seen.length, 0, 'not called while there is room')
  xs[1].data = { certified: true }
  xs[0].data = { certified: true }
  t.is(slots.admit('Y'), null, 'protection set after admission counts')
  t.ok(seen.every((e) => xs.includes(e)))
  xs[0].data = null
  t.is(slots.admit('Y'), null, 'X now holds one unprotected entry, still in probation')
  clock.t += PROBATION_MS
  t.is(slots.admit('Y').victim, xs[0], 'protection removed later counts too')
})

test('an address with no slot takes an expired one; an address one behind does not', (t) => {
  const clock = fakeClock()
  const slots = createSlots({ limit: 2, now: clock.now })
  const [a] = fill(slots, clock, 'A', 1)
  const [b] = fill(slots, clock, 'B', 1)
  t.is(slots.admit('C'), null, 'C has no slot but every entry is in probation')
  clock.t = a.since + PROBATION_MS - 1
  t.is(slots.admit('C'), null, 'one millisecond short')
  clock.t = a.since + PROBATION_MS
  t.is(slots.admit('C').victim, a, 'C takes the expired entry')
  t.ok(live(slots).includes(b), 'B, still in probation, stays')

  const c2 = fakeClock()
  const s2 = createSlots({ limit: 3, now: c2.now })
  const as = fill(s2, c2, 'A', 2)
  const [b2] = fill(s2, c2, 'B', 1)
  c2.t += PROBATION_MS
  t.is(s2.admit('B').victim, b2, 'B, one behind A, only rotates its own entry')
  t.is(s2.admit('B'), null, 'and waits while its own entry is in probation')
  t.ok(as.every((e) => live(s2).includes(e)), 'A untouched')
})

test('same-address rotation needs probation and never touches another address', (t) => {
  const clock = fakeClock()
  const slots = createSlots({ limit: 2, now: clock.now })
  const [a] = fill(slots, clock, 'A', 1)
  const [b] = fill(slots, clock, 'B', 1)
  t.is(slots.admit('A'), null, 'own entry in probation')
  clock.t += PROBATION_MS
  const r = slots.admit('A')
  t.is(r.victim, a, 'rotates its own expired entry')
  t.ok(live(slots).includes(b), 'B untouched although expired')
  t.is(slots.count('A'), 1)

  // The fresh A is in probation again: refused. A third address takes the
  // expired B by equal share (B holds one more than C), never the young A.
  t.is(slots.admit('A'), null)
  const c = slots.admit('C')
  t.is(c.victim, b, 'equal share takes the expired entry')
  t.is(slots.count('A'), 1)
})

test('victim choice: largest group first, newest within, ties by most recent admission', (t) => {
  const clock = fakeClock()
  const slots = createSlots({ limit: 5, now: clock.now })
  const as = fill(slots, clock, 'A', 3)
  const bs = fill(slots, clock, 'B', 2)
  clock.t += PROBATION_MS
  const r = slots.admit('C')
  t.is(r.victim, as[2], 'A is larger even though B entries are newer')

  // Equal since: the most recently admitted goes.
  const c2 = fakeClock(100)
  const same = createSlots({ limit: 3, now: c2.now })
  const xs = fill(same, c2, 'X', 3, 0)
  t.is(same.admit('Y').victim, xs[2])
  t.is(same.admit('Z').victim, xs[1])

  // Two groups tied on count: the newest across both, then by admission.
  const c3 = fakeClock()
  const tied = createSlots({ limit: 4, now: c3.now })
  const ps = fill(tied, c3, 'P', 2)
  const qs = fill(tied, c3, 'Q', 2)
  t.is(tied.admit('R').victim, qs[1], 'newest across tied groups')
  t.ok(live(slots).includes(bs[0]))
  t.ok(ps.every((e) => live(tied).includes(e)))
})

test('remove is idempotent and keeps counts consistent', (t) => {
  const clock = fakeClock()
  const slots = createSlots({ limit: 3, now: clock.now })
  const [a1, a2] = fill(slots, clock, 'A', 2)
  const [b] = fill(slots, clock, 'B', 1)
  t.is(slots.remove(a1), true)
  t.is(slots.remove(a1), false, 'second remove is a no-op')
  t.is(slots.size, 2)
  t.is(slots.count('A'), 1)
  t.alike(live(slots), [a2, b])
  t.is(slots.remove({ group: 'A', since: 0, data: null }), false, 'a foreign entry is ignored')
  t.is(slots.count('A'), 1)
  t.is(slots.remove(a2), true)
  t.is(slots.count('A'), 0)
  t.is(slots.remove(b), true)
  t.is(slots.size, 0)

  // A displaced victim is already removed; the caller's later remove (on
  // its socket close) changes nothing.
  const xs = fill(slots, clock, 'X', 3)
  const r = slots.admit('Y')
  t.is(r.victim, xs[2])
  t.is(slots.remove(r.victim), false)
  t.is(slots.size, 3)
  t.is(slots.count('X'), 2)
  t.is(slots.count('Y'), 1)
  // Room again after a removal: no victim.
  slots.remove(xs[0])
  t.is(slots.admit('X').victim, null)
  t.is(slots.size, 3)
})

test('adversarial (i): one address fills the table, newcomers still get in', (t) => {
  const clock = fakeClock()
  const limit = 8
  const slots = createSlots({ limit, now: clock.now })
  const flood = fill(slots, clock, 'X', limit)
  const y = slots.admit('Y')
  t.ok(y, 'a newcomer from another address is admitted')
  t.ok(flood.includes(y.victim), 'by displacing a flood entry')
  t.is(slots.count('X'), limit - 1)

  // Flood newcomers inside probation: refused.
  for (let i = 0; i < 20; i++) {
    clock.t += 1
    t.is(slots.admit('X'), null, 'flood refused in probation ' + i)
  }
  t.ok(live(slots).includes(y.entry))

  // More distinct addresses keep getting in, still inside probation.
  const others = []
  for (const g of ['Z1', 'Z2', 'Z3']) {
    const r = slots.admit(g)
    t.ok(r && r.victim.group === 'X', g + ' displaces a flood entry')
    others.push(r.entry)
  }
  t.is(slots.count('X'), limit - 4)

  // After probation the flood only rotates its own expired entries.
  clock.t += PROBATION_MS
  for (let i = 0; i < 20; i++) {
    const r = slots.admit('X')
    t.ok(r, 'flood rotation ' + i)
    t.is(r.victim.group, 'X', 'only its own address')
    clock.t += PROBATION_MS
  }
  t.ok(live(slots).includes(y.entry), 'Y kept')
  t.ok(others.every((e) => live(slots).includes(e)), 'the other addresses kept')
  t.is(slots.count('X'), limit - 4)
})

test('adversarial (ii): shared address keeps its certified entries, a newcomer gets in after probation', (t) => {
  const clock = fakeClock()
  const limit = 6
  const slots = createSlots({ limit, now: clock.now, isProtected: certified })
  const certs = fill(slots, clock, 'S', 2)
  for (const e of certs) e.data = { certified: true }
  const sFlood = fill(slots, clock, 'S', limit - 2)

  t.is(slots.admit('S'), null, 'a same-address flood newcomer is refused in probation')

  // A flood from another address takes only unprotected S entries.
  const fFlood = []
  for (let i = 0; i < 20; i++) {
    const r = slots.admit('F')
    if (r === null) continue
    t.ok(sFlood.includes(r.victim), 'F displaced an unprotected S entry')
    fFlood.push(r.entry)
    clock.t += 1
  }
  t.ok(certs.every((e) => live(slots).includes(e)), 'certified entries survive the F flood in probation')

  // After probation both floods keep going; certified entries never move.
  for (let i = 0; i < 40; i++) {
    clock.t += PROBATION_MS / 4
    for (const g of ['S', 'F']) {
      const r = slots.admit(g)
      if (r !== null) {
        t.absent(certs.includes(r.victim), 'never a certified entry')
        if (g === 'S') sFlood.push(r.entry)
        else fFlood.push(r.entry)
      }
    }
  }
  t.ok(certs.every((e) => live(slots).includes(e)), 'certified entries survive both floods')

  // A legitimate newcomer from the shared address once some unprotected
  // entry is past probation.
  clock.t += PROBATION_MS
  const legit = slots.admit('S')
  t.ok(legit, 'the legitimate S newcomer gets in')
  t.absent(certs.includes(legit.victim))
  t.is(legit.victim.data, null, 'the victim is an unprotected flood entry')
  t.ok(certs.every((e) => live(slots).includes(e)))
  t.is(slots.size, limit)
})
