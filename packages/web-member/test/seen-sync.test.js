'use strict'

// The browser node's seen sync (lib/seen-sync.js, docs/rpc.md 5.90 seen.sign
// and 5.91 seen.merge): signed statements, the sealed document built from kv,
// convergence between two devices of one identity, unions at the local caps,
// the group.seen forward rule for remote marks, caughtUp, and the session
// wiring (LOCKED, no diary core opened, seen.changed coalesced).
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const seenBlob = require('@varanda/core/lib/seen-blob')
const { HASH_NONE, blobHash, verifySeen } = require('@varanda/core/lib/seen-proof')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { WebSocket } = require('ws')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const { connectClient, errorOf } = require('./helpers/session')
const { dmSeeder } = require('./helpers/dm-seeder')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { createSeenSync, groupApplier, IGNORED_LINE } = require('../lib/seen-sync')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const hex = (buf) => b4a.toString(buf, 'hex')
const NONCE = 'A-_9'.repeat(11)
const tok = (i) => i.toString(16).padStart(32, '0')

function identity (keyPair = crypto.keyPair(), assoc = generateAssociationKeyPair()) {
  return { keyPair, own: hex(keyPair.publicKey), assoc, association: hex(assoc.publicKey) }
}

// One device: its own storage and engine for the identity `id`.
function device (id, { applyGroups = null, storage = memoryNodeStorage() } = {}) {
  const lines = []
  let current = id.own
  const engine = createSeenSync({
    storage,
    association: id.association,
    log: (line) => lines.push(line),
    currentOwn: () => current,
    applyGroups
  })
  return {
    id,
    storage,
    engine,
    lines,
    setCurrent (own) { current = own },
    sign: (action) => engine.sign({ nonce: NONCE, action }, id.keyPair, id.own),
    merge: (params) => engine.merge({ blob: null, avisos: { own: [] }, unchanged: false, ...params }, id.keyPair, id.own)
  }
}

function keyOf (id) {
  return seenBlob.seenKeyFromSeed(id.keyPair.secretKey.subarray(0, 32), id.association, id.own)
}

function openB64 (id, b64) {
  return seenBlob.open(b4a.from(b64, 'base64'), keyOf(id), { member: id.own, association: id.association })
}

function sealB64 (id, doc) {
  return b4a.toString(seenBlob.seal(doc, keyOf(id)), 'base64')
}

function docOf (id, { dm = [], own = [], pages = {}, groups = [], gen = 1 } = {}) {
  return { gen, member: id.own, association: id.association, avisos: { own, pages }, dm, groups }
}

// Every kv write of `storage` from now on.
function spyWrites (storage) {
  const writes = []
  const writeJson = storage.writeJson.bind(storage)
  storage.writeJson = (k, v) => { writes.push(k); return writeJson(k, v) }
  return writes
}

// A kv-only applier for devices with no group cores: a remote mark replaces
// the local one when it is ahead by date (the real rule is member-ops').
function kvApplier (storage) {
  return async (marks) => {
    const before = await store.readGroupSeen(storage)
    const next = before.slice()
    const moved = []
    for (const m of marks) {
      const i = next.findIndex((x) => x.group === m.group)
      if (i >= 0 && Date.parse(next[i].at) >= Date.parse(m.at)) continue
      if (i >= 0) next.splice(i, 1)
      next.push({ group: m.group, at: m.at, writer: m.writer, seq: m.seq })
      moved.push(m.group)
    }
    if (moved.length > 0) await store.writeGroupSeen(storage, next)
    return { moved, caughtUp: [] }
  }
}

const mark = (group, seq, at) => ({ group, at, writer: 'ab'.repeat(32), seq })

test('seen.sign: read, delete and write statements verify, bound to the node hashes', async (t) => {
  const id = identity()
  const d = device(id)
  for (const action of ['read', 'delete']) {
    const r = await d.sign(action)
    t.alike(Object.keys(r).sort(), ['prevHash', 'signature'], action + ': signature and prevHash only')
    t.is(r.prevHash, HASH_NONE, 'nothing merged yet')
    t.alike(verifySeen({ nonce: NONCE, member: id.own, association: id.association, action, prevHash: HASH_NONE, newHash: HASH_NONE }, r.signature), { ok: true })
  }

  await store.writeDmSeen(d.storage, [tok(1), tok(2)])
  const g = 'cd'.repeat(32)
  await store.writeGroupSeen(d.storage, [mark(g, 3, '2026-01-02T00:00:00.000Z')])
  const w = await d.sign('write')
  t.alike(Object.keys(w).sort(), ['blob', 'hash', 'prevHash', 'signature'])
  t.is(w.blob.length, seenBlob.SEEN_BLOB_B64, 'canonical base64 of the fixed size')
  t.is(w.hash, blobHash(b4a.from(w.blob, 'base64')), 'hash of the exact ciphertext')
  t.is(w.prevHash, HASH_NONE)
  t.alike(verifySeen({ nonce: NONCE, member: id.own, association: id.association, action: 'write', prevHash: HASH_NONE, newHash: w.hash }, w.signature), { ok: true })
  t.alike(verifySeen({ nonce: NONCE, member: id.own, association: id.association, action: 'write', prevHash: HASH_NONE, newHash: 'ee'.repeat(32) }, w.signature), { ok: false, reason: 'bad-signature' }, 'another hash')

  const doc = openB64(id, w.blob)
  t.is(doc.gen, 1)
  t.alike(doc.dm.map((e) => e.token), [tok(1), tok(2)], 'the kv dm tokens, newest last')
  t.alike(doc.groups, [mark(g, 3, '2026-01-02T00:00:00.000Z')], 'the kv group marks')
  t.alike(doc.avisos, { own: [], pages: {} })
  t.is(openB64(identity(), w.blob), null, 'another identity cannot open it')

  const again = await d.sign('write')
  t.not(again.blob, w.blob, 'a fresh encryption nonce each write')

  await d.merge({ blob: w.blob })
  const after = await d.sign('read')
  t.is(after.prevHash, w.hash, 'prevHash is the hash merged last')
  const w2 = await d.sign('write')
  t.is(w2.prevHash, w.hash)
  t.is(openB64(id, w2.blob).gen, (await store.readSeenSync(d.storage, id.own)).gen + 1, 'gen counts up from the merged one')
})

