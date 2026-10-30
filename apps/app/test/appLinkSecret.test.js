'use strict'

// The app's link secret (src/appLinkSecret.js) against node:crypto, which is
// what the account service uses (apps/cli/lib/account/app-return.js).
const test = require('brittle')
const crypto = require('node:crypto')

const load = () => import('../src/appLinkSecret.js')

test('base64url matches node:crypto for every tail length', async (t) => {
  const { base64url } = await load()
  for (let n = 0; n < 40; n++) {
    const b = crypto.randomBytes(n)
    t.is(base64url(new Uint8Array(b)), b.toString('base64url'), 'length ' + n)
  }
})

test('newLinkSecret: secret is V, proof is sha256(V), as the service checks', async (t) => {
  const { newLinkSecret } = await load()
  for (let i = 0; i < 20; i++) {
    let handed = null
    const { secret, proof } = newLinkSecret((n) => {
      handed = new Uint8Array(crypto.randomBytes(n))
      return handed
    })
    t.is(secret.length, 43)
    t.ok(/^[A-Za-z0-9_-]{43}$/.test(secret))
    const v = Buffer.from(secret, 'base64url')
    t.is(v.length, 32)
    t.is(v.toString('base64url'), secret, 'canonical spelling')
    t.is(proof, crypto.createHash('sha256').update(v).digest('base64url'))
    t.ok(handed.every((x) => x === 0), 'the raw bytes are zeroed')
  }
})

test('newLinkSecret uses the injected sha256 and zeroes its digest', async (t) => {
  const { newLinkSecret } = await load()
  const digest = new Uint8Array(32).fill(7)
  const r = newLinkSecret((n) => new Uint8Array(n).fill(1), () => digest)
  t.is(r.proof, Buffer.alloc(32, 7).toString('base64url'))
  t.is(r.secret, Buffer.alloc(32, 1).toString('base64url'))
  t.ok(digest.every((x) => x === 0))
})

test('newLinkSecret refuses a bad random source', async (t) => {
  const { newLinkSecret } = await load()
  t.exception.all(() => newLinkSecret())
  t.exception.all(() => newLinkSecret(() => new Uint8Array(31)))
  t.exception.all(() => newLinkSecret(() => [1, 2, 3]))
  const bytes = new Uint8Array(32).fill(9)
  t.exception.all(() => newLinkSecret(() => bytes, () => new Uint8Array(16)))
  t.ok(bytes.every((x) => x === 0), 'zeroed even when the hash fails')
})

test('deviceRandomBytes reads globalThis.crypto', async (t) => {
  const { deviceRandomBytes } = await load()
  const a = deviceRandomBytes(32)
  t.is(a.length, 32)
  t.ok(a instanceof Uint8Array)
})
