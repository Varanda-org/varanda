'use strict'

// A conversation's read position reaches another device of the same passkey
// through the seen blob (lib/seen-sync.js heads, lib/dm.js seenHeads), even
// after more marks elsewhere than the blob's dm window holds, so both devices
// open it at the same message (dm.thread firstUnread). The real Seeder over a
// local DHT, tmp dirs only.

const test = require('brittle')
const { testnet } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const seenBlob = require('@varanda/core/lib/seen-blob')
const store = require('../lib/node-store')
const { hex, seederHost, memberNode } = require('./helpers/dm-e2e')
const { account, sibling } = require('./helpers/dm-auto')

const NONCE = 'A-_9'.repeat(11)
const NO_AVISOS = { own: [] }

// Copies `from`'s diary into `to`'s storage as a stored replica (what a
// follow would have downloaded), in process.
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

test('a conversation read in part on one device opens at the same message on another, after more marks elsewhere than the window holds', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc)
  const acct = await account(t, assoc, host)
  const A = acct.first
  const A2 = await sibling(t, assoc, host, acct, acct.fresh[0])
  const P = await memberNode(t, assoc, host)
  for (const [x, y] of [[A, P], [P, A], [P, A2]]) await copyDiary(x, y)

  for (const text of ['um', 'dois', 'três']) await P.web.request('dm.send', { to: A.key, text })
  for (const n of [A, A2]) await n.web.request('dm.pull')
  const thread = (n) => n.web.request('dm.thread', { peer: P.key })
  const rows = (await thread(A)).messages
  t.alike(rows.map((m) => m.text), ['um', 'dois', 'três'])
  t.alike((await thread(A2)).messages.map((m) => m.id), rows.map((m) => m.id), 'both devices hold the conversation')
  const [m1, m2] = rows.map((m) => m.id)
  t.is((await thread(A2)).firstUnread, m1, 'nothing read yet: it opens at the first message')

  await A.web.request('dm.seen', { peer: P.key, upTo: m1 })
  t.is((await thread(A)).firstUnread, m2)
  const [head] = await store.readDmSeen(A.storage)
  // Marks made since in other conversations, more than the window holds.
  const others = Array.from({ length: seenBlob.SYNC_DM_MAX + 72 }, (_, i) => (i + 1).toString(16).padStart(32, '0'))
  await store.writeDmSeen(A.storage, [head, ...others])

  // One seen pass on each device, as the app runs them.
  t.is((await A.web.request('seen.merge', { blob: null, avisos: NO_AVISOS, unchanged: false })).pending, true)
  const w = await A.web.request('seen.sign', { nonce: NONCE, action: 'write' })
  await A.web.request('seen.merge', { blob: w.blob, avisos: NO_AVISOS, unchanged: false })
  await A2.web.request('seen.merge', { blob: w.blob, avisos: NO_AVISOS, unchanged: false })
  t.ok((await store.readDmSeen(A2.storage)).includes(head), 'the position reached the other device')
  t.is((await thread(A2)).firstUnread, m2, 'which opens where reading stopped')

  const quiet = await A.web.request('seen.merge', { blob: null, avisos: NO_AVISOS, unchanged: true })
  t.is(quiet.pending, false, 'once in the window, a quiet pass has nothing to write')
})
