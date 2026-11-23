'use strict'

// The sibling charter in private groups (docs/protocol.md, section 10,
// "Charter from the creator's other devices"): a sealed meta or about from
// the creator's other device counts only with its envelope's authority,
// another diary's sealed charter stays sealed, and an epoch an admin hands
// out stays readable once the device that granted it no longer counts.
const test = require('brittle')
const b4a = require('b4a')
const {
  groupHeader, writerHeader, groupPost, groupMeta, groupAbout, groupAdmit, groupAdmin, groupLeave,
  groupKey, groupSealed, sealedInner, communityGrant, buildGroup
} = require('../lib/group')
const { K, AT, NOW, community } = require('./helpers/groups')
const { newBoxKeyPair, newEpochKey, sealEpochKey, openFrom, sealRecord, keyCommit } = require('../lib/group-crypto')

const G = K(0x100)
const C = K(1)
const A = K(2)
const B = K(3)
const X = K(4)
const wC = K(0x101)
const wA = K(0x200)
const wB = K(0x300)
const wX = K(0x400)
const CM = K(0x900)
const cwC2 = K(0x9c2)
const cwKey = (d) => 'c' + d.slice(1)
const hex = (b) => b4a.toString(b, 'hex')
const byWriter = (cuts) => cuts.sort((x, y) => x.writer.localeCompare(y.writer))

// A private group G of C inside CM (C created both), with A an admin and X
// a member of G, and E1 handed to the root, wA and wX.
function pworld () {
  const comm = community({ key: CM, creator: C, creates: [{ by: C, group: G }] })
  const boxes = new Map([[G, newBoxKeyPair()]])
  const logs = new Map([[G, { key: G, diary: C, entries: [{ seq: 0, record: groupHeader({ diary: C, community: CM, member: CM, visibility: 'private', join: 'approval', box: hex(boxes.get(G).publicKey), at: AT(0) }) }] }]])
  const joins = new Map([[C, [{ writer: G, on: true, seq: 1 }]]])
  const epochs = new Map()
  const w = {
    comm,
    add (diary, key) {
      if (!comm.cwOf(diary)) comm.addWriter(diary, cwKey(diary))
      boxes.set(key, newBoxKeyPair())
      logs.set(key, { key, diary, entries: [{ seq: 0, record: writerHeader({ group: G, diary, member: comm.cwOf(diary), box: hex(boxes.get(key).publicKey), at: AT(0) }) }] })
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
    rotate (by, to, { auth = null, at }) {
      const kid = { writer: by, seq: w.len(by) }
      const key = newEpochKey()
      epochs.set(kid.writer + ':' + kid.seq, key)
      const keys = to.map((x) => ({ writer: x, sealed: b4a.toString(sealEpochKey(key, G, kid, boxes.get(x).publicKey), 'base64') }))
      w.push(by, groupKey({ kid: null, basis: [], keys, auth, commit: b4a.toString(keyCommit(key, G, kid), 'hex'), at: AT(at) }))
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
    input: (keys = null) => ({ root: logs.get(G), writers: [...logs.values()].filter((l) => l.key !== G), joins, community: comm.input(), keys, now: NOW })
  }
  w.add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  w.E1 = w.rotate(G, [G, wA, wX], { at: 3 })
  w.seal(G, w.E1, groupMeta({ name: 'Segredo', join: 'approval', at: AT(4) }))
  return w
}

const texts = (g) => g.posts.map((p) => p.text)

test('a sealed sibling meta or about counts only with its envelope\'s authority', (t) => {
  const w = pworld().add(C, wC)
  // Naming the root's latest record (the writer contract): its sealed meta.
  const seen = { writer: G, seq: w.len(G) - 1 }
  w.seal(wC, w.E1, groupMeta({ name: 'Irma', join: 'approval', seen, at: AT(10) }))
  w.seal(wC, w.E1, groupAbout({ about: 'so nos', seen, at: AT(11), sealed: true }))
  let g = buildGroup(w.input(w.reader(wX)))
  t.is(g.name, 'Irma', 'the sibling meta')
  t.is(g.about, 'so nos', 'the sibling about')
  t.is(g.sealed, 0)
  w.seal(wC, w.E1, groupMeta({ name: 'Aberto', join: 'open', at: AT(12) }))
  t.is(buildGroup(w.input(w.reader(wX))).name, 'Irma', 'a private group always asks for approval')
  w.push(wC, groupLeave({ cuts: byWriter([{ writer: G, seq: w.len(G) }, { writer: wC, seq: w.len(wC) }]), at: AT(13) }))
  g = buildGroup(w.input(w.reader(wX)))
  t.is(g.name, 'Segredo', 'withdrawn by the creator leave: the root meta below the cut stays')
  t.is(g.about, null)
})

test('another diary\'s sealed charter stays sealed and counts nothing', (t) => {
  const w = pworld()
  const before = buildGroup(w.input(w.reader(wX)))
  w.seal(wA, w.E1, groupMeta({ name: 'Golpe', join: 'approval', at: AT(10) }))
  w.seal(wA, w.E1, groupAbout({ about: 'golpe', at: AT(11), sealed: true }))
  const g = buildGroup(w.input(w.reader(wX)))
  t.is(g.name, 'Segredo')
  t.is(g.about, null)
  t.is(g.sealed, before.sealed + 2, 'unread, as older readers keep them')
})

test('an epoch from an admin a sibling granted stays readable after the creator leaves', (t) => {
  const w = pworld().add(C, wC).add(B, wB)
  w.push(G, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(5) }))
  w.push(wC, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(6) }))
  const E2 = w.rotate(wB, [G, wA, wB, wX], { at: 7 })
  w.seal(wX, E2, groupPost({ text: 'p8', at: AT(8) }))
  let g = buildGroup(w.input(w.reader(wX)))
  t.ok(g.admins.has(B), 'the sibling grant')
  t.alike(texts(g), ['p8'])
  w.push(wC, groupLeave({ cuts: byWriter([{ writer: G, seq: w.len(G) }, { writer: wC, seq: w.len(wC) }]), at: AT(9) }))
  g = buildGroup(w.input(w.reader(wX)))
  t.absent(g.admins.has(B), 'the grant ends with the leave')
  t.alike(texts(g), ['p8'], 'the history B handed out stays readable')
})

