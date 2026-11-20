'use strict'

const test = require('brittle')
const b4a = require('b4a')
const { garden } = require('@varanda/rpc')
const records = require('../lib/records')
const { applyDeletes } = require('../lib/deletion')
const feed = require('../lib/feed')
const activity = require('../lib/activity')

const {
  validateRecord, validRecordCopy, decodeBlock, deleteRecord, MAX_BLOCK_BYTES,
  GARDEN_KEYS, GARDEN_STATE_KEYS, GARDEN_HELP_KEYS,
  GARDEN_DECOR_KEYS, GARDEN_GIFT_KEYS, GARDEN_TAKE_KEYS,
  gardenRecord, gardenStateRecord, gardenHelpRecord,
  gardenDecorRecord, gardenGiftRecord, gardenTakeRecord
} = records

const K2 = 'b'.repeat(64)
const AT = '2026-11-16T15:00:00.000Z'
const EARLIER = '2026-11-16T09:00:00.000Z'
const LATER = '2026-11-16T18:00:00.000Z'

function pot (over = {}) {
  return { plant: 'tomate', at: EARLIER, water: EARLIER, w: 0, ...over }
}

function state (over = {}) {
  return { type: 'garden-state', pots: [pot(), null, null, null, null, null], n: 1, at: AT, ...over }
}

function without (record, key) {
  const out = { ...record }
  delete out[key]
  return out
}

test('garden key sets are frozen and exact', async (t) => {
  t.alike([...GARDEN_KEYS], ['type', 'on', 'at'])
  t.alike([...GARDEN_STATE_KEYS], ['type', 'pots', 'n', 'at'])
  t.alike([...GARDEN_HELP_KEYS], ['type', 'to', 'pot', 'at'])
  t.ok(Object.isFrozen(GARDEN_KEYS))
  t.ok(Object.isFrozen(GARDEN_STATE_KEYS))
  t.ok(Object.isFrozen(GARDEN_HELP_KEYS))
})

test('garden phase 2 key sets are frozen, exact and match the rules module', async (t) => {
  t.alike([...GARDEN_DECOR_KEYS], ['type', 'items', 'at'])
  t.alike([...GARDEN_GIFT_KEYS], ['type', 'to', 'item', 'at'])
  t.alike([...GARDEN_TAKE_KEYS], ['type', 'from', 'seq', 'at'])
  t.alike([...GARDEN_DECOR_KEYS], [...garden.DECOR_KEYS])
  t.alike([...GARDEN_GIFT_KEYS], [...garden.GIFT_KEYS])
  t.alike([...GARDEN_TAKE_KEYS], [...garden.TAKE_KEYS])
  t.ok(Object.isFrozen(GARDEN_DECOR_KEYS))
  t.ok(Object.isFrozen(GARDEN_GIFT_KEYS))
  t.ok(Object.isFrozen(GARDEN_TAKE_KEYS))
})

test('phase 1 garden records still refuse any extra key', async (t) => {
  // An extra key would make a Phase 1 reader reject the record, so Phase 2
  // adds record types and never a key to these.
  for (const extra of [{ items: ['rede'] }, { decor: ['rede'] }, { gift: 'tomate' }]) {
    const name = Object.keys(extra)[0]
    t.is(validateRecord({ ...state(), ...extra }, 1), 'malformed', 'garden-state with ' + name)
    t.is(validateRecord({ type: 'garden', on: true, at: AT, ...extra }, 1), 'malformed', 'garden with ' + name)
    t.is(validateRecord({ type: 'garden-help', to: K2, pot: 0, at: AT, ...extra }, 1), 'malformed', 'garden-help with ' + name)
  }
})

