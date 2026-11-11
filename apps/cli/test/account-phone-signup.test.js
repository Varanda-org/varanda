'use strict'

// apps/cli/lib/account/server.js /account/finish without Google: a member
// whose Brazilian mobile the phone routes verified links with sub
// phoneSub(member), on the cookie path and on the app V-header path, and a
// number recorded for another member while the finish waits can never leave
// a link without a phone record. Loopback only: the SMS stub, a real phone
// store and a real account store in tmp dirs, and a Google stub that counts
// every call.

const test = require('brittle')
const net = require('node:net')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signPhone } = require('@varanda/core/lib/phone')
const { openAccountStore, phoneSub } = require('../lib/account/store')
const { openInvitesStore, inviteId } = require('../lib/account/invites-store')
const { createAccountServer, COOKIE } = require('../lib/account/server')
const { STUB_CODE } = require('../scripts/phone-stub')
const { linkByPhone, phoneServerOptions } = require('./helpers/phone-link')
const { tmpDir } = require('./helpers/net')

const PHONE_A = '+5511987654321'
const COOKIE_RE = new RegExp('^' + COOKIE + '=([A-Za-z0-9_-]+);')

function googleStub () {
  const g = { calls: 0 }
  g.authorizeUrl = () => {
    g.calls++
    return 'https://accounts.google.test/auth?state=x'
  }
  g.exchange = async () => {
    g.calls++
    throw new Error('google called')
  }
  return g
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association }
}

function member () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

// The account service checks Origin against its own origin, and the shared
// driver sends its fetch base as Origin, so the service listens on a port
// known before it is created.
async function freePort () {
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address()
  await new Promise((resolve) => srv.close(resolve))
  return port
}

// `phone: false` leaves the phone client and store null. `wrap(phones)`
// returns the phone store the service is given. `inviting: true` opens the
// invites sidecar as account-invites.test.js does.
async function setup (t, { phone = true, wrap, inviting = false } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const store = openAccountStore(dir)
  const invites = inviting ? openInvitesStore(dir, { perWeek: 2, isUsed: (id) => store.inviteUsed(id) }) : null
  const google = googleStub()
  const opts = phone ? phoneServerOptions() : null
  const phones = opts === null ? null : opts.phones
  const logs = []
  const port = await freePort()
  const origin = 'http://127.0.0.1:' + port
  const server = createAccountServer({
    association: iss.association,
    origin,
    google,
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    invites,
    log: (e) => logs.push(JSON.stringify(e)),
    phoneClient: opts === null ? null : opts.phoneClient,
    phones: phones === null || !wrap ? phones : wrap(phones)
  })
  const listener = await server.listen({ host: '127.0.0.1', port })
  t.teardown(() => listener.close(), { force: true })

  async function post (pathname, body, cookie) {
    const headers = { origin, 'content-type': 'application/json' }
    if (cookie) headers.cookie = COOKIE + '=' + cookie
    const res = await fetch(origin + pathname, { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body) })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, body: parsed, text }
  }

  // The finish statement names phoneSub(member) as its subject, which is
  // what account.sign at 'finish' needs (a non-empty sub).
  function signer (who) {
    return (fields) => {
      if (fields.phase === 'finish') return signAccountLink({ ...fields, sub: phoneSub(who.hex), association: iss.association }, who.kp)
      return signPhone({ ...fields, association: iss.association }, who.kp)
    }
  }

  async function startLink (who, username, invite) {
    const res = await post('/account/start', invite === undefined ? { member: who.hex, username } : { member: who.hex, username, invite })
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
    let cookie = null
    for (const line of raw) {
      const m = COOKIE_RE.exec(line)
      if (m) cookie = m[1]
    }
    return { res, nonce: res.body && res.body.nonce, cookie, username }
  }

  async function phoneStep (who, action, extra) {
    const started = await post('/account/phone/start', { member: who.hex })
    if (started.status !== 200) return started
    const nonce = started.body.nonce
    return post('/account/phone/' + action, { member: who.hex, nonce, signature: signer(who)({ action, nonce, member: who.hex }), ...extra })
  }

  async function verify (who, number) {
    const sent = await phoneStep(who, 'send', { phone: number })
    if (sent.status !== 200 || sent.body.state !== 'enviado') return sent
    return phoneStep(who, 'check', { code: STUB_CODE })
  }

  function finishLink (who, started, sub = phoneSub(who.hex)) {
    const signature = signAccountLink({ phase: 'finish', nonce: started.nonce, member: who.hex, username: started.username, association: iss.association, sub }, who.kp)
    return post('/account/finish', { signature }, started.cookie)
  }

  return { iss, store, invites, google, phones, logs, origin, post, signer, startLink, phoneStep, verify, finishLink }
}