test('two devices of one identity converge on avisos, dm and group marks', async (t) => {
  const id = identity()
  const sa = memoryNodeStorage()
  const sb = memoryNodeStorage()
  const A = device(id, { storage: sa, applyGroups: kvApplier(sa) })
  const B = device(id, { storage: sb, applyGroups: kvApplier(sb) })
  const g1 = '11'.repeat(32)
  const g2 = '22'.repeat(32)
  const page = 'page:' + '33'.repeat(32)
  await store.writeDmSeen(sa, [tok(1), tok(2)])
  await store.writeGroupSeen(sa, [mark(g1, 2, '2026-01-02T00:00:00.000Z')])
  await store.writeDmSeen(sb, [tok(3)])
  await store.writeGroupSeen(sb, [mark(g1, 1, '2026-01-01T00:00:00.000Z'), mark(g2, 5, '2026-01-05T00:00:00.000Z')])

  let r = await A.merge({ avisos: { own: [tok(10)], pages: { [page]: [tok(11)] } } })
  t.is(r.pending, true, 'A has marks the service lacks')
  const wa = await A.sign('write')
  r = await A.merge({ blob: wa.blob })
  t.is(r.pending, false, 'merging its own write: nothing pending')

  r = await B.merge({ blob: wa.blob, avisos: { own: [tok(12)] } })
  t.is(r.pending, true, 'B has more')
  t.is(r.dmChanged, true)
  t.is(r.groupChanged, true)
  t.alike(r.avisos.own.slice().sort(), [tok(10), tok(12)])
  t.alike(r.avisos.pages, { [page]: [tok(11)] })
  const wb = await B.sign('write')
  t.is(wb.prevHash, wa.hash, 'B writes over the blob it merged')
  r = await B.merge({ blob: wb.blob })
  t.is(r.pending, false)

  r = await A.merge({ blob: wb.blob })
  t.is(r.pending, false, 'nothing left to write')
  t.is(r.dmChanged, true)
  t.is(r.groupChanged, true)

  const sorted = (l) => l.slice().sort()
  t.alike(sorted(await store.readDmSeen(sa)), [tok(1), tok(2), tok(3)])
  t.alike(sorted(await store.readDmSeen(sb)), [tok(1), tok(2), tok(3)])
  const marksA = await store.readGroupSeen(sa)
  const marksB = await store.readGroupSeen(sb)
  const byGroup = (l) => l.slice().sort((x, y) => (x.group < y.group ? -1 : 1))
  t.alike(byGroup(marksA), byGroup(marksB), 'the same group marks')
  t.alike(byGroup(marksA), [mark(g1, 2, '2026-01-02T00:00:00.000Z'), mark(g2, 5, '2026-01-05T00:00:00.000Z')])
  const ra = await A.merge({ unchanged: true })
  const rb = await B.merge({ unchanged: true })
  t.alike(ra.avisos, rb.avisos, 'the same avisos')
  t.alike(sorted(ra.avisos.own), [tok(10), tok(12)])
})

test('a stale blob never clears a mark', async (t) => {
  const id = identity()
  const sa = memoryNodeStorage()
  const sb = memoryNodeStorage()
  const A = device(id, { storage: sa, applyGroups: kvApplier(sa) })
  const B = device(id, { storage: sb, applyGroups: kvApplier(sb) })
  const g = '44'.repeat(32)
  await store.writeDmSeen(sa, [tok(1)])
  const old = await A.sign('write')
  await A.merge({ blob: old.blob })
  await B.merge({ blob: old.blob })

  await store.writeDmSeen(sb, [...await store.readDmSeen(sb), tok(2)])
  await store.writeGroupSeen(sb, [mark(g, 4, '2026-02-01T00:00:00.000Z')])
  const r0 = await B.merge({ unchanged: true, avisos: { own: [tok(20)] } })
  t.is(r0.pending, true)
  const fresh = await B.sign('write')
  await B.merge({ blob: fresh.blob })

  const r = await B.merge({ blob: old.blob })
  t.alike((await store.readDmSeen(sb)).slice().sort(), [tok(1), tok(2)], 'dm marks stay')
  t.alike(await store.readGroupSeen(sb), [mark(g, 4, '2026-02-01T00:00:00.000Z')], 'the group mark stays')
  t.ok(r.avisos.own.includes(tok(20)), 'the avisos mark stays')
  t.is(r.pending, true, 'the stale document lacks them: a write is due')
  t.is(r.dmChanged, false)
  t.is(r.groupChanged, false)
})