test('an epoch from a C admin a creator CW granted stays readable after the CW retires and after the creator leaves C', (t) => {
  const make = (byCw) => {
    const w = pworld().add(B, wB)
    w.comm.addWriter(C, cwC2)
    const grant = { member: B, cuts: [{ writer: cwKey(B), seq: 1 }], at: AT(5) }
    if (byCw) w.comm.push(cwC2, communityGrant(grant))
    else w.comm.push(CM, groupAdmin({ ...grant, on: true }))
    const E2 = w.rotate(wB, [G, wA, wB, wX], { auth: { writer: cwKey(B), seq: 1 }, at: 7 })
    w.seal(wX, E2, groupPost({ text: 'p8', at: AT(8) }))
    return w
  }
  let w = make(true)
  let g = buildGroup(w.input(w.reader(wX)))
  t.ok(g.admins.has(B), 'a C admin through the creator CW')
  t.alike(texts(g), ['p8'])
  w.comm.push(cwC2, groupLeave({ cuts: [{ writer: cwC2, seq: w.comm.len(cwC2) }], at: AT(9) }))
  w.comm.confirm(C, cwC2)
  g = buildGroup(w.input(w.reader(wX)))
  t.absent(g.admins.has(B), 'the CW retired')
  t.alike(texts(g), ['p8'], 'still readable')

  for (const byCw of [true, false]) {
    w = make(byCw)
    w.comm.push(CM, groupLeave({ cuts: [{ writer: CM, seq: w.comm.len(CM) }], at: AT(9) }))
    w.comm.confirm(C, CM)
    g = buildGroup(w.input(w.reader(wX)))
    t.alike(texts(g), ['p8'], (byCw ? 'CW grant' : 'root grant') + ': readable after the creator leaves C')
  }
})

