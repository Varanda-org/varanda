'use strict'

// apps/cli/lib/account/age-routes.js mounted by server.js: hosted age
// verification with Didit (policy, start, session, result) and the gates
// that keep a key without a recorded band from a Google sign-in, a
// certificate, a rename or an invite. Loopback only: the Didit fake of
// helpers/fake-didit.js, members linked in-process, and a Google stub whose
// exchange is never reached.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signAge } = require('@varanda/core/lib/age')
const { verifyAgeVerified, verifyAgeSince } = require('@varanda/core/lib/age-proof')
const { signTerms, TERMS_VERSION } = require('@varanda/core/lib/terms')
const { signInvite } = require('@varanda/core/lib/invite')
const { openAccountStore } = require('../lib/account/store')
const { openAgeStore } = require('../lib/account/age-store')
const { openInvitesStore, inviteId } = require('../lib/account/invites-store')
const { pairInvites } = require('../lib/account/invites-pair')
const { FEIRA_AGE_DAILY } = require('../lib/account/age-routes')
const { createDidit } = require('../lib/account/didit')
const { createAccountServer, COOKIE } = require('../lib/account/server')
const { createAgeRoutes } = require('../lib/account/age-routes')
const { settleAgeCheck, readAgeCheck, startAgeCheck, directoryFloor } = require('../lib/account/age-check-state')
const { readEnv } = require('../lib/commands/account')
const { UsageError } = require('../lib/cli')
const { startFakeDidit, loopbackFetch, SESSION_TOKEN } = require('./helpers/fake-didit')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const API_KEY = 'test-key-123'
const WORKFLOW = '11111111-2222-4333-8444-555555555555'
const SUB = '1098765432109876543210'
const EMAIL = 'membro@example.test'
const DOB = '2009-03-14'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const GOOGLE_URL = 'https://accounts.google.test/auth?state=x'

// authorizeUrl answers a fixed URL so an allowed authorize is visible; the
// code exchange is never reached by these tests.
function googleStub () {
  const g = { calls: 0 }
  g.authorizeUrl = () => {
    g.calls++
    return GOOGLE_URL
  }
  g.exchange = async () => { throw new Error('google called') }
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

let subSeq = 100
function nextSub () {
  return '30000000000000000' + String(subSeq++).padStart(5, '0')
}

async function linkDirect (store, iss, m, username, sub = nextSub()) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub, email: EMAIL })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

async function waitFor (fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

// `age: false` leaves didit and ages null. `inviting` opens an invites
// sidecar; `maxMembers` caps the directory. `c.guardOk = false` makes every
// age.json write fail. `withIssuer: false` builds a service with no issuer.
// `feira: { perWeek, named = true }` pairs a Feira store (feira-invites.json)
// with the member invites; the store names the owner through inviterOf
// (`named: false` removes it).
async function setup (t, { age = true, inviting = false, maxMembers = null, dailyLimit, diditTimeoutMs, burst, since, withIssuer = true, ageCheck, floor, feira = null } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = { offset: 0, guardOk: true }
  c.now = () => Date.now() + c.offset
  const iss = issuer()
  const store = openAccountStore(dir, { now: c.now, maxMembers })
  const linked = member()
  await linkDirect(store, iss, linked, 'ana', SUB)
  const fake = await startFakeDidit()
  t.teardown(() => fake.close(), { force: true })
  const didit = age ? createDidit({ apiKey: API_KEY, workflowId: WORKFLOW, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base), ...(diditTimeoutMs ? { timeoutMs: diditTimeoutMs } : {}) }) : null
  const ages = age ? openAgeStore(dir, { now: c.now, guard: () => c.guardOk }) : null
  const primary = inviting ? openInvitesStore(dir, { now: c.now, perWeek: 5, isUsed: (id) => store.inviteUsed(id) }) : null
  let feiraStore = null
  if (feira !== null) {
    const real = openInvitesStore(dir, { file: 'feira-invites.json', ttlMs: 3600 * 1000, capOn: 'use', maxRows: 20000, pruneUnused: true, now: c.now, perWeek: feira.perWeek, isUsed: (id) => store.inviteUsed(id) })
    // The real store names the owner (inviterOf); `named: false` removes it
    // to prove the pair fails closed.
    feiraStore = feira.named === false ? { ...real, inviterOf: undefined } : real
  }
  const invites = primary !== null && feiraStore !== null ? pairInvites(primary, feiraStore) : primary
  const google = googleStub()
  const logs = []
  const texts = []
  const opts = {
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: withIssuer ? { keyPair: iss.keyPair, cert: iss.cert } : null,
    invites,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now
  }
  if (age) {
    opts.didit = didit
    opts.ages = ages
  }
  if (dailyLimit !== undefined) opts.ageDailyLimit = dailyLimit
  if (since !== undefined) opts.ageSince = since
  if (ageCheck !== undefined) opts.ageCheck = ageCheck
  // `floor(store, ages, linked)`: the directory floor as a start computes it.
  if (floor !== undefined) opts.ageDirectoryFloor = await floor(store, ages, linked)
  if (burst !== undefined) {
    opts.burst = burst
    opts.ratePerSecond = burst
  }
  const server = createAccountServer(opts)
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  // `app`: the native app's request (no Origin, x-varanda-client: app).
  async function api (method, pathname, { body, cookie, app = false } = {}) {
    const init = { method, redirect: 'manual', headers: {} }
    if (cookie) init.headers.cookie = COOKIE + '=' + cookie
    if (app) init.headers['x-varanda-client'] = 'app'
    if (body !== undefined) {
      if (!app) init.headers.origin = ORIGIN
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(base + pathname, init)
    const text = await res.text()
    texts.push(text, res.headers.get('location') || '', res.headers.get('set-cookie') || '')
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, headers: res.headers, body: parsed, text }
  }
  const post = (pathname, body, extra = {}) => api('POST', pathname, { body, ...extra })

  const signFor = (who, action, nonce) => signAge({ action, nonce, member: who.hex, association: iss.association }, who.kp)
  const start = (who) => post('/account/age/start', { member: who.hex })

  async function step (who, action, extra = {}) {
    const started = await start(who)
    if (started.status !== 200) return started
    const nonce = started.body.nonce
    return post('/account/age/' + action, { member: who.hex, nonce, signature: signFor(who, action, nonce), ...extra })
  }

  const creates = () => fake.seen.filter((r) => r.method === 'POST' && r.path === '/v3/session/')
  const deletes = () => fake.seen.filter((r) => r.method === 'DELETE')
  const decisions = () => fake.seen.filter((r) => r.method === 'GET')
  const lastSession = () => [...fake.sessions.keys()].pop()

  return { dir, c, iss, store, ages, invites, feiraStore, fake, google, linked, logs, texts, api, post, signFor, start, step, creates, deletes, decisions, lastSession }
}

// Opens a session for `who` and scripts its Didit decision.
async function opened (s, who, decision, extra) {
  const r = await s.step(who, 'session', extra)
  if (r.status !== 200 || typeof r.body.url !== 'string') return r
  s.fake.sessions.set(s.lastSession(), decision)
  return r
}

function sign (s, m, phase, nonce, username, sub = '') {
  return signAccountLink({ phase, nonce, member: m.hex, username, association: s.iss.association, sub }, m.kp)
}

function cookieOf (res) {
  const m = /^__Host-varanda-link=([A-Za-z0-9_-]+);/.exec(res.headers.get('set-cookie') || '')
  return m ? m[1] : null
}

// `previous`: the link cookie of this browser's earlier row, which lets a
// restart take over its invite reservation.
async function authorize (s, m, username, invite, previous) {
  const body = { member: m.hex, username }
  if (invite !== undefined) body.invite = invite
  const started = await s.post('/account/start', body, previous ? { cookie: previous } : {})
  if (started.status !== 200) return { started, auth: started }
  const cookie = cookieOf(started)
  const auth = await s.post('/account/authorize', { signature: sign(s, m, 'reserve', started.body.nonce, username) }, { cookie })
  return { started, cookie, auth }
}

