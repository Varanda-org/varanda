// Pure model of Fãs and Melhores amigos (fans.js): the fan count wording, the
// fan list verified against peeked records, the melhores amigos row that keeps
// only friends who follow the owner back, and the owner's editor.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const rpc = require('@varanda/rpc')

const load = () => import('../src/fans.js')

const key = (n) => n.toString(16).padStart(2, '0').repeat(32)
const OWNER = key(0xa1)
const ME = key(0xb2)
const F1 = key(0xc1)
const F2 = key(0xc2)
const F3 = key(0xc3)
const F4 = key(0xc4)
const AT = '2026-10-20T10:00:00.000Z'
const AT2 = '2026-10-21T10:00:00.000Z'
const AT3 = '2026-10-22T10:00:00.000Z'

const fan = (target, over = {}) => ({ type: 'fan', key: target, on: true, at: AT, ...over })
const follow = (target, over = {}) => ({ type: 'follow', key: target, on: true, at: AT, ...over })
const topRec = (keys, over = {}) => ({ type: 'top-friends', keys, at: AT, ...over })
const peek = (k, entries, invalid = []) => ({ key: k, entries: entries.map(([seq, record]) => ({ seq, record })), invalid, profile: null, username: null })

test('the limit comes from the contract package', async (t) => {
  const { maxTopFriends } = await load()
  t.is(rpc.MAX_TOP_FRIENDS, 8)
  t.is(maxTopFriends(), rpc.MAX_TOP_FRIENDS)
})

test('fan count wording follows the follower counts honesty rules', async (t) => {
  const { fansLabel, fansCountView, COUNTS_INCOMPLETE_NOTE } = await load()
  t.is(fansLabel(0), '0 fãs')
  t.is(fansLabel(1), '1 fã')
  t.is(fansLabel(12), '12 fãs')
  for (const bad of [-1, 1.5, '3', null, undefined, NaN]) t.is(fansLabel(bad), '', String(bad))

  const ok = fansCountView({ fans: { count: 3, indexing: false }, complete: true })
  t.alike(ok, { count: 3, text: '3 fãs', incomplete: false, note: null })
  const indexing = fansCountView({ fans: { count: 3, indexing: true }, complete: true })
  t.is(indexing.incomplete, true)
  t.is(indexing.note, COUNTS_INCOMPLETE_NOTE)
  const notComplete = fansCountView({ fans: { count: 1, indexing: false }, complete: false })
  t.is(notComplete.incomplete, true)
  t.is(notComplete.text, '1 fã')
  // An answer with no complete flag is not complete.
  t.is(fansCountView({ fans: { count: 1, indexing: false } }).incomplete, true)
  for (const bad of [null, undefined, {}, { count: -1, indexing: false }, { count: 2 }, { count: 2, indexing: 'no' }, []]) {
    t.alike(fansCountView({ fans: bad, complete: true }), { count: null, text: '', incomplete: false, note: null })
  }
  t.alike(fansCountView(), { count: null, text: '', incomplete: false, note: null })
})

test('planFanPeeks asks each fan diary for its own pointers and skips blocked and malformed ones', async (t) => {
  const { planFanPeeks, FANS_PAGE_MAX } = await load()
  const items = [
    { key: F1, seq: 4, at: AT },
    { key: F1, seq: 2, at: AT },
    { key: F2, seq: 7, at: AT },
    { key: F3, seq: 1, at: AT },
    { key: OWNER, seq: 1, at: AT },
    { key: F4, seq: 0, at: AT },
    { key: 'nope', seq: 1, at: AT },
    null
  ]
  t.alike(planFanPeeks({ author: OWNER, items, isBlocked: (k) => k === F3 }), [
    { author: F1, seqs: [2, 4] },
    { author: F2, seqs: [7] }
  ])
  t.alike(planFanPeeks({ author: 'x', items }), [])
  t.alike(planFanPeeks({ author: OWNER, items: 'nope' }), [])
  t.alike(planFanPeeks(), [])
  const many = Array.from({ length: 70 }, (_, i) => ({ key: F1, seq: i + 1, at: AT }))
  const batches = planFanPeeks({ author: OWNER, items: many })
  t.is(batches.length, 1, 'only one page of pointers is planned')
  t.is(batches[0].seqs.length, FANS_PAGE_MAX)
  t.alike(batches[0].seqs, Array.from({ length: FANS_PAGE_MAX }, (_, i) => i + 1))
})

