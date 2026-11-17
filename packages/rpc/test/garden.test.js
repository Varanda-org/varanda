'use strict'

const test = require('brittle')
const rpc = require('..')
const garden = require('../lib/garden')

const H = 3600000
// 09:00 Brasília.
const T0 = Date.parse('2026-11-16T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const OWNER = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const D = 'd'.repeat(64)
const E = 'e'.repeat(64)

const pot = (plant, atMs, waterMs = atMs, w = 0) => ({ plant, at: iso(atMs), water: iso(waterMs), w })
const six = (...items) => [...items, null, null, null, null, null, null].slice(0, 6)
const follow = (key = OWNER, on = true) => ({ type: 'follow', key, on, at: iso(T0 - 100 * H) })
const help = (to, p, atMs) => ({ type: 'garden-help', to, pot: p, at: iso(atMs) })
const row = (author, seq, p, atMs, extra = {}) => ({ author, seq, record: help(OWNER, p, atMs), follow: follow(), ...extra })

test('garden is exported from the package index', (t) => {
  t.is(rpc.garden, garden)
  t.ok(Object.isFrozen(garden), 'the module object is frozen')
  t.ok(Object.isFrozen(garden.GARDEN_PLANTS))
  t.ok(garden.GARDEN_PLANTS.every((p) => Object.isFrozen(p)))
})

test('constants are the agreed defaults', (t) => {
  t.is(garden.GARDEN_POTS, 6)
  t.alike(garden.GARDEN_PLANTS.map((p) => [p.id, p.ripeMs]), [
    ['manjericao', 21600000], ['tomate', 36000000], ['pimenta', 57600000],
    ['alecrim', 86400000], ['samambaia', 129600000], ['espada', 172800000]
  ])
  t.alike([
    garden.GARDEN_WATER_GAP_MS, garden.GARDEN_WATER_BOOST_MS, garden.GARDEN_WATER_MAX,
    garden.GARDEN_HELP_BOOST_MS, garden.GARDEN_HELP_PER_POT, garden.GARDEN_GIVEN_BOOST_MS,
    garden.GARDEN_GIVEN_PER_POT, garden.GARDEN_SAVES_DAILY_MAX, garden.GARDEN_HELPS_DAILY_MAX,
    garden.GARDEN_ACTS_MAX, garden.GARDEN_HELP_WINDOW_MS, garden.GARDEN_HELP_ROWS,
    garden.GARDEN_STREET_PAGE, garden.GARDEN_DAY_MS, garden.GARDEN_DAY_OFFSET_MS, garden.GARDEN_MAX_FUTURE_MS
  ], [10800000, 3600000, 12, 7200000, 3, 1800000, 3, 6, 5, 24, 259200000, 24, 20, 86400000, -10800000, 86400000])
})

test('invariants: the help window covers the slowest plant, the gap is shorter than the fastest', (t) => {
  const ripes = garden.GARDEN_PLANTS.map((p) => p.ripeMs)
  t.ok(garden.GARDEN_HELP_WINDOW_MS >= Math.max(...ripes) + garden.GARDEN_MAX_FUTURE_MS, 'a help to a ripening pot is still in the window')
  t.ok(Math.min(...ripes) > garden.GARDEN_WATER_GAP_MS, 'every plant can be watered at least once')
})

test('isPlantId, isPotIndex, isSaveOrdinal', (t) => {
  for (const p of garden.GARDEN_PLANTS) t.ok(garden.isPlantId(p.id), p.id)
  for (const bad of ['Tomate', 'rosa', '', 'toString', '__proto__', null, 1, {}, ['tomate']]) t.absent(garden.isPlantId(bad), String(bad))
  for (let i = 0; i < 6; i++) t.ok(garden.isPotIndex(i))
  for (const bad of [-1, 6, 1.5, '1', NaN, null, true]) t.absent(garden.isPotIndex(bad), String(bad))
  for (let n = 1; n <= 6; n++) t.ok(garden.isSaveOrdinal(n))
  for (const bad of [0, 7, 2.5, '1', null]) t.absent(garden.isSaveOrdinal(bad), String(bad))
})

test('isPot: exact shape, canonical dates, ordered at <= water <= record', (t) => {
  const ok = pot('tomate', T0, T0 + 3 * H, 1)
  t.ok(garden.isPot(ok, T0 + 3 * H), 'watered at the record instant')
  t.ok(garden.isPot(null, T0), 'an empty pot')
  t.absent(garden.isPot(ok, T0 + 3 * H - 1), 'watered after the record')
  t.absent(garden.isPot(pot('tomate', T0 + H, T0), T0 + 2 * H), 'watered before planted')
  t.absent(garden.isPot(ok), 'no record instant')
  t.absent(garden.isPot(ok, NaN))
  t.absent(garden.isPot({ ...ok, extra: 1 }, T0 + 5 * H), 'an extra key')
  const { w, ...missing } = ok
  t.absent(garden.isPot(missing, T0 + 5 * H), 'a missing key')
  for (const at of ['2026-11-16T12:00:00Z', '2026-11-16T12:00:00.000+00:00', '2026-11-16T09:00:00.000-03:00', '2026-02-30T12:00:00.000Z', '2026-11-16', ' 2026-11-16T12:00:00.000Z', 1763294400000]) {
    t.absent(garden.isPot({ ...ok, at }, T0 + 5 * H), 'non-canonical at ' + JSON.stringify(at))
  }
  for (const bad of [-1, 13, 1.5, '1', null, NaN]) t.absent(garden.isPot({ ...ok, w: bad }, T0 + 5 * H), 'w ' + String(bad))
  t.ok(garden.isPot({ ...ok, w: 12 }, T0 + 5 * H), 'w at the cap')
  t.absent(garden.isPot({ ...ok, plant: 'rosa' }, T0 + 5 * H), 'unknown plant')
  for (const bad of [undefined, 0, 'x', [], [ok]]) t.absent(garden.isPot(bad, T0 + 5 * H), String(bad))
})

test('isPot: hostile objects never throw and never pass', (t) => {
  const ok = pot('tomate', T0)
  const getter = { ...ok }
  Object.defineProperty(getter, 'w', { enumerable: true, get () { throw new Error('boom') } })
  t.absent(garden.isPot(getter, T0), 'a throwing getter')
  const accessor = { ...ok }
  Object.defineProperty(accessor, 'w', { enumerable: true, get () { return 0 } })
  t.absent(garden.isPot(accessor, T0), 'an accessor that returns a good value')
  t.absent(garden.isPot(new Proxy({ ...ok }, { ownKeys () { throw new Error('boom') } }), T0), 'a throwing ownKeys trap')
  t.absent(garden.isPot(new Proxy({ ...ok }, { getPrototypeOf () { throw new Error('boom') } }), T0), 'a throwing prototype trap')
  const { proxy, revoke } = Proxy.revocable({ ...ok }, {})
  revoke()
  t.absent(garden.isPot(proxy, T0), 'a revoked proxy')
  t.absent(garden.isPot({ ...ok, [Symbol('x')]: 1 }, T0), 'a symbol key')
  const hidden = { ...ok }
  Object.defineProperty(hidden, 'extra', { enumerable: false, value: 1 })
  t.absent(garden.isPot(hidden, T0), 'a hidden extra key')
  class Pot { constructor () { Object.assign(this, ok) } }
  t.absent(garden.isPot(new Pot(), T0), 'a class instance')
  t.ok(garden.isPot(Object.assign(Object.create(null), ok), T0), 'a null-prototype object is plain')
})

test('a Proxy cannot answer differently after the check', (t) => {
  const target = pot('manjericao', T0)
  const liar = new Proxy(target, { get (o, k) { return k === 'plant' ? 'espada' : k === 'w' ? 99 : o[k] } })
  t.ok(garden.isPot(liar, T0), 'the own data properties are a valid pot')
  t.is(garden.potView(liar, T0 + H).plant, 'manjericao', 'the view reads the checked value, never the get trap')
  const out = garden.applyActs({ pots: six(liar) }, [{ op: 'clear', pot: 0 }], T0 + H)
  t.ok(out.ok)
})

test('isPots: a dense array of exactly six pots', (t) => {
  t.ok(garden.isPots(six(), T0))
  t.ok(garden.isPots(six(pot('tomate', T0), null, pot('espada', T0 - H)), T0))
  t.absent(garden.isPots(six().slice(0, 5), T0), 'five')
  t.absent(garden.isPots([...six(), null], T0), 'seven')
  // eslint-disable-next-line no-sparse-arrays
  t.absent(garden.isPots([null, , null, null, null, null], T0), 'sparse')
  t.absent(garden.isPots(new Array(6), T0), 'all holes')
  const extra = six()
  extra.foo = 1
  t.absent(garden.isPots(extra, T0), 'an extra array property')
  t.absent(garden.isPots({ 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, length: 6 }, T0), 'array-like')
  const getter = six()
  Object.defineProperty(getter, 2, { enumerable: true, get () { throw new Error('boom') } })
  t.absent(garden.isPots(getter, T0), 'a throwing index getter')
  t.absent(garden.isPots(new Proxy(six(), { ownKeys () { throw new Error('boom') } }), T0), 'a throwing proxy')
  t.absent(garden.isPots(six(pot('tomate', T0 + 1)), T0), 'a pot dated after the record')
  t.absent(garden.isPots(six({ plant: 'tomate' }), T0), 'one bad pot')
  t.absent(garden.isPots(six(), 'x'), 'no record instant')
})

test('isAct and isActs: the four acts with exact keys', (t) => {
  t.ok(garden.isAct({ op: 'plant', pot: 0, plant: 'tomate' }))
  for (const op of ['water', 'harvest', 'clear']) t.ok(garden.isAct({ op, pot: 5 }), op)
  t.absent(garden.isAct({ op: 'plant', pot: 0 }), 'plant without a plant')
  t.absent(garden.isAct({ op: 'water', pot: 0, plant: 'tomate' }), 'water with a plant')
  t.absent(garden.isAct({ op: 'plant', pot: 0, plant: 'tomate', at: 1 }), 'an extra key')
  t.absent(garden.isAct({ op: 'water', pot: 6 }), 'pot 6')
  t.absent(garden.isAct({ op: 'dig', pot: 0 }), 'unknown op')
  t.absent(garden.isAct({ op: 'plant', pot: 0, plant: 'rosa' }), 'unknown plant')
  const getter = { op: 'water' }
  Object.defineProperty(getter, 'pot', { enumerable: true, get () { throw new Error('boom') } })
  t.absent(garden.isAct(getter), 'a throwing getter')
  for (const bad of [null, undefined, 'water', ['water', 0]]) t.absent(garden.isAct(bad), String(bad))
  const act = { op: 'water', pot: 0 }
  t.ok(garden.isActs([act]))
  t.ok(garden.isActs(new Array(24).fill(act)), 'at the cap')
  t.absent(garden.isActs([]), 'empty')
  t.absent(garden.isActs(new Array(25).fill(act)), 'over the cap')
  // eslint-disable-next-line no-sparse-arrays
  t.absent(garden.isActs([act, , act]), 'sparse')
  t.absent(garden.isActs([act, { op: 'water' }]), 'one bad act')
  t.absent(garden.isActs({ 0: act, length: 1 }), 'array-like')
})

test('isFollowOf: an on follow of exactly that owner', (t) => {
  t.ok(garden.isFollowOf(follow(), OWNER))
  t.absent(garden.isFollowOf(follow(OWNER, false), OWNER), 'an unfollow')
  t.absent(garden.isFollowOf(follow(B), OWNER), 'a follow of someone else')
  t.absent(garden.isFollowOf({ ...follow(), type: 'fan' }, OWNER), 'another type')
  t.absent(garden.isFollowOf({ ...follow(), extra: 1 }, OWNER), 'an extra key')
  t.absent(garden.isFollowOf({ ...follow(), on: 1 }, OWNER), 'on is not true')
  t.absent(garden.isFollowOf({ ...follow(), at: '2026-11-16T12:00:00Z' }, OWNER), 'a non-canonical date')
  t.absent(garden.isFollowOf(follow(), 'A'.repeat(64)), 'a bad owner')
  t.absent(garden.isFollowOf(null, OWNER))
  t.absent(garden.isFollowOf(new Proxy(follow(), { ownKeys () { throw new Error('boom') } }), OWNER))
})

test('gardenDay and dayStart: Brasília days start at 03:00Z', (t) => {
  t.is(garden.gardenDay(Date.parse('2026-11-16T02:59:59.999Z')), '2026-11-15')
  t.is(garden.gardenDay(Date.parse('2026-11-16T03:00:00.000Z')), '2026-11-16')
  t.is(garden.dayStart(T0), Date.parse('2026-11-16T03:00:00.000Z'))
  t.is(garden.dayStart(Date.parse('2026-11-16T02:00:00.000Z')), Date.parse('2026-11-15T03:00:00.000Z'))
  t.is(garden.dayStart(-1), Date.parse('1969-12-31T03:00:00.000Z'), 'before the epoch')
  for (const bad of [NaN, Infinity, '1', null, 9e15]) {
    t.is(garden.gardenDay(bad), null, String(bad))
    t.ok(Number.isNaN(garden.dayStart(bad)), String(bad))
  }
})

test('dayStart: a start below the Date range is NaN', (t) => {
  t.ok(Number.isNaN(garden.dayStart(-8.64e15)), 'the earliest instant starts its day out of range')
  t.is(garden.dayStart(8.64e15), Date.parse('+275760-09-12T03:00:00.000Z'), 'the latest instant still has a day')
  t.is(garden.dayStart(T0), Date.parse('2026-11-16T03:00:00.000Z'), 'a normal instant is unchanged')
})

test('potView: growth at zero, a quarter and ripe', (t) => {
  const p = pot('manjericao', T0)
  const v0 = garden.potView(p, T0)
  t.alike(v0, { plant: 'manjericao', progress: 0, stage: 0, ripe: false, ripeAt: T0 + 6 * H, dry: false, canWater: false })
  t.is(garden.potView(p, T0 + 1.5 * H - 1).stage, 0, 'just below a quarter')
  const q = garden.potView(p, T0 + 1.5 * H)
  t.is(q.progress, 0.25)
  t.is(q.stage, 1, 'a quarter')
  t.is(garden.potView(p, T0 + 3.6 * H).stage, 2, 'from 0.6')
  const almost = garden.potView(p, T0 + 6 * H - 1)
  t.absent(almost.ripe)
  t.is(almost.stage, 2)
  const ripe = garden.potView(p, T0 + 6 * H)
  t.ok(ripe.ripe)
  t.is(ripe.stage, 3)
  t.is(ripe.progress, 1)
  t.absent(ripe.canWater, 'a ripe pot is never watered')
  t.is(garden.potView(p, T0 + 100 * H).progress, 1, 'no death')
  t.is(garden.potView(p, T0 + 3 * H).dry, true, 'dry after the gap')
  t.is(garden.potView(p, T0 + 3 * H).canWater, true)
  t.is(garden.potView(p, T0 + 3 * H - 1).dry, false)
})

test('potView: boosts, the half-time floor and waters clamped by the gaps', (t) => {
  const watered = pot('manjericao', T0, T0 + 3 * H, 1)
  t.is(garden.potView(watered, T0).ripeAt, T0 + 5 * H, 'one water takes an hour off')
  t.is(garden.potView(pot('manjericao', T0, T0 + 4 * H, 12), T0).ripeAt, T0 + 5 * H, 'w is clamped by the gaps between at and water')
  t.is(garden.potView(pot('manjericao', T0, T0 + 30 * H, 2), T0 + 30 * H).ripeAt, T0 + 4 * H, 'waters are clamped by w')
  t.is(garden.potView(pot('manjericao', T0), T0, { received: 1 }).ripeAt, T0 + 4 * H, 'one help takes two hours off')
  t.is(garden.potView(pot('manjericao', T0), T0, { received: 99 }).ripeAt, T0 + 3 * H, 'helps cap at three, floored at half time')
  t.is(garden.potView(pot('espada', T0), T0, { received: 99 }).ripeAt, T0 + 48 * H - 6 * H, 'three helps on a slow plant')
  t.is(garden.potView(pot('espada', T0), T0, { given: 99 }).ripeAt, T0 + 48 * H - 1.5 * H, 'given caps at three')
  const max = pot('tomate', T0, T0 + 6 * H, 2)
  t.is(garden.potView(max, T0, { received: 3, given: 3 }).ripeAt, T0 + 5 * H, 'waters, helps and given together never go below half of ripeMs')
  t.ok(garden.potView(pot('manjericao', T0), T0 + 3 * H, { received: 3 }).ripe, 'ripe at the floor')
  for (const bad of [-1, NaN, '3', 1.5, null, Infinity]) {
    t.is(garden.potView(pot('manjericao', T0), T0, { received: bad, given: bad }).ripeAt, T0 + 6 * H, 'a bad count reads 0: ' + String(bad))
  }
})

test('potView: a pot dated ahead of now reads 0, bad input reads null', (t) => {
  const v = garden.potView(pot('tomate', T0 + 2 * H), T0)
  t.is(v.progress, 0)
  t.is(v.stage, 0)
  t.absent(v.dry)
  t.is(garden.potView(null, T0), null)
  t.is(garden.potView({ plant: 'tomate' }, T0), null)
  t.is(garden.potView(pot('tomate', T0), NaN), null)
  t.is(garden.potView(pot('tomate', T0), '1'), null)
  const opts = {}
  Object.defineProperty(opts, 'received', { enumerable: true, get () { throw new Error('boom') } })
  t.is(garden.potView(pot('manjericao', T0), T0, opts).ripeAt, T0 + 6 * H, 'a throwing options getter reads 0')
})

test('potView: a pot watered past the future tolerance, or ripe past the Date range, is null', (t) => {
  const last = '+275760-09-13T00:00:00.000Z'
  t.is(garden.potView({ plant: 'manjericao', at: last, water: last, w: 0 }, T0), null, 'dated at the largest instant')
  t.is(garden.potView(pot('manjericao', T0, T0 + 23 * H), T0).plant, 'manjericao', 'watered 23 h ahead')
  t.is(garden.potView(pot('manjericao', T0 + 24 * H), T0).progress, 0, 'at the tolerance')
  t.is(garden.potView(pot('manjericao', T0, T0 + 25 * H), T0), null, 'watered 25 h ahead')
  const late = 8.64e15 - H
  t.is(garden.potView(pot('manjericao', late), late), null, 'a ripeAt past the Date range')
})

test('applyActs: plant, water, harvest, clear', (t) => {
  let out = garden.applyActs(null, [{ op: 'plant', pot: 0, plant: 'manjericao' }, { op: 'plant', pot: 3, plant: 'tomate' }], T0)
  t.ok(out.ok)
  t.alike(out.state.pots, six(pot('manjericao', T0), null, null, pot('tomate', T0)))
  t.ok(garden.isPots(out.state.pots, T0), 'the result is a valid state at now')
  const s1 = out.state
  t.is(garden.applyActs(s1, [{ op: 'water', pot: 0 }], T0 + 3 * H - 1).reason, 'not-dry')
  out = garden.applyActs(s1, [{ op: 'water', pot: 0 }], T0 + 3 * H)
  t.ok(out.ok)
  t.alike(out.state.pots[0], pot('manjericao', T0, T0 + 3 * H, 1))
  t.is(garden.applyActs(out.state, [{ op: 'water', pot: 0 }], T0 + 3 * H).reason, 'not-dry', 'watered twice in one session')
  t.is(garden.applyActs(out.state, [{ op: 'harvest', pot: 0 }], T0 + 5 * H - 1).reason, 'not-ripe')
  const h = garden.applyActs(out.state, [{ op: 'harvest', pot: 0 }], T0 + 5 * H)
  t.ok(h.ok, 'one water took an hour off')
  t.is(h.state.pots[0], null)
  t.is(garden.applyActs(s1, [{ op: 'plant', pot: 0, plant: 'tomate' }], T0).reason, 'occupied')
  t.is(garden.applyActs(s1, [{ op: 'water', pot: 1 }], T0 + 3 * H).reason, 'empty')
  t.is(garden.applyActs(s1, [{ op: 'clear', pot: 1 }], T0).reason, 'empty')
  t.is(garden.applyActs(s1, [{ op: 'harvest', pot: 1 }], T0).reason, 'empty')
  const c = garden.applyActs(s1, [{ op: 'clear', pot: 3 }], T0 + H)
  t.ok(c.ok, 'clear needs no ripeness')
  t.is(c.state.pots[3], null)
  const replant = garden.applyActs(s1, [{ op: 'clear', pot: 3 }, { op: 'plant', pot: 3, plant: 'espada' }], T0 + H)
  t.alike(replant.state.pots[3], pot('espada', T0 + H))
  t.is(garden.applyActs(null, [{ op: 'plant', pot: 0, plant: 'tomate' }, { op: 'water', pot: 0 }], T0).reason, 'not-dry', 'a fresh pot is not dry')
})

test('applyActs: w is capped at GARDEN_WATER_MAX', (t) => {
  const state = { pots: six(pot('espada', T0, T0 + 30 * H, 12)) }
  const out = garden.applyActs(state, [{ op: 'water', pot: 0 }], T0 + 33 * H)
  t.ok(out.ok)
  t.is(out.state.pots[0].w, 12)
})

test('applyActs: one bad act refuses the whole batch, inputs are never mutated', (t) => {
  const state = { type: 'garden-state', pots: six(pot('manjericao', T0)), n: 1, at: iso(T0) }
  const acts = [{ op: 'plant', pot: 1, plant: 'tomate' }, { op: 'water', pot: 0 }, { op: 'plant', pot: 2, plant: 'espada' }]
  const before = JSON.stringify({ state, acts })
  const out = garden.applyActs(state, acts, T0 + H)
  t.alike(out, { ok: false, reason: 'not-dry' })
  t.is(JSON.stringify({ state, acts }), before, 'a refusal changes nothing')
  const good = garden.applyActs(state, [{ op: 'water', pot: 0 }, { op: 'plant', pot: 1, plant: 'tomate' }], T0 + 3 * H)
  t.ok(good.ok)
  t.is(JSON.stringify({ state, acts }), before, 'a success changes nothing either')
  t.not(good.state.pots, state.pots)
  good.state.pots[0].w = 9
  t.is(state.pots[0].w, 0, 'the result shares nothing with the input')
  t.is(garden.applyActs(state, [{ op: 'clear', pot: 0 }, { op: 'dig', pot: 1 }], T0).reason, 'acts', 'one malformed act')
  t.is(garden.applyActs(state, [], T0).reason, 'acts')
  t.is(garden.applyActs(state, new Array(25).fill({ op: 'clear', pot: 0 }), T0).reason, 'acts')
})

test('applyActs: a bad state or clock refuses', (t) => {
  const act = [{ op: 'plant', pot: 0, plant: 'tomate' }]
  t.is(garden.applyActs({ pots: six(pot('tomate', T0 + H)) }, act, T0).reason, 'state', 'a state watered after now')
  t.is(garden.applyActs({ pots: six().slice(0, 5) }, act, T0).reason, 'state')
  t.is(garden.applyActs({}, act, T0).reason, 'state')
  t.is(garden.applyActs('x', act, T0).reason, 'state')
  const getter = {}
  Object.defineProperty(getter, 'pots', { enumerable: true, get () { throw new Error('boom') } })
  t.is(garden.applyActs(getter, act, T0).reason, 'state', 'a throwing getter')
  for (const bad of [NaN, '1', null, undefined, Infinity]) t.is(garden.applyActs(null, act, bad).reason, 'invalid', String(bad))
})

test('applyActs: water ignores neighbour counts, harvest reads them (round 3)', (t) => {
  const full = [3, 3, 3, 3, 3, 3]
  const state = { pots: six(pot('manjericao', T0), pot('tomate', T0)) }
  t.ok(garden.applyActs(state, [{ op: 'water', pot: 0 }], T0 + 3 * H, { received: full }).ok, 'manjericao watered at hour 3')
  t.ok(garden.applyActs(state, [{ op: 'water', pot: 1 }], T0 + 6 * H, { received: full }).ok, 'tomate watered at hour 6')
  t.ok(garden.applyActs(state, [{ op: 'water', pot: 1 }], T0 + 6 * H, { received: full, given: full }).ok, 'given does not block a water either')
  t.ok(garden.applyActs(state, [{ op: 'harvest', pot: 0 }], T0 + 3 * H, { received: full }).ok, 'harvest under three helps at the floor')
  t.is(garden.applyActs(state, [{ op: 'harvest', pot: 0 }], T0 + 3 * H).reason, 'not-ripe', 'not ripe with no helps')
  const g = garden.applyActs(state, [{ op: 'harvest', pot: 0 }], T0 + 4.5 * H, { given: [3, 0, 0, 0, 0, 0] })
  t.ok(g.ok, 'given takes 1.5 h off')
  for (const bad of [[3, 3], [3, 3, 3, 3, 3, 3, 3], 'x', 3, { 0: 3, length: 6 }, [3, 3, 3, 3, 3, -1], [3, 3, 3, 3, 3, 1.5], [NaN, 3, 3, 3, 3, 3], null]) {
    t.is(garden.applyActs(state, [{ op: 'harvest', pot: 0 }], T0 + 3 * H, { received: bad }).reason, 'not-ripe', 'reads as zeros: ' + JSON.stringify(bad))
  }
  const hostile = [3, 3, 3, 3, 3, 3]
  Object.defineProperty(hostile, 0, { enumerable: true, get () { throw new Error('boom') } })
  t.is(garden.applyActs(state, [{ op: 'harvest', pot: 0 }], T0 + 3 * H, { received: hostile }).reason, 'not-ripe', 'a throwing count getter reads as zeros')
})

test('foldHelps: counted helps and the helper list', (t) => {
  const pots = six(pot('espada', T0 - 10 * H), pot('tomate', T0 - 10 * H))
  const now = T0 + 2 * H
  const out = garden.foldHelps({ owner: OWNER, pots, now, helps: [row(B, 5, 0, T0), row(C, 9, 1, T0 + H)] })
  t.alike(out.perPot, [1, 1, 0, 0, 0, 0])
  t.alike(out.helpers, [
    { author: C, seq: 9, pot: 1, at: iso(T0 + H) },
    { author: B, seq: 5, pot: 0, at: iso(T0) }
  ], 'newest first')
})

test('foldHelps: one help per helper per Brasília day, across the 03:00Z boundary', (t) => {
  const pots = six(pot('espada', T0 - 40 * H))
  const now = T0
  const before = Date.parse('2026-11-16T02:59:00.000Z')
  const after = Date.parse('2026-11-16T03:01:00.000Z')
  const late = Date.parse('2026-11-16T11:00:00.000Z')
  let out = garden.foldHelps({ owner: OWNER, pots, now, helps: [row(B, 3, 0, before), row(B, 4, 0, after)] })
  t.is(out.perPot[0], 2, 'two Brasília days')
  out = garden.foldHelps({ owner: OWNER, pots, now, helps: [row(B, 7, 0, late), row(B, 4, 0, after)] })
  t.is(out.perPot[0], 1, 'one Brasília day')
  t.alike(out.helpers.map((h) => h.seq), [4], 'the lowest seq of the day wins')
  out = garden.foldHelps({ owner: OWNER, pots, now, helps: [row(B, 4, 0, after), row(B, 4, 0, after)] })
  t.is(out.perPot[0], 1, 'a repeated row counts once')
})

test('foldHelps: a help without follow evidence, from the owner or to another balcony is dropped', (t) => {
  const pots = six(pot('espada', T0 - 10 * H))
  const now = T0 + H
  const count = (helps) => garden.foldHelps({ owner: OWNER, pots, now, helps }).perPot[0]
  t.is(count([row(B, 1, 0, T0, { follow: null })]), 0, 'no follow record')
  t.is(count([row(B, 1, 0, T0, { follow: follow(OWNER, false) })]), 0, 'an unfollow')
  t.is(count([row(B, 1, 0, T0, { follow: follow(C) })]), 0, 'a follow of another member')
  t.is(count([{ author: B, seq: 1, record: help(OWNER, 0, T0) }]), 0, 'a row without follow')
  t.is(count([row(OWNER, 1, 0, T0)]), 0, 'the owner watering their own balcony')
  t.is(count([{ ...row(B, 1, 0, T0), record: help(C, 0, T0) }]), 0, 'a help to another balcony')
  t.is(count([{ ...row(B, 1, 0, T0), record: { ...help(OWNER, 0, T0), extra: 1 } }]), 0, 'an extra key')
  t.is(count([{ ...row(B, 1, 0, T0), record: { ...help(OWNER, 0, T0), type: 'scrap' } }]), 0, 'another type')
  t.is(count([{ ...row(B, 1, 0, T0), record: { ...help(OWNER, 0, T0), at: '2026-11-16T12:00:00Z' } }]), 0, 'a non-canonical date')
  t.is(count([row(B, 0, 0, T0)]), 0, 'seq 0')
  t.is(count([row('B'.repeat(64), 1, 0, T0)]), 0, 'a bad author')
  const getter = row(C, 2, 0, T0)
  Object.defineProperty(getter.record, 'pot', { enumerable: true, get () { throw new Error('boom') } })
  t.is(count([getter, row(B, 1, 0, T0)]), 1, 'a hostile record is skipped, the others count')
  t.is(count([new Proxy(row(C, 2, 0, T0), { getOwnPropertyDescriptor () { throw new Error('boom') } }), row(B, 1, 0, T0)]), 1, 'a hostile row is skipped')
  t.is(count([row(B, 1, 0, T0)]), 1, 'the control row counts')
})

test('foldHelps: the per-pot cap and the order of who counts', (t) => {
  const pots = six(pot('espada', T0 - 10 * H))
  const now = T0 + 10 * H
  const helps = [row(E, 1, 0, T0 + 3 * H), row(D, 1, 0, T0 + 2 * H), row(C, 1, 0, T0 + H), row(B, 1, 0, T0 + H)]
  const out = garden.foldHelps({ owner: OWNER, pots, now, helps })
  t.is(out.perPot[0], 3, 'capped at GARDEN_HELP_PER_POT')
  t.is(out.helpers.length, 4, 'every helper is still listed')
  t.alike(out.helpers.map((h) => h.author), [E, D, B, C], 'newest first, then author')
})

test('foldHelps: one helper row per author, the newest kept help', (t) => {
  const pots = six(pot('espada', T0 - 100 * H), pot('espada', T0 - 100 * H))
  const now = T0
  // Three Brasília days for B: 11-14, 11-15 and 11-16.
  const helps = [row(B, 1, 0, T0 - 50 * H), row(B, 2, 1, T0 - 26 * H), row(B, 3, 0, T0 - 2 * H), row(C, 1, 1, T0 - H)]
  const out = garden.foldHelps({ owner: OWNER, pots, now, helps })
  t.alike(out.perPot, [2, 2, 0, 0, 0, 0], 'every counted day still counts')
  t.alike(out.helpers, [
    { author: C, seq: 1, pot: 1, at: iso(T0 - H) },
    { author: B, seq: 3, pot: 0, at: iso(T0 - 2 * H) }
  ], 'B once, its newest help')
})

test('foldHelps: a few accounts cannot fill the helper list', (t) => {
  const pots = six(pot('espada', T0 - 100 * H))
  const now = T0
  const authors = ['1', '2', '3', '4', '5'].map((c) => c.repeat(64))
  // Five Brasília days inside the window: 11-13 to 11-17.
  const times = [T0 - 71 * H, T0 - 48 * H, T0 - 24 * H, T0, T0 + 23 * H]
  const helps = []
  for (const a of authors) for (const [i, at] of times.entries()) helps.push(row(a, i + 1, 0, at))
  t.is(helps.length, 25)
  let out = garden.foldHelps({ owner: OWNER, pots, now, helps })
  t.is(out.perPot[0], 3)
  t.alike(out.helpers, authors.map((author) => ({ author, seq: 5, pot: 0, at: iso(T0 + 23 * H) })), 'five rows, one per author')
  const honest = '6'.repeat(64)
  out = garden.foldHelps({ owner: OWNER, pots, now, helps: [...helps, row(honest, 1, 0, now - 72 * H)] })
  t.is(out.helpers.length, 6)
  t.is(out.helpers[5].author, honest, 'a real helper is still listed')
})

test('foldHelps: Brasília days past year 9999 are still separate days', (t) => {
  const now = Date.parse('+010000-03-01T12:00:00.000Z')
  const pots = six(pot('espada', now - 100 * H))
  const count = (helps) => garden.foldHelps({ owner: OWNER, pots, now, helps }).perPot[0]
  t.is(count([row(B, 1, 0, now - 25 * H), row(B, 2, 0, now - H)]), 2, 'two consecutive days')
  t.is(count([row(B, 1, 0, now - 2 * H), row(B, 2, 0, now - H)]), 1, 'the same day')
})

test('foldHelps: future, out-of-window and early helps are dropped', (t) => {
  const pots = six(pot('espada', T0 - 100 * H), pot('tomate', T0))
  const now = T0
  const count = (helps) => garden.foldHelps({ owner: OWNER, pots, now, helps }).perPot
  t.alike(count([row(B, 1, 0, now + 24 * H)]), [1, 0, 0, 0, 0, 0], 'at the future tolerance')
  t.alike(count([row(B, 1, 0, now + 24 * H + 1)]), [0, 0, 0, 0, 0, 0], 'past the future tolerance')
  t.alike(count([row(B, 1, 0, now - 72 * H)]), [1, 0, 0, 0, 0, 0], 'at the window edge')
  t.alike(count([row(B, 1, 0, now - 72 * H - 1)]), [0, 0, 0, 0, 0, 0], 'older than the window')
  t.alike(count([row(B, 1, 1, T0 - 1)]), [0, 0, 0, 0, 0, 0], 'before the pot was planted')
  t.alike(count([row(B, 1, 1, T0)]), [0, 1, 0, 0, 0, 0], 'at the planting')
  t.alike(count([row(B, 1, 2, T0)]), [0, 0, 0, 0, 0, 0], 'an empty pot')
})

test('foldHelps: the helper list is capped, bad input counts nothing', (t) => {
  const pots = six(pot('espada', T0 - 100 * H))
  const helps = []
  for (let i = 0; i < 30; i++) helps.push(row(i.toString(16).padStart(64, '0'), 1, 0, T0 - i * H))
  const out = garden.foldHelps({ owner: OWNER, pots, now: T0, helps })
  t.is(out.helpers.length, 24)
  t.is(out.helpers[0].at, iso(T0))
  t.is(out.perPot[0], 3)
  const zero = { perPot: [0, 0, 0, 0, 0, 0], helpers: [] }
  t.alike(garden.foldHelps({ owner: OWNER, pots, now: T0, helps: 'x' }), zero)
  t.alike(garden.foldHelps({ owner: 'x', pots, now: T0, helps }), zero)
  t.alike(garden.foldHelps({ owner: OWNER, pots, now: NaN, helps }), zero)
  t.alike(garden.foldHelps({ owner: OWNER, pots: 'x', now: T0, helps }), zero, 'no planted pot')
  t.alike(garden.foldHelps(null), zero)
})

test('foldGiven: own helps boost own pots planted before them', (t) => {
  const pots = six(pot('espada', T0 - 10 * H), pot('tomate', T0 + H))
  const now = T0 + 2 * H
  const g = (seq, to, atMs) => ({ seq, record: help(to, 0, atMs) })
  t.alike(garden.foldGiven({ self: OWNER, pots, now, given: [g(1, B, T0)] }).perPot, [1, 0, 0, 0, 0, 0], 'the later pot gets nothing')
  t.alike(garden.foldGiven({ self: OWNER, pots, now, given: [g(1, B, T0 + H)] }).perPot, [1, 1, 0, 0, 0, 0], 'planted at the help')
  t.alike(garden.foldGiven({ self: OWNER, pots, now, given: [g(1, B, T0), g(2, B, T0 + 1000)] }).perPot, [1, 0, 0, 0, 0, 0], 'one per balcony per day')
  t.alike(garden.foldGiven({ self: OWNER, pots, now, given: [g(1, OWNER, T0)] }).perPot, [0, 0, 0, 0, 0, 0], 'a help to self')
  t.alike(garden.foldGiven({ self: OWNER, pots, now, given: [g(1, B, T0), g(2, C, T0), g(3, D, T0), g(4, E, T0)] }).perPot, [3, 0, 0, 0, 0, 0], 'capped per pot')
  t.alike(garden.foldGiven({ self: OWNER, pots, now, given: [g(1, B, now + 25 * H), g(2, C, now - 73 * H)] }).perPot, [0, 0, 0, 0, 0, 0], 'out of the window')
  t.alike(garden.foldGiven({ self: OWNER, pots, now, given: 'x' }).perPot, [0, 0, 0, 0, 0, 0])
  t.alike(garden.foldGiven({ self: 'x', pots, now, given: [g(1, B, T0)] }).perPot, [0, 0, 0, 0, 0, 0])
})

test('foldGiven: at most GARDEN_HELPS_DAILY_MAX a day, the lowest seqs', (t) => {
  const now = T0 + 2 * H
  const to = (i) => i.toString(16).padStart(64, '2')
  const given = []
  for (let i = 0; i < 6; i++) given.push({ seq: 10 + i, record: help(to(i), 0, T0 + i * 1000) })
  // The pot is planted at the sixth help, so it sees that help alone.
  const pots = six(pot('espada', T0 + 5000))
  t.is(garden.foldGiven({ self: OWNER, pots, now, given }).perPot[0], 0, 'the sixth help of the day does not count')
  t.is(garden.foldGiven({ self: OWNER, pots, now, given: given.slice(1) }).perPot[0], 1, 'the same help as the fifth counts')
  const nextDay = given.map((g, i) => i === 5 ? { seq: g.seq, record: help(to(5), 0, T0 + 24 * H) } : g)
  t.is(garden.foldGiven({ self: OWNER, pots, now: T0 + 25 * H, given: nextDay }).perPot[0], 1, 'the next day has its own budget')
})

test('foldGiven: Brasília days past year 9999 are still separate days', (t) => {
  const now = Date.parse('+010000-03-01T12:00:00.000Z')
  const pots = six(pot('espada', now - 100 * H))
  const at = (seq, to, atMs) => ({ seq, record: help(to, 0, atMs) })
  t.is(garden.foldGiven({ self: OWNER, pots, now, given: [at(1, B, now - 25 * H), at(2, B, now - H)] }).perPot[0], 2, 'one balcony on two consecutive days')
  t.is(garden.foldGiven({ self: OWNER, pots, now, given: [at(1, B, now - 2 * H), at(2, B, now - H)] }).perPot[0], 1, 'one balcony on the same day')
  const to = (i) => i.toString(16).padStart(64, '2')
  const given = []
  for (let i = 0; i < 5; i++) given.push(at(10 + i, to(i), now - 25 * H + i * 1000))
  given.push(at(20, to(5), now - H))
  // Planted at the last help, so the pot sees that help alone.
  t.is(garden.foldGiven({ self: OWNER, pots: six(pot('espada', now - H)), now, given }).perPot[0], 1, 'the next day has its own budget')
})

test('foldBalcony: the reader view of a balcony', (t) => {
  const flag = { type: 'garden', on: true, at: iso(T0 - 50 * H) }
  const state = { type: 'garden-state', pots: six(pot('manjericao', T0 - 2 * H)), n: 1, at: iso(T0 - 2 * H) }
  const helps = [row(B, 3, 0, T0 - H)]
  const given = [{ seq: 2, record: help(C, 0, T0 - H) }]
  const out = garden.foldBalcony({ owner: OWNER, flag, state, helps, given, now: T0 })
  t.is(out.on, true)
  t.is(out.stale, false)
  t.is(out.pots[0].ripeAt, T0 - 2 * H + 6 * H - 2 * H - 0.5 * H, 'one help and one given')
  t.alike(out.pots.slice(1), [null, null, null, null, null])
  t.alike(out.helpers, [{ author: B, seq: 3, pot: 0, at: iso(T0 - H) }])
})

test('foldBalcony: off, future and malformed records', (t) => {
  const flag = { type: 'garden', on: true, at: iso(T0) }
  const state = { type: 'garden-state', pots: six(pot('tomate', T0)), n: 1, at: iso(T0) }
  const empty = [null, null, null, null, null, null]
  let out = garden.foldBalcony({ owner: OWNER, flag: { ...flag, on: false }, state, now: T0 })
  t.alike([out.on, out.pots, out.stale], [false, empty, false], 'an off flag shows no pots')
  out = garden.foldBalcony({ owner: OWNER, flag: null, state, now: T0 })
  t.alike([out.on, out.pots, out.stale], [false, empty, false], 'no flag')
  out = garden.foldBalcony({ owner: OWNER, flag: { ...flag, at: iso(T0 + 24 * H + 1) }, state, now: T0 })
  t.alike([out.on, out.pots, out.stale], [false, empty, true], 'a future flag is dropped')
  const future = iso(T0 + 24 * H + 1)
  out = garden.foldBalcony({ owner: OWNER, flag, state: { ...state, pots: six(pot('tomate', T0 + 24 * H + 1)), at: future }, now: T0 })
  t.alike([out.on, out.pots, out.stale], [true, empty, true], 'a future state is dropped')
  out = garden.foldBalcony({ owner: OWNER, flag, state: { ...state, pots: six(pot('tomate', T0 + 24 * H)), at: iso(T0 + 24 * H) }, now: T0 })
  t.is(out.pots[0].progress, 0, 'a state at the tolerance reads, its pot at zero')
  out = garden.foldBalcony({ owner: OWNER, flag, state: { ...state, n: 7 }, now: T0 })
  t.alike([out.on, out.pots, out.stale], [true, empty, false], 'a malformed state')
  out = garden.foldBalcony({ owner: OWNER, flag, state: { ...state, at: iso(T0 - 1) }, now: T0 })
  t.alike(out.pots, empty, 'a pot dated after its record')
  out = garden.foldBalcony({ owner: OWNER, flag: { ...flag, on: 'true' }, state, now: T0 })
  t.is(out.on, false, 'on must be exactly true')
  out = garden.foldBalcony({ owner: OWNER, flag: { ...flag, extra: 1 }, state, now: T0 })
  t.is(out.on, false, 'a flag with an extra key')
  t.alike(garden.foldBalcony(null), { on: false, pots: empty, helpers: [], stale: false })
})

test('foldBalcony: a pot ripe past the Date range is an empty slot, as potView answers', (t) => {
  const now = 8.64e15 - 1000
  const planted = pot('manjericao', now - 1000)
  const flag = { type: 'garden', on: true, at: iso(now - 50 * H) }
  const state = { type: 'garden-state', pots: six(planted, pot('tomate', now)), n: 1, at: iso(now) }
  t.is(garden.potView(planted, now), null, 'potView answers null')
  t.is(garden.potView(pot('tomate', now), now), null, 'planted at now too')
  const out = garden.foldBalcony({ owner: OWNER, flag, state, now })
  t.is(out.on, true)
  t.is(out.stale, false)
  t.alike(out.pots, [null, null, null, null, null, null], 'both slots read empty')
  t.ok(out.pots.every((v) => v === null || Math.abs(v.ripeAt) <= 8.64e15), 'no view with an out-of-range ripeAt')
})

test('helpAllowed: reasons', (t) => {
  const follows = new Set([B, C])
  const base = { self: OWNER, to: B, follows, own: [], now: T0 }
  t.alike(garden.helpAllowed(base), { ok: true })
  t.alike(garden.helpAllowed({ ...base, to: OWNER }), { ok: false, reason: 'self' })
  t.alike(garden.helpAllowed({ ...base, to: D }), { ok: false, reason: 'not-following' })
  t.alike(garden.helpAllowed({ ...base, follows: [B] }), { ok: false, reason: 'not-following' }, 'follows must be a Set')
  t.alike(garden.helpAllowed({ ...base, own: [{ to: B, at: iso(T0 - H) }] }), { ok: false, reason: 'same-day' })
  t.alike(garden.helpAllowed({ ...base, own: [{ to: B, at: iso(T0 - H).replace('.000Z', 'Z') }] }), { ok: true }, 'a non-canonical row is no row')
  t.alike(garden.helpAllowed({ ...base, own: [{ to: B, at: T0 - H }] }), { ok: false, reason: 'same-day' }, 'a row in ms')
  t.alike(garden.helpAllowed({ ...base, own: [{ to: B, at: Date.parse('2026-11-16T02:59:59.999Z') }] }), { ok: true }, 'yesterday in Brasília')
  t.alike(garden.helpAllowed({ ...base, own: [{ to: B, at: iso(T0 + 48 * H) }] }), { ok: false, reason: 'same-day' }, 'a future row counts as today')
  const five = [D, E, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64)].map((to) => ({ to, at: iso(T0 - H) }))
  t.alike(garden.helpAllowed({ ...base, own: five }), { ok: false, reason: 'daily' })
  t.alike(garden.helpAllowed({ ...base, own: five.slice(0, 4) }), { ok: true })
  t.alike(garden.helpAllowed({ ...base, own: five.map((r) => ({ ...r, at: iso(T0 - 24 * H) })) }), { ok: true }, 'yesterday frees the budget')
  for (const bad of [{ ...base, now: NaN }, { ...base, now: -8.64e15 }, { ...base, self: 'x' }, { ...base, to: null }, { ...base, own: 'x' }, { ...base, own: undefined }, null]) {
    t.alike(garden.helpAllowed(bad), { ok: false, reason: 'invalid' })
  }
  const hostileSet = new Proxy(new Set([B]), {})
  t.alike(garden.helpAllowed({ ...base, follows: hostileSet }), { ok: false, reason: 'not-following' }, 'a proxied Set never throws')
})

