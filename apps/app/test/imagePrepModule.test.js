'use strict'

// modules/image-prep/index.js (the JS side of the native AVIF encode) with
// expo-modules-core replaced by a stub whose native module the tests swap
// through globalThis.__imageNative. globalThis.__imageMissing makes the stub
// throw as on Android and web, where the module does not exist.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const expoCore = `
export function requireNativeModule (name) {
  if (name !== 'ImagePrep' || globalThis.__imageMissing) throw new Error('unknown module')
  return {
    canEncodeAvif: () => globalThis.__imageNative.canEncodeAvif(),
    encodeAvif: (...args) => globalThis.__imageNative.encodeAvif(...args)
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

const SOURCE = 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/ImagePicker/photo.heic'
const OPTS = { maxSide: 2048, quality: 0.7 }
const OK = {
  uri: 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/image-prep/a.avif',
  width: 2048,
  height: 1536
}

// Read with hasOwn so a case can pass undefined itself.
function fake (opts = {}) {
  const supported = Object.hasOwn(opts, 'supported') ? opts.supported : true
  const answer = Object.hasOwn(opts, 'answer') ? opts.answer : OK
  const error = opts.error
  const calls = { probe: 0, encode: [] }
  globalThis.__imageNative = {
    async canEncodeAvif () {
      calls.probe++
      if (supported instanceof Error) throw supported
      return supported
    },
    async encodeAvif (...args) {
      calls.encode.push(args)
      if (Object.hasOwn(opts, 'error')) throw error
      return answer
    }
  }
  return calls
}

const load = () => import('../modules/image-prep/index.js')

test('image prep: canEncodeAvif is true only for a true probe and never throws', async (t) => {
  const { canEncodeAvif } = await load()
  fake({ supported: true })
  t.is(await canEncodeAvif(), true)
  for (const supported of [false, 'yes', 1, null, undefined, new Error('boom')]) {
    fake({ supported })
    t.is(await canEncodeAvif(), false)
  }
})

test('image prep: native gets the uri, maxSide and quality', async (t) => {
  const { encodeAvif } = await load()
  const calls = fake()
  t.alike(await encodeAvif(SOURCE, { ...OPTS, extra: 'dropped' }), OK)
  t.alike(calls.encode, [[SOURCE, 2048, 0.7]])
  const edges = fake({ answer: { uri: OK.uri, width: 16, height: 16 } })
  t.alike(await encodeAvif(SOURCE, { maxSide: 16, quality: 1 }), { uri: OK.uri, width: 16, height: 16 })
  await encodeAvif(SOURCE, { maxSide: 4096, quality: 0.01 })
  t.alike(edges.encode, [[SOURCE, 16, 1], [SOURCE, 4096, 0.01]])
})

test('image prep: invalid arguments resolve null before native', async (t) => {
  const { encodeAvif } = await load()
  const calls = fake()
  const bad = [
    [42, OPTS],
    ['', OPTS],
    ['file://', OPTS],
    ['https://varanda.example/photo.jpg', OPTS],
    ['content://media/external/images/media/7', OPTS],
    ['/var/mobile/photo.heic', OPTS],
    ['FILE:///var/mobile/photo.heic', OPTS],
    ['file:///' + 'a'.repeat(4088), OPTS],
    [SOURCE],
    [SOURCE, null],
    [SOURCE, 'opts'],
    [SOURCE, { quality: 0.7 }],
    [SOURCE, { ...OPTS, maxSide: 2 }],
    [SOURCE, { ...OPTS, maxSide: 15 }],
    [SOURCE, { ...OPTS, maxSide: 4097 }],
    [SOURCE, { ...OPTS, maxSide: 16384 }],
    [SOURCE, { ...OPTS, maxSide: 1024.5 }],
    [SOURCE, { ...OPTS, maxSide: '2048' }],
    [SOURCE, { ...OPTS, maxSide: Infinity }],
    [SOURCE, { maxSide: 2048 }],
    [SOURCE, { ...OPTS, quality: 0 }],
    [SOURCE, { ...OPTS, quality: -0.5 }],
    [SOURCE, { ...OPTS, quality: 1.01 }],
    [SOURCE, { ...OPTS, quality: NaN }],
    [SOURCE, { ...OPTS, quality: Infinity }],
    [SOURCE, { ...OPTS, quality: '0.7' }]
  ]
  for (const args of bad) t.is(await encodeAvif(...args), null)
  t.is(calls.encode.length, 0)
  t.is(calls.probe, 0, 'not even the probe runs')
  const longest = 'file:///' + 'a'.repeat(4087)
  t.is(longest.length, 4095)
  t.alike(await encodeAvif(longest, OPTS), OK, 'a uri just under 4096 chars is accepted')
})

test('image prep: a failed probe resolves null before encoding', async (t) => {
  const { encodeAvif } = await load()
  for (const supported of [false, new Error('boom')]) {
    const calls = fake({ supported })
    t.is(await encodeAvif(SOURCE, OPTS), null)
    t.is(calls.probe, 1)
    t.is(calls.encode.length, 0)
  }
})

test('image prep: a native throw resolves null', async (t) => {
  const { encodeAvif } = await load()
  for (const error of [new Error('native detail /var/x'), Object.assign(new Error('x'), { code: 'ERR' }), 'native detail', null]) {
    fake({ error })
    t.is(await encodeAvif(SOURCE, OPTS), null)
  }
})

test('image prep: a malformed native answer resolves null', async (t) => {
  const { encodeAvif } = await load()
  const bad = [
    null,
    undefined,
    'ok',
    {},
    { ...OK, uri: undefined },
    { ...OK, uri: '/var/x.avif' },
    { ...OK, uri: 'file://' },
    { ...OK, uri: 'https://varanda.example/a.avif' },
    { ...OK, uri: OK.uri.replace('.avif', '.jpg') },
    { ...OK, uri: OK.uri + '.tmp' },
    { ...OK, width: 0 },
    { ...OK, width: -2 },
    { ...OK, width: 2047 },
    { ...OK, width: 14 },
    { ...OK, height: 2 },
    { ...OK, height: 1536.5 },
    { ...OK, height: '1536' },
    { ...OK, width: NaN },
    { ...OK, width: 2050 },
    { ...OK, height: 4096 }
  ]
  for (const answer of bad) {
    fake({ answer })
    t.is(await encodeAvif(SOURCE, OPTS), null)
  }
})

test('image prep: an answer pointing at the source itself resolves null', async (t) => {
  const { encodeAvif } = await load()
  const picked = 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/ImagePicker/photo.avif'
  fake({ answer: { ...OK, uri: picked } })
  t.is(await encodeAvif(picked, OPTS), null, 'the caller would delete the original')
  t.alike(await encodeAvif(SOURCE, OPTS), { ...OK, uri: picked }, 'the same answer for another source passes')
})

test('image prep: the answer is cut to the contract fields', async (t) => {
  const { encodeAvif } = await load()
  fake({ answer: { ...OK, path: '/var/x.avif', bytes: 1234 } })
  t.alike(await encodeAvif(SOURCE, OPTS), OK)
})

// The query gives a fresh module instance, loaded while the stub throws.
test('image prep: without the native module everything is false or null', async (t) => {
  globalThis.__imageMissing = true
  let mod
  try {
    mod = await import('../modules/image-prep/index.js?missing')
  } finally {
    globalThis.__imageMissing = false
  }
  const calls = fake()
  t.is(await mod.canEncodeAvif(), false)
  t.is(await mod.encodeAvif(SOURCE, OPTS), null)
  t.is(calls.probe, 0)
  t.is(calls.encode.length, 0)
})