test('planFanPeeks plans at most one page of fans from an untrusted list of any length', async (t) => {
  const { planFanPeeks, confirmFans, FANS_PAGE_MAX } = await load()
  const { FOLLOWS_MAX } = await import('../src/indexClient.js')
  t.is(FANS_PAGE_MAX, FOLLOWS_MAX, 'the same page as the follower lists')
  const items = Array.from({ length: 500 }, (_, i) => ({ key: key(0x20 + (i % 200)), seq: i + 1, at: AT }))
  const plan = planFanPeeks({ author: OWNER, items })
  t.is(plan.length, FANS_PAGE_MAX, 'one batch per distinct fan, at most a page of them')
  // A pointer past the page is not judged either, even with a peek for it.
  const late = items[FANS_PAGE_MAX]
  const peeks = new Map([[late.key, peek(late.key, [[late.seq, fan(OWNER)]])]])
  const r = confirmFans({ author: OWNER, items, peeks })
  t.alike(r.rows, [])
})

test('confirmFans: only a signed fan record of the author in the fan diary proves a row', async (t) => {
  const { confirmFans } = await load()
  const peeks = new Map([
    [F1, peek(F1, [[2, fan(OWNER, { at: AT })]])],
    [F2, peek(F2, [[3, fan(OWNER, { at: AT3 })]])],
    [F3, peek(F3, [[4, fan(OWNER, { on: false })]])],
    [F4, peek(F4, [[5, fan(key(0xee))]])],
    [key(0xd1), peek(key(0xd1), [[6, fan(OWNER, { at: AT2 })]])],
    [key(0xd2), peek(key(0xd2), [[7, follow(OWNER)]])],
    [key(0xd3), peek(key(0xd3), [[8, fan(OWNER, { extra: 1 })]])],
    [key(0xd4), peek(key(0xd4), [[9, fan(OWNER)]])]
  ])
  const items = [
    { key: F1, seq: 2, at: AT },
    { key: F2, seq: 3, at: AT3 },
    { key: F3, seq: 4, at: AT }, // off
    { key: F4, seq: 5, at: AT }, // another target
    { key: key(0xd1), seq: 6, at: AT }, // date differs from the pointer
    { key: key(0xd2), seq: 7, at: AT }, // a follow is not a fan
    { key: key(0xd3), seq: 8, at: AT }, // extra field
    { key: key(0xd4), seq: 10, at: AT }, // seq not read
    { key: key(0xd5), seq: 1, at: AT }, // no peek at all
    { key: OWNER, seq: 1, at: AT }, // the author is never their own fan
    { key: F1, seq: 99 } // malformed pointer
  ]
  const { rows, unavailable } = confirmFans({ author: OWNER, items, peeks })
  t.alike(rows, [{ key: F2, seq: 3, at: AT3 }, { key: F1, seq: 2, at: AT }])
  t.is(unavailable, 9)
})

test('confirmFans: a peek of another diary cannot vouch for a fan', async (t) => {
  const { confirmFans } = await load()
  // F2's pointer is answered by a peek that says it is F1's diary.
  const peeks = new Map([[F2, peek(F1, [[2, fan(OWNER)]])]])
  const out = confirmFans({ author: OWNER, items: [{ key: F2, seq: 2, at: AT }], peeks })
  t.alike(out.rows, [])
  t.is(out.unavailable, 1)
})

