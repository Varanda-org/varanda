'use strict'

const test = require('brittle')
const http = require('node:http')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { createFcm } = require('../lib/account/fcm')

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const account = {
  project_id: 'varanda-test',
  client_email: 'push@example.test',
  private_key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  token_uri: 'https://oauth.example.test/token'
}
const notice = { token: 'test_device:123-ABC', alert: 'Você recebeu uma mensagem', tag: 'abcdefghijklmn_-', kind: 'dm' }
const accessToken = crypto.randomBytes(32).toString('base64url')
const fcmError = { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }

async function setup (t, { oauth, message, ...options } = {}) {
  const requests = []
  const tokens = []
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    sockets.add(req.socket)
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const request = { method: req.method, url: req.url, headers: req.headers, body, res }
    if (req.url === '/token') {
      tokens.push(request)
      if (oauth) oauth(request, tokens.length)
      else respond(request, 200, { access_token: accessToken, expires_in: 3600 })
    } else {
      requests.push(request)
      if (message) message(request, requests.length)
      else respond(request, 200, {})
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const sender = createFcm({ account, origin, tokenOrigin: origin, ...options })
  t.teardown(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { sender, requests, tokens, sockets }
}

function respond (request, status, body) {
  request.res.writeHead(status, { 'content-type': 'application/json' })
  request.res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

test('FCM validates configuration without exposing private key material', t => {
  t.exception.all(() => createFcm(), /account/)
  for (const field of ['project_id', 'client_email', 'private_key', 'token_uri']) {
    const candidate = { ...account }
    delete candidate[field]
    t.exception.all(() => createFcm({ account: candidate }), new RegExp(field))
  }
  for (const [field, value] of [['private_key', 'invalid-private-material'], ['token_uri', 'invalid-url'], ['project_id', '../project']]) {
    let error
    try { createFcm({ account: { ...account, [field]: value } }) } catch (err) { error = err }
    t.ok(error && error.constructor === Error && error.message.includes(field), 'plain error identifies field')
    t.absent(error.message.includes('invalid-private-material'), 'no key in error')
  }
  for (const [field, value] of [['origin', 'invalid'], ['tokenOrigin', 'invalid'], ['now', 1], ['timeoutMs', 0]]) {
    t.exception.all(() => createFcm({ account, [field]: value }), new RegExp(field))
  }
  const wrongKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' })
  t.exception.all(() => createFcm({ account: { ...account, private_key: wrongKey } }), /private_key/)
})

test('FCM rejects invalid notices before OAuth or delivery', async t => {
  const { sender, requests, tokens } = await setup(t)
  const invalid = [undefined, null, {}, 'notice']
  for (const token of ['', 'x'.repeat(4097), 'contains space', 'a/b', 'abc\n', 42]) invalid.push({ ...notice, token })
  for (const alert of ['', 'x'.repeat(201), null]) invalid.push({ ...notice, alert })
  for (const tag of ['short', 'x'.repeat(17), 'abcdefghijklmn_\n']) invalid.push({ ...notice, tag })
  invalid.push({ ...notice, kind: 'other' })
  for (const input of invalid) t.is(await sender.send(input), 'dropped')
  t.is(requests.length, 0)
  t.is(tokens.length, 0)
})

test('FCM exchanges a verifiable RS256 assertion and sends only the specified payload', async t => {
  const time = 1800000000123
  const { sender, requests, tokens } = await setup(t, { now: () => time })
  for (const kind of ['dm', 'dm-page', 'group', 'group-private']) {
    t.is(await sender.send({ ...notice, kind, sender: 'ignored', memberKey: 'ignored' }), 'ok')
    const request = requests.at(-1)
    t.is(request.method, 'POST')
    t.is(request.url, '/v1/projects/varanda-test/messages:send')
    t.ok(request.headers.authorization === 'Bearer ' + accessToken, 'OAuth credential matches')
    t.is(request.headers['content-type'], 'application/json')
    const body = JSON.parse(request.body)
    t.alike(Object.keys(body), ['message'])
    t.ok(body.message.token === notice.token, 'device token matches')
    delete body.message.token
    t.alike(body.message, {
      notification: { body: notice.alert },
      android: { collapse_key: notice.tag, priority: 'high', notification: { tag: notice.tag, channel_id: 'conversas' } },
      data: { k: kind, t: notice.tag }
    })
    t.alike(Object.keys(body.message.data).sort(), ['k', 't'])
  }
  t.is(tokens.length, 1)
  t.is(tokens[0].method, 'POST')
  t.is(tokens[0].headers['content-type'], 'application/x-www-form-urlencoded')
  const form = new URLSearchParams(tokens[0].body)
  t.alike([...form.keys()].sort(), ['assertion', 'grant_type'])
  t.is(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
  const [header, claims, signature] = form.get('assertion').split('.')
  t.alike(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  t.alike(JSON.parse(Buffer.from(claims, 'base64url')), {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: account.token_uri,
    iat: Math.floor(time / 1000),
    exp: Math.floor(time / 1000) + 3600
  })
  t.ok(crypto.verify('RSA-SHA256', Buffer.from(header + '.' + claims), keys.publicKey, Buffer.from(signature, 'base64url')), 'JWT signature verifies')
})

test('FCM caches OAuth until five minutes before expiry and refreshes after expiry', async t => {
  let time = 1800000000000
  const { sender, tokens } = await setup(t, { now: () => time })
  t.is(await sender.send(notice), 'ok')
  time += 55 * 60 * 1000 - 1
  t.is(await sender.send(notice), 'ok')
  t.is(tokens.length, 1)
  time++
  t.is(await sender.send(notice), 'ok')
  t.is(tokens.length, 2)
  time += 3600 * 1000
  t.is(await sender.send(notice), 'ok')
  t.is(tokens.length, 3)
})

test('FCM shares concurrent OAuth exchanges and reuses one dedicated connection', async t => {
  let time = 1800000000000
  const { sender, tokens, requests, sockets } = await setup(t, { now: () => time })
  const agents = []
  const original = http.request
  http.request = (url, options, callback) => {
    agents.push(options.agent)
    return original(url, options, callback)
  }
  try {
    for (let batch = 1; batch <= 2; batch++) {
      t.alike(await Promise.all(Array.from({ length: 8 }, () => sender.send(notice))), Array(8).fill('ok'))
      t.is(tokens.length, batch, 'one exchange for an empty or expired cache')
      t.is(requests.length, batch * 8, 'each message sent once')
      time += 3600 * 1000
    }
  } finally {
    http.request = original
  }
  t.is(agents.length, 18)
  t.ok(agents[0] instanceof http.Agent && agents[0] !== http.globalAgent, 'dedicated agent')
  t.ok(agents.every(agent => agent === agents[0]), 'same agent for OAuth and messages')
  t.is(agents[0]?.keepAlive, true)
  t.is(agents[0]?.maxSockets, 1)
  t.is(sockets.size, 1, 'all requests reuse the same socket')
})

test('FCM accepts boundary device token lengths and a 200 character alert', async t => {
  const { sender, requests } = await setup(t)
  for (const token of ['a', 'b'.repeat(4096)]) {
    t.is(await sender.send({ ...notice, token, alert: 'x'.repeat(200) }), 'ok')
    const body = JSON.parse(requests.at(-1).body)
    t.ok(body.message.token === token, 'boundary device token matches')
    t.is(body.message.notification.body.length, 200)
  }
})

test('FCM marks only a typed 404 NOT_FOUND UNREGISTERED detail as gone', async t => {
  const cases = [
    [404, { error: { status: 'NOT_FOUND', details: [fcmError] } }, 'gone'],
    [400, { error: { status: 'INVALID_ARGUMENT' } }, 'dropped'],
    [404, { error: { status: 'NOT_FOUND' } }, 'dropped'],
    [404, { error: { status: 'NOT_FOUND', details: [{ ...fcmError, '@type': 'another-type' }] } }, 'dropped'],
    [404, { error: { status: 'OTHER', details: [fcmError] } }, 'dropped'],
    [400, { error: { status: 'NOT_FOUND', details: [fcmError] } }, 'dropped'],
    [404, { error: { status: 'NOT_FOUND', details: [null, { ...fcmError, errorCode: 'OTHER' }] } }, 'dropped'],
    [404, 'invalid json', 'dropped'],
    [500, {}, 'dropped'],
    [401, {}, 'dropped'],
    [429, {}, 'dropped'],
    [302, {}, 'dropped']
  ]
  const { sender, requests, tokens } = await setup(t, { message: (request, count) => respond(request, cases[count - 1][0], cases[count - 1][1]) })
  for (const [, , outcome] of cases) t.is(await sender.send(notice), outcome)
  t.is(requests.length, cases.length)
  t.is(tokens.length, 1, 'delivery failures do not trigger another OAuth request')
})

test('FCM shares a failed OAuth exchange and retries it only on the next send', async t => {
  const { sender, requests, tokens } = await setup(t, {
    oauth: (request, count) => respond(request, count === 1 ? 500 : 200, { access_token: accessToken, expires_in: 3600 })
  })
  t.alike(await Promise.all(Array.from({ length: 8 }, () => sender.send(notice))), Array(8).fill('dropped'))
  t.is(tokens.length, 1)
  t.is(requests.length, 0)
  t.is(await sender.send(notice), 'ok')
  t.is(tokens.length, 2)
  t.is(requests.length, 1)
})

test('FCM drops malformed OAuth responses without delivery', async t => {
  const bodies = ['invalid json', {}, { access_token: accessToken }, { access_token: accessToken, expires_in: -1 }, { access_token: '', expires_in: 3600 }]
  const { sender, requests, tokens } = await setup(t, { oauth: (request, count) => respond(request, 200, bodies[count - 1]) })
  for (let i = 0; i < bodies.length; i++) t.is(await sender.send(notice), 'dropped')
  t.is(tokens.length, bodies.length)
  t.is(requests.length, 0)
})

test('FCM times out OAuth and message responses without retrying', async t => {
  const oauth = await setup(t, { oauth: () => {}, timeoutMs: 100 })
  t.is(await oauth.sender.send(notice), 'dropped')
  t.is(oauth.tokens.length, 1)
  t.is(oauth.requests.length, 0)
  const delivery = await setup(t, { message: () => {}, timeoutMs: 100 })
  t.is(await delivery.sender.send(notice), 'dropped')
  t.is(delivery.tokens.length, 1)
  t.is(delivery.requests.length, 1)
})

test('FCM drops network failures and oversized responses', async t => {
  const { sender, requests } = await setup(t, {
    message: (request, count) => {
      if (count === 1) request.res.destroy()
      else respond(request, 404, 'x'.repeat(65537))
    }
  })
  t.is(await sender.send(notice), 'dropped')
  t.is(await sender.send(notice), 'dropped')
  t.is(requests.length, 2)
})

test('FCM never logs device tokens or credentials during delivery', async t => {
  const { sender, tokens } = await setup(t)
  const output = []
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']
  const originals = methods.map(name => console[name])
  let outcome
  try {
    for (const name of methods) console[name] = (...args) => output.push(args.join(' '))
    outcome = await sender.send(notice)
  } finally {
    methods.forEach((name, index) => { console[name] = originals[index] })
  }
  t.is(outcome, 'ok')
  const logged = output.join('\n')
  t.absent(logged.includes(notice.token), 'no device token logged')
  t.absent(logged.includes(accessToken), 'no OAuth token logged')
  t.absent(logged.includes(new URLSearchParams(tokens[0].body).get('assertion')), 'no JWT logged')
  t.absent(logged.includes(account.private_key), 'no private key logged')
})
