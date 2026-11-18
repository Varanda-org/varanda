// The Enfeites and Barraquinha writes and reads of the browser node
// (docs/rpc.md garden.*) called straight on member-ops, on memory storage
// with no seeder and no network: the own stall, a decor publish, a give (the
// emptied state and the gift in one append), a take with its two-sided
// consent, a drop, and every refusal writing nothing. Every clock is a fixed
// Saturday `SAT` unless a test says otherwise.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { validateRecord, gardenRecord, gardenStateRecord, gardenDecorRecord, gardenGiftRecord, gardenTakeRecord, followRecord } = require('@varanda/core/lib/records')
const { deletedSeqs } = require('@varanda/core/lib/deletion')
const { garden } = require('@varanda/rpc')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')

const HOUR = 3600000
const DAY = 24 * HOUR
// Saturday 12:00 in Brasília (UTC-3); the Brasília day starts at 03:00Z.
const SAT = Date.UTC(2026, 10, 14, 15, 0, 0)
const FRI = SAT - DAY
const LAST_SAT = SAT - 7 * DAY
const TAKE_KEEP_MS = 691200000
const APPEND_MAX = 8
const iso = (ms) => new Date(ms).toISOString()
const ZEROS = [0, 0, 0, 0, 0, 0]

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

const onFlag = (ms = SAT - 10 * HOUR) => gardenRecord({ on: true, at: iso(ms) })
const follow = (key, ms = SAT - 20 * HOUR) => followRecord({ key, on: true, at: iso(ms) })
const pot = (plant, ms) => ({ plant, at: iso(ms), water: iso(ms), w: 0 })
// Pots 0, 3, 4 and 5 hold a ripe manjericao (6 h), pot 1 a growing tomate
// (10 h) and pot 2 is empty.
const RIPE = pot('manjericao', SAT - 7 * HOUR)
const POTS = [RIPE, pot('tomate', SAT - 2 * HOUR), null, RIPE, RIPE, RIPE]
const state = (ms = SAT - HOUR / 2, n = 1, pots = POTS) => gardenStateRecord({ pots, n, at: iso(ms) })
const gift = (to, ms = SAT - HOUR, item = 'tomate') => gardenGiftRecord({ to, item, at: iso(ms) })
const take = (from, seq, ms = SAT - HOUR) => gardenTakeRecord({ from, seq, at: iso(ms) })

test('the fixed clocks: SAT is a stall Saturday, FRI is not', (t) => {
  t.ok(garden.stallDay(SAT))
  t.ok(garden.stallDay(LAST_SAT))
  t.absent(garden.stallDay(FRI))
})

// ---- gardenStallOwn ----

test('gardenStallOwn: a fresh diary, then opted in', async (t) => {
  const { ctx } = await prepared()
  const empty = { open: true, decor: null, giftsToday: 0, takesToday: 0, gave: [], takes: [] }
  t.alike(await member.gardenStallOwn(ctx, SAT), empty)
  await member.gardenSet(ctx)
  t.alike(await member.gardenStallOwn(ctx, SAT), empty)
  t.is((await member.gardenStallOwn(ctx, FRI)).open, false, 'closed on a Friday')
})

test('gardenStallOwn: an unreadable clock reads both budgets spent and the stall closed', async (t) => {
  const { ctx } = await prepared([onFlag(), gift(someKey()), take(someKey(), 3)])
  for (const now of [NaN, Infinity, 'x', 9e15]) {
    t.alike(await member.gardenStallOwn(ctx, now), {
      open: false,
      decor: null,
      giftsToday: garden.GARDEN_GIFTS_DAILY_MAX,
      takesToday: garden.GARDEN_TAKES_DAILY_MAX,
      gave: [],
      takes: []
    }, String(now))
  }
})

