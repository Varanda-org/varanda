'use strict'

// The sibling charter (docs/protocol.md, section 10, "Charter from the
// creator's other devices"): the creator's other bound writers write the
// group's charter (name, join, image, about, admin grants and demotions)
// like its root, and in a community its CWs grant and demote C admins, while
// the root holds its powers. Nobody else's charter off the root counts.
const test = require('brittle')
const {
  groupHeader, writerHeader, groupPost, groupBan, groupMeta, groupAdmin, groupLeave, groupImage, groupAbout,
  communityMetaCw, communityImageCw, communityAboutCw, communityGrant, communityDemote, communityBan,
  validateGroupRecord, buildGroup, buildCommunity
} = require('../lib/group')
const { K, AT, NOW, community, groupIn } = require('./helpers/groups')

const G = K(0x100)
const C = K(1)
const A = K(2)
const B = K(3)
const X = K(4)
const Y = K(5)
const wC = K(0x101)
const wC2 = K(0x102)
const wC3 = K(0x103)
const wA = K(0x200)
const wX = K(0x400)
const wY = K(0x500)
const CMG = K(0xc0)
const cwOf = (diary) => 'cc' + diary.slice(2)

const image = { core: K(900), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 100, sha256: K(901), width: 512, height: 512 }
const byWriter = (cuts) => cuts.sort((x, y) => x.writer.localeCompare(y.writer))
const refs = (g) => g.posts.map((p) => p.writer + ':' + p.seq)
const sorted = (set) => [...set].sort()

// A public group G of C inside the community CMG C created; each diary that
// writes in G gets a CW there (the creator's is CMG's root).
function world () {
  const parent = community({ key: CMG, creator: C, creates: [{ by: C, group: G }] })
  const g = groupIn(parent, { key: G, diary: C, name: 'Varanda' })
  const w = {
    C: parent,
    add (diary, key, { rejoin = null } = {}) {
      if (parent.cwOf(diary) === undefined) parent.addWriter(diary, cwOf(diary))
      g.add(diary, key, { rejoin })
      return w
    },
    push: g.push,
    len: g.len,
    logs: g.logs,
    // A diary cut, with the `at` its group-cut record carries.
    mark (diary, writer, cut, seq, at = AT(100)) {
      g.mark(diary, writer, cut, seq)
      const list = g.input().marks.get(diary)
      list[list.length - 1].at = at
      return w
    },
    input: () => g.input({ community: parent.input() })
  }
  return w
}

// A standalone group G of C: writers name G as their member.
function standalone () {
  const logs = new Map([[G, { key: G, diary: C, entries: [{ seq: 0, record: groupHeader({ diary: C, name: 'Varanda', at: AT(0) }) }] }]])
  const joins = new Map([[C, [{ writer: G, on: true, seq: 1 }]]])
  const w = {
    logs,
    add (diary, key, { rejoin = null } = {}) {
      logs.set(key, { key, diary, entries: [{ seq: 0, record: writerHeader({ group: G, diary, member: G, rejoin, at: AT(0) }) }] })
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
    input: () => ({ root: logs.get(G), writers: [...logs.values()].filter((l) => l.key !== G), joins, marks: new Map(), now: NOW })
  }
  return w
}

const post = (w, key, s, extra = {}) => w.push(key, groupPost({ text: 'p' + s, at: AT(s), ...extra }))
// The same blocks with `pick`ed ones turned into a type every reader drops,
// as older readers drop charter off the root.
const without = (input, pick) => {
  const strip = (l) => ({ ...l, entries: l.entries.map((e) => pick(l, e) ? { ...e, record: { type: 'group-future', at: e.record.at } } : e) })
  return { ...input, writers: input.writers.map(strip) }
}

test('checkRecord: charter off the root validates; a CW appointing in a group stays root-only', (t) => {
  t.is(validateGroupRecord(groupMeta({ name: 'Nova', join: 'open', at: AT(1) }), 1), null)
  t.is(validateGroupRecord(groupImage({ image, at: AT(1) }), 1), null)
  t.is(validateGroupRecord(groupAbout({ about: 'Rua', at: AT(1) }), 1), null)
  t.is(validateGroupRecord(groupAdmin({ member: A, on: true, at: AT(1) }), 1), null)
  const grant = communityGrant({ member: A, cuts: [{ writer: cwOf(A), seq: 1 }], at: AT(1) })
  t.alike(grant, { type: 'group-admin', group: null, member: A, on: true, cuts: [{ writer: cwOf(A), seq: 1 }], seen: null, at: AT(1) })
  t.is(validateGroupRecord(grant, 1, { community: true }), null, 'a CW grant of C')
  t.is(validateGroupRecord({ ...grant, group: G }, 1, { community: true }), 'root-only', 'a CW never appoints in a group')
  t.is(validateGroupRecord(groupMeta({ name: 'Nova', join: 'open', at: AT(1) }), 1, { community: true }), 'root-only', 'root shapes on a CW')
})

test('public group: the creator\'s second device renames, sets join, image and about, grants and demotes', (t) => {
  const w = world().add(C, wC).add(A, wA).add(X, wX).add(Y, wY)
  post(w, wX, 1)
  w.push(wC, groupMeta({ name: 'Nova', join: 'approval', at: AT(2) }))
  w.push(wC, groupImage({ image, at: AT(3) }))
  w.push(wC, groupAbout({ about: 'Rua de cima', at: AT(4) }))
  const grant = w.push(wC, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(5) }))
  let g = buildGroup(w.input())
  t.is(g.name, 'Nova')
  t.is(g.join, 'approval')
  t.alike(g.image, image)
  t.is(g.imageAuthor, C)
  t.is(g.about, 'Rua de cima')
  t.ok(g.admins.has(A), 'the sibling grant counts')
  const ban = w.push(wA, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], seen: grant, at: AT(6) }))
  g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned', 'the granted admin bans')
  w.push(wC, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], seen: ban, at: AT(7) }))
  g = buildGroup(w.input())
  t.absent(g.admins.has(A), 'the sibling demotion counts')
  t.is(g.members.get(X), 'banned', 'the ban before the demotion stands')
  w.push(wA, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], seen: g.last, at: AT(8) }))
  t.not(buildGroup(w.input()).members.get(Y), 'banned', 'a demoted admin bans nobody')
})

