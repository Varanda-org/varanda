'use strict'

// Private standalone groups (docs/protocol.md, section 10 and "Private
// groups"): with no community there is no gate, so the epoch machinery
// (distributors, eligibility, entitled writers, removals) runs on the
// group's own layers alone. A community group whose parent is missing,
// pending or orphan still entitles nobody.
const test = require('brittle')
const b4a = require('b4a')
const {
  groupHeader, writerHeader, groupPost, groupAdmit, groupBan, groupAdmin, groupLeave,
  groupKey, groupSealed, sealedInner, buildGroup
} = require('../lib/group')
const { community } = require('./helpers/groups')
const { newBoxKeyPair, newEpochKey, sealEpochKey, openFrom, sealRecord, keyCommit } = require('../lib/group-crypto')

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
const Z = K(6)
const wC = K(0x101)
const wC2 = K(0x102)
const wA = K(0x200)
const wA2 = K(0x201)
const wB = K(0x300)
const wX = K(0x400)
const wX2 = K(0x401)
const wX3 = K(0x402)
const wY = K(0x500)
const wZ = K(0x700)
const CM = K(0x900)

const hex = (b) => b4a.toString(b, 'hex')
const cm = (key, kid) => hex(keyCommit(key, G, kid))
const kidOf = (r) => r === null ? null : r.writer + ':' + r.seq
const sorted = (list) => [...list].sort()

// A private standalone group: C creates G, whose root opens the first
// epoch E1 for itself alone at creation. With `parent`, the root instead
// names that community (and C itself as the creator's CW), for the
// contrast cases.
function sworld ({ parent = null } = {}) {
  const boxes = new Map([[G, newBoxKeyPair()]])
  const rootHeader = groupHeader({ diary: C, community: parent, member: parent, visibility: 'private', join: 'approval', box: hex(boxes.get(G).publicKey), at: AT(0) })
  const logs = new Map([[G, { key: G, diary: C, entries: [{ seq: 0, record: rootHeader }] }]])
  const joins = new Map([[C, [{ writer: G, on: true, seq: 1 }]]])
  const marks = new Map()
  const epochs = new Map()
  const next = (diary) => {
    let seq = 0
    for (const list of [joins.get(diary) || [], marks.get(diary) || []]) {
      for (const e of list) if (e.seq > seq) seq = e.seq
    }
    return seq + 1
  }
  const w = {
    logs,
    joins,
    marks,
    boxes,
    add (diary, key, { box = true, rejoin = null, at = 0, member = G } = {}) {
      if (box) boxes.set(key, newBoxKeyPair())
      logs.set(key, { key, diary, entries: [{ seq: 0, record: writerHeader({ group: G, diary, member, box: box ? hex(boxes.get(key).publicKey) : null, rejoin, at: AT(at) }) }] })
      const list = joins.get(diary) || []
      list.push({ writer: key, on: true, seq: next(diary) })
      joins.set(diary, list)
      return w
    },
    mark (diary, writer, cut) {
      const list = marks.get(diary) || []
      list.push({ writer, cut, seq: next(diary) })
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
    entry (writer, kid, key) {
      return { writer, sealed: b4a.toString(sealEpochKey(key, G, kid, boxes.get(writer).publicKey), 'base64') }
    },
    // A first block on `by`: a fresh key sealed to `to`.
    rotate (by, to, { basis = [], auth = null, at }) {
      const kid = { writer: by, seq: w.len(by) }
      const key = newEpochKey()
      epochs.set(kidOf(kid), key)
      w.push(by, groupKey({ kid: null, basis, keys: to.map((x) => w.entry(x, kid, key)), auth, commit: cm(key, kid), at: AT(at) }))
      return kid
    },
    // A continuation on `by` handing an existing epoch to `to`.
    hand (by, kid, to, at) {
      return w.push(by, groupKey({ kid, keys: to.map((x) => w.entry(x, kid, epochs.get(kidOf(kid)))), at: AT(at) }))
    },
    seal (writer, kid, record) {
      const { nonce, box } = sealRecord(sealedInner(record, { writer, group: G, kid }), epochs.get(kidOf(kid)))
      return w.push(writer, groupSealed({ kid, nonce, box, at: record.at }))
    },
    reader (...writers) {
      const pair = boxes.get(writers[0])
      return { writers: new Set(writers), unseal: (sealed) => openFrom(b4a.from(sealed, 'base64'), pair) }
    },
    input (keys = null, extra = {}) {
      const writers = [...logs.values()].filter((l) => l.key !== G)
      return { root: logs.get(G), writers, joins, marks, keys, now: NOW, ...extra }
    }
  }
  w.E1 = w.rotate(G, [G], { at: 1 })
  return w
}

// A, an admin, and X and Y, admitted, each on one writer; E2 hands them
// the key.
function members () {
  const w = sworld()
  w.add(A, wA).add(X, wX).add(Y, wY)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(2) }))
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(3) }))
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(4) }))
  w.E2 = w.rotate(G, [G, wA, wX, wY], { at: 5 })
  return w
}

