'use strict'

// Excluir conta sem a passkey: POST /account/delete/sms/send and
// /account/delete/sms/check (apps/cli/lib/account/delete-routes.js) over the
// deletion codes of apps/cli/lib/account/phone-routes.js. The person types
// the @nome and the number verified on Varanda; a code goes only when the
// number's index is the member's live, verified row, and every other case
// answers the same bytes. Loopback only: the Didit fake of
// helpers/fake-didit.js, real stores in a tmp dir, members linked in-process.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert, createModeratorCert } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signPhone } = require('@varanda/core/lib/phone')
const { openAccountStore } = require('../lib/account/store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { openPasskeyStore } = require('../lib/account/passkey-store')
const { openPhoneStore } = require('../lib/account/phone-store')
const { openDeletionRequests, MAX_AGE_MS } = require('../lib/account/deletion-requests')
const { createPhoneClient } = require('../lib/account/phone-client')
const { createPhoneRoutes, VERIFY_SHADOW_MS } = require('../lib/account/phone-routes')
const { createDeleteRoutes, WAIT_MS } = require('../lib/account/delete-routes')
const { createAccountServer, keyedWindow } = require('../lib/account/server')
const { startFakeDidit, loopbackFetch, PHONE_CODE } = require('./helpers/fake-didit')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const API_KEY = 'test-phone-key-123'
const EMAIL = 'membro@example.test'
const WRONG_CODE = '654321'
const PHONE_A = '+5511987654321'
const PHONE_B = '+5521912345678'
const PHONE_C = '+5531998887777'
const PHONE_D = '+5541991112222'
const PHONE_E = '+5551993334444'
const PHONE_F = '+5561995556666'
const NUMBERS = [PHONE_A, PHONE_B, PHONE_C, PHONE_D, PHONE_E, PHONE_F]
const SENDER = 'Varanda excluir conta'
const NAMES = ['ana', 'bia', 'carla', 'dani', 'eva', 'fabi', 'zeca']
const CBS = { linked: () => true, deleted: () => false, burnable: () => false }

const google = {
  authorizeUrl: () => { throw new Error('google called') },
  exchange: async () => { throw new Error('google called') }
}

function keyPair () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association, assoc }
}

let subSeq = 100
async function linkDirect (accounts, iss, m, username) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub: '50000000000000000' + String(subSeq++).padStart(5, '0'), email: EMAIL })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

async function until (fn, ms = 5000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ana holds PHONE_A (live, verified); bia never verified; carla changed
// PHONE_C for PHONE_E (so PHONE_C is 'trocado'); dani's PHONE_D was released
// ('liberado'); eva has no phone and only verifies through the phone routes;
// fabi holds PHONE_F. `phone: false` turns the feature off. `fresh` keeps
// the clock at the service's start.
// `floor`: the fixed answer time of the check (0 keeps the tests fast).
async function setup (t, { phone = true, moderation: withModeration = true, dailyLimit, floor = 0, fresh = false } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = { offset: 0, passkeysOk: true, requestsOk: true }
  const now = () => Date.now() + c.offset
  const iss = issuer()
  const store = openAccountStore(dir, { now })
  const who = {}
  for (const name of NAMES.slice(0, 6)) {
    who[name] = keyPair()
    await linkDirect(store, iss, who[name], name)
  }
  const moderation = withModeration ? openModerationStore(dir, { now, association: iss.association }) : null
  const passkeys = openPasskeyStore(dir, { now, guard: () => c.passkeysOk })
  const requests = openDeletionRequests(dir, { now, guard: () => c.requestsOk })
  const fake = await startFakeDidit()
  t.teardown(() => fake.close(), { force: true })
  const client = phone ? createPhoneClient({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base) }) : null
  const phones = phone ? openPhoneStore(dir, { key: nodeCrypto.randomBytes(32), now }) : null
  if (phone) {
    await phones.record({ member: who.ana.hex, phone: PHONE_A }, CBS)
    await phones.record({ member: who.carla.hex, phone: PHONE_C }, CBS)
    await phones.record({ member: who.carla.hex, phone: PHONE_E }, CBS)
    await phones.record({ member: who.dani.hex, phone: PHONE_D }, CBS)
    await phones.release(who.dani.hex)
    await phones.record({ member: who.fabi.hex, phone: PHONE_F }, CBS)
  }
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: b4a.toString(modKp.publicKey, 'hex'), date: '2026-10-01T00:00:00.000Z' }, iss.assoc)
  const logs = []
  const opts = {
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    moderation,
    passkeys,
    deletionRequests: requests,
    phones,
    phoneClient: client,
    log: (e) => logs.push(JSON.stringify(e)),
    now,
    deleteSmsFloorMs: floor
  }
  if (dailyLimit !== undefined) opts.phoneDailyLimit = dailyLimit
  const server = createAccountServer(opts)
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  // Past the service's start, where it refuses deletion codes (`fresh` stays).
  if (!fresh) c.offset += VERIFY_SHADOW_MS
  const base = 'http://127.0.0.1:' + listener.port
  const texts = []

  async function post (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) })
    const text = await res.text()
    texts.push(text)
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  async function status (m) {
    const res = await fetch(base + '/account/status?member=' + m.hex)
    return JSON.parse(await res.text())
  }

  // Waits for the background half of every send answered so far.
  let asked = 0
  async function send (username, number) {
    const r = await post('/account/delete/sms/send', { username, phone: number })
    if (r.status === 200) {
      const resolves = store.lookup(username.replace(/^\s*@?/, '').trim().toLowerCase())
      if (resolves !== null && resolves.kind !== 'page') asked++
      await until(() => server.deletionCodeStats().asked === asked && server.deletionCodeStats().settled === asked)
    }
    return r
  }
  const check = (username, number, code) => post('/account/delete/sms/check', { username, phone: number, code })
  const sends = () => fake.seen.filter((r) => r.path === '/v3/phone/send/')
  const checks = () => fake.seen.filter((r) => r.path === '/v3/phone/check/')

  async function apply (blocked) {
    const pulled = await moderation.pull()
    const snapshot = createSnapshot({ seq: 1, date: new Date().toISOString(), blocked }, modKp, modCert)
    await moderation.ack({ changeIds: pulled.changes.map((x) => x.id), snapshot, moderatorCert: modCert })
  }

  return { dir, c, now, iss, store, who, moderation, passkeys, requests, phones, fake, server, logs, texts, post, status, send, check, sends, checks, apply }
}

