'use strict'

// Private groups (docs/protocol.md, "Private groups"): sealed records, epoch
// keys, distributors, eligibility and rekey-pending in buildGroup.
const test = require('brittle')
const b4a = require('b4a')
const {
  MAX_KEY_RECIPIENTS, MAX_KEY_BASIS,
  validateGroupRecord, validateWriterHeader, validateGroupHeader, isWeakBoxKey,
  groupHeader, writerHeader, groupPost, groupHide, groupMeta, groupAdmit, groupBan, groupAdmin, groupLeave,
  groupKey, groupSealed, sealedInner, communityAdmit, communityBan, buildGroup, buildCommunity, groupInvites, communityInvites
} = require('../lib/group')
const { community } = require('./helpers/groups')
const { newBoxKeyPair, newEpochKey, sealEpochKey, openFrom, sealRecord, keyTag, keyCommit } = require('../lib/group-crypto')

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
const wA = K(0x200)
const wB = K(0x300)
const wX = K(0x400)
const wX2 = K(0x401)
const wY = K(0x500)
const wZ = K(0x700)
const CM = K(0x900)
// The CW of a diary in CM, and a second one for a rejoin.
const cwKey = (d) => 'c' + d.slice(1)
const cwX2 = 'd' + X.slice(1)

const hex = (b) => b4a.toString(b, 'hex')
const cm = (key, kid) => hex(keyCommit(key, G, kid))

// A private group inside the open community CM: C creates G; A is a group
// admin, X and Y are admitted. The root then opens epoch E1 for every
// writer and seals the name. `cc` is the creator of CM (C by default, whose
// CW is then CM itself) and `cadmins` are granted in CM's root; every diary
// that gets a G writer joins CM with a CW of its own first. Only CM's
// creator creates groups (in CM's root), so with `cc` other than C the
// header of C names no group of CM: G is an orphan.
function pworld ({ base = true, cc = C, cadmins = [] } = {}) {
  const granted = [...new Set([C, ...cadmins])].filter((d) => d !== cc)
  const comm = community({
    key: CM,
    creator: cc,
    members: granted.map((d) => ({ diary: d, cw: cwKey(d), status: 'member' })),
    admins: granted,
    creates: [{ by: C, group: G }]
  })
  const boxes = new Map([[G, newBoxKeyPair()]])
  const logs = new Map([[G, { key: G, diary: C, entries: [{ seq: 0, record: groupHeader({ diary: C, community: CM, member: comm.cwOf(C), visibility: 'private', join: 'approval', box: hex(boxes.get(G).publicKey), at: AT(0) }) }] }]])
  const joins = new Map([[C, [{ writer: G, on: true, seq: 1 }]]])
  const epochs = new Map()
  const w = {
    logs,
    joins,
    boxes,
    epochs,
    comm,
    cwOf: (d) => comm.cwOf(d),
    add (diary, key, { box = true, rejoin = null, at = 0, cw = null } = {}) {
      if (!comm.cwOf(diary)) comm.addWriter(diary, cwKey(diary))
      if (box) boxes.set(key, newBoxKeyPair())
      logs.set(key, { key, diary, entries: [{ seq: 0, record: writerHeader({ group: G, diary, member: cw || comm.cwOf(diary), box: box ? hex(boxes.get(key).publicKey) : null, rejoin, at: AT(at) }) }] })
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
    entry (writer, kid, key, group = G) {
      return { writer, sealed: b4a.toString(sealEpochKey(key, group, kid, boxes.get(writer).publicKey), 'base64') }
    },
    // A first block on `by`: a fresh key sealed to `to`.
    rotate (by, to, { basis = [], auth = null, at }) {
      const kid = { writer: by, seq: w.len(by) }
      const key = newEpochKey()
      epochs.set(kid.writer + ':' + kid.seq, key)
      w.push(by, groupKey({ kid: null, basis, keys: to.map((x) => w.entry(x, kid, key)), auth, commit: cm(key, kid), at: AT(at) }))
      return kid
    },
    // A root group-admin of CM for diary d, cut by default at its CW's
    // current length.
    cgrant (d, on, { cuts = null, at }) {
      if (!comm.cwOf(d)) comm.addWriter(d, cwKey(d))
      return comm.push(CM, groupAdmin({ member: d, on, cuts: cuts || [{ writer: comm.cwOf(d), seq: comm.len(comm.cwOf(d)) }], at: AT(at) }))
    },
    // A leave of d's CW in CM.
    // An honest leave: the leave plus the diary turning that CW off.
    cleave (d, at) {
      const cw = comm.cwOf(d)
      const ref = comm.push(cw, groupLeave({ cuts: [{ writer: cw, seq: comm.len(cw) }], at: AT(at) }))
      comm.confirm(d, cw)
      return ref
    },
    // The `auth` a node writes: its own CW at its current length.
    cauth: (d) => ({ writer: comm.cwOf(d), seq: comm.len(comm.cwOf(d)) }),
    keyOf (kid) {
      return epochs.get(kid.writer + ':' + kid.seq)
    },
    seal (writer, kid, record, key = w.keyOf(kid)) {
      const { nonce, box } = sealRecord(sealedInner(record, { writer, group: G, kid }), key)
      return w.push(writer, groupSealed({ kid, nonce, box, at: record.at }))
    },
    reader (...writers) {
      const pair = boxes.get(writers[0])
      return {
        writers: new Set(writers),
        unseal: (sealed) => openFrom(b4a.from(sealed, 'base64'), pair)
      }
    },
    input (keys = null, extra = {}) {
      const writers = [...logs.values()].filter((l) => l.key !== G)
      return { root: logs.get(G), writers, joins, community: comm.input(), keys, now: NOW, ...extra }
    }
  }
  if (base) {
    w.add(A, wA).add(X, wX).add(Y, wY)
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
    w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
    w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(3) }))
    w.E1 = w.rotate(G, [G, wA, wX, wY], { at: 4 })
    w.seal(G, w.E1, groupMeta({ name: 'Segredo', join: 'approval', at: AT(5) }))
  }
  return w
}

const sealedPost = (w, writer, kid, s) => w.seal(writer, kid, groupPost({ text: 'p' + s, at: AT(s) }))
const visible = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.writer + ':' + p.seq)
const kidOf = (r) => r === null ? null : r.writer + ':' + r.seq

function normalize (g) {
  return JSON.stringify(g, (k, v) => v instanceof Set ? [...v].sort() : v instanceof Map ? [...v].sort((a, b) => a[0] < b[0] ? -1 : 1) : v)
}

// Every Uint8Array reachable from a value (Sets and Maps included).
function bytesIn (value) {
  const found = []
  const stack = [value]
  const seen = new Set()
  while (stack.length > 0) {
    const v = stack.pop()
    if (v === null || typeof v !== 'object' || seen.has(v)) continue
    seen.add(v)
    if (v instanceof Uint8Array) {
      found.push(v)
      continue
    }
    if (v instanceof Map) for (const [k, x] of v) stack.push(k, x)
    else if (v instanceof Set) for (const x of v) stack.push(x)
    else for (const k of Object.keys(v)) stack.push(v[k])
  }
  return found
}

test('group-key and group-sealed shapes and limits', (t) => {
  const w = pworld({ base: false }).add(X, wX)
  const kid = { writer: G, seq: 1 }
  const key = newEpochKey()
  const k = groupKey({ kid: null, basis: [{ writer: wX, seq: 2 }], keys: [w.entry(wX, kid, key)], commit: cm(key, kid), at: AT(1) })
  t.alike(Object.keys(k), ['type', 'kid', 'basis', 'keys', 'auth', 'commit', 'at'])
  const opts = { private: true }
  t.is(validateGroupRecord(k, 1, opts), null)
  t.is(validateGroupRecord(k, 1, { ...opts, root: true }), null, 'in the root too')
  t.is(validateGroupRecord(k, 1), 'private-only')
  t.is(validateGroupRecord(k, 1, { root: true, community: true, private: true }), 'group-only')
  const cont = groupKey({ kid, keys: k.keys, at: AT(1) })
  t.alike(Object.keys(cont), ['type', 'kid', 'basis', 'keys', 'auth', 'at'])
  t.is(validateGroupRecord(cont, 1, opts), null, 'a continuation')
  t.is(validateGroupRecord({ ...cont, commit: k.commit }, 1, opts), 'malformed', 'a continuation carries no commit')
  const { commit, ...bare } = k
  t.is(validateGroupRecord(bare, 1, opts), 'malformed', 'a first block without commit')
  t.is(validateGroupRecord({ ...k, commit: commit.toUpperCase() }, 1, opts), 'malformed', 'commit is lowercase hex64')
  t.is(validateGroupRecord({ ...k, commit: commit.slice(2) }, 1, opts), 'malformed')
  t.is(validateGroupRecord({ ...k, commit: null }, 1, opts), 'malformed')
  t.is(validateGroupRecord({ ...k, kid: { writer: G, seq: 0 } }, 1, opts), 'malformed', 'a kid names a block after the header')
  t.is(validateGroupRecord({ ...k, keys: [] }, 1, opts), 'keys-invalid')
  const many = (n) => Array.from({ length: n }, (_, i) => ({ writer: K(0x1000 + i), sealed: k.keys[0].sealed }))
  t.is(validateGroupRecord({ ...k, keys: many(MAX_KEY_RECIPIENTS) }, 1, opts), null, '48 recipients fit')
  const full = { ...k, keys: many(MAX_KEY_RECIPIENTS), basis: Array.from({ length: MAX_KEY_BASIS }, (_, i) => ({ writer: K(0x2000 + i), seq: 2 ** 40 + i })) }
  t.is(validateGroupRecord(full, 1, opts), null, '48 recipients, 16 basis refs and the commit fit')
  t.ok(b4a.byteLength(JSON.stringify(full)) <= 16384, b4a.byteLength(JSON.stringify(full)) + ' bytes')
  t.is(validateGroupRecord({ ...k, keys: many(MAX_KEY_RECIPIENTS + 1) }, 1, opts), 'keys-invalid')
  t.is(validateGroupRecord({ ...k, keys: [k.keys[0], k.keys[0]] }, 1, opts), 'keys-invalid', 'a writer at most once')
  t.is(validateGroupRecord({ ...k, keys: [{ ...k.keys[0], sealed: k.keys[0].sealed.slice(4) }] }, 1, opts), 'keys-invalid', '96 bytes exactly')
  t.is(validateGroupRecord({ ...k, keys: [{ ...k.keys[0], extra: 1 }] }, 1, opts), 'keys-invalid')
  const basis = (n) => Array.from({ length: n }, (_, i) => ({ writer: wX, seq: i + 1 }))
  t.is(validateGroupRecord({ ...k, basis: basis(MAX_KEY_BASIS) }, 1, opts), null)
  t.is(validateGroupRecord({ ...k, basis: basis(MAX_KEY_BASIS + 1) }, 1, opts), 'basis-invalid')
  t.is(validateGroupRecord({ ...k, basis: [{ writer: wX, seq: 1 }, { writer: wX, seq: 1 }] }, 1, opts), 'basis-invalid')

  const { nonce, box } = sealRecord(sealedInner(groupPost({ text: 'oi', at: AT(2) }), { writer: wX, group: G, kid }), key)
  const s = groupSealed({ kid, nonce, box, at: AT(2) })
  t.alike(Object.keys(s), ['type', 'kid', 'nonce', 'box', 'at'])
  t.is(validateGroupRecord(s, 1, opts), null)
  t.is(validateGroupRecord(s, 1), 'private-only')
  t.is(validateGroupRecord({ ...s, nonce: nonce.toUpperCase() }, 1, opts), 'malformed')
  t.is(validateGroupRecord({ ...s, nonce: nonce.slice(2) }, 1, opts), 'malformed')
  t.is(validateGroupRecord({ ...s, box: box + '=' }, 1, opts), 'box-invalid', 'canonical base64 only')
  t.is(validateGroupRecord({ ...s, box: 'AAAAAAAAAAAAAAAAAAAAAAAB' }, 1, opts), null, '18 bytes')
  t.is(validateGroupRecord({ ...s, box: 'AAAAAAAAAAAAAAAAAAAAAAB=' }, 1, opts), 'box-invalid', 'nonzero padding bits')
  t.is(validateGroupRecord({ ...s, box: 'AAAA' }, 1, opts), 'box-invalid', 'shorter than a MAC')
  t.is(validateGroupRecord({ ...s, box: 'A'.repeat(16100) }, 1, opts), 'box-invalid', 'over the inner limit')
  t.is(validateGroupRecord({ ...s, kid: null }, 1, opts), 'malformed')

  for (const r of [groupPost({ text: 'oi', at: AT(1) }), groupHide({ target: { writer: wX, seq: 1 }, on: true, at: AT(1) })]) {
    t.is(validateGroupRecord(r, 1, opts), 'sealed-only', r.type)
  }
  t.is(validateGroupRecord(groupMeta({ name: 'x', join: 'approval', at: AT(1) }), 1, { root: true, private: true }), 'sealed-only')
  t.is(validateGroupRecord(groupBan({ member: X, on: true, at: AT(1) }), 1, opts), null, 'moderation stays plaintext')
})

test('a writer header box must match the visibility', (t) => {
  const wh = writerHeader({ group: G, diary: B, member: cwKey(B), box: K(9), at: AT(0) })
  t.is(validateWriterHeader(wh), null)
  const w = pworld()
  w.add(B, wB, { box: false })
  w.push(G, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(6) }))
  const g = buildGroup(w.input())
  t.absent(g.writers.has(wB), 'no box in a private group: header-invalid')
  t.ok(g.writers.has(wX))

  const pub = { key: G, entries: [{ seq: 0, record: groupHeader({ diary: C, community: CM, member: CM, at: AT(0) }) }] }
  const boxed = { key: wB, diary: B, entries: [{ seq: 0, record: wh }] }
  const joins = new Map([[C, [{ writer: G, on: true, seq: 1 }]], [B, [{ writer: wB, on: true, seq: 1 }]]])
  const p = buildGroup({ root: pub, writers: [boxed], joins, now: NOW })
  t.absent(p.writers.has(wB), 'a box in a public group: header-invalid')
  t.is(p.sealed, 0)
  t.is(p.epoch, null)
  t.is(p.rekeyPending, false)
})

test('a sealed post decrypts and orders by its envelope', (t) => {
  const w = pworld()
  sealedPost(w, wX, w.E1, 8)
  w.push(wY, groupPost({ text: 'plain', at: AT(6) }))
  sealedPost(w, wY, w.E1, 7)
  const g = buildGroup(w.input(w.reader(wX)))
  t.alike(g.posts.map((p) => p.writer + ':' + p.seq + ':' + p.text), [wY + ':2:p7', wX + ':1:p8'], 'by at; the plaintext post in a private group is skipped')
  t.alike(visible(g), [wY + ':2', wX + ':1'])
  t.is(g.name, 'Segredo')
  t.is(g.join, 'approval')
  t.is(g.visibility, 'private')
  t.is(g.sealed, 0)
  t.is(kidOf(g.epoch), kidOf(w.E1))
  t.is(g.rekeyPending, false)
  t.is(g.incomplete, false)

  const none = buildGroup(w.input())
  t.alike(none.posts, [])
  t.is(none.name, null)
  t.is(none.sealed, 3, 'meta and two posts')
  t.is(none.epoch, null)
  t.is(none.rekeyPending, false, 'holds no key at all')
  t.ok(none.members.get(X) === 'member' && none.admins.has(A), 'authority needs no key')

  const outsider = { writers: new Set([wB]), unseal: () => { throw new Error('never called for others') } }
  t.is(buildGroup(w.input(outsider)).sealed, 3)
  for (const r of [g, none]) t.alike(bytesIn(r), [], 'no key in the result')
})

