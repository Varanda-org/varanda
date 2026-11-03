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

// The builder's default Node (20) cannot load the bare-module-lexer prebuild
// that pack-worklet needs (Node ^22.21 or >=24.9), so the hook would fail.
test('the preview profile pins a Node of at least 24.9', (t) => {
  const node = JSON.parse(read('eas.json')).build.preview.node
  t.ok(/^\d+\.\d+\.\d+$/.test(node), 'a full version: eas.json refuses ranges')
  const [major, minor] = node.split('.').map(Number)
  t.ok(major > 24 || (major === 24 && minor >= 9), 'Node ' + node)
})

// Without it the module fails to compile (ActivityResultCallback is not on
// its classpath), and that only shows on the EAS build.
test('the auth-session module declares androidx.activity', (t) => {
  const gradle = read('modules/auth-session/android/build.gradle')
  t.ok(/implementation "androidx\.activity:activity(-ktx)?:\d+\.\d+\.\d+"/.test(gradle))
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

test('app.json is linked to the varanda-org EAS project', (t) => {
  const { expo } = JSON.parse(read('app.json'))
  t.is(expo.owner, 'varanda-org')
  t.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(expo.extra.eas.projectId), 'projectId is a UUID')
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
  // A library may merge storage permissions; the main manifest only ever
  // names them to remove them.
  for (const name of ['WRITE_EXTERNAL_STORAGE', 'READ_EXTERNAL_STORAGE']) {
    const lines = manifest.split('\n').filter((l) => l.includes('android.permission.' + name + '"'))
    t.ok(lines.length > 0 && lines.every((l) => l.includes('tools:node="remove"')), name + ' only as a removal')
  }
  t.ok(manifest.includes('android.permission.INTERNET'))
})

// The liveness selfie needs the camera; the prompt only comes from the
// module's start(), never at app startup.
test('the main manifest grants CAMERA for the selfie without requiring a camera', (t) => {
  const manifest = read('android/app/src/main/AndroidManifest.xml')
  const camera = manifest.split('\n').filter((l) => l.includes('android.permission.CAMERA"'))
  t.is(camera.length, 1, 'CAMERA named once')
  t.absent(camera[0].includes('tools:node'), 'CAMERA is not a removal')
  // Play reads CAMERA as requiring camera and camera.autofocus unless each is
  // declared not required; camera.any alone does not clear them. The liveness
  // SDK declares camera.any with the default required true, and that wins the
  // manifest merge unless the app replaces the attribute.
  for (const feature of ['camera', 'camera.any', 'camera.autofocus', 'camera.front']) {
    const name = 'android.hardware.' + feature + '"'
    const lines = manifest.split('\n').filter((l) => l.includes('<uses-feature') && l.includes('android:name="' + name))
    t.is(lines.length, 1, feature + ' declared once')
    t.is(lines[0] && lines[0].trim(), '<uses-feature android:name="' + name + ' android:required="false" tools:replace="android:required"/>', feature + ' not required, over any library')
  }
  t.absent(/<uses-feature[^>]*android:required="true"/.test(manifest), 'no required hardware feature')
  t.absent(/<uses-feature(?![^>]*android:required="false")[^>]*>/.test(manifest), 'every uses-feature says required false')
  const permissions = [...manifest.matchAll(/<uses-permission android:name="android\.permission\.([A-Z_]+)"( tools:node="remove")?\/>/g)]
    .map((m) => m[1] + (m[2] ? ':remove' : ''))
  t.alike(permissions, ['INTERNET', 'VIBRATE', 'READ_EXTERNAL_STORAGE:remove', 'WRITE_EXTERNAL_STORAGE:remove', 'CAMERA'])
  t.is((manifest.match(/<uses-permission\b/g) || []).length, permissions.length, 'every uses-permission is in the list')
})

test('Info.plist explains the camera use for the selfie', (t) => {
  const plist = read('ios/Varanda/Info.plist')
  const m = plist.match(/<key>NSCameraUsageDescription<\/key>\s*<string>([^<]*)<\/string>/)
  t.ok(m, 'NSCameraUsageDescription present')
  t.ok(m && m[1].trim().length > 0, 'non-empty description')
  t.ok(m && m[1].includes('selfie'), 'names the selfie')
})

// A wider claim would pull /@, /convite/ or the /account/ passkey pages out of
// the browser for everyone who has the app installed.
test('the main manifest claims only /c/ and /g/ of the production host as App Links', (t) => {
  const manifest = read('android/app/src/main/AndroidManifest.xml')
  t.is(manifest.split('android:autoVerify="true"').length - 1, 1, 'exactly one autoVerify')
  const filters = manifest.match(/<intent-filter[^>]*>[\s\S]*?<\/intent-filter>/g) || []
  const verified = filters.filter((f) => f.includes('android:autoVerify="true"'))
  t.is(verified.length, 1)
  const appLinks = verified[0] || ''
  t.ok(appLinks.includes('<action android:name="android.intent.action.VIEW"/>'))
  t.ok(appLinks.includes('<category android:name="android.intent.category.DEFAULT"/>'))
  t.ok(appLinks.includes('<category android:name="android.intent.category.BROWSABLE"/>'))
  const data = appLinks.match(/<data [^>]*\/>/g) || []
  t.alike(data, [
    '<data android:scheme="https" android:host="bora.varanda.app" android:pathPrefix="/c/"/>',
    '<data android:scheme="https" android:host="bora.varanda.app" android:pathPrefix="/g/"/>'
  ])
  const hosts = manifest.match(/android:host="[^"]*"/g) || []
  t.ok(hosts.length > 0 && hosts.every((h) => h === 'android:host="bora.varanda.app"'), 'only the production host')
  t.absent(manifest.includes('android:pathPattern'))
  t.absent(manifest.includes('android:path='))
  t.absent(manifest.includes('android:pathAdvancedPattern'))
  t.alike(manifest.match(/android:pathPrefix="[^"]*"/g), ['android:pathPrefix="/c/"', 'android:pathPrefix="/g/"'])
  const scheme = filters.filter((f) => f.includes('android:scheme="varanda"'))
  t.is(scheme.length, 1, 'the varanda scheme filter is kept')
  t.absent((scheme[0] || '').includes('autoVerify'))
  t.ok(manifest.includes('android:launchMode="singleTask"'))
})

test('the iOS marketing version matches app.json', (t) => {
  const pbxproj = read('ios/Varanda.xcodeproj/project.pbxproj')
  t.absent(pbxproj.includes('MARKETING_VERSION = 1.0;'))
  t.ok(pbxproj.includes(`MARKETING_VERSION = ${JSON.parse(read('app.json')).expo.version};`))
})