function noSecrets (t, s) {
  const logs = s.logs.join('\n')
  for (const n of NUMBERS) {
    t.absent(logs.includes(n), 'no number in a log line')
    t.absent(logs.includes(n.slice(3)), 'no national number in a log line')
  }
  t.absent(logs.includes(PHONE_CODE) || logs.includes(WRONG_CODE), 'no code in a log line')
  for (const name of NAMES) t.absent(logs.includes('"' + name + '"') || logs.includes('@' + name), 'no @nome in a log line')
  for (const m of Object.values(s.who)) t.absent(logs.includes(m.hex), 'no key in a log line')
  t.absent(s.texts.join('\n').includes(PHONE_A.slice(3)), 'no number in an answer')
}

test('Excluir conta sem a passkey: the @nome, the verified number and the code only file a request; nothing is scheduled', async (t) => {
  const s = await setup(t)
  const sent = await s.send('@Ana ', PHONE_A)
  t.is(sent.status, 200, sent.text)
  t.alike(sent.body, { sent: true })
  t.is(s.sends().length, 1, 'one code texted')
  t.is(s.sends()[0].body.phone_number, PHONE_A, 'to the number typed')
  t.is(s.sends()[0].body.options.sms_sender_name, SENDER, 'the SMS names its purpose')
  const before = s.now()
  const done = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(done.status, 200, done.text)
  t.alike(done.body, { requested: true })
  t.is(s.checks().length, 1)
  const filed = s.requests.requestedAt(s.who.ana.hex)
  t.ok(filed !== null && filed >= before && filed <= s.now(), 'the request is on file with its time')
  t.is(s.passkeys.hold(s.who.ana.hex), null, 'no hold')
  t.absent((await s.status(s.who.ana)).scheduledDeletion, 'no date on /account/status')
  t.is(s.store.status(s.who.ana.hex).linked, true, 'nothing deleted')
  t.is(s.logs.filter((l) => l.includes('"pedido-sms"')).length, 1)
  t.absent(s.logs.some((l) => l.includes('"agendada')), 'no schedule log, so no push')
  t.ok(s.logs.some((l) => l.includes('"exclusao-enviado"')))

  const replay = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(replay.body.error, 'codigo-invalido', 'the code is spent')
  t.is(s.checks().length, 1, 'a spent code never reaches the provider')

  // A later correct code refreshes the time of the same row.
  s.c.offset += 3600 * 1000
  await s.send('ana', PHONE_A)
  t.is(s.sends().length, 2, 'a request on file does not stop a new code')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { requested: true })
  const refreshed = s.requests.requestedAt(s.who.ana.hex)
  t.ok(refreshed >= filed + 3600 * 1000, 'the time moved to the second request')
  t.is(s.passkeys.hold(s.who.ana.hex), null, 'still no hold')

  // The file is the state: a store opened anew (a restart) reads it.
  const reopened = openDeletionRequests(s.dir, { now: s.now })
  t.is(reopened.requestedAt(s.who.ana.hex), refreshed, 'the request survives a restart')
  t.is(reopened.requestedAt(s.who.fabi.hex), null)

  // A hold already waiting: the date is public, so no code goes.
  await s.passkeys.schedule({ member: s.who.ana.hex, runAt: new Date(s.now() + WAIT_MS).toISOString() })
  s.c.offset += 61000
  await s.send('ana', PHONE_A)
  t.is(s.sends().length, 2, 'no code while a deletion waits')
  noSecrets(t, s)
})

test('Excluir conta sem a passkey: a request older than 30 days is gone, and the sweep drops it from the file', async (t) => {
  const s = await setup(t)
  await s.send('ana', PHONE_A)
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { requested: true })
  const filed = s.requests.requestedAt(s.who.ana.hex)
  s.c.offset += MAX_AGE_MS - 60000
  t.is(s.requests.requestedAt(s.who.ana.hex), filed, 'still on file before 30 days')
  await s.server.deletionSweep()
  t.is(s.requests.holds(s.who.ana.hex), true, 'the sweep keeps a live row')
  s.c.offset += 120000
  t.is(s.requests.requestedAt(s.who.ana.hex), null, 'past 30 days the request is gone')
  t.is(s.requests.holds(s.who.ana.hex), true, 'the row waits for the next write')
  await s.server.deletionSweep()
  t.is(s.requests.holds(s.who.ana.hex), false, 'the sweep removed it from the file')
  t.is(s.store.status(s.who.ana.hex).linked, true, 'and deleted nothing')
})

test('Excluir conta sem a passkey: send answers the same bytes whatever the @nome and number are', async (t) => {
  const s = await setup(t)
  const reference = await s.send('ana', PHONE_A)
  t.is(s.sends().length, 1)
  const cases = [
    ['zeca', PHONE_A, 'an @nome nobody holds'],
    ['ana', PHONE_B, 'a wrong number for a member with a phone'],
    ['bia', PHONE_B, 'a member who never verified a number'],
    ['carla', PHONE_C, 'a number the member changed (trocado)'],
    ['dani', PHONE_D, 'a released number (liberado)'],
    ['fabi', PHONE_A, 'another member\'s number'],
    ['ana', PHONE_A, 'a resend inside 60 s'],
    ['fabi', PHONE_F, 'a deletion already waiting'],
    ['carla', PHONE_E, 'a deleted account']
  ]
  await s.passkeys.schedule({ member: s.who.fabi.hex, runAt: new Date(s.now() + WAIT_MS).toISOString() })
  await s.store.deleteMember(s.who.carla.hex)
  for (const [name, number, what] of cases) {
    const r = await s.send(name, number)
    t.is(r.status, reference.status, what)
    t.is(r.text, reference.text, what)
  }
  t.is(s.sends().length, 1, 'no other code was texted')
  noSecrets(t, s)
})

