// The Varandinha writes and reads of the browser node (docs/rpc.md garden.*)
// called straight on member-ops, on memory storage with no seeder and no
// network: the own state, the opt in, a leave (tombstones first, the off
// flag last), one play session as one saved state and one help to a
// followed balcony, with every refusal writing nothing. Every clock is a
// fixed `now`.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { validateRecord, gardenRecord, gardenStateRecord, gardenHelpRecord, gardenDecorRecord, gardenGiftRecord, gardenTakeRecord, followRecord } = require('@varanda/core/lib/records')
const { deletedSeqs } = require('@varanda/core/lib/deletion')
const { garden } = require('@varanda/rpc')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')

const HOUR = 3600000
// 12:00 in Brasília (UTC-3); the Brasília day starts at 03:00Z.
const NOW = Date.UTC(2026, 10, 10, 15, 0, 0)
const DAY_END = Date.UTC(2026, 10, 11, 3, 0, 0)
const iso = (ms) => new Date(ms).toISOString()

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function someKey () {
  return hex(crypto.randomBytes(32))
}

async function prepared (records = []) {
  const kp = generateAssociationKeyPair()
  const keyPair = crypto.keyPair()
  const storage = memoryNodeStorage()
  const ctx = { storage, association: hex(kp.publicKey), keyPair }
  const { publicKey } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: publicKey }, kp))
  await appendRaw(ctx, records)
  return { ctx, key: publicKey }
}

async function appendRaw (ctx, records) {
  for (let i = 0; i < records.length; i += 8) {
    await member.withIdentity(ctx, ({ diary }) => store.appendRecords(diary, records.slice(i, i + 8)))
  }
}

async function rawOf (ctx) {
  return member.withIdentity(ctx, ({ diary }) => store.readRaw(diary))
}

async function lengthOf (ctx) {
  return (await rawOf(ctx)).length
}

function liveOf (raw, type) {
  const gone = deletedSeqs(raw)
  return raw.filter((e) => !gone.has(e.seq) && e.record !== null && e.record.type === type).map((e) => e.seq)
}

// Counts the records of every append (single or batch) and throws on the
// failAt-th batch append (from 1), 0 for never.
function spyAppends (t, failAt = 0) {
  const one = store.appendRecord
  const many = store.appendRecords
  const sizes = []
  let batches = 0
  store.appendRecord = async (diary, record, limits) => {
    sizes.push(1)
    return one(diary, record, limits)
  }
  store.appendRecords = async (diary, records, limits) => {
    sizes.push(records.length)
    if (++batches === failAt) throw new Error('falha simulada')
    return many(diary, records, limits)
  }
  t.teardown(() => {
    store.appendRecord = one
    store.appendRecords = many
  })
  return sizes
}

async function refusal (p) {
  try {
    await p
  } catch (err) {
    return err.message
  }
  return null
}

const onFlag = (ms = NOW - 10 * HOUR) => gardenRecord({ on: true, at: iso(ms) })
const help = (to, ms, pot = 0) => gardenHelpRecord({ to, pot, at: iso(ms) })
const follow = (key, ms = NOW - 20 * HOUR) => followRecord({ key, on: true, at: iso(ms) })
const plant = (pot, id = 'manjericao') => ({ op: 'plant', pot, plant: id })

// ---- gardenOwn ----

test('gardenOwn: a fresh diary, after the opt in and after a play', async (t) => {
  const { ctx } = await prepared()
  t.alike(await member.gardenOwn(ctx, NOW), { on: false, state: null, savesToday: 0, helpsToday: 0, given: [] })
  await member.gardenSet(ctx)
  t.alike(await member.gardenOwn(ctx, NOW), { on: true, state: null, savesToday: 0, helpsToday: 0, given: [] })
  const r = await member.gardenPlay(ctx, { acts: [plant(0)], now: NOW, received: [] })
  const own = await member.gardenOwn(ctx, NOW)
  t.is(own.on, true)
  t.alike(own.state, r.state, 'the state as written')
  t.is(own.state.n, 1)
  t.is(own.savesToday, 1)
})