test('garden-decor record: rules, reasons and builder', async (t) => {
  const rec = { type: 'garden-decor', items: ['rede', 'gato'], at: AT }
  t.is(validateRecord(rec, 1), null)
  t.is(validateRecord({ ...rec, items: [] }, 1), null, 'no enfeites')
  t.is(validateRecord({ ...rec, items: [...garden.GARDEN_DECOR_IDS] }, 1), null, 'all four enfeites')
  for (const id of garden.GARDEN_DECOR_IDS) t.is(validateRecord({ ...rec, items: [id] }, 1), null, 'one ' + id)
  t.is(validateRecord(rec, 0), 'genesis-required')
  t.is(validateRecord({ ...rec, items: ['rede', 'varal', 'gato', 'pisca', 'rede'] }, 1), 'malformed', 'a list of five')
  t.is(validateRecord({ ...rec, items: ['gato', 'rede'] }, 1), 'malformed', 'out of canonical order')
  t.is(validateRecord({ ...rec, items: ['rede', 'rede'] }, 1), 'malformed', 'a repeated id')
  t.is(validateRecord({ ...rec, items: ['flamingo'] }, 1), 'malformed', 'an unknown id')
  t.is(validateRecord({ ...rec, items: ['Rede'] }, 1), 'malformed', 'ids are exact')
  t.is(validateRecord({ ...rec, items: new Array(2) }, 1), 'malformed', 'a sparse array')
  for (const items of [null, 'rede', {}, 1, [1], [null]]) t.is(validateRecord({ ...rec, items }, 1), 'malformed', 'items ' + JSON.stringify(items))
  t.is(validateRecord({ ...rec, extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateRecord({ ...rec, text: 'oi' }, 1), 'malformed', 'no text field')
  for (const k of ['items', 'at']) t.is(validateRecord(without(rec, k), 1), 'malformed', 'missing ' + k)
  for (const at of ['2026-11-16', 5, null, '2026-11-16T15:00:00Z']) t.is(validateRecord({ ...rec, at }, 1), 'date-invalid', 'at ' + at)
  t.is(validateRecord({ ...rec, items: ['x'], at: 'x' }, 1), 'malformed', 'shape is judged before the date')
  const items = ['rede', 'pisca']
  const built = gardenDecorRecord({ items, at: AT })
  t.alike(built, { ...rec, items: ['rede', 'pisca'] })
  t.not(built.items, items, 'the builder copies the list')
  items.push('gato')
  t.alike(built.items, ['rede', 'pisca'], 'a later change to the caller list does not reach the record')
  t.ok(records.isCanonicalIso(gardenDecorRecord({ items: [] }).at), 'at defaults to now')
  await t.exception.all(async () => gardenDecorRecord({ items: ['gato', 'rede'], at: AT }), /malformed/)
  await t.exception.all(async () => gardenDecorRecord({ items: 'rede', at: AT }), /malformed/)
  await t.exception.all(async () => gardenDecorRecord({ items: ['rede'], at: 'ontem' }), /date-invalid/)
})

test('garden-gift record: rules, reasons and builder', async (t) => {
  const rec = { type: 'garden-gift', to: K2, item: 'tomate', at: AT }
  t.is(validateRecord(rec, 1), null)
  for (const p of garden.GARDEN_PLANTS) t.is(validateRecord({ ...rec, item: p.id }, 1), null, 'item ' + p.id)
  t.is(validateRecord(rec, 0), 'genesis-required')
  for (const item of ['rosa', 'Tomate', 'rede', '', null, 0, {}]) t.is(validateRecord({ ...rec, item }, 1), 'malformed', 'item ' + JSON.stringify(item))
  for (const to of ['B'.repeat(64), K2.slice(1), K2 + 'b', 7, null]) t.is(validateRecord({ ...rec, to }, 1), 'malformed', 'to ' + String(to))
  t.is(validateRecord({ ...rec, extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateRecord({ ...rec, text: 'oi' }, 1), 'malformed', 'no text field')
  t.is(validateRecord({ ...rec, price: 1 }, 1), 'malformed', 'no price field')
  for (const k of ['to', 'item', 'at']) t.is(validateRecord(without(rec, k), 1), 'malformed', 'missing ' + k)
  for (const at of ['2026-11-16', 5, null, '2026-11-16T15:00:00Z']) t.is(validateRecord({ ...rec, at }, 1), 'date-invalid', 'at ' + at)
  t.is(validateRecord({ ...rec, item: 'rosa', at: 'x' }, 1), 'malformed', 'shape is judged before the date')
  t.alike(gardenGiftRecord({ to: K2, item: 'tomate', at: AT }), rec)
  t.ok(records.isCanonicalIso(gardenGiftRecord({ to: K2, item: 'tomate' }).at), 'at defaults to now')
  await t.exception.all(async () => gardenGiftRecord({ to: K2, item: 'rosa', at: AT }), /malformed/)
  await t.exception.all(async () => gardenGiftRecord({ to: 'B'.repeat(64), item: 'tomate', at: AT }), /malformed/)
  await t.exception.all(async () => gardenGiftRecord({ to: K2, item: 'tomate', at: 'ontem' }), /date-invalid/)
})

test('garden-take record: rules, reasons and builder', async (t) => {
  const rec = { type: 'garden-take', from: K2, seq: 7, at: AT }
  t.is(validateRecord(rec, 1), null)
  t.is(validateRecord({ ...rec, seq: 1 }, 1), null, 'the first block after the genesis')
  t.is(validateRecord({ ...rec, seq: Number.MAX_SAFE_INTEGER }, 1), null, 'the largest safe seq')
  t.is(validateRecord(rec, 0), 'genesis-required')
  for (const seq of [0, -1, 1.5, '7', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) t.is(validateRecord({ ...rec, seq }, 1), 'malformed', 'seq ' + String(seq))
  for (const from of ['B'.repeat(64), K2.slice(1), K2 + 'b', 7, null]) t.is(validateRecord({ ...rec, from }, 1), 'malformed', 'from ' + String(from))
  t.is(validateRecord({ ...rec, extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateRecord({ ...rec, text: 'oi' }, 1), 'malformed', 'no text field')
  t.is(validateRecord({ ...rec, hash: K2 }, 1), 'malformed', 'no hash field')
  for (const k of ['from', 'seq', 'at']) t.is(validateRecord(without(rec, k), 1), 'malformed', 'missing ' + k)
  for (const at of ['2026-11-16', 5, null, '2026-11-16T15:00:00Z']) t.is(validateRecord({ ...rec, at }, 1), 'date-invalid', 'at ' + at)
  t.is(validateRecord({ ...rec, seq: 0, at: 'x' }, 1), 'malformed', 'shape is judged before the date')
  t.alike(gardenTakeRecord({ from: K2, seq: 7, at: AT }), rec)
  t.ok(records.isCanonicalIso(gardenTakeRecord({ from: K2, seq: 7 }).at), 'at defaults to now')
  await t.exception.all(async () => gardenTakeRecord({ from: K2, seq: 0, at: AT }), /malformed/)
  await t.exception.all(async () => gardenTakeRecord({ from: 'B'.repeat(64), seq: 7, at: AT }), /malformed/)
  await t.exception.all(async () => gardenTakeRecord({ from: K2, seq: 7, at: 'ontem' }), /date-invalid/)
})

test('a self-addressed gift or take is a valid record', async (t) => {
  // The record does not carry its writer's key; the folds drop it.
  const self = 'c'.repeat(64)
  t.is(validateRecord(gardenGiftRecord({ to: self, item: 'alecrim', at: AT }), 1), null)
  t.is(validateRecord(gardenTakeRecord({ from: self, seq: 3, at: AT }), 4), null)
})

test('garden record: rules, reasons and builder', async (t) => {
  const rec = { type: 'garden', on: true, at: AT }
  t.is(validateRecord(rec, 1), null)
  t.is(validateRecord({ ...rec, on: false }, 7), null)
  t.is(validateRecord(rec, 0), 'genesis-required')
  for (const on of [1, 0, 'true', null, undefined, {}, []]) t.is(validateRecord({ ...rec, on }, 1), 'malformed', 'on ' + String(on))
  t.is(validateRecord({ ...rec, extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateRecord({ ...rec, text: 'oi' }, 1), 'malformed', 'no text field')
  t.is(validateRecord(without(rec, 'on'), 1), 'malformed', 'missing on')
  t.is(validateRecord(without(rec, 'at'), 1), 'malformed', 'missing at')
  for (const at of ['2026-11-16', 5, null, '2026-11-16T15:00:00Z']) t.is(validateRecord({ ...rec, at }, 1), 'date-invalid', 'at ' + at)
  t.is(validateRecord({ ...rec, on: 'yes', at: 'x' }, 1), 'malformed', 'shape is judged before the date')
  t.alike(gardenRecord({ on: true, at: AT }), rec)
  t.alike(gardenRecord({ on: false, at: AT }), { ...rec, on: false })
  t.ok(records.isCanonicalIso(gardenRecord({ on: true }).at), 'at defaults to now')
  await t.exception.all(async () => gardenRecord({ on: 'yes' }), /malformed/)
  await t.exception.all(async () => gardenRecord({ on: true, at: 'ontem' }), /date-invalid/)
})

test('garden-state record: rules and reasons', async (t) => {
  const rec = state()
  t.is(validateRecord(rec, 1), null)
  t.is(validateRecord(state({ pots: [null, null, null, null, null, null] }), 1), null, 'an empty balcony')
  t.is(validateRecord(rec, 0), 'genesis-required')
  t.is(validateRecord({ ...rec, extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateRecord({ ...rec, text: 'oi' }, 1), 'malformed', 'no text field')
  for (const k of ['pots', 'n', 'at']) t.is(validateRecord(without(rec, k), 1), 'malformed', 'missing ' + k)
  for (const at of ['2026-11-16', 5, null, '2026-11-16T15:00:00Z']) t.is(validateRecord(state({ at }), 1), 'date-invalid', 'at ' + at)
  t.is(validateRecord({ ...state({ at: 'x' }), extra: 1 }, 1), 'malformed', 'keys are judged before the date')
  t.is(validateRecord(state({ at: 'x', n: 0 }), 1), 'date-invalid', 'the date is judged before pots and n')
})

test('garden-state record: n is the save ordinal of the day', async (t) => {
  for (let n = 1; n <= garden.GARDEN_SAVES_DAILY_MAX; n++) t.is(validateRecord(state({ n }), 1), null, 'n ' + n)
  for (const n of [0, -1, garden.GARDEN_SAVES_DAILY_MAX + 1, 1.5, '1', null, NaN, Infinity]) {
    t.is(validateRecord(state({ n }), 1), 'malformed', 'n ' + String(n))
  }
})

test('garden-state record: pots shape and dates', async (t) => {
  const empty = [null, null, null, null, null, null]
  const withPot = (p, i = 0) => empty.map((x, j) => (j === i ? p : x))
  t.is(validateRecord(state({ pots: withPot(pot({ water: AT })) }), 1), null, 'watered at the record instant')
  t.is(validateRecord(state({ pots: withPot(pot({ at: AT, water: AT })) }), 1), null, 'planted at the record instant')
  t.is(validateRecord(state({ pots: withPot(pot(), 5) }), 1), null, 'the last pot')
  t.is(validateRecord(state({ pots: withPot(pot({ water: LATER })) }), 1), 'malformed', 'watered after the record')
  t.is(validateRecord(state({ pots: withPot(pot({ at: LATER, water: LATER })) }), 1), 'malformed', 'planted after the record')
  t.is(validateRecord(state({ pots: withPot(pot({ at: AT, water: EARLIER })) }), 1), 'malformed', 'watered before it was planted')
  t.is(validateRecord(state({ pots: withPot(pot({ at: '2026-11-16T09:00:00Z' })) }), 1), 'malformed', 'a pot date that is not canonical')
  t.is(validateRecord(state({ pots: withPot(pot({ plant: 'rosa' })) }), 1), 'malformed', 'unknown plant')
  t.is(validateRecord(state({ pots: withPot(pot({ w: -1 })) }), 1), 'malformed', 'negative waterings')
  t.is(validateRecord(state({ pots: withPot(pot({ w: garden.GARDEN_WATER_MAX + 1 })) }), 1), 'malformed', 'too many waterings')
  t.is(validateRecord(state({ pots: withPot({ ...pot(), extra: 1 }) }), 1), 'malformed', 'extra pot key')
  t.is(validateRecord(state({ pots: withPot(without(pot(), 'w')) }), 1), 'malformed', 'missing pot key')
  t.is(validateRecord(state({ pots: empty.slice(0, 5) }), 1), 'malformed', 'five pots')
  t.is(validateRecord(state({ pots: [...empty, null] }), 1), 'malformed', 'seven pots')
  t.is(validateRecord(state({ pots: new Array(6) }), 1), 'malformed', 'a sparse array')
  for (const pots of [null, {}, 'pots', 6]) t.is(validateRecord(state({ pots }), 1), 'malformed', 'pots ' + String(pots))
  t.is(validateRecord(state({ pots: withPot(pot(), 0).map((p, i) => (i === 3 ? 0 : p)) }), 1), 'malformed', 'a pot that is no object')
})

test('garden-help record: rules, reasons and builder', async (t) => {
  const rec = { type: 'garden-help', to: K2, pot: 0, at: AT }
  t.is(validateRecord(rec, 1), null)
  t.is(validateRecord({ ...rec, pot: 5 }, 1), null, 'the last pot')
  t.is(validateRecord(rec, 0), 'genesis-required')
  for (const p of [6, -1, 1.5, '0', null, NaN]) t.is(validateRecord({ ...rec, pot: p }, 1), 'malformed', 'pot ' + String(p))
  for (const to of ['B'.repeat(64), K2.slice(1), K2 + 'b', 7, null]) t.is(validateRecord({ ...rec, to }, 1), 'malformed', 'to ' + String(to))
  t.is(validateRecord({ ...rec, extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateRecord({ ...rec, text: 'oi' }, 1), 'malformed', 'no text field')
  for (const k of ['to', 'pot', 'at']) t.is(validateRecord(without(rec, k), 1), 'malformed', 'missing ' + k)
  for (const at of ['2026-11-16', 5, null, '2026-11-16T15:00:00Z']) t.is(validateRecord({ ...rec, at }, 1), 'date-invalid', 'at ' + at)
  t.is(validateRecord({ ...rec, to: 'B'.repeat(64), at: 'x' }, 1), 'malformed', 'shape is judged before the date')
  t.alike(gardenHelpRecord({ to: K2, pot: 0, at: AT }), rec)
  await t.exception.all(async () => gardenHelpRecord({ to: K2, pot: 6, at: AT }), /malformed/)
  await t.exception.all(async () => gardenHelpRecord({ to: 'B'.repeat(64), pot: 0, at: AT }), /malformed/)
})

test('gardenStateRecord copies the pots', async (t) => {
  const pots = [pot(), null, null, null, null, pot({ plant: 'alecrim' })]
  const rec = gardenStateRecord({ pots, n: 2, at: AT })
  t.alike(rec, state({ pots: [pot(), null, null, null, null, pot({ plant: 'alecrim' })], n: 2 }))
  t.not(rec.pots, pots)
  t.not(rec.pots[0], pots[0])
  pots[0].w = 99
  pots[1] = pot()
  t.is(rec.pots[0].w, 0, 'a later change to the caller pot does not reach the record')
  t.is(rec.pots[1], null)
  await t.exception.all(async () => gardenStateRecord({ pots: [pot({ water: LATER }), null, null, null, null, null], n: 1, at: AT }), /malformed/)
  await t.exception.all(async () => gardenStateRecord({ pots: [null, null, null, null, null, null], n: 7, at: AT }), /malformed/)
  await t.exception.all(async () => gardenStateRecord({ pots: 'x', n: 1, at: AT }), /malformed/)
})

test('hostile garden records are refused, never thrown', async (t) => {
  const throwing = state()
  Object.defineProperty(throwing, 'pots', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(throwing, 1), 'malformed')
  t.is(validRecordCopy(throwing, 1), null)

  const getterPot = pot()
  Object.defineProperty(getterPot, 'w', { enumerable: true, get () { return 0 } })
  t.is(validateRecord(state({ pots: [getterPot, null, null, null, null, null] }), 1), 'malformed', 'a pot field behind a getter')

  const proxied = new Proxy([pot(), null, null, null, null, null], { getOwnPropertyDescriptor () { throw new Error('boom') } })
  t.is(validateRecord(state({ pots: proxied }), 1), 'malformed', 'a proxy array whose descriptors throw')
  const getTrap = new Proxy([pot(), null, null, null, null, null], { get () { throw new Error('boom') } })
  t.is(validRecordCopy(state({ pots: getTrap }), 1), null, 'a proxy array is never copied')

  const symbolPots = [null, null, null, null, null, null]
  symbolPots[Symbol('x')] = 1
  t.is(validateRecord(state({ pots: symbolPots }), 1), 'malformed', 'an array with a symbol key')

  const extraPots = [null, null, null, null, null, null]
  extraPots.extra = 1
  t.is(validateRecord(state({ pots: extraPots }), 1), 'malformed', 'an array with an extra key')

  const protoPot = Object.create({ evil: true })
  Object.assign(protoPot, pot())
  t.is(validateRecord(state({ pots: [protoPot, null, null, null, null, null] }), 1), 'malformed', 'a pot with a foreign prototype')

  const revocable = Proxy.revocable({}, {})
  revocable.revoke()
  t.is(validateRecord(state({ pots: revocable.proxy }), 1), 'malformed', 'a revoked proxy')
  t.is(validateRecord({ type: 'garden-help', to: K2, pot: { valueOf () { return 0 } }, at: AT }, 1), 'malformed')

  const getterItems = ['rede']
  Object.defineProperty(getterItems, '0', { enumerable: true, get () { return 'rede' } })
  t.is(validateRecord({ type: 'garden-decor', items: getterItems, at: AT }, 1), 'malformed', 'an enfeite behind a getter')
  const extraItems = ['rede']
  extraItems.extra = 1
  t.is(validateRecord({ type: 'garden-decor', items: extraItems, at: AT }, 1), 'malformed', 'an items array with an extra key')
  const throwingItems = new Proxy(['rede'], { getOwnPropertyDescriptor () { throw new Error('boom') } })
  t.is(validateRecord({ type: 'garden-decor', items: throwingItems, at: AT }, 1), 'malformed', 'a proxy array whose descriptors throw')
  const throwingGift = { type: 'garden-gift', to: K2, at: AT }
  Object.defineProperty(throwingGift, 'item', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateRecord(throwingGift, 1), 'malformed')
  t.is(validRecordCopy(throwingGift, 1), null)
  t.is(validateRecord({ type: 'garden-take', from: K2, seq: { valueOf () { return 7 } }, at: AT }, 1), 'malformed')
  t.is(validateRecord({ type: 'garden-gift', to: K2, item: { toString () { return 'tomate' } }, at: AT }, 1), 'malformed')
})

test('garden constants match core: future tolerance and the Brasília day', async (t) => {
  t.is(garden.GARDEN_MAX_FUTURE_MS, feed.MAX_FUTURE_MS)
  t.is(garden.GARDEN_DAY_MS, activity.DAY_MS)
  t.is(garden.GARDEN_DAY_OFFSET_MS, activity.DAY_OFFSET_MS)
  let mismatches = 0
  let checked = 0
  const start = Date.parse('1969-12-25T00:00:00.000Z')
  const end = Date.parse('1970-01-05T00:00:00.000Z')
  // Every 7 minutes 13 seconds across the epoch, then across midnight
  // Brasília (03:00 UTC) of a recent day to the millisecond edges.
  for (let ms = start; ms < end; ms += 433000) {
    checked++
    if (garden.gardenDay(ms) !== activity.localDay(ms)) mismatches++
    if (garden.dayStart(ms) !== activity.dayStart(ms)) mismatches++
  }
  const midnight = Date.parse('2026-11-16T03:00:00.000Z')
  for (const d of [-86400001, -1, 0, 1, 3599999, 86399999, 86400000]) {
    checked++
    if (garden.gardenDay(midnight + d) !== activity.localDay(midnight + d)) mismatches++
    if (garden.dayStart(midnight + d) !== activity.dayStart(midnight + d)) mismatches++
  }
  for (let ms = Date.parse('2026-01-01T00:00:00.000Z'); ms < Date.parse('2027-01-01T00:00:00.000Z'); ms += 3600000 + 17) {
    checked++
    if (garden.gardenDay(ms) !== activity.localDay(ms)) mismatches++
  }
  t.ok(checked > 10000, checked + ' instants')
  t.is(mismatches, 0)
  t.is(garden.gardenDay(midnight - 1), '2026-11-15')
  t.is(garden.gardenDay(midnight), '2026-11-16')
})

test('deleting the newest garden-state makes the previous live one win', async (t) => {
  const older = gardenStateRecord({ pots: [pot(), null, null, null, null, null], n: 1, at: EARLIER })
  const newer = gardenStateRecord({ pots: [null, pot({ plant: 'pimenta', at: AT, water: AT }), null, null, null, null], n: 2, at: AT })
  const latestState = (entries) => {
    let best = null
    for (const e of entries) {
      const copy = e.record === null ? null : validRecordCopy(e.record, e.seq)
      if (copy !== null && copy.type === 'garden-state' && (best === null || e.seq > best.seq)) best = { seq: e.seq, record: copy }
    }
    return best
  }
  const entries = [{ seq: 1, record: older }, { seq: 2, record: newer }]
  t.is(latestState(applyDeletes(entries)).seq, 2, 'the newest wins while it lives')
  const withDelete = [...entries, { seq: 3, record: deleteRecord({ seq: 2, at: LATER }) }]
  const live = applyDeletes(withDelete)
  t.ok(live[1].deleted, 'the newest state is deleted')
  const best = latestState(live)
  t.is(best.seq, 1, 'the previous state wins')
  t.alike(best.record, older)
})

test('garden records survive validRecordCopy and the block codec', async (t) => {
  const recs = [
    gardenRecord({ on: true, at: AT }),
    gardenStateRecord({ pots: [pot(), null, pot({ plant: 'espada', w: 3 }), null, null, null], n: 3, at: AT }),
    gardenHelpRecord({ to: K2, pot: 2, at: AT }),
    gardenDecorRecord({ items: ['varal', 'pisca'], at: AT }),
    gardenGiftRecord({ to: K2, item: 'samambaia', at: AT }),
    gardenTakeRecord({ from: K2, seq: 12, at: AT })
  ]
  for (const r of recs) {
    const copy = validRecordCopy(r, 4)
    t.alike(copy, r, r.type + ' copy')
    t.not(copy, r)
    const decoded = decodeBlock(b4a.from(JSON.stringify(r)))
    t.alike(decoded, r, r.type + ' block round trip')
    t.is(validateRecord(decoded, 4), null)
    t.is(validRecordCopy(r, 0), null, r.type + ' never at seq 0')
  }
  const copy = validRecordCopy(recs[1], 4)
  t.not(copy.pots, recs[1].pots)
  t.not(copy.pots[0], recs[1].pots[0])
  t.not(validRecordCopy(recs[3], 4).items, recs[3].items)
})

test('a full six-pot garden-state is far below MAX_BLOCK_BYTES', async (t) => {
  const max = '2026-11-16T15:00:00.000Z'
  const pots = garden.GARDEN_PLANTS.map((p) => ({ plant: p.id, at: '2026-11-16T09:00:00.000Z', water: max, w: garden.GARDEN_WATER_MAX }))
  t.is(pots.length, garden.GARDEN_POTS)
  const rec = gardenStateRecord({ pots, n: garden.GARDEN_SAVES_DAILY_MAX, at: max })
  const bytes = b4a.byteLength(JSON.stringify(rec))
  t.is(MAX_BLOCK_BYTES, 16384)
  t.ok(bytes < MAX_BLOCK_BYTES / 16, bytes + ' bytes')
})
