'use strict'

// Communities and groups as a hosted page, through the page routes of
// apps/cli/lib/account/pages-routes.js, loopback only: a local seeder and
// seed-ws on a local DHT, the account service with pages on and a real
// pages-groups client, and a member node that reads what the page wrote.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until } = require('./helpers/net')
const { createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signAccept } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const member = require('@varanda/core/lib/member')
const groupLib = require('@varanda/core/lib/group')
const groupCrypto = require('@varanda/core/lib/group-crypto')
const { person, startSeeder, syncOnce } = require('../../../packages/core/test/helpers/sync-groups')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createPagesGroups } = require('../lib/account/pages-groups')
const { createAccountServer } = require('../lib/account/server')

const ORIGIN = 'https://varanda.test'
const PAGE_KEYS = 'cd'.repeat(32)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function newKey () {
  const kp = crypto.keyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function googleStub () {
  return { authorizeUrl: () => 'http://127.0.0.1:1/auth', exchange: async () => { throw new Error('unused') } }
}

test('account pages groups: the page joins and posts through the routes, a removed admin is refused', async (t) => {
  t.timeout(600000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  const seeder = await startSeeder(t, bootstrap, assocKp)
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + ws.port

  // A member node creates an open community, an open group and a private one.
  const a = await person(t, assocKp, 'Ana')
  const { community: C } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group: G } = await member.groupCreate(a, { name: 'Praça', join: 'open', community: C })
  const { group: GP } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private', community: C })
  await syncOnce(bootstrap, a)

  const dir = tmpDir(t, 'varanda-account-')
  const store = openAccountStore(dir)
  const terms = openTermsStore(dir)
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const pagesStore = openPagesStore(dir)
  const logs = []
  const log = (e) => logs.push(e)
  const writer = createPagesWriter({ dir, keys, association, seederWs, log })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  const pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs, log })
  t.teardown(() => pg.close(), { force: true })
  await pg.ready()
  await until(() => writer.connected() && pg.connected(), { name: 'links up', timeoutMs: 20000 })
  const accountServer = createAccountServer({
    association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log,
    pages: { keys, writer, pagesStore, dir, pagesGroups: pg, blocklist: { has: () => false }, limits: { reboxEveryMs: 0 } }
  })
  const server = await accountServer.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => server.close(), { force: true })
  const base = 'http://127.0.0.1:' + server.port

  async function api (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  let subSeq = 100
  let termsCount = 0
  async function linked (username) {
    const m = newKey()
    const row = store.start({ member: m.hex, username })
    store.reserve(row.id)
    store.putGoogle(row.id, { sub: '60000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
    await store.finish(row.id, { signature: 'a'.repeat(128) }, issuerKp, issuerCert, association)
    termsCount++
    await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: (String(termsCount) + 'G'.repeat(43)).slice(0, 43), signature: 'a'.repeat(128) })
    return m
  }

  async function start (m, action) {
    const r = await api('/account/pages/start', { member: m.hex, action })
    if (r.status !== 200) throw new Error('start ' + action + ' ' + r.status)
    return r.body
  }

  function sign (m, action, nonce, page, op) {
    return signPage({ action, nonce, member: m.hex, page, association, opHash: opHash(op) }, m.kp)
  }

  async function act (m, action, page, op) {
    const { nonce } = await start(m, action)
    return api('/account/pages/' + action, { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) })
  }

  // Again while the fold is still partial.
  function settled (m, action, page, op, name) {
    return until(async () => {
      const r = await act(m, action, page, op)
      return r.body && r.body.error === 'indisponivel' ? null : r
    }, { name, timeoutMs: 120000, intervalMs: 500 })
  }

  function roster (m, page, fields, nonce) {
    const f = { page, ...fields, at: new Date().toISOString(), nonce, association }
    return { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
  }

  const ana = await linked('ana')
  const bia = await linked('bia')

  // The page, with bia as its admin.
  const created = await start(ana, 'create')
  const P = created.page
  const genesis = roster(ana, P, { gen: 1, owner: ana.hex, admins: [], prev: null }, created.nonce)
  const createOp = { username: 'padaria', name: 'Padaria', bio: '', roster: { gen: 1, admins: [], prev: null, at: genesis.at, nonce: created.nonce } }
  const made = await api('/account/pages/create', { member: ana.hex, nonce: created.nonce, page: P, op: createOp, signature: sign(ana, 'create', created.nonce, P, createOp), record: genesis })
  t.is(made.status, 200, JSON.stringify(made.body))
  {
    const { nonce } = await start(ana, 'invite')
    const row = pagesStore.get(P)
    const record = roster(ana, P, { gen: row.gen + 1, owner: ana.hex, admins: [bia.hex], prev: row.rosterSeq }, nonce)
    const op = { member: bia.hex, gen: row.gen + 1, rosterSignature: record.signature, roster: { owner: ana.hex, admins: [bia.hex], prev: row.rosterSeq, at: record.at, nonce } }
    t.is((await api('/account/pages/invite', { member: ana.hex, nonce, page: P, op, signature: sign(ana, 'invite', nonce, P, op), record })).status, 200)
    const acc = await start(bia, 'accept')
    const f = { page: P, gen: row.gen + 1, rosterSignature: pagesStore.get(P).invites[bia.hex].rosterSignature, at: new Date().toISOString(), nonce: acc.nonce, actor: bia.hex }
    t.is((await api('/account/pages/accept', { member: bia.hex, nonce: acc.nonce, page: P, record: { type: 'page-accept', ...f, signature: signAccept(f, bia.kp) } })).status, 200)
  }

  // Join the community, then the open group, through the routes.
  const joined = await settled(ana, 'community-join', P, { community: C }, 'community join')
  t.is(joined.status, 200, JSON.stringify(joined.body))
  t.is(joined.body.role, 'member', 'the page is a member of the open community')
  const inGroup = await settled(bia, 'group-join', P, { group: G, community: C }, 'group join')
  t.is(inGroup.body.state, 'member', 'an admin joins the open group as the page')
  const status = await act(ana, 'status', P, {})
  t.ok(status.body.communities.some((c) => c.community === C && c.role === 'member'), 'status lists the community')

  const posted = await settled(ana, 'group-post', P, { group: G, text: 'pão quente na praça' }, 'group post')
  t.is(posted.status, 200, JSON.stringify(posted.body))
  t.ok(Number.isSafeInteger(posted.body.seq))
  const seen = await until(async () => {
    await syncOnce(bootstrap, a)
    const r = await member.groupRead(a, { group: G })
    return r.items.find((p) => p.text === 'pão quente na praça') || null
  }, { name: 'member reads the page post', timeoutMs: 180000, intervalMs: 500 })
  t.is(seen.diary, P, 'the member reads the post from the page diary')

  const read = await settled(bia, 'group-read', P, { group: G }, 'group read')
  t.is(read.status, 200)
  t.ok(read.body.items.some((x) => x.text === 'pão quente na praça'), 'an admin reads the group as the page')
  t.is(read.body.role, 'member')
  t.is((await act(bia, 'group-read', P, { group: G, limit: 33 })).body.error, 'pedido-invalido', 'at most 32 a read')
  t.is((await act(bia, 'group-post', P, { group: G, text: '' })).body.error, 'pedido-invalido', 'the group text bounds hold')

  // Private groups: the service holds no group box, so a page without the
  // device-held one joins none, and a post there is a device-sealed envelope.
  t.is((await settled(ana, 'group-join', P, { group: GP }, 'boxless private join')).body.error, 'sem-caixa', 'no group box: no private join')
  t.is((await settled(ana, 'group-post', P, { group: GP, text: 'em claro' }, 'plain private post')).body.error, 'privado', 'no plain post in a private group')
  const kid = { writer: GP, seq: 1 }
  const record = groupLib.groupPost({ text: 'x' })
  const env = groupCrypto.sealRecord(groupLib.sealedInner(record, { writer: G, group: G, kid }), crypto.randomBytes(32))
  const sealOp = { group: G, kid, nonce: env.nonce, box: env.box, at: record.at, writer: G, seq: 1 }
  t.is((await settled(ana, 'group-seal', P, sealOp, 'seal in a public group')).body.error, 'pedido-invalido', 'no envelope in a public group')
  t.is((await act(ana, 'group-seal', P, { ...sealOp, seq: 0 })).body.error, 'pedido-invalido', 'the seal seq is checked before the lock')
  t.is((await act(ana, 'group-seal', P, { ...sealOp, nonce: 'x' })).body.error, 'pedido-invalido', 'and the envelope shape')
  t.is((await act(bia, 'group-rebox', P, {})).body.error, 'sem-permissao', 'only the owner reboxes')
  t.is((await act(ana, 'group-rebox', P, {})).body.error, 'sem-caixa', 'a page with no group box has nothing to rebox')
  await pagesStore.setDm(P, { gen: 1, box: hex(crypto.randomBytes(32)), groupBox: hex(groupCrypto.newBoxKeyPair().publicKey), shares: {}, pending: {}, reboxPending: true, legacyBundle: null, rotatePending: null })
  t.is((await act(bia, 'group-read', P, { group: GP })).body.error, 'aguardando-chave', 'a private action waits while reboxPending')
  const reboxed = await settled(ana, 'group-rebox', P, {}, 'rebox')
  t.is(reboxed.status, 200, JSON.stringify(reboxed.body))
  t.alike(reboxed.body, { groups: [], left: [] }, 'no private membership to move')
  t.is(pagesStore.get(P).dm.reboxPending, false, 'and reboxPending clears')
  const st = await act(ana, 'status', P, {})
  t.is(st.body.reboxPending, false, 'status carries reboxPending')
  t.is(st.body.reboxNeeded, 0, 'and reboxNeeded')
  // A rebox a route could not finish is retried by the service itself.
  const d = pagesStore.get(P).dm
  await pagesStore.setDm(P, { ...d, reboxPending: true })
  t.is((await act(ana, 'status', P, {})).body.reboxPending, true, 'status shows a pending rebox')
  t.is(await until(async () => (await accountServer.pagesReboxSweep()) === 1 || null, { name: 'sweep', timeoutMs: 60000, intervalMs: 500 }), true, 'the sweep reboxes the pending page')
  t.is(pagesStore.get(P).dm.reboxPending, false, 'and clears it')
  // Back to a page without device-held keys, so the remove below needs no rotation.
  await pagesStore.setDm(P, null)

  // Remove bia; from then on she is refused and nothing is written for her.
  {
    const { nonce } = await start(ana, 'remove')
    const row = pagesStore.get(P)
    const record = roster(ana, P, { gen: row.gen + 1, owner: ana.hex, admins: [], prev: row.rosterSeq }, nonce)
    const r = await api('/account/pages/remove', { member: ana.hex, nonce, page: P, record })
    t.is(r.status, 200, JSON.stringify(r.body))
  }
  const length = writer.info(P).length
  const writersBefore = JSON.stringify(pg.writersOf(P))
  t.is((await act(bia, 'group-read', P, { group: GP })).body.error, 'sem-permissao', 'a removed admin cannot read the private group')
  t.is((await act(bia, 'group-join', P, { group: GP })).body.error, 'sem-permissao', 'nor join a group')
  t.is((await act(bia, 'group-post', P, { group: G, text: 'ainda aqui' })).body.error, 'sem-permissao', 'nor post')
  t.is((await act(bia, 'community-leave', P, { community: C })).body.error, 'sem-permissao', 'nor leave')
  t.is(writer.info(P).length, length, 'no block was appended to the page diary')
  t.is(JSON.stringify(pg.writersOf(P)), writersBefore, 'and no writer was minted')

  const logged = JSON.stringify(logs)
  t.absent(logged.includes('pão quente') || logged.includes('ainda aqui'), 'logs carry no text')
  t.absent(logged.includes(P) || logged.includes(C) || logged.includes(G), 'logs carry no key')
})
