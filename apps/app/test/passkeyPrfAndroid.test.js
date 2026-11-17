'use strict'

// The Android passkey module (modules/passkey-prf/android) pins Credential
// Manager. Releases before 1.5.0 lack the passkey cleanup the app relies on,
// and a range or a variable would let a build pick one. The file is read as
// text.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const GRADLE = path.join(__dirname, '..', 'modules/passkey-prf/android/build.gradle')
const MIN = [1, 5, 0]
const ARTIFACTS = ['androidx.credentials:credentials', 'androidx.credentials:credentials-play-services-auth']

const uncommented = (gradle) => gradle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

function atLeast (version, min) {
  const parts = version.split('.').map(Number)
  for (let i = 0; i < min.length; i++) {
    if (parts[i] !== min[i]) return parts[i] > min[i]
  }
  return true
}

test('atLeast compares versions numerically', (t) => {
  t.ok(atLeast('1.5.0', MIN))
  t.ok(atLeast('1.10.0', MIN), 'not a string compare')
  t.ok(atLeast('2.0.0', MIN))
  t.absent(atLeast('1.4.9', MIN))
  t.absent(atLeast('0.9.0', MIN))
})

test('both Credential Manager dependencies are pinned to an exact version at or above 1.5.0', (t) => {
  const gradle = uncommented(fs.readFileSync(GRADLE, 'utf8'))
  for (const artifact of ARTIFACTS) {
    const lines = [...gradle.matchAll(/^\s*implementation\s+(['"])([^'"]*)\1\s*$/gm)]
      .map((m) => m[2])
      .filter((coord) => coord.startsWith(artifact + ':'))
    t.is(lines.length, 1, artifact + ' is declared once, as a plain string')
    const version = lines.length === 1 ? lines[0].slice(artifact.length + 1) : ''
    t.ok(/^\d+\.\d+\.\d+$/.test(version), artifact + ' has an exact version: ' + version)
    t.ok(atLeast(version, MIN), artifact + ' is at least ' + MIN.join('.') + ': ' + version)
  }
})