test('a sealed hide and a sealed meta apply once opened', (t) => {
  const w = pworld()
  const p = sealedPost(w, wX, w.E1, 6)
  w.seal(wA, w.E1, groupHide({ target: p, on: true, at: AT(7) }))
  w.seal(G, w.E1, groupMeta({ name: 'Outro', join: 'open', at: AT(8) }))
  const g = buildGroup(w.input(w.reader(wY)))
  t.alike(visible(g), [], 'hidden by the admin')
  t.is(g.name, 'Segredo', 'a sealed meta whose join is not approval is skipped')
  t.is(g.join, 'approval')
})

test('a tampered or transplanted envelope counts as sealed', (t) => {
  const w = pworld()
  const p = sealedPost(w, wX, w.E1, 6)
  const env = w.logs.get(wX).entries[p.seq].record
  // Copied verbatim into another writer: the binding says wX.
  w.push(wY, { ...env })
  const box = env.box
  const i = 20
  const tampered = { ...env, box: box.slice(0, i) + (box[i] === 'A' ? 'B' : 'A') + box.slice(i + 1) }
  t.is(validateGroupRecord(tampered, 2, { private: true }), null, 'still a valid shape')
  w.push(wX, tampered)
  // Under another kid (same key): the binding names E1.
  const E2 = { writer: G, seq: w.len(G) }
  w.epochs.set(G + ':' + E2.seq, w.keyOf(w.E1))
  w.push(G, groupKey({ kid: null, keys: [w.entry(wA, E2, w.keyOf(w.E1))], commit: cm(w.keyOf(w.E1), E2), at: AT(9) }))
  w.push(wX, { ...env, kid: E2, at: AT(10) })
  const g = buildGroup(w.input(w.reader(wA)))
  t.alike(visible(g), [wX + ':1'])
  t.is(g.sealed, 3, 'the copy, the tampered block and the re-kidded one')
})

test('a key from an unauthorized distributor is ignored', (t) => {
  const w = pworld()
  const kid = w.rotate(wX, [wX, wY], { at: 6 })
  sealedPost(w, wX, kid, 7)
  const g = buildGroup(w.input(w.reader(wY)))
  t.alike(g.posts, [])
  t.is(g.sealed, 1)
  t.is(kidOf(g.epoch), kidOf(w.E1), 'the member block opens no epoch')
  // A continuation from a member is ignored too.
  w.push(wX, groupKey({ kid: w.E1, keys: [w.entry(wY, w.E1, newEpochKey())], at: AT(8) }))
  t.is(kidOf(buildGroup(w.input(w.reader(wY))).epoch), kidOf(w.E1))
})

test('a transplanted key entry fails the context tag', (t) => {
  const w = pworld()
  const firstX = w.logs.get(G).entries[w.E1.seq].record.keys.find((e) => e.writer === wX)
  const E2 = { writer: G, seq: w.len(G) }
  const key2 = newEpochKey()
  w.epochs.set(G + ':' + E2.seq, key2)
  w.push(G, groupKey({ kid: null, keys: [{ writer: wX, sealed: firstX.sealed }, w.entry(wA, E2, key2)], commit: cm(key2, E2), at: AT(6) }))
  sealedPost(w, wA, E2, 7)
  const gx = buildGroup(w.input(w.reader(wX)))
  t.alike(gx.posts, [], 'an entry from another epoch never opens')
  t.is(kidOf(gx.epoch), kidOf(w.E1), 'E2 is not held, so E1 stays the newest eligible')
  t.alike(visible(buildGroup(w.input(w.reader(wA)))), [wA + ':1'])

  const v = pworld()
  const E3 = { writer: G, seq: v.len(G) }
  const key3 = newEpochKey()
  v.epochs.set(G + ':' + E3.seq, key3)
  v.push(G, groupKey({ kid: null, keys: [v.entry(wX, E3, key3, K(0x999))], commit: cm(key3, E3), at: AT(6) }))
  sealedPost(v, G, E3, 7)
  t.is(buildGroup(v.input(v.reader(wX))).sealed, 1, 'an entry sealed for another group never opens')
})

test('concurrent rotations from the same parent are two kids, both readable', (t) => {
  const w = pworld()
  const E2 = w.rotate(G, [G, wA, wX, wY], { at: 10 })
  const E3 = w.rotate(wA, [G, wA, wX, wY], { at: 11 })
  t.not(kidOf(E2), kidOf(E3))
  sealedPost(w, wX, E2, 12)
  sealedPost(w, wY, E3, 13)
  for (const r of [wX, wY, wA]) {
    const g = buildGroup(w.input(w.reader(r)))
    t.alike(visible(g), [wX + ':1', wY + ':1'], 'reader ' + r.slice(-3))
    t.is(kidOf(g.epoch), kidOf(E3), 'the newest in causal order')
  }
  const gc = buildGroup(w.input(w.reader(G)))
  t.alike(visible(gc), [wX + ':1', wY + ':1'], 'the creator reads through the root box')
})

test('the creator receives an admin rotation through the root box', (t) => {
  const w = pworld()
  const E2 = w.rotate(wA, [G, wA, wX], { at: 6 })
  sealedPost(w, wA, E2, 7)
  const g = buildGroup(w.input(w.reader(G)))
  t.alike(g.posts.map((p) => p.text), ['p7'])
  t.is(g.name, 'Segredo')
})

test('a removal after the last epoch leaves the reader rekey-pending until a rotation covers it', (t) => {
  const w = pworld()
  const ban = w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(6) }))
  let g = buildGroup(w.input(w.reader(wX)))
  t.is(g.members.get(Y), 'banned')
  t.is(g.epoch, null)
  t.is(g.rekeyPending, true)
  const E2 = w.rotate(G, [G, wA, wX], { basis: [ban], at: 7 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2))
  t.is(g.rekeyPending, false)
  t.is(buildGroup(w.input()).rekeyPending, false, 'no key held, nothing pending')

  for (const removal of [
    (v) => v.push(wY, groupLeave({ cuts: [{ writer: wY, seq: v.len(wY) }], at: AT(6) })),
    (v) => v.push(G, groupAdmit({ member: Y, on: false, cuts: [{ writer: wY, seq: v.len(wY) }], at: AT(6) })),
    (v) => v.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: v.len(wA) }], at: AT(6) }))
  ]) {
    const v = pworld()
    removal(v)
    t.is(buildGroup(v.input(v.reader(wX))).rekeyPending, true)
  }
})

test('an epoch distributed before a ban is never eligible after the ban', (t) => {
  const w = pworld()
  w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(10) }))
  // A never saw the ban: its rotation excludes Y but does not cover it.
  const E2 = w.rotate(wA, [G, wA, wX], { at: 20 })
  let g = buildGroup(w.input(w.reader(wX)))
  t.is(g.epoch, null, 'E2 misses the ban, E1 still names Y')
  t.is(g.rekeyPending, true)
  sealedPost(w, wA, E2, 21)
  t.alike(buildGroup(w.input(w.reader(wX))).posts.map((p) => p.text), ['p21'], 'still readable')
  const E3 = w.rotate(G, [G, wA, wX], { basis: [{ writer: G, seq: 6 }], at: 22 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E3))
})

test('a pending new device of an admitted diary is never an entitled recipient', (t) => {
  const w = pworld()
  w.add(X, wX2)
  const E2 = w.rotate(G, [G, wA, wX, wX2, wY], { at: 6 })
  const g = buildGroup(w.input(w.reader(wA)))
  t.is(g.members.get(X), 'member')
  t.ok(g.requests.includes(X), 'the new device waits for an admit')
  t.is(kidOf(g.epoch), kidOf(w.E1), 'E2 hands the key to a pending writer')
  t.not(kidOf(g.epoch), kidOf(E2))
  t.alike(g.entitled, [G, wA, wX, wY].sort(), 'the writers a rotation seals to')
  const own = buildGroup(w.input(w.reader(wX2)))
  t.is(own.epoch, null, 'the pending device itself holds only E2, which names it')
  t.is(own.rekeyPending, true)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }, { writer: wX2, seq: 1 }], at: AT(7) }))
  const after = buildGroup(w.input(w.reader(wA)))
  t.is(kidOf(after.epoch), kidOf(E2), 'admitted, E2 becomes eligible')
  t.alike(after.entitled, [G, wA, wX, wX2, wY].sort())
  t.is(kidOf(buildGroup(w.input(w.reader(wX2))).epoch), kidOf(E2))
})

test('a community admin receives keys and distributes through auth; a demotion in C ends it, history stays', (t) => {
  const w = cworld()
  const E1 = w.rotate(G, [G, wA, wX], { at: 3 })
  sealedPost(w, wX, E1, 4)
  let g = buildGroup(w.input(w.reader(wA)))
  t.is(g.community.kind, 'community')
  t.is(g.orphan, false)
  t.ok(g.admins.has(A), 'a community admin is an admin of G')
  t.ok(g.entitled.includes(wA), 'and receives keys on its live writer')
  t.alike(g.posts.map((p) => p.text), ['p4'], 'the community admin reads')
  t.is(kidOf(g.epoch), kidOf(E1))
  const E2 = w.rotate(wA, [G, wA, wX], { auth: w.cauth(A), at: 5 })
  sealedPost(w, wX, E2, 6)
  g = buildGroup(w.input(w.reader(wX)))
  t.alike(g.posts.map((p) => p.text), ['p4', 'p6'])
  t.is(kidOf(g.epoch), kidOf(E2), 'the community admin distributes like a group admin')

  const demote = w.cgrant(A, false, { at: 7 })
  g = buildGroup(w.input(w.reader(wX)))
  t.absent(g.admins.has(A))
  t.absent(g.entitled.includes(wA))
  t.is(g.epoch, null, 'the demotion is a removal and E2 is no longer valid for sending')
  t.is(g.rekeyPending, true)
  t.alike(g.posts.map((p) => p.text), ['p4', 'p6'], 'history stays readable')
  t.alike(g.removals, [demote])
  const E3 = w.rotate(G, [G, wX], { basis: [demote], at: 8 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E3), 'a basis naming the community record covers it')
  // Regranted, then demoted again: the new demotion needs a rotation.
  w.cgrant(A, true, { at: 9 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E3))
  w.cgrant(A, false, { at: 10 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(g.epoch, null, 'the uncovered second demotion')
  t.is(g.rekeyPending, true)
})

test('a hostile unseal never breaks the fold', (t) => {
  const w = pworld()
  sealedPost(w, wX, w.E1, 6)
  for (const unseal of [() => { throw new Error('x') }, () => b4a.alloc(31), () => 'k'.repeat(32), () => null]) {
    const g = buildGroup(w.input({ writers: new Set([wX]), unseal }))
    t.is(g.sealed, 2)
    t.is(g.incomplete, false)
  }
  t.is(buildGroup(w.input({ writers: [wX], unseal: () => null })).sealed, 2, 'writers must be a Set')
})

function shuffle (list, rand) {
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

test('property: private records give the same output for every delivery order', (t) => {
  const w = pworld()
  w.add(X, wX2)
  sealedPost(w, wX, w.E1, 6)
  const ban = w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(7) }))
  sealedPost(w, wY, w.E1, 8)
  const E2 = w.rotate(wA, [G, wA, wX], { basis: [ban], at: 9 })
  sealedPost(w, wA, E2, 10)
  w.seal(G, E2, groupHide({ target: { writer: wX, seq: 1 }, on: true, at: AT(11) }))
  w.push(wX, groupKey({ kid: E2, keys: [w.entry(wX2, E2, w.keyOf(E2))], at: AT(12) }))
  const reader = w.reader(wX)
  const expected = normalize(buildGroup(w.input(reader)))
  const parsed = JSON.parse(expected)
  t.is(parsed.epoch.writer, wA)
  t.ok(parsed.posts.length >= 2)
  let seed = 7
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  let same = 0
  const N = 500
  for (let i = 0; i < N; i++) {
    const base = w.input(reader)
    const root = { key: G, entries: shuffle(base.root.entries, rand) }
    const writers = shuffle(base.writers.map((l) => ({ ...l, entries: shuffle(l.entries, rand) })), rand)
    if (normalize(buildGroup({ ...base, root, writers })) === expected) same++
  }
  t.is(same, N, N + ' delivery orders')
  t.is(normalize(buildGroup(w.input(reader))), expected, 'stable')
})

const wX3 = K(0x402)

test('the fold checks the context tag of what unseal returns', (t) => {
  const w = pworld()
  sealedPost(w, wX, w.E1, 6)
  const key = w.keyOf(w.E1)
  const plainFor = (group, kid) => b4a.concat([key, keyTag(group, kid.writer, kid.seq)])
  const returned = []
  const reader = (plain) => ({
    writers: new Set([wX]),
    unseal: () => {
      const b = b4a.from(plain)
      returned.push(b)
      return b
    }
  })
  t.alike(visible(buildGroup(w.input(reader(plainFor(G, w.E1))))), [wX + ':1'], 'the right tag opens')
  t.ok(returned.length > 0 && returned.every((b) => b.every((x) => x === 0)), 'the callback buffer is wiped')
  for (const [label, plain] of [['another kid', plainFor(G, { writer: G, seq: 1 })], ['another group', plainFor(K(0x999), w.E1)], ['a bare key', key]]) {
    const g = buildGroup(w.input(reader(plain)))
    t.is(g.sealed, 2, label)
    t.is(g.epoch, null, label)
  }
})

test('decrypted edges never change membership or moderation', (t) => {
  const w = pworld()
  w.add(B, wB)
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(6) }))
  const bBan = w.push(wB, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(20) }))
  // Opened, this post follows B's ban and the root's ban follows it, which
  // would make the root's ban the latest and let the unban lift it.
  const p = w.seal(wX, w.E1, groupPost({ text: 'oi', seen: bBan, at: AT(5) }))
  const cBan = w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }, { writer: wX, seq: p.seq + 1 }], at: AT(10) }))
  w.push(G, groupBan({ member: Y, on: false, lifts: cBan, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(30) }))
  const without = buildGroup(w.input())
  const withKeys = buildGroup(w.input(w.reader(wX)))
  t.alike(withKeys.posts.map((x) => x.text), ['oi'])
  t.is(without.members.get(Y), 'banned', 'in plaintext order B ban is the latest')
  t.is(withKeys.members.get(Y), without.members.get(Y))
  t.alike([...withKeys.bans], [...without.bans])
  t.alike([...withKeys.admins].sort(), [...without.admins].sort())
  t.alike(withKeys.requests, without.requests)
  t.alike(withKeys.entitled, without.entitled)
})