test('gardenOwn: savesToday resets at 03:00Z, n on the same Brasília day', async (t) => {
  const { ctx } = await prepared([onFlag()])
  await member.gardenPlay(ctx, { acts: [plant(0)], now: DAY_END - 2 * HOUR, received: [] })
  await member.gardenPlay(ctx, { acts: [plant(1)], now: DAY_END - 1, received: [] })
  t.is((await member.gardenOwn(ctx, DAY_END - 1)).savesToday, 2, 'same day: n')
  const next = await member.gardenOwn(ctx, DAY_END)
  t.is(next.savesToday, 0, 'a new Brasília day')
  t.is(next.state.n, 2, 'the state is still reported')
  const r = await member.gardenPlay(ctx, { acts: [plant(2)], now: DAY_END, received: [] })
  t.is(r.state.n, 1, 'the first save of the new day')
})

test('gardenOwn: a future-dated state counts as today (its n)', async (t) => {
  const pots = [null, null, null, null, null, null]
  const { ctx } = await prepared([onFlag(), gardenStateRecord({ pots, n: 1, at: iso(NOW + 30 * HOUR) })])
  t.is((await member.gardenOwn(ctx, NOW)).savesToday, 1, 'counts as today')
  const { ctx: ctx2 } = await prepared([onFlag(), gardenStateRecord({ pots, n: 6, at: iso(NOW + 30 * HOUR) })])
  t.is((await member.gardenOwn(ctx2, NOW)).savesToday, garden.GARDEN_SAVES_DAILY_MAX)
})

test('gardenOwn: helpsToday and given (window cut, newest seq first)', async (t) => {
  const a = someKey()
  const b = someKey()
  const c = someKey()
  const { ctx } = await prepared([
    onFlag(),
    help(a, NOW - 73 * HOUR),
    help(b, NOW - 71 * HOUR, 2),
    help(c, NOW - HOUR, 5),
    help(a, NOW + 2 * HOUR, 1)
  ])
  const raw = await rawOf(ctx)
  const seqs = liveOf(raw, 'garden-help')
  const own = await member.gardenOwn(ctx, NOW)
  t.is(own.helpsToday, 2, 'today and the future-dated one')
  t.alike(own.given, [
    { seq: seqs[3], to: a, pot: 1, at: iso(NOW + 2 * HOUR) },
    { seq: seqs[2], to: c, pot: 5, at: iso(NOW - HOUR) },
    { seq: seqs[1], to: b, pot: 2, at: iso(NOW - 71 * HOUR) }
  ])
})

test('gardenOwn: given holds at most GARDEN_HELP_ROWS rows', async (t) => {
  const records = [onFlag()]
  for (let i = 0; i < garden.GARDEN_HELP_ROWS + 3; i++) records.push(help(someKey(), NOW - 30 * HOUR + i * 60000))
  const { ctx } = await prepared(records)
  const own = await member.gardenOwn(ctx, NOW)
  t.is(own.given.length, garden.GARDEN_HELP_ROWS)
  t.ok(own.given[0].seq > own.given[1].seq, 'newest first')
})

// ---- gardenSet ----

test('gardenSet twice: the earlier flag tombstoned, one live flag', async (t) => {
  const { ctx, key: me } = await prepared()
  const first = await member.gardenSet(ctx)
  const second = await member.gardenSet(ctx)
  const raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden'), [second.seq])
  t.ok(deletedSeqs(raw).has(first.seq), 'the earlier flag is tombstoned')
  t.is(second.ref, me + ':' + second.seq)
})

// ---- gardenPlay ----

test('gardenPlay: refused while the flag is off', async (t) => {
  const { ctx } = await prepared()
  const before = await lengthOf(ctx)
  t.is(await refusal(member.gardenPlay(ctx, { acts: [plant(0)], now: NOW, received: [] })), member.GARDEN_OFF_PLAY)
  await appendRaw(ctx, [gardenRecord({ on: false, at: iso(NOW - HOUR) })])
  const mid = await lengthOf(ctx)
  t.is(await refusal(member.gardenPlay(ctx, { acts: [plant(0)], now: NOW, received: [] })), member.GARDEN_OFF_PLAY)
  t.is(mid, before + 1)
  t.is(await lengthOf(ctx), mid, 'nothing written')
})

