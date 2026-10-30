'use strict'

const test = require('brittle')
const {
  MAX_GROUP_WRITERS, MAX_GROUP_WRITERS_PER_DIARY, GROUP_TYPES,
  validateGroupHeader, validateWriterHeader, validateGroupRecord,
  groupHeader, writerHeader, groupPost, groupHide, groupAdmit, groupBan, groupMeta, groupAdmin, groupLeave,
  groupJoins, groupJoinHistory, orderKey, compareOrder, isFuture, buildGroup
} = require('../lib/group')
const { groupJoinRecord } = require('../lib/records')

const K = (n) => n.toString(16).padStart(64, '0')
const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const AT = (s) => new Date(BASE + s * 1000).toISOString()
const NOW = BASE + 365 * 86400000

const G = K(0x100)
const C = K(1)
const A = K(2)
const B = K(3)
const X = K(4)
const Y = K(5)
const wC = K(0x101)
const wA = K(0x200)
const wB = K(0x300)
const wX = K(0x400)
const wX2 = K(0x401)
const wY = K(0x500)

// A group under construction: the root, writers and the diaries' joins.
function world ({ join = 'open', bindRoot = true } = {}) {
  const logs = new Map([[G, { key: G, diary: C, entries: [{ seq: 0, record: groupHeader({ diary: C, join, name: 'Varanda', at: AT(0) }) }] }]])
  const joins = new Map()
  if (bindRoot) joins.set(C, [{ writer: G, on: true, seq: 1 }])
  const w = {
    logs,
    joins,
    add (diary, key, { rejoin = null, at = AT(0) } = {}) {
      logs.set(key, { key, diary, entries: [{ seq: 0, record: writerHeader({ group: G, diary, rejoin, at }) }] })
      const list = joins.get(diary) || []
      list.push({ writer: key, on: true, seq: list.length + 1 })
      joins.set(diary, list)
      return w
    },
    push (key, record) {
      const log = logs.get(key)
      const seq = log.entries.length
      log.entries.push({ seq, record })
      return { writer: key, seq }
    },
    len (key) {
      return logs.get(key).entries.length
    },
    input ({ drop = [] } = {}) {
      const writers = [...logs.values()].filter((l) => l.key !== G && !drop.includes(l.key))
      return { root: logs.get(G), writers, joins, communities: [], now: NOW }
    }
  }
  return w
}

const post = (w, key, s, extra = {}) => w.push(key, groupPost({ text: 'p' + s, at: AT(s), ...extra }))
const visible = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.writer + ':' + p.seq)
const refs = (g) => g.posts.map((p) => p.writer + ':' + p.seq)

function normalize (g) {
  return { ...g, admins: [...g.admins].sort(), members: [...g.members].sort((a, b) => a[0] < b[0] ? -1 : 1) }
}

test('header shapes', async (t) => {
  const h = groupHeader({ diary: C, name: 'Varanda', at: AT(0) })
  t.alike(Object.keys(h), ['type', 'v', 'kind', 'diary', 'visibility', 'join', 'name', 'box', 'at'])
  t.is(validateGroupHeader(h), null)
  t.is(validateGroupHeader({ ...h, name: null }), null, 'a public group may be unnamed')
  t.is(validateGroupHeader({ ...h, kind: 'community' }), null)
  t.is(validateGroupHeader({ ...h, extra: 1 }), 'malformed', 'extra key')
  t.is(validateGroupHeader({ ...h, v: 2 }), 'malformed')
  t.is(validateGroupHeader({ ...h, kind: 'x' }), 'malformed')
  t.is(validateGroupHeader({ ...h, box: K(9) }), 'malformed', 'public has no box')
  t.is(validateGroupHeader({ ...h, name: '' }), 'name-length')
  t.is(validateGroupHeader({ ...h, name: 'x'.repeat(81) }), 'name-length')
  t.is(validateGroupHeader({ ...h, name: 'a\nb' }), 'control-chars')
  t.is(validateGroupHeader({ ...h, at: 'x' }), 'date-invalid')
  t.is(validateGroupHeader({ ...h, name: 'x'.repeat(20000) }), 'too-large', 'oversized header')
  const priv = { ...h, visibility: 'private', join: 'approval', name: null, box: K(9) }
  t.is(validateGroupHeader(priv), null)
  t.is(validateGroupHeader({ ...priv, box: null }), 'malformed', 'private requires a box')
  t.is(validateGroupHeader({ ...priv, join: 'open' }), 'malformed', 'private implies approval')
  t.is(validateGroupHeader({ ...priv, name: 'x' }), 'malformed', 'private name is null')
  await t.exception.all(async () => groupHeader({ diary: 'x' }), /malformed/)
  const wh = writerHeader({ group: G, diary: X, at: AT(0) })
  t.alike(wh, { type: 'group-writer', v: 1, group: G, diary: X, box: null, rejoin: null, at: AT(0) })
  t.alike(Object.keys(wh), ['type', 'v', 'group', 'diary', 'box', 'rejoin', 'at'])
  t.alike(writerHeader({ group: G, diary: X, rejoin: { writer: wX, seq: 2, x: 1 }, at: AT(0) }).rejoin, { writer: wX, seq: 2 })
  t.is(validateWriterHeader({ ...wh, rejoin: { writer: wX, seq: 0 } }), 'malformed', 'a leave is never block 0')
  t.is(validateWriterHeader({ ...wh, rejoin: 'x' }), 'malformed')
  const noRejoin = { ...wh }
  delete noRejoin.rejoin
  t.is(validateWriterHeader(noRejoin), 'malformed', 'rejoin is required, null or a ref')
  t.is(validateWriterHeader(wh), null)
  t.is(validateWriterHeader({ ...wh, box: K(9) }), 'malformed')
  t.is(validateWriterHeader({ ...wh, extra: 1 }), 'malformed')
  t.is(validateGroupRecord(wh, 0), null)
  t.is(validateGroupRecord(h, 0, { root: true }), null)
  t.is(validateGroupRecord(h, 0), 'malformed', 'a writer core never starts with a group header')
  const hostile = { ...h }
  Object.defineProperty(hostile, 'diary', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateGroupHeader(hostile), 'malformed')
})

