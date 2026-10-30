'use strict'

// modules/auth-session/index.js (the JS side of the Auth Tab /
// ASWebAuthenticationSession module) with expo-modules-core replaced by a
// stub whose native module the tests swap through globalThis.__authNative.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const expoCore = `
export function requireNativeModule (name) {
  if (name !== 'AuthSession') throw new Error('unknown module')
  return {
    isAvailable: () => globalThis.__authNative.isAvailable(),
    open: (url, host, path) => globalThis.__authNative.open(url, host, path)
  }
}
`
const hooks = `
const stubs = {
  'expo-modules-core': 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(expoCore)})
}
export async function resolve (specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const URL_OK = 'https://varanda.example/account/google?state=abc'
const HOST = 'varanda.example'
const PATH = '/account/app/conta'

function fake ({ available = true, answer, error } = {}) {
  const calls = []
  globalThis.__authNative = {
    isAvailable () {
      if (available instanceof Error) throw available
      return available
    },
    async open (...args) {
      calls.push(args)
      if (error) throw error
      return answer
    }
  }
  return calls
}

const load = () => import('../modules/auth-session/index.js')

test('auth session: isAvailable never throws', async (t) => {
  const { isAvailable } = await load()
  fake({ available: true })
  t.is(isAvailable(), true)
  fake({ available: 'yes' })
  t.is(isAvailable(), false)
  fake({ available: new Error('boom') })
  t.is(isAvailable(), false)
})

test('auth session: invalid arguments reject INVALID before native', async (t) => {
  const { open } = await load()
  const calls = fake({ answer: { type: 'cancel' } })
  const bad = [
    ['http://varanda.example/x', HOST, PATH],
    ['https://', HOST, PATH],
    [42, HOST, PATH],
    [URL_OK, '', PATH],
    [URL_OK, 'varanda.example/x', PATH],
    [URL_OK, 'varanda.example:443', PATH],
    [URL_OK, 'varanda example', PATH],
    [URL_OK, HOST, 'account/app/conta'],
    [URL_OK, HOST, '/account/app/conta?x=1'],
    [URL_OK, HOST, '/account/app/conta#x'],
    [URL_OK, HOST, null]
  ]
  for (const args of bad) {
    await t.exception(() => open(...args), /inválido/)
    try { await open(...args) } catch (err) { t.is(err.code, 'INVALID') }
  }
  t.is(calls.length, 0)
})

test('auth session: unavailable rejects UNSUPPORTED', async (t) => {
  const { open } = await load()
  const calls = fake({ available: false })
  try {
    await open(URL_OK, HOST, PATH)
    t.fail('should reject')
  } catch (err) {
    t.is(err.code, 'UNSUPPORTED')
  }
  t.is(calls.length, 0)
})

test('auth session: native answers are normalized to the contract shapes', async (t) => {
  const { open } = await load()
  const cases = [
    [{ type: 'ok', url: 'https://varanda.example/account/app/conta?conta=ok', extra: 1 }, { type: 'ok', url: 'https://varanda.example/account/app/conta?conta=ok' }],
    [{ type: 'ok', url: 'varanda://conta?conta=ok' }, { type: 'failed', reason: 'unknown' }],
    [{ type: 'ok' }, { type: 'failed', reason: 'unknown' }],
    [{ type: 'cancel', url: 'x' }, { type: 'cancel' }],
    [{ type: 'failed', reason: 'verification' }, { type: 'failed', reason: 'verification' }],
    [{ type: 'failed', reason: 'timeout' }, { type: 'failed', reason: 'timeout' }],
    [{ type: 'failed', reason: 'other' }, { type: 'failed', reason: 'unknown' }],
    [null, { type: 'failed', reason: 'unknown' }],
    ['ok', { type: 'failed', reason: 'unknown' }],
    [{ type: 'weird' }, { type: 'failed', reason: 'unknown' }]
  ]
  for (const [answer, expected] of cases) {
    const calls = fake({ answer })
    t.alike(await open(URL_OK, HOST, PATH), expected)
    t.alike(calls, [[URL_OK, HOST, PATH]])
  }
})

test('auth session: native errors keep only BUSY or INVALID, with generic text', async (t) => {
  const { open } = await load()
  const cases = [
    [Object.assign(new Error('native detail'), { code: 'BUSY' }), 'BUSY'],
    [Object.assign(new Error('native detail'), { code: 'INVALID' }), 'INVALID'],
    [Object.assign(new Error('native detail'), { code: 'ERR_SOMETHING' }), 'UNSUPPORTED'],
    [new Error('native detail'), 'UNSUPPORTED']
  ]
  for (const [error, code] of cases) {
    fake({ error })
    try {
      await open(URL_OK, HOST, PATH)
      t.fail('should reject')
    } catch (err) {
      t.is(err.code, code)
      t.absent(err.message.includes('native detail'))
    }
  }
})