test('gardenStallOwn: gave and takes, newest seq first, cut and windowed', async (t) => {
  const a = someKey()
  const b = someKey()
  const c = someKey()
  const { ctx } = await prepared([
    take(c, 9, SAT - 2 * HOUR), // at or below the on flag: never listed
    onFlag(),
    gift(a, LAST_SAT), // its week ended
    gift(b, SAT - 2 * HOUR, 'manjericao'),
    gift(a, FRI), // not a Saturday
    take(a, 5, SAT - TAKE_KEEP_MS - 1), // older than eight days
    take(b, 6, FRI),
    take(c, 7, SAT - HOUR)
  ])
  const raw = await rawOf(ctx)
  const gifts = liveOf(raw, 'garden-gift')
  const takes = liveOf(raw, 'garden-take')
  const own = await member.gardenStallOwn(ctx, SAT)
  t.is(own.giftsToday, 1)
  t.is(own.takesToday, 1, 'only the take above the flag dated today')
  t.alike(own.gave, [{ seq: gifts[1], to: b, item: 'manjericao', at: iso(SAT - 2 * HOUR) }])
  t.alike(own.takes, [
    { seq: takes[3], from: c, gseq: 7, at: iso(SAT - HOUR) },
    { seq: takes[2], from: b, gseq: 6, at: iso(FRI) }
  ])
})

test('gardenStallOwn: 13 live takes in the window are all returned, at most GARDEN_TAKE_ROWS', async (t) => {
  const thirteen = Array.from({ length: 13 }, (_, i) => take(someKey(), i + 1, SAT - i * 12 * HOUR))
  const { ctx } = await prepared([onFlag(SAT - 8 * DAY), ...thirteen])
  const own = await member.gardenStallOwn(ctx, SAT)
  t.is(own.takes.length, 13)
  t.ok(own.takes.every((r, i) => i === 0 || own.takes[i - 1].seq > r.seq), 'newest seq first')
  const many = Array.from({ length: garden.GARDEN_TAKE_ROWS + 6 }, (_, i) => take(someKey(), i + 1, SAT - i * HOUR))
  const { ctx: ctx2 } = await prepared([onFlag(SAT - 8 * DAY), ...many])
  t.is((await member.gardenStallOwn(ctx2, SAT)).takes.length, garden.GARDEN_TAKE_ROWS)
  const gifts = Array.from({ length: garden.GARDEN_GIFT_ROWS + 3 }, () => gift(someKey()))
  const { ctx: ctx3 } = await prepared([onFlag(), ...gifts])
  const own3 = await member.gardenStallOwn(ctx3, SAT)
  t.is(own3.gave.length, garden.GARDEN_GIFT_ROWS)
  t.is(own3.giftsToday, garden.GARDEN_GIFT_ROWS + 3)
})

test('gardenStallOwn: with the flag off decor is null and both lists empty', async (t) => {
  const { ctx } = await prepared([onFlag(), gardenDecorRecord({ items: ['rede'], at: iso(SAT - HOUR) }), gift(someKey()), take(someKey(), 4)])
  t.ok((await member.gardenStallOwn(ctx, SAT)).decor !== null)
  await appendRaw(ctx, [gardenRecord({ on: false, at: iso(SAT - HOUR) })])
  const own = await member.gardenStallOwn(ctx, SAT)
  t.is(own.decor, null)
  t.alike(own.gave, [])
  t.alike(own.takes, [])
  t.is(own.takesToday, 0)
})

// ---- gardenDecor ----

test('gardenDecor: refused with the flag off, nothing written', async (t) => {
  const { ctx } = await prepared()
  const before = await lengthOf(ctx)
  t.is(await refusal(member.gardenDecor(ctx, { items: ['rede'] })), member.GARDEN_OFF_PLAY)
  t.is(await lengthOf(ctx), before)
})