test('saveOrdinal: rollover at the Brasília day', (t) => {
  const prev = (n, atMs) => ({ type: 'garden-state', pots: six(), n, at: iso(atMs) })
  t.is(garden.saveOrdinal(null, T0), 1)
  t.is(garden.saveOrdinal(undefined, T0), 1)
  t.is(garden.saveOrdinal(prev(3, T0 - H), T0), 4)
  t.is(garden.saveOrdinal(prev(5, T0 - H), T0), 6)
  t.is(garden.saveOrdinal(prev(6, T0 - H), T0), null, 'past the daily max')
  t.is(garden.saveOrdinal(prev(6, Date.parse('2026-11-16T02:59:59.999Z')), T0), 1, 'yesterday in Brasília')
  t.is(garden.saveOrdinal(prev(6, Date.parse('2026-11-16T03:00:00.000Z')), T0), null, 'today from 03:00Z')
  t.is(garden.saveOrdinal(prev(6, T0 + 48 * H), T0), null, 'a future state counts as today')
  t.is(garden.saveOrdinal({ ...prev(2, T0 - H), seq: 9 }, T0), 3, 'extra wrapper keys are fine')
  t.is(garden.saveOrdinal(prev(7, T0 - H), T0), null, 'a malformed ordinal')
  t.is(garden.saveOrdinal({ n: 1, at: 'x' }, T0), null, 'a malformed date')
  t.is(garden.saveOrdinal(prev(1, T0), NaN), null, 'no clock')
})

test('saveOrdinal: a clock whose Brasília day starts below the Date range answers null', (t) => {
  const prev = (n, atMs) => ({ type: 'garden-state', pots: six(), n, at: iso(atMs) })
  const early = -8.64e15
  t.is(garden.saveOrdinal(null, early), null, 'no previous state')
  t.is(garden.saveOrdinal(undefined, early), null)
  t.is(garden.saveOrdinal(prev(2, early), early), null, 'a readable previous state')
  t.is(garden.saveOrdinal(null, T0), 1, 'a normal clock is unchanged')
  t.is(garden.saveOrdinal(prev(6, T0 - 24 * H), T0), 1, 'rollover')
  t.is(garden.saveOrdinal(prev(2, T0 - H), T0), 3, 'n + 1')
  t.is(garden.saveOrdinal(prev(6, T0 - H), T0), null, 'past the max')
})
