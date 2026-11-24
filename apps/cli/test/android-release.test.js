const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const IOS_WORKFLOW = path.join(repoRoot, '.github/workflows/ios-release.yml')
const WORKFLOW = path.join(repoRoot, '.github/workflows/android-release.yml')
const EAS_JSON = path.join(repoRoot, 'apps/app/eas.json')
const EASIGNORE = path.join(repoRoot, '.easignore')
const EAS_CLI_DIR = path.join(repoRoot, '.github/eas-cli')

// android-release.yml, checked with line and regex rules like deploy.test.js
// (no YAML parser available). Comment lines are dropped so prose cannot
// satisfy or trip a rule. The job holds the Expo token and ships to Google
// Play, so the rules keep it on main, behind the variable, with pinned
// actions, no install scripts and nothing spliced into a script.
const yml = fs.readFileSync(WORKFLOW, 'utf8')
const lines = yml.split('\n').filter((l) => !/^\s*#/.test(l))
const code = lines.join('\n')

function block (startRe, endRe, from = lines) {
  const start = from.findIndex((l) => startRe.test(l))
  if (start === -1) return ''
  let end = from.length
  for (let i = start + 1; i < from.length; i++) {
    if (endRe.test(from[i])) { end = i; break }
  }
  return from.slice(start, end).join('\n')
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
  t.is((code.match(/^ {4}permissions:/gm) || []).length, 2, 'only supersede and play have their own permissions')
  t.ok(/^ {4}permissions:\s*\n {6}actions: write\s*$/m.test(supersede), 'supersede, with actions: write only')
  // actions: read for the freshness check after the approval, nothing more.
  const playPerms = block(/^ {4}permissions:\s*$/, /^ {4}\S/, job.split('\n')).split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
  t.alike(playPerms, ['actions: read', 'contents: read'], 'play may only read runs and contents')

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
  t.ok(/^ {6}name:\s*google-play\s*$/m.test(job), 'uses the google-play environment')
})

test('android-release.yml: install from lockfiles without scripts and the exact eas command', (t) => {
  const npmCi = lines.filter((l) => /npm ci\b/.test(l))
  t.is(npmCi.length, 2, 'two npm ci: the repository and eas-cli')
  for (const l of npmCi) t.ok(/^\s+run: npm ci --ignore-scripts\s*$/.test(l), 'npm ci --ignore-scripts: ' + l.trim())
  // eas-cli runs with EXPO_TOKEN: every one of its dependencies comes from
  // .github/eas-cli/package-lock.json, never from a fresh resolution.
  t.ok(/^ {8}working-directory:\s*\.github\/eas-cli\s*\n {8}run: npm ci --ignore-scripts\s*$/m.test(job), 'eas-cli installed by npm ci in .github/eas-cli')
  t.absent(/\bnpm (install|i|add|exec|x)\b|\bnpx\b|--global\b|\s-g\b/.test(code), 'nothing installed outside a lockfile')

  const builds = lines.filter((l) => /\beas build\b/.test(l))
  t.is(builds.length, 1, 'one eas build')
  const b = builds[0]
  t.ok(/^\s+"\$GITHUB_WORKSPACE"\/\.github\/eas-cli\/node_modules\/\.bin\/eas build /.test(b), 'the eas of .github/eas-cli runs the build')
  for (const flag of ['--platform android', '--profile production', '--auto-submit', '--non-interactive', '--no-wait']) {
    t.ok(b.includes(flag), 'eas build has ' + flag)
  }
  t.absent(/eas (submit|update|workflow)/.test(code), 'no other eas command')
  t.ok(/^ {8}working-directory:\s*apps\/app\s*$/m.test(job), 'eas runs from apps/app')
  t.ok(/^ {10}DISABLE_EAS_ANALYTICS:\s*'1'\s*$/m.test(job), 'eas analytics off')
  t.ok(/^ {10}EXPO_NO_TELEMETRY:\s*'1'\s*$/m.test(job), 'expo telemetry off')
  t.ok(/^ {10}if \[ -z "\$EXPO_TOKEN" \]; then\s*$/m.test(job), 'fails when EXPO_TOKEN is empty')

  // The same eas-cli as the iOS release: one lockfile to vet for both stores.
  const ios = fs.readFileSync(IOS_WORKFLOW, 'utf8')
  t.ok(/^ {8}working-directory:\s*\.github\/eas-cli\s*\n {8}run: npm ci --ignore-scripts\s*$/m.test(ios), 'ios-release.yml installs the same eas-cli')
})

