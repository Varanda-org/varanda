'use strict'

// lib/storage-budget.js: charges from signed sizes, the admission test
// against budget - reserve and the member's fair share, served -> leaving
// -> released, the drop order (roots first, then the largest owner, the
// newer admission, the key) down to budget - reserve, what a member past
// its share sheds, and that the order does not depend on insertion order.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const {
  STORAGE_BLOCK_OVERHEAD,
  DEFAULT_STORAGE_BYTES,
  reserveFor,
  memberCapFor,
  coreCharge,
  createStorageBudget
} = require('../lib/storage-budget')

test('constants and charges', (t) => {
  t.is(STORAGE_BLOCK_OVERHEAD, 128)
  t.is(DEFAULT_STORAGE_BYTES, 64 * 1024 * 1024 * 1024)
  t.is(reserveFor(1000), 100)
  t.is(reserveFor(9), 0)
  t.is(coreCharge({ length: 10, byteLength: 5000 }), 5000 + 10 * 128)
  t.is(coreCharge({ length: 0, byteLength: 0 }), 0)
  t.is(coreCharge({}), 0, 'missing sizes count as nothing')
  t.is(coreCharge({ length: -1, byteLength: NaN }), 0, 'negative or missing sizes count as nothing')
  t.is(coreCharge({ length: 10, byteLength: 5000 }, { maxBytes: 1000, maxBlocks: 4 }), 1000 + 4 * 128, 'caps bound a kept part')
})

test('a signed size past the safe integers is never charged as nothing', (t) => {
  const huge = Number.MAX_SAFE_INTEGER * 4
  t.is(coreCharge({ length: 10, byteLength: huge }), Infinity, 'uncapped: unbounded')
  t.is(coreCharge({ length: 10, byteLength: 1.5 }), Infinity, 'a non-integer size is not trusted either')
  t.is(coreCharge({ length: 10, byteLength: huge }, { maxBytes: 1000, maxBlocks: 4 }), 1000 + 4 * 128, 'capped: the cap')
  t.is(coreCharge({ length: Number.MAX_SAFE_INTEGER, byteLength: 0 }), Infinity, 'a sum past the safe integers')
  const b = createStorageBudget({ budget: 1000, reserve: 100 })
  t.is(b.reserveCharge('a', Infinity), false, 'no admission fits it')
  t.is(b.stats().reserved, 0)
  t.ok(b.reserveCharge('b', 900), 'the budget is untouched')
})

test('constructor validates budget and reserve', (t) => {
  t.exception.all(() => createStorageBudget({}), /budget/)
  t.exception.all(() => createStorageBudget({ budget: 0 }), /budget/)
  t.exception.all(() => createStorageBudget({ budget: 1.5 }), /budget/)
  t.exception.all(() => createStorageBudget({ budget: 100, reserve: 100 }), /reserve/)
  t.exception.all(() => createStorageBudget({ budget: 100, reserve: -1 }), /reserve/)
  const b = createStorageBudget({ budget: 1000 })
  t.is(b.reserve, 100)
  t.is(b.limit, 900)
  t.alike(createStorageBudget({ budget: 1000, reserve: 0 }).limit, 1000)
})

test('admission fits only up to budget - reserve, counting reservations and leaving cores', (t) => {
  const b = createStorageBudget({ budget: 1000, reserve: 100 })
  t.ok(b.room())
  t.ok(b.reserveCharge('a', 500))
  t.absent(b.reserveCharge('b', 401), 'held + reserved + charge > limit')
  t.ok(b.reserveCharge('b', 400), 'exactly the limit fits')
  t.absent(b.room(), 'no room at the limit')
  t.ok(b.reserveCharge('a', 450), 'a second reservation of a key replaces the first')
  t.is(b.stats().reserved, 850)
  b.unreserve('b')
  b.unreserve('b')
  t.is(b.stats().reserved, 450)
  b.set('a', 'A', 600)
  t.alike(b.stats(), { used: 600, served: 600, reserved: 0, budget: 1000, reserve: 100 }, 'set replaces the reservation')
  b.leave('a')
  t.alike(b.stats(), { used: 600, served: 0, reserved: 0, budget: 1000, reserve: 100 }, 'a leaving core is still held')
  t.absent(b.reserveCharge('c', 301), 'a core being purged still takes room')
  b.release('a')
  t.is(b.stats().used, 0)
  t.ok(b.reserveCharge('c', 900))
  b.release('c')
  t.is(b.stats().reserved, 0, 'release clears a reservation')
  t.exception.all(() => b.reserveCharge('d', -1), /charge/)
  t.exception.all(() => b.set('d', 'D', 1.5), /charge/)
  t.exception.all(() => b.set('d', null, 1), /owner/)
})