test('the latest charter in causal order wins across the root and a sibling', (t) => {
  const w = world().add(C, wC)
  const r1 = w.push(G, groupMeta({ name: 'Um', join: 'open', at: AT(1) }))
  const s2 = w.push(wC, groupMeta({ name: 'Dois', join: 'approval', seen: r1, at: AT(2) }))
  t.is(buildGroup(w.input()).name, 'Dois')
  w.push(G, groupMeta({ name: 'Tres', join: 'open', seen: s2, at: AT(0) }))
  const g = buildGroup(w.input())
  t.is(g.name, 'Tres', 'a later root meta wins whatever its clock')
  t.is(g.join, 'open')
})

test('an earlier sibling image or about never hides a later root one; a later sibling one replaces it', (t) => {
  const w = world().add(C, wC)
  const imgs = [1, 2, 3].map((start) => ({ ...image, start }))
  const s1 = post(w, wC, 1)
  w.push(wC, groupImage({ image: imgs[0], at: AT(1) }))
  w.push(wC, groupAbout({ about: 'um', at: AT(1) }))
  const r2 = post(w, G, 2, { seen: s1 })
  w.push(G, groupImage({ image: imgs[1], at: AT(2) }))
  const ra = w.push(G, groupAbout({ about: 'dois', at: AT(2) }))
  let g = buildGroup(w.input())
  t.alike(g.image, imgs[1], 'the later root image')
  t.is(g.about, 'dois', 'the later root about')
  post(w, wC, 3, { seen: r2 })
  // Naming the root's latest record (the writer contract).
  w.push(wC, groupImage({ image: imgs[2], seen: ra, at: AT(0) }))
  w.push(wC, groupAbout({ about: 'tres', seen: ra, at: AT(0) }))
  g = buildGroup(w.input())
  t.alike(g.image, imgs[2], 'the later sibling image')
  t.is(g.about, 'tres', 'the later sibling about')
})

test('a member\'s or admin\'s charter on its own writer changes nothing, nor the order', (t) => {
  const w = world().add(C, wC).add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  post(w, wX, 2)
  const m = w.push(wA, groupMeta({ name: 'Golpe', join: 'approval', at: AT(3) }))
  w.push(wX, groupMeta({ name: 'Outro', join: 'approval', at: AT(4) }))
  const a = w.push(wA, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 0 }], seen: m, at: AT(5) }))
  w.push(wA, groupImage({ image, at: AT(6) }))
  w.push(wA, groupAbout({ about: 'golpe', at: AT(6) }))
  post(w, wX, 7, { seen: a })
  post(w, G, 8, { seen: a })
  const g = buildGroup(w.input())
  t.is(g.name, 'Varanda')
  t.is(g.join, 'open')
  t.absent(g.admins.has(X))
  t.is(g.image, null)
  t.is(g.about, null)
  const foreign = (l, e) => l.diary !== C && ['group-meta', 'group-admin', 'group-image', 'group-about'].includes(e.record.type)
  const old = buildGroup(without(w.input(), foreign))
  t.alike(refs(g), refs(old), 'the post order is the one of a reader that drops them')
  t.alike(g.last, old.last, 'and so is last')
  t.alike(sorted(g.admins), sorted(old.admins))
})

test('sibling charter stops after a creator leave, a diary cut, or a root cut', (t) => {
  const base = () => {
    const w = world().add(C, wC).add(A, wA)
    const meta = w.push(wC, groupMeta({ name: 'Nova', join: 'approval', at: AT(2) }))
    w.push(wC, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], seen: meta, at: AT(3) }))
    return { w, meta }
  }
  let { w, meta } = base()
  t.is(buildGroup(w.input()).name, 'Nova', 'control')
  w.push(wC, groupLeave({ cuts: byWriter([{ writer: G, seq: w.len(G) }, { writer: wC, seq: w.len(wC) }]), at: AT(4) }))
  let g = buildGroup(w.input())
  t.is(g.name, 'Varanda', 'the leave ends the sibling meta below it')
  t.absent(g.admins.has(A), 'and the sibling grant')
  ;({ w, meta } = base())
  w.mark(C, wC, meta.seq)
  g = buildGroup(w.input())
  t.is(g.name, 'Varanda', 'a diary cut at the meta')
  t.absent(g.admins.has(A))
  ;({ w, meta } = base())
  w.mark(C, wC, meta.seq + 1)
  g = buildGroup(w.input())
  t.is(g.name, 'Nova', 'a diary cut above the meta keeps it')
  t.absent(g.admins.has(A), 'and voids the grant at the cut')
  ;({ w } = base())
  w.mark(C, G, 1)
  g = buildGroup(w.input())
  t.is(g.rootCut, 1)
  t.is(g.name, 'Varanda', 'a root cut ends the sibling charter')
  t.absent(g.admins.has(A))
})

