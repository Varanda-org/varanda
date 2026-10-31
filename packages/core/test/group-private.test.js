'use strict'

// Private groups (docs/protocol.md, "Private groups"): sealed records, epoch
// keys, distributors, eligibility and rekey-pending in buildGroup.
const test = require('brittle')
const b4a = require('b4a')
const {
  MAX_KEY_RECIPIENTS, MAX_KEY_BASIS,
  validateGroupRecord, validateWriterHeader, validateGroupHeader, isWeakBoxKey,
  groupHeader, writerHeader, groupPost, groupHide, groupMeta, groupAdmit, groupBan, groupAdmin, groupLeave,
  groupKey, groupSealed, sealedInner, communityAdmin, groupLink, communityLink, buildGroup
} = require('../lib/group')
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

const hex = (b) => b4a.toString(b, 'hex')
const cm = (key, kid) => hex(keyCommit(key, G, kid))

// A private group: C creates G; A is a group admin, X and Y are admitted.
// The root then opens epoch E1 for every writer and seals the name.
function pworld ({ base = true } = {}) {
  const boxes = new Map([[G, newBoxKeyPair()]])
  const logs = new Map([[G, { key: G, diary: C, entries: [{ seq: 0, record: groupHeader({ diary: C, visibility: 'private', join: 'approval', box: hex(boxes.get(G).publicKey), at: AT(0) }) }] }]])
  const joins = new Map([[C, [{ writer: G, on: true, seq: 1 }]]])
  const epochs = new Map()
  const w = {
    logs,
    joins,
    boxes,
    epochs,
    add (diary, key, { box = true, rejoin = null, at = 0 } = {}) {
      if (box) boxes.set(key, newBoxKeyPair())
      logs.set(key, { key, diary, entries: [{ seq: 0, record: writerHeader({ group: G, diary, box: box ? hex(boxes.get(key).publicKey) : null, rejoin, at: AT(at) }) }] })
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
    rotate (by, to, { basis = [], at }) {
      const kid = { writer: by, seq: w.len(by) }
      const key = newEpochKey()
      epochs.set(kid.writer + ':' + kid.seq, key)
      w.push(by, groupKey({ kid: null, basis, keys: to.map((x) => w.entry(x, kid, key)), commit: cm(key, kid), at: AT(at) }))
      return kid
    },
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
      return { root: logs.get(G), writers, joins, communities: [], keys, now: NOW, ...extra }
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
  t.alike(Object.keys(k), ['type', 'kid', 'basis', 'keys', 'commit', 'at'])
  const opts = { private: true }
  t.is(validateGroupRecord(k, 1, opts), null)
  t.is(validateGroupRecord(k, 1, { ...opts, root: true }), null, 'in the root too')
  t.is(validateGroupRecord(k, 1), 'private-only')
  t.is(validateGroupRecord(k, 1, { root: true, community: true, private: true }), 'group-only')
  const cont = groupKey({ kid, keys: k.keys, at: AT(1) })
  t.alike(Object.keys(cont), ['type', 'kid', 'basis', 'keys', 'at'])
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
  const wh = writerHeader({ group: G, diary: B, box: K(9), at: AT(0) })
  t.is(validateWriterHeader(wh), null)
  const w = pworld()
  w.add(B, wB, { box: false })
  w.push(G, groupAdmit({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(6) }))
  const g = buildGroup(w.input())
  t.absent(g.writers.has(wB), 'no box in a private group: header-invalid')
  t.ok(g.writers.has(wX))

  const pub = { key: G, entries: [{ seq: 0, record: groupHeader({ diary: C, at: AT(0) }) }] }
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

test('a community admin with power receives keys; losing it makes the epoch ineligible', (t) => {
  const w = pworld({ base: false })
  w.add(A, wA).add(X, wX).add(Z, wZ)
  const cuts = [{ writer: wA, seq: 1 }, { writer: wZ, seq: 1 }]
  w.push(G, communityLink({ community: CM, on: true, cuts, at: AT(1) }))
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  const records = [groupLink({ group: G, on: true, cuts, at: AT(1) }), communityAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) })]
  const community = () => {
    const entries = [{ seq: 0, record: groupHeader({ kind: 'community', diary: Z, name: 'Bairro', at: AT(0) }) }]
    for (const record of records) entries.push({ seq: entries.length, record })
    return { key: CM, entries, joins: new Map([[Z, [{ writer: CM, on: true, seq: 1 }]]]) }
  }
  const input = (keys) => w.input(keys, { communities: [community()] })
  const E1 = w.rotate(G, [G, wA, wX, wZ], { at: 3 })
  sealedPost(w, wX, E1, 4)
  let g = buildGroup(input(w.reader(wA)))
  t.is(g.community, CM)
  t.ok(g.admins.has(A) && g.admins.has(Z))
  t.alike(g.posts.map((p) => p.text), ['p4'], 'the community admin reads')
  t.is(kidOf(g.epoch), kidOf(E1))
  // The community admin distributes like a group admin.
  const E2 = w.rotate(wA, [G, wA, wX, wZ], { at: 5 })
  sealedPost(w, wX, E2, 6)
  g = buildGroup(input(w.reader(wX)))
  t.alike(g.posts.map((p) => p.text), ['p4', 'p6'])
  t.is(kidOf(g.epoch), kidOf(E2))

  records.push(communityAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(7) }))
  g = buildGroup(input(w.reader(wX)))
  t.absent(g.admins.has(A))
  t.is(g.epoch, null, 'the demotion is a removal and A is no longer entitled')
  t.is(g.rekeyPending, true)
  t.alike(g.posts.map((p) => p.text), ['p4', 'p6'], 'history stays readable')
  const E3 = w.rotate(G, [G, wX, wZ], { basis: [{ writer: CM, seq: 3 }], at: 8 })
  t.is(kidOf(buildGroup(input(w.reader(wX))).epoch), kidOf(E3), 'a basis naming the community record covers it')
  // A community record alone, about someone E3 never named, still needs a
  // rotation: regranted, then demoted again.
  records.push(communityAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(9) }))
  t.is(kidOf(buildGroup(input(w.reader(wX))).epoch), kidOf(E3))
  records.push(communityAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(10) }))
  g = buildGroup(input(w.reader(wX)))
  t.is(g.epoch, null, 'the uncovered community demotion')
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