const sealedPost = (w, writer, kid, s) => w.seal(writer, kid, groupPost({ text: 'p' + s, at: AT(s) }))
const texts = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.text)

// The state two folds of the same cores must agree on.
const stateOf = (g) => JSON.stringify({
  writers: sorted(g.writers),
  admins: sorted(g.admins),
  members: [...g.members].sort((a, b) => a[0] < b[0] ? -1 : 1),
  epoch: kidOf(g.epoch),
  rekeyPending: g.rekeyPending,
  entitled: g.entitled,
  removals: g.removals,
  incomplete: g.incomplete
})

test('the first epoch at creation is sendable', (t) => {
  const w = sworld()
  const g = buildGroup(w.input(w.reader(G)))
  t.is(g.incomplete, false)
  t.is(g.community, null)
  t.is(g.visibility, 'private')
  t.alike(g.entitled, [G], 'the root is entitled with no parent')
  t.is(kidOf(g.epoch), kidOf(w.E1), 'E1 is eligible')
  t.is(g.rekeyPending, false)
  t.alike(g.removals, [])
  sealedPost(w, G, w.E1, 2)
  t.alike(texts(buildGroup(w.input(w.reader(G)))), ['p2'])
  t.is(buildGroup(w.input()).epoch, null, 'no key held, no epoch')
})

test('admit then key delivery', (t) => {
  const w = sworld()
  w.add(X, wX)
  let g = buildGroup(w.input(w.reader(G)))
  t.is(g.members.get(X), 'requested')
  t.alike(g.entitled, [G], 'a requester is not entitled')
  t.is(kidOf(g.epoch), kidOf(w.E1))
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  g = buildGroup(w.input(w.reader(G)))
  t.is(g.members.get(X), 'member')
  t.alike(g.entitled, sorted([G, wX]))
  t.is(kidOf(g.epoch), kidOf(w.E1), 'an admit takes nothing away: E1 stays eligible')
  t.is(buildGroup(w.input(w.reader(wX))).epoch, null, 'X holds no key yet')
  w.hand(G, w.E1, [wX], 3)
  sealedPost(w, G, w.E1, 4)
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(w.E1), 'a continuation hands E1 to the admitted writer')
  t.alike(texts(g), ['p4'])
  // A new device of the admitted diary is entitled without a new admit.
  w.add(X, wX2, { at: 5 })
  t.ok(buildGroup(w.input()).entitled.includes(wX2))
})