test('gardenPlay: one session is one append, 1 block then 2 (tombstone + state)', async (t) => {
  const { ctx } = await prepared([onFlag()])
  const sizes = spyAppends(t)
  const r1 = await member.gardenPlay(ctx, { acts: [plant(0), plant(1, 'tomate'), plant(2, 'alecrim')], now: NOW, received: [] })
  t.alike(sizes, [1], 'the first state alone')
  const r2 = await member.gardenPlay(ctx, { acts: [plant(3), plant(4), { op: 'clear', pot: 0 }], now: NOW + 60000, received: [] })
  t.alike(sizes, [1, 2], 'the previous state tombstone and the new state')
  const raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-state'), [r2.seq])
  t.ok(deletedSeqs(raw).has(r1.seq))
  t.is(r2.state.seq, r2.seq)
  t.is(r2.state.n, 2)
  t.is(r2.state.at, iso(NOW + 60000))
  t.is(r2.state.pots[0], null, 'cleared')
  t.is(r2.state.pots[3].plant, 'manjericao')
  t.is(validateRecord(raw[r2.seq].record, r2.seq), null, 'valid at its seq')
  t.alike(raw[r2.seq].record.pots, r2.state.pots, 'state as written')
})

test('gardenPlay: one bad act refuses the whole batch, nothing written', async (t) => {
  const { ctx } = await prepared([onFlag()])
  await member.gardenPlay(ctx, { acts: [plant(0)], now: NOW, received: [] })
  const before = await lengthOf(ctx)
  t.is(await refusal(member.gardenPlay(ctx, { acts: [plant(1), plant(0)], now: NOW + 1000, received: [] })), member.GARDEN_BAD_PLAY, 'a full pot')
  t.is(await refusal(member.gardenPlay(ctx, { acts: [plant(1), { op: 'water', pot: 0 }], now: NOW + 1000, received: [] })), member.GARDEN_BAD_PLAY, 'watered too recently')
  t.is(await refusal(member.gardenPlay(ctx, { acts: [{ op: 'nope', pot: 1 }], now: NOW + 1000, received: [] })), member.GARDEN_BAD_PLAY, 'an unknown act')
  t.is(await refusal(member.gardenPlay(ctx, { acts: 'x', now: NOW + 1000, received: [] })), member.GARDEN_BAD_PLAY, 'no list')
  t.is(await lengthOf(ctx), before, 'nothing written')
  t.is((await member.gardenOwn(ctx, NOW + 1000)).state.pots[1], null, 'pot 1 still empty')
})

test('gardenPlay: the 7th save of a Brasília day is refused', async (t) => {
  const { ctx } = await prepared([onFlag()])
  for (let i = 0; i < garden.GARDEN_SAVES_DAILY_MAX; i++) {
    const r = await member.gardenPlay(ctx, { acts: [plant(i)], now: NOW + i * 60000, received: [] })
    t.is(r.state.n, i + 1)
  }
  const before = await lengthOf(ctx)
  t.is(await refusal(member.gardenPlay(ctx, { acts: [{ op: 'clear', pot: 0 }], now: NOW + HOUR, received: [] })), member.GARDEN_SAVES_FULL)
  t.is(await lengthOf(ctx), before, 'nothing written')
  t.is((await member.gardenOwn(ctx, NOW + HOUR)).savesToday, garden.GARDEN_SAVES_DAILY_MAX)
})

test('gardenPlay: planted at hour 0, watered at hour 3, harvested under the received bound', async (t) => {
  const { ctx } = await prepared([onFlag()])
  await member.gardenPlay(ctx, { acts: [plant(0)], now: NOW, received: [] })
  const acts = [{ op: 'water', pot: 0 }, { op: 'harvest', pot: 0 }]
  const before = await lengthOf(ctx)
  t.is(await refusal(member.gardenPlay(ctx, { acts, now: NOW + 3 * HOUR, received: [] })), member.GARDEN_BAD_PLAY, 'not ripe without neighbours')
  t.is(await lengthOf(ctx), before)
  const received = Array(6).fill(garden.GARDEN_HELP_PER_POT)
  const water = await member.gardenPlay(ctx, { acts: [{ op: 'water', pot: 0 }], now: NOW + 3 * HOUR, received })
  t.is(water.state.pots[0].w, 1, 'watered')
  const raw = await rawOf(ctx)
  t.is(validateRecord(raw[water.seq].record, water.seq), null, 'valid at its seq')
  const harvest = await member.gardenPlay(ctx, { acts: [{ op: 'harvest', pot: 0 }], now: NOW + 3 * HOUR + 1000, received })
  t.is(harvest.state.pots[0], null, 'harvested')
})