test('gardenDecor: a publish replaces the previous block', async (t) => {
  const { ctx, key: me } = await prepared([onFlag()])
  const sizes = spyAppends(t)
  const first = await member.gardenDecor(ctx, { items: ['rede', 'gato'] })
  t.alike(first.items, ['rede', 'gato'])
  t.is(first.ref, me + ':' + first.seq)
  const second = await member.gardenDecor(ctx, { items: ['pisca'] })
  t.alike(sizes, [1, 2], 'the previous decor tombstone and the new decor in one append')
  const raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-decor'), [second.seq])
  t.ok(deletedSeqs(raw).has(first.seq))
  t.is(validateRecord(raw[second.seq].record, second.seq), null)
  t.alike((await member.gardenStallOwn(ctx, SAT)).decor, { seq: second.seq, items: ['pisca'] })
  t.ok(/^registro inválido/.test(await refusal(member.gardenDecor(ctx, { items: ['gato', 'rede'] }))), 'not canonical order')
})

test('gardenStallOwn: a decor at or below the on flag is not shown', async (t) => {
  const { ctx } = await prepared([gardenDecorRecord({ items: ['varal'], at: iso(SAT - 12 * HOUR) }), onFlag()])
  t.is((await member.gardenStallOwn(ctx, SAT)).decor, null)
})

// ---- gardenGive and gardenGiveCheck ----

// Asserts both the check and the give refuse with `message`, writing nothing.
async function refusedBoth (t, ctx, args, message, label) {
  const before = await lengthOf(ctx)
  t.is(await refusal(member.gardenGiveCheck(ctx, args)), message, 'check: ' + label)
  t.is(await refusal(member.gardenGive(ctx, args)), message, 'give: ' + label)
  t.is(await lengthOf(ctx), before, 'nothing written: ' + label)
}

test('gardenGive: state and gift in one append of three, the pot emptied, one live state', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag(), follow(a), state()])
  const prev = liveOf(await rawOf(ctx), 'garden-state')
  const args = { to: a, pot: 0, writer: me, now: SAT, received: ZEROS }
  const before = await lengthOf(ctx)
  t.is(await member.gardenGiveCheck(ctx, args), undefined, 'the check passes')
  t.is(await lengthOf(ctx), before, 'the check wrote nothing')
  const sizes = spyAppends(t)
  const r = await member.gardenGive(ctx, args)
  t.alike(sizes, [3], 'one append: the state tombstone, the state, the gift')
  const raw = await rawOf(ctx)
  t.is(r.seq, raw.length - 1, 'the gift is last')
  t.is(r.ref, me + ':' + r.seq)
  t.alike(raw[r.seq].record, { type: 'garden-gift', to: a, item: 'manjericao', at: iso(SAT) })
  t.alike(liveOf(raw, 'garden-state'), [r.state.seq])
  t.ok(deletedSeqs(raw).has(prev[0]))
  t.is(r.state.seq, r.seq - 1)
  t.is(r.state.n, 2)
  t.is(r.state.at, iso(SAT))
  t.is(r.state.pots[0], null, 'the pot emptied')
  t.alike(r.state.pots[3], RIPE, 'the other pots kept')
  t.alike(raw[r.state.seq].record.pots, r.state.pots)
  for (const s of [r.seq, r.state.seq]) t.is(validateRecord(raw[s].record, s), null, 'valid at ' + s)
  const own = await member.gardenStallOwn(ctx, SAT)
  t.is(own.giftsToday, 1)
  t.alike(own.gave, [{ seq: r.seq, to: a, item: 'manjericao', at: iso(SAT) }])
})

test('gardenGive: self, writer mismatch and flag off are refused', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([follow(a), state()])
  await refusedBoth(t, ctx, { to: me, pot: 0, writer: me, now: SAT, received: ZEROS }, member.GARDEN_GIFT_SELF, 'self')
  await refusedBoth(t, ctx, { to: a, pot: 0, writer: someKey(), now: SAT, received: ZEROS }, store.LOCKED, 'writer mismatch')
  await refusedBoth(t, ctx, { to: a, pot: 0, writer: me, now: SAT, received: ZEROS }, member.GARDEN_OFF_PLAY, 'flag off')
})