test('confirmFans: newest first with no ranking, one row per fan, blocked fans dropped', async (t) => {
  const { confirmFans } = await load()
  const peeks = {
    [F1]: [peek(F1, [[2, fan(OWNER, { at: AT })], [5, fan(OWNER, { at: AT2 })]])],
    [F2]: peek(F2, [[3, fan(OWNER, { at: AT2 })]]),
    [F3]: peek(F3, [[4, fan(OWNER, { at: AT3 })]])
  }
  const items = [
    { key: F1, seq: 2, at: AT },
    { key: F1, seq: 5, at: AT2 },
    { key: F2, seq: 3, at: AT2 },
    { key: F3, seq: 4, at: AT3 }
  ]
  const all = confirmFans({ author: OWNER, items, peeks })
  t.alike(all.rows.map((r) => r.key), [F3, F1, F2])
  t.is(all.rows[1].seq, 5)
  t.is(all.unavailable, 0)
  const some = confirmFans({ author: OWNER, items, peeks, isBlocked: (k) => k === F3 })
  t.alike(some.rows.map((r) => r.key), [F1, F2])
  t.is(some.unavailable, 0, 'a blocked fan is the reader\'s choice, not a gap')
  t.alike(confirmFans(), { rows: [], unavailable: 0 })
  t.alike(confirmFans({ author: 'x', items, peeks }).rows, [])
})

test('planTopPeeks asks for the owner record and each follow back in the friend diary', async (t) => {
  const { planTopPeeks, maxTopFriends } = await load()
  const top = { seq: 9, back: { [F1]: 4, [F2]: null, [F3]: 6, [OWNER]: 2, nope: 3 } }
  t.alike(planTopPeeks({ owner: OWNER, top }), [
    { author: OWNER, seqs: [9] },
    { author: F1, seqs: [4] },
    { author: F3, seqs: [6] }
  ])
  t.alike(planTopPeeks({ owner: OWNER, top, isBlocked: (k) => k === F1 }).map((b) => b.author), [OWNER, F3])
  t.alike(planTopPeeks({ owner: OWNER, top: null }), [])
  t.alike(planTopPeeks({ owner: OWNER, top: { seq: 0, back: {} } }), [])
  t.alike(planTopPeeks({ owner: 'x', top }), [])
  const back = {}
  for (let i = 0; i < 40; i++) back[key(0x30 + i)] = i + 1
  const plan = planTopPeeks({ owner: OWNER, top: { seq: 1, back } })
  t.is(plan.length, 1 + maxTopFriends(), 'a seeder that lists more cannot make the app read more')
})

test('assembleTop shows a friend to others only when the follow back is peeked and names the owner', async (t) => {
  const { assembleTop } = await load()
  const top = { seq: 3, back: { [F1]: 5, [F2]: 6, [F3]: 7, [F4]: null } }
  const peeks = new Map([
    [OWNER, peek(OWNER, [[3, topRec([F1, F2, F3, F4])]])],
    [F1, peek(F1, [[5, follow(OWNER)]])],
    [F2, peek(F2, [[6, follow(OWNER)]])],
    [F3, peek(F3, [[7, follow(OWNER)]])]
  ])
  const v = assembleTop({ owner: OWNER, self: ME, top, peeks })
  t.alike(v.rows.map((r) => [r.key, r.slot, r.status]), [[F1, 0, 'confirmed'], [F2, 1, 'confirmed'], [F3, 2, 'confirmed']])
  t.is(v.mine, false)
  t.is(v.pending, 0)
  t.is(v.incomplete, false)
  t.is(v.notice, null)
})

