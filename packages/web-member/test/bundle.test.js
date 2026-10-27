// The browser bundles: scripts/build.js produces web/app.js bundled for the
// browser (plus the relay page and the browser node, varanda-node.js, which
// test/node-bundle.test.js runs) without Node-only pieces (sodium-native,
// rocksdb) and without an unresolved node: require. Both bundles (app and relay) carry
// lib/sodium-browser.js (sodium-javascript plus the ed25519 scalarmult
// noise-curve-ed needs, on @noble/curves) in place of plain sodium-javascript:
// recognised by the shim's failure message and a noble point-decoding
// message, both string literals that survive minification.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { testnet, tmpDir } = require('./helpers/net')

const BUILD = path.join(__dirname, '..', 'scripts', 'build.js')

test('build.js bundles the member for the browser', async (t) => {
  t.timeout(120000)
  await testnet(t)
  const out = path.join(tmpDir(t, 'varanda-web-bundle-'), 'app.js')
  const r = spawnSync(process.execPath, [BUILD, '--out', out], { encoding: 'utf8', timeout: 110000 })
  t.is(r.status, 0, 'build exits 0: ' + (r.stderr || '').trim())
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('BUNDLE '))
  t.ok(line && /^BUNDLE \d+ GZIP \d+$/.test(line), 'prints BUNDLE <bytes> GZIP <bytes>')
  t.comment(line)
  t.ok(fs.existsSync(out), 'bundle written')
  const code = fs.readFileSync(out, 'utf8')
  t.absent(code.includes('sodium-native'), 'no sodium-native')
  t.absent(code.includes('rocksdb'), 'no rocksdb')
  t.absent(code.includes('__require("node:'), 'no unresolved node: require')

  const relayLine = (r.stdout || '').split('\n').find((l) => l.startsWith('RELAY_BUNDLE '))
  t.ok(relayLine && /^RELAY_BUNDLE ok \d+$/.test(relayLine), 'prints RELAY_BUNDLE ok <bytes>')
  t.comment(relayLine)
  const nodeLine = (r.stdout || '').split('\n').find((l) => l.startsWith('NODE_BUNDLE '))
  t.ok(nodeLine && /^NODE_BUNDLE \d+ GZIP \d+$/.test(nodeLine), 'prints NODE_BUNDLE <bytes> GZIP <bytes>')
  t.comment(nodeLine)
  t.ok(fs.existsSync(path.join(path.dirname(out), 'varanda-node.js')), 'node bundle written next to the app bundle')
  const relayOut = path.join(path.dirname(out), 'relay.js')
  t.ok(fs.existsSync(relayOut), 'relay bundle written next to the app bundle')
  const relay = fs.readFileSync(relayOut, 'utf8')
  for (const [name, bundle] of [['app', code], ['relay', relay]]) {
    t.ok(bundle.includes('failed to derive shared secret'), name + ': contains lib/sodium-browser.js')
    t.ok(bundle.includes('bad point: invalid y coordinate'), name + ': contains @noble/curves ed25519')
    t.ok(bundle.includes('crypto_scalarmult_ed25519_noclamp'), name + ': names crypto_scalarmult_ed25519_noclamp')
    t.absent(bundle.includes('sodium-native'), name + ': no sodium-native')
  }
  // The initiator links run behind @varanda/core lib/frame-guard.js (its
  // error texts survive minification), which must come without the seeder
  // it was extracted from: none of lib/seeder.js's server-only log texts.
  const nodeBundle = fs.readFileSync(path.join(path.dirname(out), 'varanda-node.js'), 'utf8')
  for (const [name, bundle] of [['app', code], ['node', nodeBundle]]) {
    t.ok(bundle.includes('frame over the limit') && bundle.includes('FrameGuard: '), name + ': contains lib/frame-guard.js')
    for (const marker of ['media-admitted', 'seeder-full', 'admission-failed']) {
      t.absent(bundle.includes(marker), name + ': no lib/seeder.js marker ' + marker)
    }
  }
})