test('record shapes', async (t) => {
  t.alike([...GROUP_TYPES], ['group-post', 'group-hide', 'group-admit', 'group-ban', 'group-meta', 'group-admin', 'group-leave'])
  const p = groupPost({ text: 'oi', replyTo: { writer: wA, seq: 1, extra: 1 }, seen: { writer: wB, seq: 2 }, at: AT(1) })
  t.alike(p, { type: 'group-post', text: 'oi', replyTo: { writer: wA, seq: 1 }, seen: { writer: wB, seq: 2 }, at: AT(1) })
  t.is(validateGroupRecord(p, 1), null)
  t.is(validateGroupRecord({ ...p, extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateGroupRecord(p, 0), 'malformed', 'seq 0 is the header')
  t.is(validateGroupRecord({ ...p, text: '' }, 1), 'text-length')
  t.is(validateGroupRecord({ ...p, text: 'x'.repeat(1001) }), 'malformed', 'no seq')
  t.is(validateGroupRecord({ ...p, text: 'x'.repeat(1001) }, 1), 'text-length')
  t.is(validateGroupRecord({ ...p, replyTo: { writer: wA, seq: 0 } }, 1), 'reply-invalid')
  t.is(validateGroupRecord({ ...p, seen: { writer: wA } }, 1), 'seen-invalid')
  const hide = groupHide({ target: { writer: wA, seq: 1 }, on: true, at: AT(1) })
  t.is(validateGroupRecord(hide, 2), null)
  t.is(validateGroupRecord({ ...hide, on: 1 }, 2), 'malformed')
  const cuts = [{ writer: wX, seq: 0 }, { writer: wX2, seq: 4 }]
  for (const build of [groupAdmit, groupBan]) {
    const r = build({ member: X, on: true, cuts, at: AT(1) })
    t.is(validateGroupRecord(r, 1), null, r.type)
    t.is(validateGroupRecord({ ...r, cuts: [{ writer: wX, seq: -1 }] }, 1), 'cuts-invalid', 'negative cut')
    t.is(validateGroupRecord({ ...r, cuts: [{ writer: wX, seq: 1 }, { writer: wX, seq: 2 }] }, 1), 'cuts-invalid', 'repeated writer')
    t.is(validateGroupRecord({ ...r, cuts: [{ writer: wX, seq: 1, x: 1 }] }, 1), 'cuts-invalid')
    t.is(validateGroupRecord({ ...r, cuts: Array.from({ length: 17 }, (_, i) => ({ writer: K(0x900 + i), seq: 1 })) }, 1), 'cuts-invalid', 'over 16 cuts')
    t.is(validateGroupRecord({ ...r, cuts: Array.from({ length: 16 }, (_, i) => ({ writer: K(0x900 + i), seq: 1 })) }, 1), null, '16 cuts')
    t.is(validateGroupRecord({ ...r, cuts: null }, 1), 'cuts-invalid')
    t.is(validateGroupRecord({ ...r, member: 'x' }, 1), 'malformed')
  }
  const ban = groupBan({ member: X, on: true, at: AT(1) })
  t.alike(ban.lifts, null)
  t.is(validateGroupRecord({ ...ban, lifts: { writer: wA, seq: 1 } }, 1), 'lifts-invalid', 'lifts without an unban')
  t.is(validateGroupRecord({ ...ban, on: false }, 1), 'lifts-invalid', 'unban without lifts')
  t.is(validateGroupRecord({ ...ban, on: false, lifts: { writer: wA, seq: 1 } }, 1), null)
  await t.exception.all(async () => groupBan({ member: X, on: false, at: AT(1) }), /lifts-invalid/)
  const meta = groupMeta({ name: 'Novo', join: 'approval', at: AT(1) })
  const admin = groupAdmin({ member: A, on: true, at: AT(1) })
  t.is(validateGroupRecord(meta, 1, { root: true }), null)
  t.is(validateGroupRecord(admin, 1, { root: true }), null)
  t.is(validateGroupRecord(meta, 1), 'root-only')
  t.is(validateGroupRecord(admin, 1), 'root-only')
  t.is(validateGroupRecord({ ...meta, join: 'x' }, 1, { root: true }), 'malformed')
  t.alike(groupLeave({ at: AT(1) }), { type: 'group-leave', seen: null, cuts: [], at: AT(1) })
  t.alike(Object.keys(groupLeave({ at: AT(1) })), ['type', 'seen', 'cuts', 'at'])
  t.alike(groupLeave({ cuts: [{ writer: wX, seq: 2, x: 1 }], at: AT(1) }).cuts, [{ writer: wX, seq: 2 }])
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, cuts: [], at: AT(1), x: 1 }, 1), 'malformed')
  t.is(validateGroupRecord({ type: 'group-leave', cuts: [], at: AT(1) }, 1), 'malformed', 'seen is required, null or a ref')
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, at: AT(1) }, 1), 'malformed', 'cuts are required')
  t.is(validateGroupRecord({ type: 'group-leave', seen: { writer: wX, seq: -1 }, cuts: [], at: AT(1) }, 1), 'seen-invalid')
  const leaveCuts = (n) => Array.from({ length: n }, (_, i) => ({ writer: K(0x900 + i), seq: 1 }))
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, cuts: leaveCuts(MAX_GROUP_WRITERS_PER_DIARY), at: AT(1) }, 1), null, '8 cuts')
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, cuts: leaveCuts(MAX_GROUP_WRITERS_PER_DIARY + 1), at: AT(1) }, 1), 'cuts-invalid', 'over 8 cuts')
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, cuts: [{ writer: wX, seq: 1 }, { writer: wX, seq: 2 }], at: AT(1) }, 1), 'cuts-invalid', 'repeated writer')
  t.is(validateGroupRecord({ type: 'group-unknown', at: AT(1) }, 1), 'malformed')
  t.is(validateGroupRecord({ type: 'toString', at: AT(1) }, 1), 'malformed')
})

test('groupJoins and groupJoinHistory', (t) => {
  const G2 = K(0x999)
  const entries = [
    { seq: 0, record: { type: 'member-cert' } },
    { seq: 3, record: groupJoinRecord({ group: G, writer: wX, on: false, at: AT(3) }) },
    { seq: 1, record: groupJoinRecord({ group: G, writer: wX, on: true, at: AT(1) }) },
    { seq: 2, record: groupJoinRecord({ group: G2, writer: wX2, on: true, at: AT(2) }) },
    { seq: 4, record: { type: 'group-join', group: G, writer: 'x', on: true, at: AT(4) } },
    null
  ]
  t.alike([...groupJoins(entries)], [[wX2, { group: G2, writer: wX2, seq: 2, at: AT(2) }]])
  t.alike(groupJoinHistory(entries, G), [{ writer: wX, on: true, seq: 1 }, { writer: wX, on: false, seq: 3 }])
  t.alike([...groupJoins('x')], [])
  t.alike(groupJoinHistory(null, G), [])
})

test('orderKey and the future skip', (t) => {
  t.ok(compareOrder(orderKey(AT(1), wB, 9), orderKey(AT(2), wA, 1)) < 0)
  t.ok(compareOrder(orderKey(AT(1), wA, 9), orderKey(AT(1), wB, 1)) < 0)
  t.ok(compareOrder(orderKey(AT(1), wA, 1), orderKey(AT(1), wA, 2)) < 0)
  t.ok(isFuture(new Date(BASE + 86400001).toISOString(), BASE))
  t.absent(isFuture(new Date(BASE + 86400000).toISOString(), BASE))
})

test('a basic group and shuffled writer input', (t) => {
  const w = world().add(A, wA).add(X, wX).add(Y, wY)
  post(w, G, 1)
  post(w, wX, 2)
  post(w, wY, 3)
  post(w, wA, 4)
  const g = buildGroup(w.input())
  t.is(g.kind, 'group')
  t.is(g.name, 'Varanda')
  t.is(g.creator, C)
  t.is(g.incomplete, false)
  t.alike(refs(g), [G + ':1', wX + ':1', wY + ':1', wA + ':1'])
  t.alike([...g.members], [[C, 'member'], [A, 'member'], [X, 'member'], [Y, 'member']])
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse().map((l) => ({ ...l, entries: l.entries.slice().reverse() }))
  t.alike(normalize(buildGroup(shuffled)), normalize(g))
  t.alike(buildGroup(null).posts, [])
  t.is(buildGroup({ root: { key: G, entries: [] } }).incomplete, true)
})

test('meta renames and changes the join mode', (t) => {
  const w = world().add(X, wX)
  w.push(G, groupMeta({ name: 'Outro', join: 'approval', at: AT(1) }))
  post(w, wX, 2)
  const g = buildGroup(w.input())
  t.is(g.name, 'Outro')
  t.is(g.join, 'approval')
  t.alike(g.requests, [X])
})