// A community admin A (no grant in G) next to the admitted member X.
function cworld (opts = {}) {
  const w = pworld({ base: false, cadmins: [A], ...opts })
  w.add(A, wA).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  return w
}

test('a member who leaves the community is not entitled; rejoining C alone does not re-entitle the old writer', (t) => {
  const w = cworld()
  w.rotate(G, [G, wA, wX], { at: 3 })
  const leave = w.cleave(X, 4)
  let g = buildGroup(w.input(w.reader(wA)))
  t.is(g.members.get(X), 'left', 'gated out of G')
  t.absent(g.entitled.includes(wX))
  t.is(g.rekeyPending, true, 'the community leave is a removal')
  t.alike(g.removals, [leave])
  const E2 = w.rotate(G, [G, wA], { basis: [leave], at: 5 })
  t.is(kidOf(buildGroup(w.input(w.reader(wA))).epoch), kidOf(E2))
  w.comm.addWriter(X, cwX2, { rejoin: leave })
  g = buildGroup(w.input(w.reader(wA)))
  t.is(g.members.get(X), 'left', 'the old G writer names a retired CW')
  t.absent(g.entitled.includes(wX))
  t.is(kidOf(g.epoch), kidOf(E2))
  t.is(g.rekeyPending, false)
})

test('a community demotion of a member C never granted is not a removal', (t) => {
  const w = cworld()
  const E1 = w.rotate(G, [G, wA, wX], { at: 3 })
  w.cgrant(X, false, { at: 4 })
  const g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E1))
  t.alike(g.removals, [])
})

// Linear in the epochs: four times the epochs must cost far less than
// six times the time (an ancestor walk per candidate was quadratic, about
// eight times here).
function manyEpochs (count) {
  const w = pworld()
  w.push(wA, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(1) }))
  const plain = new Map()
  const key = newEpochKey()
  for (let i = 0; i < count; i++) {
    const kid = { writer: G, seq: w.len(G) }
    const blob = b4a.alloc(96)
    blob.writeUInt32BE(i, 0)
    const sealed = b4a.toString(blob, 'base64')
    plain.set(sealed, b4a.concat([key, keyTag(G, kid.writer, kid.seq)]))
    w.push(G, groupKey({ kid: null, keys: [{ writer: wX, sealed }], commit: cm(key, kid), at: AT(10 + i) }))
  }
  const input = w.input({ writers: new Set([wX]), unseal: (s) => plain.has(s) ? b4a.from(plain.get(s)) : null })
  let best = Infinity
  let g = null
  for (let i = 0; i < 2; i++) {
    const start = Date.now()
    g = buildGroup(input)
    best = Math.min(best, Date.now() - start)
  }
  return { g, ms: best }
}

test('coverage is computed once: 4000 epochs with an uncovered removal', (t) => {
  const small = manyEpochs(1000)
  const big = manyEpochs(4000)
  t.is(big.g.epoch, null)
  t.is(big.g.rekeyPending, true)
  t.is(small.g.rekeyPending, true)
  t.ok(big.ms < 500, 'folded in ' + big.ms + ' ms')
  t.ok(big.ms < 6 * Math.max(small.ms, 5), big.ms + ' ms against ' + small.ms + ' ms for a quarter')
})

test('a creator leave never takes back the keys handed out', (t) => {
  const w = pworld()
  const E2 = w.rotate(wA, [G, wA, wX, wY], { at: 6 })
  sealedPost(w, wX, E2, 7)
  w.push(G, groupLeave({ cuts: [{ writer: G, seq: 1 }], at: AT(8) }))
  const g = buildGroup(w.input(w.reader(wX)))
  t.absent(g.admins.has(A), 'the grant is withdrawn')
  t.alike(g.posts.map((p) => p.text), ['p7'], 'E2 stays readable')
})

test('entitled writers: an unban that omits a writer, a rejoin on a new writer', (t) => {
  const w = pworld()
  const ban = w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(6) }))
  w.push(G, groupBan({ member: X, on: false, lifts: ban, cuts: [], at: AT(7) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  t.absent(g.entitled.includes(wX), 'the unban never listed wX')

  const v = pworld()
  const leave = v.push(wY, groupLeave({ cuts: [{ writer: wY, seq: v.len(wY) }], at: AT(6) }))
  v.add(Y, wX3, { rejoin: leave })
  v.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wX3, seq: 1 }], at: AT(8) }))
  const r = buildGroup(v.input())
  t.is(r.members.get(Y), 'member')
  t.ok(r.entitled.includes(wX3))
  t.absent(r.entitled.includes(wY), 'the writer that left')
})

test('a continuation by a second distributor hands the epoch to a new device', (t) => {
  const w = pworld()
  sealedPost(w, wX, w.E1, 6)
  w.add(X, wX2)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 1 }], at: AT(7) }))
  t.is(buildGroup(w.input(w.reader(wX2))).sealed, 2, 'not yet')
  w.push(wA, groupKey({ kid: w.E1, keys: [w.entry(wX2, w.E1, w.keyOf(w.E1))], at: AT(8) }))
  const g = buildGroup(w.input(w.reader(wX2)))
  t.alike(g.posts.map((p) => p.text), ['p6'])
  t.is(kidOf(g.epoch), kidOf(w.E1))
  // A continuation naming a block that is no first block is ignored.
  const bogus = { writer: G, seq: 2 }
  w.push(G, groupKey({ kid: bogus, keys: [w.entry(wY, bogus, newEpochKey())], at: AT(9) }))
  t.is(kidOf(buildGroup(w.input(w.reader(wY))).epoch), kidOf(w.E1))
})

test('an unbound private root opens nothing', (t) => {
  const w = pworld()
  sealedPost(w, wX, w.E1, 6)
  const joins = new Map([...w.joins].filter(([d]) => d !== C))
  const g = buildGroup({ ...w.input(w.reader(wX)), joins })
  t.is(g.incomplete, true)
  t.alike(g.posts, [])
  t.is(g.sealed, 1)
  t.is(g.epoch, null)
  t.is(g.rekeyPending, false)
})

test('a bad inner record stays sealed', (t) => {
  const w = pworld()
  const key = w.keyOf(w.E1)
  const bind = (record, writer = wX) => sealedInner(record, { writer, group: G, kid: w.E1 })
  const pushRaw = (inner, at) => {
    const { nonce, box } = sealRecord(inner, key)
    w.push(wX, groupSealed({ kid: w.E1, nonce, box, at }))
  }
  pushRaw(bind(groupPost({ text: 'a', at: AT(9) })), AT(10))
  pushRaw(bind(groupKey({ kid: w.E1, keys: [w.entry(wX, w.E1, key)], at: AT(11) })), AT(11))
  pushRaw(bind(groupMeta({ name: 'x', join: 'approval', at: AT(12) })), AT(12))
  pushRaw({ ...bind(groupPost({ text: 'b', at: AT(13) })), extra: 1 }, AT(13))
  pushRaw(bind(groupPost({ text: 'c', at: AT(14) }), wY), AT(14))
  sealedPost(w, wX, w.E1, 15)
  const g = buildGroup(w.input(w.reader(wX)))
  t.alike(g.posts.map((p) => p.text), ['p15'])
  t.is(g.sealed, 5, 'at mismatch, nested key, meta outside the root, extra key, other writer')
  t.is(g.name, 'Segredo')
})

test('an unseal that throws midway leaves no key bytes in the result', (t) => {
  const w = pworld()
  const E2 = w.rotate(G, [G, wA, wX, wY], { at: 6 })
  sealedPost(w, wX, E2, 7)
  const pair = w.boxes.get(wX)
  let calls = 0
  const keys = {
    writers: new Set([wX]),
    unseal: (s) => {
      if (++calls > 1) throw new Error('midway')
      return openFrom(b4a.from(s, 'base64'), pair)
    }
  }
  const g = buildGroup(w.input(keys))
  t.is(calls, 2)
  t.is(g.incomplete, false)
  t.is(g.sealed, 1, 'E2 never opened')
  t.alike(bytesIn(g), [])
})

test('coverage reaches through the basis of an ancestor first block', (t) => {
  const w = cworld()
  w.rotate(G, [G, wA, wX], { at: 3 })
  const d1 = w.cgrant(A, false, { at: 4 })
  w.rotate(G, [G, wX], { basis: [d1], at: 5 })
  const E3 = w.rotate(G, [G, wX], { at: 6 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E3))
  const v = cworld()
  v.rotate(G, [G, wA, wX], { at: 3 })
  v.cgrant(A, false, { at: 4 })
  v.rotate(G, [G, wX], { at: 6 })
  t.is(buildGroup(v.input(v.reader(wX))).rekeyPending, true, 'without that basis')
})

const wA3 = K(0x203)
const wC2 = K(0x102)
const wC3 = K(0x103)

test('a retired writer is never entitled through an earlier grant', (t) => {
  const w = pworld()
  const E2 = w.rotate(wA, [G, wA, wX, wY], { at: 5.5 })
  const leave = w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(6) }))
  w.add(A, wA3, { rejoin: leave })
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA3, seq: 1 }], at: AT(7) }))
  let g = buildGroup(w.input(w.reader(wX)))
  t.ok(g.admins.has(A))
  t.ok(g.entitled.includes(wA3))
  t.absent(g.entitled.includes(wA), 'the writer that left keeps no grant')
  t.not(kidOf(g.epoch), kidOf(E2), 'the retired writer epoch does not cover the leave')
  t.is(g.epoch, null)
  t.is(g.rekeyPending, true)
  const E3 = w.rotate(G, g.entitled, { basis: [leave], at: 8 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E3))
})

test('a creator leaving on a secondary writer and rejoining keeps only the new writer entitled', (t) => {
  const w = pworld()
  w.add(C, wC2)
  const leave = w.push(wC2, groupLeave({ cuts: [{ writer: G, seq: w.len(G) }, { writer: wC2, seq: w.len(wC2) }], at: AT(6) }))
  let g = buildGroup(w.input())
  t.absent(g.entitled.includes(G) || g.entitled.includes(wC2), 'the creator left')
  w.add(C, wC3, { rejoin: leave })
  g = buildGroup(w.input())
  t.is(g.members.get(C), 'member')
  t.ok(g.entitled.includes(wC3))
  t.absent(g.entitled.includes(G), 'the root wrote nothing since the leave')
  t.absent(g.entitled.includes(wC2))
})

test('a community admin who leaves G and rejoins is entitled only on its rejoin writer', (t) => {
  const w = cworld()
  const leave = w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(3) }))
  w.add(A, wA3, { rejoin: leave })
  const g = buildGroup(w.input())
  t.ok(g.admins.has(A))
  t.ok(g.entitled.includes(wA3))
  t.absent(g.entitled.includes(wA))
})

test('onKey hands the accepted epochs, copies only, and a throwing hook changes nothing', (t) => {
  const w = pworld()
  const E2 = w.rotate(wA, [G, wA, wX], { at: 6 })
  sealedPost(w, wX, E2, 7)
  w.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(8) }))
  w.rotate(wX, [wX, wY], { at: 9 })
  const reader = w.reader(wX)
  const base = normalize(buildGroup(w.input(reader)))
  const got = []
  reader.onKey = (kid, key, recipients) => {
    got.push({ kid: kidOf(kid), same: b4a.equals(key, w.keyOf(kid)), len: key.byteLength, recipients: recipients.slice() })
    key.fill(7)
    kid.seq = 99
    recipients.push('x')
  }
  const g = buildGroup(w.input(reader))
  t.alike(got.map((x) => x.kid), [kidOf(w.E1), kidOf(E2)], 'the demoted admin epoch, never the member one')
  t.ok(got.every((x) => x.same && x.len === 32))
  t.alike(got[0].recipients, [G, wA, wX, wY].sort())
  t.alike(got[1].recipients, [G, wA, wX].sort())
  t.alike(g.posts.map((p) => p.text), ['p7'], 'readable by the fold')
  t.is(normalize(g), base, 'mutating the copies changes nothing')
  t.alike(bytesIn(g), [])
  reader.onKey = () => { throw new Error('hook') }
  t.is(normalize(buildGroup(w.input(reader))), base, 'a throwing hook changes nothing')
})

test('leave floods neither count for a never-admitted diary nor cost more than one per writer', (t) => {
  const w = pworld()
  w.add(B, wB)
  for (let i = 0; i < 5000; i++) w.push(wB, groupLeave({ cuts: [{ writer: wB, seq: w.len(wB) }], at: AT(10 + i / 1000) }))
  let last = null
  for (let i = 0; i < 2000; i++) last = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(20 + i / 1000) }))
  const E2 = w.rotate(G, [G, wA, wY], { basis: [last], at: 30 })
  const start = Date.now()
  const g = buildGroup(w.input(w.reader(wY)))
  const ms = Date.now() - start
  t.is(g.members.get(X), 'left')
  t.alike(g.entitled, [G, wA, wY].sort())
  t.is(kidOf(g.epoch), kidOf(E2), 'the never-admitted leaves are no removals; the last X leave covers the others')
  t.ok(ms < 5000, 'folded in ' + ms + ' ms')
})

test('a low-order box key is header-invalid in roots and writers', (t) => {
  const weak = [
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0000000000000000000000000000000000000000000000000000000000000080',
    '0100000000000000000000000000000000000000000000000000000000000000',
    'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
    '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
    '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f11d7',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
  ]
  const good = hex(newBoxKeyPair().publicKey)
  t.absent(isWeakBoxKey(good))
  t.absent(isWeakBoxKey('xyz'))
  const root = groupHeader({ diary: C, community: CM, member: CM, visibility: 'private', join: 'approval', box: good, at: AT(0) })
  const writer = writerHeader({ group: G, diary: B, member: cwKey(B), box: good, at: AT(0) })
  for (const box of weak) {
    t.ok(isWeakBoxKey(box), box.slice(0, 8) + box.slice(62))
    t.is(validateGroupHeader({ ...root, box }), 'malformed', 'root')
    t.is(validateWriterHeader({ ...writer, box }), 'malformed', 'writer')
  }
  const w = pworld()
  w.add(B, wB)
  w.logs.get(wB).entries[0].record = { ...w.logs.get(wB).entries[0].record, box: weak[0] }
  w.push(G, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(6) }))
  const g = buildGroup(w.input())
  t.absent(g.writers.has(wB))
  t.absent(g.entitled.includes(wB), 'never a recipient')
})

