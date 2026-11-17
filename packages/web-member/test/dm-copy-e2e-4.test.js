'use strict'

// More of the history copy (docs/protocol.md section 11), over the real
// Seeder and real browser nodes, as dm-copy-e2e.test.js (this file holds what
// would not fit that one's time): the conversations of a held Página, and the
// weekly copy allowance spent on photos while the text still travels on it.
// Local DHT and tmp dirs only.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair, createCert, createIssuerCert } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const { errorOf } = require('./helpers/session')
const { hex, seederHost, memberNode, png } = require('./helpers/dm-e2e')
const { BLOB, sleep, copyDiary, sweepPool, copyUsed, textsOf } = require('./helpers/dm-copy')
const { account, sibling, ownDrops, copiesOf, kick, idle, manifestOf } = require('./helpers/dm-auto')

const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)
const NO_PAGE_KEY = 'sem chave da página'

// A Página diary (its certificate, a roster naming `ownerKp` as owner and a
// dm-key with `box`), copied into each of `nodes` as a stored replica, which
// is how dm.lookup and the page store find it. -> the page key (hex).
async function pageDiary (t, assoc, issuer, pageKp, ownerKp, box, nodes) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex, keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  const page = hex(pageKp.publicKey)
  await m.setCert(createCert({ member: page }, assoc.kp))
  const fields = { page, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuer.kp, issuer.cert))
  await m.core.append({ type: 'dm-key', box, gen: 1, at: AT })
  const hold = async (n) => {
    const dst = await store.openReplica(n.storage, m.key)
    const a = m.core.replicate(true, { keepAlive: false })
    const b = dst.replicate(false, { keepAlive: false })
    a.pipe(b).pipe(a)
    try {
      await dst.update({ wait: true })
      await dst.download({ start: 0, end: m.core.length }).done()
    } finally {
      a.destroy()
      b.destroy()
      await dst.close()
    }
  }
  for (const n of nodes) await hold(n)
  return { page, hold }
}

// The page's gen 1 secrets, made by `A`, and the call that adopts them on a
// device of the same identity.
function adopt (N, page, made, assoc) {
  const s = made.shares[0]
  return N.web.request('dm.pageSecrets', { page, gen: 1, sealed: s.sealed, by: N.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc.kp) })
}

// The old device A of a new account and its newer device A2 (which knows
// its own device id, as the session tells the engine).
async function devicesOf (t, assoc, host, blob) {
  const acct = await account(t, assoc, host, { old: 1, fresh: 1, blob })
  const A2 = await sibling(t, assoc, host, acct, acct.fresh[0], { blob })
  t.is((await A2.web.request('device.list')).self, acct.fresh[0], 'A2 knows its device id')
  return { acct, A: acct.first, A2 }
}

