'use strict'

// The CLI with only the files the seeder image ships (helpers/image-files.js
// reads the root .dockerignore). bin/varanda.js loads every command module at
// startup, `seed` included, so one require of a file the image leaves out
// stops the seeder before its health check, as #876 did. No Docker and no
// network.

const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CLI = path.join(__dirname, '..')
const BIN = path.join(CLI, 'bin', 'varanda.js')
const HOOK = path.join(__dirname, 'helpers', 'image-files.js')

function inImage (args) {
  const r = spawnSync(process.execPath, ['-r', HOOK, ...args], { cwd: CLI, encoding: 'utf8', timeout: 60000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('every command module loads with only the image files', (t) => {
  const r = inImage([BIN, '--help'])
  t.is(r.code, 0, r.stderr)
  t.ok(r.stdout.includes('  seed '), 'help lists seed')
  t.ok(r.stdout.includes('  account review '), 'help lists account review')
})

// Only `account review` and the page conversation commands use web-member,
// and they require it when they run: `seed` does not depend on its code.
test('no command module loads web-member at startup', (t) => {
  const r = inImage(['-e', [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const dir = path.join(process.cwd(), 'lib', 'commands')",
    "for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) require(path.join(dir, f))",
    "require('./lib/account/server')",
    "const sep = path.sep + 'web-member' + path.sep",
    'console.log(JSON.stringify(Object.keys(require.cache).filter((f) => f.includes(sep))))'
  ].join('\n')])
  t.is(r.code, 0, r.stderr)
  t.alike(JSON.parse(r.stdout), [], 'no web-member file loaded')
})

test('the check refuses what the image leaves out and admits what it ships', (t) => {
  const left = [
    "require('@varanda/web-member')",
    "require('./test/helpers/net')"
  ]
  for (const code of left) {
    const r = inImage(['-e', code])
    t.not(r.code, 0, code + ' fails')
    t.ok(r.stderr.includes('is not in the seeder image'), code + ': ' + r.stderr.split('\n')[0])
  }
  const shipped = [
    "require('@varanda/web-member/lib/passkey')",
    "require('@varanda/web-member/lib/recovery')",
    "require('./lib/account/review-account')"
  ]
  for (const code of shipped) {
    const r = inImage(['-e', code])
    t.is(r.code, 0, code + ' loads: ' + r.stderr)
  }
})

// deploy/seeder/update.sh (aplicar_origem_midia) runs the web app finisher
// from this image to put VARANDA_MEDIA_ORIGIN into the app the web image
// ships: it and its service worker template ship, and it loads nothing else.
test('the web app finisher and its template ship, and it loads only Node built-ins', (t) => {
  const r = inImage(['-e', [
    "require.resolve('../app/scripts/sw.js')",
    "require('../app/scripts/finish-web.js')",
    "const path = require('node:path')",
    "const root = path.resolve(process.cwd(), '../..')",
    'console.log(JSON.stringify(Object.keys(require.cache).map((f) => path.relative(root, f))))'
  ].join('\n')])
  t.is(r.code, 0, r.stderr)
  const loaded = JSON.parse(r.stdout || '[]').filter((f) => f !== path.relative(path.resolve(CLI, '../..'), HOOK))
  t.alike(loaded, ['apps/app/scripts/finish-web.js'], 'only finish-web.js itself (and the check)')
  const other = inImage(['-e', "require.resolve('../app/scripts/render-og.js')"])
  t.not(other.code, 0, 'another app script is left out')
  t.ok(other.stderr.includes('is not in the seeder image'), other.stderr.split('\n')[0])
})
