'use strict'

// EAS preview builds: the config files and the hand edits that keep the
// upload free of secrets and the native projects consistent.
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('brittle')

const root = path.join(__dirname, '..')
const repo = path.join(root, '..', '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('eas.json has no prebuildCommand and no updates', (t) => {
  const eas = JSON.parse(read('eas.json'))
  t.is(eas.cli.appVersionSource, 'remote', 'EAS keeps the build number (docs/development.md, Envio para a App Store)')
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

// The builder runs a plain `npm ci --include=dev` at the root. onnxruntime-node's
// install script (apps/cli only) then fetches CUDA files that answer 404 on the
// Linux builder, and sharp's can compile on macOS. The named post-install hook
// still runs with the flag on.
test('the preview profiles run no dependency install script', (t) => {
  const { build } = JSON.parse(read('eas.json'))
  t.alike(build.preview.env, { npm_config_ignore_scripts: 'true' })
  t.is(build['preview-simulator'].extends, 'preview')
  t.absent('env' in build['preview-simulator'], 'preview-simulator inherits the env of preview')
})

// Without it the module fails to compile (ActivityResultCallback is not on
// its classpath), and that only shows on the EAS build.
test('the auth-session module declares androidx.activity', (t) => {
  const gradle = read('modules/auth-session/android/build.gradle')
  t.ok(/implementation "androidx\.activity:activity(-ktx)?:\d+\.\d+\.\d+"/.test(gradle))
})

// One media3 stack: video-prep pins the version expo-video declares, or Gradle
// resolves a newer one for every media3 module the app ships.
test('the video-prep module pins media3 1.8.0, as expo-video does', (t) => {
  const gradle = read('modules/video-prep/android/build.gradle')
  for (const name of ['transformer', 'effect', 'common']) {
    const lines = gradle.split('\n').filter((l) => l.includes('androidx.media3:media3-' + name + ':'))
    t.alike(lines.map((l) => l.trim()), ['implementation "androidx.media3:media3-' + name + ':1.8.0"'], name)
  }
  const expoVideo = fs.readFileSync(require.resolve('expo-video/android/build.gradle', { paths: [root] }), 'utf8')
  t.ok(expoVideo.includes('def androidxMedia3Version = "1.8.0"'), 'expo-video still declares 1.8.0')
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

// The hook itself, from a copy whose prepare-native.sh is a stub that only
// records its platform: a production Android build stops on a bad Firebase
// config before any native work, every other build is unchanged.
test('the post install hook checks the Firebase config only for production Android', (t) => {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    t.comment('bash not found: skipping the behavioural check')
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-eas-hook-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'scripts'))
  for (const file of ['eas-post-install.sh', 'check-firebase-config.js']) {
    fs.copyFileSync(path.join(root, 'scripts', file), path.join(dir, 'scripts', file))
  }
  fs.writeFileSync(path.join(dir, 'scripts', 'prepare-native.sh'), [
    'set -euo pipefail',
    'echo "$1" > prepared',
    'mkdir -p assets/worklet',
    'echo "" > assets/worklet/main.bundle.js',
    ''
  ].join('\n'))

  const hex = (n) => crypto.randomBytes(n).toString('hex')
  const projectNumber = String(crypto.randomInt(1e11, 1e12))
  const good = {
    project_info: { project_number: projectNumber, project_id: 'fake-' + hex(4) },
    client: [{
      client_info: { mobilesdk_app_id: '1:' + projectNumber + ':android:' + hex(8), android_client_info: { package_name: 'app.varanda' } },
      api_key: [{ current_key: 'fake-' + hex(16) }]
    }]
  }
  const secrets = [projectNumber, good.project_info.project_id, good.client[0].client_info.mobilesdk_app_id, good.client[0].api_key[0].current_key]
  const config = path.join(dir, 'config-' + hex(4) + '.json')

  const run = (env, content) => {
    fs.rmSync(path.join(dir, 'prepared'), { force: true })
    fs.rmSync(path.join(dir, 'assets'), { recursive: true, force: true })
    if (content === null) fs.rmSync(config, { force: true })
    else if (content !== undefined) fs.writeFileSync(config, content)
    const r = spawnSync('bash', [path.join(dir, 'scripts', 'eas-post-install.sh')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env }
    })
    const prepared = fs.existsSync(path.join(dir, 'prepared')) ? fs.readFileSync(path.join(dir, 'prepared'), 'utf8').trim() : null
    return { ...r, out: r.stdout + r.stderr, prepared }
  }
  const prod = { EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'production', VARANDA_GOOGLE_SERVICES_JSON: config }
  const wrongClient = JSON.parse(JSON.stringify(good))
  wrongClient.client[0].client_info.android_client_info.package_name = 'app.varanda.debug'
  const noKey = JSON.parse(JSON.stringify(good))
  noKey.client[0].api_key = []
  const noProject = JSON.parse(JSON.stringify(good))
  delete noProject.project_info.project_number

  for (const [name, env, content] of [
    ['no variable', { EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'production' }, undefined],
    ['no file', prod, null],
    ['invalid JSON', prod, JSON.stringify(good).slice(0, -2)],
    ['wrong client', prod, JSON.stringify(wrongClient)],
    ['no api key', prod, JSON.stringify(noKey)],
    ['no project number', prod, JSON.stringify(noProject)]
  ]) {
    const r = run(env, content)
    t.not(r.status, 0, name + ': the build stops')
    t.is(r.prepared, null, name + ': before any native work')
    t.ok(/^check-firebase-config: [a-z-]+\n$/.test(r.out), name + ': only a reason token')
    t.absent(r.out.includes(dir), name + ': no path')
    for (const v of secrets) t.absent(r.out.includes(v), name + ': no value')
  }

  const ok = run(prod, JSON.stringify(good))
  t.is(ok.status, 0, 'production Android with a complete config: ' + ok.stderr)
  t.is(ok.prepared, 'android')
  t.ok(ok.out.includes('check-firebase-config: ok'))
  for (const v of secrets) t.absent(ok.out.includes(v), 'no value on success')

  // The variable is missing in every case below, and nothing is checked.
  for (const env of [
    { EAS_BUILD_PLATFORM: 'android', EAS_BUILD_PROFILE: 'preview' },
    { EAS_BUILD_PLATFORM: 'android' },
    { EAS_BUILD_PLATFORM: 'ios', EAS_BUILD_PROFILE: 'production' },
    { EAS_BUILD_PLATFORM: 'ios', EAS_BUILD_PROFILE: 'preview' }
  ]) {
    const r = run(env)
    const label = env.EAS_BUILD_PLATFORM + ' ' + (env.EAS_BUILD_PROFILE || '(no profile)')
    t.is(r.status, 0, label + ': unchanged ' + r.stderr)
    t.is(r.prepared, env.EAS_BUILD_PLATFORM, label + ': prepares its platform')
    t.absent(r.out.includes('check-firebase-config'), label + ': no Firebase check')
  }
  t.is(run({ EAS_BUILD_PROFILE: 'production' }).status, 2, 'an unknown platform still exits 2')
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
  // A library may merge storage or camera permissions; the main manifest only ever
  // names them to remove them.
  for (const name of ['WRITE_EXTERNAL_STORAGE', 'READ_EXTERNAL_STORAGE', 'CAMERA']) {
    const lines = manifest.split('\n').filter((l) => l.includes('android.permission.' + name + '"'))
    t.ok(lines.length > 0 && lines.every((l) => l.includes('tools:node="remove"')), name + ' only as a removal')
  }
  t.ok(manifest.includes('android.permission.INTERNET'))
})

