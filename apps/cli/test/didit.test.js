'use strict'

// apps/cli/lib/account/didit.js against the loopback Didit fake. No socket
// leaves 127.0.0.1: the endpoint base and the fetch both point at the fake.

const test = require('brittle')
const { createDidit, ageOutcome, MIN_AGE, ADULT_AGE, FACE_ADULT_MIN } = require('../lib/account/didit')
const { startFakeDidit, loopbackFetch, SESSION_TOKEN } = require('./helpers/fake-didit')

const API_KEY = 'didit-key-de-teste-SEGREDO'
const WORKFLOW = '11111111-2222-4333-8444-555555555555'
const CALLBACK = 'https://varanda.test/?idade=volta'
const VENDOR = 'ref-0123456789abcdef'
const DOB = '1999-12-31-SENTINELA'

async function fakeFor (t) {
  const fake = await startFakeDidit()
  t.teardown(() => fake.close(), { force: true })
  return fake
}

function client (fake, extra = {}) {
  return createDidit({
    apiKey: API_KEY,
    workflowId: WORKFLOW,
    endpoints: { base: fake.base },
    fetch: loopbackFetch(fake.base),
    ...extra
  })
}

function noLeak (t, value) {
  const text = JSON.stringify(value) + String(value && value.message)
  for (const secret of [API_KEY, SESSION_TOKEN, DOB]) t.absent(text.includes(secret), 'leaks nothing')
}

function create (d) {
  return d.createSession({ vendorData: VENDOR, callback: CALLBACK })
}

test('thresholds live in one place', (t) => {
  t.is(MIN_AGE, 16)
  t.is(ADULT_AGE, 18)
  t.is(FACE_ADULT_MIN, 21)
})

test('createDidit refuses a bad key or workflow without echoing it', (t) => {
  const bad = [
    { apiKey: '', workflowId: WORKFLOW },
    { apiKey: 'chave com espaco-SEGREDO', workflowId: WORKFLOW },
    { apiKey: 'chave\nSEGREDO', workflowId: WORKFLOW },
    { apiKey: 'x'.repeat(513), workflowId: WORKFLOW },
    { apiKey: 42, workflowId: WORKFLOW },
    { apiKey: API_KEY, workflowId: 'nao-e-uuid-SEGREDO' },
    { apiKey: API_KEY, workflowId: undefined }
  ]
  for (const opts of bad) {
    try {
      createDidit(opts)
      t.fail('should throw')
    } catch (err) {
      t.ok(err instanceof TypeError)
      const text = String(err.message) + String(err.stack)
      t.absent(text.includes('SEGREDO'), 'message does not echo the value')
      t.absent(text.includes(API_KEY))
      noLeak(t, err)
    }
  }
})

test('createSession: x-api-key header, JSON body, callback and vendor_data passed through', async (t) => {
  const fake = await fakeFor(t)
  const result = await create(client(fake))
  t.is(result.ok, true)
  t.ok(/^sess-/.test(result.sessionId))
  t.ok(result.url.startsWith('https://verify.didit.test/session/'))
  t.alike(Object.keys(result).sort(), ['ok', 'sessionId', 'url'])
  noLeak(t, result)

  t.is(fake.seen.length, 1)
  const req = fake.seen[0]
  t.is(req.method, 'POST')
  t.is(req.path, '/v3/session/')
  t.is(req.headers['x-api-key'], API_KEY)
  t.ok(String(req.headers['content-type']).startsWith('application/json'))
  t.alike(req.body, { workflow_id: WORKFLOW, vendor_data: VENDOR, callback: CALLBACK, language: 'pt' })
})

test('createSession: refused inputs never reach the network', async (t) => {
  const fake = await fakeFor(t)
  const d = client(fake)
  t.alike(await d.createSession({ vendorData: '', callback: CALLBACK }), { ok: false })
  t.alike(await d.createSession({ vendorData: VENDOR, callback: 'http://varanda.test/' }), { ok: false })
  t.alike(await d.createSession({ vendorData: VENDOR, callback: CALLBACK, language: 'pt;x' }), { ok: false })
  t.alike(await d.createSession(), { ok: false })
  t.is(fake.seen.length, 0)
})