test('a reservation is the floor of the charge that replaces it', (t) => {
  const b = createStorageBudget({ budget: 1000, reserve: 100 })
  t.ok(b.reserveCharge('a', 500))
  b.set('a', 'A', 0)
  t.alike(b.stats(), { used: 500, served: 500, reserved: 0, budget: 1000, reserve: 100 }, 'a replica still empty at serve keeps the reserved charge')
  t.absent(b.reserveCharge('b', 401), 'so a racing admission cannot overshoot')
  b.set('a', 'A', 300)
  t.is(b.stats().served, 300, 'once served, the core\'s own charge counts')
  b.set('a', 'A', 700)
  t.is(b.stats().served, 700)
})

test('growth may use the reserve; over() only past the budget', (t) => {
  const b = createStorageBudget({ budget: 1000, reserve: 100 })
  b.set('a', 'A', 900)
  t.absent(b.over())
  t.absent(b.room())
  b.set('a', 'A', 1000)
  t.absent(b.over(), 'at the budget is not over it')
  t.alike(b.victims(), [], 'no victims while not over')
  b.set('a', 'A', 1001)
  t.ok(b.over())
})

test('victims: largest owner first, down to budget - reserve', (t) => {
  const b = createStorageBudget({ budget: 1000, reserve: 100 })
  b.set('a', 'A', 300)
  b.set('a-media', 'A', 200) // A = 500
  b.set('b', 'B', 350)
  b.set('c', 'C', 100)
  t.absent(b.over())
  b.set('c', 'C', 200) // served 1050 > 1000
  t.ok(b.over())
  t.alike(b.victims(), [{ owner: 'A', bytes: 500 }], 'one owner is enough: 1050 - 500 <= 900')
  t.alike(b.keysOf('A').sort(), ['a', 'a-media'])
  b.set('b', 'B', 700) // served 1400: A 500, B 700, C 200
  t.alike(b.victims(), [{ owner: 'B', bytes: 700 }], '1400 - 700 = 700 <= 900')
  b.set('c', 'C', 600) // served 1800: B 700, C 600, A 500
  t.alike(b.victims(), [{ owner: 'B', bytes: 700 }, { owner: 'C', bytes: 600 }], '1800 - 700 = 1100 > 900, then - 600 = 500')
})

test('victims: ties go to the newer admission, then to the smaller key', (t) => {
  const b = createStorageBudget({ budget: 1000, reserve: 100 })
  b.set('x', 'X', 400)
  b.set('y', 'Y', 400)
  b.set('z', 'Z', 400)
  const ranks = { X: 0, Y: 2, Z: 1 }
  t.alike(b.victims((o) => ranks[o]), [{ owner: 'Y', bytes: 400 }], 'newest first')
  t.alike(b.victims(() => 5), [{ owner: 'X', bytes: 400 }], 'same rank: smaller key first')
  t.alike(b.victims(() => NaN), [{ owner: 'X', bytes: 400 }], 'a non-finite rank counts as -1')
  t.alike(b.victims(), [{ owner: 'X', bytes: 400 }], 'no rank function')
})

test('victims: every owner when nothing smaller reaches the target', (t) => {
  const b = createStorageBudget({ budget: 100, reserve: 50 })
  b.set('a', 'A', 60)
  b.set('b', 'B', 60)
  t.alike(b.victims(), [{ owner: 'A', bytes: 60 }, { owner: 'B', bytes: 60 }])
})