test('gardenGive: only to a followed member (a live follow block, not a queued op)', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag(), state()])
  const args = { to: a, pot: 0, writer: me, now: SAT, received: ZEROS }
  await refusedBoth(t, ctx, args, member.GARDEN_GIFT_NOT_FOLLOWING, 'no follow')
  await member.followAdd(ctx, a)
  await refusedBoth(t, ctx, args, member.GARDEN_GIFT_NOT_FOLLOWING, 'queued follow only')
  await appendRaw(ctx, [follow(a)])
  t.ok((await member.gardenGive(ctx, args)).seq > 0)
})

test('gardenGive: only on a Saturday', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag(FRI - 10 * HOUR), follow(a, FRI - 20 * HOUR), state(FRI - 6 * HOUR, 1, [pot('manjericao', FRI - 7 * HOUR), null, null, null, null, null])])
  await refusedBoth(t, ctx, { to: a, pot: 0, writer: me, now: FRI, received: ZEROS }, member.GARDEN_STALL_CLOSED, 'a Friday')
})

test('gardenGive: once per person per day, at most three a day', async (t) => {
  const keys = Array.from({ length: 4 }, someKey)
  const { ctx, key: me } = await prepared([onFlag(), ...keys.map((k) => follow(k)), state()])
  const give = (to, p, i) => member.gardenGive(ctx, { to, pot: p, writer: me, now: SAT + i * 60000, received: ZEROS })
  await give(keys[0], 0, 0)
  await refusedBoth(t, ctx, { to: keys[0], pot: 3, writer: me, now: SAT + 60000, received: ZEROS }, member.GARDEN_GIFT_SAME_DAY, 'a second gift to the same person')
  await give(keys[1], 3, 2)
  await give(keys[2], 4, 3)
  t.is((await member.gardenStallOwn(ctx, SAT + HOUR)).giftsToday, 3)
  await refusedBoth(t, ctx, { to: keys[3], pot: 5, writer: me, now: SAT + HOUR, received: ZEROS }, member.GARDEN_GIFTS_FULL, 'a fourth gift')
  t.is(liveOf(await rawOf(ctx), 'garden-state').length, 1, 'one live state after three gives')
})

test('gardenGive: a full save budget is refused, never a gift alone', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag(), follow(a), state(SAT - HOUR, garden.GARDEN_SAVES_DAILY_MAX)])
  await refusedBoth(t, ctx, { to: a, pot: 0, writer: me, now: SAT, received: ZEROS }, member.GARDEN_SAVES_FULL, 'saves spent')
})

test('gardenGive: an empty or growing pot is not ripe, a bad pot is a bad play', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag(), follow(a), state()])
  await refusedBoth(t, ctx, { to: a, pot: 1, writer: me, now: SAT, received: ZEROS }, member.GARDEN_NOT_RIPE, 'growing')
  await refusedBoth(t, ctx, { to: a, pot: 2, writer: me, now: SAT, received: ZEROS }, member.GARDEN_NOT_RIPE, 'empty')
  await refusedBoth(t, ctx, { to: a, pot: 9, writer: me, now: SAT, received: ZEROS }, member.GARDEN_BAD_PLAY, 'no such pot')
  const { ctx: none, key: me2 } = await prepared([onFlag(), follow(a)])
  await refusedBoth(t, none, { to: a, pot: 0, writer: me2, now: SAT, received: ZEROS }, member.GARDEN_NOT_RIPE, 'no state yet')
})