test('removals lists exactly the refs a rotation basis must cover', (t) => {
  const w = pworld()
  w.add(B, wB)
  for (let i = 0; i < 5000; i++) w.push(wB, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(10 + i / 1000) }))
  let g = buildGroup(w.input())
  t.alike(g.removals, [], 'bans from an unadmitted writer are ignored records')
  t.is(g.members.get(X), 'member')
  w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(20) }))
  const ban2 = w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(21) }))
  g = buildGroup(w.input())
  t.alike(g.removals, [ban2], 'the latest counted removal per writer')
  const E2 = w.rotate(G, g.entitled, { basis: g.removals, at: 22 })
  t.is(kidOf(buildGroup(w.input(w.reader(wA))).epoch), kidOf(E2))
  t.alike(buildGroup({ root: { key: G, entries: [{ seq: 0, record: groupHeader({ diary: C, community: CM, member: CM, at: AT(0) }) }] }, writers: [], joins: new Map(), now: NOW }).removals, [], 'public')

  const c = cworld()
  c.rotate(G, [G, wA, wX], { at: 3 })
  const demote = c.cgrant(A, false, { at: 4 })
  t.alike(buildGroup(c.input()).removals, [demote], 'a community demotion, as a ref on the C core')
})

test('an opened post keeps its envelope generation (a pending rejoin cannot post through an old writer)', (t) => {
  const w = pworld()
  w.add(X, wX2)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }, { writer: wX2, seq: 1 }], at: AT(6) }))
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 1 }], at: AT(10) }))
  w.add(X, wX3, { rejoin: leave })
  // Not re-admitted; a distributor wrongly seals E2 to the pending wX3.
  const E2 = w.rotate(G, [G, wA, wX3, wY], { basis: [leave], at: 13 })
  // On the old writer, backdated before the leave: the envelope follows E2
  // and so the rejoin.
  w.seal(wX2, E2, groupPost({ text: 'late', at: AT(8) }))
  w.seal(wX3, E2, groupPost({ text: 'late3', at: AT(15) }))
  const g = buildGroup(w.input(w.reader(wA)))
  t.is(g.members.get(X), 'requested')
  t.alike(g.posts.map((p) => p.text).sort(), ['late', 'late3'], 'both opened')
  for (const p of g.posts) t.is(p.hidden, true, p.text + ' hidden')
})

test('community toggles coalesce to one removal per community core', (t) => {
  const w = cworld({ cadmins: [A, Z] })
  const cwZ = w.cwOf(Z)
  const cwX = w.cwOf(X)
  w.rotate(G, [G, wA, wX], { at: 3 })
  for (let i = 0; i < 100; i++) {
    const at = 4 + i / 10
    w.cgrant(A, false, { at })
    w.cgrant(A, true, { at })
    w.comm.push(cwZ, communityAdmit({ member: X, on: false, cuts: [{ writer: cwX, seq: 1 }], at: AT(at) }))
    w.comm.push(cwZ, communityAdmit({ member: X, on: true, cuts: [{ writer: cwX, seq: 1 }], at: AT(at) }))
  }
  let g = buildGroup(w.input(w.reader(wX)))
  t.alike(g.removals.map((r) => r.writer).sort(), [CM, cwZ].sort(), 'one removal per community core')
  t.is(g.rekeyPending, true)
  const E2 = w.rotate(G, g.entitled, { basis: g.removals, at: 20 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2), 'one extra epoch covers the whole storm')
})

test('a member back in the community enters G only on a new writer an admit lists', (t) => {
  const w = cworld()
  const leave = w.cleave(X, 4)
  w.comm.addWriter(X, cwX2, { rejoin: leave })
  w.add(X, wX2)
  t.is(w.logs.get(wX2).entries[0].record.member, cwX2, 'the new G writer names the new CW')
  let g = buildGroup(w.input())
  t.ok(g.requests.includes(X), 'the new writer waits for an admit')
  t.absent(g.entitled.includes(wX) || g.entitled.includes(wX2))
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX2, seq: 1 }], at: AT(6) }))
  g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  t.ok(g.entitled.includes(wX2))
  t.absent(g.entitled.includes(wX), 'the writer on the retired CW stays out')
})

const wY2 = K(0x501)
const wY3 = K(0x502)
const leaveOn = (w, writer, at, extra = {}) => w.push(writer, groupLeave({ cuts: [{ writer, seq: w.len(writer) }], at: AT(at), ...extra }))
const epochFor = (w, reader = wX) => buildGroup(w.input(w.reader(reader)))

test('a banned member cannot reopen rekey-pending with leaves, even backdated', (t) => {
  const w = pworld()
  const ban = w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(6) }))
  const E2 = w.rotate(G, [G, wA, wX], { basis: [ban], at: 7 })
  t.is(kidOf(epochFor(w).epoch), kidOf(E2))
  leaveOn(w, wY, 8)
  t.is(kidOf(epochFor(w).epoch), kidOf(E2), 'after a leave')
  leaveOn(w, wY, 9)
  t.is(kidOf(epochFor(w).epoch), kidOf(E2), 'after a second leave')
  // Sorted before the ban by its clock: the ban's cut still covers it.
  leaveOn(w, wY, 1)
  const g = epochFor(w)
  t.is(kidOf(g.epoch), kidOf(E2), 'after a backdated leave')
  t.is(g.rekeyPending, false)
  t.alike(g.removals, [ban])
})

test('a departed member cannot add a requirement with more leaves, even backdated on another writer', (t) => {
  const w = pworld()
  w.add(Y, wY2)
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }, { writer: wY2, seq: 1 }], at: AT(5.5) }))
  const leave = leaveOn(w, wY, 6)
  const E2 = w.rotate(G, [G, wA, wX], { basis: [leave], at: 7 })
  t.is(kidOf(epochFor(w).epoch), kidOf(E2))
  leaveOn(w, wY, 8)
  t.is(kidOf(epochFor(w).epoch), kidOf(E2), 'after a second leave')
  leaveOn(w, wY2, 2)
  const g = epochFor(w)
  t.is(kidOf(g.epoch), kidOf(E2), 'after a leave backdated before the first on another writer')
  t.is(g.rekeyPending, false)
})

test('rejoin and leave without an admit never add a requirement', (t) => {
  const w = pworld()
  const leave = leaveOn(w, wY, 6)
  const E2 = w.rotate(G, [G, wA, wX], { basis: [leave], at: 7 })
  w.add(Y, wY2, { rejoin: leave })
  t.is(kidOf(epochFor(w).epoch), kidOf(E2), 'pending rejoin')
  const l2 = leaveOn(w, wY2, 9)
  t.is(kidOf(epochFor(w).epoch), kidOf(E2), 'leave on the rejoin writer')
  w.add(Y, wY3, { rejoin: l2 })
  leaveOn(w, wY3, 12)
  const g = epochFor(w)
  t.is(kidOf(g.epoch), kidOf(E2), 'second rejoin and leave')
  t.alike(g.removals, [leave])
})

test('a genuine leave by an admitted member, an admin or the creator still needs a rotation', (t) => {
  for (const [label, who] of [['member', (w) => leaveOn(w, wY, 6)], ['admin', (w) => leaveOn(w, wA, 6)]]) {
    const w = pworld()
    const leave = who(w)
    const g = epochFor(w)
    t.is(g.epoch, null, label)
    t.is(g.rekeyPending, true, label)
    t.alike(g.removals, [leave], label)
  }
  const w = pworld()
  w.add(C, K(0x102))
  const leave = leaveOn(w, K(0x102), 6, { cuts: [{ writer: G, seq: w.len(G) }, { writer: K(0x102), seq: 1 }] })
  const g = epochFor(w)
  t.is(g.rekeyPending, true, 'creator')
  t.alike(g.removals, [leave], 'creator')
  // A readmitted member's next leave is a new requirement.
  const v = pworld()
  const l1 = leaveOn(v, wY, 6)
  v.rotate(G, [G, wA, wX], { basis: [l1], at: 7 })
  v.add(Y, wY2, { rejoin: l1 })
  v.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY2, seq: 1 }], at: AT(8) }))
  const E3 = v.rotate(G, [G, wA, wX, wY2], { at: 9 })
  t.is(kidOf(epochFor(v).epoch), kidOf(E3))
  leaveOn(v, wY2, 10)
  t.is(epochFor(v).rekeyPending, true, 'readmitted then left again')
})

test('extra leaves of the same generation never hide the genuine one', (t) => {
  const w = pworld()
  w.add(Y, wY2)
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }, { writer: wY2, seq: 1 }], at: AT(5.5) }))
  const leave = leaveOn(w, wY, 6)
  leaveOn(w, wY, 7)
  leaveOn(w, wY2, 8)
  let g = epochFor(w)
  t.is(g.rekeyPending, true, 'the generation still ended')
  t.is(g.removals.length, 1, 'one requirement')
  const E2 = w.rotate(G, g.entitled, { basis: [leave], at: 9 })
  g = epochFor(w)
  t.is(kidOf(g.epoch), kidOf(E2), 'covering one leave of the generation covers it')
})

const wA2 = K(0x201)
const wYz = K(0x4f0)

test('a departed admin with a standing grant cannot add requirements by rejoining', (t) => {
  const w = pworld()
  const l1 = leaveOn(w, wA, 6)
  const E2 = w.rotate(G, [G, wX, wY], { basis: [l1], at: 7 })
  t.is(kidOf(epochFor(w).epoch), kidOf(E2))
  w.add(A, wA2, { rejoin: l1 })
  const l2 = leaveOn(w, wA2, 8)
  t.is(kidOf(epochFor(w).epoch), kidOf(E2), 'rejoin and leave on wA2')
  w.add(A, wA3, { rejoin: l2 })
  leaveOn(w, wA3, 9)
  const g = epochFor(w)
  t.is(kidOf(g.epoch), kidOf(E2), 'again on wA3')
  t.alike(g.removals, [l1])
})

test('a backdated rejoin never turns an old admit into a new requirement nor hides the genuine leave', (t) => {
  const w = pworld()
  const l1 = leaveOn(w, wY, 6)
  w.rotate(G, [G, wA, wX], { basis: [l1], at: 7 })
  w.add(Y, wY2, { rejoin: l1 })
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY2, seq: 1 }], at: AT(8) }))
  w.rotate(G, [G, wA, wX, wY2], { at: 9 })
  const l2 = leaveOn(w, wY2, 10)
  let g = epochFor(w)
  t.is(g.rekeyPending, true, 'the genuine leave of the readmitted member counts')
  const E4 = w.rotate(G, g.entitled, { basis: g.removals, at: 11 })
  t.is(kidOf(epochFor(w).epoch), kidOf(E4))
  // A writer whose rejoin names the old leave and sorts before the real
  // rejoin, with a leave right after it.
  w.add(Y, wYz, { rejoin: l1 })
  leaveOn(w, wYz, -1)
  g = epochFor(w)
  t.is(kidOf(g.epoch), kidOf(E4), 'the shuffled leave adds nothing')
  t.is(g.rekeyPending, false)
  t.ok(g.removals.some((r) => kidOf(r) === kidOf(l2)), 'the genuine leave still counts')
})

test('a demotion never blinds the history an admin handed out; sending stays strict', (t) => {
  for (const [label, cuts] of [['no cuts', []], ['a 0 cut', [{ writer: wA, seq: 0 }]]]) {
    const w = pworld()
    const E2 = w.rotate(wA, [G, wA, wX, wY], { at: 6 })
    sealedPost(w, wX, E2, 7)
    sealedPost(w, wY, w.E1, 8)
    const demote = w.push(G, groupAdmin({ member: A, on: false, cuts, at: AT(9) }))
    const g = epochFor(w)
    t.alike(g.posts.map((p) => p.text), ['p7', 'p8'], label + ': old posts readable')
    t.is(g.epoch, null, label + ': nothing eligible')
    t.is(g.rekeyPending, true, label)
    const E3 = w.rotate(G, [G, wX, wY], { basis: [demote], at: 10 })
    t.is(kidOf(epochFor(w).epoch), kidOf(E3), label + ': a rotation by the creator')
  }
})

test('a community demotion omitting a CW cuts it at 0 for sending; reading stays', (t) => {
  const w = cworld()
  const E1 = w.rotate(wA, [G, wA, wX], { auth: w.cauth(A), at: 3 })
  sealedPost(w, wX, E1, 4)
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E1), 'control')
  // The demotion lists another writer only: A's CW is cut at 0.
  w.cgrant(A, false, { cuts: [{ writer: K(0x9999), seq: 1 }], at: 5 })
  const g = buildGroup(w.input(w.reader(wX)))
  t.alike(g.posts.map((p) => p.text), ['p4'], 'readable')
  t.is(g.epoch, null, 'never eligible for sending')
  t.is(g.rekeyPending, true)
})

test('a writer a demotion omitted reads but never distributes for sending', (t) => {
  const w = pworld()
  w.add(A, wA2)
  const demote = w.push(G, groupAdmin({ member: A, on: false, cuts: [], at: AT(6) }))
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA2, seq: 1 }], at: AT(7) }))
  // wA, cut at 0 for sending, rotates after the demotion it covers.
  const E2 = w.rotate(wA, [G, wA2, wX, wY], { basis: [demote], at: 8 })
  sealedPost(w, wX, E2, 9)
  const g = epochFor(w)
  t.ok(g.admins.has(A), 'A is an admin again through wA2')
  t.alike(g.posts.map((p) => p.text), ['p9'], 'readable')
  t.not(kidOf(g.epoch), kidOf(E2), 'never eligible for sending')
})

test('a reading-only continuation never changes sending eligibility', (t) => {
  const w = pworld()
  const demote = w.push(G, groupAdmin({ member: A, on: false, cuts: [], at: AT(6) }))
  const E2 = w.rotate(G, [G, wX, wY], { basis: [demote], at: 7 })
  t.is(kidOf(epochFor(w).epoch), kidOf(E2))
  // wA, omitted by the demotion, still reads; it names a stranger in E2.
  w.push(wA, groupKey({ kid: E2, keys: [{ writer: K(0xdead), sealed: b4a.toString(b4a.alloc(96, 1), 'base64') }], at: AT(8) }))
  const g = epochFor(w)
  t.is(kidOf(g.epoch), kidOf(E2), 'still eligible')
  t.is(g.rekeyPending, false)
  // A continuation from a valid distributor still counts as before.
  w.add(X, wX2)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }, { writer: wX2, seq: 1 }], at: AT(9) }))
  w.push(G, groupKey({ kid: E2, keys: [w.entry(wX2, E2, w.keyOf(E2))], at: AT(10) }))
  t.is(kidOf(buildGroup(w.input(w.reader(wX2))).epoch), kidOf(E2), 'the new device holds E2 and may send')
})

test('a departed admin cannot hand itself power for its next leave set', (t) => {
  const w = pworld()
  const l1 = leaveOn(w, wA, 6)
  const E2 = w.rotate(G, [G, wX, wY], { basis: [l1], at: 7 })
  w.add(A, wA2, { rejoin: l1 })
  // After its leave, on its granted writer, a block naming its rejoin writer.
  w.push(wA, groupKey({ kid: null, keys: [w.entry(wA2, { writer: wA, seq: w.len(wA) }, newEpochKey())], commit: 'c'.repeat(64), at: AT(8) }))
  leaveOn(w, wA2, 9)
  const g = epochFor(w)
  t.alike(g.removals, [l1])
  t.is(kidOf(g.epoch), kidOf(E2))
  t.is(g.rekeyPending, false)
})