test('Excluir conta sem a passkey: check answers codigo-invalido for every failure and never asks the provider on a mismatch', async (t) => {
  const s = await setup(t)
  const noPending = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(noPending.status, 400)
  t.alike(noPending.body, { error: 'codigo-invalido' })
  t.is((await s.check('zeca', PHONE_A, PHONE_CODE)).text, noPending.text, 'an @nome nobody holds')
  t.is((await s.check('bia', PHONE_B, PHONE_CODE)).text, noPending.text, 'a member without a phone')
  t.is(s.checks().length, 0, 'none of them reached the provider')

  await s.send('ana', PHONE_A)
  t.is((await s.check('ana', PHONE_B, PHONE_CODE)).text, noPending.text, 'a number other than the one the code went to')
  t.is(s.checks().length, 0, 'a mismatched number never reaches the provider')
  t.is((await s.check('ana', PHONE_A, WRONG_CODE)).text, noPending.text, 'a wrong code')
  t.is(s.checks().length, 1)
  t.is((await s.check('ana', PHONE_A, WRONG_CODE)).text, noPending.text, 'the second attempt')
  t.is((await s.check('ana', PHONE_A, WRONG_CODE)).text, noPending.text, 'the third attempt')
  t.is((await s.check('ana', PHONE_A, PHONE_CODE)).text, noPending.text, 'the right code after three wrong codes')
  t.is(s.checks().length, 3, 'the entry was dropped after the third wrong code')
  t.is(s.requests.requestedAt(s.who.ana.hex), null, 'nothing filed')

  // An expired code.
  s.c.offset += 61000
  await s.send('ana', PHONE_A)
  s.c.offset += 600 * 1000
  t.is((await s.check('ana', PHONE_A, PHONE_CODE)).text, noPending.text, 'an expired code')
  t.is(s.checks().length, 3)

  t.alike((await s.check('ana', PHONE_A, '12345')).body, { error: 'codigo-invalido' })
  t.alike((await s.check('ana', '11987654321', PHONE_CODE)).body, { error: 'telefone-invalido' }, 'E.164 only, as the phone routes')
  t.alike((await s.post('/account/delete/sms/send', { username: 'a', phone: PHONE_A })).body, { error: 'nome-invalido' })
  t.alike((await s.post('/account/delete/sms/send', { username: 'ana', phone: PHONE_A, member: s.who.ana.hex })).body, { error: 'pedido-invalido' })
  t.alike((await s.post('/account/delete/sms/send', { username: 'ana' })).body, { error: 'pedido-invalido' })
  t.is(s.requests.requestedAt(s.who.ana.hex), null)
})

test('Excluir conta sem a passkey: 3 codes a day per matched (member, number); wrong numbers never use them up', async (t) => {
  const s = await setup(t)
  for (let i = 0; i < 6; i++) {
    await s.send('ana', NUMBERS[1 + (i % 5)])
    s.c.offset += 61000
  }
  t.is(s.sends().length, 0, 'wrong numbers text nothing')
  for (let i = 0; i < 3; i++) {
    await s.send('ana', PHONE_A)
    s.c.offset += 61000
  }
  t.is(s.sends().length, 3, 'the wrong numbers spent none of the three')
  const fourth = await s.send('ana', PHONE_A)
  t.alike(fourth.body, { sent: true }, 'the same answer')
  t.is(s.sends().length, 3, 'the fourth matched send in a day texts nothing')
  s.c.offset += 24 * 3600 * 1000
  await s.send('ana', PHONE_A)
  t.is(s.sends().length, 4, 'a new day')
})

async function verifySend (t, s, who, number) {
  const started = await s.post('/account/phone/start', { member: who.hex })
  const nonce = started.body.nonce
  const r = await s.post('/account/phone/send', { member: who.hex, nonce, signature: signPhone({ action: 'send', nonce, member: who.hex, association: s.iss.association }, who.kp), phone: number })
  s.c.offset += 61000
  return r
}

test('Excluir conta sem a passkey: deletion codes and verification never read or spend each other\'s per-number window', async (t) => {
  const s = await setup(t)
  t.alike((await verifySend(t, s, s.who.eva, PHONE_F)).body, { state: 'enviado' })
  t.alike((await verifySend(t, s, s.who.eva, PHONE_F)).body, { state: 'enviado' })
  await s.send('fabi', PHONE_F)
  t.is(s.sends().length, 3, 'the deletion code went')
  s.c.offset += 61000
  const third = await verifySend(t, s, s.who.eva, PHONE_F)
  t.alike(third.body, { state: 'enviado' }, 'the third verification send is the same as without the deletion send')
  const named = s.sends().map((r) => r.body.options.sms_sender_name)
  t.alike(named, [undefined, undefined, SENDER, undefined], 'only the deletion send names a sender')
  t.absent(Object.hasOwn(s.sends()[0].body.options, 'sms_sender_name'), 'a verification send carries no sender key')

  const s2 = await setup(t)
  for (let i = 0; i < 3; i++) await verifySend(t, s2, s2.who.eva, PHONE_A)
  t.is(s2.sends().length, 3, 'three verification sends fill the number\'s verification window')
  await s2.send('ana', PHONE_A)
  t.is(s2.sends().length, 4, 'the owner\'s deletion code still goes')
  for (let i = 0; i < 3; i++) {
    s2.c.offset += 61000
    await s2.send('ana', PHONE_A)
  }
  t.is(s2.sends().length, 6, 'three deletion codes to the number in a day, no fourth')
  noSecrets(t, s2)
})

test('Excluir conta sem a passkey: a full daily ceiling skips the send with the same answer', async (t) => {
  const s = await setup(t, { dailyLimit: 3 })
  await s.send('ana', PHONE_A)
  await s.send('carla', PHONE_E)
  await s.send('fabi', PHONE_F)
  t.is(s.sends().length, 3, 'three deletion codes today: min(50, 3)')
  const unknown = await s.send('zeca', PHONE_B)
  s.c.offset += 61000
  const full = await s.send('ana', PHONE_A)
  t.is(full.status, 200)
  t.is(full.text, unknown.text, 'the same bytes as an unknown @nome')
  t.is(s.sends().length, 3, 'the provider got no call')
  t.ok(s.logs.some((l) => l.includes('"exclusao-teto-diario"')))
  t.alike((await verifySend(t, s, s.who.bia, PHONE_B)).body, { state: 'enviado' }, 'sign-up is not starved by deletion codes')
})

test('Excluir conta sem a passkey: checks with a wrong number change nothing, so the owner is never locked out', async (t) => {
  const s = await setup(t)
  await s.send('ana', PHONE_A)
  for (let i = 0; i < 11; i++) t.alike((await s.check('ana', NUMBERS[1 + (i % 5)], PHONE_CODE)).body, { error: 'codigo-invalido' })
  t.is(s.checks().length, 0)
  const done = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(done.status, 200, 'eleven wrong-number checks spent no window and no attempt')
  t.alike(done.body, { requested: true })
})

