'use strict'

const test = require('brittle')
const crypto = require('node:crypto')
const b4a = require('b4a')
const {
  SEEN_PLAIN_BYTES,
  SEEN_NONCE_BYTES,
  SEEN_MAC_BYTES,
  SEEN_BLOB_BYTES,
  SEEN_BLOB_B64,
  SYNC_AVISOS_MAX,
  SYNC_PAGES_MAX,
  SYNC_PAGE_TOKENS_MAX,
  SYNC_DM_MAX,
  SYNC_GROUPS_MAX,
  MERGE_AVISOS_MAX,
  MERGE_PAGE_TOKENS_MAX,
  HEADER_BYTES,
  TOKEN_ENTRY_BYTES,
  PAGE_HEAD_BYTES,
  GROUP_ENTRY_BYTES,
  BLOCK_ENTRY_BYTES,
  SYNC_BLOCKS_MAX,
  SEEN_VERSION,
  seenKeyFromSeed,
  trim,
  encode,
  decode,
  seal,
  open,
  merge,
  sameContent
} = require('../lib/seen-blob')

const hex = (n) => crypto.randomBytes(n).toString('hex')
const MEMBER = hex(32)
const ASSOC = hex(32)
const EXPECT = { member: MEMBER, association: ASSOC }

function tokens (n, t0 = 1700000000) {
  const out = []
  for (let i = 0; i < n; i++) out.push({ token: hex(16), t: t0 + i })
  return out
}

function marks (n, ms0 = Date.UTC(2026, 0, 1)) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({ group: hex(32), at: new Date(ms0 + i * 1000).toISOString(), writer: hex(32), seq: i + 1 })
  }
  return out
}

function emptyDoc () {
  return { gen: 0, member: MEMBER, association: ASSOC, avisos: { own: [], pages: {} }, dm: [], groups: [] }
}

function fullDoc (extra = 0) {
  const pages = {}
  for (let i = 0; i < SYNC_PAGES_MAX + extra; i++) pages['page:' + hex(32)] = tokens(SYNC_PAGE_TOKENS_MAX + extra, 1700000000 + i * 100)
  return {
    gen: 7,
    member: MEMBER,
    association: ASSOC,
    avisos: { own: tokens(SYNC_AVISOS_MAX + extra), pages },
    dm: tokens(SYNC_DM_MAX + extra),
    groups: marks(SYNC_GROUPS_MAX + extra)
  }
}

function content (d) {
  return JSON.stringify([d.avisos.own, d.avisos.pages, d.dm, d.groups])
}

test('sizes and caps', (t) => {
  t.is(SEEN_BLOB_BYTES, SEEN_NONCE_BYTES + SEEN_MAC_BYTES + SEEN_PLAIN_BYTES)
  t.is(SEEN_BLOB_BYTES, 32808)
  t.is(SEEN_BLOB_B64, 43744)
  t.is(b4a.toString(b4a.alloc(SEEN_BLOB_BYTES), 'base64').length, SEEN_BLOB_B64)
  t.is(HEADER_BYTES, 77)
  t.is(MERGE_AVISOS_MAX, 256)
  t.is(MERGE_PAGE_TOKENS_MAX, 32)
  const atCaps = HEADER_BYTES +
    SYNC_AVISOS_MAX * TOKEN_ENTRY_BYTES +
    SYNC_PAGES_MAX * (PAGE_HEAD_BYTES + SYNC_PAGE_TOKENS_MAX * TOKEN_ENTRY_BYTES) +
    SYNC_DM_MAX * TOKEN_ENTRY_BYTES +
    SYNC_GROUPS_MAX * GROUP_ENTRY_BYTES +
    SYNC_BLOCKS_MAX * BLOCK_ENTRY_BYTES
  t.is(atCaps, 32753)
  t.ok(atCaps <= SEEN_PLAIN_BYTES)
})

test('round trip at every cap', (t) => {
  const doc = fullDoc()
  const bytes = encode(doc)
  t.is(bytes.byteLength, SEEN_PLAIN_BYTES)
  const back = decode(bytes, EXPECT)
  t.alike(back, trim(doc))
  t.is(back.avisos.own.length, SYNC_AVISOS_MAX)
  t.is(Object.keys(back.avisos.pages).length, SYNC_PAGES_MAX)
  t.is(back.dm.length, SYNC_DM_MAX)
  t.is(back.groups.length, SYNC_GROUPS_MAX)
  t.is(back.gen, 7)
})