test('a second device with only its header sets a sealed about through its seen', (t) => {
  const w = pworld().add(C, wC)
  const root = w.seal(G, w.E1, groupAbout({ about: 'raiz', at: AT(10), sealed: true }))
  const s = w.seal(wC, w.E1, groupAbout({ about: 'irma', seen: root, at: AT(5), sealed: true }))
  t.is(buildGroup(w.input(w.reader(wX))).about, 'irma', 'it follows the root about it saw')
  w.seal(G, w.E1, groupAbout({ about: 'raiz de novo', seen: s, at: AT(1), sealed: true }))
  t.is(buildGroup(w.input(w.reader(wX))).about, 'raiz de novo', 'a later root about wins back')
})

test('a third device replaces the second one\'s sealed about by naming it', (t) => {
  const wC2 = K(0x102)
  const w = pworld().add(C, wC).add(C, wC2)
  const root = w.seal(G, w.E1, groupAbout({ about: 'raiz', at: AT(10), sealed: true }))
  const two = w.seal(wC, w.E1, groupAbout({ about: 'dois', seen: root, at: AT(11), sealed: true }))
  t.is(buildGroup(w.input(w.reader(wX))).about, 'dois')
  w.seal(wC2, w.E1, groupAbout({ about: 'tres', seen: two, at: AT(1), sealed: true }))
  t.is(buildGroup(w.input(w.reader(wX))).about, 'tres', 'device 3 names device 2\'s about and wins')
})

test('a sealed sibling about naming its own writer ahead is judged where its envelope sits', (t) => {
  const w = pworld().add(C, wC)
  const ahead = { writer: wC, seq: w.len(wC) + 1 }
  w.seal(wC, w.E1, groupAbout({ about: 'so nos', seen: ahead, at: AT(10), sealed: true }))
  t.is(buildGroup(w.input(w.reader(wX))).about, 'so nos', 'control')
  const L = w.push(wC, groupLeave({ cuts: byWriter([{ writer: G, seq: w.len(G) }, { writer: wC, seq: w.len(wC) }]), at: AT(11) }))
  t.is(L.seq, ahead.seq, 'the seen names the leave')
  t.is(buildGroup(w.input(w.reader(wX))).about, null, 'the leave after its envelope ends it')
})

// The reading layer takes a sibling grant or demotion only where the rank,
// without leave or liveness terms, and the diary cut bound let it take
// effect.
const wC3 = K(0x103)
// The input with group-cut marks of C's diary, after its joins.
const withMarks = (w, keys, list) => {
  const input = w.input(keys)
  let seq = Math.max(...input.joins.get(C).map((j) => j.seq))
  return { ...input, marks: new Map([[C, list.map((m) => ({ ...m, seq: ++seq }))]]) }
}

test('reading: a stolen sibling\'s demotion naming a root seq reached after the cut never makes an admin\'s epoch unreadable', (t) => {
  const w = pworld().add(C, wC)
  const future = { writer: G, seq: w.len(G) + 1 }
  w.push(wC, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], seen: future, at: AT(5) }))
  const marks = [{ writer: wC, cut: w.len(wC), at: AT(20) }]
  // Root records every reader holds, written after the cut.
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(30) }))
  t.is(w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(31) })).seq, future.seq)
  const E2 = w.rotate(wA, [G, wA, wX], { at: 40 })
  w.seal(wX, E2, groupPost({ text: 'p41', at: AT(41) }))
  const g = buildGroup(withMarks(w, w.reader(wX), marks))
  t.ok(g.admins.has(A), 'the planted demotion is void')
  t.alike(texts(g), ['p41'], 'A\'s epoch after the cut opens')
})

test('reading: a stolen sibling\'s grant naming a root seq reached after the cut never makes a member\'s key block distribute', (t) => {
  const w = pworld().add(C, wC)
  const future = { writer: G, seq: w.len(G) + 1 }
  w.push(wC, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], seen: future, at: AT(5) }))
  const marks = [{ writer: wC, cut: w.len(wC), at: AT(20) }]
  // Root records every reader holds, written after the cut.
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(30) }))
  t.is(w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(31) })).seq, future.seq)
  const E2 = w.rotate(wX, [G, wA, wX], { at: 40 })
  w.seal(wX, E2, groupPost({ text: 'p41', at: AT(41) }))
  const g = buildGroup(withMarks(w, w.reader(wA), marks))
  t.absent(g.admins.has(X), 'the planted grant is void')
  t.alike(texts(g), [], 'X\'s key block opens nothing')
})

