'use strict'

// scripts/check-firebase-config.js, with generated fake configs: a store build
// stops when push would be off, and never prints the path or the content.
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('brittle')

const { check, main, PACKAGE_NAME } = require('../scripts/check-firebase-config')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-firebase-config.js')
const hex = (n) => crypto.randomBytes(n).toString('hex')

function fakeConfig () {
  const projectNumber = String(crypto.randomInt(1e11, 1e12))
  const client = (packageName) => ({
    client_info: {
      mobilesdk_app_id: '1:' + projectNumber + ':android:' + hex(8),
      android_client_info: { package_name: packageName }
    },
    api_key: [{ current_key: 'fake-' + hex(16) }]
  })
  return {
    project_info: { project_number: projectNumber, project_id: 'fake-' + hex(4) },
    client: [client('app.varanda.debug'), client(PACKAGE_NAME)]
  }
}

const values = (config) => [
  config.project_info.project_number,
  config.project_info.project_id,
  ...config.client.flatMap((c) => [c.client_info.mobilesdk_app_id, c.api_key[0].current_key])
].filter(Boolean)

test('the package is the production application id', (t) => {
  const gradle = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'build.gradle'), 'utf8')
  t.ok(gradle.includes("applicationId '" + PACKAGE_NAME + "'"))
})

test('check: a complete config for the app passes', (t) => {
  t.is(check(JSON.stringify(fakeConfig())), null)
})

test('check: each missing piece has its own reason', (t) => {
  const cases = [
    ['invalid-json', () => '{"client": ['],
    ['invalid-json', () => 'null'],
    ['no-client-for-package', (c) => { c.client = [] }],
    ['no-client-for-package', (c) => { delete c.client }],
    ['no-client-for-package', (c) => { c.client = [c.client[0]] }],
    ['missing-api-key', (c) => { c.client[1].api_key = [] }],
    ['missing-api-key', (c) => { c.client[1].api_key[0].current_key = ' ' }],
    ['missing-app-id', (c) => { delete c.client[1].client_info.mobilesdk_app_id }],
    ['missing-project-id', (c) => { c.project_info.project_id = '' }],
    ['missing-project-number', (c) => { delete c.project_info.project_number }],
    ['missing-project-id', (c) => { delete c.project_info }]
  ]
  for (const [reason, edit] of cases) {
    const config = fakeConfig()
    const out = edit(config)
    t.is(check(typeof out === 'string' ? out : JSON.stringify(config)), reason, reason)
  }
})

// build.gradle takes the first client with the package, so a later complete
// one must not hide an incomplete first one.
test('check: the first client for the package is the one checked', (t) => {
  const config = fakeConfig()
  const broken = JSON.parse(JSON.stringify(config.client[1]))
  broken.api_key = []
  config.client.splice(1, 0, broken)
  t.is(check(JSON.stringify(config)), 'missing-api-key')
})

test('main: no variable, or a file that cannot be read', (t) => {
  const none = path.join(os.tmpdir(), 'absent-' + hex(8), 'google-services.json')
  t.is(main({}, none), 'unset')
  t.is(main({ VARANDA_GOOGLE_SERVICES_JSON: '' }, none), 'unset')
  t.is(main({ VARANDA_GOOGLE_SERVICES_JSON: path.join(os.tmpdir(), 'absent-' + hex(8), 'google-services.json') }), 'unreadable')
})

// Gradle falls back to android/app/google-services.json when the variable is
// empty, so the guard has to check that file, not stop at "unset".
test('main: the fallback file is checked when the variable is empty', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-firebase-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fallback = path.join(dir, 'fallback.json')
  const named = path.join(dir, 'named.json')

  fs.writeFileSync(fallback, JSON.stringify(fakeConfig()))
  t.is(main({}, fallback), null, 'valid fallback passes')

  const other = fakeConfig()
  other.client = [other.client[0]]
  fs.writeFileSync(fallback, JSON.stringify(other))
  t.is(main({}, fallback), 'no-client-for-package', 'fallback for another package is refused')
  t.is(main({ VARANDA_GOOGLE_SERVICES_JSON: '  ' }, fallback), 'no-client-for-package', 'blank variable counts as unset')

  fs.writeFileSync(named, JSON.stringify(fakeConfig()))
  t.is(main({ VARANDA_GOOGLE_SERVICES_JSON: named }, fallback), null, 'the named file wins over a bad fallback')

  fs.writeFileSync(fallback, JSON.stringify(fakeConfig()))
  fs.writeFileSync(named, '{')
  t.is(main({ VARANDA_GOOGLE_SERVICES_JSON: named }, fallback), 'invalid-json', 'the named file wins over a good fallback')
})

test('the command prints only a reason, never the path or the content', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-firebase-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'google-services-' + hex(4) + '.json')
  const run = (env) => spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })

  const good = fakeConfig()
  fs.writeFileSync(file, JSON.stringify(good))
  const ok = run({ VARANDA_GOOGLE_SERVICES_JSON: file })
  t.is(ok.status, 0, 'a complete config passes')
  t.is(ok.stdout + ok.stderr, 'check-firebase-config: ok\n')

  const bad = fakeConfig()
  bad.client[1].client_info.mobilesdk_app_id = ''
  const secret = 'fake-' + hex(16)
  const broken = [
    ['unset', {}, null],
    ['unreadable', { VARANDA_GOOGLE_SERVICES_JSON: path.join(dir, 'missing.json') }, null],
    ['invalid-json', { VARANDA_GOOGLE_SERVICES_JSON: file }, '{"api_key": "' + secret + '"'],
    ['missing-app-id', { VARANDA_GOOGLE_SERVICES_JSON: file }, JSON.stringify(bad)]
  ]
  for (const [reason, env, content] of broken) {
    if (content !== null) fs.writeFileSync(file, content)
    const r = run(env)
    t.is(r.status, 1, reason + ': exit 1')
    t.is(r.stdout, '', reason + ': nothing on stdout')
    t.is(r.stderr, 'check-firebase-config: ' + reason + '\n', reason + ': only the reason')
    const out = r.stdout + r.stderr
    t.absent(out.includes(dir), reason + ': no path')
    for (const v of [secret, ...values(bad)]) t.absent(out.includes(v), reason + ': no value')
  }
})
