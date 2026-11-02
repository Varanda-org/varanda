'use strict'

// Compares the committed ios/Podfile.lock with the one `pod install` just
// wrote, and fails when a pod is missing, extra or at another version: a new
// Expo module added to package.json without the lock (expo-clipboard was) is
// caught here instead of on the next person's machine.
//
// Two SPEC CHECKSUMS lines always differ between machines: the prebuilt
// React-Core-prebuilt and ReactNativeDependencies podspecs carry the absolute
// path of the downloaded tarball in Pods/, so their checksum depends on where
// the repository is checked out (docs/verification.md section 7). Those two
// lines and the CocoaPods version line are left out of the comparison.
// Usage: node scripts/check-pods-lock.js <committed lock> <generated lock>

const fs = require('fs')

const PATH_DEPENDENT = /^ {2}(React-Core-prebuilt|ReactNativeDependencies): [0-9a-f]{40}$/
const COCOAPODS_VERSION = /^COCOAPODS: /

function comparable (text) {
  return String(text).split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '' && !PATH_DEPENDENT.test(line) && !COCOAPODS_VERSION.test(line))
}

function counts (lines) {
  const map = new Map()
  for (const line of lines) map.set(line, (map.get(line) || 0) + 1)
  return map
}

function onlyIn (a, b) {
  const out = []
  for (const [line, n] of a) {
    for (let i = (b.get(line) || 0); i < n; i++) out.push(line)
  }
  return out
}

function lockDrift (committed, generated) {
  const a = counts(comparable(committed))
  const b = counts(comparable(generated))
  const missing = onlyIn(b, a)
  const extra = onlyIn(a, b)
  return { ok: missing.length === 0 && extra.length === 0, missing, extra }
}

module.exports = { lockDrift }

if (require.main === module) {
  const [committedFile, generatedFile] = process.argv.slice(2)
  if (!committedFile || !generatedFile) {
    console.error('usage: node scripts/check-pods-lock.js <committed lock> <generated lock>')
    process.exit(2)
  }
  const drift = lockDrift(fs.readFileSync(committedFile, 'utf8'), fs.readFileSync(generatedFile, 'utf8'))
  if (drift.ok) {
    console.log('Podfile.lock: up to date (path-dependent checksums and the CocoaPods version ignored)')
    process.exit(0)
  }
  console.error('Podfile.lock is out of date: run `npm run prepare:native -w apps/app -- ios` and commit the lock.')
  for (const line of drift.missing) console.error('  not committed: ' + line)
  for (const line of drift.extra) console.error('  only committed: ' + line)
  process.exit(1)
}
