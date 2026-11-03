'use strict'

// Cognito guest credentials and the capture descriptor parser, against a
// loopback fake of the Cognito Identity JSON API (no public network).
const test = require('brittle')
const http = require('node:http')
const load = () => import('../src/livenessCredentials.js')

const POOL = 'eu-west-1:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'
const IDENTITY = 'eu-west-1:11111111-2222-3333-4444-555555555555'
const ACCESS = 'ASIAFAKEACCESSKEY0001'
const SECRET = 'fake-secret-key-never-logged'
const SESSION = 'fake-session-token-never-logged'
const EXPIRATION = 1893456000

async function fakeCognito (t, answer) {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const call = { method: req.method, headers: req.headers, body: JSON.parse(raw || 'null') }
      calls.push(call)
      const out = answer(call)
      res.writeHead(out.status || 200, { 'content-type': 'application/x-amz-json-1.1' })
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  return { calls, endpoint: 'http://127.0.0.1:' + server.address().port + '/' }
}

function good ({ headers }) {
  const target = headers['x-amz-target']
  if (target === 'AWSCognitoIdentityService.GetId') return { body: { IdentityId: IDENTITY } }
  if (target === 'AWSCognitoIdentityService.GetCredentialsForIdentity') {
    return {
      body: {
        IdentityId: IDENTITY,
        Credentials: { AccessKeyId: ACCESS, SecretKey: SECRET, SessionToken: SESSION, Expiration: EXPIRATION }
      }
    }
  }
  return { status: 400, body: { message: 'unknown target' } }
}

test('the provider calls GetId then GetCredentialsForIdentity with the Cognito headers', async (t) => {
  const { createCredentialProvider } = await load()
  const fake = await fakeCognito(t, good)
  const provider = createCredentialProvider({ region: 'eu-west-1', identityPoolId: POOL, fetch, endpoint: fake.endpoint })
  const creds = await provider()

  t.is(fake.calls.length, 2)
  t.is(fake.calls[0].headers['x-amz-target'], 'AWSCognitoIdentityService.GetId')
  t.is(fake.calls[1].headers['x-amz-target'], 'AWSCognitoIdentityService.GetCredentialsForIdentity')
  for (const c of fake.calls) {
    t.is(c.method, 'POST')
    t.is(c.headers['content-type'], 'application/x-amz-json-1.1')
    t.absent(c.headers.cookie)
    t.absent(c.headers.authorization)
  }
  t.alike(fake.calls[0].body, { IdentityPoolId: POOL })
  t.alike(fake.calls[1].body, { IdentityId: IDENTITY })

  t.alike(Object.keys(creds).sort(), ['accessKeyId', 'expiration', 'secretAccessKey', 'sessionToken'])
  t.is(creds.accessKeyId, ACCESS)
  t.is(creds.secretAccessKey, SECRET)
  t.is(creds.sessionToken, SESSION)
  t.ok(creds.expiration instanceof Date)
  t.is(creds.expiration.getTime(), EXPIRATION * 1000)
})

test('the fetch options omit credentials, refuse redirects and skip the cache', async (t) => {
  const { createCredentialProvider } = await load()
  const seen = []
  const stub = async (url, opts) => {
    seen.push({ url, opts })
    const target = opts.headers['X-Amz-Target']
    return { status: 200, redirected: false, json: async () => good({ headers: { 'x-amz-target': target } }).body }
  }
  await createCredentialProvider({ region: 'eu-west-1', identityPoolId: POOL, fetch: stub })()
  t.is(seen.length, 2)
  for (const { url, opts } of seen) {
    t.is(url, 'https://cognito-identity.eu-west-1.amazonaws.com/')
    t.is(opts.method, 'POST')
    t.is(opts.credentials, 'omit')
    t.is(opts.redirect, 'error')
    t.is(opts.cache, 'no-store')
  }
})

test('a region outside the list or a pool of another region is never fetched', async (t) => {
  const { createCredentialProvider } = await load()
  const fake = await fakeCognito(t, good)
  const bad = [
    { region: 'eu-central-1', identityPoolId: 'eu-central-1:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' },
    { region: 'eu-west-1', identityPoolId: 'us-east-1:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' },
    { region: 'eu-west-1', identityPoolId: 'eu-west-1:not-a-uuid' },
    { region: undefined, identityPoolId: POOL }
  ]
  for (const b of bad) {
    const provider = createCredentialProvider({ ...b, fetch, endpoint: fake.endpoint })
    await t.exception(provider(), /verificação/)
    try { await provider() } catch (err) { t.is(err.code, 'CREDENTIALS') }
  }
  t.is(fake.calls.length, 0)
})

