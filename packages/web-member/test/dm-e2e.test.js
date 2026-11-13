'use strict'

// Direct messages end to end: the real Seeder with the dm option (its pool
// on disk, the stamp channel with a test postage key generated here) behind
// a WebSocket server, and real browser nodes (lib/node.js over in-memory
// storage) with fixed PRFs. Local DHT and tmp dirs only.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const dmCore = require('@varanda/core/lib/dm')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const { memoryNodeStorage } = require('../lib/node-storage')
const { hex, seederHost, memberNode, rawDm, takeStamps, dropOf, png, rejection } = require('./helpers/dm-e2e')

const HEX64 = /[0-9a-f]{64}/

// Copies `from`'s diary into `to`'s storage as a stored replica (what a
// follow or a peek would have read), in process.
async function copyDiary (from, to) {
  const src = await store.openDiary(from.storage)
  const dst = await store.openReplica(to.storage, from.key)
  const a = src.replicate(true)
  const b = dst.replicate(false)
  a.pipe(b).pipe(a)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: src.length }).done()
  a.destroy()
  b.destroy()
  await src.close()
  await dst.close()
}

function filesUnder (dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

// Neither the pool on disk nor the seeder log names a member: the raw key
// bytes and the hex form are both searched for.
function assertNoMemberKey (t, host, members, label) {
  const poolDir = path.join(host.dataDir, 'dm-pool')
  t.ok(fs.existsSync(poolDir), label + ': pool dir exists')
  const files = filesUnder(poolDir)
  t.ok(files.length > 0, label + ': pool has files')
  for (const f of files) {
    const bytes = fs.readFileSync(f)
    for (const m of members) {
      t.is(b4a.indexOf(bytes, b4a.from(m.key, 'hex')), -1, label + ': no raw member key in ' + path.basename(f))
      t.is(b4a.indexOf(bytes, b4a.from(m.key)), -1, label + ': no hex member key in ' + path.basename(f))
    }
  }
  const dmLines = host.events.filter((e) => e && typeof e.event === 'string' && e.event.startsWith('dm'))
  t.ok(dmLines.length > 0, label + ': the dm channel logged')
  for (const e of dmLines) t.absent(HEX64.test(JSON.stringify(e)), label + ': no hex64 on a dm log line')
  const log = JSON.stringify(dmLines)
  for (const m of members) t.absent(log.includes(m.key), label + ': no member key on the dm channel log')
}

test('dm end to end against the real seeder', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc)

  // Enable: the box published comes from the PRF; stamps from the top-up.
  const A = await memberNode(t, assoc, host)
  const B = await memberNode(t, assoc, host)
  const boxB = await dmBoxKeyPairFromPrf(B.prf, 1)
  t.alike(B.enabled, { box: hex(boxB.publicKey), gen: 1, seq: 1 }, 'dm.enable publishes the PRF box')
  const budget = JSON.parse(fs.readFileSync(path.join(host.dataDir, 'dm-stamps.json'), 'utf8'))
  // v2 file: { days: { diary: { 'YYYY-MM-DD': count } } } (protocol section 11).
  for (const n of [A, B]) {
    const days = budget.days[n.key] || {}
    const issued = Object.values(days).reduce((sum, count) => sum + count, 0)
    t.ok(issued >= dmCore.DM_STAMP_WALLET, 'the seeder issued the wallet top-up')
  }

  // Lookup: A reads B's dm-key from B's diary.
  await copyDiary(B, A)
  await copyDiary(A, B)
  t.alike(await A.web.request('dm.lookup', { member: B.key }), { box: hex(boxB.publicKey), gen: 1 }, 'lookup answers the box')

  // Send and pull as a request (B follows nobody).
  const sent = await A.web.request('dm.send', { to: B.key, text: 'oi' })
  t.ok(/^[0-9a-f]{32}$/.test(sent.id))
  const p1 = await B.web.request('dm.pull')
  t.is(p1.added, 1, 'B files one message')
  t.is((await B.web.request('dm.list', {})).conversations.length, 0, 'not in the inbox')
  const req = await B.web.request('dm.list', { folder: 'request' })
  t.is(req.conversations.length, 1)
  t.is(req.conversations[0].peer, A.key)
  t.is(req.conversations[0].preview, 'oi')
  t.is((await B.web.request('dm.thread', { peer: A.key })).folder, 'request')

  // Accept, then reply with replyTo.
  await B.web.request('dm.set', { peer: A.key, state: 'accepted' })
  const inbox = await B.web.request('dm.list', {})
  t.is(inbox.conversations.length, 1, 'accepted: in the inbox')
  t.is(inbox.conversations[0].peer, A.key)
  const reply = await B.web.request('dm.send', { to: A.key, text: 'olá', replyTo: sent.id })
  t.is((await A.web.request('dm.pull')).added, 1, 'A files the reply')
  const ta = await A.web.request('dm.thread', { peer: B.key })
  const got = ta.messages.find((m) => m.id === reply.id)
  t.ok(got, 'the reply is in A\'s thread')
  t.is(got.text, 'olá')
  t.is(got.replyTo, sent.id, 'replyTo crossed')
  t.is(got.from, B.key)
  t.ok(typeof got.at === 'string' && got.at <= new Date().toISOString(), 'at is the effective time')

  // A third identity reads the same pool and opens nothing.
  const C = await memberNode(t, assoc, host)
  t.is((await C.web.request('dm.pull')).added, 0, 'C adds nothing')
  t.is((await C.web.request('dm.list', { folder: 'request' })).conversations.length, 0)

  // A put without a valid stamp is refused; a stamp from the wallet is kept.
  const ch = await rawDm(t, host.url)
  const forged = dropOf(crypto.randomBytes(dmCore.DM_SEALED_BYTES), { kid: (await store.readDmStamps(C.storage)).kids[0], sig: b4a.toString(crypto.randomBytes(256), 'base64'), token: hex(crypto.randomBytes(32)) })
  t.alike(await ch.put(forged), { ok: false, reason: 'invalido' }, 'no valid stamp: invalido')

  // A throwaway key, without a certificate or with one of another
  // association, stamps and puts a message to B: the seeder stores it (it
  // never sees the sender), B opens and files nothing.
  const throwaway = crypto.keyPair()
  const otherAssoc = generateAssociationKeyPair()
  for (const cert of [undefined, createCert({ member: hex(throwaway.publicKey) }, otherAssoc)]) {
    const junk = dmCore.sealInner(dmCore.buildInner({ kind: 'msg', to: B.key, text: 'descartável', cert }, throwaway), hex(boxB.publicKey))
    const [s] = await takeStamps(C, 1)
    t.alike(await ch.put(dropOf(junk, s)), { ok: true, reason: null }, 'the pool takes the drop')
  }
  t.is((await B.web.request('dm.pull')).added, 0, 'a throwaway key without a valid certificate adds 0')

  // A future-dated message from C, filed before B declines, stays hidden:
  // the decline cuts on filedAt, not on the sender's at.
  await copyDiary(B, C)
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
  const inner = dmCore.buildInner({ kind: 'msg', id: dmCore.newMessageId(), at: future, to: B.key, text: 'do futuro', replyTo: null, cert: C.cert }, C.keyPair)
  const sealed = dmCore.sealInner(inner, hex(boxB.publicKey))
  const [stamp] = await takeStamps(C, 1)
  t.alike(await ch.put(dropOf(sealed, stamp)), { ok: true, reason: null }, 'a wallet stamp is accepted')
  t.is((await B.web.request('dm.pull')).added, 1, 'B files the request from C')
  const cRow = (await B.web.request('dm.list', { folder: 'request' })).conversations.find((c) => c.peer === C.key)
  t.ok(cRow, 'C is a request')
  t.ok(cRow.at < future, 'the listed time is the effective time, not the future at')
  await B.web.request('dm.set', { peer: C.key, state: 'declined' })
  t.absent((await B.web.request('dm.list', { folder: 'request' })).conversations.some((c) => c.peer === C.key), 'declined: the future-dated request is hidden')
  t.is((await B.web.request('dm.thread', { peer: C.key })).messages.length, 0, 'and its thread is empty')

  assertNoMemberKey(t, host, [A, B, C], 'before restart')

  // Restart: the pool and B's cursor survive.
  await host.current.close()
  host.current = null
  await host.start()
  t.is((await B.web.request('dm.pull')).added, 0, 'after restart the cursor holds: nothing new')

  // A fresh device of B (same passkey PRF) reads everything again.
  const B2 = await memberNode(t, assoc, host, { keyPair: B.keyPair, prf: B.prf, enable: false })
  // C's future-dated message files too; the decline after it in the pool
  // hides it again.
  t.is((await B2.web.request('dm.pull')).added, 3, 'A\'s message, B\'s sent copy and C\'s request')
  const t2 = await B2.web.request('dm.thread', { peer: A.key })
  t.alike(t2.messages.map((m) => [m.text, m.mine]).sort(), [['oi', false], ['olá', true]], 'the sent copy is mine under peer A')
  t.is(t2.folder, 'inbox', 'the accepted ctl reached the new device')
  t.is((await B2.web.request('dm.thread', { peer: C.key })).messages.length, 0, 'the decline reached it too')

  // Delete on B propagates to B2 after a pull; A keeps its copy.
  await B.web.request('dm.set', { peer: A.key, state: 'deleted' })
  t.is((await B.web.request('dm.list', {})).conversations.length, 0, 'deleted on this device')
  await B2.web.request('dm.pull')
  t.is((await B2.web.request('dm.list', {})).conversations.length, 0, 'deleted on the other device')
  t.is((await B2.web.request('dm.thread', { peer: A.key })).messages.length, 0)
  t.is((await A.web.request('dm.thread', { peer: B.key })).messages.length, 2, 'A keeps the thread')

  // Block: the seeder takes A's next message, B files nothing.
  await B.web.request('dm.set', { peer: A.key, state: 'blocked' })
  const kept = host.events.filter((e) => e.event === 'dm' && e.reason === 'guardada').length
  await A.web.request('dm.send', { to: B.key, text: 'de novo' })
  t.is(host.events.filter((e) => e.event === 'dm' && e.reason === 'guardada').length, kept + 2, 'the seeder stored both drops')
  t.is((await B.web.request('dm.pull')).added, 0, 'blocked: nothing added')
  await B2.web.request('dm.pull')
  t.is((await B2.web.request('dm.thread', { peer: A.key })).messages.length, 0, 'nor shown on the other device')
  t.is((await B2.web.request('dm.list', {})).conversations.length, 0)
  t.is((await B2.web.request('dm.list', { folder: 'request' })).conversations.length, 0)

  assertNoMemberKey(t, host, [A, B, C], 'after restart')
})