test('seal and open keep a constant length', (t) => {
  const key = seenKeyFromSeed(crypto.randomBytes(32), ASSOC, MEMBER)
  const empty = seal(emptyDoc(), key)
  const full = seal(fullDoc(), key)
  t.is(empty.byteLength, SEEN_BLOB_BYTES)
  t.is(full.byteLength, SEEN_BLOB_BYTES)
  t.is(encode(emptyDoc()).byteLength, SEEN_PLAIN_BYTES)
  t.is(open(full, key, EXPECT).dm.length, SYNC_DM_MAX)
  t.alike(open(empty, key, EXPECT), trim(emptyDoc()))
  t.not(b4a.toString(seal(emptyDoc(), key).subarray(0, SEEN_NONCE_BYTES), 'hex'),
    b4a.toString(empty.subarray(0, SEEN_NONCE_BYTES), 'hex'), 'fresh nonce per seal')
})

test('full doc opens back to its trimmed form', (t) => {
  const key = seenKeyFromSeed(crypto.randomBytes(32), ASSOC, MEMBER)
  const doc = fullDoc()
  t.alike(open(seal(doc, key), key, EXPECT), trim(doc))
})

test('two seeds do not open each other', (t) => {
  const a = seenKeyFromSeed(crypto.randomBytes(32), ASSOC, MEMBER)
  const b = seenKeyFromSeed(crypto.randomBytes(32), ASSOC, MEMBER)
  t.is(open(seal(emptyDoc(), a), b, EXPECT), null)
})

test('a flipped byte opens null', (t) => {
  const key = seenKeyFromSeed(crypto.randomBytes(32), ASSOC, MEMBER)
  const blob = seal(fullDoc(), key)
  for (const i of [0, SEEN_NONCE_BYTES, SEEN_NONCE_BYTES + 100, SEEN_BLOB_BYTES - 1]) {
    const bad = b4a.from(blob)
    bad[i] ^= 1
    t.is(open(bad, key, EXPECT), null, 'byte ' + i)
  }
  t.is(open(blob.subarray(1), key, EXPECT), null, 'short blob')
  t.is(open(b4a.concat([blob, b4a.alloc(1)]), key, EXPECT), null, 'long blob')
  t.is(open('x', key, EXPECT), null)
})

test('wrong member or association header opens null', (t) => {
  const key = seenKeyFromSeed(crypto.randomBytes(32), ASSOC, MEMBER)
  const blob = seal(emptyDoc(), key)
  t.is(open(blob, key, { member: hex(32), association: ASSOC }), null)
  t.is(open(blob, key, { member: MEMBER, association: hex(32) }), null)
  t.is(open(blob, key, undefined), null)
})

test('unknown version is unsupported, bad fields are null', (t) => {
  const bytes = encode(emptyDoc())
  const v2 = b4a.from(bytes)
  v2[0] = SEEN_VERSION + 1
  t.alike(decode(v2, EXPECT), { unsupported: true })
  const key = seenKeyFromSeed(crypto.randomBytes(32), ASSOC, MEMBER)
  const nonce = crypto.randomBytes(SEEN_NONCE_BYTES)
  const sodium = require('sodium-universal')
  const blob = b4a.alloc(SEEN_BLOB_BYTES)
  blob.set(nonce)
  sodium.crypto_secretbox_easy(blob.subarray(SEEN_NONCE_BYTES), v2, nonce, key)
  t.alike(open(blob, key, EXPECT), { unsupported: true })

  const flags = b4a.from(bytes)
  flags[1] = 1
  t.is(decode(flags, EXPECT), null, 'flags must be zero')

  const over = b4a.from(bytes)
  new DataView(over.buffer, over.byteOffset).setUint16(70, SYNC_AVISOS_MAX + 1, true)
  t.is(decode(over, EXPECT), null, 'count over cap')

  const overGroups = b4a.from(bytes)
  overGroups[75] = SYNC_GROUPS_MAX + 1
  t.is(decode(overGroups, EXPECT), null, 'group count over cap')

  t.is(decode(bytes.subarray(1), EXPECT), null, 'wrong length')
})