// Skips the Google round trip: the row gets its subject straight from the store.
async function finish (s, m, username, cookie) {
  s.store.putGoogle(cookie, { sub: nextSub(), email: EMAIL })
  const pending = await s.api('GET', '/account/pending', { cookie })
  return s.post('/account/finish', { signature: sign(s, m, 'finish', pending.body.nonce, username, pending.body.sub) }, { cookie })
}

async function renameStart (s, m, username) {
  return s.post('/account/rename/start', { member: m.hex, username })
}

const DOC = (age) => ({ status: 'Approved', id_verifications: [{ status: 'Approved', age, date_of_birth: DOB, first_name: 'Fulana' }] })
const FACE = (age) => ({ status: 'Approved', liveness_checks: [{ status: 'Approved', age_estimation: age }] })

function ageFile (s) {
  try {
    return JSON.parse(fs.readFileSync(path.join(s.dir, 'age.json'), 'utf8'))
  } catch {
    return null
  }
}

function noPersonalData (t, s) {
  const all = s.texts.join('\n') + '\n' + s.logs.join('\n')
  const logs = s.logs.join('\n')
  t.absent(all.includes(API_KEY), 'no api key')
  t.absent(all.includes(SESSION_TOKEN), 'no session token')
  t.absent(all.includes('session_token'), 'no session_token field')
  t.absent(all.includes('date_of_birth') || all.includes(DOB), 'no birth date')
  t.absent(all.includes(EMAIL), 'no e-mail')
  t.absent(all.includes(SUB), 'no sub')
  // The hosted URL (which carries the id) goes only to its own member.
  const withoutUrls = all.replace(/https:\/\/verify\.didit\.test\/session\/[A-Za-z0-9-]+/g, '')
  for (const id of s.fake.seen.map((r) => r.path.split('/')[3]).filter(Boolean)) {
    t.absent(withoutUrls.includes(id), 'no session id outside its url')
  }
  t.absent(logs.includes('verify.didit.test'), 'no session url in a log line')
  t.absent(/age_estimation|"age"|16-17|18\+/.test(all), 'no age or band in a response or log line')
}

test('age off: policy says not required, the routes answer 503, the gates stay open', async (t) => {
  const s = await setup(t, { age: false, inviting: true })
  const policy = await s.api('GET', '/account/age/policy')
  t.is(policy.status, 200)
  t.alike(policy.body, { required: false })

  const m = member()
  const st = await s.start(m)
  t.is(st.status, 503)
  t.alike(st.body, { error: 'indisponivel' })
  for (const action of ['session', 'result']) {
    const r = await s.post('/account/age/' + action, { member: m.hex, nonce: 'A'.repeat(43), signature: 'a'.repeat(128) })
    t.is(r.status, 503, action)
    t.alike(r.body, { error: 'indisponivel' })
  }

  // Already linked member: rename and invites as before.
  const rn = await renameStart(s, s.linked, 'ana')
  t.is(rn.status, 200, rn.text)
  const inv = await s.post('/account/invites/start', { member: s.linked.hex })
  t.is(inv.status, 200, inv.text)

  // A fresh key with an invite: authorize reaches Google and finish links.
  const started = await s.post('/account/invites/start', { member: s.linked.hex })
  const code = (await s.post('/account/invites/finish', {
    member: s.linked.hex,
    nonce: started.body.nonce,
    signature: signInvite({ action: 'issue', nonce: started.body.nonce, member: s.linked.hex, association: s.iss.association }, s.linked.kp)
  })).body.code
  const a = await authorize(s, m, 'bia', code)
  t.is(a.auth.status, 200, a.auth.text)
  t.is(a.auth.body.authorizeUrl, GOOGLE_URL)
  const done = await finish(s, m, 'bia', a.cookie)
  t.is(done.status, 200, done.text)
  t.ok(s.store.status(m.hex).linked)
  t.is(s.creates().length, 0, 'Didit never called')
})

const SINCE = '2026-10-29T00:00:00.000Z'

// Installed app versions refuse a policy body with any key besides
// `required`, so since lives on its own route.
test('age on with since: the policy stays exactly { required: true }', async (t) => {
  const s = await setup(t, { since: SINCE })
  const policy = await s.api('GET', '/account/age/policy')
  t.is(policy.status, 200)
  t.alike(policy.body, { required: true })
  t.absent('since' in policy.body)
})

const BEFORE = '2026-10-28T09:00:00.000Z'
const AFTER = '2026-10-30T15:30:00.000Z'

test('age since route: null until the first band, then signed and never earlier than the day after that band', async (t) => {
  const s = await setup(t, { since: SINCE })
  const none = await s.api('GET', '/account/age/since')
  t.is(none.status, 200)
  t.alike(none.body, { since: null }, 'no band on record yet')

  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: AFTER })
  const r = await s.api('GET', '/account/age/since')
  t.is(r.status, 200)
  t.alike(Object.keys(r.body), ['since'])
  t.is(r.body.since.type, 'age-since')
  t.is(r.body.since.since, '2026-10-31T00:00:00.000Z', 'the first band is later than since: the next UTC day after it, never its own timestamp')
  t.alike(verifyAgeSince(r.body.since, s.iss.association), { ok: true })
  t.is(verifyAgeSince(r.body.since, b4a.toString(crypto.keyPair().publicKey, 'hex')).reason, 'untrusted-association')
  t.alike((await s.api('GET', '/account/age/since')).body, r.body, 'the same object on the next call')

  // An earlier band moves the floor: a new value, signed anew.
  await s.ages.record({ member: member().hex, band: '16-17', method: 'didit', checkedAt: BEFORE })
  const moved = await s.api('GET', '/account/age/since')
  t.is(moved.body.since.since, SINCE, 'a band before since: since itself')
  t.alike(verifyAgeSince(moved.body.since, s.iss.association), { ok: true })
})

test('age since route: a first band before since answers since', async (t) => {
  const s = await setup(t, { since: SINCE })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: BEFORE })
  const r = await s.api('GET', '/account/age/since')
  t.is(r.body.since.since, SINCE)
  t.alike(verifyAgeSince(r.body.since, s.iss.association), { ok: true })
})

test('age since route: an unavailable age store is a failure, never null', async (t) => {
  const s = await setup(t, { since: SINCE })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: AFTER })
  s.ages.fail()
  const r = await s.api('GET', '/account/age/since')
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'idade', reason: 'armazenamento-indisponivel' })))
})

test('age since route: the floor is the next UTC day after the earliest band, even at midnight', async (t) => {
  const s = await setup(t, { since: SINCE })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: '2026-11-01T00:00:00.000Z' })
  t.is((await s.api('GET', '/account/age/since')).body.since.since, '2026-11-02T00:00:00.000Z')
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: '2026-10-30T23:59:59.999Z' })
  t.is((await s.api('GET', '/account/age/since')).body.since.since, '2026-10-31T00:00:00.000Z')
})

test('age since route: a fresh signing date, the signed object cached for at most 60 s', async (t) => {
  const s = await setup(t, { since: SINCE })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: BEFORE })
  const first = (await s.api('GET', '/account/age/since')).body.since
  t.ok(Math.abs(new Date(first.date).getTime() - s.c.now()) < 5000, 'dated now')
  s.c.offset += 30 * 1000
  t.alike((await s.api('GET', '/account/age/since')).body.since, first, 'within 60 s: the same object')
  s.c.offset += 31 * 1000
  const later = (await s.api('GET', '/account/age/since')).body.since
  t.is(later.since, first.since)
  t.ok(new Date(later.date).getTime() >= new Date(first.date).getTime() + 60 * 1000, 'past 60 s: re-signed with a later date')
  t.alike(verifyAgeSince(later, s.iss.association), { ok: true })
  t.alike((await s.api('GET', '/account/age/since')).body.since, later, 'cached again')
})

