'use strict'

// Standalone groups (docs/protocol.md, section 10): a v2 group root that
// names no community (community and member both null) and writers that name
// the group itself as `member`. The fold gives such a group its own
// authority model, the one protocol v1 gave every group: these cases port
// v1's group.test.js as the oracle, plus the rules that keep a standalone
// group apart from any community.
const test = require('brittle')
const {
  validateGroupHeader, isStandaloneHeader,
  groupHeader, writerHeader, groupPost, groupHide, groupAdmit, groupBan, groupMeta, groupAdmin, groupLeave,
  communityBan, communityHide, communityAdmit, buildGroup, MAX_GROUP_WRITERS
} = require('../lib/group')
const { K, AT, NOW, community, groupIn } = require('./helpers/groups')

const G = K(0x100)
const C = K(1)
const A = K(2)
const B = K(3)
const X = K(4)
const Y = K(5)
const wC = K(0x101)
const wA = K(0x200)
const wA2 = K(0x201)
const wB = K(0x300)
const wX = K(0x400)
const wX2 = K(0x401)
const wX3 = K(0x402)
const wY = K(0x500)
const CM = K(0xc0)

// A standalone group under construction: the root (C's), writers naming G
// as their member, the diaries' joins and group-cut marks. Joins and marks
// of one diary share its seq order, as in a real diary.
function world ({ join = 'open', bindRoot = true, name = 'Varanda' } = {}) {
  const header = groupHeader({ diary: C, join, name, at: AT(0) })
  const logs = new Map([[G, { key: G, diary: C, entries: [{ seq: 0, record: header }] }]])
  const joins = new Map()
  const marks = new Map()
  const next = (diary) => {
    let seq = 0
    for (const list of [joins.get(diary) || [], marks.get(diary) || []]) {
      for (const e of list) if (e.seq > seq) seq = e.seq
    }
    return seq + 1
  }
  if (bindRoot) joins.set(C, [{ writer: G, on: true, seq: 1 }])
  const w = {
    logs,
    joins,
    marks,
    add (diary, key, { rejoin = null, at = AT(0), member = G } = {}) {
      logs.set(key, { key, diary, entries: [{ seq: 0, record: writerHeader({ group: G, diary, member, rejoin, at }) }] })
      const list = joins.get(diary) || []
      list.push({ writer: key, on: true, seq: next(diary) })
      joins.set(diary, list)
      return w
    },
    mark (diary, writer, cut, seq) {
      const list = marks.get(diary) || []
      list.push({ writer, cut, seq: seq === undefined ? next(diary) : seq })
      marks.set(diary, list)
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
    input ({ drop = [], ...extra } = {}) {
      const writers = [...logs.values()].filter((l) => l.key !== G && !drop.includes(l.key))
      return { root: logs.get(G), writers, joins, marks, now: NOW, ...extra }
    }
  }
  return w
}

const post = (w, key, s, extra = {}) => w.push(key, groupPost({ text: 'p' + s, at: AT(s), ...extra }))
const visible = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.writer + ':' + p.seq)
const refs = (g) => g.posts.map((p) => p.writer + ':' + p.seq)
const hidden = (g) => g.posts.map((p) => p.hidden)

function normalize (g) {
  return JSON.stringify(g, (k, v) => v instanceof Set ? [...v].sort() : v instanceof Map ? [...v].sort((a, b) => a[0] < b[0] ? -1 : 1) : v)
}

test('isStandaloneHeader is true only for a valid group root naming neither community nor member', (t) => {
  const h = groupHeader({ diary: C, name: 'Varanda', at: AT(0) })
  t.is(h.community, null)
  t.is(h.member, null)
  t.is(validateGroupHeader(h), null)
  t.ok(isStandaloneHeader(h))
  t.ok(isStandaloneHeader(groupHeader({ diary: C, visibility: 'private', join: 'approval', box: K(0x77), at: AT(0) })), 'private too')
  t.absent(isStandaloneHeader({ ...h, community: CM, member: K(0x20) }), 'a community group')
  t.absent(isStandaloneHeader({ ...h, community: CM }), 'a mix is malformed')
  t.absent(isStandaloneHeader({ ...h, member: K(0x20) }), 'a mix is malformed')
  t.is(validateGroupHeader({ ...h, community: CM }), 'malformed')
  t.is(validateGroupHeader({ ...h, member: K(0x20) }), 'malformed')
  t.absent(isStandaloneHeader({ ...h, kind: 'community', name: 'Bairro' }), 'a community root is never a standalone group')
  t.absent(isStandaloneHeader({ ...h, v: 1 }), 'legacy')
  t.absent(isStandaloneHeader({ ...h, at: 'x' }), 'an invalid root')
  t.absent(isStandaloneHeader(null))
  t.absent(isStandaloneHeader(undefined))
  const hostile = { ...h }
  Object.defineProperty(hostile, 'community', { enumerable: true, get () { throw new Error('boom') } })
  t.absent(isStandaloneHeader(hostile), 'never throws')
})

