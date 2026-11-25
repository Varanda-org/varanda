const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const WORKFLOW = path.join(repoRoot, '.github/workflows/ios-release.yml')
const EAS_JSON = path.join(repoRoot, 'apps/app/eas.json')
const EASIGNORE = path.join(repoRoot, '.easignore')

// ios-release.yml, checked with line and regex rules like deploy.test.js (no
// YAML parser available). Comment lines are dropped so prose cannot satisfy or
// trip a rule. The job holds the Expo token and ships to App Store Connect, so
// the rules keep it on main, behind the variable, with pinned actions, no
// install scripts and nothing spliced into a script.
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

const job = block(/^ {2}testflight:\s*$/, /^ {2}\S/)
const supersede = block(/^ {2}supersede:\s*$/, /^ {2}\S/)
const GUARD = "github\\.repository == 'Varanda-org\\/varanda' && github\\.ref == 'refs\\/heads\\/main' && vars\\.VARANDA_IOS_RELEASE == 'true'"
// testflight also needs the supersede job's go (apps/cli/test/supersede.test.js).
const GO = " && needs\\.supersede\\.outputs\\.go == 'true'"

test('ios-release.yml: actions pinned to the commits ci.yml uses', (t) => {
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

test('ios-release.yml: permissions, triggers, concurrency and the one job', (t) => {
  const top = block(/^permissions:/, /^\S/)
  const topLines = top.split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(topLines, ['contents: read'], 'top-level permissions are contents: read only')
  t.is((code.match(/^ {4}permissions:/gm) || []).length, 2, 'only supersede and testflight have their own permissions')
  t.ok(/^ {4}permissions:\s*\n {6}actions: write\s*$/m.test(supersede), 'supersede, with actions: write only')
  // actions: read for the freshness check after the approval, nothing more.
  const jobPerms = block(/^ {4}permissions:\s*$/, /^ {4}\S/, job.split('\n')).split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
  t.alike(jobPerms, ['actions: read', 'contents: read'], 'testflight may only read runs and contents')

  const on = block(/^on:/, /^\S/)
  const triggers = (on.match(/^ {2}\S+:/gm) || []).map((s) => s.trim())
  t.alike(triggers, ['push:', 'workflow_dispatch:'], 'triggers are push and workflow_dispatch only')
  t.ok(/^ {4}branches:\s*\[main\]\s*$/m.test(on), 'push on main only')
  const paths = (on.match(/^ {6}- '([^']+)'\s*$/gm) || []).map((l) => l.trim().slice(3, -1))
  for (const p of ['apps/app/**', 'packages/**', 'package.json', 'package-lock.json', '.easignore', '.github/workflows/ios-release.yml']) {
    t.ok(paths.includes(p), 'push paths include ' + p)
  }
  t.absent(/paths-ignore:/.test(on), 'no paths-ignore')

  t.absent(/^concurrency:/m.test(code), 'no workflow concurrency: a run waiting for approval would hold the newer one back')
  t.ok(/^ {6}group:\s*ios-release-\$\{\{ github\.ref \}\}\s*$/m.test(job), 'testflight concurrency group is ios-release-<ref>')
  t.ok(/^ {6}cancel-in-progress:\s*false\s*$/m.test(job), 'testflight cancel-in-progress is false')

  const jobs = block(/^jobs:/, /^\S/).split('\n').filter((l) => /^ {2}[A-Za-z0-9_-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''))
  t.alike(jobs, ['supersede', 'testflight'], 'supersede, then testflight')
  t.ok(new RegExp('^ {4}if:\\s*' + GUARD + '\\s*$', 'm').test(supersede), 'supersede: repository, branch and variable guard')
  t.ok(new RegExp('^ {4}if:\\s*' + GUARD + GO + '\\s*$', 'm').test(job), 'testflight: the same guard plus the supersede go')
  t.ok(/^ {4}needs:\s*supersede\s*$/m.test(job), 'testflight needs supersede')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(job), 'runs-on ubuntu-24.04')
  t.ok(/^ {4}timeout-minutes:\s*\d+\s*$/m.test(job), 'has a timeout')
  t.ok(/^ {6}name:\s*app-store\s*$/m.test(job), 'uses the app-store environment')
})

test('ios-release.yml: install from lockfiles without scripts and the exact eas command', (t) => {
  const npmCi = lines.filter((l) => /npm ci\b/.test(l))
  t.is(npmCi.length, 2, 'two npm ci: the repository and eas-cli')
  for (const l of npmCi) t.ok(/^\s+run: npm ci --ignore-scripts\s*$/.test(l), 'npm ci --ignore-scripts: ' + l.trim())
  // eas-cli runs with EXPO_TOKEN: every one of its dependencies comes from
  // .github/eas-cli/package-lock.json (checked in android-release.test.js).
  t.ok(/^ {8}working-directory:\s*\.github\/eas-cli\s*\n {8}run: npm ci --ignore-scripts\s*$/m.test(job), 'eas-cli installed by npm ci in .github/eas-cli')
  t.absent(/\bnpm (install|i|add|exec|x)\b|\bnpx\b|--global\b|\s-g\b/.test(code), 'nothing installed outside a lockfile')

  const builds = lines.filter((l) => /\beas build\b/.test(l))
  t.is(builds.length, 1, 'one eas build')
  const b = builds[0]
  t.ok(/^\s+"\$GITHUB_WORKSPACE"\/\.github\/eas-cli\/node_modules\/\.bin\/eas build /.test(b), 'the eas of .github/eas-cli runs the build')
  for (const flag of ['--platform ios', '--profile production', '--auto-submit', '--non-interactive', '--json']) {
    t.ok(b.includes(flag), 'eas build has ' + flag)
  }
  // --no-wait unless the plan step chose a release: then eas waits for the
  // build and its submission, and its JSON names the build number.
  t.ok(/ --json \$wait_flag > "\$RUNNER_TEMP\/eas-build\.json"\s*$/.test(b), 'JSON output to $RUNNER_TEMP/eas-build.json')
  t.ok(/^ {10}wait_flag=--no-wait\s*$/m.test(job), 'no-wait by default')
  t.ok(/^ {10}if \[ "\$RELEASE" = true \]; then wait_flag=; fi\s*$/m.test(job), 'waits only on a release')
  t.ok(/^ {10}RELEASE:\s*\$\{\{ steps\.plan\.outputs\.release \}\}\s*$/m.test(job), 'RELEASE from the plan step')
  t.absent(/eas (submit|update|workflow)/.test(code), 'no other eas command')
  t.ok(/^ {8}working-directory:\s*apps\/app\s*$/m.test(job), 'eas runs from apps/app')
  t.ok(/^ {10}DISABLE_EAS_ANALYTICS:\s*'1'\s*$/m.test(job), 'eas analytics off')
  t.ok(/^ {10}EXPO_NO_CAPABILITY_SYNC:\s*'1'\s*$/m.test(job), 'eas never changes capabilities in the Apple account')
})

test('ios-release.yml: no npm cache in the job that holds EXPO_TOKEN', (t) => {
  // A cache another run wrote would feed the job that runs with the token.
  t.absent(/^\s+cache:/m.test(job), 'setup-node has no cache:')
  t.absent(/cache-dependency-path:/.test(job), 'no cache-dependency-path')
  // setup-node turns the npm cache on by itself when package.json names npm
  // as its packageManager; false keeps it off whatever package.json says.
  t.ok(/uses:\s*actions\/setup-node@[0-9a-f]{40}[^\n]*\n {8}with:\s*\n {10}node-version:\s*'24'\s*\n {10}package-manager-cache:\s*false\s*$/m.test(job), 'setup-node with package-manager-cache: false')
})

const steps = block(/^ {4}steps:\s*$/, /^ {4}\S/, job.split('\n')).split('\n').slice(1).join('\n').split(/\n(?= {6}- )/)
const stepName = (s) => s.split('\n').map((l) => l.trim()).find((l) => /^(uses|run|name):/.test(l))
const SUBMIT = "steps\\.fresh\\.outputs\\.go == 'true' && steps\\.plan\\.outputs\\.release == 'true'"

test('ios-release.yml: testflight checks again, after the approval, that no newer run exists', (t) => {
  // The shared script and its behaviour are in apps/cli/test/supersede.test.js.
  t.ok(/^ {6}- id: fresh\s*$/m.test(steps[0]), 'the first step is fresh')
  t.ok(steps.length > 1, 'steps after it')
  for (const s of steps.slice(1)) {
    const first = s.split('\n')[0]
    t.ok(/^ {6}- if: steps\.fresh\.outputs\.go == 'true'\s*$/.test(first) || new RegExp('^ {6}- if: ' + SUBMIT + '\\s*$').test(first), 'runs only on a fresh go: ' + stepName(s))
  }
})

test('ios-release.yml: a version bump goes to App Review through scripts/ios-app-review.js', (t) => {
  // The script and its requests are in apps/cli/test/ios-app-review.test.js.
  const names = steps.map(stepName)
  const at = (re) => names.findIndex((n) => re.test(n))
  const plan = at(/Check the version and whether it goes to App Review/)
  const build = at(/Build and submit to TestFlight/)
  const submit = at(/Send the version to App Review/)
  const install = at(/run: npm ci/)
  t.ok(plan > 0 && plan < install && install < build && build < submit, 'plan before any install, then build, then submit')
  t.is(submit, steps.length - 1, 'submit is the last step')
  t.ok(/^ {8}id: plan\s*$/m.test(steps[plan]), 'plan step id')
  t.ok(/^ {8}run: node scripts\/ios-app-review\.js plan\s*$/m.test(steps[plan]), 'plan runs the script')
  t.ok(new RegExp('^ {6}- if: ' + SUBMIT + '\\s*$', 'm').test(steps[submit]), 'submit only when the plan chose a release')
  t.ok(/^ {8}run: node scripts\/ios-app-review\.js submit "\$RUNNER_TEMP\/eas-build\.json"\s*$/m.test(steps[submit]), 'submit reads the eas output')
  const ascSecrets = (s) => [...s.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort()
  for (const i of [plan, submit]) {
    t.alike(ascSecrets(steps[i]), ['ASC_API_ISSUER_ID', 'ASC_API_KEY_ID', 'ASC_API_KEY_P8'], 'only the App Store Connect key: ' + names[i])
    t.absent(/working-directory:/.test(steps[i]), 'runs from the repository root')
  }
  t.alike(ascSecrets(steps[build]), ['EXPO_TOKEN'], 'the build step holds only EXPO_TOKEN')
  for (const [i, s] of steps.entries()) {
    if (i !== plan && i !== submit) t.absent(/ASC_API/.test(s), 'no App Store Connect key in: ' + names[i])
  }
  t.ok(/^ {4}timeout-minutes:\s*180\s*$/m.test(job), 'room for the EAS build and the App Store Connect processing')
})

test('ios-release.yml: only the Expo and App Store Connect secrets and VARANDA_IOS_RELEASE, only in env: or if:', (t) => {
  const secrets = new Set([...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  const vars = new Set([...code.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  t.alike([...secrets].sort(), ['ASC_API_ISSUER_ID', 'ASC_API_KEY_ID', 'ASC_API_KEY_P8', 'EXPO_TOKEN'], 'secret names')
  t.alike([...vars], ['VARANDA_IOS_RELEASE'], 'variable names')
  t.absent(/\bsecrets:\s*inherit/.test(code), 'no secrets: inherit')
  t.absent(/toJSON\((secrets|vars)/i.test(code), 'no dump of the secrets or vars context')
  for (const l of lines) {
    if (!/\b(secrets|vars)\./.test(l)) continue
    const ok = /^\s+if:\s/.test(l) || /^\s+[A-Z][A-Z0-9_]*:\s*\$\{\{\s*(secrets|vars)\.[A-Za-z0-9_]+\s*\}\}\s*$/.test(l)
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
  t.ok(/^\d+$/.test(eas.submit.production.ios.ascAppId), 'submit profile names the App Store Connect app')
})

test('.easignore keeps App Store Connect keys and certificates out of the upload', (t) => {
  const ignore = fs.readFileSync(EASIGNORE, 'utf8').split('\n').map((l) => l.trim())
  for (const p of ['*.p8', '*.p12', '**/.env']) t.ok(ignore.includes(p), '.easignore has ' + p)
})