test('reading: a sibling demotion a member writer drags past a root re-grant never makes the admin\'s epoch unreadable', (t) => {
  const w = pworld().add(C, wC)
  // A forward ref to wX, which the member then grows past the re-grant.
  const ahead = { writer: wX, seq: w.len(wX) + 1 }
  w.push(wC, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], seen: ahead, at: AT(5) }))
  const regrant = w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(6) }))
  w.seal(wX, w.E1, groupPost({ text: 'p7', seen: regrant, at: AT(7) }))
  t.is(w.seal(wX, w.E1, groupPost({ text: 'p8', at: AT(8) })).seq, ahead.seq)
  const E2 = w.rotate(wA, [G, wA, wX], { at: 9 })
  w.seal(wX, E2, groupPost({ text: 'p10', at: AT(10) }))
  const g = buildGroup(w.input(w.reader(wX)))
  t.ok(g.admins.has(A), 'the re-grant holds')
  t.ok(texts(g).includes('p10'), 'A\'s epoch after the re-grant opens')
})

test('reading: a re-grant after a rejoin, at the same slot as a withdrawn demotion, stays readable whatever the key order', (t) => {
  for (const [demoter, regranter] of [[wC, wC3], [wC3, wC]]) {
    const w = pworld().add(C, demoter)
    const s = { writer: G, seq: w.len(G) - 1 }
    w.push(demoter, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], seen: s, at: AT(5) }))
    const L = w.push(demoter, groupLeave({ cuts: byWriter([{ writer: G, seq: w.len(G) }, { writer: demoter, seq: w.len(demoter) }]), at: AT(6) }))
    w.add(C, regranter)
    const input = w.input()
    const log = input.writers.find((l) => l.key === regranter)
    log.entries[0] = { seq: 0, record: writerHeader({ ...log.entries[0].record, rejoin: L }) }
    input.joins.get(C)[input.joins.get(C).length - 1].rejoin = L
    w.push(regranter, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: w.len(wA) }], seen: s, at: AT(7) }))
    const E2 = w.rotate(wA, [G, wA, wX], { at: 8 })
    w.seal(wX, E2, groupPost({ text: 'p9', at: AT(9) }))
    const g = buildGroup(w.input(w.reader(wX)))
    const label = demoter === wC ? 'the re-grant sorts higher' : 'the demotion sorts higher'
    t.ok(g.admins.has(A), label + ': the re-grant counts')
    t.ok(texts(g).includes('p9'), label + ': A\'s epoch opens')
  }
})

test('reading: a planted grant dragged past a withdrawn root demotion never makes a member\'s key block distribute', (t) => {
  const w = pworld().add(C, wC)
  w.push(G, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(5) }))
  const demote = w.push(G, groupAdmin({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(6) }))
  // A forward ref to wX, which X then grows past the root demotion.
  const ahead = { writer: wX, seq: w.len(wX) + 1 }
  w.push(wC, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], seen: ahead, at: AT(7) }))
  w.seal(wX, w.E1, groupPost({ text: 'p8', seen: demote, at: AT(8) }))
  t.is(w.seal(wX, w.E1, groupPost({ text: 'p9', at: AT(9) })).seq, ahead.seq)
  // A leave on wC that does not list the root withdraws the root's records.
  w.push(wC, groupLeave({ cuts: [{ writer: wC, seq: w.len(wC) }], at: AT(10) }))
  const E2 = w.rotate(wX, [G, wA, wX], { at: 11 })
  w.seal(wX, E2, groupPost({ text: 'p12', at: AT(12) }))
  const g = buildGroup(w.input(w.reader(wA)))
  t.absent(g.admins.has(X))
  t.absent(texts(g).includes('p12'), 'X\'s key block opens nothing')
})