async function createRefused (t, handlers, extra) {
  const fake = await fakeFor(t)
  fake.script(handlers)
  const result = await create(client(fake, extra))
  t.alike(result, { ok: false })
  noLeak(t, result)
}

test('createSession: 4xx and 5xx refused', async (t) => {
  await createRefused(t, { create: (req, res, ctx) => ctx.json(res, 400, { detail: 'bad', session_token: SESSION_TOKEN }) })
  await createRefused(t, { create: (req, res, ctx) => ctx.json(res, 403, { detail: 'forbidden' }) })
  await createRefused(t, { create: (req, res, ctx) => ctx.json(res, 500, { detail: 'boom' }) })
})

test('createSession: non-JSON refused', async (t) => {
  await createRefused(t, {
    create (req, res) {
      res.writeHead(201, { 'Content-Type': 'text/html' }).end('<html>' + SESSION_TOKEN + '</html>')
    }
  })
  await createRefused(t, {
    create (req, res) {
      res.writeHead(201, { 'Content-Type': 'application/json' }).end('{not json')
    }
  })
})

test('createSession: a redirect is never followed', async (t) => {
  const fake = await fakeFor(t)
  fake.script((req, res) => {
    if (req.url === '/elsewhere') return res.writeHead(201, { 'Content-Type': 'application/json' }).end('{"session_id":"x","url":"https://a.test/"}')
    res.writeHead(302, { Location: fake.base + '/elsewhere' }).end()
  })
  const result = await create(client(fake))
  t.alike(result, { ok: false })
  t.is(fake.seen.length, 1, 'only the original request was made')
})

test('createSession: timeout refused', async (t) => {
  await createRefused(t, () => {}, { timeoutMs: 100 })
})

test('createSession: oversize body refused', async (t) => {
  await createRefused(t, {
    create (req, res, ctx) {
      ctx.json(res, 201, { session_id: 'sess-1', url: 'https://a.test/', pad: 'x'.repeat(70000) })
    }
  })
  await createRefused(t, {
    create (req, res) {
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ session_id: 'sess-1', url: 'https://a.test/', pad: 'x'.repeat(70000) }))
    }
  })
})

test('createSession: hostile session id or url refused, session_token dropped', async (t) => {
  const answers = [
    { session_id: 'sess-1', url: 'http://verify.didit.test/s' },
    { session_id: 'sess-1', url: 'https://user:pass@verify.didit.test/s' },
    { session_id: 'sess-1', url: 'https://user@verify.didit.test/s' },
    { session_id: 'sess-1', url: 'javascript:alert(1)' },
    { session_id: 'sess-1', url: 'https://a.test/' + 'x'.repeat(2048) },
    { session_id: 'sess-1' },
    { session_id: '', url: 'https://a.test/' },
    { session_id: '../x', url: 'https://a.test/' },
    { session_id: 'x'.repeat(129), url: 'https://a.test/' },
    { session_id: 7, url: 'https://a.test/' },
    [1, 2]
  ]
  for (const body of answers) {
    await createRefused(t, {
      create: (req, res, ctx) => ctx.json(res, 201, Array.isArray(body) ? body : { ...body, session_token: SESSION_TOKEN })
    })
  }
})

test('decision: GET with the key, maps the outcome, encodes the id', async (t) => {
  const fake = await fakeFor(t)
  const d = client(fake)
  const { sessionId } = await create(d)
  fake.sessions.set(sessionId, {
    status: 'Approved',
    session_token: SESSION_TOKEN,
    id_verifications: [{ status: 'Approved', age: 17, date_of_birth: DOB, first_name: 'Fulana' }]
  })
  const result = await d.decision(sessionId)
  t.alike(result, { ok: true, outcome: { state: 'verificado', band: '16-17' } })
  noLeak(t, result)
  const req = fake.seen[1]
  t.is(req.method, 'GET')
  t.is(req.path, '/v3/session/' + sessionId + '/decision/')
  t.is(req.headers['x-api-key'], API_KEY)
})