test('a diary never hands itself power through a block that survives its leave', (t) => {
  const wA1 = K(0x204)
  const w = pworld()
  w.add(A, wA1)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA1, seq: 1 }], at: AT(5.5) }))
  const l1 = leaveOn(w, wA, 6)
  const E2 = w.rotate(G, [G, wX, wY], { basis: [l1], at: 7 })
  w.add(A, wA2, { rejoin: l1 })
  const after = sealedPost(w, wA2, E2, 8)
  // On its other granted writer, ordered after the rejoin (so not withdrawn).
  w.push(wA1, groupKey({ kid: null, basis: [after], keys: [w.entry(wA2, { writer: wA1, seq: w.len(wA1) }, newEpochKey())], commit: 'c'.repeat(64), at: AT(8.5) }))
  leaveOn(w, wA2, 9)
  const g = epochFor(w)
  t.alike(g.removals, [l1])
  t.is(kidOf(g.epoch), kidOf(E2))
})

test('a forged continuation can only hand the committed key', (t) => {
  const w = pworld()
  const l1 = leaveOn(w, wA, 6)
  const E2 = w.rotate(G, [G, wX, wY], { basis: [l1], at: 7 })
  w.add(B, wB)
  w.push(G, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(8) }))
  // The departed admin, its grant never revoked, hands the new member a key
  // of its own choosing for E2, backdated before the real delivery.
  const forged = newEpochKey()
  w.push(wA, groupKey({ kid: E2, keys: [w.entry(wB, E2, forged)], at: AT(9) }))
  w.push(G, groupKey({ kid: E2, keys: [w.entry(wB, E2, w.keyOf(E2))], at: AT(12) }))
  sealedPost(w, wX, E2, 13)
  w.seal(wA, E2, groupPost({ text: 'forged', at: AT(14) }), forged)
  const got = []
  const reader = w.reader(wB)
  reader.onKey = (kid, key) => got.push(b4a.equals(key, w.keyOf(E2)))
  const g = buildGroup(w.input(reader))
  t.alike(g.posts.map((p) => p.text), ['p13'], 'the real key opens the real post')
  t.is(g.sealed, 2, 'the sealed meta of E1 and the forged envelope stay sealed')
  t.alike(got, [true], 'onKey hands only the real key')
  t.is(kidOf(g.epoch), kidOf(E2))
})

test('a flood of reading-only epochs is never opened nor handed on', (t) => {
  const w = pworld()
  const l1 = leaveOn(w, wA, 6)
  const E2 = w.rotate(G, [G, wX, wY], { basis: [l1], at: 7 })
  // The departed admin, grant never revoked, writes epochs sealed to the root.
  for (let i = 0; i < 50; i++) w.rotate(wA, [G], { at: 8 + i / 100 })
  const reader = w.reader(G)
  const unseal = reader.unseal
  let calls = 0
  reader.unseal = (s) => {
    calls++
    return unseal(s)
  }
  const got = []
  reader.onKey = (kid) => got.push(kidOf(kid))
  const g = buildGroup(w.input(reader))
  t.alike(got, [kidOf(w.E1), kidOf(E2)], 'onKey reports only epochs valid for sending')
  t.is(calls, 2, 'no reading-only epoch without content is opened')
  t.is(kidOf(g.epoch), kidOf(E2))
  t.is(g.name, 'Segredo')
})

test('a demoted admin epoch stays readable to its holders but is never handed on', (t) => {
  const w = pworld()
  const E2 = w.rotate(wA, [G, wA, wX, wY], { at: 6 })
  sealedPost(w, wX, E2, 7)
  w.push(G, groupAdmin({ member: A, on: false, cuts: [], at: AT(8) }))
  const reader = w.reader(wX)
  const got = []
  reader.onKey = (kid) => got.push(kidOf(kid))
  const g = buildGroup(w.input(reader))
  t.alike(g.posts.map((p) => p.text), ['p7'], 'readable: a counted envelope names it')
  t.alike(got, [kidOf(w.E1)], 'only the epoch valid for sending is reported')
})

test('an old writer of a departed distributor never distributes for sending after a rejoin', (t) => {
  const wA1 = K(0x204)
  const wC2 = K(0x102)
  const wC3 = K(0x103)
  const scenario = (label, setup) => {
    const w = pworld()
    const { attackerWriter, legit } = setup(w)
    const evil = w.rotate(attackerWriter, [G, wX, wY].filter((x) => x !== attackerWriter), { basis: w.basis, at: 20 })
    const got = []
    const reader = w.reader(wX)
    reader.onKey = (kid) => got.push(kidOf(kid))
    const g = buildGroup(w.input(reader))
    t.is(kidOf(g.epoch), kidOf(legit), label + ': the legit epoch stays')
    t.is(g.rekeyPending, false, label)
    t.absent(got.includes(kidOf(evil)), label + ': never handed on')
  }
  scenario('the writer that left', (w) => {
    const l1 = leaveOn(w, wA, 6)
    w.basis = [l1]
    const legit = w.rotate(G, [G, wX, wY], { basis: [l1], at: 7 })
    w.add(A, wA2, { rejoin: l1 })
    return { attackerWriter: wA, legit }
  })
  scenario('another listed writer that never left', (w) => {
    w.add(A, wA1)
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA1, seq: 1 }], at: AT(5.5) }))
    const l1 = leaveOn(w, wA, 6)
    w.basis = [l1]
    const legit = w.rotate(G, [G, wX, wY], { basis: [l1], at: 7 })
    w.add(A, wA2, { rejoin: l1 })
    return { attackerWriter: wA1, legit }
  })
  scenario('the root of a creator who left', (w) => {
    w.add(C, wC2)
    const l1 = leaveOn(w, wC2, 6, { cuts: [{ writer: G, seq: w.len(G) }, { writer: wC2, seq: 1 }] })
    w.basis = [l1]
    const legit = w.rotate(wA, [wA, wX, wY], { basis: [l1], at: 7 })
    w.add(C, wC3, { rejoin: l1 })
    return { attackerWriter: G, legit }
  })
})

test('a rejoined admin regranted on its new writer distributes again', (t) => {
  const w = pworld()
  const l1 = leaveOn(w, wA, 6)
  w.rotate(G, [G, wX, wY], { basis: [l1], at: 7 })
  w.add(A, wA2, { rejoin: l1 })
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA2, seq: 1 }], at: AT(8) }))
  const E3 = w.rotate(wA2, [G, wA2, wX, wY], { at: 9 })
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  t.is(kidOf(buildGroup(w.input(reader)).epoch), kidOf(E3))
  t.ok(got.includes(kidOf(E3)))
})

const wA4 = K(0x205)
const wA5 = K(0x206)
const wY4 = K(0x503)
const seenRejoin = (writer) => ({ writer, seq: 0 })

test('an old sibling writer stays out of the entitled set whatever it appends after a rejoin', (t) => {
  const wA1 = K(0x204)
  const w = pworld()
  w.add(A, wA1)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA1, seq: 1 }], at: AT(5.5) }))
  t.alike(buildGroup(w.input()).entitled, [G, wA, wA1, wX, wY].sort(), 'control: an admin that never left keeps every granted writer')
  const l1 = leaveOn(w, wA, 6)
  const E2 = w.rotate(G, buildGroup(w.input()).entitled, { basis: [l1], at: 7 })
  w.add(A, wA2, { rejoin: l1 })
  // On the old sibling, a record ordered after the rejoin.
  w.push(wA1, groupAdmit({ member: X, on: true, cuts: [], seen: seenRejoin(wA2), at: AT(8) }))
  const g = epochFor(w)
  t.absent(g.entitled.includes(wA1), 'the old sibling is not entitled')
  t.absent(g.entitled.includes(wA) || g.entitled.includes(wA2))
  t.is(kidOf(g.epoch), kidOf(E2))
  // Regranted on its rejoin writer, the admin counts again there only.
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA2, seq: 1 }], at: AT(9) }))
  const r = buildGroup(w.input())
  t.ok(r.entitled.includes(wA2), 'control: the rejoin writer once a grant lists it')
  t.absent(r.entitled.includes(wA1))
})

test('a device bound before the latest rejoin never re-enters through an old grant', (t) => {
  const w = pworld()
  const l1 = leaveOn(w, wA, 6)
  w.add(A, wA2, { rejoin: l1 })
  w.add(A, wA4)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA2, seq: 1 }, { writer: wA4, seq: 1 }], at: AT(7) }))
  // A device with no record yet is retired (a rule from before this fix);
  // once it writes, its grant counts.
  w.push(wA4, groupAdmit({ member: X, on: true, cuts: [], seen: { writer: G, seq: w.len(G) - 1 }, at: AT(7.5) }))
  t.ok(buildGroup(w.input()).entitled.includes(wA4), 'control: a new device bound after the rejoin, once granted')
  const l2 = leaveOn(w, wA2, 8)
  w.add(A, wA5, { rejoin: l2 })
  w.push(wA4, groupAdmit({ member: X, on: true, cuts: [], seen: seenRejoin(wA5), at: AT(30) }))
  const g = buildGroup(w.input())
  t.absent(g.entitled.includes(wA4), 'bound before the latest rejoin')
  t.absent(g.entitled.includes(wA5), 'no grant lists the new rejoin writer yet')
})

test('community power on an old G writer ends with its diary leave', (t) => {
  const wA1 = K(0x204)
  const w = cworld()
  w.add(A, wA1)
  t.ok(buildGroup(w.input()).entitled.includes(wA1), 'control: every live writer of a community admin')
  const l1 = leaveOn(w, wA, 6)
  w.add(A, wA2, { rejoin: l1 })
  w.push(wA1, groupAdmit({ member: X, on: true, cuts: [], seen: seenRejoin(wA2), at: AT(8) }))
  const g = buildGroup(w.input())
  t.absent(g.entitled.includes(wA1))
  t.ok(g.entitled.includes(wA2), 'the rejoin writer')
})

test('a creator who left and rejoined is entitled only on its rejoin writer', (t) => {
  const wC2 = K(0x102)
  const wC3 = K(0x103)
  const w = pworld()
  w.add(C, wC2)
  const l1 = leaveOn(w, wC2, 6, { cuts: [{ writer: G, seq: w.len(G) }, { writer: wC2, seq: 1 }] })
  w.add(C, wC3, { rejoin: l1 })
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], seen: seenRejoin(wC3), at: AT(8) }))
  const g = buildGroup(w.input())
  t.ok(g.entitled.includes(wC3))
  t.absent(g.entitled.includes(G) || g.entitled.includes(wC2), 'the old root and device')
})

test('a member new device after a rejoin is entitled once a current admit lists it', (t) => {
  const w = pworld()
  const l1 = leaveOn(w, wY, 6)
  w.add(Y, wY2, { rejoin: l1 })
  w.add(Y, wY4)
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY2, seq: 1 }], at: AT(7) }))
  let g = buildGroup(w.input())
  t.ok(g.entitled.includes(wY2))
  t.absent(g.entitled.includes(wY4), 'pending until an admit lists it')
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY2, seq: 1 }, { writer: wY4, seq: 1 }], at: AT(8) }))
  g = buildGroup(w.input())
  t.ok(g.entitled.includes(wY4))
})

test('leaving ends the nomination: a pre-leave grant never counts again, whatever the join order', (t) => {
  const wA1 = K(0x204)
  const wK2 = K(0x207)
  const w = pworld()
  w.add(A, wA1)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA1, seq: 1 }], at: AT(5.5) }))
  const l1 = leaveOn(w, wA, 6)
  const E2 = w.rotate(G, buildGroup(w.input()).entitled, { basis: [l1], at: 7 })
  // K2, its join placed before wA1's in A's own diary, rejoins after L1.
  w.add(A, wK2, { rejoin: l1 })
  const list = w.joins.get(A)
  list.find((j) => j.writer === wK2).seq = 0
  w.push(wA1, groupAdmit({ member: X, on: true, cuts: [], seen: { writer: wK2, seq: 0 }, at: AT(8) }))
  const evil = w.rotate(wA1, [G, wX, wY], { basis: [l1], at: 20 })
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  const g = buildGroup(w.input(reader))
  t.absent(g.entitled.includes(wA1), 'never entitled')
  t.absent(g.entitled.includes(wK2), 'no event lists the rejoin writer')
  t.is(kidOf(g.epoch), kidOf(E2), 'its block is never the eligible epoch')
  t.absent(got.includes(kidOf(evil)))
})

test('honest re-admission and re-grant after a rejoin count; a later leave ends them', (t) => {
  const w = pworld()
  const ly = leaveOn(w, wY, 6)
  w.add(Y, wY2, { rejoin: ly })
  t.absent(buildGroup(w.input()).entitled.includes(wY2), 'no new admit yet')
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY2, seq: 1 }], at: AT(7) }))
  t.ok(buildGroup(w.input()).entitled.includes(wY2), 'an admit listing the rejoin writer')

  const la = leaveOn(w, wA, 8)
  w.add(A, wA2, { rejoin: la })
  // The old writer cut past the leave proves the grant saw it.
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: la.seq + 1 }, { writer: wA2, seq: 0 }], at: AT(9) }))
  let g = buildGroup(w.input())
  t.ok(g.entitled.includes(wA2), 'a grant whose cut on the old writer is past the leave')
  t.ok(g.admins.has(A))

  // Leaving again voids the re-admission and the re-grant.
  leaveOn(w, wY2, 10)
  leaveOn(w, wA2, 11)
  g = buildGroup(w.input())
  t.absent(g.entitled.includes(wY2) || g.entitled.includes(wA2))
})

test('a member who backdates its leave under an honest admit is not entitled after rejoining', (t) => {
  const w = pworld({ base: false })
  w.add(A, wA).add(Y, wY)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  w.rotate(G, [G, wA], { at: 2 })
  // Y writes a leave dated before the admit that the admin writes without
  // seeing it (its cut on wY stops before the leave).
  const ly = leaveOn(w, wY, 3)
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(10) }))
  w.add(Y, wY2, { rejoin: ly })
  const g = buildGroup(w.input())
  t.absent(g.entitled.includes(wY2), 'the admit never saw the leave')
  t.absent(g.entitled.includes(wY))
})

test('a departed admin pre-leave epoch is still handed on as history', (t) => {
  const w = pworld()
  const E2 = w.rotate(wA, [G, wA, wX, wY], { at: 5.5 })
  const la = leaveOn(w, wA, 6)
  w.rotate(G, [G, wX, wY], { basis: [la], at: 7 })
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  buildGroup(w.input(reader))
  t.ok(got.includes(kidOf(E2)))
})

test('an admin admitting its own diary before leaving never entitles it after the rejoin', (t) => {
  for (const [label, cuts] of [
    ['a pre-bound rejoin writer', [{ writer: wA, seq: 1 }, { writer: wA2, seq: 1 }]],
    ['an inflated cut on the leaving writer', [{ writer: wA, seq: 1000 }, { writer: wA2, seq: 0 }]]
  ]) {
    const w = pworld()
    w.push(wA, groupAdmit({ member: A, on: true, cuts, at: AT(5) }))
    const l1 = leaveOn(w, wA, 6)
    const E2 = w.rotate(G, [G, wX, wY], { basis: [l1], at: 7 })
    w.add(A, wA2, { rejoin: l1 })
    const g = epochFor(w)
    t.absent(g.entitled.includes(wA2), label + ': not entitled')
    t.is(kidOf(g.epoch), kidOf(E2), label)
  }
  // An admit of another diary by that admin still counts.
  const w = pworld()
  const ly = leaveOn(w, wY, 6)
  w.add(Y, wY2, { rejoin: ly })
  w.push(wA, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY2, seq: 1 }], at: AT(7) }))
  t.ok(buildGroup(w.input()).entitled.includes(wY2), 'an admit by another admin')
})