// ---- gardenHelp and gardenHelpCheck ----

// Asserts both the check and the write refuse with `message`, writing nothing.
async function refusedBoth (t, ctx, args, message, label) {
  const before = await lengthOf(ctx)
  t.is(await refusal(member.gardenHelpCheck(ctx, args)), message, 'check: ' + label)
  t.is(await refusal(member.gardenHelp(ctx, args)), message, 'help: ' + label)
  t.is(await lengthOf(ctx), before, 'nothing written: ' + label)
}

test('gardenHelp: self, writer mismatch and own flag off are refused', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([follow(a)])
  await refusedBoth(t, ctx, { to: me, pot: 0, writer: me, now: NOW }, member.GARDEN_HELP_SELF, 'self')
  await refusedBoth(t, ctx, { to: a, pot: 0, writer: someKey(), now: NOW }, store.LOCKED, 'writer mismatch')
  await refusedBoth(t, ctx, { to: a, pot: 0, writer: me, now: NOW }, member.GARDEN_OFF_HELP, 'flag off')
  await appendRaw(ctx, [gardenRecord({ on: false, at: iso(NOW - HOUR) })])
  await refusedBoth(t, ctx, { to: a, pot: 0, writer: me, now: NOW }, member.GARDEN_OFF_HELP, 'flag written off')
})

test('gardenHelp: only a followed balcony (a live follow block, not a queued op)', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag()])
  const args = { to: a, pot: 3, writer: me, now: NOW }
  await refusedBoth(t, ctx, args, member.GARDEN_NOT_FOLLOWING, 'no follow')
  await member.followAdd(ctx, a)
  t.ok((await store.readFollows(ctx.storage)).includes(a), 'kv follows has it')
  await refusedBoth(t, ctx, args, member.GARDEN_NOT_FOLLOWING, 'queued follow only')
  await appendRaw(ctx, [follow(a)])
  const before = await lengthOf(ctx)
  t.is(await member.gardenHelpCheck(ctx, args), undefined, 'the check passes')
  t.is(await lengthOf(ctx), before, 'the check wrote nothing')
  const r = await member.gardenHelp(ctx, args)
  const raw = await rawOf(ctx)
  t.is(r.seq, before, 'one block')
  t.is(r.ref, me + ':' + r.seq)
  t.alike(raw[r.seq].record, { type: 'garden-help', to: a, pot: 3, at: iso(NOW) })
  t.is(validateRecord(raw[r.seq].record, r.seq), null, 'valid at its seq')
})

test('gardenHelp: once per balcony per Brasília day, at most five balconies', async (t) => {
  const keys = Array.from({ length: 6 }, someKey)
  const { ctx, key: me } = await prepared([onFlag(), ...keys.map((k) => follow(k))])
  await member.gardenHelp(ctx, { to: keys[0], pot: 0, writer: me, now: NOW })
  await refusedBoth(t, ctx, { to: keys[0], pot: 1, writer: me, now: NOW + HOUR }, member.GARDEN_SAME_DAY, 'same day')
  for (let i = 1; i < 5; i++) await member.gardenHelp(ctx, { to: keys[i], pot: 0, writer: me, now: NOW + i * 60000 })
  t.is((await member.gardenOwn(ctx, NOW + HOUR)).helpsToday, 5)
  await refusedBoth(t, ctx, { to: keys[5], pot: 0, writer: me, now: NOW + HOUR }, member.GARDEN_HELPS_FULL, 'a 6th balcony')
  const next = await member.gardenHelp(ctx, { to: keys[0], pot: 0, writer: me, now: DAY_END })
  t.ok(next.seq > 0, 'a new Brasília day frees the budget')
})

