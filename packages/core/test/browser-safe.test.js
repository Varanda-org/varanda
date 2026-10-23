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
