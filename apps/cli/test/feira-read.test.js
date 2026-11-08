'use strict'

// apps/cli/lib/account/feira-read.js against a fake loopback seeder: the
// listing check read by the Feira entry and the folded current view
// read by the moderation panel. Nothing leaves 127.0.0.1.

const test = require('brittle')
const http = require('node:http')
const b4a = require('b4a')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createListingReader, MAX_BODY } = require('../lib/account/feira-read')

const TOKEN = 'c3'.repeat(32)
const VIEW = { title: 'Bicicleta', text: 'aro 29', priceLabel: 'R$ 500,00', city: 'São Paulo', uf: 'SP', kind: 'produto', status: 'disponivel' }

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function fixture (t) {
  const state = { handler: (req, res) => res.writeHead(404).end(), requests: [] }
  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    state.requests.push({ url: req.url, auth: req.headers.authorization })
    state.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(resolve)
  }))
  state.baseUrl = 'http://127.0.0.1:' + server.address().port
  return state
}

function serveJson (text) {
  return (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text)
  }
}

// Every console method recorded while `fn` runs.
async function silent (t, fn) {
  const calls = []
  const saved = {}
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[k] = console[k]
    console[k] = (...args) => calls.push(args)
  }
  const out = process.stdout.write
  const err = process.stderr.write
  const writes = []
  process.stdout.write = (chunk, ...rest) => { writes.push(String(chunk)); return out.call(process.stdout, chunk, ...rest) }
  process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return err.call(process.stderr, chunk, ...rest) }
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(saved)) console[k] = saved[k]
    process.stdout.write = out
    process.stderr.write = err
    t.is(calls.length, 0, 'no console call')
    t.absent(writes.some((w) => w.includes(TOKEN)), 'the token never reaches stdout or stderr')
  }
}

function setup () {
  const assoc = generateAssociationKeyPair()
  const author = hex(generateAssociationKeyPair().publicKey)
  return { association: hex(assoc.publicKey), author }
}

test('readListing: { ok: true } from /feira-listing is accepted, with the request it sends', async (t) => {
  const s = setup()
  const fx = await fixture(t)
  const reader = createListingReader({ baseUrl: fx.baseUrl, token: TOKEN, association: s.association })

  fx.handler = serveJson('{"ok":true}\n')
  const r = await silent(t, () => reader.readListing(s.author, 3))
  t.alike(r, { author: s.author, seq: 3 })
  t.is(fx.requests[0].url, '/feira-listing/' + s.author + '/3', 'its own route, never /moderation-post')
  t.is(fx.requests[0].auth, 'Bearer ' + TOKEN)
  t.is(fx.requests.length, 1, 'one request, no status read')
})

test('readListing: any other answer is refused', async (t) => {
  const s = setup()
  const fx = await fixture(t)
  const reader = createListingReader({ baseUrl: fx.baseUrl, token: TOKEN, association: s.association })

  fx.handler = serveJson('{"ok":false}')
  t.is(await reader.readListing(s.author, 3), 'recusado', 'ok false')
  fx.handler = serveJson('{"ok":"true"}')
  t.is(await reader.readListing(s.author, 3), 'recusado', 'ok not a boolean')
  fx.handler = serveJson('{"ok":true,"extra":1}')
  t.is(await reader.readListing(s.author, 3), 'recusado', 'an unknown key')
  fx.handler = serveJson('{}')
  t.is(await reader.readListing(s.author, 3), 'recusado', 'no key')
  fx.handler = serveJson('[true]')
  t.is(await reader.readListing(s.author, 3), 'recusado', 'not an object')
})

test('readListing and readCurrent: 404, redirect, byte limit, timeout and bad arguments', async (t) => {
  const s = setup()
  const fx = await fixture(t)
  const reader = createListingReader({ baseUrl: fx.baseUrl, token: TOKEN, association: s.association, timeoutMs: 300 })

  fx.handler = (req, res) => res.writeHead(404).end()
  t.is(await reader.readListing(s.author, 3), 'ausente')
  t.is(await reader.readCurrent(s.author, 3), 'ausente')

  fx.handler = (req, res) => res.writeHead(302, { location: fx.baseUrl + '/elsewhere' }).end()
  t.is(await reader.readListing(s.author, 3), 'recusado', 'a redirect is never followed')
  t.is(await reader.readCurrent(s.author, 3), 'recusado')
  t.absent(fx.requests.some((r) => r.url === '/elsewhere'), 'the redirect target is never asked')

  fx.handler = serveJson('{"v":1,"pad":"' + 'a'.repeat(MAX_BODY) + '"}')
  t.is(await reader.readListing(s.author, 3), 'recusado', 'over the byte limit')
  fx.handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"pad":"' + 'a'.repeat(MAX_BODY / 2))
    res.write('a'.repeat(MAX_BODY))
    res.end('"}')
  }
  t.is(await reader.readCurrent(s.author, 3), 'recusado', 'a chunked body over the limit')

  fx.handler = () => {}
  t.is(await reader.readListing(s.author, 3), 'timeout')
  t.is(await reader.readCurrent(s.author, 3), 'timeout')

  fx.handler = (req, res) => res.writeHead(500).end()
  t.is(await reader.readListing(s.author, 3), 'recusado')

  t.is(await reader.readListing('AB'.repeat(32), 3), 'config', 'uppercase key')
  t.is(await reader.readListing(s.author, 0), 'config', 'seq 0')
  t.is(await reader.readCurrent(s.author, 1.5), 'config')
  const remote = createListingReader({ baseUrl: 'http://example.test:80', token: TOKEN, association: s.association })
  t.is(await remote.readListing(s.author, 3), 'config', 'never a non-loopback base')
  const tokenless = createListingReader({ baseUrl: fx.baseUrl, token: null, association: s.association })
  t.is(await tokenless.readCurrent(s.author, 3), 'config', 'never without the token')
})

test('readCurrent: the folded view, exact keys and string or null values', async (t) => {
  const s = setup()
  const fx = await fixture(t)
  const reader = createListingReader({ baseUrl: fx.baseUrl, token: TOKEN, association: s.association })

  fx.handler = serveJson(JSON.stringify(VIEW))
  const v = await silent(t, () => reader.readCurrent(s.author, 3))
  t.alike(v, VIEW)
  t.is(fx.requests[0].url, '/moderation-listing/' + s.author + '/3')
  t.is(fx.requests[0].auth, 'Bearer ' + TOKEN)

  fx.handler = serveJson(JSON.stringify({ ...VIEW, status: null }))
  t.is((await reader.readCurrent(s.author, 3)).status, null, 'an unknown status')
  fx.handler = serveJson(JSON.stringify({ ...VIEW, extra: 1 }))
  t.is(await reader.readCurrent(s.author, 3), 'recusado', 'an unknown key')
  fx.handler = serveJson(JSON.stringify({ ...VIEW, title: 42 }))
  t.is(await reader.readCurrent(s.author, 3), 'recusado', 'a non-string value')
  fx.handler = serveJson('[1]')
  t.is(await reader.readCurrent(s.author, 3), 'recusado', 'not an object')
  fx.handler = serveJson('nope')
  t.is(await reader.readCurrent(s.author, 3), 'recusado', 'not JSON')
})