test('Excluir conta sem a passkey: a request beside a signed wait leaves the wait as it was', async (t) => {
  const s = await setup(t)
  await s.send('ana', PHONE_A)
  const first = await s.passkeys.schedule({ member: s.who.ana.hex, runAt: new Date(s.now() + WAIT_MS).toISOString() })
  s.c.offset += 60 * 1000
  const done = await s.check('ana', PHONE_A, PHONE_CODE)
  t.alike(done.body, { requested: true })
  t.is(s.passkeys.hold(s.who.ana.hex).runAt, first.runAt, 'the first date stays')
  t.absent(s.logs.some((l) => l.includes('"agendada')), 'no new schedule, so no new push')

  // The signed cancel, from a signed-in device, cancels the wait only.
  const sign = (nonce) => signAccountLink({ phase: 'cancel', nonce, member: s.who.ana.hex, username: 'ana', association: s.iss.association, sub: '' }, s.who.ana.kp)
  const cs = await s.post('/account/delete/cancel/start', { member: s.who.ana.hex })
  const cf = await s.post('/account/delete/cancel/finish', { member: s.who.ana.hex, nonce: cs.body.nonce, signature: sign(cs.body.nonce) })
  t.alike(cf.body, { cancelled: true })
  t.is(s.passkeys.hold(s.who.ana.hex), null)
  t.ok(s.requests.requestedAt(s.who.ana.hex) !== null, 'the request stays on file for the operator to read')
})

test('Excluir conta sem a passkey: a deletion or a new number between send and check makes the code worthless', async (t) => {
  const s = await setup(t)
  await s.send('fabi', PHONE_F)
  await s.phones.record({ member: s.who.fabi.hex, phone: PHONE_B }, CBS)
  t.alike((await s.check('fabi', PHONE_F, PHONE_CODE)).body, { error: 'codigo-invalido' }, 'the number is no longer the live one')
  t.is(s.requests.requestedAt(s.who.fabi.hex), null)

  await s.send('ana', PHONE_A)
  await s.store.deleteMember(s.who.ana.hex)
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' }, 'the deleted @nome resolves to nobody')
  t.is(s.requests.requestedAt(s.who.ana.hex), null)
})

test('Excluir conta sem a passkey: a failed request write answers indisponivel and the same code files it, never a second provider check', async (t) => {
  const s = await setup(t)
  await s.send('ana', PHONE_A)
  s.c.requestsOk = false
  const first = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(first.status, 503)
  t.alike(first.body, { error: 'indisponivel' })
  t.is(s.requests.requestedAt(s.who.ana.hex), null, 'nothing on file')
  t.ok(s.logs.some((l) => l.includes('"pedido-sms-incerto"')))
  s.c.requestsOk = true
  t.alike((await s.check('ana', PHONE_A, WRONG_CODE)).body, { error: 'codigo-invalido' }, 'an approved entry needs the same code')
  const again = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(again.status, 200, again.text)
  t.alike(again.body, { requested: true })
  t.ok(s.requests.requestedAt(s.who.ana.hex) !== null, 'filed on the retry')
  t.is(s.checks().length, 1, 'the provider was asked once')
  t.is(s.passkeys.hold(s.who.ana.hex), null, 'no hold')
})

test('Excluir conta sem a passkey: a blocked member files a request; the operator schedule runs at its date, the request row goes and the burn stays', async (t) => {
  const s = await setup(t)
  await s.apply([s.who.ana.hex])
  await s.phones.sweep({ linked: () => true, deleted: () => false, burnable: (m) => m === s.who.ana.hex, blocked: (m) => m === s.who.ana.hex })
  t.is(s.phones.counts().burned, 1, 'ana\'s number is burned and still sealed')
  await s.send('ana', PHONE_A)
  t.is(s.sends().length, 1)
  const done = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(done.status, 200, done.text)
  t.alike(done.body, { requested: true })
  t.is(s.passkeys.hold(s.who.ana.hex), null, 'the request scheduled nothing')

  // What `varanda account delete` does once the owner wrote in.
  await s.passkeys.schedule({ member: s.who.ana.hex, runAt: new Date(s.now() + WAIT_MS).toISOString() })
  s.c.offset = VERIFY_SHADOW_MS + WAIT_MS - 60000
  await s.server.deletionSweep()
  t.is(s.store.status(s.who.ana.hex).linked, true, 'not before its date')
  t.is(s.requests.holds(s.who.ana.hex), true)
  s.c.offset = VERIFY_SHADOW_MS + WAIT_MS + 60000
  const swept = await s.server.deletionSweep()
  t.is(swept.members, 1)
  t.is(s.store.status(s.who.ana.hex).linked, false)
  t.ok(s.moderation.blocked().some((x) => x.member === s.who.ana.hex), 'the block stays published')
  t.is(s.passkeys.holds(s.who.ana.hex), false, 'the hold went with the purge')
  t.is(s.requests.holds(s.who.ana.hex), false, 'the request row went with the purge')
  t.is(s.phones.live(s.who.ana.hex), null, 'the phone row ended')
  t.is(s.phones.counts().burned, 1, 'still burned')
  t.ok(s.logs.some((l) => l.includes('"agendada-executada"')))
  noSecrets(t, s)
})

test('Excluir conta sem a passkey: at the date the sweep runs the deletion of the operator\'s schedule (owner block, purge), the request row included', async (t) => {
  const s = await setup(t)
  await s.send('ana', PHONE_A)
  t.is((await s.check('ana', PHONE_A, PHONE_CODE)).status, 200)
  await s.passkeys.schedule({ member: s.who.ana.hex, runAt: new Date(s.now() + WAIT_MS).toISOString() })
  s.c.offset = VERIFY_SHADOW_MS + WAIT_MS + 60000
  const swept = await s.server.deletionSweep()
  t.is(swept.members, 1, 'deleted and purged in the same sweep')
  t.is(s.store.status(s.who.ana.hex).linked, false)
  const change = s.moderation.pending().changes.find((x) => x.member === s.who.ana.hex)
  t.is(change.by, 'titular', 'the owner block')
  t.is(s.passkeys.holds(s.who.ana.hex), false)
  t.is(s.requests.holds(s.who.ana.hex), false, 'the request row went')
  t.is(s.phones.live(s.who.ana.hex), null, 'the phone row ended')
  t.alike(await s.status(s.who.ana), { linked: false, deleted: 'pendente' })
})