function notLinked (t, s, who) {
  t.is(s.store.status(who.hex).linked, false, 'no link')
  t.is(s.store.memberForSub(phoneSub(who.hex)), null, 'no link under the phone subject')
}

function linkedByPhone (t, s, who, body) {
  t.is(typeof body.cert, 'object', 'the answer carries the certificate')
  t.is(s.store.status(who.hex).linked, true, 'linked')
  t.is(s.store.memberForSub(phoneSub(who.hex)), who.hex, 'linked under the phone subject')
  t.ok(s.phones.verified(who.hex), 'the phone record is live')
}

test('a verified mobile links a member on the cookie path with no Google call', async (t) => {
  const s = await setup(t)
  const who = member()
  const body = await linkByPhone({ origin: s.origin, member: who.hex, username: 'bruna', sign: s.signer(who), app: false })
  linkedByPhone(t, s, who, body)
  t.is(s.google.calls, 0, 'Google never called')
  t.is(s.store.lookup('bruna').member, who.hex)
  for (const line of s.logs) t.absent(line.includes(STUB_CODE), 'no code in the logs')
})

test('a verified mobile links a member on the app V-header path with no redeem code', async (t) => {
  const s = await setup(t)
  const who = member()
  const body = await linkByPhone({ origin: s.origin, member: who.hex, username: 'carla', sign: s.signer(who), app: true })
  linkedByPhone(t, s, who, body)
  t.is(s.google.calls, 0, 'Google never called')
})

test('a member without a verified mobile gets telefone-pendente, not expirado', async (t) => {
  const s = await setup(t)
  const who = member()
  const started = await s.startLink(who, 'diana')
  t.is(started.res.status, 200)
  t.ok(started.cookie)
  const done = await s.finishLink(who, started)
  t.is(done.status, 403)
  t.is(done.body.error, 'telefone-pendente')
  notLinked(t, s, who)
  // The row survives the refusal: verifying and finishing again links.
  t.is((await s.verify(who, PHONE_A)).body.state, 'verificado')
  const again = await s.finishLink(who, started)
  t.is(again.status, 200)
  linkedByPhone(t, s, who, again.body)
})

test('the finish statement must name the phone subject', async (t) => {
  const s = await setup(t)
  const who = member()
  const started = await s.startLink(who, 'elisa')
  t.is((await s.verify(who, PHONE_A)).body.state, 'verificado')
  const wrong = await s.finishLink(who, started, 'sub-de-outra-pessoa')
  t.is(wrong.body.error, 'assinatura-invalida')
  notLinked(t, s, who)
})

test('without phone configuration a finish with no Google answer stays expirado', async (t) => {
  const s = await setup(t, { phone: false })
  const who = member()
  const started = await s.startLink(who, 'flora')
  t.is(started.res.status, 200)
  const done = await s.finishLink(who, started)
  t.is(done.body.error, 'expirado')
  t.is(s.store.status(who.hex).linked, false)
})

