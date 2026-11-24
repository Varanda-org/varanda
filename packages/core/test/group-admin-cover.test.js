'use strict'

// An admin grant covers the admin's devices it does not list
// (docs/protocol.md, "Admin grants cover the admin's devices"): exactly
// as an admit covers a member's (autoAdmit), from the device's first
// record after the grant, only in the grant's generation, until a demotion,
// a leave or a diary cut. The reading layer keeps the cover of every grant
// it holds, so an epoch a covered device handed out stays readable.
const test = require('brittle')
const b4a = require('b4a')
const {
  groupHeader, writerHeader, groupPost, groupHide, groupAdmit, groupBan, groupAdmin, groupLeave,
  groupKey, groupSealed, sealedInner, groupReact, communityBan, buildGroup, buildCommunity
} = require('../lib/group')
const { K, AT, NOW, community, groupIn } = require('./helpers/groups')
const { newBoxKeyPair, newEpochKey, sealEpochKey, openFrom, sealRecord, keyCommit } = require('../lib/group-crypto')

const G = K(0x100)
const C = K(1)
const A = K(2)
const D = K(3)
const X = K(4)
const Y = K(5)
const wA = K(0x200)
const wA2 = K(0x201)
const wA3 = K(0x202)
const wD = K(0x300)
const wX = K(0x400)
const wY = K(0x500)
const CMG = K(0xc0)
const cwOf = (diary) => 'cc' + diary.slice(2)

const hex = (b) => b4a.toString(b, 'hex')
const sorted = (set) => [...set].sort()
const visible = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.writer + ':' + p.seq)
const kidOf = (r) => r === null ? null : r.writer + ':' + r.seq
const post = (w, key, s) => w.push(key, groupPost({ text: 'p' + s, at: AT(s) }))

// A public group G of C inside the community CMG C created; each diary that
// writes in G gets a CW there.
function world ({ join = 'open' } = {}) {
  const parent = community({ key: CMG, creator: C, creates: [{ by: C, group: G }] })
  const g = groupIn(parent, { key: G, diary: C, join, name: 'Varanda' })
  const w = {
    C: parent,
    add (diary, key, { rejoin = null } = {}) {
      if (parent.cwOf(diary) === undefined) parent.addWriter(diary, cwOf(diary))
      g.add(diary, key, { rejoin })
      return w
    },
    push: g.push,
    len: g.len,
    mark (diary, writer, cut, seq) {
      g.mark(diary, writer, cut, seq)
      return w
    },
    input: () => g.input({ community: parent.input() })
  }
  return w
}

test('an admin second writer moderates only from its first record after the grant', (t) => {
  const w = world({ join: 'approval' }).add(A, wA).add(A, wA2).add(X, wX).add(Y, wY).add(D, wD)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(1) }))
  const p2 = post(w, wX, 2)
  post(w, wD, 2)
  // Before the grant: nothing wA2 writes carries authority.
  w.push(wA2, groupHide({ target: p2, on: true, at: AT(3) }))
  w.push(wA2, groupBan({ member: Y, on: true, at: AT(3) }))
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(4) }))
  let g = buildGroup(w.input())
  t.ok(g.admins.has(A))
  t.ok(visible(g).includes(wX + ':1'), 'a hide before the grant is void')
  t.is(g.members.get(Y), 'member', 'a ban before the grant is void')
  t.absent(visible(g).includes(wD + ':1'), 'D is not admitted yet')
  // After the grant: the unlisted writer bans, admits and hides.
  const p5 = post(w, wX, 5)
  w.push(wA2, groupHide({ target: p5, on: true, at: AT(6) }))
  w.push(wA2, groupAdmit({ member: D, on: true, cuts: [{ writer: wD, seq: 1 }], at: AT(6) }))
  w.push(wA2, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(7) }))
  g = buildGroup(w.input())
  t.ok(visible(g).includes(wD + ':1'), 'its admit counts')
  t.is(g.members.get(X), 'banned', 'its ban counts')
  t.absent(g.posts.find((p) => p.writer === wX && p.seq === 1).hidden, 'the earlier hide stays void')
  t.ok(g.posts.find((p) => p.writer === wX && p.seq === 2).hidden, 'its later hide counts')
  t.ok(g.authorityWriters.has(wA2), 'its next record would act')

  // A writer bound after the grant is covered from its first record.
  w.add(A, wA3)
  w.push(wA3, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(8) }))
  g = buildGroup(w.input())
  t.is(g.members.get(Y), 'banned', 'a device bound after the grant acts')

  // A demotion cuts every writer of the diary at 0, covered ones included.
  w.push(G, groupAdmin({ member: A, on: false, cuts: [], at: AT(9) }))
  g = buildGroup(w.input())
  t.absent(g.admins.has(A))
  t.is(g.members.get(X), 'member')
  t.is(g.members.get(Y), 'member')
  t.absent(visible(g).includes(wD + ':1'), 'the admit is void too')
  for (const k of [wA, wA2, wA3]) t.absent(g.authorityWriters.has(k), 'no authority left on ' + k.slice(-3))
})

