'use strict'

// admission.js must load without hypercore, hyperdht, hyperswarm or any of
// their native/storage dependencies (so a browser bundle can reuse it), and
// lib/net.js must re-export the very same functions. No network needed.
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const coreRoot = path.join(__dirname, '..')

test('admission.js loads without the node-only network stack', (t) => {
  const code = "require('./lib/admission.js'); process.stdout.write(JSON.stringify(Object.keys(require.cache)))"
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const cached = JSON.parse(r.stdout)
  t.ok(cached.length > 0, 'modules were loaded')
  for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/', '/udx/', '/rocksdb/', '/corestore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})

// The notices, push-proof and age modules ship in the web bundle, which stubs
// `crypto` and `fs` to throw: neither may be required, by them or anything
// they load from lib/ (hypercore-crypto's Node backend, sodium-native, requires `fs` to
// find its addon; the bundle swaps that backend out, so only `crypto` is
// checked beyond lib/).
for (const mod of ['./lib/notices.js', './lib/notices-net.js', './lib/push-proof.js', './lib/age.js']) {
  test(mod + ' loads without the node-only network stack, fs or crypto', (t) => {
    const code = "const m = require('node:module'); const seen = []; const orig = m.prototype.require; m.prototype.require = function (id) { seen.push([this.filename, id]); return orig.apply(this, arguments) }; require('" + mod + "'); process.stdout.write(JSON.stringify({ cached: Object.keys(require.cache), seen }))"
    const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
    t.is(r.status, 0, r.stderr)
    const { cached, seen } = JSON.parse(r.stdout)
    t.ok(cached.length > 0, 'modules were loaded')
    for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/', '/udx/', '/rocksdb/', '/corestore/']) {
      t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
    }
    const libDir = path.join(coreRoot, 'lib') + path.sep
    for (const id of ['crypto', 'node:crypto']) {
      t.absent(seen.some(([, req]) => req === id), 'not required: ' + id)
    }
    for (const id of ['fs', 'node:fs']) {
      t.absent(seen.some(([from, req]) => req === id && typeof from === 'string' && from.startsWith(libDir)), 'not required from lib/: ' + id)
    }
  })
}

// frame-guard.js is meant to sit in front of a browser-side secret stream:
// it may load streamx and nothing server-only (no swarm, no storage, no fs,
// and not the seeder that used to hold it).
test('frame-guard.js loads without the node-only network stack, fs or the seeder', (t) => {
  const code = "const m = require('node:module'); const seen = []; const orig = m.prototype.require; m.prototype.require = function (id) { seen.push(id); return orig.apply(this, arguments) }; require('./lib/frame-guard.js'); process.stdout.write(JSON.stringify({ cached: Object.keys(require.cache), seen }))"
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { cached, seen } = JSON.parse(r.stdout)
  t.ok(cached.some((p) => p.endsWith(path.join('lib', 'frame-guard.js'))), 'frame-guard.js was loaded')
  for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/', '/hypercore-crypto/', '/udx/', '/rocksdb/', '/corestore/', '/@hyperswarm/secret-stream/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
  t.absent(cached.some((p) => p.endsWith(path.join('lib', 'seeder.js'))), 'not loaded: lib/seeder.js')
  for (const id of ['fs', 'node:fs', '#fs', 'net', 'node:net', 'crypto', 'node:crypto']) {
    t.absent(seen.includes(id), 'not required: ' + id)
  }
})

test('net.js re-exports the admission functions', (t) => {
  const net = require('../lib/net')
  const admission = require('../lib/admission')
  t.is(net.attachAdmission, admission.attachAdmission)
  t.is(net.topicFor, admission.topicFor)
  t.is(net.validateMessage, admission.validateMessage)
  t.is(net.MAX_CONNECTIONS, admission.MAX_CONNECTIONS)
  t.ok(net.watchContiguous)
})

test('browser import stubs', (t) => {
  t.is(require('../lib/browser/process').platform, 'browser')
  t.exception(() => require('../lib/browser/fs').readFileSync('x'), /indisponível/)
})