test('a writer from before a leave that appends after the rejoin gains no charter', (t) => {
  const w = world().add(C, wC).add(C, wC2)
  const L = w.push(wC, groupLeave({ cuts: byWriter([{ writer: G, seq: w.len(G) }, { writer: wC, seq: w.len(wC) }]), at: AT(1) }))
  w.add(C, wC3, { rejoin: L })
  const r = post(w, wC3, 2)
  w.push(wC2, groupMeta({ name: 'Velho', join: 'approval', seen: r, at: AT(3) }))
  t.is(buildGroup(w.input()).name, 'Varanda', 'the old writer')
  const g0 = buildGroup(w.input())
  w.push(wC3, groupMeta({ name: 'Novo', join: 'approval', seen: g0.last, at: AT(4) }))
  t.is(buildGroup(w.input()).name, 'Novo', 'the writer of the rejoin')
})

test('charterWriters: the root and the live creator writers', (t) => {
  const w = world().add(C, wC).add(A, wA)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  let g = buildGroup(w.input())
  t.alike(sorted(g.charterWriters), sorted([G, wC]))
  w.mark(C, wC, 1)
  g = buildGroup(w.input())
  t.alike(sorted(g.charterWriters), [G], 'a cut sibling writes no charter')
  w.mark(C, G, 1)
  t.alike(sorted(buildGroup(w.input()).charterWriters), [], 'nor a cut root')
})

test('standalone group: sibling charter, rejoin generations and a leave that does not list the root', (t) => {
  let w = standalone().add(C, wC).add(A, wA)
  w.push(wC, groupMeta({ name: 'Irma', join: 'approval', at: AT(1) }))
  w.push(wC, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(2) }))
  let g = buildGroup(w.input())
  t.is(g.name, 'Irma')
  t.ok(g.admins.has(A))
  t.alike(sorted(g.charterWriters), sorted([G, wC]))

  w = standalone().add(C, wC).add(C, wC2)
  const L = w.push(wC, groupLeave({ cuts: byWriter([{ writer: G, seq: w.len(G) }, { writer: wC, seq: w.len(wC) }]), at: AT(1) }))
  w.add(C, wC3, { rejoin: L })
  const r = post(w, wC3, 2)
  w.push(wC2, groupMeta({ name: 'Velho', join: 'approval', seen: r, at: AT(3) }))
  t.is(buildGroup(w.input()).name, 'Varanda', 'an old writer after the rejoin')
  w.push(wC3, groupMeta({ name: 'Novo', join: 'approval', seen: buildGroup(w.input()).last, at: AT(4) }))
  t.is(buildGroup(w.input()).name, 'Novo')

  w = standalone().add(C, wC).add(C, wC2)
  const root = w.push(G, groupMeta({ name: 'Raiz', join: 'approval', at: AT(1) }))
  w.push(wC, groupAbout({ about: 'irma', at: AT(2) }))
  w.push(wC, groupMeta({ name: 'Irma', join: 'approval', seen: root, at: AT(2) }))
  t.is(buildGroup(w.input()).name, 'Irma')
  w.push(wC2, groupLeave({ cuts: [{ writer: wC2, seq: w.len(wC2) }], at: AT(3) }))
  g = buildGroup(w.input())
  t.is(g.name, 'Varanda', 'a leave not listing the root ends the root and sibling charter')
  t.is(g.join, 'open')
  t.is(g.about, null)
})

const Z = K(0x9)
const cwA = K(0x20)
const cwB = K(0x30)
const cwX = K(0x40)
const cwZ2 = K(0x92)
const cwZ3 = K(0x93)
const cwZ4 = K(0x94)
const comm = (C) => buildCommunity(C.input())

test('community: a creator CW renames, sets join, image and about, grants and demotes while the root holds', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }] })
  C.addWriter(Z, cwZ2)
  C.push(cwZ2, communityMetaCw({ name: 'Praca', join: 'approval', at: AT(40) }))
  C.push(cwZ2, communityImageCw({ image, at: AT(41) }))
  C.push(cwZ2, communityAboutCw({ about: 'Praca central', at: AT(42) }))
  const grant = C.push(cwZ2, communityGrant({ member: A, cuts: [{ writer: cwA, seq: 1 }], at: AT(43) }))
  let c = comm(C)
  t.is(c.rootAuthority, true)
  t.is(c.name, 'Praca')
  t.is(c.join, 'approval')
  t.alike(c.image, image)
  t.is(c.about, 'Praca central')
  t.ok(c.admins.has(A), 'the CW grant counts')
  t.alike(sorted(c.charterWriters), sorted([C.key, cwZ2]))
  const ban = C.push(cwA, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: C.len(cwX) }], seen: grant, at: AT(44) }))
  t.is(comm(C).members.get(X), 'banned', 'the granted admin bans')
  C.push(cwZ2, communityDemote({ member: A, cuts: [{ writer: cwA, seq: C.len(cwA) }], seen: ban, at: AT(45) }))
  c = comm(C)
  t.absent(c.admins.has(A), 'the CW demotion')
  t.is(c.members.get(X), 'banned')
})