test('a basic standalone group and shuffled writer input', (t) => {
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
  t.is(g.community, null)
  t.is(g.orphan, false)
  t.alike(refs(g), [G + ':1', wX + ':1', wY + ':1', wA + ':1'])
  t.alike([...g.members], [[C, 'member'], [A, 'member'], [X, 'member'], [Y, 'member']], 'every diary with a writer is a member: no community gate makes it left')
  t.alike([...g.admins], [C])
  t.alike([...g.liveWriters].sort(), [G, wA, wX, wY].sort(), 'every counted writer is live without a gate')
  t.ok(g.authorityWriters.has(G))
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse().map((l) => ({ ...l, entries: l.entries.slice().reverse() }))
  t.is(normalize(buildGroup(shuffled)), normalize(g))
})

test('a writer naming member null or a foreign key is header-invalid, never awaited', (t) => {
  const w = world().add(X, wX).add(Y, wY, { member: K(0x50) }).add(A, wA, { member: CM })
  post(w, wX, 1)
  post(w, wY, 2)
  post(w, wA, 3)
  // A community writer header (member null) bound by B's diary.
  w.logs.set(wB, { key: wB, diary: B, entries: [{ seq: 0, record: writerHeader({ group: G, diary: B, at: AT(0) }) }, { seq: 1, record: groupPost({ text: 'b', at: AT(4) }) }] })
  w.joins.set(B, [{ writer: wB, on: true, seq: 1 }])
  const g = buildGroup(w.input())
  t.alike(refs(g), [wX + ':1'])
  t.ok(g.writers.has(wX))
  t.absent(g.writers.has(wY), 'a foreign member key')
  t.absent(g.writers.has(wA), 'a community key')
  t.absent(g.writers.has(wB), 'member null')
  t.absent(g.members.has(Y) || g.members.has(A) || g.members.has(B))
  t.is(g.incomplete, false, 'rejected, not awaited')
  t.absent(g.liveWriters.has(wY) || g.liveWriters.has(wA) || g.liveWriters.has(wB))
})

test('a supplied community input changes nothing, even one whose catalogue names the standalone root', (t) => {
  const w = world({ join: 'approval' }).add(A, wA).add(X, wX).add(Y, wY)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  const p = post(w, wX, 3)
  post(w, wY, 4)
  const base = buildGroup(w.input())
  // C creates a community whose catalogue lists G, with B as admin, and
  // B's CW bans X, hides X's post and admits Y "in G".
  const parent = community({ key: CM, creator: C, members: [{ diary: B, cw: K(0x30), status: 'member' }, { diary: Y, cw: K(0x50), status: 'member' }], admins: [B], creates: [{ by: C, group: G }] })
  parent.push(K(0x30), communityBan({ group: G, member: X, on: true, at: parent.at() }))
  parent.push(K(0x30), communityHide({ group: G, target: p, on: true, at: parent.at() }))
  parent.push(K(0x30), communityAdmit({ group: G, member: Y, on: true, at: parent.at() }))
  const g = buildGroup(w.input({ community: parent.input() }))
  t.is(normalize(g), normalize(base), 'the community input is ignored')
  t.is(g.community, null, 'never attached')
  t.is(g.orphan, false)
  t.is(g.incomplete, false)
  t.is(g.members.get(X), 'member', 'no community ban')
  t.is(g.members.get(Y), 'requested', 'no community admit')
  t.absent(g.admins.has(B), 'no community admin')
  t.alike(visible(g), [wX + ':1'])
  t.is(normalize(buildGroup(w.input({ community: { root: { key: CM, entries: [] } } }))), normalize(base), 'a missing community input never makes it incomplete')
  t.is(normalize(buildGroup(w.input({ community: 'junk' }))), normalize(base))
})

