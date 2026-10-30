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
  APP_RETURN_PATH,
  accountReturnUrl,
  appReturnPage,
  ageReturnUrl,
  header
} = require('../lib/account/app-return')

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

// The same 32 bytes spelled with stray low bits in the last character.
function nonCanonical (token) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const i = alphabet.indexOf(token[42])
  return token.slice(0, 42) + alphabet[(i & ~3) | ((i & 3) ^ 1)]
}

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

test('accountReturnUrl: the fixed https app return, a code only on ok', (t) => {
  t.alike(OUTCOMES, ['ok', 'erro', 'cancelado', 'lista-de-espera', 'convite-invalido'])
  t.is(APP_RETURN_PATH, '/account/app/conta')
  const origin = 'https://varanda.example'
  const base = origin + '/account/app/conta?conta='
  const { code } = mintRedeem()
  t.is(accountReturnUrl(origin, 'ok', code), base + 'ok&codigo=' + code)
  t.is(accountReturnUrl(origin, 'ok'), base + 'ok')
  t.is(accountReturnUrl(origin, 'ok', 'x&y=1'), base + 'ok', 'a malformed code is dropped')
  t.is(accountReturnUrl(origin, 'ok', nonCanonical(code)), base + 'ok', 'a non-canonical code is dropped')
  for (const o of ['erro', 'cancelado', 'lista-de-espera', 'convite-invalido']) {
    t.is(accountReturnUrl(origin, o, code), base + o, o + ' carries no code')
  }
  for (const o of [undefined, '', 'OK', 'ok&codigo=x', 'https://evil.test', 'indisponivel']) {
    t.is(accountReturnUrl(origin, o, code), base + 'erro', 'unknown outcome: ' + o)
  }
})

test('appReturnPage: a static page, no link, no code, no script', (t) => {
  const html = appReturnPage()
  t.is(appReturnPage(), html, 'the same page every time')
  t.ok(html.includes('<title>Varanda</title>'))
  t.ok(html.includes('Volte ao app Varanda'))
  t.ok(html.includes('Este endereço só funciona dentro do app Varanda.'))
  t.ok(html.includes('mesma passkey'), 'points to linking on the site')
  t.absent(/<script/i.test(html), 'no script')
  t.absent(html.includes('intent:'), 'no intent')
  t.absent(html.includes('codigo'), 'no code parameter')
  t.absent(/<a\b/i.test(html), 'no link at all')
})

test('ageReturnUrl: fixed, no secret', (t) => {
  t.is(ageReturnUrl(), 'varanda://idade?volta=1')
})

test('header: a string header or null', (t) => {
  t.is(header({ headers: { 'x-varanda-link': 'v' } }, 'x-varanda-link'), 'v')
  t.is(header({ headers: {} }, 'x-varanda-link'), null)
  t.is(header({ headers: { 'x-varanda-link': ['a', 'b'] } }, 'x-varanda-link'), null)
})