test('community: another diary\'s CW grant counts nothing and leaves the order alone', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }], admins: [A] })
  const grant = C.push(cwA, communityGrant({ member: B, cuts: [{ writer: cwB, seq: 1 }], at: AT(40) }))
  C.push(cwB, communityBan({ member: K(0xabc), on: true, cuts: [], seen: grant, at: AT(41) }))
  C.push(cwA, communityMetaCw({ name: 'Golpe', join: 'approval', at: AT(42) }))
  const c = comm(C)
  t.absent(c.admins.has(B))
  t.is(c.name, 'Bairro')
  const old = buildCommunity(without(C.input(), (l, e) => l.diary !== Z && e.record.type === 'group-admin' && e.record.on === true))
  t.alike(c.last, old.last, 'the order of a reader that drops the grant')
  t.alike(sorted(c.admins), sorted(old.admins))
})

test('community: sibling charter stops after a creator leave, on a retired CW and from an old generation', (t) => {
  let C = community({ creator: Z, members: [{ diary: B, cw: cwB, status: 'member' }] })
  C.addWriter(Z, cwZ2)
  C.push(cwZ2, communityGrant({ member: B, cuts: [{ writer: cwB, seq: 1 }], at: AT(40) }))
  t.ok(comm(C).admins.has(B), 'control')
  C.push(cwZ2, groupLeave({ cuts: [{ writer: cwZ2, seq: C.len(cwZ2) }], at: AT(41) }))
  C.confirm(Z, cwZ2)
  let c = comm(C)
  t.is(c.rootAuthority, true, 'the leave does not touch the root')
  t.absent(c.admins.has(B), 'the grant does not outlive the leave')

  C = community({ creator: Z, members: [{ diary: B, cw: cwB, status: 'member' }] })
  C.addWriter(Z, cwZ2)
  C.addWriter(Z, cwZ4)
  const L = C.push(cwZ4, groupLeave({ cuts: byWriter([{ writer: cwZ2, seq: C.len(cwZ2) }, { writer: cwZ4, seq: C.len(cwZ4) }]), at: AT(40) }))
  C.confirm(Z, cwZ4)
  C.addWriter(Z, cwZ3, { rejoin: L })
  c = comm(C)
  C.push(cwZ2, communityGrant({ member: B, cuts: [{ writer: cwB, seq: 1 }], seen: c.last, at: AT(50) }))
  t.absent(comm(C).admins.has(B), 'a retired CW of the old generation')
  C.push(cwZ3, communityGrant({ member: B, cuts: [{ writer: cwB, seq: 1 }], seen: comm(C).last, at: AT(51) }))
  c = comm(C)
  t.ok(c.admins.has(B), 'the CW of the rejoin')
  t.alike(sorted(c.charterWriters), [cwZ3], 'only live writers: the root of the generation before the leave is not one')
})

test('community: once the root\'s powers end, only repairs count', (t) => {
  const C = community({ creator: Z, members: [{ diary: B, cw: cwB, status: 'member' }] })
  const L = C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(40) }))
  C.addWriter(Z, cwZ3, { rejoin: L })
  let c = comm(C)
  t.is(c.cwDemote, true, 'the gate is set')
  C.push(cwZ3, communityGrant({ member: B, cuts: [{ writer: cwB, seq: 1 }], seen: c.last, at: AT(50) }))
  C.push(cwZ3, communityMetaCw({ name: 'Reparo', join: 'approval', seen: c.last, at: AT(51) }))
  c = comm(C)
  t.absent(c.admins.has(B), 'no grant past the gate')
  t.is(c.name, 'Reparo', 'the repair counts')
  t.is(c.join, 'approval')
  t.alike(sorted(c.charterWriters), [], 'nobody writes charter')
})

