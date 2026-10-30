'use strict'

// apps/cli/lib/account/app-return.js: the pure rules of the native app's
// account sign-in. No network.

const test = require('brittle')
const nodeCrypto = require('node:crypto')
const {
  OUTCOMES,
  isAppRequest,
  isAppProof,
  proofOf,
  safeEqual,
  mintRedeem,
  redeemMatches,
  accountReturnUrl,
  ageReturnUrl,
  header
} = require('../lib/account/app-return')

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

function secret () {
  return nodeCrypto.randomBytes(32).toString('base64url')
}

test('isAppRequest: exactly x-varanda-client: app', (t) => {
  t.ok(isAppRequest({ headers: { 'x-varanda-client': 'app' } }))
  for (const v of [undefined, '', 'App', 'app ', 'web', ['app']]) {
    t.absent(isAppRequest({ headers: { 'x-varanda-client': v } }), JSON.stringify(v))
  }
})

test('isAppProof: base64url of exactly 32 bytes, canonical, no padding', (t) => {
  const good = proofOf(secret())
  t.ok(isAppProof(good))
  const nonCanonical = good.slice(0, 42) + String.fromCharCode(good.charCodeAt(42) + 1)
  for (const v of [undefined, null, 42, '', good.slice(0, 42), good + 'A', good.slice(0, 42) + '=', good.slice(0, 42) + '/', good.slice(0, 42) + '+', nonCanonical, Buffer.from(good)]) {
    t.absent(isAppProof(v), 'refused: ' + String(v).slice(0, 50))
  }
})

test('proofOf: base64url(sha256(the bytes of V)), null for a malformed V', (t) => {
  const v = secret()
  const expected = nodeCrypto.createHash('sha256').update(Buffer.from(v, 'base64url')).digest('base64url')
  t.is(proofOf(v), expected)
  t.ok(TOKEN_RE.test(proofOf(v)))
  t.is(proofOf(v), proofOf(v), 'deterministic')
  t.not(proofOf(v), proofOf(secret()))
  for (const bad of [undefined, null, '', 'abc', v + 'A', v.slice(0, 42), 'a'.repeat(44)]) t.is(proofOf(bad), null)
})

test('safeEqual: equal strings only, never throws on length or type', (t) => {
  const a = proofOf(secret())
  t.ok(safeEqual(a, a))
  t.ok(safeEqual(a, String(a)))
  t.absent(safeEqual(a, proofOf(secret())))
  t.absent(safeEqual(a, a.slice(0, 42)))
  t.absent(safeEqual(a, null))
  t.absent(safeEqual(undefined, undefined))
  t.absent(safeEqual('', 'x'))
})

test('mintRedeem / redeemMatches: a fresh token shape, only its hash matches', (t) => {
  const r = mintRedeem()
  t.ok(TOKEN_RE.test(r.code))
  t.ok(TOKEN_RE.test(r.hash))
  t.not(r.code, r.hash, 'only a hash is kept')
  t.ok(redeemMatches(r.code, r.hash))
  t.absent(redeemMatches(mintRedeem().code, r.hash))
  t.absent(redeemMatches(r.hash, r.hash), 'the stored hash is not a code')
  t.absent(redeemMatches(undefined, r.hash))
  t.absent(redeemMatches(r.code, null))
  t.absent(redeemMatches(r.code.slice(0, 42), r.hash))
  t.not(mintRedeem().code, r.code)
})

test('accountReturnUrl: the fixed varanda://conta return, a code only on ok', (t) => {
  t.alike(OUTCOMES, ['ok', 'erro', 'cancelado', 'lista-de-espera', 'convite-invalido'])
  const { code } = mintRedeem()
  t.is(accountReturnUrl('ok', code), 'varanda://conta?conta=ok&codigo=' + code)
  t.is(accountReturnUrl('ok'), 'varanda://conta?conta=ok')
  t.is(accountReturnUrl('ok', 'x&y=1'), 'varanda://conta?conta=ok', 'a malformed code is dropped')
  for (const o of ['erro', 'cancelado', 'lista-de-espera', 'convite-invalido']) {
    t.is(accountReturnUrl(o, code), 'varanda://conta?conta=' + o, o + ' carries no code')
  }
  for (const o of [undefined, '', 'OK', 'ok&codigo=x', 'https://evil.test', 'indisponivel']) {
    t.is(accountReturnUrl(o, code), 'varanda://conta?conta=erro', 'unknown outcome: ' + o)
  }
})

test('ageReturnUrl: fixed, no secret', (t) => {
  t.is(ageReturnUrl(), 'varanda://idade?volta=1')
})

test('header: a string header or null', (t) => {
  t.is(header({ headers: { 'x-varanda-link': 'v' } }, 'x-varanda-link'), 'v')
  t.is(header({ headers: {} }, 'x-varanda-link'), null)
  t.is(header({ headers: { 'x-varanda-link': ['a', 'b'] } }, 'x-varanda-link'), null)
})