test('ban then unban hides exactly [banCut, unbanCut)', (t) => {
  const w = world().add(X, wX)
  for (let s = 1; s <= 2; s++) post(w, wX, s)
  const ban = w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 3 }], at: AT(10) }))
  for (let s = 3; s <= 5; s++) post(w, wX, s)
  w.push(G, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: 6 }], lifts: ban, at: AT(20) }))
  for (let s = 6; s <= 7; s++) post(w, wX, s)
  const g = buildGroup(w.input())
  t.alike(g.posts.filter((p) => p.hidden).map((p) => p.seq), [3, 4, 5])
  t.is(g.members.get(X), 'member')
})

test('an unban leaves a writer it does not list banned, and bans still lists the ban to lift', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX, 1)
  const ban = w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(2) }))
  post(w, wX, 3)
  post(w, wX2, 4)
  w.push(G, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], lifts: ban, at: AT(5) }))
  post(w, wX, 6)
  post(w, wX2, 7)
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1', wX + ':3'], 'the writer posting during the ban stays banned, its later posts too')
  t.alike(g.bans.get(X), ban, 'the latest ban stays liftable while a counted writer is banned')
  w.push(G, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], lifts: ban, at: AT(8) }))
  post(w, wX2, 9)
  const g2 = buildGroup(w.input())
  t.alike(visible(g2), [wX + ':1', wX + ':3', wX2 + ':3'], 'an unban citing the same ban lifts the listed writer')
  t.absent(g2.bans.has(X))
  t.is(g2.members.get(X), 'member')
})

test('a ban still covers unlisted writers from seq 0', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX, 1)
  post(w, wX2, 2)
  w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(3) }))
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1'])
  t.is(g.members.get(X), 'banned')
  t.ok(g.bans.has(X))
})

test('a cut is an observed length: its reference is seq - 1 and records at seq >= cut are affected', (t) => {
  const w = world().add(X, wX)
  post(w, wX, 100)
  post(w, wX, 101)
  // Clock far behind: without the reference the ban would sort first.
  w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 2 }], at: AT(1) }))
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.seq, p.hidden]), [[1, false], [2, true]])
  const w2 = world().add(X, wX)
  post(w2, wX, 100)
  w2.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 0 }], at: AT(1) }))
  w2.push(G, groupHide({ target: { writer: wX, seq: 1 }, on: false, at: AT(2) }))
  t.alike(buildGroup(w2.input()).posts.map((p) => p.hidden), [true], 'cut 0 covers the whole writer')
  // A's second ban observed wX:1, so it follows B's unban of the first ban
  // even though its clock says otherwise: the unban counts, and wX:1 (below
  // the second ban's cut) is visible again.
  const w3 = world().add(A, wA).add(B, wB).add(X, wX)
  w3.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w3.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  const ban1 = w3.push(wB, groupBan({ member: X, on: true, at: AT(100) }))
  w3.push(wB, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: 1 }], lifts: ban1, at: AT(200) }))
  w3.push(wA, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 2 }], at: AT(150) }))
  post(w3, wX, 300)
  const g3 = buildGroup(w3.input())
  t.is(g3.members.get(X), 'banned')
  t.alike(g3.posts.map((p) => p.hidden), [false])
})

test('lifts is an ordering reference: an unban never sorts before its ban', (t) => {
  const w = world().add(A, wA).add(B, wB).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wX, 2)
  const ban = w.push(wA, groupBan({ member: X, on: true, at: AT(500) }))
  // B's clock is far behind A's; the unban still follows the ban it lifts.
  w.push(wB, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: 1 }], lifts: ban, at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  t.alike(g.posts.map((p) => p.hidden), [false])
})

test('an unban that misses a later ban leaves D banned', (t) => {
  const w = world().add(A, wA).add(B, wB).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wX, 2)
  const b1 = w.push(wA, groupBan({ member: X, on: true, at: AT(3) }))
  w.push(wB, groupBan({ member: X, on: true, at: AT(4) }))
  w.push(wA, groupBan({ member: X, on: false, lifts: b1, at: AT(5) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.alike(g.posts.map((p) => p.hidden), [true])
})

test('an admin demoted with a cut loses actions at seq >= cut even with earlier at', (t) => {
  const w = world().add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  const p1 = post(w, wX, 2)
  const p2 = post(w, wX, 3)
  w.push(wA, groupHide({ target: p1, on: true, at: AT(4) }))
  w.push(wA, groupHide({ target: p2, on: true, at: AT(5) }))
  w.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 2 }], at: AT(3) }))
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => p.hidden), [true, false])
  t.absent(g.admins.has(A))
  t.ok(g.admins.has(C))
})

test('future posts are skipped', (t) => {
  const w = world().add(X, wX)
  post(w, wX, 1)
  w.push(wX, groupPost({ text: 'later', at: new Date(NOW + 86400001).toISOString() }))
  const g = buildGroup(w.input())
  t.alike(refs(g), [wX + ':1'])
  t.alike(g.future, [{ writer: wX, seq: 2 }])
})

test('an approval group hides posts before the admit cut', (t) => {
  const w = world({ join: 'approval' }).add(X, wX).add(X, wX2).add(Y, wY)
  post(w, wX, 1)
  post(w, wX, 2)
  post(w, wX2, 3)
  post(w, wY, 4)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 2 }], at: AT(5) }))
  post(w, wX, 6)
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':2', wX + ':3'], 'a backlog writer the admit does not list stays hidden')
  t.is(g.members.get(X), 'member')
  t.is(g.members.get(Y), 'requested')
  t.alike(g.requests, [X, Y], 'an admitted diary with an uncovered writer is listed for the admins')
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 0 }], at: AT(7) }))
  const g2 = buildGroup(w.input())
  t.alike(visible(g2), [wX + ':2', wX2 + ':1', wX + ':3'], 'a new admit listing the writer admits it')
  t.alike(g2.requests, [Y])
})

test('a writer created after the admit stays hidden until an admit lists it', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  w.add(X, wX2, { at: AT(3) })
  post(w, wX2, 4)
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1'])
  t.is(g.members.get(X), 'member')
  t.alike(g.requests, [X])
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 1 }], at: AT(5) }))
  post(w, wX2, 6)
  const g2 = buildGroup(w.input())
  t.alike(visible(g2), [wX + ':1', wX2 + ':1', wX2 + ':2'])
  t.alike(g2.requests, [])
})

test('an admit withdrawal still covers unlisted writers from seq 0', (t) => {
  const w = world({ join: 'approval' }).add(X, wX).add(X, wX2)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }, { writer: wX2, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  post(w, wX2, 3)
  w.push(G, groupAdmit({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(4) }))
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1'], 'the unlisted writer is withdrawn from seq 0')
  t.is(g.members.get(X), 'requested')
})

test('leave withdraws every writer of D', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX, 1)
  const p2 = post(w, wX2, 2)
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(3) }))
  post(w, wX2, 4, { seen: leave })
  post(w, wX, 5)
  const g = buildGroup(w.input())
  // The other writer's records go from seq 0, whatever the leave's cuts say.
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [[wX + ':1', false], [p2.writer + ':1', true], [wX2 + ':2', true], [wX + ':3', true]])
  t.is(g.members.get(X), 'left')
  const off = w.input()
  off.joins = new Map(off.joins)
  off.joins.set(X, [...off.joins.get(X), { writer: wX, on: false, seq: 9 }])
  t.alike(normalize(buildGroup(off)), normalize(g), 'a diary join on:false never withdraws a writer')
})

const wX3 = K(0x402)