test('a second device with only its header sets the image and about through its seen', (t) => {
  const imgs = [1, 2, 3].map((start) => ({ ...image, start }))
  const w = world().add(C, wC)
  post(w, G, 1)
  w.push(G, groupImage({ image: imgs[0], at: AT(2) }))
  const about = w.push(G, groupAbout({ about: 'raiz', at: AT(3) }))
  const seen = { writer: G, seq: about.seq }
  const si = w.push(wC, groupImage({ image: imgs[1], seen, at: AT(4) }))
  const sa = w.push(wC, groupAbout({ about: 'irma', seen, at: AT(4) }))
  let g = buildGroup(w.input())
  t.alike(g.image, imgs[1], 'the sibling image follows the root image it saw')
  t.is(g.about, 'irma')
  w.push(G, groupImage({ image: imgs[2], seen: si, at: AT(0) }))
  w.push(G, groupAbout({ about: 'raiz de novo', seen: sa, at: AT(0) }))
  g = buildGroup(w.input())
  t.alike(g.image, imgs[2], 'a later root image wins back')
  t.is(g.about, 'raiz de novo')

  for (const bad of [{ writer: G, seq: 99 }, { writer: K(0x777), seq: 1 }]) {
    const v = world().add(C, wC)
    post(v, G, 1)
    v.push(G, groupImage({ image: imgs[0], at: AT(2) }))
    v.push(wC, groupImage({ image: imgs[1], seen: bad, at: AT(4) }))
    t.alike(buildGroup(v.input()).image, imgs[0], 'a seen that does not resolve keeps the own-writer anchor')
  }
})

test('community: a creator CW with only its header sets the image and about through its seen', (t) => {
  const imgs = [1, 2, 3].map((start) => ({ ...image, start }))
  const C = community({ creator: Z })
  C.addWriter(Z, cwZ2)
  C.push(C.key, groupMeta({ name: 'Bairro', join: 'open', at: AT(1) }))
  C.push(C.key, groupImage({ image: imgs[0], at: AT(2) }))
  const about = C.push(C.key, groupAbout({ about: 'raiz', at: AT(3) }))
  const seen = { writer: C.key, seq: about.seq }
  const si = C.push(cwZ2, communityImageCw({ image: imgs[1], seen, at: AT(4) }))
  const sa = C.push(cwZ2, communityAboutCw({ about: 'irma', seen, at: AT(4) }))
  let c = comm(C)
  t.alike(c.image, imgs[1])
  t.is(c.about, 'irma')
  C.push(C.key, groupImage({ image: imgs[2], seen: si, at: AT(0) }))
  C.push(C.key, groupAbout({ about: 'raiz de novo', seen: sa, at: AT(0) }))
  c = comm(C)
  t.alike(c.image, imgs[2], 'a later root image wins back')
  t.is(c.about, 'raiz de novo')
  const v = community({ creator: Z })
  v.addWriter(Z, cwZ2)
  v.push(v.key, groupMeta({ name: 'Bairro', join: 'open', at: AT(1) }))
  v.push(v.key, groupAbout({ about: 'raiz', at: AT(2) }))
  v.push(cwZ2, communityAboutCw({ about: 'irma', seen: { writer: v.key, seq: 99 }, at: AT(4) }))
  t.is(comm(v).about, 'raiz', 'a seen that does not resolve keeps the own-writer anchor')
})

test('a third device replaces the second one\'s image by naming it; the root wins back', (t) => {
  const imgs = [1, 2, 3, 4].map((start) => ({ ...image, start }))
  const w = world().add(C, wC).add(C, wC2)
  post(w, G, 1)
  const r = w.push(G, groupImage({ image: imgs[0], at: AT(2) }))
  const two = w.push(wC, groupImage({ image: imgs[1], seen: r, at: AT(3) }))
  t.alike(buildGroup(w.input()).image, imgs[1], 'device 2')
  const three = w.push(wC2, groupImage({ image: imgs[2], seen: two, at: AT(0) }))
  t.alike(buildGroup(w.input()).image, imgs[2], 'device 3 names device 2\'s image and wins')
  w.push(G, groupImage({ image: imgs[3], seen: three, at: AT(0) }))
  t.alike(buildGroup(w.input()).image, imgs[3], 'a later root image wins back')
})

test('contract: a sibling names the root\'s latest record, not the fold\'s last node', (t) => {
  const make = (pick) => {
    const w = world().add(C, wC)
    w.push(G, groupMeta({ name: 'Varanda', join: 'open', at: AT(1) }))
    const about = w.push(G, groupAbout({ about: 'raiz', at: AT(2) }))
    const g = buildGroup(w.input())
    w.push(wC, groupAbout({ about: 'irma', seen: pick(g, about), at: AT(3) }))
    return { g, after: buildGroup(w.input()) }
  }
  const viaLast = make((g) => g.last)
  t.alike(viaLast.g.last, { writer: G, seq: 1 }, 'last is the root meta')
  t.is(viaLast.after.about, 'raiz', 'naming last sorts before the root about at seq 2')
  t.is(make((g, about) => about).after.about, 'irma', 'naming the root\'s latest record wins')
})

test('a ref cycle or a ref past the held length falls back to the anchor', (t) => {
  const imgs = [1, 2, 3].map((start) => ({ ...image, start }))
  let w = world().add(C, wC).add(C, wC2)
  post(w, G, 1)
  w.push(G, groupImage({ image: imgs[0], at: AT(2) }))
  w.push(wC, groupImage({ image: imgs[1], seen: { writer: wC2, seq: 1 }, at: AT(3) }))
  w.push(wC2, groupImage({ image: imgs[2], seen: { writer: wC, seq: 1 }, at: AT(3) }))
  t.alike(buildGroup(w.input()).image, imgs[0], 'a two-record cycle')
  w = world().add(C, wC)
  post(w, G, 1)
  w.push(G, groupImage({ image: imgs[0], at: AT(2) }))
  w.push(wC, groupImage({ image: imgs[1], seen: { writer: wC, seq: 5 }, at: AT(3) }))
  t.alike(buildGroup(w.input()).image, imgs[0], 'a ref past the held length')
})

