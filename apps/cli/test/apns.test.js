'use strict'

const test = require('brittle')
const http2 = require('node:http2')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { createApns } = require('../lib/account/apns')

const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const config = {
  key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  keyId: 'TESTKEY',
  teamId: 'TESTTEAM',
  topic: 'app.varanda.test'
}
const notice = { token: 'a'.repeat(64), alert: 'Você recebeu uma mensagem', tag: 'abcdefghijklmn_-', kind: 'dm' }

async function setup (t, handle, options = {}) {
  const server = http2.createServer()
  const sessions = new Set()
  const requests = []
  let connections = 0
  server.on('session', session => {
    connections++
    sessions.add(session)
    session.on('error', () => {})
    session.on('close', () => sessions.delete(session))
  })
  server.on('stream', (stream, headers) => {
    const session = stream.session
    stream.on('error', () => {})
    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', chunk => { body += chunk })
    stream.on('end', () => {
      const request = { headers, body: JSON.parse(body), stream, session }
      requests.push(request)
      handle(request, requests.length)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const sender = createApns({ ...config, origin: 'http://127.0.0.1:' + server.address().port, ...options })
  t.teardown(async () => {
    sender.close()
    for (const session of sessions) session.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  return { sender, requests, connections: () => connections }
}

function respond (request, status = 200, body = '') {
  request.stream.respond({ ':status': status })
  request.stream.end(typeof body === 'string' ? body : JSON.stringify(body))
}

test('APNs validates configuration without exposing key material', t => {
  for (const field of ['key', 'keyId', 'teamId', 'topic']) {
    const candidate = { ...config }
    delete candidate[field]
    t.exception.all(() => createApns(candidate), new RegExp(field))
  }
  for (const [field, value] of [['key', 'invalid-private-material'], ['origin', 'invalid-origin'], ['now', 1], ['timeoutMs', 0], ['sandbox', 'yes']]) {
    let error
    try { createApns({ ...config, [field]: value }) } catch (err) { error = err }
    t.ok(error && error.constructor === Error && error.message.includes(field), 'plain error identifies field')
    t.absent(error.message.includes('invalid-private-material'), 'no key in error')
  }
  const wrongKey = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ format: 'pem', type: 'pkcs8' })
  t.exception.all(() => createApns({ ...config, key: wrongKey }), /key/)
})

test('APNs rejects invalid notices before connecting', async t => {
  const { sender, requests, connections } = await setup(t, request => respond(request))
  const invalid = [undefined, null, {}, 'notice']
  for (const token of ['', 'a'.repeat(63), 'a'.repeat(201), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\n', 42]) invalid.push({ ...notice, token })
  for (const alert of ['', 'x'.repeat(201), null]) invalid.push({ ...notice, alert })
  for (const tag of ['short', 'x'.repeat(17), 'abcdefghijklmn_\n']) invalid.push({ ...notice, tag })
  invalid.push({ ...notice, kind: 'other' })
  for (const input of invalid) t.is(await sender.send(input), 'dropped')
  t.is(requests.length, 0)
  t.is(connections(), 0)
})

test('APNs sends the exact payload and headers with a verifiable ES256 JWT', async t => {
  const time = 1800000000123
  const { sender, requests } = await setup(t, request => respond(request), { now: () => time })
  for (const kind of ['dm', 'dm-page', 'group', 'group-private']) {
    t.is(await sender.send({ ...notice, kind, sender: 'ignored', memberKey: 'ignored' }), 'ok')
    const { headers, body } = requests.at(-1)
    t.is(headers[':method'], 'POST')
    t.ok(headers[':path'] === '/3/device/' + notice.token, 'device path matches')
    t.is(headers['apns-topic'], config.topic)
    t.is(headers['apns-push-type'], 'alert')
    t.is(headers['apns-priority'], '10')
    t.is(headers['apns-collapse-id'], notice.tag)
    t.alike(body, { aps: { alert: { body: notice.alert }, sound: 'default', 'thread-id': kind }, k: kind, t: notice.tag })
    t.alike(Object.keys(body).sort(), ['aps', 'k', 't'])
    t.ok(headers.authorization.startsWith('bearer '))
    const [header, claims, signature] = headers.authorization.slice(7).split('.')
    t.alike(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: config.keyId })
    t.alike(JSON.parse(Buffer.from(claims, 'base64url')), { iss: config.teamId, iat: Math.floor(time / 1000) })
    const sig = Buffer.from(signature, 'base64url')
    t.is(sig.length, 64)
    t.ok(crypto.verify('sha256', Buffer.from(header + '.' + claims), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, sig), 'JWT signature verifies')
  }
})

test('APNs reuses one session and refreshes its provider token at 50 minutes', async t => {
  let time = 1800000000000
  const { sender, requests, connections } = await setup(t, request => respond(request), { now: () => time })
  t.is(await sender.send(notice), 'ok')
  time += 50 * 60 * 1000 - 1
  t.is(await sender.send(notice), 'ok')
  t.ok(requests[0].headers.authorization === requests[1].headers.authorization, 'JWT reused before 50 minutes')
  time++
  t.is(await sender.send(notice), 'ok')
  t.ok(requests[1].headers.authorization !== requests[2].headers.authorization, 'JWT refreshed at 50 minutes')
  t.is(connections(), 1)
})

test('APNs accepts the maximum device token and alert lengths', async t => {
  const { sender, requests } = await setup(t, request => respond(request))
  const token = 'b'.repeat(200)
  t.is(await sender.send({ ...notice, token, alert: 'x'.repeat(200) }), 'ok')
  t.ok(requests[0].headers[':path'] === '/3/device/' + token, 'maximum device path matches')
  t.is(requests[0].body.aps.alert.body.length, 200)
})

test('APNs marks only 410 Unregistered as gone and never retries', async t => {
  const cases = [
    [410, { reason: 'Unregistered' }, 'gone'],
    [400, { reason: 'BadDeviceToken' }, 'dropped'],
    [500, {}, 'dropped'],
    [410, { reason: 'Other' }, 'dropped'],
    [400, { reason: 'Unregistered' }, 'dropped'],
    [410, 'invalid json', 'dropped'],
    [403, { reason: 'ExpiredProviderToken' }, 'dropped'],
    [429, {}, 'dropped'],
    [302, {}, 'dropped']
  ]
  const { sender, requests } = await setup(t, (request, count) => respond(request, cases[count - 1][0], cases[count - 1][1]))
  for (const [, , outcome] of cases) t.is(await sender.send(notice), outcome)
  t.is(requests.length, cases.length)
})

test('APNs times out stalled responses without retrying', async t => {
  const { sender, requests } = await setup(t, () => {}, { timeoutMs: 100 })
  t.is(await sender.send(notice), 'dropped')
  t.is(requests.length, 1)
})

test('APNs reconnects lazily after a session closes', async t => {
  const { sender, requests, connections } = await setup(t, request => respond(request))
  t.is(await sender.send(notice), 'ok')
  const session = requests[0].session
  const closed = once(session, 'close')
  session.close()
  await closed
  t.is(connections(), 1)
  t.is(await sender.send(notice), 'ok')
  t.is(connections(), 2)
})

test('APNs drops interrupted streams and oversized responses', async t => {
  const { sender, requests } = await setup(t, (request, count) => {
    if (count === 1) request.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
    else respond(request, 410, 'x'.repeat(65537))
  })
  t.is(await sender.send(notice), 'dropped')
  t.is(await sender.send(notice), 'dropped')
  t.is(requests.length, 2)
})

test('APNs drops a session error and reconnects only on the next send', async t => {
  const { sender, requests, connections } = await setup(t, (request, count) => {
    if (count === 1) request.session.destroy(new Error('test session failure'))
    else respond(request)
  })
  t.is(await sender.send(notice), 'dropped')
  t.is(requests.length, 1)
  t.is(connections(), 1)
  t.is(await sender.send(notice), 'ok')
  t.is(requests.length, 2)
  t.is(connections(), 2)
})

test('APNs never logs device tokens or credentials during delivery', async t => {
  const { sender, requests } = await setup(t, request => respond(request))
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
  t.absent(logged.includes(requests[0].headers.authorization.slice(7)), 'no JWT logged')
  t.absent(logged.includes(config.key), 'no key logged')
})
