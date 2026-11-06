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

function block (startRe, endRe) {
  const start = lines.findIndex((l) => startRe.test(l))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (endRe.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

const job = block(/^ {2}testflight:\s*$/, /^ {2}\S/)
const GUARD = "github\\.repository == 'Varanda-org\\/varanda' && github\\.ref == 'refs\\/heads\\/main' && vars\\.VARANDA_IOS_RELEASE == 'true'"

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
  t.absent(/^ {4}permissions:/m.test(code), 'no job widens the permissions')

  const on = block(/^on:/, /^\S/)
  const triggers = (on.match(/^ {2}\S+:/gm) || []).map((s) => s.trim())
  t.alike(triggers, ['push:', 'workflow_dispatch:'], 'triggers are push and workflow_dispatch only')
  t.ok(/^ {4}branches:\s*\[main\]\s*$/m.test(on), 'push on main only')
  const paths = (on.match(/^ {6}- '([^']+)'\s*$/gm) || []).map((l) => l.trim().slice(3, -1))
  for (const p of ['apps/app/**', 'packages/**', 'package.json', 'package-lock.json', '.easignore', '.github/workflows/ios-release.yml']) {
    t.ok(paths.includes(p), 'push paths include ' + p)
  }
  t.absent(/paths-ignore:/.test(on), 'no paths-ignore')

  t.ok(/^ {2}group:\s*ios-release-\$\{\{ github\.ref \}\}\s*$/m.test(code), 'concurrency group is ios-release-<ref>')
  t.ok(/^ {2}cancel-in-progress:\s*false\s*$/m.test(code), 'cancel-in-progress is false')

  const jobs = block(/^jobs:/, /^\S/).split('\n').filter((l) => /^ {2}[A-Za-z0-9_-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ''))
  t.alike(jobs, ['testflight'], 'one job, testflight')
  t.ok(new RegExp('^ {4}if:\\s*' + GUARD + '\\s*$', 'm').test(job), 'repository, branch and variable guard')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(job), 'runs-on ubuntu-24.04')
  t.ok(/^ {4}timeout-minutes:\s*\d+\s*$/m.test(job), 'has a timeout')
  t.ok(/^ {6}name:\s*app-store\s*$/m.test(job), 'uses the app-store environment')
})

test('ios-release.yml: install without scripts and the exact eas command', (t) => {
  const npmCi = lines.filter((l) => /npm ci\b/.test(l))
  t.is(npmCi.length, 1, 'one npm ci')
  t.ok(/--ignore-scripts/.test(npmCi[0]), 'npm ci has --ignore-scripts')

  const easInstall = lines.filter((l) => /eas-cli/.test(l))
  t.is(easInstall.length, 1, 'one eas-cli install')
  t.ok(/^\s+- run: npm install --global --ignore-scripts eas-cli@\d+\.\d+\.\d+\s*$/.test(easInstall[0]), 'eas-cli at an exact version, without install scripts')

  const builds = lines.filter((l) => /\beas build\b/.test(l))
  t.is(builds.length, 1, 'one eas build')
  const b = builds[0]
  for (const flag of ['--platform ios', '--profile production', '--auto-submit', '--non-interactive', '--no-wait']) {
    t.ok(b.includes(flag), 'eas build has ' + flag)
  }
  t.absent(/eas (submit|update|workflow)/.test(code), 'no other eas command')
  t.ok(/^ {8}working-directory:\s*apps\/app\s*$/m.test(job), 'eas runs from apps/app')
  t.ok(/^ {10}DISABLE_EAS_ANALYTICS:\s*'1'\s*$/m.test(job), 'eas analytics off')
})

test('ios-release.yml: only EXPO_TOKEN and VARANDA_IOS_RELEASE, only in env: or if:', (t) => {
  const secrets = new Set([...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  const vars = new Set([...code.matchAll(/vars\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  t.alike([...secrets], ['EXPO_TOKEN'], 'secret names')
  t.alike([...vars], ['VARANDA_IOS_RELEASE'], 'variable names')
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
  for (const bad of ['pull_request', 'workflow_run', 'continue-on-error', 'self-hosted', '<<:', '\u2014']) {
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