test('community: a third creator CW replaces the second one\'s about by naming it', (t) => {
  const C = community({ creator: Z })
  C.addWriter(Z, cwZ2)
  C.addWriter(Z, cwZ4)
  C.push(C.key, groupMeta({ name: 'Bairro', join: 'open', at: AT(1) }))
  const r = C.push(C.key, groupAbout({ about: 'raiz', at: AT(2) }))
  const two = C.push(cwZ2, communityAboutCw({ about: 'dois', seen: r, at: AT(3) }))
  t.is(comm(C).about, 'dois')
  const three = C.push(cwZ4, communityAboutCw({ about: 'tres', seen: two, at: AT(0) }))
  t.is(comm(C).about, 'tres', 'the third CW names the second one\'s about')
  C.push(C.key, groupAbout({ about: 'raiz de novo', seen: three, at: AT(0) }))
  t.is(comm(C).about, 'raiz de novo', 'a later root about wins back')
})

// The rank (docs/protocol.md, "Charter from the creator's other devices"):
// a sibling record ranks by what its `seen` names, never by its own causal
// position, and a diary cut bounds what it may name.
const wB = K(0x300)
// A diary cut with the `at` its group-cut record carries, in a community.
const markAt = (Cm, diary, writer, cut, at) => {
  Cm.mark(diary, writer, cut)
  const list = Cm.input().marks.get(diary)
  list[list.length - 1].at = at
}

test('a stolen sibling key: after the diary cut and a root repair, growing a member writer moves nothing', (t) => {
  const w = world().add(C, wC2).add(X, wX).add(Y, wY)
  post(w, wX, 1)
  // The thief holds wC2 and wX: its charter names wX's next seq.
  const future = { writer: wX, seq: w.len(wX) }
  w.push(wC2, groupMeta({ name: 'Golpe', join: 'approval', seen: future, at: AT(2) }))
  w.push(wC2, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], seen: future, at: AT(3) }))
  w.push(wC2, groupAbout({ about: 'golpe', seen: future, at: AT(4) }))
  w.mark(C, wC2, w.len(wC2), undefined, AT(5))
  const meta = w.push(G, groupMeta({ name: 'Reparo', join: 'open', at: AT(6) }))
  w.push(G, groupAdmin({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], seen: meta, at: AT(7) }))
  const about = w.push(G, groupAbout({ about: 'reparo', at: AT(8) }))
  const check = (label) => {
    const g = buildGroup(w.input())
    t.is(g.name, 'Reparo', label + ': the root name')
    t.is(g.join, 'open', label + ': the root join')
    t.absent(g.admins.has(X), label + ': the root demotion')
    t.is(g.about, 'reparo', label + ': the root about')
    return g
  }
  check('before the growth')
  w.push(wX, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], seen: about, at: AT(9) }))
  const g = check('after the growth')
  t.not(g.members.get(Y), 'banned', 'the thief\'s ban counts nothing')
})

test('community: a stolen creator CW: after the diary cut and a root repair, growing a member CW moves nothing', (t) => {
  const Cm = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }, { diary: B, cw: cwB, status: 'member' }] })
  Cm.addWriter(Z, cwZ2)
  const future = { writer: cwX, seq: Cm.len(cwX) }
  Cm.push(cwZ2, communityMetaCw({ name: 'Golpe', join: 'approval', seen: future, at: AT(40) }))
  Cm.push(cwZ2, communityGrant({ member: X, cuts: [{ writer: cwX, seq: 1 }], seen: future, at: AT(41) }))
  Cm.push(cwZ2, communityAboutCw({ about: 'golpe', seen: future, at: AT(42) }))
  markAt(Cm, Z, cwZ2, Cm.len(cwZ2), AT(43))
  const meta = Cm.push(Cm.key, groupMeta({ name: 'Reparo', join: 'open', at: AT(44) }))
  Cm.push(Cm.key, groupAdmin({ member: X, on: false, cuts: [{ writer: cwX, seq: Cm.len(cwX) }], seen: meta, at: AT(45) }))
  const about = Cm.push(Cm.key, groupAbout({ about: 'reparo', at: AT(46) }))
  const check = (label) => {
    const c = comm(Cm)
    t.is(c.name, 'Reparo', label + ': the root name')
    t.is(c.join, 'open', label + ': the root join')
    t.absent(c.admins.has(X), label + ': the root demotion')
    t.is(c.about, 'reparo', label + ': the root about')
    return c
  }
  check('before the growth')
  Cm.push(cwX, communityBan({ member: B, on: true, cuts: [{ writer: cwB, seq: Cm.len(cwB) }], seen: about, at: AT(47) }))
  const c = check('after the growth')
  t.not(c.members.get(B), 'banned', 'the thief\'s ban counts nothing')
})

