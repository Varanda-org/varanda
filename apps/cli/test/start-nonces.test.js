'use strict'

// apps/cli/lib/account/start-nonces.js: the stateless nonces of the unsigned
// phone and age start routes. A fake clock throughout.

const test = require('brittle')
const nodeCrypto = require('node:crypto')
const { createStartNonces, spentCapacity, MAX_SPENT } = require('../lib/account/start-nonces')

const TTL = 600 * 1000
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

function hex () {
  return nodeCrypto.randomBytes(32).toString('hex')
}

function clock (start = 1_800_000_000_000) {
  const c = { t: start }
  c.now = () => c.t
  return c
}

test('start nonces: a 43-character token that spends once, for its member only', (t) => {
  const c = clock()
  const n = createStartNonces({ label: 'varanda-phone-start-v1', now: c.now })
  const a = hex()
  const b = hex()
  const nonce = n.mint(a)
  t.ok(TOKEN_RE.test(nonce), 'the wire format clients already handle')
  t.is(Buffer.from(nonce, 'base64url').length, 32)
  t.is(n.size(), 0, 'minting stores nothing')
  t.absent(n.spend(b, nonce), 'minted for another member')
  t.ok(n.spend(a, nonce))
  t.absent(n.spend(a, nonce), 'a second spend is refused')
  t.is(n.size(), 1)
  t.not(n.mint(a), n.mint(a), 'random per mint')
})

test('start nonces: expired, malformed and tampered nonces are refused', (t) => {
  const c = clock()
  const n = createStartNonces({ label: 'varanda-phone-start-v1', now: c.now })
  const a = hex()
  const late = n.mint(a)
  c.t += TTL + 1000
  t.absent(n.spend(a, late), 'expired')

  const nonce = n.mint(a)
  const raw = Buffer.from(nonce, 'base64url')
  for (let i = 0; i < raw.length; i++) {
    const bad = Buffer.from(raw)
    bad[i] ^= 1
    t.absent(n.spend(a, bad.toString('base64url')), 'byte ' + i + ' tampered')
  }
  // The last character carries 2 spare bits: another spelling of the same bytes.
  const last = nonce[42]
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const respelled = nonce.slice(0, 42) + alphabet[alphabet.indexOf(last) ^ 1]
  t.alike(Buffer.from(respelled, 'base64url'), raw, 'decodes to the same bytes')
  t.absent(n.spend(a, respelled), 'a non-canonical spelling is refused')
  for (const v of [undefined, null, 42, '', nonce.slice(0, 42), nonce + 'A', 'A'.repeat(43), nonce.replace(/.$/, '=')]) {
    t.absent(n.spend(a, v), 'malformed: ' + String(v))
  }
  t.absent(n.spend('A'.repeat(64), nonce), 'a malformed member')
  t.ok(n.spend(a, nonce), 'the untouched nonce still spends')
})

test('start nonces: a phone nonce never spends at the age table, nor after a restart', (t) => {
  const c = clock()
  const a = hex()
  const phone = createStartNonces({ label: 'varanda-phone-start-v1', now: c.now })
  const age = createStartNonces({ label: 'varanda-age-start-v1', now: c.now })
  t.absent(age.spend(a, phone.mint(a)), 'another route')
  const restarted = createStartNonces({ label: 'varanda-phone-start-v1', now: c.now })
  const nonce = phone.mint(a)
  t.absent(restarted.spend(a, nonce), 'a second instance has another secret')
  t.ok(phone.spend(a, nonce))
})

test('start nonces: a full spent table refuses instead of evicting, and frees room as entries expire', (t) => {
  const c = clock()
  const n = createStartNonces({ label: 'varanda-phone-start-v1', now: c.now, max: 2 })
  const a = hex()
  const first = n.mint(a)
  const second = n.mint(a)
  const third = n.mint(a)
  t.ok(n.spend(a, first))
  t.ok(n.spend(a, second))
  t.absent(n.spend(a, third), 'full of live entries: refused')
  t.absent(n.spend(a, first), 'the first spent entry was not evicted')
  t.is(n.size(), 2)
  c.t += TTL + 1000
  const fresh = n.mint(a)
  t.ok(n.spend(a, fresh), 'room again once the spent entries expired')
  t.is(n.size(), 1)
  t.is(MAX_SPENT, 16384)
})

test('start nonces: a clock that steps back never revives a spent nonce', (t) => {
  const c = clock()
  const n = createStartNonces({ label: 'varanda-phone-start-v1', now: c.now, max: 1 })
  const a = hex()
  const nonce = n.mint(a)
  t.ok(n.spend(a, nonce))
  // Forward past the expiry (the entry is pruned to make room), then back.
  c.t += TTL + 1000
  t.ok(n.spend(a, n.mint(a)))
  c.t -= TTL
  t.absent(n.spend(a, nonce), 'held clock: still expired')
  c.t -= 10 * TTL
  t.absent(n.spend(a, nonce), 'a large step back draws a new secret')
  t.ok(n.spend(a, n.mint(a)), 'new nonces work')
})

test('start nonces: malformed options throw', (t) => {
  t.exception.all(() => createStartNonces({}), /label/)
  t.exception.all(() => createStartNonces({ label: 'a\nb' }), /label/)
  t.exception.all(() => createStartNonces({ label: 'x', max: 0 }), /max/)
  t.exception.all(() => createStartNonces({ label: 'x', ttlMs: 10 }), /ttlMs/)
  t.exception.all(() => createStartNonces({ label: 'x' }).mint('zz'), /member/)
})

test('start nonces: the spent table grows with the token bucket, never below the floor', (t) => {
  t.is(spentCapacity(20, 100), MAX_SPENT, 'the default bucket fits the floor')
  t.ok(20 * TTL / 1000 + 100 <= MAX_SPENT)
  t.is(spentCapacity(100, 100), 100 * 600 + 100, 'a faster bucket: one TTL of spends plus the burst')
  t.is(spentCapacity(1, 1), MAX_SPENT)
  t.is(spentCapacity(30, 50, 1000), MAX_SPENT, 'a shorter TTL')
})