test('a leave cutting another writer past its end withdraws what that writer writes later', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  w.push(G, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }, { writer: wX2, seq: 1 }], at: AT(1) }))
  post(w, wY, 2)
  w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 3 }], at: AT(3) }))
  post(w, wX2, 4)
  w.push(wX2, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(5) }))
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [[wY + ':1', false], [wX2 + ':1', true]], 'the later post is withdrawn')
  t.is(g.members.get(Y), 'member', 'the later ban carries no authority')
  t.is(g.bans.size, 0)
})

test('a creator leaving from another writer keeps the root records below its root cut', (t) => {
  const w = world().add(C, wC).add(A, wA).add(Y, wY)
  w.push(G, groupMeta({ name: 'Novo', join: 'approval', at: AT(1) }))
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(2) }))
  post(w, wY, 3)
  w.push(wA, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(4) }))
  w.push(wC, groupLeave({ cuts: [{ writer: G, seq: w.len(G) }, { writer: wC, seq: w.len(wC) }], at: AT(5) }))
  const g = buildGroup(w.input())
  t.is(g.name, 'Novo')
  t.is(g.join, 'approval')
  t.ok(g.admins.has(A), 'the grant before the cut stays')
  t.is(g.members.get(C), 'left')
  t.is(g.members.get(Y), 'member', 'the admin appointed before the cut still admits')
  t.alike(visible(g), [wY + ':1'])
})

test('a rejoin restores what follows it, never the other writer records before the leave', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX2, 1)
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(2) }))
  w.add(X, wX3, { rejoin: leave, at: AT(3) })
  post(w, wX3, 4)
  post(w, wX2, 5, { seen: { writer: wX3, seq: 0 } })
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [
    [wX2 + ':1', true],
    [wX3 + ':1', false],
    [wX2 + ':2', false]
  ])
  t.is(g.members.get(X), 'member')
})

test('leave then rejoin in an open group', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 1)
  const leave = w.push(wX, groupLeave({ at: AT(2) }))
  post(w, wX, 3)
  w.add(X, wX3, { rejoin: leave, at: AT(4) })
  post(w, wX3, 1)
  post(w, wY, 6)
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [
    [wX + ':1', false],
    [wX + ':3', true],
    [wX3 + ':1', false],
    [wY + ':1', false]
  ], 'pre-leave kept, between leave and rejoin hidden, new posts shown')
  t.is(g.members.get(X), 'member')
  t.is(g.incomplete, false)
  const early = world().add(X, wX)
  const l = early.push(wX, groupLeave({ at: AT(50) }))
  early.add(X, wX3, { rejoin: l, at: AT(1) })
  post(early, wX3, 2)
  t.alike(refs(buildGroup(early.input())), [wX3 + ':1'], 'rejoin orders after the leave whatever its clock')
})

test('a rejoin in an approval group needs a new admit', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  const leave = w.push(wX, groupLeave({ at: AT(3) }))
  w.add(X, wX3, { rejoin: leave, at: AT(4) })
  post(w, wX3, 5)
  const before = buildGroup(w.input())
  t.alike(before.posts.map((p) => p.hidden), [false, true], 'the old admit does not carry over')
  t.is(before.members.get(X), 'requested')
  t.alike(before.requests, [X])
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX3, seq: 1 }], at: AT(6) }))
  const after = buildGroup(w.input())
  t.alike(after.posts.map((p) => p.hidden), [false, false])
  t.is(after.members.get(X), 'member')
})

test('a rejoin naming another diary leave is ignored', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const leave = w.push(wY, groupLeave({ at: AT(1) }))
  const notLeave = post(w, wX, 2)
  w.add(X, wX3, { rejoin: leave, at: AT(3) })
  post(w, wX3, 4)
  const g = buildGroup(w.input())
  t.alike(refs(g), [wX + ':1'])
  t.is(g.incomplete, false)
  w.logs.get(wX3).entries[0].record = writerHeader({ group: G, diary: X, rejoin: notLeave, at: AT(3) })
  const g2 = buildGroup(w.input())
  t.alike(refs(g2), [wX + ':1'], 'a rejoin naming a post is ignored too')
  t.is(g2.incomplete, false)
  w.logs.get(wX3).entries[0].record = writerHeader({ group: G, diary: X, rejoin: { writer: wX, seq: 9 }, at: AT(3) })
  t.is(buildGroup(w.input()).incomplete, true, 'a leave not known yet leaves the group incomplete')
})

test('a banned member who leaves and rejoins stays banned', (t) => {
  const w = world().add(X, wX)
  post(w, wX, 1)
  w.push(G, groupBan({ member: X, on: true, at: AT(2) }))
  const leave = w.push(wX, groupLeave({ at: AT(3) }))
  w.add(X, wX3, { rejoin: leave, at: AT(4) })
  post(w, wX3, 5)
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.alike(g.posts.map((p) => p.hidden), [true, true])
})

test('the author hides own posts; others cannot', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  const p1 = post(w, wX, 1)
  const p2 = post(w, wX, 2)
  w.push(wX2, groupHide({ target: p1, on: true, at: AT(3) }))
  w.push(wY, groupHide({ target: p2, on: true, at: AT(4) }))
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => p.hidden), [true, false])
})

test('last and bans give a writer its seen and lifts', (t) => {
  const w = world().add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  const p = post(w, wX, 2)
  const ban = w.push(wA, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(3) }))
  const g = buildGroup(w.input())
  t.alike(g.last, ban)
  t.alike(g.bans.get(X), ban)
  w.push(wA, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], lifts: g.bans.get(X), at: AT(4) }))
  const g2 = buildGroup(w.input())
  t.absent(g2.bans.has(X), 'nothing to lift once unbanned')
  t.is(g2.members.get(X), 'member')
  t.ok(p)
  t.is(buildGroup(world().input()).last, null)
})

test('a post that names the rejoin as seen stays visible on a slower clock', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  const leave = w.push(wX, groupLeave({ at: AT(10) }))
  w.add(X, wX3, { rejoin: leave, at: AT(100) })
  const g = buildGroup(w.input())
  t.alike(g.last, { writer: wX3, seq: 0 }, 'the rejoin node is the newest')
  t.is(g.members.get(X), 'member')
  w.push(wX2, groupPost({ text: 'depois', seen: g.last, at: AT(50) }))
  t.alike(visible(buildGroup(w.input())), [wX2 + ':1'], 'ordered after the rejoin, not between leave and rejoin')
})

test('a leave that names a rejoin as seen orders after it on a slower clock', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  const leave = w.push(wX, groupLeave({ at: AT(10) }))
  w.add(X, wX3, { rejoin: leave, at: AT(100) })
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  w.push(wX2, groupLeave({ seen: g.last, at: AT(50) }))
  t.is(buildGroup(w.input()).members.get(X), 'left', 'the second leave ends the rejoined membership')
})

test('moderation that names a rejoin as seen keeps its authority on a slower clock', (t) => {
  const w = world().add(A, wA).add(A, wB).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }, { writer: wB, seq: 0 }], at: AT(1) }))
  const leave = w.push(wB, groupLeave({ at: AT(10) }))
  w.add(A, wC, { rejoin: leave, at: AT(100) })
  const g = buildGroup(w.input())
  t.is(g.members.get(A), 'member')
  w.push(wA, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], seen: g.last, at: AT(50) }))
  t.is(buildGroup(w.input()).members.get(X), 'banned', 'the ban orders after the rejoin, where A is an admin again')
  t.is(validateGroupRecord({ type: 'group-hide', target: { writer: wX, seq: 1 }, on: true, at: AT(1) }, 1), 'malformed', 'seen is required, null or a ref')
})