test('group at survives extended years and bad ms is refused', (t) => {
  const doc = emptyDoc()
  doc.groups = [
    { group: hex(32), at: '-000001-01-01T00:00:00.000Z', writer: hex(32), seq: 1 },
    { group: hex(32), at: '+275760-09-13T00:00:00.000Z', writer: hex(32), seq: 4294967295 }
  ]
  const back = decode(encode(doc), EXPECT)
  t.alike(back.groups, trim(doc).groups)
  t.is(back.groups[0].at, '-000001-01-01T00:00:00.000Z')

  const one = emptyDoc()
  one.groups = marks(1)
  const bytes = encode(one)
  const bad = b4a.from(bytes)
  // at of the only group mark sits at header + 64; make it out of the Date range
  new DataView(bad.buffer, bad.byteOffset).setInt32(HEADER_BYTES + 64 + 4, 0x7fffffff, true)
  t.is(decode(bad, EXPECT), null)
})

test('a mark with seq over u32 stays out of the blob', (t) => {
  const doc = emptyDoc()
  const [kept] = marks(1)
  doc.groups = [kept, { group: hex(32), at: kept.at, writer: hex(32), seq: 4294967296 }]
  const back = decode(encode(doc), EXPECT)
  t.alike(back.groups, [kept])
})

test('encode throws on a malformed doc', (t) => {
  t.exception.all(() => encode({ ...emptyDoc(), dm: [{ token: 'zz', t: 1 }] }))
  t.exception.all(() => encode({ ...emptyDoc(), member: 'x' }))
  t.exception.all(() => encode({ ...emptyDoc(), avisos: { own: [], pages: { nope: [] } } }))
  t.exception.all(() => encode({ ...emptyDoc(), groups: [{ group: hex(32), at: '2026-01-01', writer: hex(32), seq: 1 }] }))
})

test('trim drops the oldest first', (t) => {
  const own = tokens(SYNC_AVISOS_MAX + 5)
  const shuffled = own.slice().reverse()
  const doc = { ...emptyDoc(), avisos: { own: shuffled, pages: {} } }
  const out = trim(doc)
  t.alike(out.avisos.own, own.slice(5), 'newest kept, oldest first')

  const groups = marks(SYNC_GROUPS_MAX + 3)
  t.alike(trim({ ...emptyDoc(), groups }).groups, groups.slice(3))

  const dm = tokens(SYNC_DM_MAX + 2)
  t.alike(trim({ ...emptyDoc(), dm }).dm, dm.slice(2))

  const pages = {}
  const keys = []
  for (let i = 0; i < SYNC_PAGES_MAX + 2; i++) {
    const k = 'page:' + hex(32)
    keys.push(k)
    pages[k] = tokens(SYNC_PAGE_TOKENS_MAX + 1, 1000 + i * 100)
  }
  const tp = trim({ ...emptyDoc(), avisos: { own: [], pages } }).avisos.pages
  t.alike(Object.keys(tp).sort(), keys.slice(2).sort(), 'pages with the newest marks kept')
  for (const k of Object.keys(tp)) t.alike(tp[k], pages[k].slice(1))

  const dup = [{ token: own[0].token, t: 5 }, { token: own[0].token, t: 9 }]
  t.alike(trim({ ...emptyDoc(), dm: dup }).dm, [{ token: own[0].token, t: 9 }], 'duplicate keeps the latest t')
})

test('merge is commutative over full disjoint lists past the cap', (t) => {
  const a = fullDoc()
  const b = fullDoc()
  b.gen = 3
  const ab = merge(a, b).doc
  const ba = merge(b, a).doc
  t.is(content(ab), content(ba))
  t.is(ab.gen, 8)
  t.is(ba.gen, 8)
  t.is(ab.avisos.own.length, SYNC_AVISOS_MAX)
  t.is(ab.dm.length, SYNC_DM_MAX)
  t.is(ab.groups.length, SYNC_GROUPS_MAX)
  t.is(Object.keys(ab.avisos.pages).length, SYNC_PAGES_MAX)
  t.ok(decode(encode(ab), EXPECT), 'merged doc encodes')
})

test('merge is idempotent', (t) => {
  const a = fullDoc()
  const b = fullDoc()
  const m = merge(a, b).doc
  t.is(content(merge(m, m).doc), content(m))
  t.is(content(merge(m, b).doc), content(m))
  t.is(content(merge(a, m).doc), content(m))
  t.is(merge(m, m).localOnly, false)
})