test('a forged cycle never makes an epoch cover the leave it precedes', (t) => {
  const wA1 = K(0x204)
  const w = pworld()
  w.add(A, wA1)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA1, seq: 1 }], at: AT(5) }))
  // F at wA:1 names wA1:1, a continuation of F that names the leave wA:2.
  const F = { writer: wA, seq: 1 }
  const key = newEpochKey()
  w.epochs.set(wA + ':1', key)
  w.push(wA, groupKey({ kid: null, basis: [{ writer: wA1, seq: 1 }], keys: [G, wX, wY].map((x) => w.entry(x, F, key)), commit: cm(key, F), at: AT(6) }))
  const leave = leaveOn(w, wA, 7)
  w.push(wA1, groupKey({ kid: F, basis: [leave], keys: [w.entry(wX, F, key)], at: AT(8) }))
  w.add(A, wA2, { rejoin: leave, at: 9 })
  let g = epochFor(w)
  t.absent(g.members.get(A) === 'left', 'the rejoin counts')
  t.not(kidOf(g.epoch), kidOf(F), 'the cycle does not cover the leave')
  t.is(g.epoch, null)
  t.is(g.rekeyPending, true)
  const E3 = w.rotate(G, g.entitled, { basis: g.removals, at: 9 })
  g = epochFor(w)
  t.is(kidOf(g.epoch), kidOf(E3), 'a fresh authorized epoch covers it')
})

test('a leave with forward references never hides from the rotation that names it', (t) => {
  // Forward `seen` to the root's next seq and a far `at`.
  {
    const w = pworld()
    const L = leaveOn(w, wY, 1000, { seen: { writer: G, seq: w.len(G) } })
    const F = w.rotate(G, [G, wA, wX], { basis: [L], at: 10 })
    const g = epochFor(w)
    t.is(kidOf(g.epoch), kidOf(F), 'forward seen: the rotation naming the leave is eligible')
    t.is(g.rekeyPending, false)
  }
  // A forward root cut in the leave, the root growing past it.
  {
    const w = pworld()
    const k = w.len(G)
    const L = leaveOn(w, wY, 1000, { cuts: [{ writer: wY, seq: w.len(wY) }, { writer: G, seq: k + 10 }] })
    const F = w.rotate(G, [G, wA, wX], { basis: [L], at: 10 })
    for (let i = 0; i < 12; i++) w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(11 + i) }))
    const E3 = w.rotate(G, [G, wA, wX], { at: 30 })
    const g = epochFor(w)
    t.ok([kidOf(F), kidOf(E3)].includes(kidOf(g.epoch)), 'forward cut: covered')
    t.is(kidOf(g.epoch), kidOf(E3), 'and its descendants')
  }
  // Continuations written before the leave whose kids name future root seqs.
  {
    const w = pworld()
    const k = w.len(G)
    w.push(wY, groupKey({ kid: { writer: G, seq: k }, keys: [w.entry(wY, { writer: G, seq: k }, newEpochKey())], at: AT(20) }))
    const L = leaveOn(w, wY, 1000)
    const F = w.rotate(G, [G, wA, wX], { basis: [L], at: 10 })
    const g = epochFor(w)
    t.is(kidOf(g.epoch), kidOf(F), 'future kids: covered')
  }
})

test('a pre-leave epoch listing its own future leave never covers it', (t) => {
  const w = pworld()
  const key = newEpochKey()
  const F = { writer: wA, seq: 1 }
  w.epochs.set(wA + ':1', key)
  w.push(wA, groupKey({ kid: null, basis: [{ writer: wA, seq: 2 }], keys: [G, wX, wY].map((x) => w.entry(x, F, key)), commit: cm(key, F), at: AT(6) }))
  const L = leaveOn(w, wA, 7)
  w.add(A, wA2, { rejoin: L, at: 9 })
  const g = epochFor(w)
  t.not(kidOf(g.epoch), kidOf(F))
  t.is(g.rekeyPending, true)
})

// Alternating leaves and key blocks on a departed admin's writer: the
// sending pass stays linear.
function leaveKeyStorm (pairs) {
  const w = pworld()
  for (let i = 0; i < pairs; i++) {
    leaveOn(w, wA, 6 + i / 1000)
    w.rotate(wA, [G], { at: 6 + i / 1000 + 0.0001 })
  }
  const input = w.input(w.reader(wX))
  let best = Infinity
  let g = null
  for (let i = 0; i < 2; i++) {
    const start = Date.now()
    g = buildGroup(input)
    best = Math.min(best, Date.now() - start)
  }
  return { g, ms: best, E1: w.E1 }
}

test('alternating leaves and key blocks fold in linear time', (t) => {
  const small = leaveKeyStorm(1500)
  const big = leaveKeyStorm(6000)
  t.is(big.g.members.get(A), 'left')
  t.ok(big.ms < 5000, 'folded in ' + big.ms + ' ms')
  t.ok(big.ms < 6 * Math.max(small.ms, 5), big.ms + ' ms against ' + small.ms + ' ms for a quarter')
})

test('a community demotion of a diary that keeps power in G takes nothing away', (t) => {
  const w = pworld({ cadmins: [A, Z] })
  w.add(Z, wZ)
  w.cgrant(A, false, { at: 6 })
  let g = buildGroup(w.input(w.reader(wX)))
  t.is(g.rekeyPending, false, 'A keeps its G grant')
  t.is(kidOf(g.epoch), kidOf(w.E1))
  t.alike(g.removals, [])
  const E2 = w.rotate(G, g.entitled, { at: 7 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2), 'and it still rotates')
  // A community-only admin demoted in the community is a requirement.
  const dz = w.cgrant(Z, false, { at: 8 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(g.rekeyPending, true)
  t.alike(g.removals, [dz])
})

test('a community admin back in G never distributes from an old sibling writer', (t) => {
  const wZ2 = K(0x701)
  const wZ3 = K(0x702)
  const w = cworld({ cadmins: [A, Z] })
  w.add(Z, wZ).add(Z, wZ2)
  t.ok(buildGroup(w.input()).entitled.includes(wZ2), 'control: listed while Z never left')
  const L = leaveOn(w, wZ, 6)
  const legit = w.rotate(G, buildGroup(w.input()).entitled, { basis: [L], at: 6.5 })
  w.add(Z, wZ3, { rejoin: L, at: 7 })
  w.push(wZ2, groupAdmit({ member: X, on: true, cuts: [], seen: { writer: wZ3, seq: 0 }, at: AT(8) }))
  const evil = w.rotate(wZ2, [G, wA, wX], { basis: [L], auth: w.cauth(Z), at: 20 })
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  const g = buildGroup(w.input(reader))
  t.ok(g.entitled.includes(wZ3), 'the rejoin writer of a community admin')
  t.absent(g.entitled.includes(wZ2), 'the old device stays out')
  t.is(kidOf(g.epoch), kidOf(legit))
  t.absent(got.includes(kidOf(evil)), 'its block is never valid for sending')
})

test('a grant withdrawn by the creator leave gives no sending power', (t) => {
  const w = pworld()
  const grant = w.push(G, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(5.5) }))
  // The creator leaves from the root, withdrawing X's grant; A's earlier
  // grant survives.
  const L = w.push(G, groupLeave({ cuts: [{ writer: G, seq: grant.seq }], at: AT(6) }))
  let g = buildGroup(w.input())
  t.ok(g.admins.has(A))
  t.absent(g.admins.has(X), 'the grant is withdrawn')
  const E2 = w.rotate(wA, g.entitled, { basis: [L], at: 7 })
  sealedPost(w, wY, E2, 8)
  t.is(kidOf(epochFor(w).epoch), kidOf(E2))
  w.push(wX, groupKey({ kid: E2, keys: [{ writer: K(0xdead), sealed: b4a.toString(b4a.alloc(96, 1), 'base64') }], at: AT(9) }))
  const evil = w.rotate(wX, [wA, wX, wY], { basis: [L], at: 10 })
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  g = buildGroup(w.input(reader))
  t.is(kidOf(g.epoch), kidOf(E2), 'the legit epoch stays eligible')
  t.is(g.rekeyPending, false)
  t.absent(got.includes(kidOf(evil)), 'X never distributes for sending')
  t.alike(g.posts.map((p) => p.text), ['p8'])
})

test('a departed admin moderates nothing through its old grant', (t) => {
  const wA1 = K(0x204)
  const w = pworld()
  w.add(A, wA1)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA1, seq: 1 }], at: AT(5.5) }))
  const L = leaveOn(w, wA, 6)
  w.rotate(G, buildGroup(w.input()).entitled, { basis: [L], at: 6.5 })
  w.add(A, wA2, { rejoin: L, at: 7 })
  w.add(B, wB)
  // On the other old writer, ordered after the rejoin.
  w.push(wA1, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen: { writer: wA2, seq: 0 }, at: AT(8) }))
  let g = buildGroup(w.input())
  t.is(g.members.get(B), 'requested', 'never admitted')
  t.absent(g.entitled.includes(wB))
  t.absent(g.entitled.includes(wA) || g.entitled.includes(wA1) || g.entitled.includes(wA2))
  const E3 = w.rotate(G, g.entitled, { basis: g.removals, at: 9 })
  t.absent(w.logs.get(G).entries[E3.seq].record.keys.some((k) => k.writer === wB), 'the next rotation does not seal to B')

  // Re-granted on its rejoin writer, the returning admin admits again.
  const grant = w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA2, seq: 1 }], at: AT(10) }))
  w.push(wA2, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], seen: grant, at: AT(11) }))
  g = buildGroup(w.input())
  t.is(g.members.get(B), 'member', 'control: admitted by the re-granted admin')
  t.ok(g.entitled.includes(wB))
})

test('a basis ref past the end or forward into its own writer never pre-covers a removal', (t) => {
  // Past the end of the root.
  {
    const w = pworld()
    const E2 = w.rotate(wA, [G, wA, wX], { basis: [{ writer: G, seq: Number.MAX_SAFE_INTEGER }], at: 6 })
    t.is(kidOf(epochFor(w).epoch), kidOf(E2))
    const ban = w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(7) }))
    let g = epochFor(w)
    t.is(g.epoch, null, 'past the end: the ban is not covered')
    t.is(g.rekeyPending, true)
    const E3 = w.rotate(G, [G, wA, wX], { basis: [ban], at: 8 })
    g = epochFor(w)
    t.is(kidOf(g.epoch), kidOf(E3), 'an honest lister covers it')
  }
  // A forward ref into the lister's own writer.
  {
    const w = pworld()
    const E2 = w.rotate(wA, [G, wA, wX], { basis: [{ writer: wA, seq: w.len(wA) + 3 }], at: 6 })
    w.push(wA, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(6.5) }))
    w.push(wA, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(7) }))
    w.push(wA, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(7.5) }))
    t.ok(w.len(wA) - 1 >= E2.seq + 3, 'the named seq now exists')
    const g = epochFor(w)
    t.is(g.epoch, null, 'same-writer forward ref: not covered')
    t.is(g.rekeyPending, true)
  }
})

test('decrypted edges never make a departed admin post visible', (t) => {
  const wA1 = K(0x204)
  const w = pworld()
  w.add(A, wA1)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA1, seq: 1 }], at: AT(5.5) }))
  // Q on wA1 names P, the next block of wA, in its sealed `seen`.
  w.seal(wA1, w.E1, groupPost({ text: 'Q', seen: { writer: wA, seq: 1 }, at: AT(6) }))
  const L = leaveOn(w, wA1, 7)
  w.add(A, wA2, { rejoin: L, at: 8 })
  w.seal(wA, w.E1, groupPost({ text: 'P', at: AT(9) }))
  const g = buildGroup(w.input(w.reader(wX)))
  const P = g.posts.find((p) => p.text === 'P')
  t.ok(P, 'opened')
  t.is(P.hidden, true, 'P stays hidden')
  // Control: an admin that never left posts visibly.
  const v = pworld()
  sealedPost(v, wA, v.E1, 6)
  t.alike(visible(buildGroup(v.input(v.reader(wX)))), [wA + ':1'])
})

test('a departed admin that rejoined without a new grant is no admin in any view', (t) => {
  const w = pworld()
  const L = leaveOn(w, wA, 6)
  w.add(A, wA2, { rejoin: L, at: 7 })
  let g = buildGroup(w.input())
  t.is(g.members.get(A), 'requested')
  t.ok(g.requests.includes(A))
  t.absent(g.admins.has(A))
  w.push(G, groupBan({ member: A, on: true, cuts: [{ writer: wA2, seq: 1 }], at: AT(8) }))
  g = buildGroup(w.input())
  t.is(g.members.get(A), 'banned', 'not shielded')

  const v = pworld()
  const L2 = leaveOn(v, wA, 6)
  v.add(A, wA2, { rejoin: L2, at: 7 })
  v.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA2, seq: 1 }], at: AT(8) }))
  g = buildGroup(v.input())
  t.ok(g.admins.has(A), 're-granted: an admin again')
  t.is(g.members.get(A), 'member')
})

test('group-key auth shapes: the cited CW length is at least 1', (t) => {
  const w = pworld({ base: false }).add(X, wX)
  const kid = { writer: G, seq: 1 }
  const key = newEpochKey()
  const opts = { private: true }
  const k = groupKey({ kid: null, keys: [w.entry(wX, kid, key)], auth: { writer: CM, seq: 1 }, commit: cm(key, kid), at: AT(1) })
  t.alike(Object.keys(k), ['type', 'kid', 'basis', 'keys', 'auth', 'commit', 'at'])
  t.is(validateGroupRecord(k, 1, opts), null)
  t.is(validateGroupRecord({ ...k, auth: null }, 1, opts), null)
  t.is(validateGroupRecord({ ...k, auth: { writer: CM, seq: 0 } }, 1, opts), 'malformed', 'seq 0')
  t.is(validateGroupRecord({ ...k, auth: { writer: CM, seq: 1.5 } }, 1, opts), 'malformed')
  t.is(validateGroupRecord({ ...k, auth: { writer: 'x', seq: 1 } }, 1, opts), 'malformed')
  t.is(validateGroupRecord({ ...k, auth: { writer: CM, seq: 1, x: 1 } }, 1, opts), 'malformed')
  const { auth, ...bare } = k
  t.is(validateGroupRecord(bare, 1, opts), 'malformed', 'auth is required')
  const cont = groupKey({ kid, keys: k.keys, auth: { writer: CM, seq: 2 }, at: AT(1) })
  t.alike(Object.keys(cont), ['type', 'kid', 'basis', 'keys', 'auth', 'at'])
  t.is(validateGroupRecord(cont, 1, opts), null)
})