test('android-release.yml: no npm cache in the job that holds EXPO_TOKEN', (t) => {
  // A cache another run wrote would feed the job that runs with the token.
  t.absent(/^\s+cache:/m.test(job), 'setup-node has no cache:')
  t.absent(/cache-dependency-path:/.test(job), 'no cache-dependency-path')
  // setup-node turns the npm cache on by itself when package.json names npm
  // as its packageManager; false keeps it off whatever package.json says.
  t.ok(/uses:\s*actions\/setup-node@[0-9a-f]{40}[^\n]*\n {8}with:\s*\n {10}node-version:\s*'24'\s*\n {10}package-manager-cache:\s*false\s*$/m.test(job), 'setup-node with package-manager-cache: false')
})

test('.github/eas-cli: one exact eas-cli, every package fixed by the lockfile', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(EAS_CLI_DIR, 'package.json'), 'utf8'))
  t.ok(pkg.private, 'private, never published')
  t.alike(Object.keys(pkg.dependencies), ['eas-cli'], 'eas-cli is the one dependency')
  const version = pkg.dependencies['eas-cli']
  t.ok(/^\d+\.\d+\.\d+$/.test(version), 'eas-cli at an exact version: ' + version)
  for (const k of ['devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'overrides', 'scripts', 'workspaces']) {
    t.absent(k in pkg, 'no ' + k)
  }

  const lock = JSON.parse(fs.readFileSync(path.join(EAS_CLI_DIR, 'package-lock.json'), 'utf8'))
  t.is(lock.lockfileVersion, 3, 'lockfile version 3')
  t.alike(lock.packages[''].dependencies, pkg.dependencies, 'the lockfile root matches package.json')
  t.is(lock.packages['node_modules/eas-cli'].version, version, 'the lockfile has that eas-cli')
  const loose = Object.entries(lock.packages).filter(([k, p]) => k !== '' && (
    p.link || !/^https:\/\/registry\.npmjs\.org\//.test(p.resolved || '') || !/^sha512-/.test(p.integrity || '')
  )).map(([k]) => k)
  t.alike(loose, [], 'every package from registry.npmjs.org with a sha512 integrity')

  // Its own project: never a workspace of the monorepo, never in its lockfile.
  const root = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  t.absent(root.workspaces.some((w) => w.startsWith('.github')), 'not a workspace')
  const rootLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
  t.absent(Object.keys(rootLock.packages).some((k) => k.startsWith('.github')), 'not in the root lockfile')

  // The docs name the version the workflows run.
  for (const doc of ['docs/google-play.md', 'docs/development.md']) {
    t.ok(fs.readFileSync(path.join(repoRoot, doc), 'utf8').includes('`eas-cli` ' + version), doc + ' names eas-cli ' + version)
  }
})

test('android-release.yml: play checks again, after the approval, that no newer run exists', (t) => {
  // The shared script and its behaviour are in apps/cli/test/supersede.test.js.
  const steps = block(/^ {4}steps:\s*$/, /^ {4}\S/, job.split('\n')).split('\n').slice(1).join('\n').split(/\n(?= {6}- )/)
  t.ok(/^ {6}- id: fresh\s*$/m.test(steps[0]), 'the first step is fresh')
  t.ok(steps.length > 1, 'steps after it')
  for (const s of steps.slice(1)) {
    t.ok(/^ {6}- if: steps\.fresh\.outputs\.go == 'true'\s*$/m.test(s.split('\n')[0]), 'runs only on a fresh go: ' + s.split('\n').map((l) => l.trim()).find((l) => /^(uses|run|name):/.test(l)))
  }
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
  // Rolled out on the internal track only: the google-play approval is the gate,
  // and any other track stays a person's step in the Play Console.
  // The service account key lives in EAS credentials, never in the repository.
  t.alike(eas.submit.production.android, { track: 'internal', releaseStatus: 'completed' }, 'internal track, completed, no key path')
  t.absent(fs.readFileSync(EAS_JSON, 'utf8').includes('serviceAccountKeyPath'), 'no serviceAccountKeyPath anywhere in eas.json')
})

test('.easignore keeps the Play keys, keystores and the Firebase config out of the upload', (t) => {
  const ignore = fs.readFileSync(EASIGNORE, 'utf8').split('\n').map((l) => l.trim())
  for (const p of ['*.jks', '*.keystore', '**/google-services.json', '**/key.properties', 'credentials.json', '**/.env']) {
    t.ok(ignore.includes(p), '.easignore has ' + p)
  }
})
