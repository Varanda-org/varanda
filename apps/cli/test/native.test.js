const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../../..')
const WORKFLOW = path.join(repoRoot, '.github/workflows/native.yml')

// native.yml, checked with line and regex rules like ci.test.js (no YAML
// parser available). Comment lines are dropped so prose cannot satisfy or
// trip a rule. The workflow builds code from pull requests, so the rules
// below are the ones that keep that safe: pinned actions, a read-only token,
// no secrets, no pull_request_target, no install scripts, no expression
// spliced into a shell script.
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

const job = (id) => block(new RegExp('^ {2}' + id + ':\\s*$'), /^ {2}\S/)
const BUILDS = ['js-bundles', 'android-build', 'ios-build']

test('native.yml: actions pinned to the commits ci.yml uses', (t) => {
  const pins = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020'
  }
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.ok(uses.length > 0, 'uses: lines present')
  for (const u of uses) {
    const [name, ref] = u.split('@')
    t.ok(name in pins, 'only checkout and setup-node: ' + name)
    t.is(ref, pins[name], 'expected pin for ' + name)
  }
  const checkouts = code.split(/uses:\s*actions\/checkout@/).slice(1)
  t.is(checkouts.length, 4, 'one checkout per job that needs the tree')
  for (const after of checkouts) t.ok(/^\S+[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false/.test(after), 'checkout has persist-credentials: false')
})

test('native.yml: install, permissions, concurrency and triggers', (t) => {
  const npmCi = lines.filter((l) => /npm ci\b/.test(l))
  t.is(npmCi.length, 3, 'npm ci in the three build jobs')
  for (const l of npmCi) t.ok(/--ignore-scripts/.test(l), 'npm ci has --ignore-scripts: ' + l.trim())

  const top = block(/^permissions:/, /^\S/)
  const topLines = top.split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(topLines, ['contents: read'], 'top-level permissions are contents: read only')
  t.absent(/^ {4}permissions:/m.test(code), 'no job widens the permissions')

  t.ok(/^ {2}group:\s*native-\$\{\{ github\.ref \}\}\s*$/m.test(code), 'concurrency group is native-<ref>')
  t.ok(/^ {2}cancel-in-progress:\s*true\s*$/m.test(code), 'cancel-in-progress is true')

  const on = block(/^on:/, /^\S/)
  const triggers = (on.match(/^ {2}\S+:/gm) || []).map((s) => s.trim())
  t.alike(triggers, ['pull_request:', 'push:'], 'triggers are pull_request and push only')
  t.ok(/^ {4}branches:\s*\[main\]\s*$/m.test(on), 'push on main only')
  t.absent(/paths(-ignore)?:/.test(on), 'no path filters: the changes job decides, so the gate always reports')
})

test('native.yml: jobs, runners and the change filter', (t) => {
  const ids = (code.match(/^ {2}[a-z0-9-]+:\s*$/gm) || []).map((s) => s.trim().slice(0, -1))
  const jobsStart = ids.indexOf('changes')
  t.alike(ids.slice(jobsStart), ['changes', ...BUILDS, 'native'], 'the five jobs, in order')

  t.ok(/runs-on:\s*ubuntu-24\.04/.test(job('changes')))
  t.ok(/runs-on:\s*ubuntu-24\.04/.test(job('js-bundles')))
  t.ok(/runs-on:\s*ubuntu-24\.04/.test(job('android-build')))
  t.ok(/runs-on:\s*macos-26/.test(job('ios-build')))
  for (const id of BUILDS) {
    const j = job(id)
    t.ok(/^ {4}needs:\s*changes\s*$/m.test(j), id + ' needs changes')
    t.ok(/^ {4}if:\s*needs\.changes\.outputs\.app == 'true'\s*$/m.test(j), id + ' runs only when the app changed')
    t.ok(/timeout-minutes:\s*\d+/.test(j), id + ' has a timeout')
  }

  const filter = job('changes')
  t.ok(/fetch-depth:\s*0/.test(filter), 'full history to diff the range')
  // Unquoted, NUL-separated, both sides of a rename: a non-ASCII path or a
  // rename out of the app cannot hide from the filter.
  t.ok(/git -c core\.quotePath=false diff --name-only --no-renames -z /.test(filter), 'unambiguous path listing')
  // Fail closed: skip only when every path is on the allow-list of paths
  // outside the app; the app's own paths are never on it.
  t.ok(/grep -Ezvq '/.test(filter), 'any path off the allow-list builds')
  const allow = (filter.match(/grep -Ezvq '([^']+)'/) || [])[1] || ''
  for (const p of ['docs/', 'apps/(site|cli)/', 'deploy/']) t.ok(allow.includes(p), 'allow-listed: ' + p)
  for (const p of ['apps/app', 'packages/', 'package-lock', 'native.yml', 'scripts/']) t.absent(allow.includes(p), 'never allow-listed: ' + p)
})

test('native.yml: the builds the job names promise', (t) => {
  const js = job('js-bundles')
  t.ok(/expo export --platform android/.test(js), 'android export')
  t.ok(/expo export --platform ios/.test(js), 'ios export')

  const android = job('android-build')
  t.ok(/"ndk;27\.1\.12297006"/.test(android), 'the NDK React Native 0.83 builds with')
  t.ok(/prepare:native -w apps\/app -- android/.test(android))
  t.ok(/\.\/gradlew assembleDebug/.test(android))
  t.absent(/assembleRelease|bundleRelease/.test(android), 'no release build (it needs the release key)')

  const ios = job('ios-build')
  t.ok(/xcode-select -s \/Applications\/Xcode_26\.2\.app/.test(ios), 'the Xcode the app is checked with')
  t.ok(/prepare:native -w apps\/app -- ios/.test(ios))
  t.ok(/check-pods-lock\.js/.test(ios), 'the committed Podfile.lock is checked')
  t.ok(/-sdk iphonesimulator/.test(ios) && /CODE_SIGNING_ALLOWED=NO/.test(ios), 'unsigned simulator build')
})

test('native.yml: the gate', (t) => {
  const gate = job('native')
  t.ok(/^ {4}if:\s*always\(\)\s*$/m.test(gate), 'the gate always runs')
  t.ok(/^ {4}needs:\s*\[changes, js-bundles, android-build, ios-build\]\s*$/m.test(gate), 'the gate needs every job')
  t.absent(/test \((20|24)\)/.test(code), 'no job takes a required ci.yml name')
})

test('native.yml: nothing spliced into a script, no secrets, no unsafe triggers', (t) => {
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
  for (const bad of ['secrets.', 'pull_request_target', 'workflow_run', 'continue-on-error', 'self-hosted', '<<:', '\u2014']) {
    t.absent(yml.includes(bad), 'absent: ' + bad)
  }
})