test('auth citing the CW length right after a promotion reads and sends', (t) => {
  const w = cworld()
  t.is(w.comm.len(w.cwOf(A)), 1, 'A wrote nothing in its CW since the grant')
  const E = w.rotate(wA, [G, wA, wX], { auth: { writer: w.cwOf(A), seq: 1 }, at: 3 })
  sealedPost(w, wX, E, 4)
  let g = buildGroup(w.input(w.reader(wX)))
  t.alike(g.posts.map((p) => p.text), ['p4'])
  t.is(kidOf(g.epoch), kidOf(E))
  const bare = w.rotate(wA, [G, wA, wX], { at: 5 })
  sealedPost(w, wX, bare, 6)
  g = buildGroup(w.input(w.reader(wX)))
  t.is(g.sealed, 1, 'a block with auth null from a diary without G authority counts for nothing')
  t.is(kidOf(g.epoch), kidOf(E))
})

test('auth after a demotion never sends; an older citation still reads', (t) => {
  const w = cworld()
  const cwA = w.cwOf(A)
  // A CW record with no effect (it names a group C never created).
  w.comm.push(cwA, communityAdmit({ group: K(0x999), member: X, on: true, cuts: [], at: AT(3) }))
  t.is(w.comm.len(cwA), 2)
  const before = w.rotate(wA, [G, wA, wX], { auth: { writer: cwA, seq: 2 }, at: 3.5 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(before), 'control: valid before the demotion')
  w.cgrant(A, false, { at: 4 })
  t.is(w.comm.logs.get(CM).entries[w.comm.len(CM) - 1].record.cuts[0].seq, 2, 'the demotion cuts at 2')
  const late = w.rotate(wA, [G, wA, wX], { auth: { writer: cwA, seq: 2 }, at: 5 })
  const old = w.rotate(wA, [G, wA, wX], { auth: { writer: cwA, seq: 1 }, at: 6 })
  sealedPost(w, wX, late, 7)
  sealedPost(w, wX, old, 8)
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  const g = buildGroup(w.input(reader))
  t.alike(g.posts.map((p) => p.text), ['p7', 'p8'], 'both read (the accepted residual)')
  t.is(g.epoch, null, 'nobody sends under a demoted admin')
  t.is(g.rekeyPending, true)
  t.absent(got.includes(kidOf(late)) || got.includes(kidOf(old)), 'never handed on')
})

test('a grant and a demotion at the same CW length keep earlier blocks readable', (t) => {
  const w = cworld()
  const E = w.rotate(wA, [G, wA, wX], { auth: w.cauth(A), at: 3 })
  sealedPost(w, wX, E, 4)
  const demote = w.cgrant(A, false, { at: 5 })
  const root = w.comm.logs.get(CM).entries
  t.is(root[demote.seq].record.cuts[0].seq, 1)
  t.ok(root.some((e) => e.record.type === 'group-admin' && e.record.on && e.record.cuts[0].seq === 1), 'the grant cut at the same length')
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  const g = buildGroup(w.input(reader))
  t.alike(g.posts.map((p) => p.text), ['p4'], 'history stays readable')
  t.is(g.epoch, null)
  t.alike(got, [], 'a reading-only epoch is never handed on')
})

test('auth citing a length beyond the held CW, or a CW of another diary, is ignored', (t) => {
  for (const [label, auth] of [
    ['beyond the held length', (w) => ({ writer: w.cwOf(A), seq: 2 })],
    ['another diary CW', (w) => ({ writer: w.cwOf(X), seq: 1 })],
    ['the root of C, not the creator', () => ({ writer: CM, seq: 1 })],
    ['a core outside C', () => ({ writer: K(0x9999), seq: 1 })]
  ]) {
    const w = cworld()
    const E = w.rotate(wA, [G, wA, wX], { auth: auth(w), at: 3 })
    sealedPost(w, wX, E, 4)
    const g = buildGroup(w.input(w.reader(wX)))
    t.alike(g.posts, [], label + ': nothing opens')
    t.is(g.sealed, 1, label)
    t.is(g.epoch, null, label)
  }
})

test('auth from a diary with G authority is ignored: G authority decides', (t) => {
  const w = pworld()
  const E2 = w.rotate(wA, [G, wA, wX, wY], { auth: { writer: w.cwOf(X), seq: 1 }, at: 6 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E2), 'a G admin with a bogus auth still distributes')
  const E3 = w.rotate(G, [G, wA, wX, wY], { auth: { writer: K(0x9999), seq: 9 }, at: 7 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E3), 'and so does the creator')
})

test('a community ban is covered by a basis ref on the CW that holds it', (t) => {
  const w = pworld({ cadmins: [Z] })
  const cwZ = w.cwOf(Z)
  const cwY = w.cwOf(Y)
  const ban = w.comm.push(cwZ, communityBan({ member: Y, on: true, cuts: [{ writer: cwY, seq: w.comm.len(cwY) }], at: AT(6) }))
  let g = buildGroup(w.input(w.reader(wX)))
  t.is(g.members.get(Y), 'banned', 'banned in C, banned in G')
  t.absent(g.entitled.includes(wY))
  t.is(g.epoch, null)
  t.is(g.rekeyPending, true)
  t.alike(g.removals, [ban])
  const elsewhere = w.rotate(G, [G, wA, wX], { basis: [{ writer: CM, seq: w.comm.len(CM) - 1 }], at: 7 })
  g = buildGroup(w.input(w.reader(wX)))
  t.not(kidOf(g.epoch), kidOf(elsewhere), 'a ref on another C core covers nothing')
  t.is(g.rekeyPending, true)
  const E2 = w.rotate(G, [G, wA, wX], { basis: [ban], at: 8 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E2))
})

test('two concurrent removals on two CW cores are both required', (t) => {
  const w = pworld({ cadmins: [Z, B] })
  const cwX = w.cwOf(X)
  const cwY = w.cwOf(Y)
  const banY = w.comm.push(w.cwOf(Z), communityBan({ member: Y, on: true, cuts: [{ writer: cwY, seq: w.comm.len(cwY) }], at: AT(6) }))
  const offX = w.comm.push(w.cwOf(B), communityAdmit({ member: X, on: false, cuts: [{ writer: cwX, seq: w.comm.len(cwX) }], at: AT(6) }))
  let g = buildGroup(w.input(w.reader(wA)))
  t.alike(g.removals, [banY, offX].sort((a, b) => a.writer < b.writer ? -1 : 1))
  w.rotate(G, [G, wA, wX], { basis: [banY], at: 7 })
  g = buildGroup(w.input(w.reader(wA)))
  t.is(g.epoch, null, 'one of two')
  t.is(g.rekeyPending, true)
  const both = w.rotate(G, [G, wA, wX], { basis: [banY, offX], at: 8 })
  t.is(kidOf(buildGroup(w.input(w.reader(wA))).epoch), kidOf(both))
})

test('leaving the community leaves the group rekey-pending until a rotation covers the leave', (t) => {
  const w = cworld()
  const E1 = w.rotate(wA, [G, wA, wX], { auth: w.cauth(A), at: 3 })
  sealedPost(w, wX, E1, 3.5)
  const leave = w.cleave(A, 4)
  let g = buildGroup(w.input(w.reader(wX)))
  t.alike(g.posts.map((p) => p.text), ['p3.5'], 'what A handed out stays readable')
  t.absent(g.admins.has(A), 'a left community admin is no admin of G')
  t.is(g.members.get(A), 'left')
  t.is(g.rekeyPending, true)
  t.alike(g.removals, [leave])
  const E2 = w.rotate(G, [G, wX], { basis: [leave], at: 5 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2))
})

test('the creator of C, also G\'s creator, distributes from another G writer by G authority', (t) => {
  const w = pworld()
  const wC2 = K(0x110)
  w.add(C, wC2)
  t.is(w.cwOf(C), CM)
  // Its citation of C's root is ignored: G authority decides.
  const E2 = w.rotate(wC2, [G, wA, wX, wY, wC2], { auth: { writer: CM, seq: w.comm.len(CM) }, at: 6 })
  sealedPost(w, wX, E2, 7)
  let g = buildGroup(w.input(w.reader(wY)))
  t.ok(g.admins.has(C))
  t.ok(g.entitled.includes(wC2))
  t.alike(g.posts.map((p) => p.text), ['p7'])
  t.is(kidOf(g.epoch), kidOf(E2))
  const E3 = w.rotate(wC2, [G, wA, wX, wY, wC2], { auth: { writer: w.cwOf(X), seq: 1 }, at: 8 })
  g = buildGroup(w.input(w.reader(wY)))
  t.is(kidOf(g.epoch), kidOf(E3), 'nor does a CW of another diary take G authority away')

  // The old world (C's creator Z citing C's root in a G whose header names
  // C): G is an orphan and Z distributes nothing.
  const o = pworld({ cc: Z })
  o.add(Z, wZ)
  t.is(o.cwOf(Z), CM)
  o.rotate(wZ, [G, wA, wX, wY, wZ], { auth: { writer: CM, seq: o.comm.len(CM) }, at: 6 })
  const go = buildGroup(o.input(o.reader(wY)))
  t.is(go.orphan, true, 'only the community creator creates groups')
  t.alike(go.entitled, [])
  t.is(go.epoch, null)
  t.absent(go.admins.has(Z))
})

test('with the parent community missing nobody is entitled and a key holder is rekey-pending', (t) => {
  const w = pworld()
  sealedPost(w, wX, w.E1, 6)
  const g = buildGroup(w.input(w.reader(wX), { community: null }))
  t.is(g.community, null)
  t.is(g.orphan, false)
  t.is(g.incomplete, true)
  t.alike(g.entitled, [])
  t.is(g.epoch, null)
  t.is(g.rekeyPending, true)
  t.alike(g.posts.map((p) => p.text), ['p6'], 'readers still read')
  t.is(buildGroup(w.input(null, { community: null })).rekeyPending, false, 'no key held')
})

test('an orphan private group has no epoch', (t) => {
  const w = pworld()
  const ci = w.comm.input()
  const orphanC = { ...ci, root: { ...ci.root, entries: ci.root.entries.filter((e) => e.record.type !== 'group-create') } }
  const g = buildGroup(w.input(w.reader(wX), { community: orphanC }))
  t.is(g.orphan, true)
  t.is(g.community, null)
  t.alike(g.entitled, [])
  t.is(g.epoch, null)
  t.is(g.rekeyPending, true)
  t.is(g.name, 'Segredo', 'still readable')
})

test('a community admin ban inside G is a removal a basis ref on its CW covers', (t) => {
  const w = pworld({ cadmins: [Z] })
  const cwZ = w.cwOf(Z)
  const ban = w.comm.push(cwZ, communityBan({ group: G, member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(6) }))
  let g = buildGroup(w.input(w.reader(wX)))
  t.is(g.members.get(Y), 'banned', 'banned in G only')
  t.is(g.community.members.get(Y), 'member')
  t.alike(g.removals, [ban], 'a G-side record of the CW virtual log')
  t.is(g.rekeyPending, true)
  const E2 = w.rotate(G, [G, wA, wX], { basis: [ban], at: 7 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2))
})

test('a G admin demoted in G but still a community admin distributes through auth', (t) => {
  const w = pworld({ cadmins: [A] })
  const demote = w.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(6) }))
  let g = buildGroup(w.input(w.reader(wX)))
  t.ok(g.admins.has(A), 'still an admin of G through C')
  const E2 = w.rotate(wA, [G, wA, wX, wY], { basis: [demote], auth: w.cauth(A), at: 7 })
  sealedPost(w, wX, E2, 8)
  g = buildGroup(w.input(w.reader(wX)))
  t.alike(g.posts.map((p) => p.text), ['p8'])
  t.is(kidOf(g.epoch), kidOf(E2), 'the block past the G cut counts through the community')
  t.is(g.rekeyPending, false)
})

test('a demoted community admin needs a group admit for its posts, earlier ones included', (t) => {
  const w = pworld({ cadmins: [Z] })
  w.add(Z, wZ)
  sealedPost(w, wZ, w.E1, 6)
  let g = buildGroup(w.input(w.reader(wX)))
  t.alike(visible(g), [wZ + ':1'], 'a community admin posts without an admit')
  w.cgrant(Z, false, { at: 7 })
  g = buildGroup(w.input(w.reader(wX)))
  t.alike(visible(g), [], 'after the demotion its post needs an admit')
  t.is(g.members.get(Z), 'requested', 'its status follows C now')
  w.push(G, groupAdmit({ member: Z, on: true, cuts: [{ writer: wZ, seq: 1 }], at: AT(8) }))
  g = buildGroup(w.input(w.reader(wX)))
  t.alike(visible(g), [wZ + ':1'], 'admitted in G, visible again')
})

test('a community ban hides the banned distributor posts but its epoch still opens', (t) => {
  const w = pworld({ cadmins: [Z] })
  const E2 = w.rotate(wA, [G, wA, wX, wY], { at: 6 })
  sealedPost(w, wA, E2, 7)
  const cwA = w.cwOf(A)
  w.comm.push(w.cwOf(Z), communityBan({ member: A, on: true, cuts: [{ writer: cwA, seq: w.comm.len(cwA) }], at: AT(8) }))
  const g = buildGroup(w.input(w.reader(wX)))
  t.is(g.members.get(A), 'banned')
  t.is(g.sealed, 0, 'nothing stays sealed')
  t.alike(g.posts.map((p) => p.text + ':' + p.hidden), ['p7:true'], 'opened and hidden, as in a public group')
})

test('a departed group admin backdating an admit under its community leave entitles nobody', (t) => {
  const w = pworld()
  w.add(B, wB)
  w.cleave(A, 50)
  w.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(40) }))
  const g = buildGroup(w.input(w.reader(wX)))
  t.absent(g.entitled.includes(wB), 'the collaborator is never entitled')
  t.ok(g.requests.includes(B))
  const E2 = w.rotate(G, g.entitled, { basis: g.removals, at: 60 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E2), 'an honest rotation leaves it out and is eligible')
})

test('a G leave appended after a backdated admit never revives a departed admin authority', (t) => {
  const w = pworld()
  w.add(B, wB)
  w.cleave(A, 50)
  w.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(40) }))
  w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(45) }))
  const g = buildGroup(w.input(w.reader(wX)))
  t.absent(g.entitled.includes(wB), 'the collaborator is never entitled')
  t.ok(g.requests.includes(B))
})

test('a group creator out of the community cannot distribute; history stays readable', (t) => {
  // G's creator is C's creator: it leaves C on C's root.
  const w = pworld()
  sealedPost(w, wX, w.E1, 6)
  w.cleave(C, 50)
  const E2 = w.rotate(G, [G, wA, wX, wY], { at: 7 })
  sealedPost(w, wX, E2, 8)
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  const g = buildGroup(w.input(reader))
  t.alike(g.posts.map((p) => p.text), ['p6', 'p8'], 'both epochs still read')
  t.absent(got.includes(kidOf(E2)), 'the departed creator epoch is never handed on')
  t.absent(got.includes(kidOf(w.E1)), 'nor its earlier one: no authority after leaving')
  t.not(kidOf(g.epoch), kidOf(E2))
  t.is(g.name, null, 'its root rename no longer counts')
})

