'use strict'

// The varanda:// URLs the native app is opened with (src/linkReturn.js).
const test = require('brittle')
const crypto = require('node:crypto')

const load = () => import('../src/linkReturn.js')
const R = crypto.randomBytes(32).toString('base64url')
const CODE = 'aB3_-'.repeat(8) + 'xyz'
const KEY = 'ab'.repeat(32)

async function withOrigin (t, origin) {
  const { setInstallation } = await import('../src/installation.js')
  t.ok(setInstallation(origin))
  t.teardown(() => setInstallation(null))
}

test('parseAppReturn: the fixed account returns', async (t) => {
  const { parseAppReturn } = await load()
  t.alike(parseAppReturn('varanda://conta?conta=ok&codigo=' + R), { kind: 'conta', outcome: 'ok', code: R })
  for (const outcome of ['erro', 'cancelado', 'lista-de-espera', 'convite-invalido']) {
    t.alike(parseAppReturn('varanda://conta?conta=' + outcome), { kind: 'conta', outcome }, outcome)
  }
  t.alike(parseAppReturn('varanda://conta?conta=ok'), { kind: 'conta', outcome: 'ok' }, 'ok without a code')
  t.alike(parseAppReturn('varanda://conta?x=1&conta=erro&y'), { kind: 'conta', outcome: 'erro' }, 'other params ignored')
  t.alike(parseAppReturn('varanda://conta?conta=ok&codigo=' + R + '#frag'), { kind: 'conta', outcome: 'ok', code: R })
})

test('parseAppReturn: the code only with ok and only in the minted shape', async (t) => {
  const { parseAppReturn } = await load()
  for (const outcome of ['erro', 'cancelado', 'lista-de-espera', 'convite-invalido']) {
    t.alike(parseAppReturn('varanda://conta?conta=' + outcome + '&codigo=' + R), { kind: 'conta', outcome }, outcome)
  }
  const nonCanonical = R.slice(0, 42) + 'B'
  for (const bad of [R.slice(1), R + 'A', nonCanonical, R.slice(0, 42) + '%', '']) {
    t.alike(parseAppReturn('varanda://conta?conta=ok&codigo=' + bad), { kind: 'conta', outcome: 'ok' }, bad)
  }
  t.is(parseAppReturn('varanda://conta?conta=ok&codigo=' + R + '&codigo=' + R), null, 'repeated codigo')
  t.is(parseAppReturn('varanda://conta?conta=ok&conta=erro'), null, 'repeated conta')
})

test('parseAppReturn: the age return', async (t) => {
  const { parseAppReturn } = await load()
  t.alike(parseAppReturn('varanda://idade?volta=1'), { kind: 'idade' })
  t.alike(parseAppReturn('varanda://idade?status=x&volta=1'), { kind: 'idade' })
  for (const bad of ['varanda://idade?volta=0', 'varanda://idade?', 'varanda://idade', 'varanda://idade?volta=1&volta=1']) {
    t.is(parseAppReturn(bad), null, bad)
  }
})

test('parseAppReturn: strict on scheme and host', async (t) => {
  const { parseAppReturn } = await load()
  for (const bad of [
    'varanda://conta', 'varanda://conta/?conta=ok', 'varanda:///conta?conta=ok', 'Varanda://conta?conta=ok',
    'varanda://CONTA?conta=ok', 'varanda://conta.evil?conta=ok', 'https://conta?conta=ok', 'evil://conta?conta=ok',
    'varanda://conta?conta=talvez', 'varanda://conta?conta=OK', 'varanda://conta?conta=ok\n', ' varanda://conta?conta=ok',
    'varanda://conta?conta=ok&codigo=' + 'A'.repeat(400), 'varanda://x?conta=ok', null, 5, undefined
  ]) {
    t.is(parseAppReturn(bad), null, String(bad))
  }
})

test('parseAppLink: empty-host varanda paths', async (t) => {
  const { parseAppLink } = await load()
  t.alike(parseAppLink('varanda:///convite/' + CODE), { kind: 'convite', code: CODE })
  t.alike(parseAppLink('varanda:///@Ana_01'), { kind: 'perfil', username: 'ana_01' })
  t.alike(parseAppLink('varanda:///m/' + KEY.toUpperCase()), { kind: 'perfil', key: KEY })
  t.alike(parseAppLink('varanda:///convite/' + CODE + '?x=1'), { kind: 'convite', code: CODE })
})

test('parseAppLink: rejects host forms and malformed links', async (t) => {
  const { parseAppLink } = await load()
  for (const bad of [
    'varanda://convite/' + CODE, 'varanda://@ana', 'varanda://m/' + KEY, 'varanda:////convite/' + CODE,
    'varanda:///convite/' + CODE.slice(1), 'varanda:///convite/' + CODE + '/x', 'varanda:///@an',
    'varanda:///@ana%2F', 'varanda:///m/' + KEY.slice(1), 'varanda:///', 'varanda:///conta?conta=ok',
    'https://example.test/convite/' + CODE, 'varanda:///@ana\\x', null, ''
  ]) {
    t.is(parseAppLink(bad), null, String(bad))
  }
})

test('parseAppLink: https only on the installation origin', async (t) => {
  const { parseAppLink } = await load()
  await withOrigin(t, 'https://varanda.example')
  t.alike(parseAppLink('https://varanda.example/convite/' + CODE), { kind: 'convite', code: CODE })
  t.alike(parseAppLink('https://varanda.example/@ana'), { kind: 'perfil', username: 'ana' })
  t.alike(parseAppLink('https://varanda.example/m/' + KEY + '#x'), { kind: 'perfil', key: KEY })
  for (const bad of [
    'https://varanda.example.evil/convite/' + CODE, 'https://evil.example/convite/' + CODE,
    'http://varanda.example/convite/' + CODE, 'https://varanda.example@evil.example/convite/' + CODE,
    'https://evil.example/https://varanda.example/convite/' + CODE, 'https://varanda.example//evil.example/@ana',
    'https://VARANDA.example/@ana', 'https://varanda.example:8443/@ana'
  ]) {
    t.is(parseAppLink(bad), null, bad)
  }
})

test('parseAppLink: no https link while the installation is a loopback http one', async (t) => {
  const { parseAppLink } = await load()
  await withOrigin(t, 'http://127.0.0.1:8790')
  t.is(parseAppLink('http://127.0.0.1:8790/convite/' + CODE), null)
})

test('parseInviteInput: bare code or a full invite link', async (t) => {
  const { parseInviteInput } = await load()
  await withOrigin(t, 'https://varanda.example')
  t.is(parseInviteInput('  ' + CODE + '\n'), CODE)
  t.is(parseInviteInput('https://varanda.example/convite/' + CODE), CODE)
  t.is(parseInviteInput(' varanda:///convite/' + CODE + ' '), CODE)
  for (const bad of ['https://evil.example/convite/' + CODE, CODE.slice(2), 'https://varanda.example/@ana', '', null]) {
    t.is(parseInviteInput(bad), null, String(bad))
  }
})