test('a community group whose parent is missing is still incomplete, and a writer naming G there is invalid', (t) => {
  const parent = community({ key: CM, creator: C, creates: [{ by: C, group: G }] })
  const g = groupIn(parent, { key: G, diary: C })
  g.add(X, wX, { cw: K(0x40) })
  parent.addWriter(X, K(0x40))
  post(g, wX, 1)
  const whole = buildGroup(g.input())
  t.is(whole.incomplete, false)
  t.ok(whole.community !== null)
  const missing = buildGroup(g.input({ community: null }))
  t.is(missing.incomplete, true, 'a missing parent never counts as standalone')
  t.is(missing.community, null)
  t.is(missing.orphan, false)
  const empty = buildGroup(g.input({ community: { root: { key: CM, entries: [] } } }))
  t.is(empty.incomplete, true)
  // A writer naming G as member inside a community group meets the gate.
  g.add(Y, wY, { cw: G })
  post(g, wY, 2)
  const gated = buildGroup(g.input())
  t.absent(gated.writers.has(wY))
  t.alike(refs(gated), [wX + ':1'])
  t.is(gated.incomplete, false, 'rejected, not awaited')
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

test('an unban leaves a writer it does not list banned', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX, 1)
  const ban = w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(2) }))
  post(w, wX, 3)
  post(w, wX2, 4)
  w.push(G, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], lifts: ban, at: AT(5) }))
  post(w, wX, 6)
  post(w, wX2, 7)
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1', wX + ':3'])
  t.alike(g.bans.get(X), ban)
  t.absent(g.liveWriters.has(wX2), 'the banned writer is not live')
  t.ok(g.liveWriters.has(wX))
})

test('a ban covers unlisted writers from seq 0 and the banned diary is not live', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX, 1)
  post(w, wX2, 2)
  w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(3) }))
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1'])
  t.is(g.members.get(X), 'banned')
  t.absent(g.liveWriters.has(wX) || g.liveWriters.has(wX2))
})

test('admin layers: a grant covers listed writers and the other devices of its generation, a demotion with a cut ends it', (t) => {
  const w = world().add(A, wA).add(A, wA2).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  const p1 = post(w, wX, 2)
  const p2 = post(w, wX, 3)
  const p3 = post(w, wX, 4)
  w.push(wA2, groupHide({ target: p1, on: true, at: AT(5) }))
  w.push(wA, groupHide({ target: p2, on: true, at: AT(5) }))
  let g = buildGroup(w.input())
  t.ok(g.admins.has(A), 'admin now on a bound writer the grant covers')
  t.ok(g.authorityWriters.has(wA))
  t.ok(g.authorityWriters.has(wA2), 'a writer the grant omits is covered')
  t.alike(hidden(g), [true, true, false], 'the covered writer hides')
  w.push(wA, groupHide({ target: p3, on: true, at: AT(6) }))
  w.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 2 }], at: AT(3) }))
  g = buildGroup(w.input())
  t.alike(hidden(g), [false, true, false], 'actions at seq >= the demotion cut are void, and the demotion cuts the covered writer at 0')
  t.absent(g.admins.has(A))
  t.alike([...g.admins], [C])
  t.absent(g.authorityWriters.has(wA))
  t.absent(g.authorityWriters.has(wA2))
})

test('the creator cannot be banned or demoted', (t) => {
  const w = world().add(A, wA).add(C, wC)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: C, on: false, at: AT(2) }))
  post(w, G, 3)
  w.push(wA, groupBan({ member: C, on: true, at: AT(4) }))
  w.push(wA, groupAdmit({ member: C, on: false, at: AT(4) }))
  post(w, wC, 5)
  const g = buildGroup(w.input())
  t.ok(g.admins.has(C))
  t.is(g.members.get(C), 'member')
  t.alike(hidden(g), [false, false])
})

test('two admins cannot ban each other; a demoted admin can then be banned', (t) => {
  const w = world().add(A, wA).add(B, wB)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(1) }))
  post(w, wB, 2)
  w.push(wA, groupBan({ member: B, on: true, at: AT(3) }))
  w.push(wB, groupBan({ member: A, on: true, at: AT(3) }))
  let g = buildGroup(w.input())
  t.is(g.members.get(A), 'member')
  t.is(g.members.get(B), 'member')
  t.alike([...g.admins].sort(), [A, B, C].sort())
  w.push(G, groupAdmin({ member: B, on: false, at: AT(4) }))
  g = buildGroup(w.input())
  t.is(g.members.get(B), 'banned', 'the same ban counts once B is demoted')
  t.alike(hidden(g), [true])
  t.absent(g.admins.has(B))
})

