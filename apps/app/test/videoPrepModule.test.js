'use strict'

// modules/video-prep/index.js (the JS side of the native video re-encode)
// with expo-modules-core replaced by a stub whose native module the tests
// swap through globalThis.__videoNative.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const expoCore = `
export function requireNativeModule (name) {
  if (name !== 'VideoPrep') throw new Error('unknown module')
  return {
    isAvailable: () => globalThis.__videoNative.isAvailable(),
    prepare: (uri, opts) => globalThis.__videoNative.prepare(uri, opts)
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

const SOURCE = 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/ImagePicker/clip.mov'
const CAPS = { maxMs: 30000, maxBytes: 8388608 }
const OK = {
  uri: 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/video-prep/a.mp4',
  posterUri: 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/video-prep/a.jpg',
  width: 540,
  height: 960,
  ms: 12345,
  bytes: 2100000
}

function fake ({ available = true, answer = OK, error } = {}) {
  const calls = []
  globalThis.__videoNative = {
    isAvailable () {
      if (available instanceof Error) throw available
      return available
    },
    async prepare (...args) {
      calls.push(args)
      if (error) throw error
      return answer
    }
  }
  return calls
}

async function rejection (t, promise) {
  try {
    await promise
    t.fail('should reject')
    return null
  } catch (err) {
    return err
  }
}

const load = () => import('../modules/video-prep/index.js')

test('video prep: isAvailable never throws', async (t) => {
  const { isAvailable } = await load()
  fake({ available: true })
  t.is(isAvailable(), true)
  fake({ available: 'yes' })
  t.is(isAvailable(), false)
  fake({ available: null })
  t.is(isAvailable(), false)
  fake({ available: new Error('boom') })
  t.is(isAvailable(), false)
})

test('video prep: native gets the caps with the 960 and 1.4 Mbit/s defaults', async (t) => {
  const { prepare } = await load()
  const calls = fake()
  t.alike(await prepare(SOURCE, CAPS), OK)
  t.alike(calls, [[SOURCE, { maxMs: 30000, maxBytes: 8388608, maxSide: 960, maxBitrate: 1400000 }]])

  const again = fake()
  await prepare(SOURCE, { maxMs: 15000, maxBytes: 4194304, maxSide: 720, maxBitrate: 1000000, extra: 'dropped' })
  t.alike(again, [[SOURCE, { maxMs: 15000, maxBytes: 4194304, maxSide: 720, maxBitrate: 1000000 }]])
})

test('video prep: invalid arguments reject INVALID before native', async (t) => {
  const { prepare } = await load()
  const calls = fake()
  const bad = [
    [42, CAPS],
    ['', CAPS],
    ['file://', CAPS],
    ['https://varanda.example/clip.mp4', CAPS],
    ['/var/mobile/clip.mov', CAPS],
    [SOURCE, null],
    [SOURCE, { maxBytes: 8388608 }],
    [SOURCE, { maxMs: 0, maxBytes: 8388608 }],
    [SOURCE, { maxMs: 30000, maxBytes: -1 }],
    [SOURCE, { maxMs: 1.5, maxBytes: 8388608 }],
    [SOURCE, { maxMs: '30000', maxBytes: 8388608 }],
    [SOURCE, { ...CAPS, maxSide: 0 }],
    [SOURCE, { ...CAPS, maxBitrate: Infinity }]
  ]
  for (const args of bad) {
    const err = await rejection(t, prepare(...args))
    t.is(err.code, 'INVALID')
  }
  t.is(calls.length, 0)
  t.alike(await prepare('content://media/external/video/media/7', CAPS), OK, 'an Android content uri is accepted')
})

test('video prep: unavailable rejects UNSUPPORTED before native', async (t) => {
  const { prepare } = await load()
  for (const available of [false, new Error('boom')]) {
    const calls = fake({ available })
    const err = await rejection(t, prepare(SOURCE, CAPS))
    t.is(err.code, 'UNSUPPORTED')
    t.is(calls.length, 0)
  }
})

test('video prep: TOO_LONG from native is surfaced as is', async (t) => {
  const { prepare } = await load()
  fake({ error: Object.assign(new Error('duration 61.2 s at /private/var/x.mov'), { code: 'TOO_LONG' }) })
  const err = await rejection(t, prepare(SOURCE, CAPS))
  t.is(err.code, 'TOO_LONG')
  t.absent(err.message.includes('61.2'), 'no native text')
  t.absent(err.message.includes('/private'), 'no path')
})

test('video prep: native errors keep only known codes, with generic text', async (t) => {
  const { prepare } = await load()
  const cases = [
    [Object.assign(new Error('native detail /var/x'), { code: 'BUSY' }), 'BUSY'],
    [Object.assign(new Error('native detail /var/x'), { code: 'INVALID' }), 'INVALID'],
    [Object.assign(new Error('native detail /var/x'), { code: 'UNSUPPORTED' }), 'UNSUPPORTED'],
    [Object.assign(new Error('native detail /var/x'), { code: 'FAILED' }), 'FAILED'],
    [Object.assign(new Error('native detail /var/x'), { code: 'ERR_SOMETHING' }), 'FAILED'],
    [new Error('native detail /var/x'), 'FAILED'],
    ['native detail /var/x', 'FAILED'],
    [null, 'FAILED']
  ]
  for (const [error, code] of cases) {
    globalThis.__videoNative = {
      isAvailable: () => true,
      prepare: async () => { throw error }
    }
    const err = await rejection(t, prepare(SOURCE, CAPS))
    t.is(err.code, code)
    t.absent(err.message.includes('native detail'))
    t.absent(err.message.includes('/var/x'))
  }
})

test('video prep: a malformed native answer rejects FAILED', async (t) => {
  const { prepare } = await load()
  const bad = [
    null,
    'ok',
    {},
    { ...OK, uri: undefined },
    { ...OK, uri: '/var/x.mp4' },
    { ...OK, uri: 'content://x' },
    { ...OK, posterUri: 'https://varanda.example/p.jpg' },
    { ...OK, posterUri: OK.uri },
    { ...OK, width: 0 },
    { ...OK, height: 540.5 },
    { ...OK, ms: '12345' },
    { ...OK, bytes: -1 },
    { ...OK, bytes: NaN }
  ]
  for (const answer of bad) {
    fake({ answer })
    const err = await rejection(t, prepare(SOURCE, CAPS))
    t.is(err.code, 'FAILED')
  }
})

test('video prep: the answer is cut to the contract fields', async (t) => {
  const { prepare } = await load()
  fake({ answer: { ...OK, path: '/var/x.mp4', codec: 'avc1' } })
  t.alike(await prepare(SOURCE, CAPS), OK)
})