test('gardenHelp: helps older than the window are tombstoned in the same append', async (t) => {
  const a = someKey()
  const b = someKey()
  const old = Array.from({ length: 9 }, (_, i) => help(someKey(), NOW - 80 * HOUR + i * 60000))
  const { ctx, key: me } = await prepared([onFlag(), follow(a), follow(b), ...old, help(a, NOW - 10 * HOUR)])
  const raw0 = await rawOf(ctx)
  const oldSeqs = liveOf(raw0, 'garden-help').slice(0, 9)
  const recent = liveOf(raw0, 'garden-help')[9]
  const sizes = spyAppends(t)
  const r1 = await member.gardenHelp(ctx, { to: b, pot: 0, writer: me, now: NOW })
  t.alike(sizes, [8], 'one append: 7 tombstones and the help')
  let raw = await rawOf(ctx)
  const gone = deletedSeqs(raw)
  t.alike(oldSeqs.filter((s) => gone.has(s)), oldSeqs.slice(0, 7), 'the oldest seven')
  t.is(r1.seq, raw0.length + 7, 'the help is last')
  t.is(raw[r1.seq].record.type, 'garden-help')
  t.ok(!gone.has(recent), 'a help inside the window stays')
  await member.gardenHelp(ctx, { to: a, pot: 0, writer: me, now: DAY_END + HOUR })
  t.alike(sizes, [8, 3], 'the two left, then the help')
  raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-help').filter((s) => oldSeqs.includes(s)), [], 'every old help gone')
  t.ok(liveOf(raw, 'garden-help').includes(recent))
})

// ---- gardenLeave ----

test('gardenLeave: tombstones every state and help, the off flag last', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([follow(a)])
  await member.gardenSet(ctx)
  await member.gardenPlay(ctx, { acts: [plant(0)], now: NOW, received: [] })
  await member.gardenHelp(ctx, { to: a, pot: 0, writer: me, now: NOW })
  await appendRaw(ctx, [help(someKey(), NOW - 2 * HOUR)])
  const r = await member.gardenLeave(ctx)
  const raw = await rawOf(ctx)
  t.is(r.seq, raw.length - 1, 'the flag is the last block')
  t.is(r.ref, me + ':' + r.seq)
  t.is(raw[r.seq].record.type, 'garden')
  t.is(raw[r.seq].record.on, false)
  t.alike(liveOf(raw, 'garden-state'), [])
  t.alike(liveOf(raw, 'garden-help'), [])
  t.alike(liveOf(raw, 'garden'), [r.seq])
  t.alike(await member.gardenOwn(ctx, NOW), { on: false, state: null, savesToday: 0, helpsToday: 0, given: [] })
  const before = raw.length
  t.is(await member.gardenLeave(ctx), null, 'a second leave writes nothing')
  t.is(await lengthOf(ctx), before)
})

test('gardenLeave: tombstones every decor, gift and take before the off flag', async (t) => {
  const { ctx } = await prepared([onFlag()])
  await appendRaw(ctx, [
    gardenDecorRecord({ items: ['rede'], at: iso(NOW - 3 * HOUR) }),
    gardenGiftRecord({ to: someKey(), item: 'tomate', at: iso(NOW - 2 * HOUR) }),
    gardenTakeRecord({ from: someKey(), seq: 4, at: iso(NOW - HOUR) }),
    gardenDecorRecord({ items: ['gato'], at: iso(NOW - HOUR) })
  ])
  const raw0 = await rawOf(ctx)
  const targets = ['garden-decor', 'garden-gift', 'garden-take'].flatMap((type) => liveOf(raw0, type))
  t.is(targets.length, 4)
  const r = await member.gardenLeave(ctx)
  const raw = await rawOf(ctx)
  t.is(r.seq, raw.length - 1, 'the flag is the last block')
  t.is(raw[r.seq].record.on, false)
  for (const type of ['garden-decor', 'garden-gift', 'garden-take']) t.alike(liveOf(raw, type), [], type + ' gone')
  const tombSeqs = raw.filter((e) => e.record !== null && e.record.type === 'delete' && targets.includes(e.record.seq)).map((e) => e.seq)
  t.is(tombSeqs.length, 4, 'one tombstone each')
  t.ok(tombSeqs.every((s) => s < r.seq), 'every tombstone before the off flag')
})