test('victims do not depend on insertion order', (t) => {
  const rows = []
  for (let i = 0; i < 40; i++) {
    const owner = 'o' + String(i % 13).padStart(2, '0')
    rows.push([owner + '-' + i, owner, 10 + ((i * 37) % 50)])
  }
  const rank = (o) => Number(o.slice(1)) % 4
  const run = (order) => {
    const b = createStorageBudget({ budget: 800, reserve: 200 })
    for (const [key, owner, charge] of order) b.set(key, owner, charge)
    return b.victims(rank)
  }
  const forward = run(rows)
  t.ok(forward.length > 1, 'several victims')
  t.alike(run([...rows].reverse()), forward)
  const shuffled = rows.map((r, i) => [((i * 7919) % 41), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r)
  t.alike(run(shuffled), forward)
})

test('a re-served key replaces its leaving charge', (t) => {
  const b = createStorageBudget({ budget: 1000 })
  b.set('a', 'A', 100)
  b.leave('a')
  b.leave('a')
  t.is(b.stats().used, 100)
  b.set('a', 'A', 150)
  t.alike(b.stats(), { used: 150, served: 150, reserved: 0, budget: 1000, reserve: 100 })
  b.leave('missing')
  b.release('missing')
  t.is(b.stats().used, 150)
})

test('the fair share: a sixteenth of the budget, never less than one full member', (t) => {
  t.is(memberCapFor(DEFAULT_STORAGE_BYTES, 1000), DEFAULT_STORAGE_BYTES / 16)
  t.is(memberCapFor(1600, 1000), 1000)
  t.is(memberCapFor(1601 * 16, 1000), 1601)
  t.is(memberCapFor(1000), 62)
  t.is(createStorageBudget({ budget: 1000 }).memberCap, Infinity)
  t.exception.all(() => createStorageBudget({ budget: 1000, memberCap: 0 }), /memberCap/)
  t.exception.all(() => createStorageBudget({ budget: 1000, memberCap: 1.5 }), /memberCap/)
})

test('an admission past its member\'s share is refused while the budget has room', (t) => {
  const b = createStorageBudget({ budget: 10000, reserve: 0, memberCap: 300 })
  b.set('A', 'A', 100)
  t.is(b.memberUse('A'), 100)
  t.ok(b.reserveCharge('m1', 150, 'A'), 'within the share')
  t.is(b.memberUse('A'), 250)
  t.absent(b.reserveCharge('m2', 51, 'A'), 'past the share')
  t.ok(b.memberRoom('A'), 'room left in the share')
  t.ok(b.reserveCharge('m2', 50, 'A'), 'exactly the share')
  t.absent(b.memberRoom('A'), 'share full')
  t.ok(b.room(), 'the budget still has room')
  t.ok(b.reserveCharge('B', 300, 'B'), 'another member is not affected')
  t.ok(b.reserveCharge('m1', 100, 'A'), 'a reservation replaced counts once')
  t.is(b.memberUse('A'), 250)
  t.ok(b.reserveCharge('x', 5000), 'no member: only the budget')
  b.unreserve('m2')
  b.set('m1', 'A', 120)
  t.is(b.memberUse('A'), 220, 'the reservation floor moves to served')
  t.alike(b.stats(), { used: 220, served: 220, reserved: 5300, budget: 10000, reserve: 0 })
  b.set('r', 'r', 80, { member: 'A', first: true })
  t.is(b.memberUse('A'), 300, 'a root brought in by A uses A\'s share')
  t.absent(b.reserveCharge('r2', 1, 'A', { first: true }), 'so no other root fits it')
  b.release('r')
  b.release('m1')
  b.release('A')
  t.is(b.memberUse('A'), 0)
  t.ok(b.reserveCharge('m3', 300, 'A'), 'the share frees with its cores')
})

test('roots filling a share never keep the member\'s own cores out; another root is refused', (t) => {
  const b = createStorageBudget({ budget: 10000, reserve: 0, memberCap: 300 })
  b.set('A', 'A', 100)
  b.set('r', 'r', 200, { member: 'A', first: true })
  t.is(b.memberUse('A'), 300, 'the share is full')
  t.is(b.memberUse('A', { own: true }), 100, 'its own cores')
  t.absent(b.memberRoom('A', { first: true }), 'no room for a root')
  t.absent(b.reserveCharge('r2', 1, 'A', { first: true }), 'a root past the share is refused')
  t.ok(b.memberRoom('A'), 'room for its own core')
  t.ok(b.reserveCharge('m1', 150, 'A'), 'its own core is admitted')
  t.is(b.memberUse('A', { own: true }), 250)
  t.absent(b.reserveCharge('m2', 51, 'A'), 'its own cores still stop at the share')
  t.ok(b.reserveCharge('m1', 200, 'A'), 'a reservation replaced counts once')
  t.is(b.memberUse('A', { own: true }), 300)
  b.set('m1', 'A', 200)
  t.ok(b.capOver(), 'served past the share')
  t.alike(b.capVictims(), [{ member: 'A', bytes: 500, roots: [{ key: 'r', bytes: 200 }], drop: false, left: 300 }], 'the root is shed, not the member')
  b.release('r')
  t.absent(b.capOver())
  t.is(b.memberUse('A'), 300)

  const c = createStorageBudget({ budget: 10000, reserve: 0, memberCap: 300 })
  c.set('r', 'r', 300, { member: 'A', first: true })
  t.ok(c.reserveCharge('q', 100, 'A', { first: true }) === false, 'a full share takes no root')
  t.ok(c.memberRoom('A'), 'a member whose diary went while its roots fill its share')
  t.ok(c.reserveCharge('A', 300, 'A'), 'comes back up to the share')
  t.is(c.memberUse('A'), 600)
  t.is(c.memberUse('A', { own: true }), 300)
  c.unreserve('A')
  t.ok(c.reserveCharge('q2', 0, 'B', { first: true }), 'a root of another member')
  t.ok(c.reserveCharge('q2', 300, 'B', { first: true }), 'its replaced reservation counts once in the whole share')
  t.absent(c.reserveCharge('q3', 1, 'B', { first: true }))
  t.ok(c.reserveCharge('B', 300, 'B'), 'a reserved root leaves its own cores alone')
  t.alike(c.stats(), { used: 300, served: 300, reserved: 600, budget: 10000, reserve: 0 })
})

test('capVictims: roots past the share go largest first, never the member', (t) => {
  const b = createStorageBudget({ budget: 100000, memberCap: 1000 })
  b.set('A', 'A', 400)
  b.set('m', 'A', 300)
  b.set('r1', 'r1', 100, { member: 'A', first: true })
  b.set('r2', 'r2', 100, { member: 'A', first: true })
  b.set('r3', 'r3', 100, { member: 'A', first: true })
  t.absent(b.capOver(), 'at the share')
  t.alike(b.capVictims(), [])
  b.set('B', 'B', 999)
  b.set('r1', 'r1', 250, { member: 'A', first: true })
  b.set('r2', 'r2', 260, { member: 'A', first: true })
  t.ok(b.capOver())
  t.is(b.over(), false, 'the budget itself is fine')
  t.alike(b.capVictims(), [{ member: 'A', bytes: 1310, roots: [{ key: 'r2', bytes: 260 }, { key: 'r1', bytes: 250 }], drop: false, left: 800 }])
  b.leave('r2')
  t.ok(b.capOver(), 'one root is not enough')
  b.leave('r1')
  t.absent(b.capOver(), 'back within the share')
})

test('capVictims: the member goes when its own cores pass the share', (t) => {
  const b = createStorageBudget({ budget: 100000, memberCap: 1000 })
  b.set('A', 'A', 400)
  b.set('r', 'r', 100, { member: 'A', first: true })
  b.set('m', 'A', 700)
  t.alike(b.capVictims(), [{ member: 'A', bytes: 1200, roots: [{ key: 'r', bytes: 100 }], drop: true, left: 1100 }])
  t.alike(b.keysOf('A').sort(), ['A', 'm'], 'the member\'s own cores, not the root')
  const c = createStorageBudget({ budget: 100000, memberCap: 1000 })
  c.set('Z', 'Z', 1001)
  c.set('Y', 'Y', 1001)
  t.alike(c.capVictims().map((v) => [v.member, v.drop]), [['Y', true], ['Z', true]], 'by member key')
})

test('victims: roots go before members, the largest root first', (t) => {
  const b = createStorageBudget({ budget: 1000, reserve: 100 })
  b.set('A', 'A', 500)
  b.set('r1', 'r1', 150, { member: 'A', first: true })
  b.set('r2', 'r2', 200, { member: 'B', first: true })
  b.set('B', 'B', 151)
  t.ok(b.over())
  t.alike(b.victims(), [{ owner: 'r2', bytes: 200 }], 'a root before the larger member')
  b.set('A', 'A', 700)
  t.alike(b.victims(), [{ owner: 'r2', bytes: 200 }, { owner: 'r1', bytes: 150 }], 'the largest root first')
  b.set('A', 'A', 900)
  t.alike(b.victims(), [{ owner: 'r2', bytes: 200 }, { owner: 'r1', bytes: 150 }, { owner: 'A', bytes: 900 }], 'members only after every root')
})

test('requires nothing', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'storage-budget.js'), 'utf8')
  t.absent(/require\(/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no require')
})

test('fits: the budget alone, whatever the shares', (t) => {
  const b = createStorageBudget({ budget: 1000, reserve: 100, memberCap: 300 })
  b.set('A', 'A', 300)
  t.absent(b.reserveCharge('m', 100, 'A'), 'refused by the share')
  t.ok(b.fits('m', 100), 'while the budget had room')
  t.ok(b.reserveCharge('x', 500))
  t.ok(b.fits('x', 600), 'a reservation replaced counts once')
  t.absent(b.fits('y', 101), 'past budget - reserve')
  t.ok(b.fits('y', 100), 'exactly the limit fits')
  t.absent(b.fits('y', Infinity), 'an unbounded charge never fits')
})