test('gardenGive: a failed final append leaves the previous state and no gift', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag(), follow(a), state()])
  const prev = liveOf(await rawOf(ctx), 'garden-state')
  const before = await lengthOf(ctx)
  spyAppends(t, 1)
  t.is(await refusal(member.gardenGive(ctx, { to: a, pot: 0, writer: me, now: SAT, received: ZEROS })), 'falha simulada')
  const raw = await rawOf(ctx)
  t.is(raw.length, before, 'nothing written')
  t.alike(liveOf(raw, 'garden-state'), prev, 'the previous balcony still shows')
  t.alike(liveOf(raw, 'garden-gift'), [])
})

test('gardenGive: older live states go first, the newest one with the gift', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag(), follow(a), state(SAT - 40 * 60000), state()])
  const prev = liveOf(await rawOf(ctx), 'garden-state')
  t.is(prev.length, 2)
  const before = await lengthOf(ctx)
  const sizes = spyAppends(t, 1)
  let err = null
  try {
    await member.gardenGive(ctx, { to: a, pot: 0, writer: me, now: SAT, received: ZEROS })
  } catch (e) {
    err = e
  }
  t.alike(sizes, [1, 3], 'the older tombstone alone, then the failed final append')
  t.is(err.written, before, 'the older tombstone landed')
  let raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-state'), [prev[1]], 'the newest previous balcony still shows')
  t.alike(liveOf(raw, 'garden-gift'), [])
  const r = await member.gardenGive(ctx, { to: a, pot: 0, writer: me, now: SAT, received: ZEROS })
  raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-state'), [r.state.seq], 'no old state stays live')
})

test('gardenGive: ended gifts pruned in the same append, oldest first, within APPEND_MAX', async (t) => {
  const a = someKey()
  const b = someKey()
  const old = Array.from({ length: 7 }, (_, i) => gift(someKey(), LAST_SAT + i * 60000))
  const { ctx, key: me } = await prepared([onFlag(), follow(a), follow(b), ...old, gift(someKey(), SAT - HOUR), state()])
  const raw0 = await rawOf(ctx)
  const oldSeqs = liveOf(raw0, 'garden-gift').slice(0, 7)
  const recent = liveOf(raw0, 'garden-gift')[7]
  const stateSeq = liveOf(raw0, 'garden-state')[0]
  const sizes = spyAppends(t)
  const r1 = await member.gardenGive(ctx, { to: a, pot: 0, writer: me, now: SAT, received: ZEROS })
  t.alike(sizes, [APPEND_MAX], 'five prunes, the state tombstone, the state, the gift')
  let raw = await rawOf(ctx)
  const block = raw.slice(raw0.length).map((e) => e.record)
  t.alike(block.slice(0, 6).map((r) => r.seq), [...oldSeqs.slice(0, 5), stateSeq], 'the oldest five, then the state')
  t.alike(block.map((r) => r.type), ['delete', 'delete', 'delete', 'delete', 'delete', 'delete', 'garden-state', 'garden-gift'])
  t.is(r1.seq, raw.length - 1)
  await member.gardenGive(ctx, { to: b, pot: 3, writer: me, now: SAT + 60000, received: ZEROS })
  t.alike(sizes, [APPEND_MAX, 5], 'the two left, the state tombstone, the state, the gift')
  raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-gift').filter((s) => oldSeqs.includes(s)), [], 'every ended gift gone')
  t.ok(liveOf(raw, 'garden-gift').includes(recent), 'a gift inside its week stays')
})

// ---- gardenOpenVerdict ----

