#!/usr/bin/env node
// Bundles the browser member (web/app.js) for Chromium with esbuild, and the
// relay page (web/relay.js) when it exists.
//
//   node packages/web-member/scripts/build.js [--out <file>]
//
// platform 'browser' makes esbuild pick the `browser` import condition, so
// @varanda/core's #fs/#path/#process resolve to its lib/browser stubs, and
// mainFields ['browser', 'module', 'main'] honours package `browser` fields
// (sodium-universal maps sodium-native to sodium-javascript there).
// random-access-file and the Node builtins the graph still names are aliased
// to web/stubs/throw.js (every use throws 'indisponível no navegador').
// Shims for missing builtins: only those in SHIMS below, each with the
// reason measured from the metafile.
// The member build fails when the graph contains a Node-only or Hypercore 11
// piece (FORBIDDEN below). Prints 'BUNDLE <bytes> GZIP <bytes>'. The relay
// build is held to the same FORBIDDEN list and prints 'RELAY_BUNDLE ok
// <bytes>' or 'RELAY_BUNDLE fail <reason>' (a forbidden module also fails
// the run).
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const STUB = path.join(ROOT, 'web', 'stubs', 'throw.js')

// Measured with the metafile: random-access-storage 3.0.2, hypercore
// 10.38.2 (index.js, lib/batch.js) and events-universal require 'events',
// which esbuild does not polyfill for the browser; the `events` package
// 3.3.0 (the browserify implementation, already hoisted through
// @hyperswarm/dht-relay) is installed exact as a devDependency of this
// workspace for it. No Buffer or process global is referenced by the graph
// (b4a is used throughout), so neither is shimmed.
const SHIMS = {
  events: require.resolve('events/')
}

// Measured importers of the stub: hypercore 10 index.js (random-access-file,
// its default storage, unused because a storage factory is always passed),
// sodium-javascript randombytes.js ('crypto', only when
// globalThis.crypto.getRandomValues is missing) and memory.js
// ('worker_threads', only when MessageChannel is missing). fs/path/os are
// listed per the spike spec; any other builtin fails the build loudly.

const STUBBED = [
  'random-access-file',
  'fs',
  'path',
  'os',
  'crypto',
  'worker_threads'
]

function aliases () {
  const alias = {}
  for (const name of STUBBED) alias[name] = STUB
  for (const [name, target] of Object.entries(SHIMS)) alias[name] = target
  return alias
}

// node:* specifiers become the stub (or the shim with the same bare name).
const nodeBuiltins = {
  name: 'node-builtins',
  setup (build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      const bare = args.path.slice(5)
      return { path: SHIMS[bare] || STUB }
    })
  }
}

// sodium-universal requires 'sodium-native', which its `browser` field maps
// to 'sodium-javascript' (0.8.0). That package lacks
// crypto_scalarmult_ed25519_BYTES and crypto_scalarmult_ed25519_noclamp,
// which noise-curve-ed needs for every Noise handshake, so in the browser
// bundles both specifiers resolve to lib/sodium-browser.js (sodium-javascript
// completed with those two). The shim's own require of sodium-javascript is
// the one import left alone (resolved here to the real package by absolute
// path), so there is no loop. Plugins see the original specifier, before
// esbuild applies the `browser` field, hence the filter on both names.
const SODIUM_SHIM = path.join(ROOT, 'lib', 'sodium-browser.js')
const SODIUM_JS = require.resolve('sodium-javascript')

const sodiumBrowser = {
  name: 'sodium-browser',
  setup (build) {
    build.onResolve({ filter: /^sodium-(native|javascript)$/ }, (args) => {
      if (args.importer === SODIUM_SHIM) return { path: SODIUM_JS }
      return { path: SODIUM_SHIM }
    })
  }
}