test('an approval group: admit cut, a new device of an admitted diary, an admit withdrawal', (t) => {
  const w = world({ join: 'approval' }).add(X, wX).add(Y, wY)
  post(w, wX, 1)
  post(w, wX, 2)
  post(w, wY, 3)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 2 }], at: AT(4) }))
  post(w, wX, 5)
  let g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':2', wX + ':3'], 'posts below the admit cut stay hidden')
  t.is(g.members.get(X), 'member')
  t.is(g.members.get(Y), 'requested')
  t.alike(g.requests, [Y])
  // Owner decision (#350): the admission covers the diary's new devices
  // while it has not left or been banned.
  w.add(X, wX2, { at: AT(6) })
  post(w, wX2, 7)
  g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':2', wX + ':3', wX2 + ':1'], 'a new device needs no new admit')
  t.alike(g.requests, [Y])
  w.push(G, groupAdmit({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(8) }))
  g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':2', wX + ':3'], 'the unlisted writer is withdrawn from seq 0')
  t.is(g.members.get(X), 'requested')
})

test('leave withdraws every writer of the diary; a rejoin restores what follows it', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  post(w, wX, 1)
  post(w, wX2, 2)
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(3) }))
  post(w, wX, 4)
  let g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [[wX + ':1', false], [wX2 + ':1', true], [wX + ':3', true]])
  t.is(g.members.get(X), 'left')
  t.absent(g.liveWriters.has(wX) || g.liveWriters.has(wX2), 'a left diary has no live writer')
  t.alike(g.leaves.get(X), leave)
  w.add(X, wX3, { rejoin: leave, at: AT(5) })
  post(w, wX3, 6)
  g = buildGroup(w.input())
  t.is(g.members.get(X), 'member', 'an open group takes the rejoin')
  t.ok(visible(g).includes(wX3 + ':1'))
  t.ok(g.liveWriters.has(wX3))
  t.is(g.incomplete, false)
})

test('a rejoin in an approval group needs a new admit', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  const leave = w.push(wX, groupLeave({ at: AT(3) }))
  w.add(X, wX3, { rejoin: leave, at: AT(4) })
  post(w, wX3, 5)
  const before = buildGroup(w.input())
  t.alike(hidden(before), [false, true], 'the old admit does not carry over')
  t.is(before.members.get(X), 'requested')
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX3, seq: 1 }], at: AT(6) }))
  const after = buildGroup(w.input())
  t.alike(hidden(after), [false, false])
  t.is(after.members.get(X), 'member')
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
  t.alike(hidden(g), [true, true])
})

test('a rejoin naming another diary leave is ignored', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const leave = w.push(wY, groupLeave({ at: AT(1) }))
  post(w, wX, 2)
  w.add(X, wX3, { rejoin: leave, at: AT(3) })
  post(w, wX3, 4)
  const g = buildGroup(w.input())
  t.alike(refs(g), [wX + ':1'])
  t.is(g.incomplete, false)
})

test('an admin who bans then leaves keeps the ban; moderation backdated before the leave carries none', (t) => {
  const w = world().add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  w.push(wA, groupBan({ member: X, on: true, at: AT(3) }))
  w.push(wA, groupLeave({ at: AT(4) }))
  let g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.is(g.members.get(A), 'left')

  const v = world().add(A, wA).add(A, wA2).add(X, wX)
  v.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA2, seq: 1 }], at: AT(1) }))
  const p = post(v, wX, 2)
  v.push(wA, groupLeave({ cuts: [{ writer: wA, seq: v.len(wA) }, { writer: wA2, seq: v.len(wA2) }], at: AT(10) }))
  v.push(wA2, groupBan({ member: X, on: true, at: AT(5) }))
  v.push(wA2, groupHide({ target: p, on: true, at: AT(5) }))
  g = buildGroup(v.input())
  t.is(g.members.get(X), 'member')
  t.alike(hidden(g), [false])
})

test('an unbound root carries no authority and its diary no creator powers', (t) => {
  const w = world({ bindRoot: false }).add(A, wA).add(X, wX)
  const p = post(w, wX, 1)
  w.push(G, groupMeta({ name: 'Falso', join: 'approval', at: AT(2) }))
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(2) }))
  w.push(G, groupBan({ member: X, on: true, at: AT(3) }))
  w.push(G, groupHide({ target: p, on: true, at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.incomplete, true)
  t.is(g.name, 'Varanda')
  t.is(g.join, 'open')
  t.alike([...g.admins], [])
  t.absent(g.members.has(C))
  t.is(g.members.get(X), 'member')
  t.alike(hidden(g), [false])
  t.absent(g.liveWriters.has(G))
})