test('dm media end to end: photo with caption and photo only, the sealed cache outlives the pool, a lock wipes it', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  const A = await memberNode(t, assoc, host, { blob })
  const B = await memberNode(t, assoc, host, { blob })
  await copyDiary(B, A)
  await copyDiary(A, B)

  // A photo of two chunks with a caption, and a photo-only message.
  const photo = png(40000)
  const item = await A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: B.key })
  t.alike(Object.keys(item), ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms'], 'the media item, nonce included')
  t.is(item.chunks, 2)
  t.alike([item.mime, item.w, item.h, item.ms], ['image/png', 64, 48, 0])
  t.is(fs.readdirSync(path.join(host.dataDir, 'blobs')).length > 0, true, 'the seeder holds the blob')
  const again = await A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: B.key })
  t.alike(again, item, 'the same photo again reuses its sealed blob')
  const sent = await A.web.request('dm.send', { to: B.key, text: 'legenda', media: [item] })
  const small = png(1000)
  const item2 = await A.node.dmPutMedia({ bytes: small, mime: 'image/png', width: 64, height: 48, to: B.key })
  const sent2 = await A.web.request('dm.send', { to: B.key, text: '', media: [item2] })
  const la = await A.web.request('dm.list', {})
  t.is(la.conversations[0].preview, 'Foto', 'a photo-only message previews as Foto, never a key')

  // The same caption with other photos is another message, never the first.
  const p1 = await A.node.dmPutMedia({ bytes: png(300), mime: 'image/png', width: 64, height: 48, to: B.key })
  const p2 = await A.node.dmPutMedia({ bytes: png(301), mime: 'image/png', width: 64, height: 48, to: B.key })
  const [s1, s2] = await Promise.all([
    A.web.request('dm.send', { to: B.key, text: 'mesma', media: [p1] }),
    A.web.request('dm.send', { to: B.key, text: 'mesma', media: [p2] })
  ])
  t.not(s1.id, s2.id, 'two sends with one caption and different media are two messages')

  // An item this node did not put, or one already sent, is refused.
  const forged = { ...item2, key: 'ab'.repeat(32) }
  t.is((await rejection(A.web.request('dm.send', { to: B.key, text: 'x', media: [forged] }))).message, 'prepare a mídia de novo')
  t.is((await rejection(A.web.request('dm.send', { to: B.key, text: 'x', media: [item] }))).message, 'prepare a mídia de novo', 'a sent blob is forgotten')

  // The sender's thread: the descriptors, and its own bytes cached at send.
  const ta = await A.web.request('dm.thread', { peer: B.key })
  t.alike(ta.messages.map((m) => [m.text, m.media]), [['legenda', [item]], ['', [item2]], ['mesma', [p1]], ['mesma', [p2]]])
  const gets = host.blobGets
  const own = await A.node.dmReadMedia({ from: A.key, id: sent.id, index: 0 })
  t.ok(b4a.equals(own.bytes, photo), 'the sender reads its photo')
  t.is(own.mime, 'image/png')
  t.is(host.blobGets, gets, 'from its cache, without a download')

  // The recipient files the descriptors; previews name the photo, not a key.
  t.is((await B.web.request('dm.pull')).added, 4)
  const list = await B.web.request('dm.list', { folder: 'request' })
  t.is(list.conversations[0].preview, 'mesma')
  const tb = await B.web.request('dm.thread', { peer: A.key })
  t.alike(tb.messages.slice(0, 2).map((m) => [m.id, m.text, m.media]), [[sent.id, 'legenda', [item]], [sent2.id, '', [item2]]], 'the stored rows keep the media items')
  const got = await B.node.dmReadMedia({ from: A.key, id: sent.id, index: 0 })
  t.ok(b4a.equals(got.bytes, photo), 'the recipient opens the photo')

  // The pool sweeps: both photos were opened (a request thread fetches
  // nothing by itself, so by an explicit read) and still read; a photo never
  // opened before is unavailable.
  await B.node.dmReadMedia({ from: A.key, id: sent2.id, index: 0 })
  host.blobGone = true
  t.ok(b4a.equals((await B.node.dmReadMedia({ from: A.key, id: sent.id, index: 0 })).bytes, photo), 'the cache outlives the pool')
  t.ok(b4a.equals((await B.node.dmReadMedia({ from: A.key, id: sent2.id, index: 0 })).bytes, small), 'the lazily opened photo too')
  const item3 = await A.node.dmPutMedia({ bytes: png(500), mime: 'image/png', width: 64, height: 48, to: B.key })
  const sent3 = await A.web.request('dm.send', { to: B.key, text: 'tarde demais', media: [item3] })
  t.is((await B.web.request('dm.pull')).added, 1)
  t.is((await rejection(B.node.dmReadMedia({ from: A.key, id: sent3.id, index: 0 }))).message, 'mídia indisponível')
  const tc = await B.web.request('dm.thread', { peer: A.key })
  const tcRows = tc.messages.map((m) => [m.text, m.media])
  t.alike(tcRows[0], ['legenda', [item]])
  t.alike(tcRows[1], ['', [item2]])
  t.alike(tcRows[tcRows.length - 1], ['tarde demais', { unavailable: true }], 'a gone blob is unavailable, the text still returns')

  // At rest the cache is ciphertext under opaque names.
  const index = await B.storage.readJson('dmMediaIndex')
  t.ok(index.items.length >= 2)
  const entry = JSON.stringify(await B.storage.readJson('dmMedia/' + index.items[0].n + '/0'))
  t.absent(entry.includes(b4a.toString(photo.subarray(0, 300), 'base64').slice(0, 40)), 'no plaintext at rest')
  t.absent(JSON.stringify(index).includes(sent.id) || JSON.stringify(index).includes(A.key), 'no id or sender in kv names')

  // A lock wipes the cache: after the next unlock the swept photo is gone.
  await B.node.clearKeyPair()
  t.is(await B.storage.readJson('dmMediaIndex'), null, 'the lock wiped the index')
  t.is(await B.storage.readJson('dmMedia/' + index.items[0].n + '/0'), null, 'and the entry')
  await B.node.setKeyPair(B.keyPair, { prf: B.prf })
  t.is((await rejection(B.node.dmReadMedia({ from: A.key, id: sent.id, index: 0 }))).message, 'mídia indisponível')
  const td = await B.web.request('dm.thread', { peer: A.key })
  t.alike(td.messages[0].media, { unavailable: true })
  t.is(td.messages[0].text, 'legenda')
})