test('gardenOpenVerdict: page, off and unavailable, null when open', (t) => {
  const ON = 3
  const flag = (over = {}) => ({ seq: ON, record: { type: 'garden', on: true, at: iso(SAT - HOUR), ...over } })
  const person = [{ seq: 1, record: { type: 'profile' } }, { seq: 2, record: { type: 'follow' } }]
  const peek = (entries, missing = [], length = 10) => ({ entries: [...person, ...entries], missing, length })
  const index = { on: ON, state: null }
  const verdict = (ix, r) => member.gardenOpenVerdict(ix, r, SAT)
  t.is(verdict(index, peek([flag()])), null, 'open with no state at all')
  t.is(verdict(index, { entries: [{ seq: 1, record: { type: 'page-roster' } }, flag()], missing: [], length: 10 }), 'page')
  t.is(verdict(index, { entries: [person[0], flag()], missing: [2], length: 10 }), 'unavailable', 'block 2 unread')
  t.is(verdict({ on: null, state: null }, peek([])), 'off')
  t.is(verdict(index, peek([], [ON])), 'unavailable', 'flag pointer to a missing block')
  t.is(verdict(index, peek([{ seq: ON, record: { type: 'mood' } }])), 'unavailable', 'another type')
  t.is(verdict(index, peek([flag({ on: false })])), 'off')
  t.is(verdict(index, peek([flag({ at: iso(SAT + 25 * HOUR) })])), 'off', 'dated past MAX_FUTURE')
})

// ---- gardenTake ----

const giftTo = (to, ms = SAT - HOUR) => gardenGiftRecord({ to, item: 'tomate', at: iso(ms) })

test('gardenTake: refused with the flag off, nothing written', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared()
  const before = await lengthOf(ctx)
  t.is(await refusal(member.gardenTake(ctx, { from: a, seq: 5, record: giftTo(me), now: SAT })), member.GARDEN_OFF_PLAY)
  t.is(await lengthOf(ctx), before)
})

test('gardenTake: one take, then idempotent', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag()])
  const before = await lengthOf(ctx)
  const sizes = spyAppends(t)
  const r = await member.gardenTake(ctx, { from: a, seq: 5, record: giftTo(me), now: SAT })
  t.alike(sizes, [1])
  t.is(r.changed, true)
  t.is(r.seq, before)
  t.is(r.ref, me + ':' + r.seq)
  const raw = await rawOf(ctx)
  t.alike(raw[r.seq].record, { type: 'garden-take', from: a, seq: 5, at: iso(SAT) })
  t.is(validateRecord(raw[r.seq].record, r.seq), null)
  const again = await member.gardenTake(ctx, { from: a, seq: 5, record: giftTo(me), now: SAT + HOUR })
  t.alike(again, { seq: r.seq, ref: r.ref, changed: false })
  t.alike(sizes, [1], 'the repeat wrote nothing')
  t.is(await lengthOf(ctx), before + 1)
})

test('gardenTake: a matching take at or below the on flag gets a fresh take, pruned in the same append', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([take(a, 5, SAT - 12 * HOUR), onFlag()])
  const stale = liveOf(await rawOf(ctx), 'garden-take')
  const sizes = spyAppends(t)
  const r = await member.gardenTake(ctx, { from: a, seq: 5, record: giftTo(me), now: SAT })
  t.is(r.changed, true)
  t.alike(sizes, [2], 'the stale take tombstone and the take')
  const raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-take'), [r.seq])
  t.ok(deletedSeqs(raw).has(stale[0]))
})

test('gardenTake: a gone mimo (self, missing, someone else, expired, not a Saturday)', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag()])
  const before = await lengthOf(ctx)
  const cases = [
    [{ from: me, seq: 5, record: giftTo(me) }, 'self'],
    [{ from: a, seq: 5, record: null }, 'block unavailable'],
    [{ from: a, seq: 5, record: { type: 'post', text: 'x', at: iso(SAT) } }, 'not a gift'],
    [{ from: a, seq: 5, record: giftTo(someKey()) }, 'a gift addressed to someone else'],
    [{ from: a, seq: 5, record: giftTo(me, LAST_SAT) }, 'an expired gift'],
    [{ from: a, seq: 5, record: giftTo(me, FRI) }, 'a non-Saturday gift']
  ]
  for (const [args, label] of cases) t.is(await refusal(member.gardenTake(ctx, { ...args, now: SAT })), member.GARDEN_GIFT_GONE, label)
  t.is(await refusal(member.gardenTake(ctx, { from: a, seq: 0, record: giftTo(me), now: SAT })), member.GARDEN_BAD_PLAY, 'a bad seq')
  t.is(await lengthOf(ctx), before, 'nothing written')
})