test('decision: failures collapse to { ok: false }', async (t) => {
  const fake = await fakeFor(t)
  const d = client(fake)
  t.alike(await d.decision('nao-existe'), { ok: false }, '404')
  t.alike(await d.decision('../etc'), { ok: false }, 'bad id never sent')
  t.alike(await d.decision(''), { ok: false })
  fake.script({ decision: (req, res, ctx) => ctx.json(res, 500, { date_of_birth: DOB }) })
  const r = await d.decision('sess-1')
  t.alike(r, { ok: false })
  noLeak(t, r)
  fake.script({ decision: (req, res) => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(DOB) })
  t.alike(await d.decision('sess-1'), { ok: false })
  t.absent(fake.seen.some((s) => s.path.includes('..')))
})

test('deleteSession: 200 and 404 ok, 429 and 5xx retry, other 4xx no retry', async (t) => {
  const fake = await fakeFor(t)
  const d = client(fake)
  const { sessionId } = await create(d)
  t.alike(await d.deleteSession(sessionId), { ok: true }, '200')
  const req = fake.seen[1]
  t.is(req.method, 'DELETE')
  t.is(req.path, '/v3/session/' + sessionId + '/delete/')
  t.is(req.headers['x-api-key'], API_KEY)
  t.alike(req.body, { retain_face_embeddings: false })
  t.alike(await d.deleteSession(sessionId), { ok: true }, '404 is already gone')

  const retry = { ok: false, retry: true }
  const noRetry = { ok: false, retry: false }
  for (const [code, expected] of [[503, retry], [429, retry], [500, retry], [502, retry], [504, retry], [403, noRetry], [409, noRetry], [400, noRetry]]) {
    fake.script({ remove: (req, res, ctx) => ctx.json(res, code, { detail: 'x' }) })
    t.alike(await d.deleteSession('sess-1'), expected, String(code))
  }
  t.alike(await d.deleteSession('a/b'), { ok: false, retry: false }, 'bad id never sent')
})

test('deleteSession: timeout and network error retry', async (t) => {
  const fake = await fakeFor(t)
  fake.script(() => {})
  t.alike(await client(fake, { timeoutMs: 100 }).deleteSession('sess-1'), { ok: false, retry: true })
  const down = createDidit({
    apiKey: API_KEY,
    workflowId: WORKFLOW,
    endpoints: { base: fake.base },
    fetch: () => Promise.reject(new TypeError('fetch failed'))
  })
  t.alike(await down.deleteSession('sess-1'), { ok: false, retry: true })
})

test('ageOutcome: documents', (t) => {
  const doc = (...entries) => ageOutcome({ status: 'Approved', id_verifications: entries })
  t.alike(doc({ status: 'Approved', age: 15 }), { state: 'recusado' })
  t.alike(doc({ status: 'Approved', age: 16 }), { state: 'verificado', band: '16-17' })
  t.alike(doc({ status: 'Approved', age: 17 }), { state: 'verificado', band: '16-17' })
  t.alike(doc({ status: 'Approved', age: 18 }), { state: 'verificado', band: '18+' })
  t.alike(doc({ status: 'Approved', age: 40, date_of_birth: DOB }), { state: 'verificado', band: '18+' })
  t.alike(doc({ status: 'In Review', age: 30 }), { state: 'inconclusivo' }, 'document not approved is ignored')
  t.alike(doc({ status: 'Approved', age: 19 }, { status: 'Approved', age: 15 }), { state: 'recusado' }, 'lowest age wins')
  t.alike(doc({ status: 'Approved', age: 17.5 }), { state: 'verificado', band: '16-17' }, 'a fraction rounds down')
  t.alike(doc({ status: 'Approved', age: 15.9 }), { state: 'recusado' }, '15.9 is still under 16')
  t.alike(ageOutcome({
    status: 'Approved',
    id_verifications: [{ status: 'Approved', age: 15.5 }],
    liveness_checks: [{ status: 'Approved', age_estimation: 30 }]
  }), { state: 'recusado' }, 'a fractional under-16 document beats a passing face')
  t.alike(ageOutcome({
    status: 'Approved',
    id_verifications: [{ status: 'Approved', age: Infinity }],
    liveness_checks: [{ status: 'Approved', age_estimation: 30 }]
  }), { state: 'inconclusivo' }, 'an unusable approved document age never falls back to the face')
  t.alike(doc({ status: 'Approved', age: '20' }), { state: 'inconclusivo' })
  t.alike(doc({ status: 'Approved', age: 151 }), { state: 'inconclusivo' })
  t.alike(doc({ status: 'Approved', age: -1 }), { state: 'inconclusivo' })
  t.alike(doc(null, 'x', { status: 'Approved', age: 20 }), { state: 'verificado', band: '18+' })
})