test('the conversations of a Página come along: filed at once on a device that holds it, kept sealed until a device adopts it', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const { acct, A, A2 } = await devicesOf(t, assoc, host, BLOB)
  const C = await memberNode(t, assoc, host, { blob: BLOB })
  await copyDiary(C, A)
  await copyDiary(A, C)
  const boxA = hex((await dmBoxKeyPairFromPrf(A.prf, 1)).publicKey)

  // Two Páginas owned by this identity, adopted on A. A2 will hold the first
  // when the copy arrives and the second only later.
  const pages = []
  for (const text of ['para a primeira', 'para a segunda']) {
    const pageKp = crypto.keyPair()
    const made = await A.web.request('dm.pageGenerate', { page: hex(pageKp.publicKey), gen: 1, recipients: [{ member: A.key, box: boxA }] })
    const diary = await pageDiary(t, assoc, issuer, pageKp, A.keyPair, made.box, [A, C])
    t.alike(await adopt(A, diary.page, made, assoc), { ok: true })
    pages.push({ ...diary, made, text })
  }
  const [P1, P2] = pages
  for (const p of pages) await C.web.request('dm.send', { to: p.page, text: p.text })
  await A.web.request('dm.send', { to: C.key, text: 'oi pessoal' })
  await A.web.request('dm.pull')
  for (const p of pages) t.alike(textsOf(await A.web.request('dm.thread', { page: p.page, peer: C.key })), [p.text], 'the Página holds its message on A')

  // A2 adopts the first Página before the copy exists, and pulls nothing.
  await P1.hold(A2)
  t.alike(await adopt(A2, P1.page, P1.made, assoc), { ok: true })
  await sweepPool(host)

  await kick(A)
  await idle(t, A)
  const copies = copiesOf(await ownDrops(t, host, acct))
  t.is(copies.length, 1, 'one text copy, no photo')
  t.alike((await manifestOf(host, copies[0])).stores.map((s) => s.page).sort(), [null, P1.page, P2.page].sort(), 'the own conversation and the two Páginas')

  await A2.web.request('dm.pull')
  await until(() => A2.web.events.some((e) => e.name === 'dm.copyImported'), { name: 'copyImported', timeoutMs: 60000 })
  t.is(A2.web.events.find((e) => e.name === 'dm.copyImported').data.messages, 2, 'the own conversation and the held Página')
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: C.key })), ['oi pessoal'], 'the own conversation')
  t.alike(textsOf(await A2.web.request('dm.thread', { page: P1.page, peer: C.key })), [P1.text], 'the held Página is filed in its own store')
  t.ok(A2.web.events.some((e) => e.name === 'dm.changed' && e.data.page === P1.page), 'dm.changed names the Página')
  t.is((await A2.web.request('dm.list', {})).conversations.length, 1, 'the Página rows stay out of the own inbox')

  // The other Página is not held here: nothing readable, one sealed entry.
  t.is((await errorOf(A2.web.request('dm.list', { page: P2.page }))).message, NO_PAGE_KEY, 'not held, so not readable')
  t.is((await store.readCopyPend(A2.storage)).length, 1, 'its conversations wait sealed')
  t.absent(JSON.stringify(await store.readCopyPend(A2.storage)).includes(P2.text), 'no text in the entry list')

  // Adopting it, and the next pull, files them.
  const imports = A2.web.events.filter((e) => e.name === 'dm.copyImported').length
  await P2.hold(A2)
  t.alike(await adopt(A2, P2.page, P2.made, assoc), { ok: true })
  await A2.web.request('dm.pull')
  await until(() => A2.web.events.filter((e) => e.name === 'dm.copyImported').length > imports, { name: 'copyImported after adoption', timeoutMs: 60000 })
  t.alike(textsOf(await A2.web.request('dm.thread', { page: P2.page, peer: C.key })), [P2.text], 'filed after adoption')
  t.ok(A2.web.events.some((e) => e.name === 'dm.changed' && e.data.page === P2.page), 'dm.changed names the adopted Página')
  t.is((await store.readCopyPend(A2.storage)).length, 0, 'the sealed entry is gone')
})

test('photos spend the weekly copy allowance after the text took its stamps: the daily wallet pays no photo', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  // Four stamps a week: the text (one part, one manifest, one of slack) takes
  // three of them, which leaves one photo's worth.
  const host = await seederHost(t, bootstrap, assoc, { blob: true, copyStampsPerWeek: 4 })
  // No background top-up, so the daily wallet only moves when a send or a
  // copy spends it.
  const quiet = { ...BLOB, topUpEveryMs: 3600000, topUpRetryMs: 3600000 }
  const { acct, A, A2 } = await devicesOf(t, assoc, host, quiet)
  const P = await memberNode(t, assoc, host, { blob: quiet })
  await copyDiary(P, A)
  await copyDiary(A, P)
  const sent = []
  for (const n of [1, 2, 3]) {
    const item = await A.node.dmPutMedia({ bytes: png(500 + n), mime: 'image/png', width: 64, height: 48, to: P.key })
    sent.push(await A.web.request('dm.send', { to: P.key, text: 'foto ' + n, media: [item] }))
  }
  await sweepPool(host)

  // The daily wallet settles after the sends (the last top-up lands).
  const wallet = async () => (await store.readBlobStamps(A.storage)).items.length
  let before = await wallet()
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    const now = await wallet()
    if (now === before && i > 3) break
    before = now
  }
  t.ok(before > 0, 'the daily wallet holds stamps')

  await kick(A)
  await idle(t, A)
  const copies = copiesOf(await ownDrops(t, host, acct))
  t.is(copies.length, 2, 'the text and one photo batch')
  t.alike((await manifestOf(host, copies[1])).photos.map((x) => x.id), [sent[2].id], 'the allowance the text left went to one photo, the newest')
  // The batch manifest must go, as the text manifest: the allowance is
  // spent, so the daily wallet pays it. Never a photo.
  t.is(await wallet(), before - 1, 'the daily wallet paid the batch manifest only')
  t.is(copyUsed(host), 4, 'the week\'s allowance is spent, text first')

  await A2.web.request('dm.pull')
  await until(() => A2.web.events.some((e) => e.name === 'dm.copyImported'), { name: 'copyImported', timeoutMs: 60000 })
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: P.key })), ['foto 1', 'foto 2', 'foto 3'], 'the text is whole on the other device')
})