test('a tampered blob is ignored with a warning and the merged hash does not move', async (t) => {
  const id = identity()
  const d = device(id)
  await store.writeDmSeen(d.storage, [tok(1)])
  const w = await d.sign('write')
  await d.merge({ blob: w.blob })
  const sync = await store.readSeenSync(d.storage, id.own)
  t.is(sync.hash, w.hash)

  const bytes = b4a.from(w.blob, 'base64')
  bytes[100] ^= 1
  const r = await d.merge({ blob: b4a.toString(bytes, 'base64') })
  t.alike(d.lines, [IGNORED_LINE])
  t.alike(await store.readSeenSync(d.storage, id.own), sync, 'seenSync unchanged')
  t.alike(await store.readDmSeen(d.storage), [tok(1)])
  t.is(r.dmChanged, false)

  const other = identity(crypto.keyPair(), id.assoc)
  const foreign = sealB64(other, docOf(other, { dm: [{ token: tok(9), t: 5 }] }))
  await d.merge({ blob: foreign })
  t.is(d.lines.length, 2, 'another identity\'s blob is ignored too')
  t.alike(await store.readDmSeen(d.storage), [tok(1)], 'nothing of it merged')
  t.is((await store.readSeenSync(d.storage, id.own)).hash, w.hash)
})