test('assembleTop: a forged back pointer shows nothing', async (t) => {
  const { assembleTop } = await load()
  const cases = {
    'follows someone else': [F1, peek(F1, [[5, follow(key(0xee))]])],
    'follow is off': [F1, peek(F1, [[5, follow(OWNER, { on: false })]])],
    'pointer leads to another record type': [F1, peek(F1, [[5, fan(OWNER)]])],
    'pointer leads to a malformed follow': [F1, peek(F1, [[5, follow(OWNER, { at: 'ontem' })]])],
    'pointer leads to an invalid block': [F1, peek(F1, [], [5])],
    'the peek is of another diary': [F1, peek(F2, [[5, follow(OWNER)]])],
    'the block was not read': [F1, peek(F1, [[6, follow(OWNER)]])]
  }
  for (const [name, [k, p]] of Object.entries(cases)) {
    const peeks = new Map([[OWNER, peek(OWNER, [[3, topRec([F1])]])], [k, p]])
    const v = assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F1]: 5 } }, peeks })
    t.alike(v.rows, [], name)
  }
  // A pointer for a key that is not in the record never adds a row.
  const peeks = new Map([[OWNER, peek(OWNER, [[3, topRec([F1])]])], [F2, peek(F2, [[5, follow(OWNER)]])]])
  t.alike(assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F2]: 5 } }, peeks }).rows, [])
  // The pointer is read in the friend's diary, not in the owner's own.
  const own = new Map([[OWNER, peek(OWNER, [[3, topRec([F1])], [5, follow(OWNER)]])]])
  t.alike(assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F1]: 5 } }, peeks: own }).rows, [])
})

test('assembleTop: an unread follow back marks the read incomplete, a definite no does not', async (t) => {
  const { assembleTop, NOTICES } = await load()
  const base = [OWNER, peek(OWNER, [[3, topRec([F1, F2])]])]
  const unread = assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F1]: 5, [F2]: null } }, peeks: new Map([base]) })
  t.alike(unread.rows, [])
  t.is(unread.incomplete, true)
  t.is(unread.notice, NOTICES.incomplete)
  const no = assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F1]: null, [F2]: null } }, peeks: new Map([base]) })
  t.is(no.incomplete, false)
  t.is(no.notice, null)
})

test('assembleTop: an incomplete profile answer says the list may be short, a worse notice wins', async (t) => {
  const { assembleTop, NOTICES } = await load()
  const peeks = new Map([[OWNER, peek(OWNER, [[3, topRec([F1])]])], [F1, peek(F1, [[5, follow(OWNER)]])]])
  const top = { seq: 3, back: { [F1]: 5 } }
  const short = assembleTop({ owner: OWNER, self: ME, top, peeks, complete: false })
  t.is(short.rows.length, 1)
  t.is(short.notice, NOTICES.indexing)
  t.is(short.incomplete, false)
  t.is(assembleTop({ owner: OWNER, self: ME, top, peeks, complete: true }).notice, null)
  t.is(assembleTop({ owner: OWNER, self: ME, top, peeks }).notice, null, 'no flag, no claim')
  const unread = assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F1]: 9 } }, peeks, complete: false })
  t.is(unread.notice, NOTICES.incomplete)
  t.is(assembleTop({ owner: OWNER, self: ME, top: { seq: 4, back: {} }, peeks, complete: false }).notice, NOTICES.unreadable)
  t.is(assembleTop({ owner: OWNER, self: ME, top: null, peeks, complete: false }).notice, null, 'no list, nothing to say')
})

test('assembleTop: a blocked friend never shows to the reader', async (t) => {
  const { assembleTop } = await load()
  const top = { seq: 3, back: { [F1]: 5, [F2]: 6 } }
  const peeks = new Map([
    [OWNER, peek(OWNER, [[3, topRec([F1, F2])]])],
    [F1, peek(F1, [[5, follow(OWNER)]])],
    [F2, peek(F2, [[6, follow(OWNER)]])]
  ])
  const v = assembleTop({ owner: OWNER, self: ME, top, peeks, isBlocked: (k) => k === F1 })
  t.alike(v.rows.map((r) => r.key), [F2])
  t.is(v.rows[0].slot, 1)
  // A blocked owner shows nothing and says why.
  const owner = assembleTop({ owner: OWNER, self: ME, top, peeks, isBlocked: (k) => k === OWNER })
  t.alike(owner.rows, [])
  t.is(typeof owner.notice, 'string')
})

