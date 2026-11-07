'use strict'

// Bare has no TextEncoder/TextDecoder. web-member's sodium-browser loads
// @noble/curves, whose ed25519 module calls TextEncoder while it loads, so
// in the worklet the web session never started and the app stayed on
// Conectar. worklet/main.js installs bare-encoding's globals before
// web-node. A child Node process without those globals stands in for Bare.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const appDir = path.join(__dirname, '..')

function runWithoutEncoding (code) {
  const script = 'delete globalThis.TextEncoder; delete globalThis.TextDecoder;\n' + code
  return spawnSync(process.execPath, ['-e', script], { cwd: appDir, encoding: 'utf8' })
}

test('without TextEncoder, loading sodium-browser fails as it did in the worklet', (t) => {
  const r = runWithoutEncoding("require('@varanda/web-member/lib/sodium-browser')")
  t.not(r.status, 0, 'the load fails')
  t.ok(/TextEncoder is not defined/.test(r.stderr), 'with the worklet error')
})

test('bare-encoding/global first: sodium-browser loads and the globals work', (t) => {
  const r = runWithoutEncoding([
    "require('bare-encoding/global')",
    "require('@varanda/web-member/lib/sodium-browser')",
    "const bytes = new TextEncoder().encode('varanda')",
    "if (!(bytes instanceof Uint8Array) || new TextDecoder().decode(bytes) !== 'varanda') throw new Error('round trip')",
    "console.log('ok')"
  ].join('\n'))
  t.is(r.status, 0, r.stderr)
  t.is(r.stdout.trim(), 'ok')
})

test('worklet/main.js installs the encoding globals before web-node loads', (t) => {
  const source = fs.readFileSync(path.join(appDir, 'worklet', 'main.js'), 'utf8')
  const code = source.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  const globals = code.indexOf("require('bare-encoding/global')")
  const webNode = code.indexOf("require('./web-node')")
  t.ok(globals !== -1, 'bare-encoding/global is required')
  t.ok(webNode !== -1, 'web-node is required')
  t.ok(globals < webNode, 'before web-node')
})

test('bare-encoding is an exact dependency of the app (bare-pack bundles it)', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  t.ok(/^\d+\.\d+\.\d+$/.test(pkg.dependencies['bare-encoding'] || ''), 'exact version')
})