test('a ban on a diary with no writer here is still liftable', (t) => {
  const w = world().add(A, wA)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  const ban = w.push(wA, groupBan({ member: Y, on: true, at: AT(2) }))
  const g = buildGroup(w.input())
  t.absent(g.members.has(Y), 'Y has no writer in this group')
  t.alike(g.bans.get(Y), ban)
})

test('a promotion keeps the earlier admission of an approval group member', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  t.alike(buildGroup(w.input()).posts.map((p) => p.hidden), [false])
  w.push(G, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 2 }], at: AT(3) }))
  post(w, wX, 4)
  t.alike(buildGroup(w.input()).posts.map((p) => p.hidden), [false, false], 'the post before the promotion stays visible')
})

test('leaves names the causal latest leave whatever its clock', (t) => {
  const w = world().add(X, wX)
  const first = w.push(wX, groupLeave({ at: AT(5) }))
  w.add(X, wX3, { rejoin: first, at: AT(6) })
  t.absent(buildGroup(w.input()).leaves.has(X), 'nothing to name once rejoined')
  const second = w.push(wX3, groupLeave({ at: AT(1) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'left')
  t.alike(g.leaves.get(X), second, 'the later leave in causal order, despite its earlier clock')
})

test('writers lists the cores the fold counted', (t) => {
  const w = world().add(X, wX)
  t.alike([...buildGroup(w.input()).writers].sort(), [G, wX].sort())
  t.alike([...buildGroup(world({ bindRoot: false }).add(X, wX).input()).writers], [wX], 'an unbound root is not counted')
  const big = world()
  for (let i = 0; i < MAX_GROUP_WRITERS + 3; i++) big.add(K(0x10000 + i), K(0x20000 + i))
  const g = buildGroup(big.input())
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.absent(g.writers.has(K(0x20000 + MAX_GROUP_WRITERS + 2)), 'a writer beyond the cap is left out')
})

test('the writer cap never keeps a rejoin without its leave', (t) => {
  const w = world({ join: 'approval' })
  const wOld = K(0x900000)
  const wNew = K(0x10)
  w.add(X, wOld)
  w.push(G, groupAdmit({ member: X, on: true, at: AT(1) }))
  const leave = w.push(wOld, groupLeave({ at: AT(2) }))
  w.add(X, wNew, { rejoin: leave, at: AT(3) })
  post(w, wNew, 4)
  for (let i = 0; i < MAX_GROUP_WRITERS - 1; i++) w.add(K(0x10000 + i), K(0x20000 + i))
  const g = buildGroup(w.input())
  t.absent(g.posts.some((p) => p.writer === wNew), 'the rejoined writer is left out with its leave')
  t.not(g.members.get(X), 'member', 'the old admission is not reused')
  t.is(g.incomplete, true)
})

test('over 512 writers keeps the 512 lowest keys', (t) => {
  const w = world()
  const n = MAX_GROUP_WRITERS + 88
  for (let i = 0; i < n; i++) {
    const d = K(0x10000 + i)
    const key = K(0x20000 + ((i * 7919) % n))
    w.add(d, key)
    post(w, key, i)
  }
  const g = buildGroup(w.input())
  const writers = new Set(g.posts.map((p) => p.writer))
  t.is(writers.size + 1, MAX_GROUP_WRITERS, 'the root and 511 others')
  t.ok([...writers].every((k) => k < K(0x20000 + MAX_GROUP_WRITERS - 1)))
  t.is(g.incomplete, true, 'a writer dropped by the cap leaves the group incomplete')
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse()
  t.alike(normalize(buildGroup(shuffled)), normalize(g))
})

test('the creator cannot be banned or demoted', (t) => {
  const w = world().add(A, wA).add(C, wC)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: C, on: false, at: AT(2) }))
  post(w, G, 3)
  w.push(wA, groupBan({ member: C, on: true, at: AT(4) }))
  w.push(wA, groupAdmit({ member: C, on: false, at: AT(4) }))
  post(w, wC, 5)
  const g = buildGroup(w.input())
  t.ok(g.admins.has(C))
  t.is(g.members.get(C), 'member')
  t.alike(g.posts.map((p) => p.hidden), [false, false])
})

test('a missing writer sets incomplete and never blocks the rest', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const p = post(w, wX, 1)
  post(w, wY, 2, { replyTo: p, seen: p })
  const g = buildGroup(w.input({ drop: [wX] }))
  t.is(g.incomplete, true)
  t.alike(refs(g), [wY + ':1'])
  const unbound = world({ bindRoot: false }).add(X, wX)
  post(unbound, G, 1)
  post(unbound, wX, 2)
  const u = buildGroup(unbound.input())
  t.is(u.incomplete, true, 'the root is not bound by the creator diary')
  t.alike(refs(u), [wX + ':1'])
  const forged = world().add(X, wX)
  forged.logs.get(wX).diary = Y
  t.alike(buildGroup(forged.input()).members.has(X), false, 'the writer header must name the diary')
})

test('a backward clock keeps a writer in its own seq order', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 100)
  post(w, wX, 50)
  post(w, wX, 10)
  post(w, wY, 60)
  const g = buildGroup(w.input())
  t.alike(refs(g), [wY + ':1', wX + ':1', wX + ':2', wX + ':3'])
})

test('a reply never sorts before its parent', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const parent = post(w, wX, 100)
  post(w, wY, 5, { replyTo: parent })
  t.alike(refs(buildGroup(w.input())), [wX + ':1', wY + ':1'])
})

test('a forged seen cycle resolves deterministically', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 10, { seen: { writer: wY, seq: 1 } })
  post(w, wY, 5, { seen: { writer: wX, seq: 1 } })
  post(w, wY, 6, { seen: { writer: wY, seq: 9 } })
  const g = buildGroup(w.input())
  t.alike(refs(g), [wY + ':1', wY + ':2', wX + ':1'], 'the smallest head is released, then the order resumes')
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse()
  t.alike(refs(buildGroup(shuffled)), refs(g))
})

test('two admins cannot ban each other', (t) => {
  const w = world().add(A, wA).add(B, wB)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wA, 2)
  post(w, wB, 2)
  w.push(wA, groupBan({ member: B, on: true, at: AT(3) }))
  w.push(wB, groupBan({ member: A, on: true, at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(A), 'member')
  t.is(g.members.get(B), 'member')
  t.alike(g.posts.map((p) => p.hidden), [false, false])
})

test('admin shielding never depends on the clock', (t) => {
  const run = (banAt) => {
    const w = world().add(A, wA).add(B, wB)
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(10) }))
    w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(11) }))
    post(w, wB, 30)
    w.push(wA, groupBan({ member: B, on: true, at: AT(banAt) }))
    return buildGroup(w.input())
  }
  for (const at of [0, 20]) {
    const g = run(at)
    t.is(g.members.get(B), 'member', 'ban void with at ' + at)
    t.alike(g.posts.map((p) => p.hidden), [false])
  }
  t.alike(normalize(run(0)), normalize(run(20)))
})