test('dm media from a stranger: a request fetches nothing until a tap, an accepted thread opens lazily, at most two opens at once', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  const A = await memberNode(t, assoc, host, { blob })
  const B = await memberNode(t, assoc, host, { blob })
  await copyDiary(B, A)
  await copyDiary(A, B)

  const photos = []
  const sent = []
  for (let i = 0; i < 6; i++) {
    photos.push(png(1000 + i))
    const item = await A.node.dmPutMedia({ bytes: photos[i], mime: 'image/png', width: 64, height: 48, to: B.key })
    sent.push(await A.web.request('dm.send', { to: B.key, text: 'foto ' + i, media: [item] }))
  }
  t.is((await B.web.request('dm.pull')).added, 6)

  // Opening the request shows every item and downloads none of them.
  const gets = host.blobGets
  const tr = await B.web.request('dm.thread', { peer: A.key })
  t.is(tr.folder, 'request')
  t.is(tr.messages.length, 6)
  t.ok(tr.messages.every((m) => Array.isArray(m.media) && m.media.length === 1), 'the items are listed')
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await B.web.request('dm.thread', { peer: A.key })
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.is(host.blobGets, gets, 'no blob fetched for a request')

  // A tap opens that one photo only.
  const tapped = await B.node.dmReadMedia({ from: A.key, id: sent[0].id, index: 0 })
  t.ok(b4a.equals(tapped.bytes, photos[0]), 'the tapped photo opens')
  t.is(host.blobGets, gets + 1, 'one frame, one photo')

  // Accepted: the thread opens the rest lazily, never more than two at once.
  await B.web.request('dm.set', { peer: A.key, state: 'accepted' })
  host.blobDelayMs = 300
  const ta = await B.web.request('dm.thread', { peer: A.key })
  t.is(ta.folder, 'inbox')
  await until(() => host.blobGets >= gets + 6 && host.blobActive === 0, { name: 'lazy opens', timeoutMs: 60000 })
  t.is(host.blobPeak, 2, 'at most two opens run at once, and two do')
  host.blobDelayMs = 0
  host.blobGone = true
  for (let i = 1; i < 6; i++) {
    t.ok(b4a.equals((await B.node.dmReadMedia({ from: A.key, id: sent[i].id, index: 0 })).bytes, photos[i]), 'opened by the thread read, now from the cache')
  }
  t.is(host.blobGets, gets + 6, 'nothing fetched twice')

  // Lock still wipes what the lazy opens cached.
  await B.node.clearKeyPair()
  t.is(await B.storage.readJson('dmMediaIndex'), null, 'the lock wiped the cache')
})

