// The Vitrine's fixtures stand in for the node only in a development bundle
// with the opt-in env var: the provider, the account calls and the terms
// stores, push hook and index client are the only way in, all behind vitrineEnabled.
'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const SRC = path.join(APP, 'src')
const VITRINE_DIR = path.join(SRC, 'vitrine')
const ALLOWED = ['src/node.js', 'src/account.js', 'src/termsStore.web.js', 'src/termsStore.native.js', 'src/usePush.web.js', 'src/indexClient.js']
const TERMS_STORES = ['src/termsStore.web.js', 'src/termsStore.native.js']
const IMPORT_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])([^'"]*vitrine\/[^'"]*)\1/g
const GUARD_RE = /const VITRINE = vitrineEnabled\(\{ EXPO_PUBLIC_VARANDA_VITRINE: process\.env\.EXPO_PUBLIC_VARANDA_VITRINE \}, typeof __DEV__ !== 'undefined' && __DEV__\)/

function sources (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(file))
    else if (entry.name.endsWith('.js')) out.push(file)
  }
  return out
}

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// Same length, string contents blanked: braces inside strings never count.
function withoutStrings (src) {
  return src.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0])
}

const rel = (file) => path.relative(APP, file).split(path.sep).join('/')
const appSources = () => [path.join(APP, 'App.js'), ...sources(SRC).filter((f) => !f.startsWith(VITRINE_DIR + path.sep))]

function vitrineImports (code) {
  const out = []
  for (const m of code.matchAll(IMPORT_RE)) out.push({ spec: m[2], index: m.index, text: m[0] })
  return out
}

// [start, end) of every `if (VITRINE) { ... }` block.
function guardedBlocks (code) {
  const plain = withoutStrings(code)
  const blocks = []
  for (const m of plain.matchAll(/\bif \(VITRINE\) \{/g)) {
    let depth = 0
    for (let i = m.index + m[0].length - 1; i < plain.length; i++) {
      if (plain[i] === '{') depth++
      else if (plain[i] === '}' && --depth === 0) {
        blocks.push([m.index, i + 1])
        break
      }
    }
  }
  return blocks
}

test('vitrineEnabled needs a development bundle and the exact opt-in', async (t) => {
  const { vitrineEnabled } = await import('../src/vitrine/enabled.js')
  t.is(vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: '1' }, true), true)
  t.is(vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: '1' }, false), false)
  t.is(vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: '1' }, undefined), false)
  t.is(vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: '1' }, 'true'), false)
  t.is(vitrineEnabled({}, true), false)
  t.is(vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: 'true' }, true), false)
  t.is(vitrineEnabled({ EXPO_PUBLIC_VARANDA_VITRINE: 1 }, true), false)
  t.is(vitrineEnabled(null, true), false)
  t.is(vitrineEnabled(undefined, true), false)
})

test('only the node, account, terms stores, push hook and index client import src/vitrine', (t) => {
  const importers = []
  for (const file of appSources()) {
    const code = withoutComments(fs.readFileSync(file, 'utf8'))
    if (vitrineImports(code).length > 0) importers.push(rel(file))
  }
  t.alike(importers.sort(), [...ALLOWED].sort())
})