test('an earlier grant never covers a writer of a later generation', (t) => {
  // The grant observed no leave; the device names one.
  const w = world().add(A, wA).add(X, wX).add(Y, wY)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  const L = w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(2) }))
  w.add(A, wA2, { rejoin: L })
  w.push(wA2, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  t.absent(g.authorityWriters.has(wA2))
})

test('a diary cut drops a covered writer', (t) => {
  const w = world().add(A, wA).add(A, wA2).add(X, wX).add(Y, wY)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  w.push(wA2, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  t.is(buildGroup(w.input()).members.get(X), 'banned', 'control: covered')
  w.mark(A, wA2, 1)
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member', 'the cut drops its records')
  t.absent(g.authorityWriters.has(wA2))
})

test('approval group: a covered device that only reacts has its reactions counted, as a listed one', (t) => {
  const w = world({ join: 'approval' }).add(A, wA).add(A, wA2).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  const target = post(w, wX, 3)
  w.push(wA2, groupReact({ target, emoji: '\u{1f44d}', at: AT(4) }))
  const g = buildGroup(w.input())
  t.ok(g.authorityWriters.has(wA2))
  t.alike(g.posts[0].reactions, [{ emoji: '\u{1f44d}', count: 1, by: [A] }], 'the reaction counts')
})

test('approval community: a covered CW keeps its earlier group posts after it retires, as a listed one', (t) => {
  const cwA = cwOf(A)
  const cwA2 = K(0x21)
  const run = (listed) => {
    const parent = community({ key: CMG, creator: C, join: 'approval', members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: C, group: G }] })
    parent.addWriter(A, cwA2)
    parent.push(CMG, groupAdmin({ member: A, on: true, cuts: listed ? [{ writer: cwA, seq: 1 }, { writer: cwA2, seq: 1 }] : [{ writer: cwA, seq: 1 }], at: parent.at() }))
    const g = groupIn(parent, { key: G, diary: C, name: 'Varanda' })
    g.add(A, wA2, { cw: cwA2 })
    g.push(wA2, groupPost({ text: 'antes', at: parent.at() }))
    let r = buildGroup(g.input())
    t.alike(visible(r), [wA2 + ':1'], (listed ? 'listed' : 'covered') + ': visible before the leave')
    parent.push(cwA2, groupLeave({ cuts: [{ writer: cwA2, seq: parent.len(cwA2) }], at: parent.at() }))
    parent.confirm(A, cwA2)
    r = buildGroup(g.input())
    t.alike(visible(r), [wA2 + ':1'], (listed ? 'listed' : 'covered') + ': the earlier post stays after the CW retires')
  }
  run(true)
  run(false)
})