test('a record of the same number for another member queued before the finish leaves no link', async (t) => {
  const s = await setup(t)
  const a = member()
  const b = member()
  const started = await s.startLink(a, 'gabi')
  t.is((await s.verify(a, PHONE_A)).body.state, 'verificado')
  // Queued before A's finish, as a check for B that had already passed the
  // provider would be: A is not linked yet, so B's record ends A's row.
  const queued = s.phones.record({ member: b.hex, phone: PHONE_A }, { linked: (m) => s.store.status(m).linked, burnable: () => false, deleted: () => false })
  const done = await s.finishLink(a, started)
  await queued
  t.is(done.body.error, 'telefone-pendente')
  notLinked(t, s, a)
  t.absent(s.phones.verified(a.hex), 'A holds no phone record')
  t.ok(s.phones.verified(b.hex))
})

test('the finish looks again once the records queued ahead of it landed', async (t) => {
  const b = member()
  let armed = null
  let queued = null
  const s = await setup(t, {
    wrap: (phones) => ({
      ...phones,
      settled: (m) => {
        if (armed !== null && m === armed) {
          armed = null
          // Lands between the first phone check and the link, as a record
          // whose ownership test ran before the finish marked the member.
          queued = phones.record({ member: b.hex, phone: PHONE_A }, { linked: () => false, burnable: () => false, deleted: () => false })
        }
        return phones.settled(m)
      }
    })
  })
  const a = member()
  const started = await s.startLink(a, 'helena')
  t.is((await s.verify(a, PHONE_A)).body.state, 'verificado')
  armed = a.hex
  const done = await s.finishLink(a, started)
  await queued
  t.ok(queued !== null, 'the record was queued during the finish')
  t.is(done.body.error, 'telefone-pendente')
  notLinked(t, s, a)
  t.absent(s.phones.verified(a.hex))
})

test('a check for the same number while a finish is in flight refuses telefone-em-uso', async (t) => {
  let release = null
  let entered = null
  const inFlight = new Promise((resolve) => { entered = resolve })
  const s = await setup(t, {
    wrap: (phones) => ({
      ...phones,
      settled: async (m) => {
        if (release === null) {
          const gate = new Promise((resolve) => { release = resolve })
          entered()
          await gate
        }
        return phones.settled(m)
      }
    })
  })
  const a = member()
  const b = member()
  const started = await s.startLink(a, 'iara')
  t.is((await s.verify(a, PHONE_A)).body.state, 'verificado')
  const finishing = s.finishLink(a, started)
  await inFlight
  const taken = await s.verify(b, PHONE_A)
  t.is(taken.body.error, 'telefone-em-uso', 'the member being linked holds the number')
  release()
  const done = await finishing
  t.is(done.status, 200)
  linkedByPhone(t, s, a, done.body)
  t.absent(s.phones.verified(b.hex))
})

// An inviter linked straight through the store, and one code it issued.
async function inviteCode (s) {
  const inviter = member()
  const row = s.store.start({ member: inviter.hex, username: 'convida' })
  s.store.reserve(row.id)
  s.store.putGoogle(row.id, { sub: '30000000000000000001', email: 'convida@example.test' })
  await s.store.finish(row.id, { signature: 'a'.repeat(128) }, s.iss.keyPair, s.iss.cert, s.iss.association)
  const { code } = await s.invites.issue(inviter.hex)
  return { code, id: inviteId(code) }
}

test('with invites on, a valid code and a verified mobile link the member and spend the code', async (t) => {
  const s = await setup(t, { inviting: true })
  const { code, id } = await inviteCode(s)
  t.is(s.invites.check(id), null, 'the code is usable')
  const who = member()
  const body = await linkByPhone({ origin: s.origin, member: who.hex, username: 'joana', sign: s.signer(who), invite: code })
  linkedByPhone(t, s, who, body)
  t.is(s.google.calls, 0, 'Google never called')
  t.ok(s.store.inviteUsed(id), 'the link records the invite')
  t.is(s.invites.check(id), 'convite-invalido', 'the sidecar is marked')
  t.ok(s.logs.includes(JSON.stringify({ event: 'convite', reason: 'usado' })))
  for (const line of s.logs) t.absent(line.includes(code), 'no code in the logs')
})