test('a demoted admin can then be banned', (t) => {
  const w = world().add(A, wA).add(B, wB)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wB, 2)
  w.push(wA, groupBan({ member: B, on: true, at: AT(3) }))
  t.is(buildGroup(w.input()).members.get(B), 'member', 'shielded while an admin')
  w.push(G, groupAdmin({ member: B, on: false, at: AT(4) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(B), 'banned', 'the same ban counts once B is demoted')
  t.alike(g.posts.map((p) => p.hidden), [true])
  t.absent(g.admins.has(B))
})

test('an unbound root carries no authority', (t) => {
  const w = world({ bindRoot: false }).add(A, wA).add(X, wX)
  const p = post(w, wX, 1)
  w.push(G, groupMeta({ name: 'Falso', join: 'approval', at: AT(2) }))
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(2) }))
  w.push(G, groupBan({ member: X, on: true, at: AT(3) }))
  w.push(G, groupHide({ target: p, on: true, at: AT(3) }))
  w.push(wA, groupHide({ target: p, on: true, at: AT(4) }))
  post(w, G, 5)
  const g = buildGroup(w.input())
  t.is(g.incomplete, true)
  t.is(g.name, 'Varanda', 'meta ignored, header still read')
  t.is(g.join, 'open')
  t.is(g.creator, C)
  t.alike([...g.admins], [], 'no admin appointed, and a creator with no counted core is no admin either')
  t.absent(g.members.has(C), 'nor a member: a node must not accept charter writes the fold ignores')
  t.is(g.members.get(X), 'member', 'ban ignored')
  t.alike(g.posts.map((q) => [q.writer + ':' + q.seq, q.hidden]), [[wX + ':1', false]], 'no root posts, no hide')
})

test('a ban by a later-cut admin is void and an unban lifting it is ignored', (t) => {
  const w = world().add(A, wA).add(B, wB).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wX, 2)
  w.push(wB, groupBan({ member: X, on: true, at: AT(3) }))
  post(w, wA, 4)
  const voidBan = w.push(wA, groupBan({ member: X, on: true, at: AT(5) }))
  w.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 2 }], at: AT(6) }))
  w.push(wB, groupBan({ member: X, on: false, lifts: voidBan, at: AT(7) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned', 'B ban stands')
  const solo = world().add(A, wA).add(B, wB).add(X, wX)
  solo.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  solo.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(solo, wA, 2)
  const v = solo.push(wA, groupBan({ member: X, on: true, at: AT(3) }))
  solo.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 2 }], at: AT(4) }))
  solo.push(wB, groupBan({ member: X, on: false, lifts: v, at: AT(5) }))
  t.is(buildGroup(solo.input()).members.get(X), 'member', 'the void ban never counted')
})

test('an admin who bans then leaves keeps the ban effective', (t) => {
  const w = world().add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  post(w, wX, 2)
  w.push(wA, groupBan({ member: X, on: true, at: AT(3) }))
  w.push(wA, groupLeave({ at: AT(4) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.is(g.members.get(A), 'left')
  t.alike(g.posts.map((p) => p.hidden), [true])
})

test('one diary binding many low-key writers keeps only its 8 earliest joins', (t) => {
  const w = world().add(A, wA).add(Y, wY)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  // Joined from the highest key down, so join order is not key order.
  const flood = Array.from({ length: MAX_GROUP_WRITERS + 50 }, (_, i) => K(0x100000 + MAX_GROUP_WRITERS + 50 - i))
  for (const k of flood) w.add(X, k)
  const p = post(w, wY, 2)
  w.push(wA, groupHide({ target: p, on: true, at: AT(3) }))
  const g = buildGroup(w.input())
  const xs = [...g.writers].filter((k) => flood.includes(k))
  t.alike(xs.sort(), flood.slice(0, MAX_GROUP_WRITERS_PER_DIARY).sort(), 'the 8 earliest joins of X, not its lowest keys')
  t.ok(g.writers.has(wA) && g.writers.has(wY), 'other diaries keep their writers')
  t.alike(g.posts.map((q) => q.hidden), [true], 'the admin hide still counts')
  t.is(g.incomplete, false, 'the group cap was never reached')
  const c = world()
  for (let i = 0; i < 10; i++) c.add(C, K(0x700 + i))
  const gc = buildGroup(c.input())
  t.is(gc.writers.size, MAX_GROUP_WRITERS_PER_DIARY, 'the bound root is one of the creator 8')
  t.ok(gc.writers.has(G))
})

test('over the group cap the creator and admins go first and banned diaries last', (t) => {
  const w = world()
  const wCreator = K(0xf00001)
  const wAdmin = K(0xf00002)
  const wBanned = K(0x10)
  const Z = K(0x99)
  w.add(C, wCreator).add(A, wAdmin).add(Z, wBanned)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wAdmin, seq: 0 }], at: AT(1) }))
  w.push(G, groupBan({ member: Z, on: true, at: AT(1) }))
  for (let i = 0; i < MAX_GROUP_WRITERS - 3; i++) w.add(K(0x10000 + i), K(0x20000 + i))
  const g = buildGroup(w.input())
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.ok(g.writers.has(wCreator) && g.writers.has(wAdmin), 'the creator and admin writers are kept despite high keys')
  t.absent(g.writers.has(wBanned), 'the banned diary gives up its slot despite the lowest key')
  t.ok(g.writers.has(K(0x20000 + MAX_GROUP_WRITERS - 4)), 'the highest ordinary writer keeps its slot')
  t.is(g.incomplete, true)
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse()
  t.alike(normalize(buildGroup(shuffled)), normalize(g))
})

test('an unbound root gives the header diary no creator powers', (t) => {
  const w = world({ bindRoot: false, join: 'approval' }).add(C, wC).add(X, wX)
  const p = post(w, wX, 1)
  w.push(wC, groupBan({ member: X, on: true, at: AT(2) }))
  w.push(wC, groupHide({ target: p, on: true, at: AT(2) }))
  w.push(wC, groupAdmit({ member: X, on: true, at: AT(2) }))
  post(w, wC, 3)
  const g = buildGroup(w.input())
  t.is(g.creator, C, 'the header stays readable')
  t.alike([...g.admins], [])
  t.is(g.members.get(X), 'requested', 'no ban and no admit from the header diary')
  t.is(g.members.get(C), 'requested', 'an ordinary diary, never auto-admitted')
  t.alike(g.posts.map((q) => q.hidden), [true, true])
  const open = world({ bindRoot: false }).add(C, wC).add(X, wX)
  open.push(wC, groupBan({ member: X, on: true, at: AT(1) }))
  open.push(wX, groupBan({ member: C, on: true, at: AT(2) }))
  const go = buildGroup(open.input())
  t.is(go.members.get(X), 'member', 'its ban counts for nothing')
  t.is(go.members.get(C), 'member', 'an ordinary member, banned by no one with authority')
})

test('a record backdated before a leave on another writer is withdrawn', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  const kept = post(w, wX2, 1)
  w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(10) }))
  post(w, wX2, 5)
  const g = buildGroup(w.input())
  t.alike(g.posts.map((q) => [q.writer + ':' + q.seq, q.hidden]), [[kept.writer + ':1', true], [wX2 + ':2', true]], 'another writer is withdrawn whatever its cut and its clock')
  t.is(g.members.get(X), 'left')
  const u = world().add(X, wX).add(X, wX2)
  post(u, wX2, 1)
  u.push(wX, groupLeave({ cuts: [{ writer: wX, seq: u.len(wX) }], at: AT(10) }))
  t.alike(buildGroup(u.input()).posts.map((q) => q.hidden), [true], 'a writer the leave omits is withdrawn from seq 0')
  const a = world({ join: 'approval' }).add(X, wX).add(X, wX2)
  a.push(G, groupAdmit({ member: X, on: true, at: AT(1) }))
  const leave = a.push(wX, groupLeave({ cuts: [{ writer: wX, seq: a.len(wX) }, { writer: wX2, seq: a.len(wX2) }], at: AT(10) }))
  a.add(X, wX3, { rejoin: leave, at: AT(20) })
  post(a, wX2, 5)
  t.alike(buildGroup(a.input()).posts.map((q) => q.hidden), [true], 'no re-admission skipped by backdating')
})