test('merge unions tokens with the latest t', (t) => {
  const token = hex(16)
  const a = { ...emptyDoc(), dm: [{ token, t: 10 }] }
  const b = { ...emptyDoc(), dm: [{ token, t: 20 }] }
  t.alike(merge(a, b).doc.dm, [{ token, t: 20 }])
  t.alike(merge(b, a).doc.dm, [{ token, t: 20 }])
})

test('a lesser remote group mark never replaces a local one', (t) => {
  const group = hex(32)
  const writer = hex(32)
  const ahead = { group, at: '2026-01-02T00:00:00.000Z', writer, seq: 5 }
  const behind = { group, at: '2026-01-01T00:00:00.000Z', writer, seq: 9 }
  const local = { ...emptyDoc(), groups: [ahead] }
  const remote = { ...emptyDoc(), groups: [behind] }
  const r = merge(local, remote)
  t.alike(r.doc.groups, [ahead])
  t.ok(r.localOnly, 'local mark ahead of the remote one')
  const r2 = merge(remote, local)
  t.alike(r2.doc.groups, [ahead])
  t.is(r2.localOnly, false, 'remote ahead already')

  const sameAt = { group, at: ahead.at, writer, seq: 6 }
  t.alike(merge({ ...emptyDoc(), groups: [sameAt] }, local).doc.groups, [sameAt], 'seq tiebreak')
})

test('localOnly cases', (t) => {
  const base = { ...emptyDoc(), dm: tokens(3) }
  t.is(merge(base, base).localOnly, false, 'same content')
  t.is(merge({ ...base, gen: 1 }, { ...base, gen: 9 }).localOnly, false, 'gen ignored')
  t.ok(merge({ ...base, dm: base.dm.concat(tokens(1, 1800000000)) }, base).localOnly, 'extra token')
  t.ok(merge({ ...base, groups: marks(1) }, base).localOnly, 'extra group mark')
  t.ok(merge({ ...base, avisos: { own: [], pages: { ['page:' + hex(32)]: tokens(1) } } }, base).localOnly, 'extra page')
  const newer = base.dm.map((e) => ({ token: e.token, t: e.t + 1 }))
  t.ok(merge({ ...base, dm: newer }, base).localOnly, 'later t')
  t.is(merge(base, { ...base, dm: newer }).localOnly, false, 'remote has the later t')
  t.is(merge(emptyDoc(), base).localOnly, false, 'local has nothing new')
  t.ok(sameContent(base, { ...base, gen: 4 }))

  // A local token older than everything in a full remote list is cut, so it
  // is not local only.
  const full = { ...emptyDoc(), dm: tokens(SYNC_DM_MAX, 2000000000) }
  t.is(merge({ ...emptyDoc(), dm: tokens(1, 1) }, full).localOnly, false)
})

test('a page the local cap would drop keeps its local tokens when the remote refreshes it', (t) => {
  // Five local pages: the oldest one (by its newest mark) is over the cap.
  const keys = []
  for (let i = 0; i <= SYNC_PAGES_MAX; i++) keys.push('page:' + hex(32))
  const local = emptyDoc()
  keys.forEach((key, i) => { local.avisos.pages[key] = [{ token: hex(16), t: 1000 + i }] })
  const oldest = keys[0]
  const oldToken = local.avisos.pages[oldest][0].token
  // The remote marks that page again, newer than every local page.
  const remote = emptyDoc()
  remote.avisos.pages[oldest] = [{ token: hex(16), t: 5000 }]
  const { doc } = merge(local, remote)
  t.ok(doc.avisos.pages[oldest], 'the refreshed page is kept')
  if (doc.avisos.pages[oldest]) {
    t.ok(doc.avisos.pages[oldest].some((e) => e.token === oldToken), 'with its older local token')
  }
  t.is(Object.keys(doc.avisos.pages).length, SYNC_PAGES_MAX)
  t.alike(merge(remote, local).doc.avisos.pages, doc.avisos.pages, 'the same either way')
})