test('ageOutcome: face estimates', (t) => {
  const face = (...entries) => ageOutcome({ status: 'Approved', id_verifications: [], liveness_checks: entries })
  t.alike(face({ age_estimation: 20 }), { state: 'inconclusivo' })
  t.alike(face({ age_estimation: 20.9 }), { state: 'inconclusivo' })
  t.alike(face({ age_estimation: 10 }), { state: 'inconclusivo' }, 'a face never refuses')
  t.alike(face({ age_estimation: 21 }), { state: 'verificado', band: '18+' })
  t.alike(face({ status: 'Approved', age_estimation: 25.3 }), { state: 'verificado', band: '18+' })
  t.alike(face({ status: 'Declined', age_estimation: 30 }), { state: 'inconclusivo' })
  t.alike(face({ age_estimation: Infinity }), { state: 'inconclusivo' })
  t.alike(face({ age_estimation: '30' }), { state: 'inconclusivo' })
  t.alike(face({ age_estimation: 25 }, { age_estimation: 17 }), { state: 'inconclusivo' }, 'the lowest estimate decides')
  t.alike(face({ age_estimation: 17 }, { age_estimation: 25 }), { state: 'inconclusivo' }, 'order does not matter')
  t.alike(face({ age_estimation: 22 }, { age_estimation: 30 }), { state: 'verificado', band: '18+' })
  t.alike(face({ status: 'Declined', age_estimation: 17 }, { age_estimation: 25 }), { state: 'verificado', band: '18+' }, 'a declined entry is ignored')
  t.alike(ageOutcome({
    status: 'Approved',
    id_verifications: [{ status: 'Approved', age: 15 }],
    liveness_checks: [{ age_estimation: 40 }]
  }), { state: 'recusado' }, 'a document beats a face')
  t.alike(ageOutcome({ status: 'Approved' }), { state: 'inconclusivo' }, 'approved with nothing')
})

test('ageOutcome: session statuses', (t) => {
  t.alike(ageOutcome({ status: 'Declined', id_verifications: [{ status: 'Approved', age: 30 }] }), { state: 'recusado' })
  for (const s of ['In Review', 'In Progress', 'Not Started', 'Awaiting User', 'Resubmitted']) {
    t.alike(ageOutcome({ status: s, id_verifications: [{ status: 'Approved', age: 30 }] }), { state: 'pendente' }, s)
  }
  for (const s of ['Abandoned', 'Expired', 'Kyc Expired']) {
    t.alike(ageOutcome({ status: s }), { state: 'expirado' }, s)
  }
  for (const s of ['approved', 'APPROVED', ' Approved', 'Unknown', '', undefined, 1]) {
    t.alike(ageOutcome({ status: s, id_verifications: [{ status: 'Approved', age: 30 }] }), { state: 'inconclusivo' }, String(s))
  }
  for (const v of [null, undefined, 'Approved', 7, [], [{ status: 'Approved' }]]) {
    t.alike(ageOutcome(v), { state: 'inconclusivo' })
  }
})

test('ageOutcome never returns vendor data', (t) => {
  const out = ageOutcome({
    status: 'Approved',
    session_token: SESSION_TOKEN,
    id_verifications: [{ status: 'Approved', age: 22, date_of_birth: DOB, document_number: 'X1' }]
  })
  t.alike(out, { state: 'verificado', band: '18+' })
  noLeak(t, out)
})