test('age check state: a missing file with a configured since uses that since', async (t) => {
  const dir = path.join(tmpDir(t), 'state')
  fs.mkdirSync(dir, { recursive: true })
  const at = Date.parse('2026-11-03T12:00:00.000Z')
  const settled = settleAgeCheck(dir, { on: true, since: SINCE, now: () => at })
  t.alike(settled, { ok: true, on: true, enabledAt: SINCE })
  t.alike(readAgeCheck(dir).state, { v: 1, on: true, enabledAt: SINCE })
  t.is(fs.statSync(path.join(dir, 'age-check.json')).mode & 0o777, 0o600)
  t.alike(settleAgeCheck(path.join(tmpDir(t), 'nosince'), { on: true, now: () => at }).enabledAt, '2026-11-03T12:00:00.000Z', 'no since: now')

  const s = await setup(t, { since: SINCE, ageCheck: settled })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: BEFORE })
  t.is((await s.api('GET', '/account/age/since')).body.since.since, SINCE)
})

test('age check state: off then on moves enabledAt to the re-enable time and the served since with it', async (t) => {
  const dir = path.join(tmpDir(t), 'state')
  fs.mkdirSync(dir, { recursive: true })
  const T1 = '2026-11-01T08:00:00.000Z'
  const T2 = '2026-11-02T10:00:00.000Z'
  const T3 = '2026-11-03T10:00:00.000Z'
  t.is(settleAgeCheck(dir, { on: true, since: SINCE, now: () => Date.parse(T1) }).enabledAt, SINCE)
  t.alike(settleAgeCheck(dir, { on: false, now: () => Date.parse(T1) }), { ok: true, on: false, enabledAt: null })
  t.alike(readAgeCheck(dir).state, { v: 1, on: false, enabledAt: null })
  // The same old VARANDA_AGE_SINCE configured again: the re-enable time wins.
  const settled = settleAgeCheck(dir, { on: true, since: SINCE, now: () => Date.parse(T2) })
  t.alike(settled, { ok: true, on: true, enabledAt: T2 })
  t.alike(settleAgeCheck(dir, { on: true, since: SINCE, now: () => Date.parse(T3) }), settled, 'a later on start keeps it')

  const s = await setup(t, { since: SINCE, ageCheck: settled })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: BEFORE })
  const r = await s.api('GET', '/account/age/since')
  t.is(r.body.since.since, T2)
  t.ok(r.body.since.since >= settled.enabledAt)
  t.alike(verifyAgeSince(r.body.since, s.iss.association), { ok: true })
})

test('age check state: an invalid file answers the since route 503 and is left alone while on', async (t) => {
  const dir = path.join(tmpDir(t), 'state')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'age-check.json')
  for (const bad of ['not json', '{"v":1,"on":true,"enabledAt":null}', '{"v":1,"on":false,"enabledAt":"2026-11-01T00:00:00.000Z"}', '{"v":2,"on":false,"enabledAt":null}']) {
    fs.writeFileSync(file, bad)
    t.alike(readAgeCheck(dir), { error: 'indisponivel' }, bad)
    t.alike(settleAgeCheck(dir, { on: true, since: SINCE }), { ok: false }, bad)
    t.is(fs.readFileSync(file, 'utf8'), bad, 'untouched')
  }
  const s = await setup(t, { since: SINCE, ageCheck: { ok: false } })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: BEFORE })
  for (let i = 0; i < 2; i++) {
    const r = await s.api('GET', '/account/age/since')
    t.is(r.status, 503)
    t.alike(r.body, { error: 'indisponivel' })
  }
  t.is(s.logs.filter((l) => l === JSON.stringify({ event: 'idade', reason: 'estado-indisponivel' })).length, 1, 'logged once')
  // An off start records the off period even over an invalid file.
  t.alike(settleAgeCheck(dir, { on: false }), { ok: true, on: false, enabledAt: null })
  t.alike(readAgeCheck(dir).state, { v: 1, on: false, enabledAt: null })
})

test('age directory floor: an unbanded link dated after since raises the served since to just after it', async (t) => {
  const s = await setup(t, { since: SINCE, floor: (store, ages) => directoryFloor(store, ages) })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: BEFORE })
  const linkedAt = s.store.exportLinks().find((l) => l.member === s.linked.hex).linkedAt
  t.ok(linkedAt > SINCE)
  const r = await s.api('GET', '/account/age/since')
  t.is(r.status, 200)
  t.is(r.body.since.since, new Date(Date.parse(linkedAt) + 1).toISOString(), 'the unbanded certificate itself is not covered')
  t.alike(verifyAgeSince(r.body.since, s.iss.association), { ok: true })
})

test('age directory floor: a banded link leaves the configured since', async (t) => {
  const s = await setup(t, {
    since: SINCE,
    floor: async (store, ages, linked) => {
      await ages.record({ member: linked.hex, band: '18+', method: 'didit', checkedAt: BEFORE })
      const floor = directoryFloor(store, ages)
      t.alike(floor, { ok: true, floor: null })
      return floor
    }
  })
  const r = await s.api('GET', '/account/age/since')
  t.is(r.body.since.since, SINCE)
})

test('age directory floor: a directory or age store that cannot answer at start is a 503, never a lower since', async (t) => {
  const s = await setup(t, { since: SINCE, floor: (store, ages) => directoryFloor({ exportLinks () { throw new Error('indisponivel') } }, ages) })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: BEFORE })
  for (let i = 0; i < 2; i++) {
    const r = await s.api('GET', '/account/age/since')
    t.is(r.status, 503)
    t.alike(r.body, { error: 'indisponivel' })
  }
  t.is(s.logs.filter((l) => l === JSON.stringify({ event: 'idade', reason: 'estado-indisponivel' })).length, 1, 'logged once')
  const failingAges = { get () { throw new Error('indisponivel') } }
  t.alike(directoryFloor(s.store, failingAges), { ok: false }, 'an age store that cannot answer')
  t.alike(directoryFloor({ exportLinks: () => [{ member: s.linked.hex, linkedAt: 'x' }] }, s.ages), { ok: false }, 'a malformed date')
})

test('age check state: an off start that cannot record the off period throws; an on start does not', (t) => {
  const dir = path.join(tmpDir(t), 'state')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'age-check.json'), JSON.stringify({ v: 1, on: true, enabledAt: SINCE }))
  t.exception(() => startAgeCheck(dir, { on: false, guard: () => false }), /age-check\.json/)
  t.alike(readAgeCheck(dir).state, { v: 1, on: true, enabledAt: SINCE }, 'the stale record is still there')
  t.alike(startAgeCheck(path.join(tmpDir(t), 'fresh'), { on: true, since: SINCE, guard: () => false }), { ok: false }, 'on: the since route answers 503 instead')
  t.alike(startAgeCheck(dir, { on: false }), { ok: true, on: false, enabledAt: null })
})

test('age: a service with no issuer answers since null and a verified result without proof', async (t) => {
  const s = await setup(t, { since: SINCE, withIssuer: false })
  await s.ages.record({ member: member().hex, band: '18+', method: 'didit', checkedAt: AFTER })
  t.alike((await s.api('GET', '/account/age/since')).body, { since: null })
  const m = member()
  await opened(s, m, FACE(30))
  const r = await s.step(m, 'result')
  t.is(r.status, 200, r.text)
  t.alike(r.body, { state: 'verificado' })
  t.alike((await s.step(m, 'session')).body, { state: 'verificado' })
})

test('age: a verified result and session carry a proof for that member and association only', async (t) => {
  const s = await setup(t)
  const m = member()
  await opened(s, m, DOC(17))
  const r = await s.step(m, 'result')
  t.is(r.status, 200, r.text)
  t.alike(Object.keys(r.body), ['state', 'proof'])
  t.is(r.body.state, 'verificado')
  const proof = r.body.proof
  t.alike(verifyAgeVerified(proof, m.hex, s.iss.association), { ok: true })
  t.is(proof.date, s.ages.get(m.hex).checkedAt, 'dated the band\'s checkedAt')
  t.absent(/16-17|18\+|band/.test(r.text), 'no band anywhere in the body')
  t.is(verifyAgeVerified(proof, member().hex, s.iss.association).reason, 'member-mismatch')
  t.is(verifyAgeVerified(proof, m.hex, b4a.toString(crypto.keyPair().publicKey, 'hex')).reason, 'untrusted-association')

  // Deterministic: the same proof from later calls of either route.
  const again = await s.step(m, 'result')
  t.alike(again.body, { state: 'verificado', proof })
  s.c.offset += 3600 * 1000
  const sess = await s.step(m, 'session')
  t.alike(sess.body, { state: 'verificado', proof })
  t.absent(/16-17|18\+|band/.test(sess.text))
  noPersonalData(t, s)
})

