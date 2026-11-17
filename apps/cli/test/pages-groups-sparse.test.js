'use strict'

// apps/cli/lib/account/pages-groups.js with a writer a seeder keeps sparse
// (#350, docs/protocol.md "Sparse copies"): its blocks below the diary cut,
// then only its leaves and key blocks. The page's fold counts such a copy
// whole once every block the seeder advertises is held. Its own file: the
// pages-groups.test.js runs already take most of the runner's per-file time.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until } = require('./helpers/net')
const { createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const member = require('@varanda/core/lib/member')
const coreStore = require('@varanda/core/lib/store')
const { groupPost, groupLeave } = require('@varanda/core/lib/group')
const { groupCutRecord } = require('@varanda/core/lib/records')
const { person, exchange, startSeeder, syncOnce, ownWriter, runUntil } = require('../../../packages/core/test/helpers/sync-groups')
const { offlineAppend, writerEntries } = require('../../../packages/core/test/helpers/group-member')
const { startSeedWs } = require('../lib/seed-ws')
const { openPageKeys } = require('../lib/account/page-keys')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesGroups } = require('../lib/account/pages-groups')

const PAGE_KEYS = 'cd'.repeat(32)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

let nonceCount = 0
function nonce () {
  nonceCount++
  return (String(nonceCount) + 'g'.repeat(43)).slice(0, 43)
}

function newPage (ctx, keys, username) {
  const { key, row } = keys.pending(nonce())
  keys.put(key, row)
  const cert = createIssuedCert({ member: key }, ctx.issuerKp, ctx.issuerCert)
  const usernameRecord = createUsernameRecord({ member: key, username }, ctx.issuerKp, ctx.issuerCert)
  const owner = crypto.keyPair()
  const fields = { page: key, gen: 1, owner: hex(owner.publicKey), admins: [], prev: null, at: new Date().toISOString(), nonce: nonce(), association: ctx.association }
  const signature = signRoster(fields, owner)
  const rosterRecord = issuerCountersign({ type: 'page-roster', ...fields, signature }, ctx.issuerKp, ctx.issuerCert)
  return { key, owner: hex(owner.publicKey), args: { cert, usernameRecord, rosterRecord } }
}

// Retries while the fold is still partial ('indisponivel').
function settled (fn, name, timeoutMs) {
  return until(async () => {
    try {
      return await fn()
    } catch (err) {
      if (err.code === 'indisponivel') return null
      throw err
    }
  }, { name, timeoutMs, intervalMs: 500 })
}

async function blocksHeld (core, from, to) {
  const out = []
  for (let i = from; i < to; i++) if (await core.has(i)) out.push(i)
  return out
}

test('pages-groups: a group with a writer the seeder keeps sparse is no longer indisponivel (#350)', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const issuerKp = crypto.keyPair()
  const ctx = { association, issuerKp, issuerCert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const seeder = await startSeeder(t, bootstrap, kp)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + server.port

  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { community: C } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group: G } = await member.groupCreate(a, { name: 'Praça', join: 'open', community: C })
  await member.groupPost(a, { group: G, text: 'oi' })
  await exchange(a, b)
  await member.communityJoin(b, { community: C })
  await member.groupJoin(b, { group: G })
  await member.groupPost(b, { group: G, text: 'antes' })
  // W, B's writer in G, is frozen at its length: a post and a leave past
  // the cut.
  const w = ownWriter(b, G)
  const cut = (await writerEntries(b, G)).length
  await offlineAppend(b, G, groupPost({ text: 'depois' }))
  const leave = await offlineAppend(b, G, groupLeave({ seen: null, cuts: [{ writer: w, seq: cut + 1 }] }))
  const s = await coreStore.openStore(b.dataDir)
  try {
    await coreStore.appendRecord(await coreStore.openDiary(s), groupCutRecord({ group: G, writer: w, cut }))
  } finally {
    await s.close()
  }
  t.ok((await syncOnce(bootstrap, a)).result.ok, 'A pushes its diary and roots')
  await runUntil(b, bootstrap, async () => {
    const e = seeder._groupServed.get(w)
    const st = seeder._groups.get(w)
    if (!e || !st || e.cutting || st.cut !== cut || st.clearedTo !== leave.seq + 1) return false
    return (await blocksHeld(e.core, 0, leave.seq + 1)).length === cut + 1
  })
  t.alike(await blocksHeld(seeder._groupServed.get(w).core, 0, leave.seq + 1), [...Array(cut).keys(), leave.seq], 'the seeder keeps W below its cut and its leave')

  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const pagesStore = openPagesStore(dir)
  const writer = createPagesWriter({ dir, keys, association, seederWs })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  const pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs })
  t.teardown(() => pg.close(), { force: true })
  await pg.ready()
  await until(() => writer.connected() && pg.connected(), { name: 'links up', timeoutMs: 20000 })
  const page = newPage(ctx, keys, 'padaria')
  await writer.createPage(page.args)
  await pagesStore.create({ page: page.key, owner: page.owner })

  t.is((await settled(() => pg.communityJoin(page.key, C), 'community join', 60000)).state, 'member', 'the page joins the community')
  // Each try fetches W again; before #350's goal it waited out the fetch
  // timeout and answered indisponivel every time.
  t.is((await settled(() => pg.groupJoin(page.key, G), 'group join', 60000)).state, 'member', 'the page joins the group with W sparse')
  // The seeder indexes the page's new writer first: its listing is partial
  // meanwhile.
  const posted = await settled(() => pg.groupPost(page.key, G, { text: 'pão quente' }), 'group post', 60000)
  t.ok(Number.isSafeInteger(posted.seq), 'and posts')
  const read = await pg.groupRead(page.key, G)
  t.is(read.incomplete, false, 'its fold is whole')
  const texts = read.items.map((p) => p.text)
  t.ok(texts.includes('antes'), 'the post below the cut counts')
  t.absent(texts.includes('depois'), 'the post past the cut does not')
})