test('moderation backdated before its author leave carries no authority', (t) => {
  const wA2 = K(0x201)
  const w = world().add(A, wA).add(A, wA2).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }, { writer: wA2, seq: 0 }], at: AT(1) }))
  const p = post(w, wX, 2)
  w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }, { writer: wA2, seq: w.len(wA2) }], at: AT(10) }))
  w.push(wA2, groupBan({ member: X, on: true, at: AT(5) }))
  w.push(wA2, groupHide({ target: p, on: true, at: AT(5) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  t.alike(g.posts.map((q) => q.hidden), [false])
  t.is(g.members.get(A), 'left')
})

test('an admin grant gives nothing to a writer its cuts omit', (t) => {
  const wA2 = K(0x201)
  const w = world().add(A, wA).add(A, wA2).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  const p1 = post(w, wX, 2)
  const p2 = post(w, wX, 3)
  w.push(wA2, groupHide({ target: p1, on: true, at: AT(4) }))
  w.push(wA, groupHide({ target: p2, on: true, at: AT(4) }))
  const g = buildGroup(w.input())
  t.ok(g.admins.has(A))
  t.alike(g.posts.map((q) => q.hidden), [false, true], 'only the listed writer moderates')
  const e = world().add(A, wA).add(X, wX)
  const q = post(e, wX, 1)
  e.push(wA, groupHide({ target: q, on: true, at: AT(2) }))
  e.push(G, groupAdmin({ member: A, on: true, cuts: [], at: AT(3) }))
  t.alike(buildGroup(e.input()).posts.map((r) => r.hidden), [false], 'a grant with no cuts never covers records written before it')
})

test('admits count per generation across several leaves', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, at: AT(1) }))
  post(w, wX, 2)
  const l1 = w.push(wX, groupLeave({ at: AT(3) }))
  w.add(X, wX2, { rejoin: l1, at: AT(4) })
  post(w, wX2, 5)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX2, seq: 2 }], at: AT(6) }))
  post(w, wX2, 7)
  // Every leave lists all the diary's writers, the one retired by l1 too.
  const l2 = w.push(wX2, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(8) }))
  w.add(X, wX3, { rejoin: l2, at: AT(9) })
  post(w, wX3, 10)
  const g = buildGroup(w.input())
  // l2 withdraws wX from seq 0 too: wX is another writer for it.
  t.alike(g.posts.map((q) => q.hidden), [true, true, false, true])
  t.is(g.members.get(X), 'requested')
})

test('a leave backdated under an admit it never observed needs a new admit after the rejoin', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(10) }))
  // No reference to the admit and an earlier `at`: it sorts before the admit.
  const leave = w.push(wX, groupLeave({ seen: null, cuts: [], at: AT(5) }))
  w.add(X, wX3, { rejoin: leave, at: AT(20) })
  post(w, wX3, 21)
  const before = buildGroup(w.input())
  t.alike(before.posts.map((p) => p.hidden), [true], 'the old admit does not cover the new generation')
  t.is(before.members.get(X), 'requested')
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX3, seq: 1 }], at: AT(30) }))
  const after = buildGroup(w.input())
  t.alike(after.posts.map((p) => p.hidden), [false], 'an admit that observed the leave admits it')
  t.is(after.members.get(X), 'member')
})

test('a covered leave that sorts after the admit does not advance its generation', (t) => {
  // The admit cuts past the records held here, so its cut is no ordering
  // edge, and the leave's far `at` puts it after the admit.
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 3 }], at: AT(10) }))
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: 1 }], at: AT(200000) }))
  w.add(X, wX3, { rejoin: leave, at: AT(20) })
  post(w, wX3, 21)
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => p.hidden), [true], 'the admit does not cover the generation after the leave')
  t.is(g.members.get(X), 'requested')

  // A leave whose `seen` names the admit that covers it: a forged cycle.
  const c = world({ join: 'approval' }).add(X, wX)
  const l = c.push(wX, groupLeave({ seen: { writer: G, seq: 1 }, cuts: [{ writer: wX, seq: 1 }], at: AT(200000) }))
  c.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: c.len(wX) }], at: AT(10) }))
  c.add(X, wX3, { rejoin: l, at: AT(20) })
  post(c, wX3, 21)
  const gc = buildGroup(c.input())
  t.alike(gc.posts.map((p) => p.hidden), [true], 'nor through a forged cycle')
  t.is(gc.members.get(X), 'requested')
})

test('an admit at the observed lengths after a leave and rejoin admits the new generation', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(1) }))
  post(w, wX, 2)
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(3) }))
  w.add(X, wX3, { rejoin: leave, at: AT(4) })
  post(w, wX3, 5)
  // Only the old writer's cut observes the leave: the rejoin is cut at 0.
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX3, seq: 0 }], at: AT(6) }))
  post(w, wX3, 7)
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [
    [wX + ':1', false],
    [wX3 + ':1', false],
    [wX3 + ':2', false]
  ])
  t.is(g.members.get(X), 'member')
})

const MAX_CUTS_IN_TEST = 16