function cworld () {
  const w = pworld({ base: false })
  w.add(A, wA).add(X, wX).add(Z, wZ)
  const cuts = [{ writer: wA, seq: 1 }, { writer: wZ, seq: 1 }]
  w.push(G, communityLink({ community: CM, on: true, cuts, at: AT(1) }))
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  const records = [groupLink({ group: G, on: true, cuts, at: AT(1) }), communityAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) })]
  const community = () => {
    const entries = [{ seq: 0, record: groupHeader({ kind: 'community', diary: Z, name: 'Bairro', at: AT(0) }) }]
    for (const record of records) entries.push({ seq: entries.length, record })
    return { key: CM, entries, joins: new Map([[Z, [{ writer: CM, on: true, seq: 1 }]]]) }
  }
  w.cinput = (keys) => w.input(keys, { communities: [community()] })
  w.records = records
  w.cuts = cuts
  return w
}

test('an unlinked community removes nothing more until it links again', (t) => {
  const w = cworld()
  w.rotate(G, [G, wA, wX, wZ], { at: 3 })
  w.records.push(groupLink({ group: G, on: false, cuts: w.cuts, at: AT(4) }))
  let g = buildGroup(w.cinput(w.reader(wX)))
  t.is(g.rekeyPending, true, 'the unlink is a removal')
  const E2 = w.rotate(G, [G, wX], { basis: [{ writer: CM, seq: 3 }], at: 5 })
  t.is(kidOf(buildGroup(w.cinput(w.reader(wX))).epoch), kidOf(E2))
  w.records.push(communityAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(6) }))
  w.records.push(groupLink({ group: G, on: false, cuts: w.cuts, at: AT(7) }))
  g = buildGroup(w.cinput(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2), 'a later demotion and a repeated unlink are not removals')
  t.is(g.rekeyPending, false)
})