test('banned, departed, demoted, cut, retired and wrong-rejoin writers are not entitled; a covered device is until a demotion', (t) => {
  const w = members()
  w.add(B, wB).add(Z, wZ)
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(6) }))
  let g = buildGroup(w.input())
  t.alike(g.entitled, sorted([G, wA, wB, wX, wY]), 'every admitted or granted writer, never the requester Z')
  // Banned.
  w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(7) }))
  // Departed.
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(8) }))
  // Demoted: B was never admitted, so the demotion leaves it nothing.
  w.push(G, groupAdmin({ member: B, on: false, cuts: [{ writer: wB, seq: w.len(wB) }], at: AT(9) }))
  // Covered device: a second device of the admin A the grant never listed;
  // A was never admitted, so only the grant covers it (same generation).
  w.add(A, wA2, { at: 10 })
  g = buildGroup(w.input())
  t.is(g.members.get(Y), 'banned')
  t.is(g.members.get(X), 'left')
  t.absent(g.admins.has(B))
  t.ok(g.admins.has(A))
  t.alike(g.entitled, sorted([G, wA, wA2]), 'the grant covers the unlisted device')
  // Wrong rejoin generation: X rejoins naming its leave, but no admit saw
  // that leave, so the new writer is not entitled; the retired old writer
  // never is again.
  w.add(X, wX2, { rejoin: leave, at: 11 })
  g = buildGroup(w.input())
  t.absent(g.entitled.includes(wX2), 'the old admit covers no writer of the next generation')
  t.absent(g.entitled.includes(wX), 'retired')
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 1 }], at: AT(12) }))
  g = buildGroup(w.input())
  t.ok(g.entitled.includes(wX2), 'an admit that saw the leave covers the new writer')
  t.absent(g.entitled.includes(wX), 'never the writer that left')
  // A writer naming a leave of another generation (not X's latest) after a
  // second leave is not entitled either.
  const leave2 = w.push(wX2, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(13) }))
  w.add(X, wX3, { rejoin: leave, at: 14 })
  g = buildGroup(w.input())
  t.absent(g.entitled.includes(wX3), 'a rejoin naming an older leave')
  t.ok(leave2)
  // Cut: A's diary cuts wA (its own decision), which ends its keys.
  w.mark(A, wA, w.len(wA))
  g = buildGroup(w.input())
  t.absent(g.entitled.includes(wA), 'a writer its diary cut')
  t.ok(g.entitled.includes(wA2), 'the covered device keeps its entitlement')
  // Demoted: the demotion cuts the covered device at 0.
  w.push(G, groupAdmin({ member: A, on: false, cuts: [], at: AT(14.5) }))
  g = buildGroup(w.input())
  t.absent(g.entitled.includes(wA2), 'a demotion ends the cover')
  // Creator: a root its diary marked never receives keys again; a new
  // creator writer does.
  w.add(C, wC, { at: 15 })
  w.mark(C, G, w.len(G))
  g = buildGroup(w.input())
  t.absent(g.entitled.includes(G), 'a marked root')
  t.ok(g.entitled.includes(wC), 'the creator on its new writer')
})

test('rotation after removal: the removed member gets no key for the new epoch', (t) => {
  const w = members()
  sealedPost(w, wY, w.E2, 6)
  const ban = w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(7) }))
  let g = buildGroup(w.input(w.reader(wX)))
  t.is(g.epoch, null, 'E2 names Y, who is no longer entitled')
  t.is(g.rekeyPending, true)
  t.alike(g.removals, [ban], 'the ban is the removal a rotation must cover')
  t.alike(g.entitled, sorted([G, wA, wX]))
  // A rotation that excludes Y but misses the ban is still not eligible.
  w.rotate(wA, g.entitled, { at: 8 })
  t.is(buildGroup(w.input(w.reader(wX))).epoch, null, 'the basis must cover the removal')
  const E3 = w.rotate(G, g.entitled, { basis: g.removals, at: 9 })
  sealedPost(w, wX, E3, 10)
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E3))
  t.is(g.rekeyPending, false)
  t.alike(texts(g), ['p6', 'p10'])
  const gy = buildGroup(w.input(w.reader(wY)))
  t.is(gy.epoch, null, 'Y holds no key to the new epoch')
  t.alike(texts(gy), ['p6'], 'Y keeps the history it held and opens nothing sealed under the new epoch')
  t.ok(gy.sealed >= 1)
})