// mulberry32: a small seeded PRNG, so every run checks the same histories.
function mulberry32 (seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const DIARY_WRITERS = [[C, [G, wC]], [A, [wA]], [B, [wB]], [X, [wX, wX2]], [Y, [wY]]]

// A random causal history: every reference points to a record that already
// exists, so any prefix of the steps is closed under references.
function history (rnd, steps, { approval = false, rejoinRate = 0.08 } = {}) {
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const join = rnd() < 0.5 && !approval ? 'open' : 'approval'
  const diaryWriters = new Map(DIARY_WRITERS.map(([d, ws]) => [d, ws.slice()]))
  const writerDiary = new Map(DIARY_WRITERS.flatMap(([d, ws]) => ws.map((k) => [k, d])))
  const skew = new Map([...writerDiary.keys()].map((k) => [k, Math.floor((rnd() - 0.5) * 7200)]))
  const lens = new Map([...writerDiary.keys()].map((k) => [k, 1]))
  const all = []
  const postsMade = []
  const bansMade = []
  const leavesMade = []
  const out = []
  let fresh = 0
  const cutsFor = (d) => {
    const ws = diaryWriters.get(d).slice(0, MAX_CUTS_IN_TEST)
    return ws.filter(() => rnd() < 0.6).map((writer) => ({ writer, seq: Math.floor(rnd() * (lens.get(writer) + 1)) }))
  }
  for (let i = 0; i < steps; i++) {
    // A rejoin: a fresh writer whose header names a leave, usually one of
    // its own diary (a leave of another diary makes the writer invalid).
    if (leavesMade.length && rnd() < rejoinRate) {
      const leave = pick(leavesMade)
      const diary = rnd() < 0.85 ? writerDiary.get(leave.writer) : pick([A, B, X, Y])
      const key = K(0x600 + fresh++)
      diaryWriters.get(diary).push(key)
      writerDiary.set(key, diary)
      skew.set(key, Math.floor((rnd() - 0.5) * 7200))
      lens.set(key, 1)
      out.push({ writer: key, add: { diary, rejoin: leave, at: AT(i * 60 + skew.get(key)) } })
      continue
    }
    let writer = pick([...writerDiary.keys()])
    const at = AT(i * 60 + skew.get(writer) + Math.floor((rnd() - 0.5) * 600))
    const roll = rnd()
    let record
    if (writer === G && roll < 0.25) {
      record = groupAdmin({ member: pick([A, B, X, C]), on: rnd() < 0.7, cuts: [], at })
      record.cuts = cutsFor(record.member)
    } else if (roll < 0.45) {
      record = groupPost({ text: 't' + i, replyTo: postsMade.length && rnd() < 0.4 ? pick(postsMade) : null, seen: all.length && rnd() < 0.7 ? pick(all) : null, at })
    } else if (roll < 0.55 && postsMade.length) {
      record = groupHide({ target: pick(postsMade), on: rnd() < 0.7, at })
    } else if (roll < 0.75) {
      const member = pick([A, B, X, Y, C])
      const on = rnd() < 0.6
      if (on || !bansMade.length) record = groupBan({ member, on: true, cuts: cutsFor(member), at })
      else record = groupBan({ member, on: false, cuts: cutsFor(member), lifts: pick(bansMade), at })
    } else if (roll < 0.9) {
      const member = pick([A, B, X, Y])
      // Half observe every writer of the member at its length (leaves
      // included), half take random cuts that may miss a leave.
      const cuts = rnd() < 0.5
        ? diaryWriters.get(member).slice(0, MAX_CUTS_IN_TEST).map((writer) => ({ writer, seq: lens.get(writer) }))
        : cutsFor(member)
      record = groupAdmit({ member, on: rnd() < 0.8, cuts, at })
      // Mostly from the root, so that admits carry authority.
      if (rnd() < 0.6) writer = G
    } else if (roll < 0.95) {
      record = groupLeave({ cuts: cutsFor(writerDiary.get(writer)).slice(0, MAX_GROUP_WRITERS_PER_DIARY), at })
    } else {
      record = groupPost({ text: 'u' + i, replyTo: null, seen: null, at })
    }
    const seq = lens.get(writer)
    lens.set(writer, seq + 1)
    const ref = { writer, seq }
    all.push(ref)
    if (record.type === 'group-post') postsMade.push(ref)
    if (record.type === 'group-ban' && record.on) bansMade.push(ref)
    if (record.type === 'group-leave') leavesMade.push(ref)
    out.push({ writer, seq, record })
  }
  return { join, steps: out }
}

function inputOf (h, n, rnd) {
  const w = world({ join: h.join })
  for (const [d, ws] of DIARY_WRITERS) for (const k of ws) if (k !== G) w.add(d, k)
  for (const s of h.steps.slice(0, n)) {
    if (s.add) w.add(s.add.diary, s.writer, s.add)
    else w.push(s.writer, s.record)
  }
  const input = w.input()
  if (!rnd) return input
  const shuffle = (a) => {
    a = a.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  return {
    ...input,
    root: { ...input.root, entries: shuffle(input.root.entries) },
    writers: shuffle(input.writers).map((l) => ({ ...l, entries: shuffle(l.entries) })),
    joins: new Map(shuffle([...input.joins]).map(([d, list]) => [d, shuffle(list)]))
  }
}

// A visible post of a rejoining writer in an approval group needs an admit
// of its diary whose cuts observe some leave of that diary (a cut above the
// leave's seq, or past the block 0 of a rejoining writer): an admit that
// observed none belongs to an earlier generation. Diaries ever granted admin
// (and the creator) are skipped, their authority bypasses admission.
function unadmittedRejoinPosts (h, g) {
  if (h.join !== 'approval') return 0
  const diaryOf = new Map(DIARY_WRITERS.flatMap(([d, ws]) => ws.map((k) => [k, d])))
  const rejoiners = new Set()
  for (const s of h.steps) {
    if (s.add) {
      diaryOf.set(s.writer, s.add.diary)
      rejoiners.add(s.writer)
    }
  }
  const granted = new Set([C])
  const leaves = []
  const admits = []
  for (const s of h.steps) {
    if (s.add) continue
    const r = s.record
    if (r.type === 'group-admin' && r.on) granted.add(r.member)
    if (r.type === 'group-leave') leaves.push({ diary: diaryOf.get(s.writer), writer: s.writer, seq: s.seq })
    if (r.type === 'group-admit' && r.on) admits.push(r)
  }
  const observes = (a) => a.cuts.some((c) => (rejoiners.has(c.writer) && diaryOf.get(c.writer) === a.member && c.seq >= 1) ||
    leaves.some((l) => l.diary === a.member && l.writer === c.writer && l.seq < c.seq))
  let bad = 0
  for (const p of g.posts) {
    if (p.hidden || !rejoiners.has(p.writer) || granted.has(p.diary)) continue
    if (!admits.some((a) => a.member === p.diary && observes(a))) bad++
  }
  return bad
}

function isSubsequence (small, big) {
  let i = 0
  for (const x of big) if (i < small.length && x === small[i]) i++
  return i === small.length
}

test('property: same output for every delivery order, stable when appending', (t) => {
  const rnd = mulberry32(0x5eed)
  let orders = 0
  let mismatches = 0
  let unstable = 0
  let banned = 0
  let hidden = 0
  let rejoined = 0
  let unadmitted = 0
  let readmitted = 0
  for (let scenario = 0; scenario < 120; scenario++) {
    const h = history(rnd, 20 + Math.floor(rnd() * 40))
    const built = buildGroup(inputOf(h, h.steps.length))
    unadmitted += unadmittedRejoinPosts(h, built)
    if (h.join === 'approval' && built.posts.some((p) => !p.hidden && p.writer >= K(0x600) && p.diary !== C)) readmitted++
    const expected = normalize(built)
    if ([...expected.members.values()].some(([, s]) => s === 'banned')) banned++
    if (expected.posts.some((p) => p.hidden)) hidden++
    if (h.steps.some((s) => s.add)) rejoined++
    for (let k = 0; k < 5; k++) {
      orders++
      const got = normalize(buildGroup(inputOf(h, h.steps.length, rnd)))
      if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches++
    }
    const cut = Math.floor(rnd() * h.steps.length)
    const prefix = normalize(buildGroup(inputOf(h, cut, rnd)))
    if (JSON.stringify(prefix) !== JSON.stringify(normalize(buildGroup(inputOf(h, cut))))) mismatches++
    if (!isSubsequence(refs(prefix), refs(expected))) unstable++
  }
  // Approval groups with frequent leaves and rejoins: admits whose cuts do or
  // do not observe a leave, under skewed clocks.
  for (let scenario = 0; scenario < 80; scenario++) {
    const h = history(rnd, 30 + Math.floor(rnd() * 40), { approval: true, rejoinRate: 0.2 })
    const built = buildGroup(inputOf(h, h.steps.length))
    unadmitted += unadmittedRejoinPosts(h, built)
    if (built.posts.some((p) => !p.hidden && p.writer >= K(0x600) && p.diary !== C)) readmitted++
    const expected = normalize(built)
    for (let k = 0; k < 3; k++) {
      orders++
      const got = normalize(buildGroup(inputOf(h, h.steps.length, rnd)))
      if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches++
    }
  }
  t.ok(orders >= 500, orders + ' delivery orders')
  t.is(mismatches, 0, 'identical output for every order')
  t.is(unstable, 0, 'appending never reorders earlier records')
  t.ok(banned > 0 && hidden > 0 && rejoined > 0, 'the histories exercise bans, hides and rejoins')
  t.is(unadmitted, 0, 'no admit of an earlier generation shows a rejoining writer post')
  t.ok(readmitted > 0, readmitted + ' approval histories show a post after a rejoin')
})
