'use strict'

// The hosted lab's GIF provider (scripts/gif-stub.js) behind the account
// service's real GIF routes: a signed-in member searches and gets GIFs, and
// nothing resolves but the stub's own name.
const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { signInvite } = require('@varanda/core/lib/invite')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { createAccountServer } = require('../lib/account/server')
const { openTermsStore } = require('../lib/account/terms-store')
const { createGifStub, STUB_HOST } = require('../scripts/gif-stub')

const ORIGIN = 'http://localhost:8080'

test('gif stub: the lab account service searches and serves its GIFs', async (t) => {
  const stub = await createGifStub()
  t.teardown(() => stub.close())
  t.ok(stub.config !== null, 'the stub config parses')
  const association = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const member = crypto.keyPair()
  const memberHex = b4a.toString(member.publicKey, 'hex')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-gif-stub-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const terms = openTermsStore(dir)
  terms.accept({ member: memberHex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  const store = { start () {}, status: (m) => ({ linked: m === memberHex }) }
  const google = { authorizeUrl () {}, exchange () {} }
  const server = createAccountServer({ association, origin: ORIGIN, google, store, terms, gif: stub.config, gifTransport: stub.transport, moderation: { blocked: () => [] } })
  const svc = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => svc.close())
  const base = 'http://127.0.0.1:' + svc.port
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: JSON.stringify(body) })

  t.alike(await (await fetch(base + '/account/gif/policy')).json(), { enabled: true })
  const { nonce } = await (await post('/account/gif/session/start', { member: memberHex })).json()
  const signature = signInvite({ action: 'summary', nonce, member: memberHex, association }, member)
  const finish = await post('/account/gif/session/finish', { member: memberHex, nonce, signature })
  t.is(finish.status, 200)
  const auth = { Authorization: 'Bearer ' + (await finish.json()).token }

  const found = await post('/account/gif/search', { q: 'qualquer coisa' }, auth)
  t.is(found.status, 200)
  const { items, next } = await found.json()
  t.ok(items.length > 0, 'any search text answers the stub page')
  t.is(next, null, 'one page')
  for (const item of items) t.alike([item.width, item.height], [1, 1])

  for (const size of ['tiny', 'full']) {
    const img = await fetch(base + '/account/gif/image/' + items[0].id + '?size=' + size, { headers: auth })
    t.is(img.status, 200)
    t.is(img.headers.get('content-type'), 'image/gif')
    const bytes = Buffer.from(await img.arrayBuffer())
    t.is(bytes.subarray(0, 6).toString('latin1'), 'GIF89a')
    t.is(bytes.readUInt16LE(6), 1, 'width 1')
    t.is(bytes.readUInt16LE(8), 1, 'height 1')
    t.is(bytes.length, items[0].bytes)
  }
})

test('gif stub: the transport resolves only the stub name, to loopback', async (t) => {
  const stub = await createGifStub()
  t.teardown(() => stub.close())
  const lookup = (host) => new Promise((resolve) => stub.transport.lookup(host, {}, (err, addrs) => resolve(err ? err.code : addrs)))
  t.alike(await lookup(STUB_HOST), [{ address: '127.0.0.1', family: 4 }])
  t.is(await lookup('api.giphy.com'), 'ENOTFOUND')
  t.is(stub.transport.allowAddress('127.0.0.1'), true)
  t.is(stub.transport.allowAddress('192.168.0.1'), false)
})