test('assembleTop: a friend who unfollowed after being pinned drops out', async (t) => {
  const { assembleTop } = await load()
  // F1 followed back at seq 5, then unfollowed at seq 9: the seeder's latest follow pointer is 9.
  const peeks = new Map([
    [OWNER, peek(OWNER, [[3, topRec([F1, F2])]])],
    [F1, peek(F1, [[5, follow(OWNER)], [9, follow(OWNER, { on: false, at: AT2 })]])],
    [F2, peek(F2, [[6, follow(OWNER)]])]
  ])
  const after = assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F1]: 9, [F2]: 6 } }, peeks })
  t.alike(after.rows.map((r) => r.key), [F2])
  // The owner still has the pick, now waiting.
  const mine = assembleTop({ owner: OWNER, self: OWNER, top: { seq: 3, back: { [F1]: 9, [F2]: 6 } }, peeks })
  t.alike(mine.rows.map((r) => [r.key, r.status]), [[F1, 'pending'], [F2, 'confirmed']])
  // Before the unfollow (the later off not yet known) the same pick was confirmed.
  const early = new Map([
    [OWNER, peek(OWNER, [[3, topRec([F1, F2])]])],
    [F1, peek(F1, [[5, follow(OWNER)]])],
    [F2, peek(F2, [[6, follow(OWNER)]])]
  ])
  const before = assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F1]: 5, [F2]: 6 } }, peeks: early })
  t.alike(before.rows.map((r) => r.key), [F1, F2])
})

test('assembleTop: a newer off already peeked beats a seeder pointing at an older on', async (t) => {
  const { assembleTop } = await load()
  // The seeder points at F1's old follow (on, seq 5); F1's later off (seq 9) is in the peek.
  const peeks = new Map([
    [OWNER, peek(OWNER, [[3, topRec([F1, F2])]])],
    [F1, peek(F1, [[5, follow(OWNER)], [9, follow(OWNER, { on: false, at: AT2 })]])],
    [F2, peek(F2, [[6, follow(OWNER)], [8, follow(key(0xee), { on: false, at: AT2 })]])]
  ])
  const top = { seq: 3, back: { [F1]: 5, [F2]: 6 } }
  const v = assembleTop({ owner: OWNER, self: ME, top, peeks })
  t.alike(v.rows.map((r) => r.key), [F2], 'F1 is off; an off for someone else does not count against F2')
  t.is(v.incomplete, false)
  // Even when the pointed block itself was not read, the known newer off settles it.
  const unread = new Map([
    [OWNER, peek(OWNER, [[3, topRec([F1])]])],
    [F1, peek(F1, [[9, follow(OWNER, { on: false, at: AT2 })]])]
  ])
  const u = assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F1]: 5 } }, peeks: unread })
  t.alike(u.rows, [])
  t.is(u.incomplete, false)
  // A newer on does not hurt an honest pointer.
  const on = new Map([
    [OWNER, peek(OWNER, [[3, topRec([F1])]])],
    [F1, peek(F1, [[5, follow(OWNER)], [9, follow(OWNER, { at: AT2 })]])]
  ])
  t.alike(assembleTop({ owner: OWNER, self: ME, top: { seq: 3, back: { [F1]: 5 } }, peeks: on }).rows.map((r) => r.key), [F1])
})

