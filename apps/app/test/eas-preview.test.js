'use strict'

// EAS preview builds: the config files and the hand edits that keep the
// upload free of secrets and the native projects consistent.
const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')

const root = path.join(__dirname, '..')
const repo = path.join(root, '..', '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('eas.json has no prebuildCommand and no updates', (t) => {
  const eas = JSON.parse(read('eas.json'))
  t.is(eas.cli.appVersionSource, 'local')
  t.is(eas.build.preview.android.buildType, 'apk')
  t.is(eas.build['preview-simulator'].extends, 'preview')
  for (const profile of Object.values(eas.build)) {
    t.absent('prebuildCommand' in profile)
    t.absent('updates' in profile)
  }
  t.absent('updates' in eas)
})

test('the post install hook runs prepare-native.sh', (t) => {
  const script = read('scripts/eas-post-install.sh')
  t.ok(script.includes('prepare-native.sh'))
  t.ok(script.includes('main.bundle.js'))
  t.is(JSON.parse(read('package.json')).scripts['eas-build-post-install'], 'bash scripts/eas-post-install.sh')
  // Whichever package.json the build service reads the hook from, it runs once.
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  t.is(rootPkg.scripts['eas-build-post-install'], 'npm run eas-build-post-install -w apps/app')
})

test('app.json has no owner and no EAS project id', (t) => {
  const { expo } = JSON.parse(read('app.json'))
  t.absent('owner' in expo)
  t.absent(expo.extra && expo.extra.eas && expo.extra.eas.projectId)
})

test('.easignore keeps the build outputs and every secret out of the upload', (t) => {
  const lines = fs.readFileSync(path.join(repo, '.easignore'), 'utf8').split('\n').map((l) => l.trim())
  for (const pattern of [
    'node_modules', 'deploy/seeder/.env', '*.jks', '*.p8', '*.p12', '*.key', '*.mobileprovision', 'credentials.json',
    '**/.cxx', '*.hprof'
  ]) {
    t.ok(lines.includes(pattern), pattern)
  }
  // npm ci at the repo root needs every workspace's package.json.
  t.absent(lines.includes('apps/site'))
  t.ok(lines.includes('!apps/site/package.json'))
})

test('the main manifest drops the overlay and write storage permissions', (t) => {
  const manifest = read('android/app/src/main/AndroidManifest.xml')
  t.absent(manifest.includes('SYSTEM_ALERT_WINDOW'))
  // A library may merge storage or camera permissions; the main manifest only
  // ever names them to remove them.
  for (const name of ['WRITE_EXTERNAL_STORAGE', 'READ_EXTERNAL_STORAGE', 'CAMERA']) {
    const lines = manifest.split('\n').filter((l) => l.includes('android.permission.' + name + '"'))
    t.ok(lines.every((l) => l.includes('tools:node="remove"')), name + ' only as a removal')
  }
  t.ok(manifest.includes('android.permission.INTERNET'))
})

test('the iOS marketing version matches app.json', (t) => {
  const pbxproj = read('ios/Varanda.xcodeproj/project.pbxproj')
  t.absent(pbxproj.includes('MARKETING_VERSION = 1.0;'))
  t.ok(pbxproj.includes(`MARKETING_VERSION = ${JSON.parse(read('app.json')).expo.version};`))
})