test('gardenLeave: a flag-off diary with a live decor still cleans up', async (t) => {
  const { ctx } = await prepared([gardenDecorRecord({ items: ['pisca'], at: iso(NOW - HOUR) })])
  const decor = liveOf(await rawOf(ctx), 'garden-decor')
  t.is(decor.length, 1)
  const r = await member.gardenLeave(ctx)
  t.ok(r !== null, 'not nothing to do')
  const raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-decor'), [])
  t.ok(deletedSeqs(raw).has(decor[0]))
  t.is(raw[r.seq].record.on, false, 'the off flag last')
  t.is(await member.gardenLeave(ctx), null, 'a repeat has nothing to do')
})

test('gardenLeave: never opted in answers null', async (t) => {
  const { ctx } = await prepared()
  const before = await lengthOf(ctx)
  t.is(await member.gardenLeave(ctx), null)
  t.is(await lengthOf(ctx), before)
})

test('gardenLeave: cut short keeps the flag on, a repeat finishes', async (t) => {
  const helps = Array.from({ length: 20 }, (_, i) => help(someKey(), NOW - 20 * HOUR + i * 60000))
  const { ctx } = await prepared([onFlag(), ...helps])
  const before = await lengthOf(ctx)
  const sizes = spyAppends(t, 2)
  let err = null
  try {
    await member.gardenLeave(ctx)
  } catch (e) {
    err = e
  }
  t.ok(err, 'fails')
  t.is(err.written, before + 7, 'the first chunk landed')
  t.alike(sizes, [8, 8])
  t.is((await member.gardenOwn(ctx, NOW)).on, true, 'still reads on')
  t.is(liveOf(await rawOf(ctx), 'garden-help').length, 12)
  const r = await member.gardenLeave(ctx)
  t.alike(sizes, [8, 8, 8, 4, 2], 'the rest, then the flag with its tombstone')
  const raw = await rawOf(ctx)
  t.is(r.seq, raw.length - 1)
  t.alike(liveOf(raw, 'garden-help'), [])
  t.alike(liveOf(raw, 'garden-state'), [])
  t.is((await member.gardenOwn(ctx, NOW)).on, false)
})

test('gardenLeave: a failed final flag carries the last tombstone as written', async (t) => {
  const { ctx } = await prepared([onFlag(), help(someKey(), NOW - HOUR)])
  const before = await lengthOf(ctx)
  const sizes = spyAppends(t, 1)
  let err = null
  try {
    await member.gardenLeave(ctx)
  } catch (e) {
    err = e
  }
  t.alike(sizes, [1, 2], 'the tombstone, then the failed flag append')
  t.ok(err, 'fails')
  t.is(err.written, before, 'the tombstone landed')
  t.is((await member.gardenOwn(ctx, NOW)).on, true, 'still reads on')
})

// ---- no text ----

test('no Varandinha record carries a text field', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([follow(a), help(someKey(), NOW - 80 * HOUR)])
  const one = store.appendRecord
  const many = store.appendRecords
  const written = []
  store.appendRecord = (diary, record, limits) => {
    written.push(record)
    return one(diary, record, limits)
  }
  store.appendRecords = (diary, records, limits) => {
    written.push(...records)
    return many(diary, records, limits)
  }
  t.teardown(() => {
    store.appendRecord = one
    store.appendRecords = many
  })
  await member.gardenSet(ctx)
  await member.gardenPlay(ctx, { acts: [plant(0), plant(1)], now: NOW, received: [] })
  await member.gardenHelp(ctx, { to: a, pot: 1, writer: me, now: NOW })
  await member.gardenLeave(ctx)
  t.alike([...new Set(written.map((r) => r.type))].sort(), ['delete', 'garden', 'garden-help', 'garden-state'])
  for (const r of written) t.absent('text' in r, r.type + ' has no text')
})