test('assembleTop fails closed when the top-friends record cannot be trusted', async (t) => {
  const { assembleTop, NOTICES } = await load()
  const top = { seq: 3, back: { [F1]: 5 } }
  const back = [F1, peek(F1, [[5, follow(OWNER)]])]
  const bad = {
    'not read': peek(OWNER, []),
    'wrong type': peek(OWNER, [[3, { type: 'profile-mood', text: 'oi' }]]),
    'self in the list': peek(OWNER, [[3, topRec([F1, OWNER])]]),
    'duplicate key': peek(OWNER, [[3, topRec([F1, F1])]]),
    'over the limit': peek(OWNER, [[3, topRec(Array.from({ length: rpc.MAX_TOP_FRIENDS + 1 }, (_, i) => key(0x50 + i)))]]),
    'extra field': peek(OWNER, [[3, topRec([F1], { extra: true })]]),
    'bad date': peek(OWNER, [[3, topRec([F1], { at: '2026-10-20' })]]),
    'keys not an array': peek(OWNER, [[3, { type: 'top-friends', keys: F1, at: AT }]]),
    'bad key': peek(OWNER, [[3, topRec(['zz'])]]),
    'invalid block': peek(OWNER, [], [3])
  }
  for (const [name, p] of Object.entries(bad)) {
    const v = assembleTop({ owner: OWNER, self: ME, top, peeks: new Map([[OWNER, p], back]) })
    t.alike(v.rows, [], name)
    t.is(v.notice, NOTICES.unreadable, name)
    t.is(v.incomplete, true, name)
  }
  t.is(assembleTop({ owner: OWNER, self: ME, top: { seq: 'x', back: {} }, peeks: new Map() }).notice, NOTICES.unreadable)
  t.is(assembleTop({ owner: 'x', top, peeks: new Map() }).notice, NOTICES.unreadable)
  // No pointer means no list, not an error.
  const none = assembleTop({ owner: OWNER, self: ME, top: null, peeks: new Map() })
  t.alike(none.rows, [])
  t.is(none.notice, null)
  t.is(none.incomplete, false)
  // An empty record clears the list.
  const empty = assembleTop({ owner: OWNER, self: ME, top, peeks: new Map([[OWNER, peek(OWNER, [[3, topRec([])]])]]) })
  t.alike(empty.rows, [])
  t.is(empty.notice, null)
})

test('owner view keeps pending picks with the waiting label and marks blocked ones', async (t) => {
  const { assembleTop, NOTICES } = await load()
  const top = { seq: 3, back: { [F1]: 5, [F2]: null, [F3]: 7 } }
  const peeks = new Map([
    [OWNER, peek(OWNER, [[3, topRec([F1, F2, F3, F4])]])],
    [F1, peek(F1, [[5, follow(OWNER)]])],
    [F3, peek(F3, [[7, follow(key(0xee))]])] // a forged follow back
  ])
  const v = assembleTop({ owner: OWNER, self: OWNER, top, peeks, isBlocked: (k) => k === F4 })
  t.is(v.mine, true)
  t.alike(v.rows.map((r) => [r.key, r.status]), [[F1, 'confirmed'], [F2, 'pending'], [F3, 'pending'], [F4, 'blocked']])
  t.is(v.rows[1].label, 'esperando seguir de volta')
  t.is(v.rows[1].label, NOTICES.pending)
  t.is(v.rows[0].label, null)
  t.is(v.pending, 2)
  // The same data seen by someone else is the confirmed row only.
  const other = assembleTop({ owner: OWNER, self: ME, top, peeks })
  t.alike(other.rows.map((r) => r.key), [F1])
  t.is(other.pending, 0)
  // Without an identity the reader is never the owner.
  t.is(assembleTop({ owner: OWNER, self: null, top, peeks }).mine, false)
})