// A wider claim would pull /convite/ or the /account/ passkey pages out of
// the browser for everyone who has the app installed. /@ and /m/ open the
// profile with its Seguir button (the Meu QR code, src/profileQr.js).
test('the main manifest claims only /c/, /g/, /anuncio/, /publicacao/, /@ and /m/ of the production host as App Links', (t) => {
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
    '<data android:scheme="https" android:host="bora.varanda.app" android:pathPrefix="/g/"/>',
    '<data android:scheme="https" android:host="bora.varanda.app" android:pathPrefix="/anuncio/"/>',
    '<data android:scheme="https" android:host="bora.varanda.app" android:pathPrefix="/publicacao/"/>',
    '<data android:scheme="https" android:host="bora.varanda.app" android:pathPrefix="/@"/>',
    '<data android:scheme="https" android:host="bora.varanda.app" android:pathPrefix="/m/"/>'
  ])
  const hosts = manifest.match(/android:host="[^"]*"/g) || []
  t.ok(hosts.length > 0 && hosts.every((h) => h === 'android:host="bora.varanda.app"'), 'only the production host')
  t.absent(manifest.includes('android:pathPattern'))
  t.absent(manifest.includes('android:path='))
  t.absent(manifest.includes('android:pathAdvancedPattern'))
  t.alike(manifest.match(/android:pathPrefix="[^"]*"/g), ['android:pathPrefix="/c/"', 'android:pathPrefix="/g/"', 'android:pathPrefix="/anuncio/"', 'android:pathPrefix="/publicacao/"', 'android:pathPrefix="/@"', 'android:pathPrefix="/m/"'])
  t.absent(manifest.includes('pathPrefix="/p/"') || manifest.includes('pathPrefix="/p"'), 'the public /p/ web page stays in the browser')
  t.absent(manifest.includes('pathPrefix="/f/"'), 'the public listing page stays in the browser')
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