test('gardenTake: a seventh take of the day is refused', async (t) => {
  const { ctx, key: me } = await prepared([onFlag()])
  for (let i = 0; i < garden.GARDEN_TAKES_DAILY_MAX; i++) {
    t.is((await member.gardenTake(ctx, { from: someKey(), seq: 5, record: giftTo(me), now: SAT + i * 60000 })).changed, true)
  }
  t.is((await member.gardenStallOwn(ctx, SAT + HOUR)).takesToday, garden.GARDEN_TAKES_DAILY_MAX)
  const before = await lengthOf(ctx)
  t.is(await refusal(member.gardenTake(ctx, { from: someKey(), seq: 5, record: giftTo(me), now: SAT + HOUR })), member.GARDEN_TAKES_FULL)
  t.is(await lengthOf(ctx), before)
})

test('gardenTake: takes older than eight days pruned in the same append, oldest first, within APPEND_MAX', async (t) => {
  const old = Array.from({ length: 9 }, (_, i) => take(someKey(), i + 1, SAT - TAKE_KEEP_MS - DAY + i * 60000))
  const { ctx, key: me } = await prepared([onFlag(SAT - 20 * DAY), ...old, take(someKey(), 50, SAT - 2 * DAY)])
  const raw0 = await rawOf(ctx)
  const oldSeqs = liveOf(raw0, 'garden-take').slice(0, 9)
  const recent = liveOf(raw0, 'garden-take')[9]
  const sizes = spyAppends(t)
  const r = await member.gardenTake(ctx, { from: someKey(), seq: 5, record: giftTo(me), now: SAT })
  t.alike(sizes, [APPEND_MAX], 'seven tombstones and the take')
  let raw = await rawOf(ctx)
  t.alike(raw.slice(raw0.length, raw0.length + 7).map((e) => e.record.seq), oldSeqs.slice(0, 7), 'the oldest seven')
  t.is(r.seq, raw.length - 1, 'the take is last')
  await member.gardenTake(ctx, { from: someKey(), seq: 6, record: giftTo(me), now: SAT + 60000 })
  t.alike(sizes, [APPEND_MAX, 3])
  raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-take').filter((s) => oldSeqs.includes(s)), [], 'every old take gone')
  t.ok(liveOf(raw, 'garden-take').includes(recent), 'a take inside the window stays')
})

// ---- gardenDrop ----

test('gardenDrop: drops an own gift or take with no seeder, even with the flag off', async (t) => {
  const a = someKey()
  const { ctx } = await prepared([onFlag(), gift(a), take(a, 5), gardenRecord({ on: false, at: iso(SAT - HOUR) })])
  const raw0 = await rawOf(ctx)
  const g = liveOf(raw0, 'garden-gift')[0]
  const tk = liveOf(raw0, 'garden-take')[0]
  const r1 = await member.gardenDrop(ctx, { kind: 'gift', seq: g })
  t.alike(r1, { seq: raw0.length, deleted: [g] })
  const r2 = await member.gardenDrop(ctx, { kind: 'take', seq: tk })
  t.alike(r2, { seq: raw0.length + 1, deleted: [tk] })
  const raw = await rawOf(ctx)
  t.alike(liveOf(raw, 'garden-gift'), [])
  t.alike(liveOf(raw, 'garden-take'), [])
  t.is(raw[r1.seq].record.type, 'delete')
  t.is(raw[r1.seq].record.seq, g)
})