test('a community demotion of a member without a grant is not a removal', (t) => {
  const w = cworld()
  const E1 = w.rotate(G, [G, wA, wX, wZ], { at: 3 })
  w.records.push(communityAdmin({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(4) }))
  t.is(kidOf(buildGroup(w.cinput(w.reader(wX))).epoch), kidOf(E1))
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
  w.rotate(G, [G, wA, wX, wZ], { at: 3 })
  w.records.push(communityAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(4) }))
  w.rotate(G, [G, wX, wZ], { basis: [{ writer: CM, seq: 3 }], at: 5 })
  const E3 = w.rotate(G, [G, wX, wZ], { at: 6 })
  t.is(kidOf(buildGroup(w.cinput(w.reader(wX))).epoch), kidOf(E3))
  const v = cworld()
  v.rotate(G, [G, wA, wX, wZ], { at: 3 })
  v.records.push(communityAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: v.len(wA) }], at: AT(4) }))
  v.rotate(G, [G, wX, wZ], { at: 6 })
  t.is(buildGroup(v.cinput(v.reader(wX))).rekeyPending, true, 'without that basis')
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

test('a community admin who rejoins is entitled only on the writer its grant lists', (t) => {
  const w = cworld()
  const leave = w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(3) }))
  w.add(A, wA3, { rejoin: leave })
  w.records.push(communityAdmin({ member: A, on: true, cuts: [{ writer: wA3, seq: 1 }], at: AT(4) }))
  const g = buildGroup(w.cinput())
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
  const root = groupHeader({ diary: C, visibility: 'private', join: 'approval', box: good, at: AT(0) })
  const writer = writerHeader({ group: G, diary: B, box: good, at: AT(0) })
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
  t.alike(buildGroup({ root: { key: G, entries: [{ seq: 0, record: groupHeader({ diary: C, at: AT(0) }) }] }, writers: [], joins: new Map(), now: NOW }).removals, [], 'public')

  const c = cworld()
  c.rotate(G, [G, wA, wX, wZ], { at: 3 })
  c.records.push(groupLink({ group: G, on: false, cuts: c.cuts, at: AT(4) }))
  t.alike(buildGroup(c.cinput()).removals, [{ writer: CM, seq: 3 }], 'a community unlink')
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

test('community toggles coalesce to one removal per community root', (t) => {
  const w = cworld()
  w.rotate(G, [G, wA, wX, wZ], { at: 3 })
  for (let i = 0; i < 100; i++) {
    const at = 4 + i / 10
    w.records.push(groupLink({ group: G, on: false, cuts: w.cuts, at: AT(at) }))
    w.records.push(groupLink({ group: G, on: true, cuts: w.cuts, at: AT(at) }))
    w.records.push(communityAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 1 }], at: AT(at) }))
    w.records.push(communityAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(at) }))
  }
  let g = buildGroup(w.cinput(w.reader(wX)))
  const fromCM = g.removals.filter((r) => r.writer === CM)
  t.ok(fromCM.length <= 1, fromCM.length + ' removal from the community')
  t.is(g.rekeyPending, true)
  const E2 = w.rotate(G, g.entitled, { basis: g.removals, at: 20 })
  g = buildGroup(w.cinput(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2), 'one extra epoch covers the whole storm')
})

test('after G unlinks a community its records add no removal', (t) => {
  const w = cworld()
  w.rotate(G, [G, wA, wX, wZ], { at: 3 })
  const unlink = w.push(G, communityLink({ community: CM, on: false, cuts: w.cuts, at: AT(4) }))
  let g = buildGroup(w.cinput(w.reader(wX)))
  t.alike(g.removals, [unlink], 'the G-side unlink')
  t.absent(g.entitled.includes(wA) || g.entitled.includes(wZ), 'the community powers are gone')
  const E2 = w.rotate(G, g.entitled, { basis: g.removals, at: 5 })
  w.records.push(communityAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 1 }], at: AT(6) }))
  w.records.push(groupLink({ group: G, on: false, cuts: w.cuts, at: AT(7) }))
  g = buildGroup(w.cinput(w.reader(wX)))
  t.alike(g.removals, [unlink], 'nothing from the unlinked community')
  t.is(kidOf(g.epoch), kidOf(E2))
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

