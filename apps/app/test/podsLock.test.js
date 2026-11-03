'use strict'

// scripts/check-pods-lock.js: the committed Podfile.lock must match what
// `pod install` writes, except for the lines that depend on the machine.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const { lockDrift } = require('../scripts/check-pods-lock')

const committed = fs.readFileSync(path.join(__dirname, '..', 'ios', 'Podfile.lock'), 'utf8')

function replaceLine (text, from, to) {
  const lines = text.split('\n')
  const i = lines.findIndex((line) => from.test(line))
  if (i === -1) throw new Error('line not found: ' + from)
  lines[i] = to(lines[i])
  return lines.join('\n')
}

test('the same lock has no drift', (t) => {
  t.alike(lockDrift(committed, committed), { ok: true, missing: [], extra: [], moved: [] })
})

test('a dependency moved under another pod is drift although no line changes', (t) => {
  const committedTree = '  - ExpoAsset (55.0.20):\n    - ExpoModulesCore\n    - SDWebImageWebPCoder\n  - ExpoImageManipulator (55.0.21):\n    - ExpoModulesCore\n'
  const generatedTree = '  - ExpoAsset (55.0.20):\n    - ExpoModulesCore\n  - ExpoImageManipulator (55.0.21):\n    - ExpoModulesCore\n    - SDWebImageWebPCoder\n'
  const drift = lockDrift(committedTree, generatedTree)
  t.is(drift.ok, false)
  t.alike(drift.missing, [])
  t.alike(drift.extra, [])
  t.alike(drift.moved, ['  - ExpoImageManipulator (55.0.21):'])
})

test('the path-dependent checksums and the CocoaPods version are ignored', (t) => {
  let other = replaceLine(committed, /^ {2}React-Core-prebuilt: [0-9a-f]{40}$/, () => '  React-Core-prebuilt: ' + 'a'.repeat(40))
  other = replaceLine(other, /^ {2}ReactNativeDependencies: [0-9a-f]{40}$/, () => '  ReactNativeDependencies: ' + 'b'.repeat(40))
  other = replaceLine(other, /^COCOAPODS: /, () => 'COCOAPODS: 1.17.0')
  t.ok(lockDrift(committed, other).ok)
})

test('a pod that pod install adds but the commit lacks is reported', (t) => {
  const generated = committed.replace('SPEC CHECKSUMS:\n', 'SPEC CHECKSUMS:\n  ExpoNew: ' + 'c'.repeat(40) + '\n')
  const drift = lockDrift(committed, generated)
  t.is(drift.ok, false)
  t.alike(drift.missing, ['  ExpoNew: ' + 'c'.repeat(40)])
  t.alike(drift.extra, [])
})

test('a committed pod that pod install no longer writes is reported', (t) => {
  const generated = replaceLine(committed, /^ {2}ExpoImagePicker: [0-9a-f]{40}$/, () => '')
  const drift = lockDrift(committed, generated)
  t.is(drift.ok, false)
  t.is(drift.extra.length, 1)
  t.ok(drift.extra[0].startsWith('  ExpoImagePicker: '))
})

test('another checksum of an ordinary pod is drift', (t) => {
  const generated = replaceLine(committed, /^ {2}ExpoImagePicker: [0-9a-f]{40}$/, () => '  ExpoImagePicker: ' + 'd'.repeat(40))
  t.is(lockDrift(committed, generated).ok, false)
})

// The Swift package is added to the Pods project in post_install and never
// reaches Podfile.lock, so the pin is checked in the podspec itself.
test('the face liveness pod is locked and pins the official AWS package exactly', (t) => {
  t.ok(committed.includes('  - FaceLivenessCapture (from `../modules/face-liveness/ios`)\n'))
  t.ok(/^ {2}FaceLivenessCapture: [0-9a-f]{40}$/m.test(committed))
  const podspec = fs.readFileSync(path.join(__dirname, '..', 'modules', 'face-liveness', 'ios', 'FaceLivenessCapture.podspec'), 'utf8')
  const call = podspec.match(/spm_dependency\(s,([\s\S]*?)\n\s*\)/)
  t.ok(call, 'spm_dependency call')
  t.ok(/^\s*if defined\?\(spm_dependency\)$/m.test(podspec), 'guarded with defined?')
  t.ok(call[1].includes("url: 'https://github.com/aws-amplify/amplify-ui-swift-liveness',"))
  t.ok(call[1].includes("requirement: { kind: 'exactVersion', version: '1.5.3' },"))
  t.ok(call[1].includes("products: ['FaceLiveness']"))
})

// Xcode refuses an untrusted package plugin or macro, and the AWS package graph
// has both, so every build has to skip the trust prompt, and the graph it
// trusts has to be pinned by commit.
test('every package the iOS build trusts is pinned by commit', (t) => {
  const resolved = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ios', 'Varanda.xcworkspace', 'xcshareddata', 'swiftpm', 'Package.resolved'), 'utf8'))
  t.ok(resolved.pins.length > 0)
  for (const pin of resolved.pins) {
    t.ok(/^[0-9a-f]{40}$/.test(pin.state.revision), pin.identity + ' has a revision')
  }
  const liveness = resolved.pins.find((pin) => pin.identity === 'amplify-ui-swift-liveness')
  t.is(liveness.location, 'https://github.com/aws-amplify/amplify-ui-swift-liveness')
  t.is(liveness.state.version, '1.5.3')
})

test('the EAS iOS build skips the package plugin and macro trust prompt', (t) => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'eas-post-install.sh'), 'utf8')
  const ios = script.match(/^if \[ "\$platform" = ios \]; then\n([\s\S]*?)^fi$/m)
  t.ok(ios, 'an ios only block')
  if (!ios) return
  t.ok(ios[1].includes('defaults write com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation -bool YES'))
  t.ok(ios[1].includes('defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES'))
})