test('gardenDrop: the wrong type, a missing or deleted block is refused', async (t) => {
  const a = someKey()
  const { ctx } = await prepared([onFlag(), gift(a), take(a, 5), state()])
  const raw0 = await rawOf(ctx)
  const g = liveOf(raw0, 'garden-gift')[0]
  const tk = liveOf(raw0, 'garden-take')[0]
  const s = liveOf(raw0, 'garden-state')[0]
  const before = raw0.length
  const cases = [
    [{ kind: 'gift', seq: tk }, 'a take as a gift'],
    [{ kind: 'take', seq: g }, 'a gift as a take'],
    [{ kind: 'gift', seq: s }, 'a state'],
    [{ kind: 'gift', seq: 0 }, 'block 0'],
    [{ kind: 'gift', seq: before + 5 }, 'past the end'],
    [{ kind: 'post', seq: g }, 'another kind']
  ]
  for (const [args, label] of cases) t.is(await refusal(member.gardenDrop(ctx, args)), member.GARDEN_NOT_GIFT, label)
  t.is(await lengthOf(ctx), before, 'nothing written')
  await member.gardenDrop(ctx, { kind: 'gift', seq: g })
  t.is(await refusal(member.gardenDrop(ctx, { kind: 'gift', seq: g })), member.GARDEN_NOT_GIFT, 'already deleted')
  t.alike((await member.gardenStallOwn(ctx, SAT)).gave, [], 'the dropped gift is no longer listed')
})

test('gardenStallOwn: a gift dated too far ahead spends today and is listed, so it can be dropped', async (t) => {
  const a = someKey()
  const b = someKey()
  // Dated next Saturday: past GARDEN_MAX_FUTURE_MS ahead of the clock, so
  // offerListable drops it, yet it counts toward today's budget.
  const ahead = SAT + 7 * DAY
  t.absent(garden.offerListable(ahead, SAT), 'offerListable refuses it')
  const { ctx } = await prepared([onFlag(), gift(a, ahead), gift(b, SAT - HOUR)])
  const raw0 = await rawOf(ctx)
  const [future, now] = liveOf(raw0, 'garden-gift')
  const own = await member.gardenStallOwn(ctx, SAT)
  t.is(own.giftsToday, 2)
  t.alike(own.gave.map((r) => r.seq), [now, future], 'both listed, newest seq first')
  t.is(own.gave[1].to, a)
  const r = await member.gardenDrop(ctx, { kind: 'gift', seq: future })
  t.alike(r.deleted, [future])
  const after = await member.gardenStallOwn(ctx, SAT)
  t.is(after.giftsToday, 1, 'the dropped gift no longer spends today')
  t.alike(after.gave.map((g) => g.seq), [now])
  const { ctx: only } = await prepared([onFlag(), gift(a, ahead)])
  const solo = await member.gardenStallOwn(only, SAT)
  t.is(solo.giftsToday, 1)
  t.is(solo.gave.length, 1, 'the only gift is listed')
  const gone = liveOf(await rawOf(only), 'garden-gift')[0]
  await member.gardenDrop(only, { kind: 'gift', seq: gone })
  t.is((await member.gardenStallOwn(only, SAT)).giftsToday, 0)
})

// ---- no text ----

test('no Barraquinha or Enfeites record carries a text field', async (t) => {
  const a = someKey()
  const { ctx, key: me } = await prepared([onFlag(), follow(a), state(), gift(someKey(), LAST_SAT)])
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
  await member.gardenDecor(ctx, { items: ['rede'] })
  const r = await member.gardenGive(ctx, { to: a, pot: 0, writer: me, now: SAT, received: ZEROS })
  await member.gardenTake(ctx, { from: a, seq: 5, record: giftTo(me), now: SAT })
  await member.gardenDrop(ctx, { kind: 'gift', seq: r.seq })
  t.alike([...new Set(written.map((x) => x.type))].sort(), ['delete', 'garden-decor', 'garden-gift', 'garden-state', 'garden-take'])
  for (const x of written) t.absent('text' in x, x.type + ' has no text')
})