test('a malformed answer fails with CREDENTIALS and never echoes the response', async (t) => {
  const { createCredentialProvider } = await load()
  const answers = [
    () => ({ body: { IdentityId: '' } }),
    () => ({ body: 'not json SECRET-IN-BODY' }),
    () => ({ status: 500, body: { message: 'SECRET-IN-BODY' } }),
    (c) => c.headers['x-amz-target'].endsWith('GetId')
      ? good(c)
      : { body: { Credentials: { AccessKeyId: ACCESS, SecretKey: '', SessionToken: SESSION, Expiration: EXPIRATION } } },
    (c) => c.headers['x-amz-target'].endsWith('GetId')
      ? good(c)
      : { body: { Credentials: { AccessKeyId: ACCESS, SecretKey: SECRET, SessionToken: SESSION, Expiration: 'SECRET-IN-BODY' } } },
    (c) => c.headers['x-amz-target'].endsWith('GetId') ? good(c) : { body: { Credentials: null } }
  ]
  for (const answer of answers) {
    const fake = await fakeCognito(t, answer)
    const provider = createCredentialProvider({ region: 'eu-west-1', identityPoolId: POOL, fetch, endpoint: fake.endpoint })
    try {
      await provider()
      t.fail('should have failed')
    } catch (err) {
      t.is(err.code, 'CREDENTIALS')
      t.absent(String(err.message).includes('SECRET-IN-BODY'))
      t.absent(String(err.message).includes(ACCESS))
    }
  }
})

test('a stalled Cognito fails with TIMEOUT', async (t) => {
  const { createCredentialProvider } = await load()
  const stub = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const provider = createCredentialProvider({ region: 'eu-west-1', identityPoolId: POOL, fetch: stub, timeoutMs: 50 })
  try {
    await provider()
    t.fail('should have timed out')
  } catch (err) {
    t.is(err.code, 'TIMEOUT')
  }
})

test('two provider calls hit Cognito twice: nothing is cached', async (t) => {
  const { createCredentialProvider } = await load()
  const fake = await fakeCognito(t, good)
  const provider = createCredentialProvider({ region: 'eu-west-1', identityPoolId: POOL, fetch, endpoint: fake.endpoint })
  await provider()
  await provider()
  t.is(fake.calls.length, 4)
  await createCredentialProvider({ region: 'eu-west-1', identityPoolId: POOL, fetch, endpoint: fake.endpoint })()
  t.is(fake.calls.length, 6)
})

test('parseCapture accepts the fake shape and rejects each bad field', async (t) => {
  const { parseCapture, STREAMING_REGIONS } = await load()
  t.is(STREAMING_REGIONS.length, 8)
  const ok = { sessionId: 'fake-liveness-session-1', region: 'eu-west-1', identityPoolId: POOL }
  t.alike(parseCapture(ok), ok)
  t.alike(parseCapture({ ...ok, validateLivenessToken: 'x'.repeat(300), extra: 1 }), ok)
  for (const region of STREAMING_REGIONS) {
    const pool = region + ':0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'
    t.alike(parseCapture({ ...ok, region, identityPoolId: pool }), { ...ok, region, identityPoolId: pool })
  }

  const bad = [
    null,
    undefined,
    'string',
    [ok],
    { ...ok, sessionId: undefined },
    { ...ok, sessionId: '' },
    { ...ok, sessionId: '...' },
    { ...ok, sessionId: 'has space' },
    { ...ok, sessionId: 'a'.repeat(129) },
    { ...ok, region: undefined },
    { ...ok, region: 'eu-central-1', identityPoolId: 'eu-central-1:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' },
    { ...ok, region: 'us-east-1' },
    { ...ok, identityPoolId: undefined },
    { ...ok, identityPoolId: 'eu-west-1:' },
    { ...ok, identityPoolId: 'eu-west-1:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b-extra' },
    { ...ok, identityPoolId: 'eu-west-10f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' }
  ]
  for (const b of bad) t.is(parseCapture(b), null)
})