test('an unsupported version leaves the state untouched and pending false', async (t) => {
  const id = identity()
  const d = device(id)
  await store.writeDmSeen(d.storage, [tok(1)])
  await d.merge({ avisos: { own: [tok(5)] } })
  const plain = seenBlob.encode(docOf(id, { dm: [{ token: tok(7), t: 9 }] }))
  plain[0] = 2
  const out = b4a.alloc(seenBlob.SEEN_BLOB_BYTES)
  const nonce = out.subarray(0, seenBlob.SEEN_NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  sodium.crypto_secretbox_easy(out.subarray(seenBlob.SEEN_NONCE_BYTES), plain, nonce, keyOf(id))
  const writes = spyWrites(d.storage)
  const r = await d.merge({ blob: b4a.toString(out, 'base64'), avisos: { own: [tok(6)] } })
  t.is(r.pending, false)
  t.is(r.dmChanged, false)
  t.is(r.groupChanged, false)
  t.alike(r.caughtUp, [])
  t.alike(writes, [], 'nothing written')
  t.alike(d.lines, [], 'not a tampered blob')
})

test('identity binding: another identity reads the old state as absent; a changed identity drops the result', async (t) => {
  const id = identity()
  const d = device(id)
  await d.merge({ avisos: { own: [tok(5)] } })
  t.ok(await store.readSeenLocal(d.storage, id.own))

  const id2 = identity(crypto.keyPair(), id.assoc)
  t.is(await store.readSeenLocal(d.storage, id2.own), null, 'the old seenLocal reads as absent')
  const d2 = device(id2, { storage: d.storage })
  const r = await d2.merge({ unchanged: true })
  t.alike(r.avisos.own, [], 'none of the old identity\'s avisos')

  d.setCurrent(id2.own)
  const writes = spyWrites(d.storage)
  await t.exception(() => d.merge({ avisos: { own: [tok(6)] } }), new RegExp(store.MISMATCH))
  await t.exception(() => d.sign('write'), new RegExp(store.MISMATCH))
  t.alike(writes, [], 'nothing written for the previous key pair')
  await t.exception(() => d.engine.sign({ nonce: NONCE, action: 'read' }, null, id.own), new RegExp(store.LOCKED))
})

test('a device with 5000 dm tokens keeps 5000 after a merge', async (t) => {
  const id = identity()
  const d = device(id)
  const ids = []
  for (let i = 0; i < 5000; i++) ids.push(tok(i + 1))
  await store.writeDmSeen(d.storage, ids)
  const now = Math.floor(Date.now() / 1000)
  const remote = sealB64(id, docOf(id, { dm: [{ token: tok(90001), t: now + 10 }, { token: tok(90002), t: now + 11 }] }))
  const r = await d.merge({ blob: remote })
  t.is(r.dmChanged, true)
  const kept = await store.readDmSeen(d.storage)
  t.is(kept.length, 5000, 'the local cap, not the shared window')
  t.alike(kept.slice(-2), [tok(90001), tok(90002)], 'the new marks newest')
  t.is(kept[0], tok(3), 'the oldest local marks dropped first')

  const w = await d.sign('write')
  const doc = openB64(id, w.blob)
  t.is(doc.dm.length, seenBlob.SYNC_DM_MAX, 'the document holds its window')
  t.ok(doc.dm.some((e) => e.token === tok(90002)))
})

test('a quiet steady poll answers pending false and leads to no write', async (t) => {
  const id = identity()
  const d = device(id, {})
  const ids = []
  for (let i = 0; i < 1000; i++) ids.push(tok(i + 1))
  await store.writeDmSeen(d.storage, ids)
  await store.writeGroupSeen(d.storage, [mark('55'.repeat(32), 2, '2026-01-01T00:00:00.000Z')])
  let r = await d.merge({ avisos: { own: [tok(70001)] } })
  t.is(r.pending, true)
  const w = await d.sign('write')
  r = await d.merge({ blob: w.blob, avisos: { own: r.avisos.own } })
  t.is(r.pending, false)

  const writes = spyWrites(d.storage)
  for (let i = 0; i < 3; i++) {
    r = await d.merge({ unchanged: true, avisos: { own: r.avisos.own } })
    t.is(r.pending, false, 'pending false')
    t.is(r.dmChanged, false)
    t.is(r.groupChanged, false)
  }
  r = await d.merge({ blob: w.blob, avisos: { own: r.avisos.own } })
  t.is(r.pending, false, 'the same blob read again: already merged')
  t.alike(writes, [], 'no kv write')

  await store.writeDmSeen(d.storage, [...await store.readDmSeen(d.storage), tok(80001)])
  r = await d.merge({ unchanged: true })
  t.is(r.pending, true, 'a mark made here since is pending')
})

test('a cursor left without its document (interrupted reset) is dropped, never paired with an empty one', async (t) => {
  const id = identity()
  const d = device(id, {})
  await store.writeDmSeen(d.storage, [tok(1), tok(2)])
  let r = await d.merge({})
  const w = await d.sign('write')
  r = await d.merge({ blob: w.blob })
  t.is(r.pending, false)
  t.is((await store.readSeenSync(d.storage, id.own)).hash, w.hash, 'the cursor names the written blob')
  // The reset cleared the document but not the cursor.
  await d.storage.writeJson('seenLocal', null)
  await d.storage.writeJson('dmSeen', null)
  r = await d.merge({ unchanged: true })
  t.is((await store.readSeenSync(d.storage, id.own)).hash, null, 'the cursor is dropped')
  const next = await d.sign('write')
  t.is(next.prevHash, HASH_NONE, 'the next write cannot replace the server blob')
})

test('deleteDmData clears the cursor before the document', async (t) => {
  const storage = memoryNodeStorage()
  const order = spyWrites(storage)
  await store.deleteDmData(storage)
  t.ok(order.indexOf('seenSync') < order.indexOf('seenLocal'), 'seenSync first')
  t.ok(order.indexOf('seenSync') < order.indexOf('seenRemote'), 'the cursor before the remote copy')
  t.ok(order.indexOf('seenRemote') < order.indexOf('seenLocal'), 'the remote copy before the document')
})

test('pending stays true on later polls until the server holds the local marks', async (t) => {
  const id = identity()
  const d = device(id, {})
  await store.writeDmSeen(d.storage, [tok(1)])
  const server = sealB64(id, docOf(id, { dm: [{ token: tok(2), t: 5 }] }))
  let r = await d.merge({ blob: server })
  t.is(r.pending, true, 'the server lacks tok(1)')
  r = await d.merge({ blob: server })
  t.is(r.pending, true, 'the same server blob read again: still lacking')
  r = await d.merge({ unchanged: true })
  t.is(r.pending, true, 'an unchanged read: still lacking')

  // The upload fails: the written blob never reaches the server.
  await d.sign('write')
  r = await d.merge({ unchanged: true })
  t.is(r.pending, true, 'a failed upload leaves the marks pending')
  r = await d.merge({ blob: server })
  t.is(r.pending, true)

  const w = await d.sign('write')
  r = await d.merge({ blob: w.blob })
  t.is(r.pending, false, 'the server holds them now')
  r = await d.merge({ unchanged: true })
  t.is(r.pending, false)
})

test('every remote dm mark reaches kv dmSeen, even one cut from the shared window', async (t) => {
  const id = identity()
  const d = device(id, {})
  const ids = []
  for (let i = 0; i < seenBlob.SYNC_DM_MAX; i++) ids.push(tok(i + 1))
  await store.writeDmSeen(d.storage, ids)
  const old = tok(99999)
  const r = await d.merge({ blob: sealB64(id, docOf(id, { dm: [{ token: old, t: 5 }] })) })
  t.is(r.dmChanged, true, 'the union added the old mark')
  const kept = await store.readDmSeen(d.storage)
  t.is(kept.length, seenBlob.SYNC_DM_MAX + 1)
  t.ok(kept.includes(old), 'the old remote mark is in kv')
  t.alike(kept.slice(-ids.length).slice().sort(), ids.slice().sort(), 'the newer local marks stay newest')

  const w = await d.sign('write')
  t.absent(openB64(id, w.blob).dm.some((e) => e.token === old), 'it stays out of the window')
  await d.merge({ blob: w.blob })
  const again = await d.merge({ unchanged: true })
  t.is(again.pending, false, 'and is not offered again as a new mark')
  t.is(again.dmChanged, false)
})

test('marks made between seen.sign and the merge of that write stay pending', async (t) => {
  const id = identity()
  const d = device(id, {})
  const g = '66'.repeat(32)
  await store.writeDmSeen(d.storage, [tok(1)])
  let w = await d.sign('write')
  await store.writeDmSeen(d.storage, [tok(1), tok(2)])
  let r = await d.merge({ blob: w.blob })
  t.is(r.pending, true, 'a dm mark made during the upload')

  w = await d.sign('write')
  await store.writeGroupSeen(d.storage, [mark(g, 1, '2026-03-01T00:00:00.000Z')])
  r = await d.merge({ blob: w.blob })
  t.is(r.pending, true, 'a group mark made during the upload')

  w = await d.sign('write')
  r = await d.merge({ blob: w.blob, avisos: { own: [tok(30)] } })
  t.is(r.pending, true, 'a new notice token')

  w = await d.sign('write')
  r = await d.merge({ blob: w.blob, avisos: { own: r.avisos.own } })
  t.is(r.pending, false, 'nothing changed since the sign')
  const doc = openB64(id, w.blob)
  t.alike(doc.dm.map((e) => e.token), [tok(1), tok(2)])
  t.alike(doc.groups, [mark(g, 1, '2026-03-01T00:00:00.000Z')])
  t.alike(doc.avisos.own.map((e) => e.token), [tok(30)])
  r = await d.merge({ unchanged: true, avisos: { own: r.avisos.own } })
  t.is(r.pending, false, 'no endless pending')

  // The upload takes a minute: a token keeps the t it was written with.
  await store.writeDmSeen(d.storage, [tok(1), tok(2), tok(3)])
  w = await d.sign('write')
  const realNow = Date.now
  Date.now = () => realNow() + 60000
  try {
    r = await d.merge({ blob: w.blob, avisos: { own: r.avisos.own } })
    t.is(r.pending, false, 'merging the unchanged write later is not a local change')
    r = await d.merge({ unchanged: true, avisos: { own: r.avisos.own } })
    t.is(r.pending, false)
  } finally {
    Date.now = realNow
  }
})

test('dm marks made after a sync rank above every mark the stored document holds', async (t) => {
  const id = identity()
  const d = device(id, {})
  const n = seenBlob.SYNC_DM_MAX
  const first = []
  for (let i = 0; i < n; i++) first.push(tok(i + 1))
  await store.writeDmSeen(d.storage, first)
  let w = await d.sign('write')
  let r = await d.merge({ blob: w.blob })
  t.is(r.pending, false)

  const second = []
  for (let i = 0; i < n; i++) second.push(tok(n + i + 1))
  await store.writeDmSeen(d.storage, [...first, ...second])
  const realNow = Date.now
  Date.now = () => realNow() + 5000
  try {
    r = await d.merge({ unchanged: true })
    t.is(r.pending, true)
    w = await d.sign('write')
    const kept = openB64(id, w.blob).dm.map((e) => e.token)
    t.alike(kept.slice().sort(), second.slice().sort(), 'the window holds every new mark')
    r = await d.merge({ blob: w.blob })
    t.is(r.pending, false, 'and nothing is left behind')
  } finally {
    Date.now = realNow
  }

  // The very first merge still backdates, so the newest of many old marks win.
  const fresh = device(identity(), {})
  const many = []
  for (let i = 0; i < n + 10; i++) many.push(tok(i + 1))
  await store.writeDmSeen(fresh.storage, many)
  const doc = openB64(fresh.id, (await fresh.sign('write')).blob)
  t.alike(doc.dm.map((e) => e.token), many.slice(-n), 'the newest marks, newest last')
})

test('a blob the key cannot open answers pending false and keeps the cursor', async (t) => {
  const id = identity()
  const d = device(id, {})
  await store.writeDmSeen(d.storage, [tok(1)])
  const w = await d.sign('write')
  await d.merge({ blob: w.blob })
  await store.writeDmSeen(d.storage, [tok(1), tok(2)])
  const sync = await store.readSeenSync(d.storage, id.own)

  const bytes = b4a.from(w.blob, 'base64')
  bytes[100] ^= 1
  const r = await d.merge({ blob: b4a.toString(bytes, 'base64') })
  t.alike(d.lines, [IGNORED_LINE])
  t.is(r.pending, false, 'no write against a blob that does not open')
  t.is((await store.readSeenSync(d.storage, id.own)).hash, sync.hash, 'the cursor is kept')
})

function unsupportedB64 (id, doc) {
  const plain = seenBlob.encode(doc)
  plain[0] = 2
  const out = b4a.alloc(seenBlob.SEEN_BLOB_BYTES)
  const nonce = out.subarray(0, seenBlob.SEEN_NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  sodium.crypto_secretbox_easy(out.subarray(seenBlob.SEEN_NONCE_BYTES), plain, nonce, keyOf(id))
  return b4a.toString(out, 'base64')
}

test('a stored document in a newer format is never overwritten', async (t) => {
  const id = identity()
  const d = device(id, {})
  await store.writeDmSeen(d.storage, [tok(1)])
  const newer = unsupportedB64(id, docOf(id, { dm: [{ token: tok(7), t: 9 }] }))
  await store.writeSeenLocal(d.storage, id.own, newer)
  const writes = spyWrites(d.storage)
  let r = await d.merge({ avisos: { own: [tok(5)] } })
  t.is(r.pending, false)
  r = await d.merge({ blob: sealB64(id, docOf(id, { dm: [{ token: tok(8), t: 9 }] })) })
  t.is(r.pending, false)
  r = await d.merge({ unchanged: true })
  t.is(r.pending, false)
  await t.exception(() => d.sign('write'), /versão mais nova/)
  t.alike(writes, [], 'nothing written')
  t.is(await store.readSeenLocal(d.storage, id.own), newer, 'the newer document stays')
  for (const action of ['read', 'delete']) t.ok((await d.sign(action)).signature, action + ' still signs')

  // The same for the remote copy an unchanged poll reads.
  const e = device(identity(), {})
  await store.writeDmSeen(e.storage, [tok(1)])
  const w = await e.sign('write')
  await e.merge({ blob: w.blob })
  await store.writeDmSeen(e.storage, [tok(1), tok(2)])
  const remote = unsupportedB64(e.id, docOf(e.id))
  await store.writeSeenRemote(e.storage, e.id.own, remote)
  await store.writeSeenSync(e.storage, e.id.own, { hash: blobHash(b4a.from(remote, 'base64')), gen: 5 })
  const ew = spyWrites(e.storage)
  r = await e.merge({ unchanged: true })
  t.is(r.pending, false, 'an unchanged poll over a newer remote copy')
  t.alike(ew, [], 'writes nothing')
})

test('a merge interrupted at any kv write still offers every local dm mark', async (t) => {
  const now = Math.floor(Date.now() / 1000)
  const X = tok(1)
  const L = tok(2)
  const R = tok(3)
  for (const key of ['seenRemote', 'seenLocal', 'seenSync', 'dmSeen']) {
    const id = identity()
    const d = device(id, {})
    await d.merge({ blob: sealB64(id, docOf(id, { dm: [{ token: X, t: now + 100000 }] })) })
    await store.writeDmSeen(d.storage, [X, L])
    // The other device re-marked X later; R is its own mark.
    const remote = sealB64(id, docOf(id, { dm: [{ token: R, t: 5 }, { token: X, t: now + 200000 }] }))

    const writeJson = d.storage.writeJson.bind(d.storage)
    let thrown = false
    d.storage.writeJson = (k, v) => {
      if (k === key && !thrown) {
        thrown = true
        throw new Error('interrompido')
      }
      return writeJson(k, v)
    }
    await t.exception(() => d.merge({ blob: remote }), /interrompido/, key + ': interrupted')

    let r = await d.merge({ blob: remote })
    t.is(r.pending, true, key + ': the local mark is still pending')
    const w = await d.sign('write')
    t.ok(openB64(id, w.blob).dm.some((e) => e.token === L), key + ': and written')
    r = await d.merge({ blob: w.blob })
    t.is(r.pending, false, key + ': until the server holds it')
    t.alike((await store.readDmSeen(d.storage)).slice().sort(), [X, L, R], key + ': dmSeen holds the remote tokens')
  }
})

// ---- remote group marks through member-ops groupSeen (group-seen.test.js's world) ----

async function member (t, { assoc = generateAssociationKeyPair(), name = 'Ana' } = {}) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  await ops.profileSet(ctx, { name, bio: '' })
  return { ctx, key, assoc, storage, keyPair }
}

async function share (from, to, keys) {
  for (const key of [from.key, ...keys]) {
    const diary = key === from.key
    const source = diary ? await store.openDiary(from.storage) : await store.openGroupCoreReadOnly(from.storage, key)
    const target = diary ? await store.openReplica(to.storage, key) : await store.openGroupReplica(to.storage, key)
    const a = source.replicate(true, { keepAlive: false })
    const b = target.replicate(false, { keepAlive: false })
    a.pipe(b).pipe(a)
    try {
      await target.download({ start: 0, end: source.length }).done()
    } finally {
      a.destroy()
      b.destroy()
      await source.close()
      await target.close()
    }
    if (!diary) await store.addGroupReplica(to.storage, key)
  }
  await store.addGroupDiary(to.storage, from.key)
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

// Ana creates the community and a second group; Bia joins and posts three
// times in Geral, and her writers reach Ana.
async function world (t) {
  const a = await member(t)
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group: horta } = await ops.groupCreate(a.ctx, { name: 'Horta', join: 'open', community })
  const b = await member(t, { assoc: a.assoc, name: 'Bia' })
  await share(a, b, [community, general])
  await ops.communityJoin(b.ctx, { community })
  const bw = await ownWriter(b, general)
  for (const text of ['um', 'dois', 'tres']) await ops.groupPost(b.ctx, { group: general, text })
  await share(b, a, [await ownWriter(b, community), bw])
  const posts = (await ops.groupRead(a.ctx, { group: general })).items.slice().reverse()
  const id = { keyPair: a.keyPair, own: a.key, assoc: a.assoc, association: hex(a.assoc.publicKey) }
  const d = device(id, { storage: a.storage, applyGroups: groupApplier({ storage: a.storage, withCores: (fn) => fn(a.ctx) }) })
  return { a, b, community, general, horta, bw, posts, id, d }
}

const markOf = (group, p, at = p.at) => ({ group, at, writer: p.writer, seq: p.seq })

test('a remote group mark goes through the group.seen forward rule', async (t) => {
  const { a, general, posts, id, d } = await world(t)
  await ops.groupSeen(a.ctx, { group: general, upTo: { at: posts[1].at, writer: posts[1].writer, seq: posts[1].seq } })
  const local = await store.readGroupSeen(a.storage)
  t.alike(local, [markOf(general, posts[1])])

  // Behind in causal order, but its author's clock says far ahead.
  const skewed = markOf(general, posts[0], '2999-01-01T00:00:00.000Z')
  let writes = spyWrites(a.storage)
  let r = await d.merge({ blob: sealB64(id, docOf(id, { groups: [skewed] })) })
  t.alike(await store.readGroupSeen(a.storage), local, 'the local mark never moves back')
  t.is(r.groupChanged, false)
  t.absent(writes.includes('groupSeen'), 'groupSeen not written')

  const unheld = { group: general, at: '2026-01-01T00:00:00.000Z', writer: posts[2].writer, seq: 99 }
  writes = spyWrites(a.storage)
  r = await d.merge({ blob: sealB64(id, docOf(id, { groups: [unheld] })) })
  t.alike(await store.readGroupSeen(a.storage), local, 'a post not held here writes nothing')
  t.absent(writes.includes('groupSeen'))

  r = await d.merge({ blob: sealB64(id, docOf(id, { groups: [markOf(general, posts[2], '2000-01-01T00:00:00.000Z')] })) })
  t.is(r.groupChanged, true, 'a mark ahead in causal order moves it forward')
  t.alike(await store.readGroupSeen(a.storage), [markOf(general, posts[2])], 'with the at of this node\'s own copy')
})

test('caughtUp lists exactly the caught-up groups and communities', async (t) => {
  const { a, community, general, horta, posts, id, d } = await world(t)
  let r = await d.merge({ blob: sealB64(id, docOf(id, { groups: [markOf(general, posts[1])] })) })
  t.is(r.groupChanged, true)
  t.alike(r.caughtUp, [], 'one post still unread in Geral')

  r = await d.merge({ blob: sealB64(id, docOf(id, { groups: [markOf(general, posts[2])] })) })
  t.alike(r.caughtUp, [general, community], 'Geral caught up, and with it every reader group of the community')
  t.absent(r.caughtUp.includes(horta), 'a group whose mark did not move is not listed')

  r = await d.merge({ unchanged: true })
  t.alike(r.caughtUp, [], 'nothing moved: nothing listed')
  t.is(r.groupChanged, false)
  const info = await ops.communityInfo(a.ctx, { community })
  t.is(info.groups.find((g) => g.group === general).unread, 0)
})

// communityInfo is stubbed: building a fold that reads incomplete, or a
// catalogue group whose core did not load, needs a partial replica.
test('caughtUp leaves out a community that is incomplete or has a group that is not a reader', async (t) => {
  const { a, community, general, posts, id, d } = await world(t)
  await d.merge({ blob: sealB64(id, docOf(id, { groups: [markOf(general, posts[1])] })) })
  const back = await store.readGroupSeen(a.storage)
  const real = ops.communityInfo
  t.teardown(() => { ops.communityInfo = real })
  const cases = [
    ['incomplete', (info) => ({ ...info, incomplete: true })],
    ['a group with no role', (info) => ({ ...info, groups: [...info.groups, { group: 'ef'.repeat(32), role: null, unread: 0 }] })],
    ['a group that is not a reader', (info) => ({ ...info, groups: [...info.groups, { group: 'ef'.repeat(32), role: 'pending', unread: 0 }] })]
  ]
  for (const [what, edit] of cases) {
    ops.communityInfo = async (c, p) => edit(await real(c, p))
    await store.writeGroupSeen(a.storage, back)
    const r = await d.merge({ blob: sealB64(id, docOf(id, { groups: [markOf(general, posts[2])] })) })
    t.alike(r.caughtUp, [general], what + ': the group only')
  }
  ops.communityInfo = real
  await store.writeGroupSeen(a.storage, back)
  const r = await d.merge({ blob: sealB64(id, docOf(id, { groups: [markOf(general, posts[2])] })) })
  t.alike(r.caughtUp, [general, community], 'control: the full community')
})

// ---- the session (lib/session.js through lib/node.js) ----

const LOCKED = 'identidade bloqueada: entre com a passkey'

async function sessionNode (t, { assoc = generateAssociationKeyPair(), keyPair = crypto.keyPair(), prf = crypto.randomBytes(32), seederUrl = 'ws://127.0.0.1:9/seeder', createSocket = () => { throw new Error('unexpected socket') }, options = {} } = {}) {
  const storage = memoryNodeStorage()
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  const node = createBrowserNode({ storage, association, seederUrl, createSocket, writeGate: false, ...options })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const id = { keyPair, own: key, assoc, association }
  return { node, web, storage, ctx, key, keyPair, prf, assoc, id }
}

const changedCount = (web) => web.events.filter((e) => e.name === 'seen.changed').length

// The names of every storage core opened from now on.
function spyCores (storage) {
  const names = []
  const core = storage.core.bind(storage)
  storage.core = (name, opts) => { names.push(name); return core(name, opts) }
  return names
}

async function until (fn, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('tempo esgotado')
}

test('session: seen.sign and seen.merge open no diary core; locked refuses and writes nothing', async (t) => {
  const s = await sessionNode(t)
  await s.web.request('node.info')
  const cores = spyCores(s.storage)
  const writes = spyWrites(s.storage)
  const read = await s.web.request('seen.sign', { nonce: NONCE, action: 'read' })
  t.alike(verifySeen({ nonce: NONCE, member: s.key, association: s.id.association, action: 'read', prevHash: HASH_NONE, newHash: HASH_NONE }, read.signature), { ok: true })
  const del = await s.web.request('seen.sign', { nonce: NONCE, action: 'delete' })
  t.alike(verifySeen({ nonce: NONCE, member: s.key, association: s.id.association, action: 'delete', prevHash: HASH_NONE, newHash: HASH_NONE }, del.signature), { ok: true })

  const remote = sealB64(s.id, docOf(s.id, { dm: [{ token: tok(1), t: 10 }] }))
  const r = await s.web.request('seen.merge', { blob: remote, avisos: { own: [tok(2)] }, unchanged: false })
  t.alike(Object.keys(r).sort(), ['avisos', 'caughtUp', 'dmChanged', 'groupChanged', 'pending'])
  t.is(r.dmChanged, true)
  t.alike(r.avisos, { own: [tok(2)], pages: {} })
  const w = await s.web.request('seen.sign', { nonce: NONCE, action: 'write' })
  t.is(w.prevHash, blobHash(b4a.from(remote, 'base64')))
  t.alike(verifySeen({ nonce: NONCE, member: s.key, association: s.id.association, action: 'write', prevHash: w.prevHash, newHash: w.hash }, w.signature), { ok: true })
  t.alike(openB64(s.id, w.blob).dm.map((e) => e.token), [tok(1)])
  t.ok(writes.length > 0, 'the merge wrote kv')
  t.alike(cores, [], 'no core opened, the diary included')

  await s.node.clearKeyPair()
  const before = writes.length
  for (const [method, params] of [['seen.sign', { nonce: NONCE, action: 'write' }], ['seen.merge', { blob: null, avisos: { own: [tok(3)] }, unchanged: false }]]) {
    const err = await errorOf(s.web.request(method, params))
    // As push.sign and every signing method of the browser node.
    t.alike([err.code, err.message], ['USAGE', LOCKED], method + ' locked')
  }
  t.is(writes.length, before, 'nothing written while locked')
})

test('session: seen.changed after a changing group.seen or merge, coalesced to one per 5 s', async (t) => {
  t.timeout(60000)
  const s = await sessionNode(t)
  const { group } = await ops.communityCreate(s.ctx, { name: 'Bairro', join: 'open' })
  await ops.groupPost(s.ctx, { group, text: 'um' })
  await ops.groupPost(s.ctx, { group, text: 'dois' })
  const items = (await s.web.request('group.read', { group })).items
  const older = items[1]

  await s.web.request('group.seen', { group, upTo: { at: older.at, writer: older.writer, seq: 99 } })
  await s.web.request('node.info')
  t.is(changedCount(s.web), 0, 'a group.seen that writes nothing emits nothing')

  await s.web.request('group.seen', { group, upTo: { at: older.at, writer: older.writer, seq: older.seq } })
  await s.web.request('node.info')
  t.is(changedCount(s.web), 1, 'emitted at once')
  t.alike(s.web.events.find((e) => e.name === 'seen.changed').data, {})
  const first = Date.now()

  await s.web.request('group.seen', { group })
  await s.web.request('node.info')
  t.is(changedCount(s.web), 1, 'a second change within 5 s waits')
  await until(() => changedCount(s.web) === 2, 10000)
  t.ok(Date.now() - first >= 4500, 'coalesced to the 5 s window')
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.is(changedCount(s.web), 2, 'once')

  const m = await sessionNode(t)
  await m.web.request('seen.merge', { blob: null, avisos: { own: [tok(1)] }, unchanged: false })
  await m.web.request('node.info')
  t.is(changedCount(m.web), 0, 'a merge that changes no dm or group mark emits nothing')
  await m.web.request('seen.merge', { blob: sealB64(m.id, docOf(m.id, { dm: [{ token: tok(4), t: 10 }] })), avisos: { own: [] }, unchanged: false })
  await m.web.request('node.info')
  t.is(changedCount(m.web), 1, 'a merge that changed dmSeen emits')
})

test('session: seen.changed after a dm.seen that marks a message', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  const createSocket = (u) => {
    const ws = new WebSocket(u)
    ws.on('error', () => {})
    return ws
  }
  const opts = { assoc, seederUrl: seeder.url, createSocket, options: { syncOptions: { dm: { issuePaceMs: 0 } } } }
  const A = await sessionNode(t, opts)
  const B = await sessionNode(t, opts)
  for (const n of [A, B]) {
    await n.web.request('dm.enable')
    await until(async () => {
      const w = await n.storage.readJson('dmStamps')
      return w && Array.isArray(w.items) && w.items.length > 0
    })
  }
  const src = await store.openDiary(A.storage)
  const dst = await store.openReplica(B.storage, A.key)
  const x = src.replicate(true)
  const y = dst.replicate(false)
  x.pipe(y).pipe(x)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: src.length }).done()
  x.destroy()
  y.destroy()
  await src.close()
  await dst.close()

  await B.web.request('dm.send', { to: A.key, text: 'oi' })
  t.is((await A.web.request('dm.pull')).added, 1)
  const before = changedCount(A.web)
  await A.web.request('dm.seen', { peer: B.key })
  await A.web.request('node.info')
  t.is(changedCount(A.web), before + 1, 'emitted after the mark')
  await A.web.request('dm.seen', { peer: B.key })
  await new Promise((resolve) => setTimeout(resolve, 5500))
  t.is(changedCount(A.web), before + 1, 'a repeat marks nothing and emits nothing')
})