test('approval group of a community: a covered writer keeps its earlier posts after its CW retires, as a listed one', (t) => {
  const cwA = cwOf(A)
  const cwA2 = K(0x21)
  const run = (listed) => {
    const name = listed ? 'listed' : 'covered'
    const parent = community({ key: CMG, creator: C, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: C, group: G }] })
    parent.addWriter(A, cwA2)
    const g = groupIn(parent, { key: G, diary: C, join: 'approval', name: 'Varanda' })
    g.add(A, wA, { cw: cwA })
    g.add(A, wA2, { cw: cwA2 })
    g.push(G, groupAdmin({ member: A, on: true, cuts: listed ? [{ writer: wA, seq: 1 }, { writer: wA2, seq: 1 }] : [{ writer: wA, seq: 1 }], at: parent.at() }))
    const target = g.push(G, groupPost({ text: 'raiz', at: parent.at() }))
    g.push(wA2, groupPost({ text: 'antes', at: parent.at() }))
    g.push(wA2, groupReact({ target, emoji: '\u{1f44d}', at: parent.at() }))
    const reactions = (r) => r.posts.find((p) => p.writer === G).reactions || []
    let r = buildGroup(g.input({ community: parent.input() }))
    t.ok(visible(r).includes(wA2 + ':1'), name + ': visible before the leave')
    t.is(reactions(r).length, 1, name + ': the reaction counts before the leave')
    parent.push(cwA2, groupLeave({ cuts: [{ writer: cwA2, seq: parent.len(cwA2) }], at: parent.at() }))
    parent.confirm(A, cwA2)
    r = buildGroup(g.input({ community: parent.input() }))
    t.ok(visible(r).includes(wA2 + ':1'), name + ': the earlier post stays after the CW retires')
    t.absent(r.authorityWriters.has(wA2), name + ': no authority after the CW retires')
    return { visible: visible(r), reactions: reactions(r) }
  }
  t.alike(run(false), run(true), 'the covered writer ends as the listed one')
})

test('in a community the admin new CW is covered and in authorityWriters', (t) => {
  const cwA = cwOf(A)
  const cwA2 = K(0x21)
  const cwX = cwOf(X)
  const comm = community({ creator: C, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }], admins: [A] })
  comm.addWriter(A, cwA2)
  let c = buildCommunity(comm.input())
  t.alike(sorted(c.authorityWriters), sorted([comm.key, cwA, cwA2]), 'the grant covers the new CW of its generation')
  comm.push(cwA2, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: 1 }], at: comm.at() }))
  c = buildCommunity(comm.input())
  t.is(c.members.get(X), 'banned', 'its ban counts in C')
  // A leave on the new CW retires it: no cover left.
  comm.push(cwA2, groupLeave({ cuts: [{ writer: cwA2, seq: comm.len(cwA2) }], at: comm.at() }))
  comm.confirm(A, cwA2)
  c = buildCommunity(comm.input())
  t.absent(c.authorityWriters.has(cwA2))
})