test('with invites on, an unverified member keeps the row and the code unspent', async (t) => {
  const s = await setup(t, { inviting: true })
  const { code, id } = await inviteCode(s)
  const who = member()
  const started = await s.startLink(who, 'kelly', code)
  t.is(started.res.status, 200)
  const done = await s.finishLink(who, started)
  t.is(done.status, 403)
  t.is(done.body.error, 'telefone-pendente')
  notLinked(t, s, who)
  t.absent(s.store.inviteUsed(id), 'the directory records no invite')
  t.is(s.invites.check(id), null, 'the sidecar is not marked')
  // The reservation and the row survive: another key cannot take the code,
  // and the same row links once the number is verified.
  const other = await s.startLink(member(), 'lara', code)
  t.is(other.res.body.error, 'convite-invalido')
  t.is((await s.verify(who, PHONE_A)).body.state, 'verificado')
  const again = await s.finishLink(who, started)
  t.is(again.status, 200)
  linkedByPhone(t, s, who, again.body)
  t.ok(s.store.inviteUsed(id))
  t.is(s.invites.check(id), 'convite-invalido')
})

// A phone store whose settled(member) holds the armed member's finish, once,
// until the test releases it.
function heldSettled () {
  const h = { armed: null, release: null }
  h.entered = new Promise((resolve) => { h.enter = resolve })
  h.wrap = (phones) => ({
    ...phones,
    settled: async (m) => {
      if (h.armed !== null && m === h.armed) {
        h.armed = null
        await new Promise((resolve) => {
          h.release = resolve
          h.enter()
        })
      }
      return phones.settled(m)
    }
  })
  return h
}

test('an unsigned start for the member cannot evict the row a phone finish is linking', async (t) => {
  const h = heldSettled()
  const s = await setup(t, { wrap: h.wrap })
  const who = member()
  const started = await s.startLink(who, 'nina')
  t.is((await s.verify(who, PHONE_A)).body.state, 'verificado')
  h.armed = who.hex
  const finishing = s.finishLink(who, started)
  await h.entered
  // Enough starts to fill the member's unproven rows and evict the oldest.
  for (const username of ['olga', 'paula', 'quiteria']) {
    const other = await s.startLink(who, username)
    t.is(other.res.status, 400, 'start for ' + username + ' refused')
    t.is(other.res.body.error, 'pedido-invalido')
  }
  h.release()
  const done = await finishing
  t.is(done.status, 200)
  linkedByPhone(t, s, who, done.body)
  t.is(s.store.lookup('nina')?.member, who.hex)
  const after = await s.startLink(who, 'rita')
  t.is(after.res.body.error, 'conta-vinculada', 'once the finish ends, start answers as for any linked key')
})

test('with invites on, an unsigned start with the same code cannot take over a row a phone finish is linking', async (t) => {
  const h = heldSettled()
  const s = await setup(t, { inviting: true, wrap: h.wrap })
  const { code, id } = await inviteCode(s)
  const who = member()
  const started = await s.startLink(who, 'sofia', code)
  t.is(started.res.status, 200)
  t.is((await s.verify(who, PHONE_A)).body.state, 'verificado')
  h.armed = who.hex
  const finishing = s.finishLink(who, started)
  await h.entered
  const other = await s.startLink(who, 'tania', code)
  t.is(other.res.status, 400)
  t.is(other.res.body.error, 'pedido-invalido')
  h.release()
  const done = await finishing
  t.is(done.status, 200)
  linkedByPhone(t, s, who, done.body)
  t.ok(s.store.inviteUsed(id), 'the link records the invite')
  t.is(s.invites.check(id), 'convite-invalido', 'the sidecar is marked')
})