test('gardenTargetSeqs: the peek list, or null to fail closed', (t) => {
  t.alike(member.gardenTargetSeqs({ on: null, state: null }), [1, 2])
  t.alike(member.gardenTargetSeqs({ on: 9, state: 5 }), [1, 2, 5, 9], 'ascending')
  t.alike(member.gardenTargetSeqs({ on: 2, state: 2 }), [1, 2], 'deduplicated')
  for (const index of [null, 'x', 7, { on: 3, state: 4, indexing: true }, { on: 0, state: null }, { on: 1.5, state: null }, { on: null, state: '4' }, { on: 3 }]) {
    t.is(member.gardenTargetSeqs(index), null, JSON.stringify(index))
  }
})

test('gardenTargetVerdict: every evidence path', (t) => {
  const ON = 3
  const STATE = 5
  const flag = (over = {}) => ({ seq: ON, record: { type: 'garden', on: true, at: iso(NOW - HOUR), ...over } })
  const pot = (plant, ms) => ({ plant, at: iso(ms), water: iso(ms), w: 0 })
  const pots = [pot('tomate', NOW - 2 * HOUR), null, pot('manjericao', NOW - 7 * HOUR), null, null, null]
  const state = (over = {}) => ({ seq: STATE, record: { type: 'garden-state', pots, n: 1, at: iso(NOW - HOUR), ...over } })
  const person = [{ seq: 1, record: { type: 'profile' } }, { seq: 2, record: { type: 'follow' } }]
  const peek = (entries, missing = [], length = 10) => ({ entries: [...person, ...entries], missing, length })
  const index = { on: ON, state: STATE }
  const verdict = (ix, r, p = 0, now = NOW) => member.gardenTargetVerdict(ix, r, p, now)

  t.is(verdict(index, peek([flag(), state()])), null, 'a growing pot of an opted-in member')
  t.is(verdict(index, { entries: [{ seq: 1, record: { type: 'page-roster' } }, flag(), state()], missing: [], length: 10 }), 'page')
  t.is(verdict(index, { entries: [person[0], flag(), state()], missing: [2], length: 10 }), 'unavailable', 'block 2 unread')
  t.is(verdict(index, { entries: [person[0], flag(), state()], missing: [2], length: 2 }), null, 'block 2 past the end')
  t.is(verdict({ on: null, state: null }, peek([])), 'off', 'no flag pointer')
  t.is(verdict(index, peek([state()], [ON])), 'unavailable', 'flag pointer to a missing block')
  t.is(verdict(index, peek([{ seq: ON, record: { type: 'mood' } }, state()])), 'unavailable', 'flag pointer to another type')
  t.is(verdict(index, peek([flag({ on: false }), state()])), 'off', 'flag off')
  t.is(verdict(index, peek([flag({ at: iso(NOW + 25 * HOUR) }), state()])), 'off', 'flag dated past MAX_FUTURE')
  t.is(verdict(index, peek([flag({ at: iso(NOW + 23 * HOUR) }), state()])), null, 'flag inside MAX_FUTURE')
  t.is(verdict({ on: ON, state: null }, peek([flag()])), 'no-plant', 'no state pointer')
  t.is(verdict({ on: ON, state: 2 }, peek([flag()])), 'unavailable', 'stale state below the flag')
  t.is(verdict(index, peek([flag()], [STATE])), 'unavailable', 'state pointer to a missing block')
  t.is(verdict(index, peek([flag(), { seq: STATE, record: { type: 'garden', on: true } }])), 'unavailable', 'state pointer to another type')
  t.is(verdict(index, peek([flag(), state({ pots: 'x' })])), 'unavailable', 'state without pots')
  t.is(verdict(index, peek([flag(), state({ at: iso(NOW + 25 * HOUR) })])), 'no-plant', 'state dated past MAX_FUTURE')
  t.is(verdict(index, peek([flag(), state()]), 1), 'no-plant', 'empty pot')
  t.is(verdict(index, peek([flag(), state()]), 2), 'no-plant', 'ripe pot')
  t.is(verdict(index, peek([flag(), state({ pots: [pot('tomate', NOW + HOUR), null, null, null, null, null], at: iso(NOW + HOUR) })])), 'no-plant', 'planted after the clock')
})