// A private group inside the open community CM: C creates G; `cadmins` are
// C admins granted in CM's root (their CW listed at its length); with
// `base`, A is a G admin listing wA, X and Y are admitted and the root opens
// E1 for every writer.
const CM = K(0x900)
const cwKey = (d) => 'c' + d.slice(1)
function pworld ({ base = true, cadmins = [] } = {}) {
  const granted = cadmins.filter((d) => d !== C)
  const comm = community({ key: CM, creator: C, members: granted.map((d) => ({ diary: d, cw: cwKey(d), status: 'member' })), admins: granted, creates: [{ by: C, group: G }] })
  const boxes = new Map([[G, newBoxKeyPair()]])
  const logs = new Map([[G, { key: G, diary: C, entries: [{ seq: 0, record: groupHeader({ diary: C, community: CM, member: comm.cwOf(C), visibility: 'private', join: 'approval', box: hex(boxes.get(G).publicKey), at: AT(0) }) }] }]])
  const joins = new Map([[C, [{ writer: G, on: true, seq: 1 }]]])
  const epochs = new Map()
  const w = {
    logs,
    comm,
    add (diary, key, { cw = null, rejoin = null } = {}) {
      if (!comm.cwOf(diary)) comm.addWriter(diary, cwKey(diary))
      boxes.set(key, newBoxKeyPair())
      logs.set(key, { key, diary, entries: [{ seq: 0, record: writerHeader({ group: G, diary, member: cw || comm.cwOf(diary), box: hex(boxes.get(key).publicKey), rejoin, at: AT(0) }) }] })
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
    len: (key) => logs.get(key).entries.length,
    entry (writer, kid, key) {
      return { writer, sealed: b4a.toString(sealEpochKey(key, G, kid, boxes.get(writer).publicKey), 'base64') }
    },
    rotate (by, to, { basis = [], auth = null, at }) {
      const kid = { writer: by, seq: w.len(by) }
      const key = newEpochKey()
      epochs.set(kid.writer + ':' + kid.seq, key)
      w.push(by, groupKey({ kid: null, basis, keys: to.map((x) => w.entry(x, kid, key)), auth, commit: hex(keyCommit(key, G, kid)), at: AT(at) }))
      return kid
    },
    seal (writer, kid, record) {
      const { nonce, box } = sealRecord(sealedInner(record, { writer, group: G, kid }), epochs.get(kid.writer + ':' + kid.seq))
      return w.push(writer, groupSealed({ kid, nonce, box, at: record.at }))
    },
    reader (writer) {
      const pair = boxes.get(writer)
      return { writers: new Set([writer]), unseal: (sealed) => openFrom(b4a.from(sealed, 'base64'), pair) }
    },
    input (keys = null) {
      return { root: logs.get(G), writers: [...logs.values()].filter((l) => l.key !== G), joins, community: comm.input(), keys, now: NOW }
    }
  }
  if (base) {
    w.add(A, wA).add(X, wX).add(Y, wY)
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
    w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
    w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(3) }))
    w.E1 = w.rotate(G, [G, wA, wX, wY], { at: 4 })
  }
  return w
}
const sealedPost = (w, writer, kid, s) => w.seal(writer, kid, groupPost({ text: 'p' + s, at: AT(s) }))
const texts = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.text)

test('private group: a covered writer is entitled and hides in both passes', (t) => {
  const w = pworld()
  w.add(A, wA2)
  const p6 = sealedPost(w, wX, w.E1, 6)
  w.seal(wA2, w.E1, groupHide({ target: p6, on: true, at: AT(7) }))
  sealedPost(w, wX, w.E1, 8)
  const plain = buildGroup(w.input())
  const opened = buildGroup(w.input(w.reader(wX)))
  t.ok(plain.entitled.includes(wA2), 'the unlisted device is entitled')
  t.alike(texts(opened), ['p8'], 'its sealed hide counts')
})

test('private group: a later grant never covers a device from before the admin leave', (t) => {
  const w = pworld()
  w.add(A, wA3)
  const L = w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }, { writer: wA3, seq: w.len(wA3) }], at: AT(6) }))
  w.add(A, wA2, { rejoin: L })
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA2, seq: 1 }], at: AT(7) }))
  w.push(wA3, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(8) }))
  const g = buildGroup(w.input())
  t.ok(g.admins.has(A), 're-granted')
  t.is(g.members.get(X), 'member', 'the device from before the leave is not covered')
  t.absent(g.entitled.includes(wA3))
  t.ok(g.entitled.includes(wA2))
  t.ok(g.authorityWriters.has(wA2))
})

test('private group: an epoch a covered writer hands out stays readable after the admin leaves and is demoted', (t) => {
  const w = pworld()
  w.add(A, wA2)
  const E2 = w.rotate(wA2, [G, wA, wA2, wX, wY], { at: 6 })
  sealedPost(w, wX, E2, 7)
  let g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2), 'the covered writer distributes for sending')
  t.alike(texts(g), ['p7'])
  w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }, { writer: wA2, seq: w.len(wA2) }], at: AT(8) }))
  g = buildGroup(w.input(w.reader(wX)))
  t.alike(texts(g), ['p7'], 'readable after the admin leaves')
  w.push(G, groupAdmin({ member: A, on: false, cuts: [], at: AT(9) }))
  g = buildGroup(w.input(w.reader(wX)))
  t.alike(texts(g), ['p7'], 'readable after the demotion')
})

