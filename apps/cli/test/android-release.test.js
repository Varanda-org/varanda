const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const IOS_WORKFLOW = path.join(repoRoot, '.github/workflows/ios-release.yml')
const WORKFLOW = path.join(repoRoot, '.github/workflows/android-release.yml')
const EAS_JSON = path.join(repoRoot, 'apps/app/eas.json')
const EASIGNORE = path.join(repoRoot, '.easignore')

// android-release.yml, checked with line and regex rules like deploy.test.js
// (no YAML parser available). Comment lines are dropped so prose cannot
// satisfy or trip a rule. The job holds the Expo token and ships to Google
// Play, so the rules keep it on main, behind the variable, with pinned
// actions, no install scripts and nothing spliced into a script.
const yml = fs.readFileSync(WORKFLOW, 'utf8')
const lines = yml.split('\n').filter((l) => !/^\s*#/.test(l))
const code = lines.join('\n')

function block (startRe, endRe) {
  const start = lines.findIndex((l) => startRe.test(l))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (endRe.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

const job = block(/^ {2}play:\s*$/, /^ {2}\S/)
const supersede = block(/^ {2}supersede:\s*$/, /^ {2}\S/)
const GUARD = "github\\.repository == 'Varanda-org\\/varanda' && github\\.ref == 'refs\\/heads\\/main' && vars\\.VARANDA_ANDROID_RELEASE == 'true'"
// play also needs the supersede job's go (apps/cli/test/supersede.test.js).
const GO = " && needs\\.supersede\\.outputs\\.go == 'true'"

test('android-release.yml: actions pinned to the commits ci.yml uses', (t) => {
  const pins = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020'
  }
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.is(uses.length, 2, 'two uses: lines')
  for (const u of uses) {
    const [name, ref] = u.split('@')
    t.ok(name in pins, 'only checkout and setup-node: ' + name)
    t.is(ref, pins[name], 'expected pin for ' + name)
  }
  t.ok(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false/.test(code), 'checkout has persist-credentials: false')
})

test('android-release.yml: permissions, triggers, concurrency and the one job', (t) => {
  const top = block(/^permissions:/, /^\S/)
  const topLines = top.split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(topLines, ['contents: read'], 'top-level permissions are contents: read only')
  t.is((code.match(/^ {4}permissions:/gm) || []).length, 1, 'only one job has its own permissions')
  t.ok(/^ {4}permissions:\s*\n {6}actions: write\s*$/m.test(supersede), 'supersede, with actions: write only')
  t.absent(/^ {4}permissions:/m.test(job), 'play keeps contents: read')

  const on = block(/^on:/, /^\S/)
  const triggers = (on.match(/^ {2}\S+:/gm) || []).map((s) => s.trim())
  t.alike(triggers, ['push:', 'workflow_dispatch:'], 'triggers are push and workflow_dispatch only')
  t.ok(/^ {4}branches:\s*\[main\]\s*$/m.test(on), 'push on main only')
  const paths = (on.match(/^ {6}- '([^']+)'\s*$/gm) || []).map((l) => l.trim().slice(3, -1))
  for (const p of ['apps/app/**', 'packages/**', 'package.json', 'package-lock.json', '.easignore', '.github/workflows/android-release.yml']) {
    t.ok(paths.includes(p), 'push paths include ' + p)
  }
  t.absent(/paths-ignore:/.test(on), 'no paths-ignore')

  t.absent(/^concurrency:/m.test(code), 'no workflow concurrency: a run waiting for approval would hold the newer one back')
  t.ok(/^ {6}group:\s*android-release-\$\{\{ github\.ref \}\}\s*$/m.test(job), 'play concurrency group is android-release-<ref>')
  t.ok(/^ {6}cancel-in-progress:\s*false\s*$/m.test(job), 'play cancel-in-progress is false')

  const jobs = block(/^jobs:/, /^\S/).split('\n').filter((l) => /^ {2}[A-Za-z0-9_-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''))
  t.alike(jobs, ['supersede', 'play'], 'supersede, then play')
  t.ok(new RegExp('^ {4}if:\\s*' + GUARD + '\\s*$', 'm').test(supersede), 'supersede: repository, branch and variable guard')
  t.ok(new RegExp('^ {4}if:\\s*' + GUARD + GO + '\\s*$', 'm').test(job), 'play: the same guard plus the supersede go')
  t.ok(/^ {4}needs:\s*supersede\s*$/m.test(job), 'play needs supersede')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(job), 'runs-on ubuntu-24.04')
  t.ok(/^ {4}timeout-minutes:\s*\d+\s*$/m.test(job), 'has a timeout')
  t.ok(/^ {6}name:\s*play-store\s*$/m.test(job), 'uses the play-store environment')
})

test('android-release.yml: install without scripts and the exact eas command', (t) => {
  const npmCi = lines.filter((l) => /npm ci\b/.test(l))
  t.is(npmCi.length, 1, 'one npm ci')
  t.ok(/--ignore-scripts/.test(npmCi[0]), 'npm ci has --ignore-scripts')

  const easInstall = lines.filter((l) => /eas-cli/.test(l))
  t.is(easInstall.length, 1, 'one eas-cli install')
  t.ok(/^\s+- run: npm install --global --ignore-scripts eas-cli@\d+\.\d+\.\d+\s*$/.test(easInstall[0]), 'eas-cli at an exact version, without install scripts')

  const builds = lines.filter((l) => /\beas build\b/.test(l))
  t.is(builds.length, 1, 'one eas build')
  const b = builds[0]
  for (const flag of ['--platform android', '--profile production', '--auto-submit', '--non-interactive', '--no-wait']) {
    t.ok(b.includes(flag), 'eas build has ' + flag)
  }
  t.absent(/eas (submit|update|workflow)/.test(code), 'no other eas command')
  t.ok(/^ {8}working-directory:\s*apps\/app\s*$/m.test(job), 'eas runs from apps/app')
  t.ok(/^ {10}DISABLE_EAS_ANALYTICS:\s*'1'\s*$/m.test(job), 'eas analytics off')
  t.ok(/^ {10}EXPO_NO_TELEMETRY:\s*'1'\s*$/m.test(job), 'expo telemetry off')
  t.ok(/^ {10}if \[ -z "\$EXPO_TOKEN" \]; then\s*$/m.test(job), 'fails when EXPO_TOKEN is empty')

  // The same eas-cli as the iOS release: one version to vet for both stores.
  const iosEas = fs.readFileSync(IOS_WORKFLOW, 'utf8').match(/eas-cli@(\d+\.\d+\.\d+)/)
  t.ok(iosEas && easInstall[0].trim().endsWith('eas-cli@' + iosEas[1]), 'same eas-cli as ios-release.yml')
})

test('android-release.yml: only EXPO_TOKEN and VARANDA_ANDROID_RELEASE, only in env: or if:', (t) => {
  const secrets = new Set([...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  const vars = new Set([...code.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  t.alike([...secrets], ['EXPO_TOKEN'], 'secret names')
  t.alike([...vars], ['VARANDA_ANDROID_RELEASE'], 'variable names')
  t.absent(/\bsecrets:\s*inherit/.test(code), 'no secrets: inherit')
  t.absent(/toJSON\((secrets|vars)/i.test(code), 'no dump of the secrets or vars context')
  for (const l of lines) {
    if (!/\b(secrets|vars)\./.test(l)) continue
    const ok = /^\s+if:\s/.test(l) || /^\s+[A-Z_]+:\s*\$\{\{\s*(secrets|vars)\.[A-Za-z0-9_]+\s*\}\}\s*$/.test(l)
    t.ok(ok, 'only in env: or if: -> ' + l.trim())
  }

  let inRun = false
  let runIndent = 0
  for (const l of lines) {
    const m = l.match(/^(\s*)(- )?run:\s*(\|)?(.*)$/)
    if (m) {
      t.absent(/\$\{\{/.test(m[4]), 'no ${{ in a run: line: ' + l.trim())
      inRun = m[3] === '|'
      runIndent = m[1].length + (m[2] ? 2 : 0)
      continue
    }
    if (inRun) {
      if (l.trim() !== '' && l.match(/^\s*/)[0].length <= runIndent) inRun = false
      else t.absent(/\$\{\{/.test(l), 'no ${{ inside a run: block: ' + l.trim())
    }
  }
  t.absent(/\bworkflow_run\b/.test(yml), 'absent: workflow_run')
  for (const bad of ['pull_request', 'continue-on-error', 'self-hosted', '<<:', '\u2014']) {
    t.absent(yml.includes(bad), 'absent: ' + bad)
  }
})

test('eas.json: the production build and submit profiles the workflow uses', (t) => {
  const eas = JSON.parse(fs.readFileSync(EAS_JSON, 'utf8'))
  t.is(eas.cli.appVersionSource, 'remote', 'EAS keeps the build number')
  const prod = eas.build.production
  t.ok(prod, 'production build profile')
  t.absent(prod.extends, 'production does not inherit the internal preview profile')
  t.absent(prod.distribution && prod.distribution !== 'store', 'store distribution')
  t.is(prod.autoIncrement, true, 'build number raised on every build')
  t.is(prod.node, eas.build.preview.node, 'same Node as preview (the worklet pack needs it)')
  t.is(prod.environment, 'production', 'EAS production environment variables')
  // The EAS builder runs a plain npm ci at the root; sharp's install script
  // (from apps/cli) then tries to compile and the iOS build fails.
  t.alike(prod.env, { npm_config_ignore_scripts: 'true' }, 'no dependency install scripts on the builder')
  t.ok(/^\d+$/.test(eas.submit.production.ios.ascAppId), 'the iOS submit profile is kept')

  // Play takes app bundles only; versionCode stays with EAS, never in build.gradle.
  t.alike(prod.android, { buildType: 'app-bundle' }, 'production builds an app bundle, nothing else overridden')
  // Draft on the internal track: a person rolls it out in the Play Console.
  // The service account key lives in EAS credentials, never in the repository.
  t.alike(eas.submit.production.android, { track: 'internal', releaseStatus: 'draft' }, 'internal track, draft, no key path')
  t.absent(fs.readFileSync(EAS_JSON, 'utf8').includes('serviceAccountKeyPath'), 'no serviceAccountKeyPath anywhere in eas.json')
})

test('.easignore keeps the Play keys, keystores and the Firebase config out of the upload', (t) => {
  const ignore = fs.readFileSync(EASIGNORE, 'utf8').split('\n').map((l) => l.trim())
  for (const p of ['*.jks', '*.keystore', '**/google-services.json', '**/key.properties', 'credentials.json', '**/.env']) {
    t.ok(ignore.includes(p), '.easignore has ' + p)
  }
})
