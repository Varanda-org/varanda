'use strict'

// scripts/check-apk-permissions.js against aapt2 output written by hand.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('brittle')
const { parsePermissions, parseSdk, checkPermissions, BANNED } = require('../scripts/check-apk-permissions')

const SCRIPT = path.join(__dirname, '../scripts/check-apk-permissions.js')

const dump = (...names) => 'package: app.varanda\npermission: app.varanda.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION\n' +
  names.map((n) => "uses-permission: name='" + n + "'").join('\n') + '\n'
const OK = dump('android.permission.VIBRATE', 'android.permission.INTERNET', 'android.permission.RECORD_AUDIO')
const BADGING = "package: name='app.varanda' versionCode='1' versionName='1.0' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'\nsdkVersion:'24'\ntargetSdkVersion:'36'\n"

const run = (input, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' })

test('parses, dedupes and sorts uses-permission lines only', (t) => {
  const text = OK + "uses-permission: name='android.permission.INTERNET'\nuses-permission-sdk-23: name='android.permission.POST_NOTIFICATIONS'\nuses-permission: name='android.permission.WRITE_EXTERNAL_STORAGE' maxSdkVersion='28'\n"
  t.alike(parsePermissions(text), [
    'android.permission.INTERNET',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECORD_AUDIO',
    'android.permission.VIBRATE',
    'android.permission.WRITE_EXTERNAL_STORAGE'
  ])
})

test('each banned permission fails, alone and with a maxSdkVersion', (t) => {
  t.is(BANNED.length, 4)
  for (const name of BANNED) {
    const f = checkPermissions(parsePermissions(OK + "uses-permission: name='" + name + "' maxSdkVersion='28'\n"))
    t.alike(f, [name + ' is in the merged manifest'])
  }
  t.alike(checkPermissions(parsePermissions(OK)), [])
})

test('empty or foreign input fails closed', (t) => {
  t.is(checkPermissions(parsePermissions('')).length, 1)
  t.is(checkPermissions(parsePermissions("package: name='x'\n")).length, 1)
})

test('reads target and compile SDK from the badging', (t) => {
  t.alike(parseSdk(BADGING), { target: 36, compile: 36 })
  t.alike(parseSdk('nothing'), { target: null, compile: null })
})

test('cli: prints the sorted list and the SDK levels, fails on AD_ID with the reason on stderr', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-perms-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const badging = path.join(dir, 'badging.txt')
  fs.writeFileSync(badging, BADGING)

  const ok = run(OK, badging)
  t.is(ok.status, 0)
  t.is(ok.stdout, 'permissions (3):\n  android.permission.INTERNET\n  android.permission.RECORD_AUDIO\n  android.permission.VIBRATE\ntargetSdkVersion: 36\ncompileSdkVersion: 36\n')

  const bad = run(OK + "uses-permission: name='com.google.android.gms.permission.AD_ID'\n", badging)
  t.is(bad.status, 1)
  t.ok(bad.stderr.includes('FAIL: com.google.android.gms.permission.AD_ID is in the merged manifest'))

  fs.writeFileSync(badging, 'garbage')
  t.is(run(OK, badging).status, 1, 'a badging without SDK levels fails')
  t.is(run('').status, 1, 'empty stdin fails')
})