test('a sibling record naming a root seq the root reaches only after the diary cut is void', (t) => {
  const make = (cut) => {
    const w = world().add(C, wC2).add(A, wA)
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
    const future = { writer: G, seq: w.len(G) + 2 }
    w.push(wC2, groupMeta({ name: 'Golpe', join: 'approval', seen: future, at: AT(2) }))
    w.push(wC2, groupAdmin({ member: A, on: false, cuts: [], seen: future, at: AT(3) }))
    if (cut) w.mark(C, wC2, w.len(wC2), undefined, AT(4))
    w.push(G, groupMeta({ name: 'Reparo', join: 'open', at: AT(5) }))
    post(w, G, 6)
    t.is(post(w, G, 7).seq, future.seq)
    return buildGroup(w.input())
  }
  const g = make(true)
  t.is(g.name, 'Reparo', 'the planted meta is void')
  t.is(g.join, 'open')
  t.ok(g.admins.has(A), 'and so is the planted demotion')
  const control = make(false)
  t.is(control.name, 'Golpe', 'with no cut it ranks after the root record it names')
  t.absent(control.admins.has(A))
})

test('a sibling grant naming a member\'s record never outlives a later root demotion', (t) => {
  const w = world().add(C, wC).add(A, wA).add(B, wB).add(Y, wY)
  post(w, wA, 1)
  const m1 = post(w, wB, 2, { seen: { writer: wA, seq: 3 } })
  w.push(wC, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], seen: m1, at: AT(3) }))
  t.ok(buildGroup(w.input()).admins.has(A), 'the grant counts until a demotion outranks it')
  const demote = w.push(G, groupAdmin({ member: A, on: false, cuts: [], at: AT(4) }))
  post(w, wA, 5)
  // A's wA:3 names the demotion: m1, and the grant after it, now sort after
  // the demotion in causal order.
  t.is(post(w, wA, 6, { seen: demote }).seq, 3)
  w.push(wA, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], seen: demote, at: AT(7) }))
  const g = buildGroup(w.input())
  t.absent(g.admins.has(A), 'the root demotion holds')
  t.not(g.members.get(Y), 'banned', 'a ban written after it counts nothing')
})

test('a retirement cut keeps the old device\'s rename; a rename its clock puts after the cut is void', (t) => {
  let w = world().add(C, wC)
  let root = w.push(G, groupMeta({ name: 'Raiz', join: 'open', at: AT(1) }))
  w.push(wC, groupMeta({ name: 'Nova', join: 'approval', seen: root, at: AT(2) }))
  w.add(C, wC2)
  w.mark(C, wC, w.len(wC), undefined, AT(50))
  let g = buildGroup(w.input())
  t.is(g.name, 'Nova', 'the reinstall keeps the old device\'s rename')
  t.is(g.join, 'approval')

  w = world().add(C, wC)
  root = w.push(G, groupMeta({ name: 'Raiz', join: 'open', at: AT(1) }))
  w.push(wC, groupMeta({ name: 'Tarde', join: 'approval', seen: root, at: AT(60) }))
  w.mark(C, wC, w.len(wC), undefined, AT(50))
  g = buildGroup(w.input())
  t.is(g.name, 'Raiz', 'below the cut by seq, after it by its clock')
})

test('with the root device lost, device 3 demotes the admin device 2 granted, naming that grant', (t) => {
  const w = world().add(C, wC).add(C, wC2).add(A, wA).add(X, wX).add(Y, wY)
  const r = post(w, G, 1)
  const grant = w.push(wC, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], seen: r, at: AT(2) }))
  w.push(wA, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], seen: grant, at: AT(3) }))
  const demote = w.push(wC2, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], seen: grant, at: AT(4) }))
  w.push(wA, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], seen: demote, at: AT(5) }))
  const g = buildGroup(w.input())
  t.absent(g.admins.has(A), 'the demotion ranks above the grant it names')
  t.is(g.members.get(X), 'banned', 'a ban between the grant and the demotion counts')
  t.not(g.members.get(Y), 'banned', 'none after the demotion')
})

// A record that does not count voids itself, never another writer's record
// that names it: an honest repair naming a stolen key's records keeps its
// rank once the diary cut voids them.
test('a repair naming a stolen key\'s records holds after the diary cut voids them', (t) => {
  const w = world().add(C, wC).add(C, wC2).add(X, wX).add(Y, wY)
  w.push(G, groupMeta({ name: 'Raiz', join: 'open', at: AT(1) }))
  w.push(G, groupAbout({ about: 'raiz', at: AT(2) }))
  const root = w.push(G, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(3) }))
  // The thief holds wC; its records carry an `at` past any cut.
  const meta = w.push(wC, groupMeta({ name: 'Golpe', join: 'open', seen: root, at: AT(90) }))
  const about = w.push(wC, groupAbout({ about: 'golpe', seen: root, at: AT(91) }))
  const grant = w.push(wC, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], seen: root, at: AT(92) }))
  // The creator repairs from wC2, naming the current winners.
  w.push(wC2, groupMeta({ name: 'Reparo', join: 'approval', seen: meta, at: AT(10) }))
  w.push(wC2, groupAbout({ about: 'reparo', seen: about, at: AT(11) }))
  const demote = w.push(wC2, groupAdmin({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], seen: grant, at: AT(12) }))
  w.mark(C, wC, w.len(wC), undefined, AT(50))
  w.push(wX, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], seen: demote, at: AT(13) }))
  const g = buildGroup(w.input())
  t.is(g.name, 'Reparo', 'the repair name holds')
  t.is(g.join, 'approval')
  t.is(g.about, 'reparo')
  t.absent(g.admins.has(X), 'the old root grant does not come back')
  t.not(g.members.get(Y), 'banned', 'so X bans nobody')
})