test('dm media failures: a failed put keeps the photo for its retry, a short read stays retryable, a lock while caching returns no bytes', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  let offline = false
  const A = await memberNode(t, assoc, host, { blob, offline: () => offline })
  // B's first media cache write of a message runs onCache first, once.
  let onCache = null
  const base = memoryNodeStorage()
  const storage = {
    ...base,
    async writeJson (k, v) {
      if (onCache !== null && k.startsWith('dmMedia') && v !== null) {
        const f = onCache
        onCache = null
        await f()
      }
      return base.writeJson(k, v)
    }
  }
  const B = await memberNode(t, assoc, host, { blob, storage })
  await copyDiary(B, A)
  await copyDiary(A, B)

  // A put that fails after the photo was sealed, then the user's retry.
  const photo = png(40000)
  offline = true
  t.ok((await rejection(A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: B.key }))) !== null, 'the put fails with the seeder unreachable')
  offline = false
  const item = await A.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: B.key })
  const sentLock = await A.web.request('dm.send', { to: B.key, text: 'trancar', media: [item] })
  const gets = host.blobGets
  const own = await A.node.dmReadMedia({ from: A.key, id: sentLock.id, index: 0 })
  t.ok(b4a.equals(own.bytes, photo), 'the sender cached its real photo, not zeros')
  t.is(host.blobGets, gets, 'without a download')
  const photo2 = png(2000)
  const item2 = await A.node.dmPutMedia({ bytes: photo2, mime: 'image/png', width: 64, height: 48, to: B.key })
  const sentShort = await A.web.request('dm.send', { to: B.key, text: 'curto', media: [item2] })
  t.is((await B.web.request('dm.pull')).added, 2)

  // A frame body that ended early is a transient error, never a gone blob.
  host.blobShort = true
  const short = await rejection(B.node.dmReadMedia({ from: A.key, id: sentShort.id, index: 0 }))
  t.ok(short !== null, 'the short read fails')
  t.not(short && short.message, 'mídia indisponível', 'not as a gone blob')
  host.blobShort = false
  const th = await B.web.request('dm.thread', { peer: A.key, limit: 1 })
  t.alike(th.messages.map((m) => m.media), [[item2]], 'the media stays retryable, not unavailable')
  t.ok(b4a.equals((await B.node.dmReadMedia({ from: A.key, id: sentShort.id, index: 0 })).bytes, photo2), 'the next read opens it')

  // A lock while the opened photo is being cached: no bytes come back.
  let locking = null
  onCache = async () => {
    locking = B.node.clearKeyPair()
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const locked = await rejection(B.node.dmReadMedia({ from: A.key, id: sentLock.id, index: 0 }))
  t.ok(locking !== null, 'the lock ran during the cache write')
  t.ok(locked !== null, 'the read returns no plaintext')
  await locking
  t.is(await B.storage.readJson('dmMediaIndex'), null, 'and the lock wiped the cache')
})