test('a group mark ahead but trimmed on one side still wins the union', (t) => {
  const local = emptyDoc()
  local.groups = marks(SYNC_GROUPS_MAX + 1, Date.UTC(2026, 0, 1))
  const g = local.groups[0]
  // The oldest local mark is over the cap; the remote holds an older post of
  // the same group (smaller seq, later at would be skew), so local is ahead.
  const ahead = { group: g.group, at: g.at, writer: g.writer, seq: g.seq + 5 }
  local.groups[0] = ahead
  const remote = emptyDoc()
  remote.groups = [{ group: g.group, at: new Date(Date.parse(g.at) + 3600 * 1000 * 24 * 30).toISOString(), writer: g.writer, seq: 1 }]
  const a = merge(local, remote).doc
  const b = merge(remote, local).doc
  t.alike(a.groups, b.groups, 'the same either way')
})

test('merge refuses another member', (t) => {
  t.exception.all(() => merge(emptyDoc(), { ...emptyDoc(), member: hex(32) }))
})

test('two devices converge within two rounds', (t) => {
  const key = seenKeyFromSeed(crypto.randomBytes(32), ASSOC, MEMBER)
  let devA = fullDoc()
  let devB = fullDoc()
  devB.groups = devA.groups.map((m, i) => i % 2 ? { ...m, seq: m.seq + 1 } : { ...m, at: new Date(Date.parse(m.at) - 1).toISOString() })
  let server = null
  const step = (local) => {
    const remote = server ? open(server, key, EXPECT) : { ...emptyDoc() }
    const { doc, localOnly } = merge(local, remote)
    if (localOnly) server = seal(doc, key)
    return { doc, localOnly }
  }
  let last
  for (let round = 0; round < 2; round++) {
    const a = step(devA)
    devA = a.doc
    const b = step(devB)
    devB = b.doc
    last = [a.localOnly, b.localOnly]
  }
  t.alike(last, [false, false], 'nothing left to write on either device')
  t.is(content(devA), content(devB))
})

test('derived key differs across association, member and domain', (t) => {
  const seed = crypto.randomBytes(32)
  const k = seenKeyFromSeed(seed, ASSOC, MEMBER)
  t.is(k.byteLength, 32)
  t.alike(seenKeyFromSeed(seed, ASSOC, MEMBER), k, 'deterministic')
  t.unlike(seenKeyFromSeed(seed, hex(32), MEMBER), k)
  t.unlike(seenKeyFromSeed(seed, ASSOC, hex(32)), k)
  t.unlike(seenKeyFromSeed(seed, MEMBER, ASSOC), k, 'order matters')
  t.unlike(k, seed.subarray(0, 32), 'never the raw seed')
  const hc = require('hypercore-crypto')
  const otherDomain = hc.hash([b4a.from('varanda/notice-seen/v1\n'), seed, b4a.from(ASSOC + '\n' + MEMBER)])
  t.unlike(otherDomain, k)
  t.exception.all(() => seenKeyFromSeed(seed.subarray(0, 31), ASSOC, MEMBER))
  t.exception.all(() => seenKeyFromSeed(seed, 'x', MEMBER))
})

const keyOfBlock = (i) => i.toString(16).padStart(64, '0')
const blockEntry = (i, on, t) => ({ key: keyOfBlock(i), on, t })

test('blocks: round trip, a document without them, a bad on byte, a count past the cap', (t) => {
  const blocks = [blockEntry(1, true, 10), blockEntry(2, false, 20)]
  const doc = { ...emptyDoc(), blocks }
  t.alike(decode(encode(doc), EXPECT).blocks, blocks)
  t.alike(decode(encode(emptyDoc()), EXPECT).blocks, [], 'none reads as an empty list')

  const bytes = encode(doc)
  const badOn = b4a.from(bytes)
  badOn[HEADER_BYTES + 32] = 2
  t.is(decode(badOn, EXPECT), null, 'on is 0 or 1')
  const tooMany = b4a.from(bytes)
  tooMany[HEADER_BYTES - 1] = SYNC_BLOCKS_MAX + 1
  t.is(decode(tooMany, EXPECT), null)
  t.exception.all(() => encode({ ...emptyDoc(), blocks: [{ key: 'x', on: true, t: 1 }] }), /block entries/)
  t.exception.all(() => encode({ ...emptyDoc(), blocks: 'x' }), /blocks must be/)
})