test('age since route: on without since answers null', async (t) => {
  const s = await setup(t)
  const r = await s.api('GET', '/account/age/since')
  t.is(r.status, 200)
  t.alike(r.body, { since: null })
})

test('age since route: off never serves since, even when passed in', async (t) => {
  const s = await setup(t, { age: false, since: SINCE })
  const policy = await s.api('GET', '/account/age/policy')
  t.alike(policy.body, { required: false })
  const r = await s.api('GET', '/account/age/since')
  t.is(r.status, 200)
  t.alike(r.body, { since: null })
})

test('age since route: GET only, refused like the policy on a wrong method', async (t) => {
  const s = await setup(t, { since: SINCE })
  const wrongPolicy = await s.api('POST', '/account/age/policy', { body: {} })
  const wrongSince = await s.api('POST', '/account/age/since', { body: {} })
  t.not(wrongPolicy.status, 200)
  t.is(wrongSince.status, wrongPolicy.status)
  t.alike(wrongSince.body, wrongPolicy.body)
})

test('age since route: its rate limit is separate from the policy\'s', async (t) => {
  // Each window allows one call, so a second call on the same route is a 429
  // and only a shared window would make the other route refuse.
  class RouteError extends Error {
    constructor (token, status) { super(token); this.token = token; this.status = status }
  }
  const sent = []
  const iss = issuer()
  const routes = createAgeRoutes({
    association: iss.association,
    origin: ORIGIN,
    store: {},
    didit: { createSession: async () => {}, decision: async () => {}, deleteSession: async () => {} },
    ages: { earliest: () => BEFORE },
    since: SINCE,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    http: {
      send: (res, status, body) => sent.push({ status, body }),
      RouteError,
      refuse: (token) => new RouteError(token, 404),
      keyedWindow: () => () => true,
      fixedWindow: () => { let left = 1; return () => left-- > 0 }
    }
  })
  const get = (pathname) => routes.handle({ method: 'GET' }, {}, new URL(pathname, ORIGIN))
  await get('/account/age/policy')
  await t.exception(get('/account/age/policy'), /pedido-invalido/, 'policy window spent')
  await get('/account/age/since')
  await t.exception(get('/account/age/since'), /pedido-invalido/, 'since window spent')
  t.is(sent.length, 2)
  t.alike(sent[0], { status: 200, body: { required: true } })
  t.is(sent[1].status, 200)
  t.is(sent[1].body.since.since, SINCE)
  t.alike(verifyAgeSince(sent[1].body.since, iss.association), { ok: true })
})

test('createAgeRoutes: a non-canonical since throws', (t) => {
  const iss = issuer()
  const base = { association: iss.association, origin: ORIGIN, store: {}, http: { keyedWindow: () => () => true, fixedWindow: () => () => true } }
  for (const bad of ['2026-10-29', '2026-10-29T00:00:00Z', '2026-10-29T00:00:00.000+00:00', ' 2026-10-29T00:00:00.000Z', '2026-13-01T00:00:00.000Z', 'xxxx-xx-xxTxx:xx:xx.xxxZ', 1761696000000, '']) {
    t.exception.all(() => createAgeRoutes({ ...base, since: bad }), TypeError, JSON.stringify(bad))
  }
  t.execution(() => createAgeRoutes({ ...base, since: SINCE }), 'canonical: accepted')
})

test('createAgeRoutes: a malformed issuer throws', (t) => {
  const iss = issuer()
  const base = { association: iss.association, origin: ORIGIN, store: {}, http: { keyedWindow: () => () => true, fixedWindow: () => () => true } }
  for (const bad of [{}, { keyPair: iss.keyPair }, { cert: iss.cert }, 'issuer', 42, false]) {
    t.exception.all(() => createAgeRoutes({ ...base, issuer: bad }), TypeError, JSON.stringify(bad))
  }
  t.execution(() => createAgeRoutes({ ...base, issuer: null }), 'null: accepted')
  t.execution(() => createAgeRoutes({ ...base, issuer: { keyPair: iss.keyPair, cert: iss.cert } }), 'a key pair and certificate: accepted')
})