test('a community demotion beyond the cut cap never blinds history', (t) => {
  const w = cworld()
  const E1 = w.rotate(wA, [G, wA, wX, wZ], { at: 3 })
  sealedPost(w, wX, E1, 4)
  // The demotion lists other writers only (the node cuts the rest at 0).
  w.records.push(communityAdmin({ member: A, on: false, cuts: [{ writer: K(0x9999), seq: 1 }], at: AT(5) }))
  const g = buildGroup(w.cinput(w.reader(wX)))
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

test('community power on an old writer ends with its diary leave', (t) => {
  const wA1 = K(0x204)
  const w = cworld()
  w.add(A, wA1)
  w.records[1] = communityAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA1, seq: 1 }], at: AT(1) })
  t.ok(buildGroup(w.cinput()).entitled.includes(wA1), 'control')
  const l1 = leaveOn(w, wA, 6)
  w.add(A, wA2, { rejoin: l1 })
  w.push(wA1, groupAdmit({ member: X, on: true, cuts: [], seen: seenRejoin(wA2), at: AT(8) }))
  t.absent(buildGroup(w.cinput()).entitled.includes(wA1))
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
  const w = cworld()
  const E1 = w.rotate(G, [G, wA, wX, wZ], { at: 3 })
  w.records.push(communityAdmin({ member: C, on: true, cuts: [{ writer: G, seq: 1 }], at: AT(4) }))
  w.records.push(communityAdmin({ member: C, on: false, cuts: [{ writer: G, seq: w.len(G) }], at: AT(5) }))
  let g = buildGroup(w.cinput(w.reader(wX)))
  t.is(g.rekeyPending, false, 'the group creator lost nothing')
  t.is(kidOf(g.epoch), kidOf(E1))
  t.alike(g.removals, [])
  const E2 = w.rotate(G, g.entitled, { at: 6 })
  g = buildGroup(w.cinput(w.reader(wX)))
  t.is(kidOf(g.epoch), kidOf(E2), 'and it still rotates')
  // A community-only admin demoted in the community is still a requirement.
  w.records.push(communityAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(7) }))
  g = buildGroup(w.cinput(w.reader(wX)))
  t.is(g.rekeyPending, true)
  t.alike(g.removals, [{ writer: CM, seq: 5 }])
})

test('a later community link never makes an earlier one of the same period see a leave', (t) => {
  const wZ2 = K(0x701)
  const wZ3 = K(0x702)
  const w = cworld()
  w.add(Z, wZ2)
  w.records.push(groupLink({ group: G, on: true, cuts: [{ writer: wZ2, seq: 1 }], at: AT(2) }))
  t.ok(buildGroup(w.cinput()).entitled.includes(wZ2), 'control: listed while Z never left')
  const L = leaveOn(w, wZ, 6)
  const legit = w.rotate(G, buildGroup(w.cinput()).entitled, { basis: [L], at: 6.5 })
  w.add(Z, wZ3, { rejoin: L, at: 7 })
  w.push(wZ2, groupAdmit({ member: X, on: true, cuts: [], seen: { writer: wZ3, seq: 0 }, at: AT(8) }))
  // Same period: only wZ3 is listed after the leave.
  w.records.push(groupLink({ group: G, on: true, cuts: [{ writer: wZ3, seq: 1 }], at: AT(9) }))
  const evil = w.rotate(wZ2, [G, wA, wX], { basis: [L], at: 20 })
  const got = []
  const reader = w.reader(wX)
  reader.onKey = (kid) => got.push(kidOf(kid))
  const g = buildGroup(w.cinput(reader))
  t.ok(g.entitled.includes(wZ3), 'the honest post-leave link entitles the rejoin writer')
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
