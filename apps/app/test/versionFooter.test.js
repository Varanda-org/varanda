// The Ajustes version footer: the running web release, and the footer wiring,
// read as text because Ajustes.js pulls in react-native.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const AJUSTES = path.join(SRC, 'screens', 'Ajustes.js')

// Same as platformGate.test.js.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

function sources (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(file))
    else if (entry.name.endsWith('.js')) out.push(file)
  }
  return out
}

async function withDocument (doc, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document')
  const before = globalThis.document
  globalThis.document = doc
  try {
    return await fn()
  } finally {
    if (had) globalThis.document = before
    else delete globalThis.document
  }
}

test('runningRelease (web) reads the varanda-release meta', async (t) => {
  const { runningRelease } = await import('../src/runningRelease.web.js')
  const asked = []
  const meta = { getAttribute: (name) => (name === 'content' ? '0123456789abcdef' : null) }
  await withDocument({ querySelector: (q) => { asked.push(q); return meta } }, () => {
    t.is(runningRelease(), '0123456789abcdef', 'meta content')
  })
  t.alike(asked, ['meta[name="varanda-release"]'], 'same selector as pwa.web.js')
  await withDocument({ querySelector: () => null }, () => {
    t.is(runningRelease(), null, 'no meta')
  })
  await withDocument({ querySelector: () => { throw new Error('boom') } }, () => {
    t.is(runningRelease(), null, 'a throwing document')
  })
  t.absent(Object.prototype.hasOwnProperty.call(globalThis, 'document'), 'stub removed')
})

test('runningRelease (native) is null', async (t) => {
  const { runningRelease } = await import('../src/runningRelease.native.js')
  t.is(runningRelease(), null)
})

test('Ajustes wires the footer to the version formatters', (t) => {
  const src = withoutComments(fs.readFileSync(AJUSTES, 'utf8'))
  t.ok(src.includes('process.env.EXPO_PUBLIC_VARANDA_COMMIT'), 'commit member expression for Metro')
  t.ok(src.includes('process.env.EXPO_PUBLIC_VARANDA_BUILD_DATE'), 'build date member expression for Metro')
  t.ok(src.includes('copyText(shareNav()'), 'copies through the navigator helper')
  t.ok(src.includes('fetchDeployedCommit('), 'asks the installation')
  // A screen reader hears the version lines themselves, then the action.
  const footer = src.indexOf("accessibilityHint='copia os detalhes da versão'")
  t.ok(footer !== -1, 'footer is a button with a hint')
  t.ok(src.includes('accessibilityLabel={[lines.appLine, lines.serverLine, versionNote]'), 'its label reads the visible lines')
  const reset = src.indexOf('Apagar e recomeçar')
  t.ok(reset !== -1 && footer > reset, 'footer after the Recomeçar confirmation')
  t.absent(src.includes('expo-clipboard'), 'no expo-clipboard')
  t.absent(fs.readFileSync(AJUSTES, 'utf8').includes('\u2014'), 'no em dash')
})

test('only Ajustes reads the build commit', (t) => {
  const readers = sources(SRC)
    .filter((file) => fs.readFileSync(file, 'utf8').includes('EXPO_PUBLIC_VARANDA_COMMIT'))
    .map((file) => path.relative(SRC, file))
  t.alike(readers, [path.join('screens', 'Ajustes.js')])
})