test('a missing writer sets incomplete and never blocks the rest', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const p = post(w, wX, 1)
  post(w, wY, 2, { replyTo: p, seen: p })
  const g = buildGroup(w.input({ drop: [wX] }))
  t.is(g.incomplete, true)
  t.alike(refs(g), [wY + ':1'])
})

test('creator device cut marks: a mark on the root ends its authority at the cut, whatever the mark seq', (t) => {
  const make = () => {
    const w = world().add(A, wA).add(X, wX).add(Y, wY)
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
    post(w, wX, 2)
    w.push(G, groupBan({ member: X, on: true, at: AT(3) }))
    return w
  }
  const plain = buildGroup(make().input())
  t.is(plain.members.get(X), 'banned')
  t.ok(plain.authorityWriters.has(G))
  // The creator's diary vouches that root records at seq >= 2 carry no
  // authority: the ban (root seq 2) is void, the grant (seq 1) stands.
  const w = make().mark(C, G, 2)
  let g = buildGroup(w.input())
  t.is(g.members.get(X), 'member', 'the ban at the cut is void')
  t.ok(g.admins.has(A), 'the grant below the cut stands')
  t.absent(g.authorityWriters.has(G), 'the root acts with no authority any more')
  t.is(g.members.get(C), 'member', 'the creator is still a member')
  // No community bounds which marks count: a mark written late in the
  // diary still cuts.
  const late = make().mark(C, G, 2, 500)
  t.is(buildGroup(late.input()).members.get(X), 'member')
  // A gap in the creator's history ends the root's authority only for a
  // creator who left a community; a standalone group has none to leave.
  const gap = make()
  gap.marks.set(C, [{ gap: true }])
  g = buildGroup(gap.input())
  t.is(g.members.get(X), 'banned', 'a gap alone cuts nothing')
  t.ok(g.authorityWriters.has(G))
  // A mark on the creator's second device drops its records from the cut.
  const v = world().add(C, wC).add(X, wX)
  post(v, wX, 1)
  post(v, wC, 2)
  v.push(wC, groupBan({ member: X, on: true, at: AT(3) }))
  t.is(buildGroup(v.input()).members.get(X), 'banned')
  v.mark(C, wC, 2)
  g = buildGroup(v.input())
  t.is(g.members.get(X), 'member', 'the second device cut below its ban')
  t.alike(visible(g), [wX + ':1', wC + ':1'])
})

test('property: the same output for every delivery order of a standalone group', (t) => {
  const w = world({ join: 'approval' }).add(A, wA).add(B, wB).add(X, wX).add(X, wX2).add(Y, wY)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  w.push(wA, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }, { writer: wX2, seq: 1 }], at: AT(2) }))
  post(w, wX, 3)
  post(w, wX2, 4)
  w.push(wA, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(5) }))
  post(w, wY, 6)
  const ban = w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(7) }))
  post(w, wY, 8)
  w.push(wA, groupBan({ member: Y, on: false, lifts: ban, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(9) }))
  w.push(wX2, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(10) }))
  post(w, wB, 11)
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'left')
  t.is(g.members.get(Y), 'member')
  t.is(g.members.get(B), 'requested')
  let seed = 7
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let i = 0; i < 20; i++) {
    const input = w.input()
    input.writers = input.writers.slice().sort(() => rnd() - 0.5).map((l) => ({ ...l, entries: l.entries.slice().sort(() => rnd() - 0.5) }))
    t.is(normalize(buildGroup(input)), normalize(g), 'order ' + i)
  }
})

test('over the group cap the creator and group admins go first and group-banned diaries last', (t) => {
  const w = world()
  const wCreator = K(0xf00001)
  const wAdmin = K(0xf00002)
  const wBanned = K(0x10)
  const D = K(0x99)
  w.add(C, wCreator).add(A, wAdmin).add(D, wBanned)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wAdmin, seq: 1 }], at: AT(1) }))
  w.push(G, groupBan({ member: D, on: true, at: AT(1) }))
  // Three tiered writers and the ordinary ones fill the cap plus two, so
  // two writers go: the banned one and the highest ordinary key, never the
  // creator's or the admin's, whose keys sort last.
  const n = MAX_GROUP_WRITERS - 2
  for (let i = 0; i < n; i++) w.add(K(0x10000 + i), K(0x20000 + i))
  const g = buildGroup(w.input())
  t.is(g.community, null)
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.ok(g.writers.has(G), 'the bound root')
  t.ok(g.writers.has(wCreator), 'the creator writer is kept despite its high key')
  t.ok(g.writers.has(wAdmin), 'the group admin writer is kept despite its high key')
  t.absent(g.writers.has(wBanned), 'the group-banned diary gives up its slot despite the lowest key')
  t.absent(g.writers.has(K(0x20000 + n - 1)), 'the highest ordinary writer goes second')
  t.ok(g.writers.has(K(0x20000 + n - 2)), 'the next one keeps its slot')
  t.ok(g.admins.has(A))
  t.ok(g.bans.has(D), 'the ban still counts for the diary it dropped')
  t.is(g.incomplete, true)
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse()
  t.alike(normalize(buildGroup(shuffled)), normalize(g))
})