test('blocks: the window keeps the newest entries', (t) => {
  const list = []
  for (let i = 0; i < SYNC_BLOCKS_MAX + 4; i++) list.push(blockEntry(i + 1, true, 100 + i))
  const back = decode(encode({ ...emptyDoc(), blocks: list }), EXPECT).blocks
  t.is(back.length, SYNC_BLOCKS_MAX)
  t.is(back[0].t, 104, 'the oldest went first')
})

test('blocks: at every cap the document still fits', (t) => {
  const blocks = []
  for (let i = 0; i < SYNC_BLOCKS_MAX; i++) blocks.push(blockEntry(i + 1, i % 2 === 0, 100 + i))
  const doc = { ...fullDoc(), blocks }
  const back = decode(encode(doc), EXPECT)
  t.is(back.blocks.length, SYNC_BLOCKS_MAX)
  t.is(back.dm.length, SYNC_DM_MAX)
  t.is(back.groups.length, SYNC_GROUPS_MAX)
})

test('blocks: the merge keeps the newer entry per key, in any order, and repeats to the same result', (t) => {
  const key = keyOfBlock(1)
  const a = { ...emptyDoc(), blocks: [{ key, on: true, t: 10 }, blockEntry(2, true, 5)] }
  const b = { ...emptyDoc(), blocks: [{ key, on: false, t: 20 }, blockEntry(3, true, 7)] }
  const ab = merge(a, b).doc
  const ba = merge(b, a).doc
  t.alike(ab.blocks, ba.blocks, 'commutative')
  t.alike(ab.blocks, [blockEntry(2, true, 5), blockEntry(3, true, 7), { key, on: false, t: 20 }], 'the unblock is newer and stays')
  t.alike(merge(ab, b).doc.blocks, ab.blocks, 'idempotent')

  const on = { ...emptyDoc(), blocks: [{ key, on: true, t: 9 }] }
  const off = { ...emptyDoc(), blocks: [{ key, on: false, t: 9 }] }
  t.alike(merge(on, off).doc.blocks, [{ key, on: true, t: 9 }], 'at equal times the block wins')
  t.alike(merge(off, on).doc.blocks, [{ key, on: true, t: 9 }])
})

test('blocks: a change makes the merge localOnly, the same list does not', (t) => {
  const key = keyOfBlock(1)
  const remote = { ...emptyDoc(), blocks: [{ key, on: true, t: 9 }] }
  t.is(merge({ ...emptyDoc(), blocks: [{ key, on: false, t: 10 }] }, remote).localOnly, true)
  t.is(merge({ ...emptyDoc(), blocks: [{ key, on: true, t: 9 }] }, remote).localOnly, false)
  t.is(sameContent({ ...emptyDoc(), blocks: [] }, { ...emptyDoc(), blocks: [{ key, on: true, t: 9 }] }), false)
})

test('version 1 is still read: no blocks, more dm tokens, cut to the new window, and written back as version 2', (t) => {
  // A version 1 plaintext written by hand: its 76-byte header has no nBlocks.
  const n = SYNC_DM_MAX + 40
  const bytes = b4a.alloc(SEEN_PLAIN_BYTES)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  bytes[0] = 1
  view.setUint32(2, 3, true)
  bytes.set(b4a.from(MEMBER, 'hex'), 6)
  bytes.set(b4a.from(ASSOC, 'hex'), 38)
  view.setUint16(70, 0, true)
  bytes[72] = 0
  view.setUint16(73, n, true)
  bytes[75] = 0
  let off = 76
  for (let i = 0; i < n; i++) {
    bytes.set(b4a.from(i.toString(16).padStart(32, '0'), 'hex'), off); off += 16
    view.setUint32(off, 1000 + i, true); off += 4
  }
  const doc = decode(bytes, EXPECT)
  t.is(doc.gen, 3)
  t.alike(doc.blocks, [])
  t.is(doc.dm.length, SYNC_DM_MAX, 'the newest stay')
  t.is(doc.dm[doc.dm.length - 1].t, 1000 + n - 1)
  const again = encode({ ...doc, blocks: [blockEntry(1, true, 5)] })
  t.is(again[0], SEEN_VERSION)
  t.is(SEEN_VERSION, 2)
  t.alike(decode(again, EXPECT).blocks, [blockEntry(1, true, 5)])
})