test('every vitrine import is guarded by vitrineEnabled', (t) => {
  for (const name of ALLOWED) {
    const code = withoutComments(fs.readFileSync(path.join(APP, name), 'utf8'))
    t.ok(GUARD_RE.test(code), name + ' computes VITRINE from vitrineEnabled with __DEV__')
    const blocks = guardedBlocks(code)
    for (const imp of vitrineImports(code)) {
      if (/\/vitrine\/enabled(\.js)?$/.test(imp.spec)) {
        t.ok(/^from\s*['"]/.test(imp.text), name + ': ' + imp.spec + ' is a static import')
        continue
      }
      t.ok(/^require\s*\(/.test(imp.text), name + ': ' + imp.spec + ' is a require, not a static import')
      t.ok(blocks.some(([start, end]) => imp.index > start && imp.index < end), name + ': ' + imp.spec + ' sits inside if (VITRINE)')
    }
  }
})

test('the age policy read is short-circuited only under the guard', (t) => {
  const code = withoutComments(fs.readFileSync(path.join(SRC, 'account.js'), 'utf8'))
  const imports = vitrineImports(code).map((i) => i.spec)
  t.alike(imports, ['./vitrine/enabled.js'], 'account.js imports only enabled.js')
  t.ok(/export const agePolicy = async \(\) => \{\s*if \(VITRINE\) return \{ required: false \}/.test(code))
})

test('every account request is refused before fetch under the guard', (t) => {
  const code = withoutComments(fs.readFileSync(path.join(SRC, 'account.js'), 'utf8'))
  t.ok(/async function call \([^)]*\) \{\s*if \(VITRINE\) throw toError\('indisponivel'\)\s*const built = buildRequest/.test(code), 'call() refuses first')
  t.ok(/export const ageSince = async \(\) => \{\s*if \(VITRINE\) return new Promise\(\(\) => \{\}\)/.test(code), 'ageSince never settles, so App.js never sends age.proof nor retries')
  t.is(code.match(/\bfetch\(/g).length, 1, 'call() is the only fetch')
})

test('the terms stores import only enabled.js and switch storage under the guard', (t) => {
  for (const name of TERMS_STORES) {
    const code = withoutComments(fs.readFileSync(path.join(APP, name), 'utf8'))
    t.alike(vitrineImports(code).map((i) => i.spec), ['./vitrine/enabled.js'], name + ' imports only enabled.js')
  }
  const web = withoutComments(fs.readFileSync(path.join(SRC, 'termsStore.web.js'), 'utf8'))
  t.ok(/const KEY = VITRINE \? VITRINE_KEY : STORAGE_KEY/.test(web))
  t.ok(/const VITRINE_KEY = 'varanda-terms-vitrine'/.test(web))
  t.absent(/(?:get|set)Item\(STORAGE_KEY/.test(web), 'the real key is reached only through KEY')
  const native = withoutComments(fs.readFileSync(path.join(SRC, 'termsStore.native.js'), 'utf8'))
  t.ok(/const VITRINE_FILE_NAME = 'varanda-terms-vitrine\.json'/.test(native))
  t.ok(/new File\(Paths\.document, VITRINE \? VITRINE_FILE_NAME : FILE_NAME\)/.test(native))
  t.is(native.match(/new File\(/g).length, 1, 'one file() for every read and write')
})

function withVitrineEnv (t) {
  const hadDev = Object.getOwnPropertyDescriptor(globalThis, '__DEV__')
  const hadEnv = Object.hasOwn(process.env, 'EXPO_PUBLIC_VARANDA_VITRINE')
  const env = process.env.EXPO_PUBLIC_VARANDA_VITRINE
  globalThis.__DEV__ = true
  process.env.EXPO_PUBLIC_VARANDA_VITRINE = '1'
  t.teardown(() => {
    if (hadDev) Object.defineProperty(globalThis, '__DEV__', hadDev)
    else delete globalThis.__DEV__
    if (hadEnv) process.env.EXPO_PUBLIC_VARANDA_VITRINE = env
    else delete process.env.EXPO_PUBLIC_VARANDA_VITRINE
  })
}

function fakeStorage (t, storage) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage })
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete globalThis.localStorage
  })
}

test('under the Vitrine the web terms store never reads or writes the real key', async (t) => {
  withVitrineEnv(t)
  const { STORAGE_KEY } = await import('../src/terms.js')
  const { loadTermsRecord, saveTermsRecord } = await import('../src/termsStore.web.js?vitrine')
  const real = JSON.stringify({ v: 1, version: 1, members: { ['ab'.repeat(32)]: { acceptedAt: '2026-10-27T12:00:00.000Z', synced: false } } })
  const map = new Map([[STORAGE_KEY, real]])
  const touched = []
  fakeStorage(t, {
    getItem: (k) => { touched.push(k); return map.has(k) ? map.get(k) : null },
    setItem: (k, v) => { touched.push(k); map.set(k, String(v)) }
  })
  t.is(await loadTermsRecord(), null, 'the real record is not seen')
  const seed = { v: 1, version: 2, members: { ['cd'.repeat(32)]: { acceptedAt: '2026-10-28T12:00:00.000Z', synced: true } } }
  t.is(await saveTermsRecord(seed), true)
  t.alike(await loadTermsRecord(), seed)
  t.is(map.get(STORAGE_KEY), real, 'the real record is untouched')
  t.alike(JSON.parse(map.get('varanda-terms-vitrine')), seed)
  t.absent(touched.includes(STORAGE_KEY), 'the real key is never accessed')
})

test('under the Vitrine account calls never fetch', async (t) => {
  withVitrineEnv(t)
  const hadFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  let fetched = 0
  globalThis.fetch = async () => { fetched++; throw new Error('no network') }
  t.teardown(() => {
    if (hadFetch) Object.defineProperty(globalThis, 'fetch', hadFetch)
    else delete globalThis.fetch
  })
  const account = await import('../src/account.js?vitrine')
  t.alike(await account.agePolicy(), { required: false })
  await t.exception(account.accountStatus('ab'.repeat(32)), /serviço indisponível/)
  await t.exception(account.invitePolicy(), /serviço indisponível/)
  await t.exception(account.termsStart({ member: 'ab'.repeat(32), version: 1 }), /serviço indisponível/)
  t.is(await account.pushKey(), null)
  const settled = await Promise.race([account.ageSince().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 50))])
  t.is(settled, false, 'ageSince stays pending')
  t.is(fetched, 0)
})

test('the Vitrine node refuses identity and connection changes', (t) => {
  const code = withoutComments(fs.readFileSync(path.join(SRC, 'node.js'), 'utf8'))
  const start = code.indexOf('function VitrineNodeProvider')
  const end = code.indexOf('function LiveNodeProvider')
  t.ok(start > 0 && end > start)
  const body = code.slice(start, end)
  t.ok(/const unavailable = \(\) => Promise\.reject\(Object\.assign\(new Error\('indisponível no modo vitrine'\), \{ code: 'USAGE' \}\)\)/.test(body))
  for (const op of ['restart', 'connect', 'forgetConfig', 'unlock', 'complete', 'lock', 'signOut', 'reset']) {
    t.ok(new RegExp('\\b' + op + ': unavailable,').test(body), op + ' refuses')
  }
})

test('no screen mentions EXPO_PUBLIC_VARANDA_VITRINE', (t) => {
  for (const file of appSources()) {
    if (ALLOWED.includes(rel(file))) continue
    t.absent(fs.readFileSync(file, 'utf8').includes('EXPO_PUBLIC_VARANDA_VITRINE'), rel(file))
  }
})