test('readEnv: VARANDA_AGE_SINCE needs the age check on and a canonical ISO', (t) => {
  const env = { VARANDA_PUBLIC_ORIGIN: ORIGIN, VARANDA_GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com', VARANDA_GOOGLE_CLIENT_SECRET: 'segredo-de-teste' }
  const on = { ...env, VARANDA_DIDIT_API_KEY: 'chave-sentinela-didit-77', VARANDA_DIDIT_WORKFLOW_ID: '0a1B2c3D-4e5F-6789-abcd-EF0123456789' }
  t.is(readEnv(env).ageSince, null, 'unset: no since')
  t.is(readEnv({ ...env, VARANDA_AGE_SINCE: '' }).ageSince, null, 'empty: no since')
  t.is(readEnv(on).ageSince, null, 'on, unset: no since')
  t.is(readEnv({ ...on, VARANDA_AGE_SINCE: SINCE }).ageSince, SINCE)
  for (const off of [env, { ...env, VARANDA_DIDIT_API_KEY: '', VARANDA_DIDIT_WORKFLOW_ID: '' }]) {
    try {
      readEnv({ ...off, VARANDA_AGE_SINCE: SINCE })
      t.fail('since with the check off: accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, 'check off: usage error')
      t.is(err.message, 'VARANDA_AGE_SINCE exige a verificação de idade ligada (VARANDA_DIDIT_API_KEY e VARANDA_DIDIT_WORKFLOW_ID).')
    }
  }
  for (const bad of ['2026-10-29', '2026-10-29T00:00:00Z', ' ' + SINCE, '2026-02-30T00:00:00.000Z', 'ontem']) {
    try {
      readEnv({ ...on, VARANDA_AGE_SINCE: bad })
      t.fail(bad + ': accepted')
    } catch (err) {
      t.ok(err instanceof UsageError, bad + ': usage error')
      t.is(err.message, 'VARANDA_AGE_SINCE inválido: use uma data ISO como 2026-10-29T00:00:00.000Z')
    }
  }
})

test('age on: policy, a fresh unlinked key starts, opens a session and reads the result', async (t) => {
  const s = await setup(t)
  const policy = await s.api('GET', '/account/age/policy')
  t.is(policy.status, 200)
  t.alike(policy.body, { required: true })

  const m = member()
  const started = await s.start(m)
  t.is(started.status, 200, started.text)
  t.alike(Object.keys(started.body), ['nonce'])
  t.ok(TOKEN_RE.test(started.body.nonce))

  const sig = s.signFor(m, 'session', started.body.nonce)
  const sess = await s.post('/account/age/session', { member: m.hex, nonce: started.body.nonce, signature: sig })
  t.is(sess.status, 200, sess.text)
  t.alike(Object.keys(sess.body), ['url'])
  t.ok(sess.body.url.startsWith('https://verify.didit.test/session/'))
  t.is(sess.headers.get('cache-control'), 'no-store')

  t.is(s.creates().length, 1)
  const req = s.creates()[0]
  t.is(req.headers['x-api-key'], API_KEY)
  t.is(req.body.callback, 'https://varanda.test/?idade=volta')
  t.is(req.body.language, 'pt')
  t.is(req.body.workflow_id, WORKFLOW)
  t.ok(/^[A-Za-z0-9_-]{22}$/.test(req.body.vendor_data), 'random vendor data, not the member key')
  t.absent(JSON.stringify(req.body).includes(m.hex), 'the member key never reaches Didit')
  t.ok(s.logs.includes(JSON.stringify({ event: 'idade', reason: 'sessao' })))

  // A second session call within the hour: the same url, no new paid session.
  const again = await s.step(m, 'session')
  t.is(again.status, 200)
  t.is(again.body.url, sess.body.url)
  t.is(s.creates().length, 1, 'the fake saw ONE create')

  // Not started yet at Didit.
  const pend = await s.step(m, 'result')
  t.is(pend.status, 200, pend.text)
  t.alike(pend.body, { state: 'pendente' })

  // Replay of the spent session nonce.
  const replay = await s.post('/account/age/session', { member: m.hex, nonce: started.body.nonce, signature: sig })
  t.is(replay.status, 404)
  t.alike(replay.body, { error: 'expirado' })
  noPersonalData(t, s)
})

test('age: concurrent session requests for one member share one paid session', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await s.start(m)
  const b = await s.start(m)
  const body = (nonce) => ({ member: m.hex, nonce, signature: s.signFor(m, 'session', nonce) })
  const [ra, rb] = await Promise.all([
    s.post('/account/age/session', body(a.body.nonce)),
    s.post('/account/age/session', body(b.body.nonce))
  ])
  t.is(ra.status, 200, ra.text)
  t.is(rb.status, 200, rb.text)
  t.is(ra.body.url, rb.body.url, 'both get the same url')
  t.is(s.creates().length, 1, 'one create at Didit')
  t.is(s.deletes().length, 0, 'the returned session is never deleted')
})

test('age: a refused session logs why (status and field names, never values), and the store or ceiling too', async (t) => {
  const s = await setup(t)
  s.fake.script({ create: (req, res, ctx) => ctx.json(res, 400, { callback: ['domain not allowed https://varanda.test'], detail: API_KEY }) })
  const r = await s.step(member(), 'session')
  t.is(r.status, 503, r.text)
  t.alike(r.body, { error: 'indisponivel' })
  t.ok(s.logs.includes(JSON.stringify({ event: 'idade', reason: 'didit-sessao-http-400' })), 'status in the log')
  t.ok(s.logs.includes(JSON.stringify({ event: 'idade', reason: 'didit-sessao-campo-callback' })), 'field name in the log')
  t.absent(s.logs.join('\n').includes('domain not allowed'), 'no provider value in the log')
  t.absent(s.logs.join('\n').includes(API_KEY), 'no key in the log')

  s.fake.script({ create: (req, res, ctx) => ctx.json(res, 403, { detail: 'invalid key' }) })
  t.is((await s.step(member(), 'session')).status, 503)
  t.ok(s.logs.includes(JSON.stringify({ event: 'idade', reason: 'didit-sessao-http-403' })))

  // A provider that never answers may have created the session anyway: the
  // outcome is unknown, so the token is not the plain refusal.
  const slow = await setup(t, { diditTimeoutMs: 100 })
  slow.fake.script({ create: () => {} })
  const timedOut = await slow.step(member(), 'session')
  t.is(timedOut.status, 503)
  t.alike(timedOut.body, { error: 'resultado-incerto' })
  t.ok(slow.logs.includes(JSON.stringify({ event: 'idade', reason: 'didit-sessao-tempo' })))

  // A 5xx or an unreadable success may also hide a created session.
  for (const create of [
    (req, res, ctx) => ctx.json(res, 502, { detail: 'bad gateway' }),
    (req, res) => res.writeHead(201, { 'Content-Type': 'application/json' }).end('{not json')
  ]) {
    s.fake.script({ create })
    const r = await s.step(member(), 'session')
    t.is(r.status, 503)
    t.alike(r.body, { error: 'resultado-incerto' })
  }

  // Two requests sharing one creation that times out both hear "unknown".
  const pair = await setup(t, { diditTimeoutMs: 100 })
  pair.fake.script({ create: () => {} })
  const m = member()
  const a = await pair.start(m)
  const b = await pair.start(m)
  const body = (nonce) => ({ member: m.hex, nonce, signature: pair.signFor(m, 'session', nonce) })
  const both = await Promise.all([pair.post('/account/age/session', body(a.body.nonce)), pair.post('/account/age/session', body(b.body.nonce))])
  for (const res of both) t.alike(res.body, { error: 'resultado-incerto' })

  const full = await setup(t, { dailyLimit: 1 })
  t.is((await full.step(member(), 'session')).status, 200)
  t.is((await full.step(member(), 'session')).status, 503)
  t.ok(full.logs.includes(JSON.stringify({ event: 'idade', reason: 'teto-diario' })))

  const down = await setup(t)
  down.ages.available = () => false
  t.is((await down.step(member(), 'session')).status, 503)
  t.ok(down.logs.includes(JSON.stringify({ event: 'idade', reason: 'armazenamento-indisponivel' })))
  noPersonalData(t, s)
})

test('age: an unavailable age store never sends anyone to Didit', async (t) => {
  const s = await setup(t)
  const m = member()
  s.ages.available = () => false
  const r = await s.step(m, 'session')
  t.is(r.status, 503, r.text)
  t.alike(r.body, { error: 'indisponivel' })
  t.is(s.creates().length, 0, 'no paid session')
})

test('age: an approval that lands while a replacement is being created deletes the replacement', async (t) => {
  const s = await setup(t)
  const m = member()
  const a = await s.start(m)
  s.fake.script({
    create: (req, res, ctx) => {
      // The member is approved while Didit is still answering the create.
      s.ages.record({ member: m.hex, band: '18+', method: 'didit' }).then(() => {
        ctx.json(res, 201, { session_id: 'sess-late', session_token: 'tok', url: 'https://verify.didit.test/session/sess-late', status: 'Not Started' })
      })
    }
  })
  const r = await s.post('/account/age/session', { member: m.hex, nonce: a.body.nonce, signature: s.signFor(m, 'session', a.body.nonce) })
  t.is(r.status, 200, r.text)
  t.is(r.body.state, 'verificado', 'no url for a member already approved')
  t.ok(await waitFor(() => s.deletes().some((d) => d.path.includes('sess-late'))), 'the useless session is deleted')
})

test('age nonces: single-use, member-bound, expiring, action-bound, never a terms proof', async (t) => {
  const s = await setup(t)
  const m = member()
  const other = member()

  // Issued to m, presented by other with its own signature: spent.
  const a = await s.start(m)
  const stolen = await s.post('/account/age/session', { member: other.hex, nonce: a.body.nonce, signature: s.signFor(other, 'session', a.body.nonce) })
  t.is(stolen.status, 404)
  t.alike(stolen.body, { error: 'expirado' })
  const late = await s.post('/account/age/session', { member: m.hex, nonce: a.body.nonce, signature: s.signFor(m, 'session', a.body.nonce) })
  t.is(late.status, 404, 'spent by the other member\'s attempt')

  // Expired.
  const b = await s.start(m)
  s.c.offset += 601 * 1000
  const expired = await s.post('/account/age/session', { member: m.hex, nonce: b.body.nonce, signature: s.signFor(m, 'session', b.body.nonce) })
  t.is(expired.status, 404)
  t.alike(expired.body, { error: 'expirado' })

  // A 'session' signature does not work for 'result', and the reverse.
  const c1 = await s.start(m)
  const wrong = await s.post('/account/age/result', { member: m.hex, nonce: c1.body.nonce, signature: s.signFor(m, 'session', c1.body.nonce) })
  t.is(wrong.status, 400)
  t.alike(wrong.body, { error: 'assinatura-invalida' })
  const c2 = await s.start(m)
  const wrong2 = await s.post('/account/age/session', { member: m.hex, nonce: c2.body.nonce, signature: s.signFor(m, 'result', c2.body.nonce) })
  t.is(wrong2.status, 400)

  // A terms signature over an age nonce.
  const d = await s.start(s.linked)
  const terms = signTerms({ nonce: d.body.nonce, member: s.linked.hex, association: s.iss.association, version: TERMS_VERSION }, s.linked.kp)
  const notAge = await s.post('/account/age/session', { member: s.linked.hex, nonce: d.body.nonce, signature: terms })
  t.is(notAge.status, 400)
  t.alike(notAge.body, { error: 'assinatura-invalida' })

  // Bad shapes.
  for (const bad of ['', m.hex.toUpperCase(), 42]) {
    const r = await s.post('/account/age/start', { member: bad })
    t.is(r.status, 400)
    t.alike(r.body, { error: 'pedido-invalido' })
  }
  t.is(s.creates().length, 0, 'no session opened by a failed proof')
  noPersonalData(t, s)
})

test('age decisions: bands stored, refusals and inconclusive store nothing, every final decision deletes the session', async (t) => {
  const s = await setup(t)

  const cases = [
    { decision: DOC(17), state: 'verificado', band: '16-17' },
    { decision: FACE(25), state: 'verificado', band: '18+' },
    { decision: FACE(17), state: 'inconclusivo', band: null },
    { decision: DOC(15), state: 'recusado', band: null }
  ]
  for (const k of cases) {
    const m = member()
    const before = s.deletes().length
    const r = await opened(s, m, k.decision)
    t.is(r.status, 200, r.text)
    const id = s.lastSession()
    const res = await s.step(m, 'result')
    t.is(res.status, 200, res.text)
    t.is(res.body.state, k.state)
    t.alike(Object.keys(res.body), k.band === null ? ['state'] : ['state', 'proof'])
    const file = ageFile(s)
    const entry = file && file.members[m.hex]
    if (k.band === null) {
      t.absent(entry, 'nothing stored for ' + k.state)
      t.absent(s.ages.verified(m.hex))
    } else {
      t.is(entry.band, k.band)
      t.is(entry.method, 'didit')
      t.alike(Object.keys(entry).sort(), ['band', 'checkedAt', 'method'])
      t.ok(s.ages.verified(m.hex))
    }
    t.ok(await waitFor(() => s.deletes().length === before + 1), 'one DELETE after the final decision')
    const del = s.deletes()[before]
    t.is(del.path, '/v3/session/' + id + '/delete/')
    t.alike(del.body, { retain_face_embeddings: false })
    t.ok(s.logs.includes(JSON.stringify({ event: 'idade', reason: k.state })))

    // The session is gone: the next result says 'nenhum' (or 'verificado').
    const next = await s.step(m, 'result')
    t.is(next.body.state, k.band === null ? 'nenhum' : 'verificado')
  }

  // In Review keeps the session; Approved later verifies.
  const m = member()
  await opened(s, m, { status: 'In Review' })
  const id = s.lastSession()
  const pend = await s.step(m, 'result')
  t.alike(pend.body, { state: 'pendente' })
  t.is(s.deletes().filter((d) => d.path.includes(id)).length, 0, 'no delete while pending')
  s.fake.sessions.set(id, DOC(30))
  const ok = await s.step(m, 'result')
  t.is(ok.body.state, 'verificado')
  t.is(ageFile(s).members[m.hex].band, '18+')

  // After verificado, neither result nor session calls Didit.
  const seen = s.fake.seen.length
  t.ok(await waitFor(() => s.deletes().some((d) => d.path.includes(id))))
  const seenAfterDelete = s.fake.seen.length
  t.ok(seenAfterDelete >= seen)
  const again = await s.step(m, 'result')
  t.is(again.body.state, 'verificado')
  const sess = await s.step(m, 'session')
  t.is(sess.body.state, 'verificado')
  t.is(s.fake.seen.length, seenAfterDelete, 'Didit not called once verified')

  // Nothing about the person in age.json.
  const raw = fs.readFileSync(path.join(s.dir, 'age.json'), 'utf8')
  t.absent(raw.includes(DOB) || raw.includes('Fulana') || raw.includes('sess-'), 'only bands in age.json')
  t.is(fs.statSync(path.join(s.dir, 'age.json')).mode & 0o777, 0o600)
  noPersonalData(t, s)
})

test('age: a result with no session says nenhum without calling Didit; a 24 h old session is gone', async (t) => {
  const s = await setup(t)
  const m = member()
  const none = await s.step(m, 'result')
  t.alike(none.body, { state: 'nenhum' })
  t.is(s.decisions().length, 0)

  await opened(s, m, DOC(20))
  s.c.offset += 24 * 3600 * 1000
  const old = await s.step(m, 'result')
  t.alike(old.body, { state: 'nenhum' })
  t.is(s.decisions().length, 0, 'no decision read for an expired session')
  t.absent(s.ages.verified(m.hex))
  t.ok(await waitFor(() => s.deletes().length === 1), 'the abandoned session is deleted at Didit too')
})

test('age limits: three sessions a day per member, then limite-idade; the daily ceiling answers 503', async (t) => {
  const s = await setup(t)
  const m = member()
  for (let i = 0; i < 3; i++) {
    const r = await s.step(m, 'session')
    t.is(r.status, 200, r.text)
    // Past the URL reuse hour, a new session is opened.
    s.c.offset += 3601 * 1000
  }
  t.is(s.creates().length, 3)
  const fourth = await s.step(m, 'session')
  t.is(fourth.status, 429)
  t.alike(fourth.body, { error: 'limite-idade' })
  t.is(s.creates().length, 3, 'no fourth create')
  // Each replaced session was deleted at Didit.
  t.ok(await waitFor(() => s.deletes().length === 2))

  const d = await setup(t, { dailyLimit: 1 })
  t.is((await d.step(member(), 'session')).status, 200)
  const over = await d.step(member(), 'session')
  t.is(over.status, 503)
  t.alike(over.body, { error: 'indisponivel' })
  t.is(d.creates().length, 1)
})

test('age eligibility: a full directory and a missing or bad invite are refused before Didit', async (t) => {
  const full = await setup(t, { maxMembers: 1 })
  const w = await full.step(member(), 'session')
  t.is(w.status, 503)
  t.alike(w.body, { error: 'lista-de-espera' })
  t.is(full.creates().length, 0, 'no create for a waitlisted key')
  // The linked member is not a new member: the cap does not apply.
  const own = await full.step(full.linked, 'session')
  t.is(own.status, 200, own.text)

  const s = await setup(t, { inviting: true })
  const m = member()
  const noInvite = await s.step(m, 'session')
  t.is(noInvite.status, 403)
  t.alike(noInvite.body, { error: 'convite-obrigatorio' }, 'the same token /account/start uses')
  const bad = await s.step(m, 'session', { invite: 'A'.repeat(43) })
  t.is(bad.status, 404)
  t.alike(bad.body, { error: 'convite-invalido' })
  const short = await s.step(m, 'session', { invite: 'curto' })
  t.is(short.status, 404)
  t.is(s.creates().length, 0, 'no create without a valid invite')

  // Issue a code as the linked member; the inviter needs its band first.
  await s.ages.record({ member: s.linked.hex, band: '18+', method: 'didit' })
  const st = await s.post('/account/invites/start', { member: s.linked.hex })
  t.is(st.status, 200, st.text)
  const issued = await s.post('/account/invites/finish', {
    member: s.linked.hex,
    nonce: st.body.nonce,
    signature: signInvite({ action: 'issue', nonce: st.body.nonce, member: s.linked.hex, association: s.iss.association }, s.linked.kp)
  })
  t.is(issued.status, 200, issued.text)
  const code = issued.body.code
  const good = await s.step(m, 'session', { invite: code })
  t.is(good.status, 200, good.text)
  t.is(s.creates().length, 1)
  t.is(s.invites.check(inviteId(code)), null, 'the invite is not consumed')
  t.absent(s.store.inviteUsed(inviteId(code)))
  t.absent(s.logs.join('\n').includes(code), 'no code in a log line')

  // Disposable keys cannot turn one invite into unlimited paid sessions: three
  // sessions per code per day, whatever the key.
  for (let i = 0; i < 2; i++) {
    const r = await s.step(member(), 'session', { invite: code })
    t.is(r.status, 200, r.text)
  }
  t.is(s.creates().length, 3)
  const capped = await s.step(member(), 'session', { invite: code })
  t.is(capped.status, 429)
  t.alike(capped.body, { error: 'limite-idade' })
  t.is(s.creates().length, 3, 'no fourth create for the same code')
})

test('age, Feira codes: one paid session per code per day', async (t) => {
  const s = await setup(t, { inviting: true, feira: { perWeek: 5 } })
  const owner = member().hex
  const { code } = await s.feiraStore.issue(owner)
  t.is(s.invites.feiraOwner(inviteId(code)), owner, 'the pair names the owner')
  const first = await s.step(member(), 'session', { invite: code })
  t.is(first.status, 200, first.text)
  const second = await s.step(member(), 'session', { invite: code })
  t.is(second.status, 429)
  t.alike(second.body, { error: 'limite-idade' })
  t.is(s.creates().length, 1, 'no second create for the same Feira code')
  s.c.offset += 30 * 60 * 1000
  t.is((await s.step(member(), 'session', { invite: code })).status, 429, 'later in the code lifetime too')
  t.absent(s.logs.join('\n').includes(code), 'no code in a log line')
})

test('age, Feira codes: no window keyed by the owner, so minted codes cannot lock an owner out', async (t) => {
  const s = await setup(t, { inviting: true, feira: { perWeek: 2 } })
  const owner = member().hex
  const codes = []
  for (let i = 0; i < 4; i++) codes.push((await s.feiraStore.issue(owner)).code)
  for (const code of codes) t.is((await s.step(member(), 'session', { invite: code })).status, 200, 'more sessions than the weekly cap are not refused per owner')
  t.is(s.creates().length, 4)
  const again = await s.step(member(), 'session', { invite: codes[0] })
  t.is(again.status, 429, 'one paid session per Feira code per day')
  t.alike(again.body, { error: 'limite-idade' })
})

test('age, Feira codes: their own daily ceiling, never the ordinary one', async (t) => {
  t.timeout(120000)
  const s = await setup(t, { inviting: true, dailyLimit: 1, burst: 2000, feira: { perWeek: 100 } })
  const owner = member().hex
  for (let i = 0; i < FEIRA_AGE_DAILY; i++) {
    const { code } = await s.feiraStore.issue(owner)
    const r = await s.step(member(), 'session', { invite: code })
    t.is(r.status, 200, 'Feira session ' + (i + 1) + ': ' + r.text)
  }
  const { code } = await s.feiraStore.issue(owner)
  const over = await s.step(member(), 'session', { invite: code })
  t.is(over.status, 429, 'past the Feira ceiling')
  t.alike(over.body, { error: 'limite-idade' })
  t.ok(s.logs.some((l) => JSON.parse(l).reason === 'teto-diario-feira'), 'the Feira ceiling is logged')
  t.is(s.creates().length, FEIRA_AGE_DAILY)

  // Ordinary invites keep the whole ordinary ceiling (1 here).
  await s.ages.record({ member: s.linked.hex, band: '18+', method: 'didit' })
  const st = await s.post('/account/invites/start', { member: s.linked.hex })
  const issued = await s.post('/account/invites/finish', {
    member: s.linked.hex,
    nonce: st.body.nonce,
    signature: signInvite({ action: 'issue', nonce: st.body.nonce, member: s.linked.hex, association: s.iss.association }, s.linked.kp)
  })
  t.is(issued.status, 200, issued.text)
  t.is(s.invites.feiraOwner(inviteId(issued.body.code)), null, 'an ordinary code has no Feira owner')
  const ordinary = await s.step(member(), 'session', { invite: issued.body.code })
  t.is(ordinary.status, 200, 'an ordinary invite still gets its session: ' + ordinary.text)
})

test('age, Feira codes: a code whose owner cannot be named fails closed', async (t) => {
  const s = await setup(t, { inviting: true, feira: { perWeek: 5, named: false } })
  const { code } = await s.feiraStore.issue(member().hex)
  const r = await s.step(member(), 'session', { invite: code })
  t.alike(r.body, { error: 'indisponivel' })
  t.is(s.creates().length, 0, 'no paid session')
})

test('age: attempts refused by a narrower window never fill the shared daily ceiling', async (t) => {
  const s = await setup(t, { dailyLimit: 4 })
  const m = member()
  for (let i = 0; i < 3; i++) {
    t.is((await s.step(m, 'session')).status, 200)
    s.c.offset += 3601 * 1000
  }
  for (let i = 0; i < 6; i++) {
    const r = await s.step(m, 'session')
    t.is(r.status, 429, 'over its own window')
  }
  const other = await s.step(member(), 'session')
  t.is(other.status, 200, 'the fourth daily slot is still free: ' + other.text)
  t.is(s.creates().length, 4)
})

test('age: disposable keys exhausting the new-key ceiling do not lock out linked members', async (t) => {
  const s = await setup(t, { dailyLimit: 2 })
  for (let i = 0; i < 2; i++) t.is((await s.step(member(), 'session')).status, 200)
  const over = await s.step(member(), 'session')
  t.is(over.status, 503, 'new keys hit their ceiling')
  const linked = await s.step(s.linked, 'session')
  t.is(linked.status, 200, 'the linked member still gets a session: ' + linked.text)
  t.is(s.creates().length, 3)
})

test('age gates on: authorize, finish, rename and invites refuse an unverified key, then allow it', async (t) => {
  const s = await setup(t, { inviting: true })

  // Already linked member, unverified. The unsigned starts answer as for
  // anyone (they must not reveal whether a key passed the age check); the
  // signed finishes refuse.
  const rn = await renameStart(s, s.linked, 'ana')
  t.is(rn.status, 200, 'rename start reveals nothing')
  const rnFin = await s.post('/account/rename/finish', { member: s.linked.hex, nonce: rn.body.nonce, signature: sign(s, s.linked, 'rename', rn.body.nonce, 'ana') })
  t.is(rnFin.status, 403)
  t.alike(rnFin.body, { error: 'idade-pendente' })
  const inv = await s.post('/account/invites/start', { member: s.linked.hex })
  t.is(inv.status, 200, 'invites start reveals nothing')
  const invFin = await s.post('/account/invites/finish', {
    member: s.linked.hex,
    nonce: inv.body.nonce,
    signature: signInvite({ action: 'issue', nonce: inv.body.nonce, member: s.linked.hex, association: s.iss.association }, s.linked.kp)
  })
  t.is(invFin.status, 403)
  t.alike(invFin.body, { error: 'idade-pendente' })

  // Verify the linked member through the routes.
  await opened(s, s.linked, FACE(40))
  t.is((await s.step(s.linked, 'result')).body.state, 'verificado')
  t.is((await renameStart(s, s.linked, 'ana')).status, 200)
  const st = await s.post('/account/invites/start', { member: s.linked.hex })
  t.is(st.status, 200)
  const code = (await s.post('/account/invites/finish', {
    member: s.linked.hex,
    nonce: st.body.nonce,
    signature: signInvite({ action: 'issue', nonce: st.body.nonce, member: s.linked.hex, association: s.iss.association }, s.linked.kp)
  })).body.code

  // A fresh key: authorize refused with no Google URL, the row kept.
  const m = member()
  const a = await authorize(s, m, 'bia', code)
  t.is(a.started.status, 200, a.started.text)
  t.is(a.auth.status, 403)
  t.alike(a.auth.body, { error: 'idade-pendente' })
  t.absent(a.auth.text.includes('google'), 'no Google URL in the answer')
  t.is(s.google.calls, 0)

  // finish refused too, even with a subject on the row (no certificate).
  s.store.reserve(a.cookie)
  const fin = await finish(s, m, 'bia', a.cookie)
  t.is(fin.status, 403)
  t.alike(fin.body, { error: 'idade-pendente' })
  t.absent(s.store.status(m.hex).linked, 'no link, no certificate')
  t.absent('cert' in (fin.body || {}))

  // Verified: a new start, authorize and finish go through.
  await opened(s, m, DOC(16), { invite: code })
  t.is((await s.step(m, 'result')).body.state, 'verificado')
  const b = await authorize(s, m, 'bia', code, a.cookie)
  t.is(b.auth.status, 200, b.auth.text)
  t.is(b.auth.body.authorizeUrl, GOOGLE_URL)
  const done = await finish(s, m, 'bia', b.cookie)
  t.is(done.status, 200, done.text)
  t.ok(s.store.status(m.hex).linked)

  // /account/status never exposes age state.
  const status = await s.api('GET', '/account/status?member=' + m.hex)
  t.absent(/idade|age|band/i.test(Object.keys(status.body).join(',')))
  noPersonalData(t, s)
})

test('age: a failed age.json write answers 503 resultado-incerto and the member stays unverified', async (t) => {
  const s = await setup(t)
  const m = member()
  await opened(s, m, DOC(19))
  s.c.guardOk = false
  const r = await s.step(m, 'result')
  t.is(r.status, 503)
  t.alike(r.body, { error: 'resultado-incerto' }, 'the write may have landed: not a plain refusal')
  t.ok(s.logs.includes(JSON.stringify({ event: 'idade', reason: 'gravacao-falhou' })))
  t.absent(s.ages.verified(m.hex), 'not verified')
  t.is(s.deletes().length, 0, 'the session is kept for a retry')

  s.c.guardOk = true
  const retry = await s.step(m, 'result')
  t.is(retry.body.state, 'verificado')
  t.ok(s.ages.verified(m.hex))
  noPersonalData(t, s)
})

test('age: forged return params have no server effect', async (t) => {
  const s = await setup(t)
  const m = member()
  await opened(s, m, { status: 'In Review' })
  const id = s.lastSession()
  for (const q of ['/?idade=volta&verificationSessionId=' + id + '&status=Approved', '/account/age/policy?status=Approved&verificationSessionId=' + id]) {
    await s.api('GET', q)
  }
  t.absent(s.ages.verified(m.hex))
  t.alike((await s.step(m, 'result')).body, { state: 'pendente' })
  t.absent(s.ages.verified(m.hex))
})

test('age app clients: the app return URL only with the app header; app-return ignores every parameter', async (t) => {
  const s = await setup(t)
  const m = member()
  const started = await s.api('POST', '/account/age/start', { app: true, body: { member: m.hex } })
  t.is(started.status, 200, 'an Origin-less app POST: ' + started.text)
  const nonce = started.body.nonce
  const sess = await s.api('POST', '/account/age/session', { app: true, body: { member: m.hex, nonce, signature: s.signFor(m, 'session', nonce) } })
  t.is(sess.status, 200, sess.text)
  t.is(s.creates().length, 1)
  t.is(s.creates()[0].body.callback, ORIGIN + '/account/age/app-return')

  const web = member()
  t.is((await s.step(web, 'session')).status, 200)
  t.is(s.creates()[1].body.callback, ORIGIN + '/?idade=volta', 'the web keeps its return')

  const id = s.lastSession()
  for (const q of ['', '?status=Approved&verificationSessionId=' + id, '?next=https://evil.test/&idade=volta']) {
    const r = await s.api('GET', '/account/age/app-return' + q)
    t.is(r.status, 302)
    t.is(r.headers.get('location'), 'varanda://idade?volta=1')
    t.is(r.headers.get('cache-control'), 'no-store')
  }
  t.absent(s.ages.verified(m.hex), 'the return grants nothing')
  const post = await s.api('POST', '/account/age/app-return', { body: {} })
  t.is(post.status, 404, 'GET only')
  noPersonalData(t, s)
})

test('age app clients: app-return has no window of its own and never answers 429', async (t) => {
  const s = await setup(t, { burst: 5000 })
  for (let i = 0; i < 1300; i++) {
    const r = await s.api('GET', '/account/age/app-return?n=' + i)
    if (r.status !== 302 || r.headers.get('location') !== 'varanda://idade?volta=1') {
      t.fail('request ' + i + ' answered ' + r.status)
      return
    }
  }
  t.pass('1300 returns in a row all redirect to the app')
})

// One app session (no Origin, app header) for `who`: start + signed session.
async function appSession (s, who) {
  const started = await s.api('POST', '/account/age/start', { app: true, body: { member: who.hex } })
  const nonce = started.body.nonce
  return s.api('POST', '/account/age/session', { app: true, body: { member: who.hex, nonce, signature: s.signFor(who, 'session', nonce) } })
}

async function appResult (s, who) {
  const started = await s.api('POST', '/account/age/start', { app: true, body: { member: who.hex } })
  const nonce = started.body.nonce
  return s.api('POST', '/account/age/result', { app: true, body: { member: who.hex, nonce, signature: s.signFor(who, 'result', nonce) } })
}

test('age app clients: a session is reused only by the client kind that opened it, both ways', async (t) => {
  const s = await setup(t)
  const callbacks = () => s.creates().map((r) => r.body.callback)
  const APP_RETURN = ORIGIN + '/account/age/app-return'
  const WEB_RETURN = ORIGIN + '/?idade=volta'

  // Web first, then the app.
  const m = member()
  const web1 = await s.step(m, 'session')
  t.is(web1.status, 200, web1.text)
  const app1 = await appSession(s, m)
  t.is(app1.status, 200, app1.text)
  t.not(app1.body.url, web1.body.url, 'the app never gets the web session')
  t.alike(callbacks(), [WEB_RETURN, APP_RETURN])
  t.is((await appSession(s, m)).body.url, app1.body.url, 'the app reuses its own')
  t.is((await s.step(m, 'session')).body.url, web1.body.url, 'the web reuses its own')
  t.is(s.creates().length, 2)
  t.is(s.deletes().length, 0, 'neither session replaced the other')

  // App first, then the web.
  const n = member()
  const app2 = await appSession(s, n)
  const web2 = await s.step(n, 'session')
  t.not(web2.body.url, app2.body.url, 'the web never gets the app session')
  t.alike(callbacks().slice(2), [APP_RETURN, WEB_RETURN])

  // Each client reads its own session; an approval closes both.
  const appId = [...s.fake.sessions.keys()][2]
  s.fake.sessions.set(appId, FACE(30))
  const read = await appResult(s, n)
  t.is(read.status, 200, read.text)
  t.is(read.body.state, 'verificado')
  t.ok(s.decisions().some((r) => r.path.includes(appId)), 'the app result read the app session')
  t.ok(s.ages.verified(n.hex))
  // The verifying call itself closes the web session too, with no later call.
  await waitFor(() => s.deletes().length === 2)
  t.is(s.deletes().length, 2, 'both sessions of the approved member are deleted by the first verifying call')
  t.ok(s.deletes().some((r) => r.path.includes(appId)))
  t.is((await s.step(n, 'result')).body.state, 'verificado')
  t.is(s.deletes().length, 2, 'nothing left to delete')
})

test('age app clients: concurrent web and app requests do not share one in-flight creation', async (t) => {
  const s = await setup(t)
  const m = member()
  const [web, app] = await Promise.all([s.step(m, 'session'), appSession(s, m)])
  t.is(web.status, 200, web.text)
  t.is(app.status, 200, app.text)
  t.not(web.body.url, app.body.url)
  t.alike(s.creates().map((r) => r.body.callback).sort(), [ORIGIN + '/?idade=volta', ORIGIN + '/account/age/app-return'].sort())
})

test('Excluir conta: a deleted key opens no Didit session, and an open one is closed instead of recording a band', async (t) => {
  const s = await setup(t)
  const r = await opened(s, s.linked, { status: 'Approved', age: 30 })
  t.is(r.status, 200, r.text)
  const createsBefore = s.creates().length
  await s.store.deleteMember(s.linked.hex)
  const res = await s.step(s.linked, 'result')
  t.is(res.status, 409, res.text)
  t.alike(res.body, { error: 'conta-excluida' })
  t.is(s.ages.get(s.linked.hex), null, 'no band recorded for a deleted key')
  t.ok(await waitFor(() => s.deletes().length >= 1), 'the open session is deleted at the provider')
  const again = await s.step(s.linked, 'session')
  t.is(again.status, 409)
  t.alike(again.body, { error: 'conta-excluida' })
  t.is(s.creates().length, createsBefore, 'no new paid session')
})