test('Excluir conta sem a passkey: without the phone feature or the moderation desk both routes are unavailable', async (t) => {
  const off = await setup(t, { phone: false })
  t.alike((await off.post('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })).body, { error: 'indisponivel' })
  t.alike((await off.post('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE })).body, { error: 'indisponivel' })
  const noDesk = await setup(t, { moderation: false })
  const r = await noDesk.post('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })
  t.alike((await noDesk.post('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE })).body, { error: 'indisponivel' })
  t.is(noDesk.sends().length, 0)

  // A request file the service would not have written: no code goes.
  const broken = await setup(t)
  fs.writeFileSync(path.join(broken.dir, 'deletion-requests.json'), '{')
  t.alike((await broken.post('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })).body, { error: 'indisponivel' })
  t.alike((await broken.post('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE })).body, { error: 'indisponivel' })
  t.is(broken.sends().length, 0, 'nothing texted')
})

test('Excluir conta sem a passkey: a refused line, a blocked send and a provider refusal', async (t) => {
  const s = await setup(t)
  s.fake.script({
    phoneCheck (req, res, ctx) {
      ctx.json(res, 200, { status: 'Approved', phone: { is_virtual: true, is_disposable: false, country_code: 'BR', carrier: { type: 'mobile' } } })
    }
  })
  await s.send('ana', PHONE_A)
  const refused = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(refused.status, 400)
  t.alike(refused.body, { error: 'codigo-invalido' }, 'a refused line answers like a wrong code')
  t.ok(s.logs.some((l) => l.includes('"exclusao-recusado-linha"')))
  t.is(s.requests.requestedAt(s.who.ana.hex), null)

  s.fake.script({ phoneSend (req, res, ctx) { ctx.json(res, 200, { status: 'Blocked' }) } })
  s.c.offset += 61000
  const blocked = await s.send('ana', PHONE_A)
  t.alike(blocked.body, { sent: true }, 'a blocked send answers the same')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' })
  t.ok(s.logs.some((l) => l.includes('"exclusao-bloqueado"')))

  s.fake.script({ phoneSend (req, res, ctx) { ctx.json(res, 400, { detail: 'bad' }) } })
  s.c.offset += 61000
  t.alike((await s.send('ana', PHONE_A)).body, { sent: true }, 'a provider refusal answers the same')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' })
  t.is(s.requests.requestedAt(s.who.ana.hex), null)
  noSecrets(t, s)
})

// The routes alone, with the server's helpers stubbed and an in-process
// provider, for the cases a loopback server cannot set up.
async function unit (t, { pagesStore = null, wrapPhones = (p) => p, smsCheckLimit = () => true, checkGate = null } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const accounts = openAccountStore(dir)
  const ana = keyPair()
  await linkDirect(accounts, iss, ana, 'ana')
  const real = openPhoneStore(dir, { key: nodeCrypto.randomBytes(32) })
  await real.record({ member: ana.hex, phone: PHONE_A }, CBS)
  const phones = wrapPhones(real)
  const passkeys = openPasskeyStore(dir)
  const requests = openDeletionRequests(dir)
  const calls = { send: [], check: [], senders: [] }
  const client = {
    send: async ({ phone, senderName }) => { calls.send.push(phone); calls.senders.push(senderName); return { ok: true, status: 'enviado' } },
    check: async ({ code }) => {
      calls.check.push(code)
      if (checkGate) await checkGate()
      return { ok: true, outcome: code === PHONE_CODE ? 'aprovado' : 'codigo-invalido' }
    }
  }
  const refuse = (token) => Object.assign(new Error(token), { token })
  const http = {
    send: (res, status, body) => { res.status = status; res.body = body },
    readJsonBody: async (req) => req.body,
    checkPost: () => {},
    RouteError: class extends Error {},
    refuse,
    keyedWindow,
    fixedWindow: () => () => true
  }
  const shift = { ms: 0 }
  const phoneRoutes = createPhoneRoutes({
    client,
    phones,
    now: () => Date.now() + shift.ms,
    association: iss.association,
    store: { isFull: () => false },
    ageVerified: () => true,
    linked: () => true,
    deleted: (m) => accounts.deletedAt(m) !== null,
    burnable: () => false,
    http
  })
  shift.ms = VERIFY_SHADOW_MS
  const notified = []
  const routes = createDeleteRoutes({
    codes: phoneRoutes.deletionCodes,
    requests,
    smsCheckLimit,
    smsCheckFloorMs: 0,
    accounts,
    moderation: { requestDeletion: async () => ({}) },
    pagesStore,
    passkeys,
    notify: (m) => notified.push(m),
    association: iss.association,
    memberLimit: () => true,
    send: http.send,
    refuse,
    fromStore: (err) => refuse(err.code || 'indisponivel'),
    checkPost: () => {},
    readJsonBody: http.readJsonBody,
    over: () => refuse('over')
  })
  let asked = 0
  async function call (pathname, body) {
    const res = {}
    try {
      await routes.handle({ method: 'POST', body }, res, new URL('http://x' + pathname))
    } catch (err) {
      return { error: err.token }
    }
    if (pathname.endsWith('/send') && accounts.lookup(body.username) !== null) {
      asked++
      await until(() => phoneRoutes.deletionCodes.stats().settled === asked)
    }
    return res
  }
  return { accounts, ana, phones: real, passkeys, requests, calls, notified, call, codes: phoneRoutes.deletionCodes }
}

test('Excluir conta sem a passkey (routes): a live page refuses, a row without a seal texts nothing, a request sends no push', async (t) => {
  const owned = [{ page: 'p'.repeat(64), closed: false, movedTo: null }]
  const u = await unit(t, { pagesStore: { listFor: () => ({ owned, admin: [], invites: [], offers: [] }) } })
  await u.call('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  t.alike(u.calls.send, [PHONE_A])
  t.alike(await u.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE }), { error: 'paginas-ativas' })
  t.is(u.requests.requestedAt(u.ana.hex), null, 'a page owner files nothing')
  t.alike(u.notified, [])

  owned.length = 0
  const unsealed = await unit(t, { wrapPhones: (p) => ({ ...p, verified: () => false }) })
  await unsealed.call('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  t.alike(unsealed.calls.send, [], 'a live row whose seal went (verified false) texts nothing')

  const ok = await unit(t)
  const page = await ok.call('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  t.alike(page.body, { sent: true })
  t.alike(ok.calls.senders, [SENDER], 'the deletion send names its purpose')
  const done = await ok.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE })
  t.alike(done.body, { requested: true })
  t.ok(ok.requests.requestedAt(ok.ana.hex) !== null, 'the request is on file')
  t.is(ok.passkeys.hold(ok.ana.hex), null, 'no hold')
  t.alike(ok.notified, [], 'no push: nothing was scheduled')
})

test('Excluir conta sem a passkey (routes): the number is compared with the live row again right before the schedule', async (t) => {
  // The live row changes while the provider checks the code.
  let swap = null
  const u = await unit(t)
  await u.call('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  const realCheck = u.calls.check
  swap = async () => { await u.phones.record({ member: u.ana.hex, phone: PHONE_B }, CBS) }
  const before = u.codes.check
  u.codes.check = async (...args) => {
    const p = await before(...args)
    await swap()
    return p
  }
  t.alike(await u.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE }), { error: 'codigo-invalido' })
  t.is(u.requests.requestedAt(u.ana.hex), null, 'nothing filed')
  t.is(realCheck.length, 1)
})

const elapsed = async (fn) => {
  const t0 = Date.now()
  const r = await fn()
  return { r, ms: Date.now() - t0 }
}

test('Excluir conta sem a passkey: checks before the send is confirmed spend no window, so the owner\'s code still files the request', async (t) => {
  const s = await setup(t)
  let confirm
  const confirmed = new Promise((resolve) => { confirm = resolve })
  s.fake.script({
    phoneSend (req, res, ctx) {
      confirmed.then(() => ctx.json(res, 200, { status: 'Success' }))
    }
  })
  await s.post('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  await until(() => s.sends().length === 1)
  const early = await Promise.all(Array.from({ length: 12 }, (_, i) => s.check('ana', PHONE_A, i % 2 ? WRONG_CODE : PHONE_CODE)))
  for (const r of early) t.alike(r.body, { error: 'codigo-invalido' })
  t.is(s.checks().length, 0, 'nothing asked before the send is confirmed')
  confirm()
  await until(() => s.server.deletionCodeStats().settled === 1)
  const done = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(done.status, 200, done.text)
  t.alike(done.body, { requested: true })
  t.absent(s.logs.some((l) => l.includes('"exclusao-limite-checagem"')), 'the window was never full')
})

test('Excluir conta sem a passkey: every refusal of the check leaves at the fixed time, the same bytes', async (t) => {
  const FLOOR = 300
  const s = await setup(t, { floor: FLOOR })
  s.fake.script({
    phoneCheck (req, res, ctx) {
      setTimeout(() => ctx.json(res, 200, { status: 'Failed' }), 50)
    },
    phoneSend (req, res, ctx) {
      setTimeout(() => ctx.json(res, 200, { status: 'Success' }), 150)
    }
  })
  const cases = []
  cases.push(['an unknown @nome', await elapsed(() => s.check('zeca', PHONE_A, PHONE_CODE))])
  cases.push(['a wrong number, no code pending', await elapsed(() => s.check('ana', PHONE_B, PHONE_CODE))])
  // The send answers at once and the provider confirms 150 ms later.
  await s.post('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  cases.push(['the right number before the provider confirmed', await elapsed(() => s.check('ana', PHONE_A, PHONE_CODE))])
  await until(() => s.server.deletionCodeStats().settled === 1)
  cases.push(['the right number, a wrong code', await elapsed(() => s.check('ana', PHONE_A, WRONG_CODE))])
  const first = cases[0][1].r
  t.is(first.status, 400)
  t.alike(first.body, { error: 'codigo-invalido' })
  for (const [what, { r, ms }] of cases) {
    t.is(r.text, first.text, what)
    t.ok(ms >= FLOOR - 5, what + ': not before the fixed time (' + ms + ' ms)')
  }
  s.fake.script({ phoneCheck (req, res, ctx) { setTimeout(() => ctx.json(res, 200, { status: 'Approved', phone: { is_virtual: false, is_disposable: false, country_code: 'BR', carrier: { type: 'mobile' } } }), 50) } })
  const ok = await elapsed(() => s.check('ana', PHONE_A, PHONE_CODE))
  t.is(ok.r.status, 200, ok.r.text)
  t.ok(ok.ms < FLOOR, 'the request is not held to the fixed time (' + ok.ms + ' ms)')
})

test('Excluir conta sem a passkey: a provider failure or timeout on check is codigo-invalido at the fixed time', async (t) => {
  const s = await setup(t, { floor: 300 })
  await s.send('ana', PHONE_A)
  s.fake.script({ phoneCheck (req, res, ctx) { ctx.json(res, 500, {}) } })
  const failed = await elapsed(() => s.check('ana', PHONE_A, PHONE_CODE))
  t.alike(failed.r.body, { error: 'codigo-invalido' })
  t.ok(failed.ms >= 295, 'at the fixed time')
  t.ok(s.logs.some((l) => l.includes('"exclusao-checagem-http-500"')))

  // A floor of 1200 ms gives the provider 700 ms.
  const slow = await setup(t, { floor: 1200 })
  await slow.send('ana', PHONE_A)
  slow.fake.script({ phoneCheck () {} })
  const hung = await elapsed(() => slow.check('ana', PHONE_A, PHONE_CODE))
  t.alike(hung.r.body, { error: 'codigo-invalido' })
  t.ok(hung.ms >= 1195 && hung.ms < 2500, 'the provider call ended before the fixed time (' + hung.ms + ' ms)')
  t.is(slow.requests.requestedAt(slow.who.ana.hex), null)
})

test('Excluir conta sem a passkey: an uncertain provider send leaves the code usable', async (t) => {
  const s = await setup(t)
  s.fake.script({ phoneSend (req, res, ctx) { ctx.json(res, 500, {}) } })
  await s.send('ana', PHONE_A)
  t.ok(s.logs.some((l) => l.includes('"exclusao-falhou-http-500"')))
  const done = await s.check('ana', PHONE_A, PHONE_CODE)
  t.is(done.status, 200, 'it may have been texted, so the code is checked')
  t.alike(done.body, { requested: true })
})

test('Excluir conta sem a passkey (routes): a full check window answers codigo-invalido, asks nothing and keeps the code', async (t) => {
  let open = false
  const u = await unit(t, { smsCheckLimit: () => open })
  await u.call('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  t.alike(await u.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE }), { error: 'codigo-invalido' })
  t.is(u.calls.check.length, 0, 'the provider was not asked')
  open = true
  const done = await u.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE })
  t.alike(done.body, { requested: true }, 'the code was kept')
})

test('Excluir conta sem a passkey (routes): one check in flight per member', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const u = await unit(t, { checkGate: () => gate })
  await u.call('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  const first = u.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE })
  await until(() => u.calls.check.length === 1)
  t.alike(await u.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE }), { error: 'codigo-invalido' }, 'a second check while one is in flight')
  release()
  t.alike((await first).body, { requested: true })
  t.is(u.calls.check.length, 1)
})

test('Excluir conta sem a passkey (routes): a deletion after the approval answers conta-excluida', async (t) => {
  const u = await unit(t)
  await u.call('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  const before = u.codes.check
  u.codes.check = async (...args) => {
    const p = await before(...args)
    await u.accounts.deleteMember(u.ana.hex)
    return p
  }
  t.alike(await u.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE }), { error: 'conta-excluida' })
  t.is(u.requests.requestedAt(u.ana.hex), null)
})

test('Excluir conta sem a passkey (routes): a store failure after the approval keeps the code for a retry', async (t) => {
  let broken = false
  const u = await unit(t, { wrapPhones: (p) => ({ ...p, verified: (m) => { if (broken) throw new Error('io'); return p.verified(m) } }) })
  await u.call('/account/delete/sms/send', { username: 'ana', phone: PHONE_A })
  const before = u.codes.check
  u.codes.check = async (...args) => {
    const p = await before(...args)
    broken = true
    return p
  }
  t.alike(await u.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE }), { error: 'indisponivel' })
  u.codes.check = before
  broken = false
  const done = await u.call('/account/delete/sms/check', { username: 'ana', phone: PHONE_A, code: PHONE_CODE })
  t.alike(done.body, { requested: true }, 'the same code files the request')
  t.is(u.calls.check.length, 1, 'without a second provider check')
})

test('Excluir conta sem a passkey: a verification code sent to the number after the deletion code files no request; a deletion code past the verification code\'s life does', async (t) => {
  const s = await setup(t, { floor: 300 })
  await s.send('ana', PHONE_A)
  t.alike((await verifySend(t, s, s.who.eva, PHONE_A)).body, { state: 'enviado' }, 'the verification route answers as always')
  t.is(s.sends().length, 2, 'both codes went to the provider')
  t.absent(Object.hasOwn(s.sends()[1].body.options, 'sms_sender_name'), 'the later one is the verification SMS')
  const late = await elapsed(() => s.check('ana', PHONE_A, PHONE_CODE))
  t.alike(late.r.body, { error: 'codigo-invalido' }, 'the code the provider holds is not the deletion code')
  t.ok(late.ms >= 295, 'at the fixed time (' + late.ms + ' ms)')
  t.is(s.checks().length, 0, 'the provider was not asked')
  t.is(s.requests.requestedAt(s.who.ana.hex), null)
  t.absent(fs.existsSync(path.join(s.dir, 'deletion-requests.json')), 'no row written')

  // A deletion code asked for once the verification code's life is over.
  s.c.offset += VERIFY_SHADOW_MS
  await s.send('ana', PHONE_A)
  t.is(s.sends().length, 3)
  const done = await s.check('ana', PHONE_A, PHONE_CODE)
  t.alike(done.body, { requested: true }, 'the refusal spent nothing the owner needs')
  t.is(s.checks().length, 1)

  // The other order: a verification send first, then the deletion code once
  // the provider can no longer re-send the verification code.
  const s2 = await setup(t)
  t.alike((await verifySend(t, s2, s2.who.eva, PHONE_A)).body, { state: 'enviado' })
  s2.c.offset += VERIFY_SHADOW_MS
  await s2.send('ana', PHONE_A)
  t.is(s2.sends().length, 2)
  t.alike((await s2.check('ana', PHONE_A, PHONE_CODE)).body, { requested: true }, 'a deletion send after a verification send files the request')
  t.ok(s2.requests.requestedAt(s2.who.ana.hex) !== null)
  noSecrets(t, s)
})

test('Excluir conta sem a passkey: a verification send in flight, or ending after the deletion send started, files no request even past a code\'s life from its start; one ended a code\'s life before does', async (t) => {
  const s = await setup(t, { floor: 300 })
  let release = null
  const held = new Promise((resolve) => { release = resolve })
  s.fake.script({
    async phoneSend (req, res, ctx) {
      if (!(ctx.body.options && ctx.body.options.sms_sender_name)) await held
      ctx.json(res, 200, { status: 'Success' })
    }
  })
  const flying = verifySend(t, s, s.who.eva, PHONE_A)
  await until(() => s.sends().length === 1)
  // Past a code's life from the verification send's start: only its being in
  // flight, then its end, can refuse.
  s.c.offset += VERIFY_SHADOW_MS + 1000
  await s.send('ana', PHONE_A)
  t.is(s.sends().length, 2, 'the deletion code went while the verification send waits')
  const during = await elapsed(() => s.check('ana', PHONE_A, PHONE_CODE))
  t.alike(during.r.body, { error: 'codigo-invalido' }, 'refused while the verification send is in flight')
  t.ok(during.ms >= 295, 'at the fixed time (' + during.ms + ' ms)')
  t.is(s.checks().length, 0, 'the provider was not asked')

  release()
  t.alike((await flying).body, { state: 'enviado' }, 'the verification route answers as always')
  const after = await elapsed(() => s.check('ana', PHONE_A, PHONE_CODE))
  t.alike(after.r.body, { error: 'codigo-invalido' }, 'refused: the verification send ended after the deletion send started')
  t.ok(after.ms >= 295, 'at the fixed time (' + after.ms + ' ms)')
  t.is(s.checks().length, 0)
  t.is(s.requests.requestedAt(s.who.ana.hex), null)
  t.absent(fs.existsSync(path.join(s.dir, 'deletion-requests.json')), 'no row written')

  // A verification send that ended past a code's life from its start, then
  // the deletion send: the end alone refuses.
  const s3 = await setup(t)
  let release3 = null
  const held3 = new Promise((resolve) => { release3 = resolve })
  s3.fake.script({
    async phoneSend (req, res, ctx) {
      if (!(ctx.body.options && ctx.body.options.sms_sender_name)) await held3
      ctx.json(res, 200, { status: 'Success' })
    }
  })
  const slow = verifySend(t, s3, s3.who.eva, PHONE_A)
  await until(() => s3.sends().length === 1)
  s3.c.offset += VERIFY_SHADOW_MS + 1000
  release3()
  t.alike((await slow).body, { state: 'enviado' })
  await s3.send('ana', PHONE_A)
  t.alike((await s3.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' }, 'refused: the verification send ended a moment before')
  t.is(s3.checks().length, 0)

  // A verification send that ended a code's life before the deletion send.
  const s2 = await setup(t)
  let release2 = null
  const held2 = new Promise((resolve) => { release2 = resolve })
  s2.fake.script({
    async phoneSend (req, res, ctx) {
      if (!(ctx.body.options && ctx.body.options.sms_sender_name)) await held2
      ctx.json(res, 200, { status: 'Success' })
    }
  })
  const first = verifySend(t, s2, s2.who.eva, PHONE_A)
  await until(() => s2.sends().length === 1)
  release2()
  t.alike((await first).body, { state: 'enviado' })
  s2.c.offset += VERIFY_SHADOW_MS
  await s2.send('ana', PHONE_A)
  t.alike((await s2.check('ana', PHONE_A, PHONE_CODE)).body, { requested: true }, 'the request is filed')
  t.is(s2.checks().length, 1)
  noSecrets(t, s)
})

test('Excluir conta sem a passkey: a deletion send that re-sends a pending verification code files no request', async (t) => {
  const s = await setup(t)
  // The provider's Retry: a send inside the pending code's life re-sends it.
  const answers = []
  const lastAt = new Map()
  s.fake.script({
    phoneSend (req, res, ctx) {
      const last = lastAt.get(ctx.body.phone_number)
      const status = last !== undefined && s.now() - last < 300 * 1000 ? 'Retry' : 'Success'
      if (status === 'Success') lastAt.set(ctx.body.phone_number, s.now())
      answers.push(status)
      ctx.json(res, 200, { status })
    }
  })
  t.alike((await verifySend(t, s, s.who.eva, PHONE_A)).body, { state: 'enviado' })
  await s.send('ana', PHONE_A)
  t.alike(answers, ['Success', 'Retry'], 'the deletion send re-sent the verification code')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' }, 'the shared code files nothing')
  t.is(s.checks().length, 0, 'the provider was not asked')
  t.is(s.requests.requestedAt(s.who.ana.hex), null)
  t.absent(fs.existsSync(path.join(s.dir, 'deletion-requests.json')), 'no row written')

  // Past the shadow of the deletion send above too, which it carried on.
  s.c.offset += VERIFY_SHADOW_MS + 1000
  await s.send('ana', PHONE_A)
  t.is(answers[2], 'Success', 'a fresh deletion code')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { requested: true })
  t.is(s.checks().length, 1)
  noSecrets(t, s)
})

test('Excluir conta sem a passkey: a deletion send right after the service starts files no request', async (t) => {
  const s = await setup(t, { fresh: true })
  await s.send('ana', PHONE_A)
  t.is(s.sends().length, 1, 'the code went')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' }, 'a verification code from before the start may be the one texted')
  s.c.offset += VERIFY_SHADOW_MS
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' }, 'the code sent early stays refused')
  t.is(s.checks().length, 0, 'the provider was not asked')
  t.is(s.requests.requestedAt(s.who.ana.hex), null)

  // Past the shadow the early send carried on as well.
  s.c.offset += 1000
  await s.send('ana', PHONE_A)
  t.is(s.sends().length, 2)
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { requested: true }, 'a deletion send past the start files')
  t.is(s.checks().length, 1)
  noSecrets(t, s)
})

// The provider's Retry re-sends the pending code and, maybe, restarts its
// life (the README checklist asks): this fake does both.
function retryRestarts (s) {
  const answers = []
  const life = new Map()
  s.fake.script({
    phoneSend (req, res, ctx) {
      const n = ctx.body.phone_number
      const status = life.has(n) && s.now() - life.get(n) < 300 * 1000 ? 'Retry' : 'Success'
      life.set(n, s.now())
      answers.push(status)
      ctx.json(res, 200, { status })
    }
  })
  return answers
}

test('Excluir conta sem a passkey: a deletion send in a verification send\'s shadow carries the shadow on, as a Retry may restart the code\'s life', async (t) => {
  const s = await setup(t)
  const answers = retryRestarts(s)
  const t0 = s.now()
  t.alike((await verifySend(t, s, s.who.eva, PHONE_A)).body, { state: 'enviado' })
  await s.send('ana', PHONE_A)
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' }, 'A, a Retry, is refused')
  s.c.offset += 250 * 1000
  t.ok(s.now() - t0 > VERIFY_SHADOW_MS + 1000, 'B is past the verification send\'s shadow')
  await s.send('ana', PHONE_A)
  t.alike(answers, ['Success', 'Retry', 'Retry'], 'B re-sent the same code, still live')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' }, 'B, inside A\'s shadow, is refused')
  t.is(s.checks().length, 0, 'the provider was not asked')
  t.is(s.requests.requestedAt(s.who.ana.hex), null)

  s.c.offset += VERIFY_SHADOW_MS + 1000
  await s.send('ana', PHONE_A)
  t.is(answers[3], 'Success', 'a fresh deletion code')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { requested: true }, 'past every shadow it files')
  t.is(s.checks().length, 1)
  noSecrets(t, s)
})

test('Excluir conta sem a passkey: a deletion send in the start window carries the shadow on', async (t) => {
  const s = await setup(t, { fresh: true })
  const answers = retryRestarts(s)
  const boot = s.now()
  s.c.offset += 200 * 1000
  await s.send('ana', PHONE_A)
  s.c.offset += 110 * 1000
  t.ok(s.now() - boot > VERIFY_SHADOW_MS, 'B is past the start window')
  await s.send('ana', PHONE_A)
  t.alike(answers, ['Success', 'Retry'], 'B re-sent the code A carried from the start window')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { error: 'codigo-invalido' }, 'B, inside A\'s shadow, is refused')
  t.is(s.checks().length, 0, 'the provider was not asked')
  t.is(s.requests.requestedAt(s.who.ana.hex), null)

  s.c.offset += VERIFY_SHADOW_MS + 1000
  await s.send('ana', PHONE_A)
  t.is(answers[2], 'Success', 'a fresh deletion code')
  t.alike((await s.check('ana', PHONE_A, PHONE_CODE)).body, { requested: true }, 'past every shadow it files')
  noSecrets(t, s)
})