test('dm reaction end to end: shown on both sides, naming the digest sender and receiver store for the message', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc)
  const A = await memberNode(t, assoc, host)
  const B = await memberNode(t, assoc, host)
  await copyDiary(B, A)
  await copyDiary(A, B)
  const boxA = await dmBoxKeyPairFromPrf(A.prf, 1)
  const boxB = await dmBoxKeyPairFromPrf(B.prf, 1)
  const ch = await rawDm(t, host.url)
  const opened = async (pair, self) => {
    const out = []
    let after = 0
    for (;;) {
      const page = await ch.requestPage({ after })
      for (const it of page.items) {
        const inner = dmCore.openSealed(dmCore.decodeDrop(it.bytes).sealed, pair)
        const body = inner === null ? null : dmCore.openInner(inner, self, { association: assoc.hex })
        if (body !== null) out.push(body)
      }
      if (page.next === null || page.items.length === 0) return out
      after = page.items[page.items.length - 1].seq
    }
  }

  const sent = await A.web.request('dm.send', { to: B.key, text: 'oi' })
  t.is((await B.web.request('dm.pull')).added, 1)
  await B.web.request('dm.set', { peer: A.key, state: 'accepted' })
  t.alike(await B.web.request('dm.react', { to: A.key, target: { from: A.key, id: sent.id }, emoji: '❤️' }), { ok: true })
  t.is((await A.web.request('dm.pull')).added, 0, 'a reaction is not a message')
  t.alike((await A.web.request('dm.thread', { peer: B.key })).messages[0].reactions, [{ emoji: '❤️', mine: false }], 'shown on the sender')
  t.alike((await B.web.request('dm.thread', { peer: A.key })).messages[0].reactions, [{ emoji: '❤️', mine: true }], 'shown on the receiver')

  const atA = await opened(boxA, A.key)
  const msgSelf = atA.find((b) => b.kind === 'msg' && b.id === sent.id)
  const rx = atA.find((b) => b.kind === 'react')
  const msgAtB = (await opened(boxB, B.key)).find((b) => b.kind === 'msg' && b.id === sent.id)
  t.ok(HEX64.test(rx.target.digest))
  t.is(dmCore.bodyDigest(msgAtB), rx.target.digest, 'the receiver named the digest of the message it holds')
  t.is(dmCore.bodyDigest(msgSelf), rx.target.digest, 'the sender holds the same digest')
})
