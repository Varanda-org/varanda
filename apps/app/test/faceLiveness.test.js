'use strict'

// modules/face-liveness/index.js (the JS side of the AWS Face Liveness
// module) with expo-modules-core replaced by a stub whose native module the
// tests swap through globalThis.__livenessNative. Setting it to null makes
// requireNativeModule throw, as on a build without the module.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const expoCore = `
export function requireNativeModule (name) {
  if (name !== 'FaceLiveness' || globalThis.__livenessNative === null) throw new Error('unknown module')
  return {
    isAvailable: () => globalThis.__livenessNative.isAvailable(),
    start: (input) => globalThis.__livenessNative.start(input),
    cancel: (...args) => globalThis.__livenessNative.cancel(...args)
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

const MODULE = path.join(__dirname, '..', 'modules', 'face-liveness', 'index.js')
const SESSION = 'f3c1d2e4-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const ACCESS = 'ASIAFAKEACCESSKEY123'
const SECRET = 'fake/secret+key/value-456'
const TOKEN = 'fake-session-token-789'
const EXPIRES = new Date('2030-01-01T00:00:00Z')
const SECRETS = [SESSION, ACCESS, SECRET, TOKEN]

function input (over = {}, credOver = {}) {
  return {
    sessionId: SESSION,
    region: 'us-east-1',
    credentials: {
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      sessionToken: TOKEN,
      expiration: EXPIRES,
      ...credOver
    },
    ...over
  }
}

function fake ({ available = true, error, answer = null } = {}) {
  const calls = []
  globalThis.__livenessNative = {
    isAvailable () {
      if (available instanceof Error) throw available
      return available
    },
    async start (arg) {
      calls.push(arg)
      if (error) throw error
      return answer
    }
  }
  return calls
}

// Each load gets a fresh module instance, so the try/catch around
// requireNativeModule runs again under the current fake.
let n = 0
const load = () => import(pathToFileURL(MODULE).href + '?v=' + (n++))

function leaks (err) {
  const text = String(err.message) + '\n' + String(err.stack)
  return SECRETS.some((s) => text.includes(s)) || text.includes('native detail')
}

test('face liveness: isAvailable never throws', async (t) => {
  globalThis.__livenessNative = null
  t.is((await load()).isAvailable(), false)

  fake({ available: new Error('boom') })
  const mod = await load()
  t.is(mod.isAvailable(), false)
  fake({ available: false })
  t.is(mod.isAvailable(), false)
  fake({ available: 'yes' })
  t.is(mod.isAvailable(), false)
  fake({ available: true })
  t.is(mod.isAvailable(), true)
})

test('face liveness: CODES is the frozen contract list', async (t) => {
  const { CODES } = await load()
  t.alike([...CODES], ['INVALID', 'CANCELLED', 'CAMERA_DENIED', 'SESSION_EXPIRED', 'UNSUPPORTED', 'BUSY', 'FAILED'])
  t.ok(Object.isFrozen(CODES))
})

test('face liveness: invalid input rejects INVALID before any native call', async (t) => {
  const calls = fake()
  const { start } = await load()
  const bad = [
    undefined,
    null,
    'x',
    input({ sessionId: '' }),
    input({ sessionId: '..' }),
    input({ sessionId: 'a/b' }),
    input({ sessionId: 'a'.repeat(129) }),
    input({ sessionId: 42 }),
    input({ region: 'eu-central-1' }),
    input({ region: '' }),
    input({ region: null }),
    input({ credentials: null }),
    input({ credentials: 'creds' }),
    input({}, { accessKeyId: '' }),
    input({}, { accessKeyId: 1 }),
    input({}, { secretAccessKey: '' }),
    input({}, { secretAccessKey: undefined }),
    input({}, { sessionToken: '' }),
    input({}, { sessionToken: {} }),
    input({}, { expiration: undefined }),
    input({}, { expiration: EXPIRES.getTime() }),
    input({}, { expiration: EXPIRES.toISOString() }),
    input({}, { expiration: new Date('nope') })
  ]
  for (const arg of bad) {
    try {
      await start(arg)
      t.fail('should reject')
    } catch (err) {
      t.is(err.code, 'INVALID')
      t.absent(leaks(err))
    }
  }
  t.is(calls.length, 0)
})

test('face liveness: absent or unavailable module rejects UNSUPPORTED', async (t) => {
  globalThis.__livenessNative = null
  const absent = await load()
  try {
    await absent.start(input())
    t.fail('should reject')
  } catch (err) {
    t.is(err.code, 'UNSUPPORTED')
    t.absent(leaks(err))
  }

  const calls = fake({ available: false })
  const mod = await load()
  try {
    await mod.start(input())
    t.fail('should reject')
  } catch (err) {
    t.is(err.code, 'UNSUPPORTED')
  }
  t.is(calls.length, 0)
})

test('face liveness: success passes a plain object with epoch expiration', async (t) => {
  const calls = fake({ answer: { anything: true } })
  const { start } = await load()
  t.alike(await start(input({ extra: 'dropped' }, { extra: 'dropped' })), { ok: true })
  t.alike(calls, [{
    sessionId: SESSION,
    region: 'us-east-1',
    credentials: {
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      sessionToken: TOKEN,
      expiration: EXPIRES.getTime()
    }
  }])
  t.is(typeof calls[0].credentials.expiration, 'number')
})

test('face liveness: native codes are normalised, unknown becomes FAILED', async (t) => {
  const { start } = await load()
  const cases = [
    ['CANCELLED', 'CANCELLED'],
    ['CAMERA_DENIED', 'CAMERA_DENIED'],
    ['SESSION_EXPIRED', 'SESSION_EXPIRED'],
    ['BUSY', 'BUSY'],
    ['INVALID', 'INVALID'],
    ['UNSUPPORTED', 'UNSUPPORTED'],
    ['FAILED', 'FAILED'],
    ['ERR_SOMETHING', 'FAILED'],
    ['cancelled', 'FAILED'],
    [undefined, 'FAILED']
  ]
  for (const [nativeCode, code] of cases) {
    const detail = 'native detail ' + SESSION + ' ' + ACCESS + ' ' + SECRET + ' ' + TOKEN
    fake({ error: Object.assign(new Error(detail), { code: nativeCode }) })
    try {
      await start(input())
      t.fail('should reject')
    } catch (err) {
      t.is(err.code, code)
      t.absent(leaks(err))
      t.absent('cause' in err)
    }
  }
  fake({ error: 'a string' })
  try {
    await start(input())
    t.fail('should reject')
  } catch (err) {
    t.is(err.code, 'FAILED')
  }
})

test('face liveness: cancel calls native cancel once, with no arguments', async (t) => {
  const calls = fake()
  const cancels = []
  globalThis.__livenessNative.cancel = (...args) => { cancels.push(args) }
  const { cancel } = await load()
  t.is(cancel(), undefined)
  t.alike(cancels, [[]], 'one call, no arguments')
  t.is(calls.length, 0, 'never starts')
})

test('face liveness: cancel is a no-op that never throws', async (t) => {
  globalThis.__livenessNative = null
  const absent = await load()
  t.execution(() => absent.cancel(), 'absent module')

  fake()
  globalThis.__livenessNative.cancel = () => { throw new Error('native detail') }
  const throwing = await load()
  t.execution(() => throwing.cancel(), 'throwing native cancel')

  fake()
  delete globalThis.__livenessNative.cancel
  const missing = await load()
  t.execution(() => missing.cancel(), 'native module without cancel')
})

test('face liveness: the module and this test never call console', (t) => {
  for (const file of [MODULE, __filename]) {
    t.absent(/\bconsole\s*\./.test(fs.readFileSync(file, 'utf8')), path.basename(file))
  }
})