test('private group of a community: a key block from a covered CW reads and sends, and stays readable after it retires', (t) => {
  const w = pworld({ base: false, cadmins: [A] })
  const cwA2 = 'e' + A.slice(1)
  w.comm.addWriter(A, cwA2)
  w.add(A, wA).add(A, wA2, { cw: cwA2 }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  const E1 = w.rotate(G, [G, wA, wA2, wX], { at: 3 })
  const E2 = w.rotate(wA2, [G, wA, wA2, wX], { basis: [E1], auth: { writer: cwA2, seq: w.comm.len(cwA2) }, at: 4 })
  sealedPost(w, wX, E2, 5)
  let g = buildGroup(w.input(w.reader(wX)))
  t.ok(g.admins.has(A))
  t.is(kidOf(g.epoch), kidOf(E2), 'valid for sending')
  t.alike(texts(g), ['p5'], 'valid for reading')
  // A leaves C on the covered CW: it retires, its key block stays history.
  w.comm.push(cwA2, groupLeave({ cuts: [{ writer: cwA2, seq: w.comm.len(cwA2) }], at: AT(6) }))
  w.comm.confirm(A, cwA2)
  g = buildGroup(w.input(w.reader(wX)))
  t.alike(texts(g), ['p5'], 'readable after the CW retires')
  // And after C's creator demotes A.
  w.comm.push(CM, groupAdmin({ member: A, on: false, cuts: [], at: AT(7) }))
  g = buildGroup(w.input(w.reader(wX)))
  t.absent(g.admins.has(A))
  t.alike(texts(g), ['p5'], 'readable after the demotion')
})

test('private group of a community: a covered CW that handed out the epoch and left C asks for the same rekey as a listed one', (t) => {
  const run = (listed) => {
    const w = pworld({ base: false, cadmins: [A] })
    const cwA2 = 'e' + A.slice(1)
    w.comm.addWriter(A, cwA2)
    if (listed) w.comm.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwKey(A), seq: 1 }, { writer: cwA2, seq: 1 }], at: AT(1) }))
    w.add(A, wA).add(A, wA2, { cw: cwA2 }).add(X, wX)
    w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
    // A holds G keys only through the block its covered CW hands out.
    const E1 = w.rotate(G, [G, wX], { at: 3 })
    const E2 = w.rotate(wA2, [G, wA, wA2, wX], { basis: [E1], auth: { writer: cwA2, seq: w.comm.len(cwA2) }, at: 4 })
    sealedPost(w, wX, E2, 5)
    t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E2), (listed ? 'listed' : 'covered') + ': valid for sending')
    w.comm.push(cwA2, groupLeave({ cuts: [{ writer: cwA2, seq: w.comm.len(cwA2) }], at: AT(6) }))
    w.comm.confirm(A, cwA2)
    const g = buildGroup(w.input(w.reader(wX)))
    return { removals: g.removals, rekeyPending: g.rekeyPending, epoch: kidOf(g.epoch) }
  }
  const listed = run(true)
  t.ok(listed.removals.length > 0, 'control: the listed CW leave asks for a removal')
  t.ok(listed.rekeyPending)
  t.alike(run(false), listed, 'the covered CW leave asks for the same')
})

test('private group: a sealed reaction of a covered writer counts as a plaintext one does', (t) => {
  const emoji = '\u{1f44d}'
  // Public control: the reaction before the grant counts (a side record of
  // a covered writer counts from seq 1).
  const pub = world({ join: 'approval' }).add(A, wA).add(A, wA2).add(X, wX)
  pub.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  const target = post(pub, wX, 2)
  pub.push(wA2, groupReact({ target, emoji, at: AT(5) }))
  pub.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(6) }))
  t.is(buildGroup(pub.input()).posts[0].reactions.length, 1, 'public: counts')

  const w = pworld({ base: false })
  w.add(A, wA).add(A, wA2).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  const E1 = w.rotate(G, [G, wA, wA2, wX], { at: 2 })
  const p = sealedPost(w, wX, E1, 3)
  w.seal(wA2, E1, groupReact({ target: p, emoji, at: AT(5) }))
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(6) }))
  const g = buildGroup(w.input(w.reader(wX)))
  t.alike(texts(g), ['p3'])
  t.is((g.posts[0].reactions || []).length, 1, 'private: the sealed reaction counts too')
})