const FORBIDDEN = [
  { name: 'hypercore 11', test: (file, versions) => /node_modules\/hypercore\//.test(file) && versions.get(pkgDir(file)) !== undefined && versions.get(pkgDir(file)).startsWith('11.') },
  { name: 'corestore', test: (file) => /node_modules\/corestore\//.test(file) },
  { name: 'rocksdb', test: (file) => /rocksdb/.test(file) },
  { name: 'sodium-native', test: (file) => /node_modules\/sodium-native\//.test(file) },
  { name: 'udx-native', test: (file) => /node_modules\/udx-native\//.test(file) },
  { name: 'hyperswarm', test: (file) => /node_modules\/hyperswarm\//.test(file) },
  // The relay entry may load hyperdht/lib/constants and lib/messages (what
  // @hyperswarm/dht-relay requires) but never hyperdht's index (Node-only).
  { name: 'hyperdht index', test: (file) => /node_modules\/hyperdht\/index\.js$/.test(file) },
  { name: 'packages/core/lib/net.js', test: (file) => /packages\/core\/lib\/net\.js$/.test(file) },
  { name: 'packages/core/lib/sync.js', test: (file) => /packages\/core\/lib\/sync\.js$/.test(file) },
  { name: 'packages/core/lib/seeder.js', test: (file) => /packages\/core\/lib\/seeder\.js$/.test(file) },
  { name: 'packages/core/lib/store.js', test: (file) => /packages\/core\/lib\/store\.js$/.test(file) }
]

// The package directory owning a bundled input (the last node_modules/<pkg>).
function pkgDir (file) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)
  return m ? m[1] : null
}

function packageVersions (inputs) {
  const versions = new Map()
  for (const file of inputs) {
    const dir = pkgDir(file)
    if (dir === null || versions.has(dir)) continue
    try {
      versions.set(dir, JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version)
    } catch {
      versions.set(dir, undefined)
    }
  }
  return versions
}

function forbiddenIn (metafile) {
  // Metafile inputs are relative to absWorkingDir (ROOT); test absolute paths.
  const inputs = Object.keys(metafile.inputs).map((f) => path.resolve(ROOT, f).split(path.sep).join('/'))
  const versions = packageVersions(inputs)
  const found = []
  for (const rule of FORBIDDEN) {
    const hit = inputs.find((file) => rule.test(file, versions))
    if (hit) found.push(rule.name + ' (' + hit + ')')
  }
  return found
}

function options (entry, outfile) {
  return {
    entryPoints: [entry],
    absWorkingDir: ROOT,
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    metafile: true,
    logLevel: 'silent',
    mainFields: ['browser', 'module', 'main'],
    define: {
      'process.env.NODE_ENV': '"production"',
      global: 'globalThis'
    },
    alias: aliases(),
    plugins: [nodeBuiltins, sodiumBrowser]
  }
}

function parseArgs (argv) {
  let out = path.join(ROOT, 'dist', 'app.js')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out = path.resolve(argv[++i])
    else throw new Error('argumento desconhecido: ' + argv[i])
  }
  return { out }
}

function firstError (err) {
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    const e = err.errors[0]
    return (e.location ? e.location.file + ': ' : '') + e.text
  }
  return String(err && err.message ? err.message : err).split('\n')[0]
}

async function main () {
  const { out } = parseArgs(process.argv.slice(2))
  fs.mkdirSync(path.dirname(out), { recursive: true })

  const result = await esbuild.build(options(path.join(ROOT, 'web', 'app.js'), out))
  const metaFile = out.replace(/\.js$/, '') + '.meta.json'
  fs.writeFileSync(metaFile, JSON.stringify(result.metafile))

  const bad = forbiddenIn(result.metafile)
  if (bad.length > 0) {
    fs.rmSync(out, { force: true })
    console.error('o pacote contém módulos proibidos: ' + bad.join(', '))
    process.exitCode = 1
    return
  }

  const bytes = fs.readFileSync(out)
  console.log('BUNDLE ' + bytes.length + ' GZIP ' + zlib.gzipSync(bytes, { level: 9 }).length)

  const relayEntry = path.join(ROOT, 'web', 'relay.js')
  if (fs.existsSync(relayEntry)) {
    const relayOut = path.join(path.dirname(out), 'relay.js')
    try {
      const relayResult = await esbuild.build(options(relayEntry, relayOut))
      fs.writeFileSync(relayOut.replace(/\.js$/, '') + '.meta.json', JSON.stringify(relayResult.metafile))
      const relayBad = forbiddenIn(relayResult.metafile)
      if (relayBad.length > 0) {
        fs.rmSync(relayOut, { force: true })
        console.log('RELAY_BUNDLE fail o pacote contém módulos proibidos: ' + relayBad.join(', '))
        process.exitCode = 1
        return
      }
      console.log('RELAY_BUNDLE ok ' + fs.statSync(relayOut).size)
    } catch (err) {
      console.log('RELAY_BUNDLE fail ' + firstError(err))
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('falha na construção: ' + firstError(err))
    process.exitCode = 1
  })
}

module.exports = { forbiddenIn }