test('the writer cap of a standalone group never keeps a rejoin without its leave', (t) => {
  const w = world({ join: 'approval' })
  const wOld = K(0x900000)
  const wNew = K(0x10)
  w.add(X, wOld)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wOld, seq: 1 }], at: AT(1) }))
  const leave = w.push(wOld, groupLeave({ cuts: [{ writer: wOld, seq: w.len(wOld) }], at: AT(2) }))
  w.add(X, wNew, { rejoin: leave, at: AT(3) })
  post(w, wNew, 4)
  // Control: under the cap the rejoin needs a new admit.
  const under = buildGroup(w.input())
  t.is(under.members.get(X), 'requested')
  t.ok(under.posts.some((p) => p.writer === wNew))
  for (let i = 0; i < MAX_GROUP_WRITERS - 1; i++) w.add(K(0x10000 + i), K(0x20000 + i))
  const g = buildGroup(w.input())
  t.absent(g.writers.has(wOld), 'the leave sorts beyond the cap')
  t.absent(g.writers.has(wNew), 'so the rejoin goes with it, despite its low key')
  t.absent(g.posts.some((p) => p.writer === wNew))
  t.not(g.members.get(X), 'member', 'the old admission is not reused')
  t.is(g.incomplete, true)
})

test('creator device cut marks: the lowest mark on the root wins, whatever the order and the diary seq', (t) => {
  const make = () => {
    const w = world().add(A, wA).add(X, wX)
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
    post(w, wX, 2)
    w.push(G, groupBan({ member: X, on: true, at: AT(3) }))
    w.push(G, groupMeta({ name: 'Depois', join: 'open', at: AT(4) }))
    return w
  }
  const plain = buildGroup(make().input())
  t.is(plain.members.get(X), 'banned')
  t.is(plain.name, 'Depois')
  // Root seq 2 is the ban, 3 the meta: a mark at 3 alone keeps the ban.
  t.is(buildGroup(make().mark(C, G, 3).input()).members.get(X), 'banned', 'control: a cut above the ban')
  for (const order of [[2, 3], [3, 2]]) {
    const w = make()
    for (const cut of order) w.mark(C, G, cut)
    const g = buildGroup(w.input())
    t.is(g.members.get(X), 'member', 'marks ' + order + ': the lowest cut voids the ban')
    t.is(g.name, 'Varanda', 'marks ' + order + ': and the meta')
    t.ok(g.admins.has(A), 'marks ' + order + ': the grant below both stands')
  }
  // The lowest mark written far later in the diary than the other.
  const far = make().mark(C, G, 3, 2).mark(C, G, 2, 100000)
  t.is(buildGroup(far.input()).members.get(X), 'member')
})

test('an admin who leaves a standalone group is listed as one who leaves a community group only', (t) => {
  const grant = (w, wkey) => w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wkey, seq: 1 }], at: AT(1) }))
  const w = world().add(A, wA)
  grant(w, wA)
  w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(2) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(A), 'left')
  const parent = community({ creator: Y, members: [{ diary: A, cw: K(0x20), status: 'member' }], creates: [{ by: Y, group: G }] })
  const cg = groupIn(parent, { key: G })
  cg.add(A, wA)
  grant(cg, wA)
  cg.push(wA, groupLeave({ cuts: [{ writer: wA, seq: cg.len(wA) }], at: AT(2) }))
  const r = buildGroup(cg.input())
  t.ok(r.community !== null)
  t.is(r.members.get(A), 'left')
  // The title reads the grant layer, which a leave of G does not withdraw.
  t.is(g.admins.has(A), r.admins.has(A), 'the same rule with and without a community')
  t.ok(g.admins.has(A))
})