test('rekey by an admin, departures and rejoin of a removed member', (t) => {
  const w = members()
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(6) }))
  let g = buildGroup(w.input(w.reader(wA)))
  t.is(g.rekeyPending, true, 'a genuine leave needs a rotation')
  t.alike(g.removals, [leave])
  const E3 = w.rotate(wA, g.entitled, { basis: g.removals, at: 7 })
  g = buildGroup(w.input(w.reader(wA)))
  t.is(kidOf(g.epoch), kidOf(E3), 'the admin rotation is eligible')
  t.is(kidOf(buildGroup(w.input(w.reader(G))).epoch), kidOf(E3), 'the creator receives it through the root box')
  t.is(buildGroup(w.input(w.reader(wX))).epoch, null, 'X left and got nothing')
  // X comes back on a new writer and is admitted again.
  w.add(X, wX2, { rejoin: leave, at: 8 })
  g = buildGroup(w.input(w.reader(wA)))
  t.ok(g.requests.includes(X))
  t.absent(g.entitled.includes(wX2))
  w.push(wA, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 1 }], at: AT(9) }))
  g = buildGroup(w.input(w.reader(wA)))
  t.is(g.members.get(X), 'member')
  t.ok(g.entitled.includes(wX2))
  w.hand(wA, E3, [wX2], 10)
  sealedPost(w, wA, E3, 11)
  const gx = buildGroup(w.input(w.reader(wX2)))
  t.is(kidOf(gx.epoch), kidOf(E3), 'the rejoined member reads the current epoch')
  t.alike(texts(gx), ['p11'])
})

test('two admins acting concurrently', (t) => {
  const w = members()
  w.add(B, wB)
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(6) }))
  w.hand(G, w.E2, [wB], 7)
  // A bans Y and rotates, while B, not seeing it, rotates to everyone.
  const ban = w.push(wA, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(8) }))
  const EA = w.rotate(wA, [G, wA, wB, wX], { basis: [ban], at: 9 })
  const EB = w.rotate(wB, [G, wA, wB, wX, wY], { at: 9 })
  sealedPost(w, wA, EA, 10)
  sealedPost(w, wB, EB, 10)
  let g = buildGroup(w.input(w.reader(wX)))
  t.is(g.members.get(Y), 'banned')
  t.alike(texts(g).sort(), ['p10', 'p10'], 'both epochs readable')
  t.is(kidOf(g.epoch), kidOf(EA), 'only the rotation that covers the ban and excludes Y is eligible')
  // B and A ban each other: admins are shielded, neither counts.
  w.push(wA, groupBan({ member: B, on: true, at: AT(11) }))
  w.push(wB, groupBan({ member: A, on: true, at: AT(11) }))
  g = buildGroup(w.input(w.reader(wX)))
  t.alike(sorted(g.admins), sorted([A, B, C]))
  t.ok(g.entitled.includes(wA) && g.entitled.includes(wB))
  t.is(kidOf(g.epoch), kidOf(EA))
})

test('two independent folds of the same cores reach the same state', (t) => {
  const w = members()
  w.add(B, wB).add(X, wX2, { at: 6 })
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(6) }))
  const ban = w.push(wA, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(7) }))
  const E3 = w.rotate(wB, [G, wA, wB, wX, wX2], { basis: [ban], at: 8 })
  sealedPost(w, wX2, E3, 9)
  const leave = w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(10) }))
  t.ok(leave)
  const one = buildGroup(w.input(w.reader(wX)))
  const shuffled = w.input(w.reader(wB))
  shuffled.writers = shuffled.writers.slice().reverse().map((l) => ({ ...l, entries: l.entries.slice().reverse() }))
  const two = buildGroup(shuffled)
  t.is(stateOf(two), stateOf(one), 'same writers, admins, epoch and entitled set')
  t.is(stateOf(buildGroup(w.input(w.reader(G)))), stateOf(one), 'whichever member folds')
  t.is(one.rekeyPending, true, 'A left after E3')
  t.alike(one.entitled, sorted([G, wB, wX, wX2]))
})