test('community: a repair from a creator CW naming a stolen CW\'s records holds after the diary cut', (t) => {
  const Cm = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }, { diary: B, cw: cwB, status: 'member' }] })
  Cm.addWriter(Z, cwZ2)
  Cm.addWriter(Z, cwZ4)
  Cm.push(Cm.key, groupMeta({ name: 'Raiz', join: 'open', at: AT(1) }))
  Cm.push(Cm.key, groupAbout({ about: 'raiz', at: AT(2) }))
  const root = Cm.push(Cm.key, groupAdmin({ member: X, on: true, cuts: [{ writer: cwX, seq: Cm.len(cwX) }], at: AT(3) }))
  const meta = Cm.push(cwZ2, communityMetaCw({ name: 'Golpe', join: 'open', seen: root, at: AT(90) }))
  const about = Cm.push(cwZ2, communityAboutCw({ about: 'golpe', seen: root, at: AT(91) }))
  const grant = Cm.push(cwZ2, communityGrant({ member: X, cuts: [{ writer: cwX, seq: Cm.len(cwX) }], seen: root, at: AT(92) }))
  Cm.push(cwZ4, communityMetaCw({ name: 'Reparo', join: 'approval', seen: meta, at: AT(10) }))
  Cm.push(cwZ4, communityAboutCw({ about: 'reparo', seen: about, at: AT(11) }))
  const demote = Cm.push(cwZ4, communityDemote({ member: X, cuts: [{ writer: cwX, seq: Cm.len(cwX) }], seen: grant, at: AT(12) }))
  markAt(Cm, Z, cwZ2, Cm.len(cwZ2), AT(50))
  Cm.push(cwX, communityBan({ member: B, on: true, cuts: [{ writer: cwB, seq: Cm.len(cwB) }], seen: demote, at: AT(13) }))
  const c = comm(Cm)
  t.is(c.name, 'Reparo', 'the repair name holds')
  t.is(c.join, 'approval')
  t.is(c.about, 'reparo')
  t.absent(c.admins.has(X), 'the old root grant does not come back')
  t.not(c.members.get(B), 'banned', 'so X bans nobody')
})

test('a planted floor grant on the cut writer never beats the repair demotion, whatever the key order', (t) => {
  for (const [thief, honest] of [[wC, wC2], [wC2, wC]]) {
    const w = world().add(C, wC).add(C, wC2).add(X, wX).add(Y, wY)
    const root = post(w, G, 1)
    // Below the cut by its clock, ranked at the floor.
    w.push(thief, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(2) }))
    const grant = w.push(thief, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], seen: root, at: AT(90) }))
    const demote = w.push(honest, groupAdmin({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], seen: grant, at: AT(10) }))
    w.mark(C, thief, w.len(thief), undefined, AT(50))
    w.push(wX, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], seen: demote, at: AT(11) }))
    const g = buildGroup(w.input())
    t.absent(g.admins.has(X), 'thief on ' + (thief === wC ? 'wC' : 'wC2') + ': the demotion holds')
    t.not(g.members.get(Y), 'banned')
  }
})

test('no attacker: a record naming one that a fast clock voids at the retirement cut keeps its rank', (t) => {
  const w = world().add(C, wC).add(C, wC2)
  const root = w.push(G, groupMeta({ name: 'Raiz', join: 'open', at: AT(1) }))
  const fast = w.push(wC, groupMeta({ name: 'Nova', join: 'approval', seen: root, at: AT(60) }))
  w.push(wC2, groupMeta({ name: 'Nova 2', join: 'approval', seen: fast, at: AT(20) }))
  w.mark(C, wC, w.len(wC), undefined, AT(50))
  const g = buildGroup(w.input())
  t.is(g.name, 'Nova 2', 'the second device\'s rename outranks the root one it follows')
  t.is(g.join, 'approval')
})

test('a record naming a void one still floors when the root record at its end came after it', (t) => {
  const make = (at) => {
    const w = world().add(C, wC).add(C, wC2)
    post(w, G, 1)
    const future = { writer: G, seq: w.len(G) + 1 }
    const meta = w.push(wC, groupMeta({ name: 'Golpe', join: 'approval', seen: future, at: AT(90) }))
    w.push(wC2, groupMeta({ name: 'Reparo', join: 'approval', seen: meta, at }))
    w.mark(C, wC, w.len(wC), undefined, AT(50))
    w.push(G, groupMeta({ name: 'Raiz', join: 'open', at: AT(20) }))
    t.is(post(w, G, 30).seq, future.seq)
    return buildGroup(w.input())
  }
  const early = make(AT(10))
  t.is(early.name, 'Raiz', 'written before the root record the void one names: the floor')
  t.is(early.join, 'open')
  t.is(make(AT(40)).name, 'Reparo', 'written after it: the rank the chain gives')
})