test('community leaves of a banned or unadmitted diary add no removal requirement', (t) => {
  // A member banned in C appending leaves to its CW.
  const w = pworld({ cadmins: [Z] })
  const cwY = w.cwOf(Y)
  const ban = w.comm.push(w.cwOf(Z), communityBan({ member: Y, on: true, cuts: [{ writer: cwY, seq: w.comm.len(cwY) }], at: AT(6) }))
  const E2 = w.rotate(G, [G, wA, wX], { basis: [ban], at: 7 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E2), 'control')
  w.cleave(Y, 8)
  w.cleave(Y, 9)
  const g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2), 'leaves under a C ban never reopen rekey-pending')
  t.is(g.rekeyPending, false)
  t.alike(g.removals, [ban])

  // A genuine leave of an entitled member forces a rotation; after it, a
  // rejoin that was never readmitted in G leaving again adds nothing.
  const v = pworld()
  const leave = v.cleave(X, 6)
  let r = buildGroup(v.input(v.reader(wA)))
  t.is(r.rekeyPending, true, 'the genuine leave is a requirement')
  const E3 = v.rotate(G, [G, wA, wY], { basis: [leave], at: 7 })
  t.is(kidOf(buildGroup(v.input(v.reader(wA))).epoch), kidOf(E3))
  v.comm.addWriter(X, cwX2, { rejoin: leave })
  v.comm.push(cwX2, groupLeave({ cuts: [{ writer: cwX2, seq: v.comm.len(cwX2) }], at: AT(9) }))
  r = buildGroup(v.input(v.reader(wA)))
  t.is(kidOf(r.epoch), kidOf(E3), 'the unadmitted rejoin leaving again needs no rotation')
  t.is(r.rekeyPending, false)
})

test('a retired CW never revives: the old device of a diary that left and rejoined on a sibling', (t) => {
  const w = pworld()
  w.add(B, wB)
  const cwA = w.cwOf(A)
  const cwA2 = 'e' + A.slice(1)
  const cwA3 = 'f' + A.slice(1)
  w.comm.addWriter(A, cwA2)
  const leave = w.comm.push(cwA2, groupLeave({ cuts: [{ writer: cwA2, seq: w.comm.len(cwA2) }], at: AT(20) }))
  w.comm.addWriter(A, cwA3, { rejoin: leave })
  // The old CW appends a no-op after the rejoin.
  w.comm.push(cwA, communityAdmit({ group: K(0x999), member: X, on: true, cuts: [], seen: { writer: cwA3, seq: 0 }, at: AT(30) }))
  w.push(wA, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(31) }))
  const g = buildGroup(w.input(w.reader(wX)))
  t.absent(g.community.liveWriters.has(cwA), 'the old CW stays retired')
  t.absent(g.authorityWriters.has(wA), 'its G writer has no authority')
  t.absent(g.entitled.includes(wA), 'nor keys')
  t.absent(g.entitled.includes(wB), 'and its admit entitles nobody')
})

test('a C leave set is covered by a basis naming any of its leaves', (t) => {
  const w = pworld()
  const leave = w.cleave(X, 20)
  const E2 = w.rotate(G, [G, wA, wY], { basis: [leave], at: 21 })
  t.is(kidOf(buildGroup(w.input(w.reader(wA))).epoch), kidOf(E2), 'control')
  // A backdated leave on a fresh CW joins the same leave set.
  const fresh = 'e' + X.slice(1)
  w.comm.addWriter(X, fresh)
  w.comm.push(fresh, groupLeave({ cuts: [{ writer: fresh, seq: w.comm.len(fresh) }], at: AT(1) }))
  const g = buildGroup(w.input(w.reader(wA)))
  t.is(kidOf(g.epoch), kidOf(E2), 'the epoch that covered the genuine leave stays eligible')
  t.is(g.rekeyPending, false)
})

test('a C admin who left and rejoined C on a fresh CW is not entitled until re-granted', (t) => {
  const cwA9 = 'e' + A.slice(1)
  const wA9 = K(0x209)
  const w = cworld()
  const E1 = w.rotate(G, [G, wA, wX], { at: 3 })
  let g = buildGroup(w.input(w.reader(wX)))
  t.ok(g.entitled.includes(wA), 'control: a C admin is entitled')
  t.is(kidOf(g.epoch), kidOf(E1))
  const leave = w.cleave(A, 4)
  w.comm.addWriter(A, cwA9, { rejoin: leave })
  w.add(A, wA9)
  t.is(w.cwOf(A), cwA9)
  const E2 = w.rotate(G, [G, wX], { basis: [leave], at: 5 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2))
  t.absent(g.admins.has(A), 'back in C, the grant never listed the fresh CW')
  t.absent(g.entitled.includes(wA9), 'not entitled on its new writer')
  t.absent(g.entitled.includes(wA))
  t.ok(g.requests.includes(A), 'no approval exemption')
  t.is(g.rekeyPending, false, 'nobody owes it a key')
  // It cannot distribute through its new CW either.
  const E3 = w.rotate(wA9, [G, wX, wA9], { auth: w.cauth(A), at: 6 })
  t.is(kidOf(buildGroup(w.input(w.reader(wX))).epoch), kidOf(E2), 'its epoch never sends')
  // Re-granted on the fresh CW, it is entitled there.
  w.cgrant(A, true, { cuts: [{ writer: cwA9, seq: 1 }], at: 7 })
  g = buildGroup(w.input(w.reader(wX)))
  t.ok(g.admins.has(A))
  t.ok(g.entitled.includes(wA9))
  t.absent(g.entitled.includes(wA), 'the old writer stays out')
  t.ok(kidOf(E3))
})

test('a key block whose auth cites a sibling CW of the same diary is ignored for sending', (t) => {
  const sib = 'f' + A.slice(1)
  const build = (cite) => {
    const w = cworld()
    w.comm.addWriter(A, sib)
    // The grant lists both CWs of A; A's G writer names the first.
    w.cgrant(A, true, { cuts: [{ writer: w.cwOf(A), seq: 1 }, { writer: sib, seq: 1 }], at: 2 })
    t.is(w.cwOf(A), cwKey(A))
    const E = w.rotate(wA, [G, wA, wX], { auth: cite(w), at: 3 })
    return { w, E, g: buildGroup(w.input(w.reader(wX))) }
  }
  const own = build((w) => w.cauth(A))
  t.is(kidOf(own.g.epoch), kidOf(own.E), 'control: citing its own CW sends')
  const other = build((w) => ({ writer: sib, seq: w.comm.len(sib) }))
  t.ok(buildCommunity(other.w.comm.input()).admins.has(A), 'the sibling CW is granted too')
  t.is(other.g.epoch, null, 'a sibling CW is no citation for this writer')
  t.alike(other.g.posts, [])
})

test('a lost device leaving again after its owner rejoined forces no rekey', (t) => {
  const w = pworld()
  const leave = w.cleave(X, 20)
  const E2 = w.rotate(G, [G, wA, wY], { basis: [leave], at: 21 })
  w.comm.addWriter(X, cwX2, { rejoin: leave })
  const g0 = buildGroup(w.input(w.reader(wA)))
  t.is(kidOf(g0.epoch), kidOf(E2), 'control')
  const old = cwKey(X)
  w.comm.push(old, groupLeave({ cuts: [{ writer: old, seq: w.comm.len(old) }], at: AT(500) }))
  const g = buildGroup(w.input(w.reader(wA)))
  t.is(kidOf(g.epoch), kidOf(E2), 'the epoch stays eligible')
  t.is(g.rekeyPending, false)
  t.alike(g.removals, g0.removals, 'no new requirement')
  t.is(g.community.members.get(X), 'member')
})

test('a demoted device of a diary still admin through another never sends through auth', (t) => {
  const w = pworld({ base: false, cadmins: [A] })
  const cwA = w.cwOf(A)
  const cwA2 = 'e' + A.slice(1)
  w.comm.addWriter(A, cwA2)
  w.add(A, wA).add(A, wA2, { cw: cwA2 }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  // CW1 writes a no-op, is demoted past it, and CW2 is granted.
  w.comm.push(cwA, communityAdmit({ group: K(0x999), member: X, on: true, cuts: [], at: AT(3) }))
  const demote = w.cgrant(A, false, { cuts: [{ writer: cwA, seq: 2 }], at: 4 })
  w.cgrant(A, true, { cuts: [{ writer: cwA2, seq: 1 }], at: 5 })
  // The creator's rotation covers the demotion; later blocks descend from it.
  const cover = w.rotate(G, [G, wA2, wX], { basis: [demote], at: 5.5 })
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  const bad = w.rotate(wA, [G, wA2, wX], { basis: [cover], auth: { writer: cwA, seq: 1 }, at: 6 })
  let g = buildGroup(w.input(reader))
  t.ok(g.admins.has(A), 'still an admin through CW2')
  t.is(kidOf(g.epoch), kidOf(cover), 'a citation of the demoted device old position never sends')
  t.absent(got.includes(kidOf(bad)))
  const good = w.rotate(wA2, [G, wA2, wX], { basis: [cover], auth: { writer: cwA2, seq: w.comm.len(cwA2) }, at: 7 })
  g = buildGroup(w.input(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(good), 'the same from a CW2-bound writer sends')
})

test('a CW a community unban did not list is never entitled until an unban lists it', (t) => {
  const w = pworld({ cadmins: [Z] })
  const cwX = w.cwOf(X)
  const cwX2b = 'e' + X.slice(1)
  w.comm.addWriter(X, cwX2b)
  w.add(X, wX2, { cw: cwX2b })
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 1 }], at: AT(6) }))
  t.ok(buildGroup(w.input()).entitled.includes(wX2), 'control')
  const ban = w.comm.push(w.cwOf(Z), communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: w.comm.len(cwX) }, { writer: cwX2b, seq: w.comm.len(cwX2b) }], at: AT(7) }))
  w.comm.push(w.cwOf(Z), communityBan({ member: X, on: false, lifts: ban, cuts: [{ writer: cwX, seq: w.comm.len(cwX) }], at: AT(8) }))
  let g = buildGroup(w.input())
  t.ok(g.entitled.includes(wX), 'the listed CW is restored')
  t.absent(g.entitled.includes(wX2), 'the unlisted one stays out')
  w.comm.push(w.cwOf(Z), communityBan({ member: X, on: false, lifts: ban, cuts: [{ writer: cwX2b, seq: w.comm.len(cwX2b) }], at: AT(9) }))
  g = buildGroup(w.input())
  t.ok(g.entitled.includes(wX2), 'an unban listing it restores it')
})

test('group-cut: a G root key block above the creator mark never sends after the creator returns', (t) => {
  for (const mode of ['no leave', 'no mark', 'mark']) {
    const w = pworld()
    const cwC2 = 'e' + C.slice(1)
    const cwC3 = 'f' + C.slice(1)
    w.comm.addWriter(C, cwC2)
    const L = mode === 'no leave' ? null : w.comm.push(cwC2, groupLeave({ cuts: [{ writer: CM, seq: w.comm.len(CM) }, { writer: cwC2, seq: w.comm.len(cwC2) }], at: AT(20) }))
    if (L !== null) w.comm.confirm(C, cwC2)
    const marks = new Map(mode === 'mark' ? [[C, [{ writer: G, cut: w.len(G), seq: 1 }]]] : [])
    // The stolen creating device rotates from the G root, then C returns.
    const E2 = w.rotate(G, [G, wA, wX, wY], { basis: L === null ? [] : [L], at: 30 })
    if (L !== null) w.comm.addWriter(C, cwC3, { rejoin: L })
    const got = []
    const reader = w.reader(wX)
    reader.onKey = (kid) => got.push(kidOf(kid))
    const g = buildGroup(w.input(reader, { marks }))
    // onKey reports exactly the epochs valid for sending.
    if (mode === 'no leave') {
      t.ok(got.includes(kidOf(E2)), 'control: with no creator leave the root distributes')
    } else {
      // Unmarked after a confirmed leave: no authority at any seq (owner
      // decision, cycle 21).
      t.absent(got.includes(kidOf(E2)), mode + ': the root block never sends')
      t.not(kidOf(g.epoch), kidOf(E2))
    }
  }
})

test('group-cut: a marked G root is never entitled again; the returning creator is, on its new writer', (t) => {
  const w = pworld()
  const cwC2 = 'e' + C.slice(1)
  const cwC3 = 'f' + C.slice(1)
  const wC3 = K(0x104)
  w.comm.addWriter(C, cwC2)
  const L = w.comm.push(cwC2, groupLeave({ cuts: [{ writer: CM, seq: w.comm.len(CM) }, { writer: cwC2, seq: w.comm.len(cwC2) }], at: AT(20) }))
  w.comm.confirm(C, cwC2)
  const marks = new Map([[C, [{ writer: G, cut: w.len(G), seq: 1 }]]])
  w.comm.addWriter(C, cwC3, { rejoin: L })
  w.add(C, wC3, { cw: cwC3 })
  let g = buildGroup(w.input(null, { marks }))
  t.is(g.community.members.get(C), 'member', 'the creator is back')
  t.absent(g.entitled.includes(G), 'the marked root receives no key')
  t.ok(g.entitled.includes(wC3), 'the creator new writer does')
  g = buildGroup(w.input(null))
  t.absent(g.entitled.includes(G), 'without a mark after the confirmed leave, the root is not entitled either')
  t.ok(g.entitled.includes(wC3))
  g = buildGroup(pworld().input(null))
  t.ok(g.entitled.includes(G), 'control: with no creator leave the root is entitled')
})

test('memberInvite in a private group is plaintext and folds without the epoch key', (t) => {
  const w = pworld()
  t.is(buildGroup(w.input()).memberInvite, false, 'no record')
  const r = groupInvites({ on: true, at: AT(6) })
  t.is(validateGroupRecord(r, 1, { private: true }), null, 'not sealed-only')
  w.push(wX, groupInvites({ on: true, at: AT(6) }))
  t.is(buildGroup(w.input()).memberInvite, false, 'a member record is ignored')
  w.push(wA, groupInvites({ on: true, at: AT(7) }))
  const none = buildGroup(w.input())
  t.is(none.memberInvite, true, 'an admin record counts with no key held')
  t.is(none.name, null, 'while the sealed name stays unread')
  t.is(buildGroup(w.input(w.reader(wY))).memberInvite, true, 'and the same with the key')
  // A sealed copy is never an invites record: only posts, hides and metas
  // open from an envelope.
  w.seal(G, w.E1, groupInvites({ on: false, at: AT(8) }))
  t.is(buildGroup(w.input(w.reader(wY))).memberInvite, true, 'a sealed record stays sealed')
  // Community staff reach a private group through C's virtual log too.
  w.comm.push(CM, communityInvites({ group: G, on: false, at: AT(9) }))
  t.is(buildGroup(w.input()).memberInvite, false, 'C\'s creator clears it in G')
})