test('a key block auth is never community authority in a standalone group', (t) => {
  const w = members()
  // X, an admitted member without any grant, cites itself as the
  // community writer a community distributor would cite.
  const EX = w.rotate(wX, [G, wA, wX, wY], { auth: { writer: wX, seq: 1 }, at: 6 })
  sealedPost(w, wX, EX, 7)
  let g = buildGroup(w.input(w.reader(wA)))
  t.is(kidOf(g.epoch), kidOf(w.E2), 'the member rotation is no epoch')
  t.alike(texts(g), [], 'nor readable')
  // An admin's block with an `auth` is judged by the group's own layers.
  const EA = w.rotate(wA, [G, wA, wX, wY], { auth: { writer: wA, seq: 1 }, at: 8 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(EA))
  t.alike(g.removals, [], 'no community removals')
})

test('a private community group with a missing or orphan parent still has epoch null and entitled []', (t) => {
  const w = sworld({ parent: CM })
  w.add(X, wX, { member: K(0x40) })
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  const missing = buildGroup(w.input(w.reader(G)))
  t.is(missing.incomplete, true)
  t.is(missing.epoch, null)
  t.is(missing.rekeyPending, true, 'it holds E1 but nothing is eligible')
  t.alike(missing.entitled, [])
  // The parent folds but never created G (another diary's community): an
  // orphan.
  const other = community({ key: CM, creator: Z })
  const orphan = buildGroup(w.input(w.reader(G), { community: other.input() }))
  t.is(orphan.orphan, true)
  t.is(orphan.epoch, null)
  t.alike(orphan.entitled, [])
  // A writer naming G as member in a community group is header-invalid
  // once the parent folds.
  const parent = community({ key: CM, creator: C, creates: [{ by: C, group: G }] })
  w.add(Y, wY, { member: G, at: 3 })
  const whole = buildGroup(w.input(w.reader(G), { community: parent.input() }))
  t.absent(whole.writers.has(wY))
})

test('a creator who leaves on a second writer and rejoins is entitled only on its rejoin writer', (t) => {
  const w = sworld()
  w.add(C, wC)
  const leave = w.push(wC, groupLeave({ cuts: [{ writer: G, seq: w.len(G) }, { writer: wC, seq: w.len(wC) }], at: AT(6) }))
  let g = buildGroup(w.input())
  t.is(g.members.get(C), 'left')
  t.alike(g.entitled, [], 'the creator left')
  t.alike(g.removals, [leave])
  w.add(C, wC2, { rejoin: leave, at: 7 })
  g = buildGroup(w.input())
  t.is(g.members.get(C), 'member')
  t.alike(g.entitled, [wC2])
})

test('a root its creator marked gets no keys and distributes nothing, whatever the mark seq; the lowest of two marks counts', (t) => {
  const make = () => {
    const w = members()
    w.add(C, wC, { at: 6 })
    return w
  }
  t.alike(buildGroup(make().input()).entitled, sorted([G, wA, wC, wX, wY]), 'control')
  // The mark sits far beyond any seq the creator's diary had: no community
  // bounds which marks count.
  const late = make()
  late.marks.set(C, [{ writer: G, cut: late.len(G), seq: 100000 }])
  const g = buildGroup(late.input())
  t.absent(g.entitled.includes(G), 'a root marked at a late diary seq')
  t.ok(g.entitled.includes(wC), 'the creator on its other writer')
  t.ok(g.admins.has(A), 'the grant below the cut stands')
  const to = [wA, wC, wX, wY]
  late.rotate(G, to, { basis: g.removals, at: 7 })
  t.is(buildGroup(late.input(late.reader(wX))).epoch, null, 'a root rotation past the cut is no epoch')
  const EA = late.rotate(wA, to, { basis: g.removals, at: 8 })
  t.is(kidOf(buildGroup(late.input(late.reader(wX))).epoch), kidOf(EA), 'control: the same rotation by the admin is')
  // Root seq 2 is A's grant (A was never admitted). A cut above the root's
  // records keeps it; with a cut at 2 as well, in either order, the lowest
  // voids it.
  const above = make()
  above.mark(C, G, above.len(G))
  t.ok(buildGroup(above.input()).entitled.includes(wA), 'control: a cut above the grant')
  for (const first of [2, 'len']) {
    const w = make()
    const cuts = first === 2 ? [2, w.len(G)] : [w.len(G), 2]
    for (const cut of cuts) w.mark(C, G, cut)
    const r = buildGroup(w.input())
    t.absent(r.entitled.includes(G), 'marks ' + cuts)
    t.absent(r.admins.has(A), 'marks ' + cuts + ': the grant at the lowest cut is void')
    t.absent(r.entitled.includes(wA), 'marks ' + cuts + ': so A gets no keys')
  }
})