test('editor: add, remove, move up and move down keep order and refuse bad picks', async (t) => {
  const { editorState, addPick, removePick, moveUp, moveDown, canMoveUp, canMoveDown, editorChanged, editorRecordKeys, NOTICES } = await load()
  let s = editorState([F1, F2])
  t.alike(s.keys, [F1, F2])
  t.is(editorChanged(s), false)
  t.is(editorRecordKeys(s), null, 'nothing to publish when unchanged')

  s = addPick(s, F3, { self: OWNER })
  t.alike(s.keys, [F1, F2, F3])
  t.is(editorChanged(s), true)

  const dup = addPick(s, F1, { self: OWNER })
  t.is(dup.error, NOTICES.duplicate)
  t.alike(dup.keys, s.keys)
  t.is(addPick(s, OWNER, { self: OWNER }).error, NOTICES.self)
  t.is(addPick(s, 'nope', { self: OWNER }).error, NOTICES.invalid)
  // No known writer key: every pick is refused, nothing is added.
  for (const bad of [null, undefined, 'nope', 42]) {
    const r = addPick(s, F4, { self: bad })
    t.is(r.error, NOTICES.invalid)
    t.alike(r.keys, s.keys)
  }
  t.is(addPick(s, F4).error, NOTICES.invalid)
  t.is(addPick(s, F4, { self: OWNER, isBlocked: (k) => k === F4 }).error, NOTICES.blockedPick)

  t.is(canMoveUp(s, F1), false)
  t.is(canMoveDown(s, F3), false)
  t.is(canMoveUp(s, F3), true)
  t.is(canMoveDown(s, F1), true)
  t.is(canMoveUp(s, F4), false)
  t.is(canMoveDown(s, F4), false)
  t.is(moveUp(s, F1), s, 'the first pick cannot go up')
  t.is(moveDown(s, F3), s, 'the last pick cannot go down')
  t.is(moveUp(s, F4), s)

  s = moveUp(s, F3)
  t.alike(s.keys, [F1, F3, F2])
  s = moveDown(s, F1)
  t.alike(s.keys, [F3, F1, F2])
  t.alike(editorRecordKeys(s, OWNER), [F3, F1, F2])

  s = removePick(s, F1)
  t.alike(s.keys, [F3, F2])
  t.is(removePick(s, F4), s)
  t.alike(s.saved, [F1, F2], 'the saved list stays what it was')

  // Going back to the saved order is no change.
  const back = editorState([F1, F2])
  t.is(editorChanged(moveUp(moveDown(back, F1), F1)), false)
  // Clearing the list is a change that publishes an empty record.
  t.alike(editorRecordKeys(removePick(removePick(back, F1), F2), OWNER), [])
})

test('editor never goes over the limit and never publishes a record the node would refuse', async (t) => {
  const { editorState, addPick, editorRecordKeys, editorRows, NOTICES } = await load()
  const many = Array.from({ length: rpc.MAX_TOP_FRIENDS + 3 }, (_, i) => key(0x60 + i))
  const s = editorState(many)
  t.is(s.keys.length, rpc.MAX_TOP_FRIENDS, 'a saved list over the limit is cut')
  t.is(addPick(s, key(0x99), { self: OWNER }).error, NOTICES.full)
  t.alike(editorState([F1, F1, 'zz', F2]).keys, [F1, F2])
  t.alike(editorState('nope').keys, [])

  // A pick that became the owner's own key, or a hand-made duplicate, is not published.
  const forged = { saved: [F1], keys: [F1, OWNER], error: null }
  t.is(editorRecordKeys(forged, OWNER), null)
  // Without the writer's key the record is never produced, even for a clean change.
  const changed = { saved: [F1], keys: [F1, F2], error: null }
  t.alike(editorRecordKeys(changed, OWNER), [F1, F2])
  for (const bad of [null, undefined, 'nope']) t.is(editorRecordKeys(changed, bad), null)
  t.is(editorRecordKeys({ saved: [], keys: [F1, F1], error: null }, OWNER), null)
  t.is(editorRecordKeys({ saved: [], keys: many, error: null }, OWNER), null)

  // Rows carry the move controls and the pending label from the owner's view.
  const rows = editorRows(editorState([F1, F2, F3]), { rows: [{ key: F2, status: 'pending' }, { key: F1, status: 'confirmed' }] })
  t.alike(rows.map((r) => [r.key, r.canUp, r.canDown, r.pending, r.label]), [
    [F1, false, true, false, null],
    [F2, true, true, true, 'esperando seguir de volta'],
    [F3, true, false, false, null]
  ])
  t.alike(editorRows(editorState([F1]), null).map((r) => r.status), [null])
})

test('texts have no em dash and the module has no quoted RPC method names', async (t) => {
  const { NOTICES } = await load()
  for (const text of Object.values(NOTICES)) t.absent(text.includes('\u2014'), text)
  const src = fs.readFileSync(path.join(__dirname, '../src/fans.js'), 'utf8')
  t.absent(src.includes('\u2014'))
  const used = rpc.METHODS.filter((m) => ["'", '"', '`'].some((q) => src.includes(q + m + q)))
  t.alike(used, [])
})
