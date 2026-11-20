const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { tmpDir } = require('./helpers/net')

const repoRoot = path.resolve(__dirname, '../../..')
const WORKFLOW = path.join(repoRoot, '.github/workflows/ci.yml')

// ci.yml, checked with line and regex rules (no YAML parser available).
// Comment lines are dropped so prose cannot satisfy or trip a rule.
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

// The legs table: the same eight workers per Node version. The skip list of
// `others` is not listed here: it is derived from the other seven below.
const LEGS = {
  'core-1': { WORKSPACE: 'packages/core', VARANDA_TEST_SHARD: '1/2' },
  'core-2': { WORKSPACE: 'packages/core', VARANDA_TEST_SHARD: '2/2' },
  'cli-1': { WORKSPACE: 'apps/cli', VARANDA_TEST_SHARD: '1/2' },
  'cli-2': { WORKSPACE: 'apps/cli', VARANDA_TEST_SHARD: '2/2' },
  'web-member-1': { WORKSPACE: 'packages/web-member', VARANDA_TEST_SHARD: '1/3' },
  'web-member-2': { WORKSPACE: 'packages/web-member', VARANDA_TEST_SHARD: '2/3' },
  'web-member-3': { WORKSPACE: 'packages/web-member', VARANDA_TEST_SHARD: '3/3' },
  others: {}
}
const NODES = ['20', '24']
const workerIds = (node) => Object.keys(LEGS).map((suite) => suite + '-' + node)
const WORKERS = NODES.flatMap(workerIds)
// The output of the `affected` job that runs or skips each sharded workspace.
const OUTPUT = { 'packages/core': 'core', 'apps/cli': 'cli', 'packages/web-member': 'web_member' }
const legOf = (id) => id.slice(0, -('-' + id.slice(-2)).length)
// A workflow expression, spelled so it is not a template string to the linter.
const expr = (inner) => '$' + '{{ ' + inner + ' }}'

function env (text) {
  const out = {}
  let inEnv = false
  for (const l of text.split('\n')) {
    if (/^ {4}env:\s*$/.test(l)) { inEnv = true; continue }
    if (inEnv && /^ {0,4}\S/.test(l)) inEnv = false
    if (!inEnv) continue
    const m = l.match(/^ {6}([A-Z_]+):\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^'(.*)'$/, '$1')
  }
  return out
}

// The env: of the step in a job (keys at ten spaces).
function stepEnv (text) {
  const out = {}
  let inEnv = false
  for (const l of text.split('\n')) {
    if (/^ {6}- env:\s*$/.test(l) || /^ {8}env:\s*$/.test(l)) { inEnv = true; continue }
    if (inEnv && !/^ {10}\S/.test(l)) inEnv = false
    if (!inEnv) continue
    const m = l.match(/^ {10}([A-Z_]+):\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// The first `run: |` script in a job, dedented.
function runScript (text) {
  const ls = text.split('\n')
  const at = ls.findIndex((l) => /^\s+(- )?run:\s*\|\s*$/.test(l))
  if (at === -1) return ''
  const col = ls[at].search(/\S/)
  const body = []
  for (let j = at + 1; j < ls.length; j++) {
    if (ls[j].trim() !== '' && ls[j].search(/\S/) <= col) break
    body.push(ls[j])
  }
  const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)))
  return body.map((l) => l.slice(indent)).join('\n') + '\n'
}

const GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']
const RUNNER_VARS = ['VARANDA_TEST_SHARD', 'VARANDA_TEST_CONCURRENCY', 'VARANDA_TEST_SKIP_WORKSPACES', 'VARANDA_TEST_TIMEOUT_MS', 'VARANDA_TEST_DURATIONS']

function cleanEnv (extra) {
  const childEnv = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH }
  for (const name of [...GIT_VARS, ...RUNNER_VARS, 'GITHUB_OUTPUT', 'BASH_ENV']) delete childEnv[name]
  return Object.assign(childEnv, extra)
}

// As GitHub runs a run: step that names no shell: bash -e.
function bash (script, cwd, extra) {
  return spawnSync('bash', ['-e', '-c', script], { cwd, env: cleanEnv(extra), encoding: 'utf8' })
}

test('ci.yml: actions pinned to the expected commits', (t) => {
  const pins = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020'
  }
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.is(uses.length, 4, 'four uses: lines (affected and the anchor; the workers reuse the anchor)')
  for (const u of uses) {
    const [name, ref] = u.split('@')
    t.ok(/^[0-9a-f]{40}$/.test(ref), 'pinned to a 40-hex SHA: ' + u)
    t.is(ref, pins[name], 'expected pin for ' + name)
  }
  t.alike([...new Set(uses.map((u) => u.split('@')[0]))].sort(), Object.keys(pins).sort())
  const checkouts = (code.match(/uses:\s*actions\/checkout@/g) || []).length
  const shallow = (code.match(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false\s*\n\s+fetch-depth:\s*2\s*\n/g) || []).length
  t.is(shallow, checkouts, 'every checkout has persist-credentials: false and fetch-depth: 2 (the parents of the merge commit)')
})

test('ci.yml: install, permissions, concurrency and triggers', (t) => {
  const npmCi = lines.filter((l) => /npm ci\b/.test(l))
  t.ok(npmCi.length > 0, 'npm ci present')
  for (const l of npmCi) t.ok(/--ignore-scripts/.test(l), 'npm ci has --ignore-scripts: ' + l.trim())

  const top = block(/^permissions:/, /^\S/)
  const topLines = top.split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(topLines, ['contents: read'], 'top-level permissions are contents: read only')

  t.ok(/^ {2}group:\s*ci-\$\{\{ github\.ref \}\}\s*$/m.test(code), 'concurrency group is ci-<ref>')
  t.ok(/^ {2}cancel-in-progress:\s*true\s*$/m.test(code), 'cancel-in-progress is true')

  const on = block(/^on:/, /^\S/)
  const triggers = (on.match(/^ {2}\S+:/gm) || []).map((s) => s.trim())
  t.alike(triggers, ['pull_request:', 'push:'], 'triggers are pull_request and push only')
  t.ok(/^ {4}branches:\s*\[main\]\s*$/m.test(on), 'push on main only')
  t.absent(/paths(-ignore)?:/.test(on), 'no path filters')
})

test('ci.yml: the affected job', (t) => {
  const text = job('affected')
  t.ok(text, 'affected found')
  t.ok(/^ {4}name:\s*affected\s*$/m.test(text), 'named affected')
  t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(text), 'runs-on ubuntu-24.04')
  t.ok(/^ {4}timeout-minutes:\s*\d+\s*$/m.test(text), 'has timeout-minutes')
  t.absent(/^ {4}(needs|if):/m.test(text), 'waits for nothing and always runs')
  t.absent(/\bnpm\b/.test(text), 'installs nothing: the selector needs only Node and git')
  t.ok(/node-version:\s*'20'/.test(text), 'Node 20')
  const outputs = {}
  for (const l of block(/^ {2}affected:\s*$/, /^ {4}steps:/).split('\n')) {
    const m = l.match(/^ {6}([a-z_]+):\s*(.*?)\s*$/)
    if (m) outputs[m[1]] = m[2]
  }
  const expected = {}
  for (const name of ['ref', 'core', 'cli', 'web_member']) expected[name] = expr('steps.pick.outputs.' + name)
  t.alike(outputs, expected, 'outputs come from the pick step')
  t.ok(/^ {6}- id:\s*pick\s*$/m.test(text), 'the step is pick')
  t.alike(stepEnv(text), { EVENT: expr('github.event_name') }, 'the event reaches the script through env')
  t.ok(runScript(text).includes('node scripts/run-tests.js --workspaces --list'), 'it asks the runner')
})

test('ci.yml: the sixteen workers have the expected shape', (t) => {
  t.is((code.match(/&test-steps/g) || []).length, 1, 'one &test-steps anchor')
  t.is((code.match(/\*test-steps/g) || []).length, 15, 'fifteen *test-steps aliases')
  let anchors = 0
  for (const id of WORKERS) {
    const text = job(id)
    t.ok(text, id + ' found')
    const node = id.slice(-2)
    t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(text), id + ' runs-on ubuntu-24.04')
    t.ok(/^ {4}timeout-minutes:\s*\d+\s*$/m.test(text), id + ' has timeout-minutes')
    t.ok(/^ {4}needs:\s*affected\s*$/m.test(text), id + ' needs affected')
    const workspace = LEGS[legOf(id)].WORKSPACE
    if (workspace) {
      const re = new RegExp('^ {4}if:\\s*needs\\.affected\\.outputs\\.' + OUTPUT[workspace] + " == 'true'\\s*$", 'm')
      t.ok(re.test(text), id + ' runs only when affected selects ' + workspace)
    } else {
      t.absent(/^ {4}if:/m.test(text), id + ' always runs once affected passed')
    }
    const e = env(text)
    t.is(e.NODE, node, id + ' NODE matches its suffix')
    t.is(e.VARANDA_TEST_CONCURRENCY, '1', id + ' VARANDA_TEST_CONCURRENCY is 1')
    const anchored = /^ {4}steps:\s*&test-steps\s*$/m.test(text)
    const aliased = /^ {4}steps:\s*\*test-steps\s*$/m.test(text)
    t.ok(anchored !== aliased, id + ' has either the anchor or the alias')
    if (anchored) anchors++
    t.absent(/\buses:/.test(text) && !anchored, id + ' has no uses: of its own')
  }
  t.is(anchors, 1, 'exactly one worker defines the steps')
})

test('ci.yml: worker env matches the legs table', (t) => {
  for (const node of NODES) {
    for (const [suite, legEnv] of Object.entries(LEGS)) {
      const id = suite + '-' + node
      const e = env(job(id))
      const expected = { NODE: node, SUITE: suite, ...legEnv, VARANDA_TEST_CONCURRENCY: '1' }
      if (suite === 'others') {
        expected.VARANDA_TEST_SKIP_WORKSPACES = e.VARANDA_TEST_SKIP_WORKSPACES
        expected.AFFECTED_REF = expr('needs.affected.outputs.ref')
      }
      t.alike(e, expected, id + ' env')
    }
  }
})

test('ci.yml: the skip list of others equals the workspaces of the other seven', (t) => {
  for (const node of NODES) {
    const covered = new Set(workerIds(node).filter((id) => !id.startsWith('others-')).map((id) => env(job(id)).WORKSPACE))
    const e = env(job('others-' + node))
    t.absent('WORKSPACE' in e, 'others-' + node + ' has no WORKSPACE')
    t.absent('VARANDA_TEST_SHARD' in e, 'others-' + node + ' has no shard')
    const skip = String(e.VARANDA_TEST_SKIP_WORKSPACES || '').split(',')
    t.is(new Set(skip).size, skip.length, 'others-' + node + ' skip list has no duplicates')
    t.alike(skip.slice().sort(), [...covered].sort(), 'others-' + node + ' skip list')
    t.alike(Object.keys(OUTPUT).sort(), [...covered].sort(), 'affected has an output for each sharded workspace')
  }
})

test('ci.yml: the shared steps', (t) => {
  const steps = job(WORKERS.find((id) => /&test-steps/.test(job(id))))
  const test = 'if \\[ -n "\\$WORKSPACE" \\]; then npm test -w "\\$WORKSPACE"; elif \\[ -n "\\$AFFECTED_REF" \\]; then npm test -- --affected="\\$AFFECTED_REF"; else npm test; fi'
  const order = ['npm ci --ignore-scripts', 'npm run lint', test, 'npm run demo']
  const ls = steps.split('\n')
  const idx = order.map((cmd) => ls.findIndex((l) => new RegExp('^\\s+(- )?run:\\s*' + cmd + '\\s*$').test(l)))
  t.ok(idx.every((i) => i !== -1), 'install, lint, test and demo present')
  t.alike([...idx].sort((a, b) => a - b), idx, 'in that order')
  for (const i of [idx[1], idx[3]]) {
    t.ok(/^\s+- if:\s*env\.SUITE == 'others'\s*$/.test(ls[i - 1] || ''), 'lint and demo only in others: ' + (ls[i] || '').trim())
  }
  t.ok(/node-version:\s*\$\{\{ env\.NODE \}\}/.test(steps), 'node-version comes from env.NODE')
  t.ok(/cache:\s*npm/.test(steps), 'npm cache')
})

test('ci.yml: the gates', (t) => {
  for (const node of NODES) {
    const id = 'test-' + node
    const text = job(id)
    t.ok(text, id + ' found')
    t.ok(new RegExp('^ {4}name:\\s*test \\(' + node + '\\)\\s*$', 'm').test(text), id + ' is named test (' + node + ')')
    t.ok(/^ {4}if:\s*always\(\)\s*$/m.test(text), id + ' has if: always()')
    t.absent(/cancelled\(\)|success\(\)/.test(text), id + ' never uses cancelled() or success()')
    const needs = text.match(/^ {4}needs:\s*\[([^\]]*)\]\s*$/m)
    t.ok(needs, id + ' has a needs list')
    const list = needs ? needs[1].split(',').map((s) => s.trim()) : []
    t.is(list.length, 9, id + ' needs nine jobs')
    t.alike(list.slice().sort(), ['affected', ...workerIds(node)].sort(), id + ' needs affected and its eight workers')
    t.absent(/\buses:/.test(text), id + ' has no uses:')
    t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(text), id + ' runs-on ubuntu-24.04')
    t.ok(/RESULTS:\s*\$\{\{ join\(needs\.\*\.result, ' '\) \}\}/.test(text), id + ' reads every result through env')
    t.ok(text.includes('[ "$#" -eq 9 ] || exit 1'), id + ' checks the count')
  }
})

// What GitHub puts in a gate's env for these results and outputs. Any other
// expression throws, so a gate cannot read something this test does not model.
function evaluate (expr, needs, results, outputs) {
  return expr.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (all, inner) => {
    if (inner === "join(needs.*.result, ' ')") return needs.map((id) => results[id]).join(' ')
    let m = inner.match(/^needs\.([a-z0-9-]+)\.result$/)
    if (m && needs.includes(m[1])) return results[m[1]]
    m = inner.match(/^needs\.affected\.outputs\.([a-z_]+)$/)
    if (m && needs.includes('affected') && m[1] in outputs) return outputs[m[1]]
    throw new Error('unexpected expression: ' + all)
  })
}

// A run as GitHub would report it: a shard runs when its output is 'true'
// (GitHub compares strings ignoring case) and affected passed, and is
// skipped otherwise; `shard` then overrides single legs and `result` any job.
function gateRun (node, { affected = 'success', others = 'success', run = {}, shard = {}, result = {} }) {
  const outputs = affected === 'success'
    ? { ref: 'HEAD^1', core: 'true', cli: 'true', web_member: 'true' }
    : { ref: '', core: '', cli: '', web_member: '' }
  Object.assign(outputs, run)
  const results = { affected, ['others-' + node]: others }
  for (const id of workerIds(node)) {
    const workspace = LEGS[legOf(id)].WORKSPACE
    if (!workspace) continue
    const runs = affected === 'success' && String(outputs[OUTPUT[workspace]]).toLowerCase() === 'true'
    results[id] = runs ? 'success' : 'skipped'
  }
  for (const [leg, value] of Object.entries(shard)) results[leg + '-' + node] = value
  Object.assign(results, result)
  return { outputs, results }
}

const GATE_CASES = [
  ['every suite ran and passed', true, {}],
  ['core left out', true, { run: { core: 'false' } }],
  ['cli left out', true, { run: { cli: 'false' } }],
  ['web-member left out', true, { run: { web_member: 'false' } }],
  ['nothing reached: every shard skipped', true, { run: { core: 'false', cli: 'false', web_member: 'false' } }],
  ['a shard failed', false, { shard: { 'core-2': 'failure' } }],
  ['a shard was cancelled', false, { shard: { 'web-member-3': 'cancelled' } }],
  ['a shard was skipped although its workspace runs', false, { shard: { 'cli-1': 'skipped' } }],
  ['a shard ran although its workspace was left out', false, { run: { core: 'false' }, shard: { 'core-1': 'success' } }],
  ['others was skipped', false, { others: 'skipped' }],
  ['others failed', false, { others: 'failure' }],
  ['affected failed and everything after it was skipped', false, { affected: 'failure', others: 'skipped' }],
  ['affected was cancelled', false, { affected: 'cancelled', others: 'skipped' }],
  ['affected did not pass, whatever its outputs and the workers say', false, { result: { affected: 'failure' } }],
  ['an empty output with its shards skipped', false, { run: { cli: '' } }],
  ['an output other than true or false', false, { run: { web_member: 'TRUE' } }]
]

test('ci.yml: a gate passes a skip only where affected asked for it', (t) => {
  for (const node of NODES) {
    const text = job('test-' + node)
    const needs = (text.match(/^ {4}needs:\s*\[([^\]]*)\]\s*$/m) || ['', ''])[1].split(',').map((s) => s.trim())
    const script = runScript(text)
    const exprs = stepEnv(text)
    t.ok(script && Object.keys(exprs).length > 0, 'test-' + node + ' has a script and its env')
    for (const [label, passes, spec] of GATE_CASES) {
      const { results, outputs } = gateRun(node, spec)
      const vars = {}
      for (const [name, expr] of Object.entries(exprs)) vars[name] = evaluate(expr, needs, results, outputs)
      const res = bash(script, repoRoot, vars)
      t.is(res.status === 0, passes, 'test-' + node + ': ' + label)
    }
  }
})

test('ci.yml: only the gates carry the required names', (t) => {
  for (const node of NODES) {
    const re = new RegExp('^\\s+name:\\s*test \\(' + node + '\\)\\s*$')
    const hits = lines.map((l, i) => [l, i]).filter(([l]) => re.test(l))
    t.is(hits.length, 1, 'name: test (' + node + ') appears once')
  }
  const jobNames = lines.filter((l) => /^ {4}name:/.test(l))
  t.is(jobNames.length, WORKERS.length + NODES.length + 1, 'every job has a name')
  for (const id of ['affected', ...WORKERS]) {
    const m = job(id).match(/^ {4}name:\s*(.*?)\s*$/m)
    const name = m ? m[1] : ''
    t.ok(name, id + ' has a name')
    t.absent(/^test\b/.test(name), id + ' name does not render as test (NN)')
    t.absent(name.includes('${{'), id + ' name is a literal')
    t.absent(name === 'check', id + ' name is not check')
  }
})

test('ci.yml: no expression inside a run: script', (t) => {
  let runs = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(.*?)run:\s*(.*)$/)
    if (!m || !/^\s*(- )?$/.test(m[1])) continue
    runs++
    const col = m[1].length
    const script = [m[2]]
    if (/^[|>]/.test(m[2])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() !== '' && lines[j].search(/\S/) <= col) break
        script.push(lines[j])
      }
    }
    t.absent(script.join('\n').includes('${{'), 'no ${{ in run: ' + m[2].trim())
  }
  t.ok(runs >= 6, 'run: steps found')
})

test('ci.yml: forbidden constructs are absent', (t) => {
  t.absent(/secrets\./.test(code), 'no secrets.')
  t.absent(/\bsecrets:\s*inherit/.test(code), 'no secrets: inherit')
  t.absent(/pull_request_target/.test(code), 'no pull_request_target')
  t.absent(/workflow_run/.test(code), 'no workflow_run')
  t.absent(/continue-on-error/.test(code), 'no continue-on-error')
  t.absent(/self-hosted/.test(code), 'no self-hosted runner')
  t.absent(/<<:/.test(code), 'no YAML merge keys')
  t.absent(/strategy:|matrix/.test(code), 'no matrix')
  t.absent(yml.includes('\u2014'), 'no em dash in the file')
})

function git (cwd, ...args) {
  const config = ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always']
  const res = spawnSync('git', [...config, ...args], { cwd, env: cleanEnv({}), encoding: 'utf8' })
  if (res.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + (res.stderr || res.error))
  return res.stdout.trim()
}

// A throwaway monorepo with the real runner and selector: a PR branch makes
// `change`, main moves on with a core change of its own, and main then merges
// the PR as GitHub builds refs/pull/<n>/merge (HEAD^1 main, HEAD^2 the PR).
function prRepo (dir, change) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'apps/*'] }))
  fs.mkdirSync(path.join(dir, 'scripts'))
  for (const name of ['run-tests.js', 'affected.js']) fs.copyFileSync(path.join(repoRoot, 'scripts', name), path.join(dir, 'scripts', name))
  for (const ws of ['packages/core', 'apps/cli', 'packages/web-member', 'apps/app']) {
    fs.mkdirSync(path.join(dir, ws, 'test'), { recursive: true })
    fs.writeFileSync(path.join(dir, ws, 'package.json'), JSON.stringify({ name: path.basename(ws), scripts: { test: 'node ../../scripts/run-tests.js' } }))
    fs.writeFileSync(path.join(dir, ws, 'index.js'), 'module.exports = 1\n')
    fs.writeFileSync(path.join(dir, ws, 'test', 'a.test.js'), '\n')
  }
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', 'pr')
  change(dir)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'pr')
  git(dir, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(dir, 'packages/core/index.js'), 'module.exports = 2\n')
  git(dir, 'commit', '-q', '-am', 'main moves on')
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr')
}

const PICK = runScript(job('affected'))

function pick (t, cwd, event) {
  const out = path.join(tmpDir(t, 'ci-pick-out-'), 'output')
  fs.writeFileSync(out, '')
  const res = bash(PICK, cwd, { EVENT: event, GITHUB_OUTPUT: out })
  return { code: res.status, output: fs.readFileSync(out, 'utf8'), stderr: res.stderr }
}

function picked (ref, core, cli, webMember) {
  return 'ref=' + ref + '\ncore=' + core + '\ncli=' + cli + '\nweb_member=' + webMember + '\n'
}

test('ci.yml: affected leaves out what a pull request does not reach, and a push runs everything', (t) => {
  const dir = tmpDir(t, 'ci-pick-')
  prRepo(dir, (d) => fs.writeFileSync(path.join(d, 'apps/app/index.js'), 'module.exports = 3\n'))
  let res = pick(t, dir, 'pull_request')
  t.is(res.code, 0, res.stderr)
  t.is(res.output, picked('HEAD^1', false, false, false), 'only the app changed: the core change main made is not the PR\'s')
  const clone = path.join(tmpDir(t, 'ci-pick-clone-'), 'repo')
  git(path.dirname(clone), 'clone', '-q', '--depth', '2', 'file://' + dir, clone)
  res = pick(t, clone, 'pull_request')
  t.is(res.code, 0, res.stderr)
  t.is(res.output, picked('HEAD^1', false, false, false), 'the same from a checkout two commits deep, as CI fetches it')
  res = pick(t, dir, 'push')
  t.is(res.code, 0, res.stderr)
  t.is(res.output, picked('', true, true, true), 'a push runs every workspace')
  git(dir, 'checkout', '-q', 'pr')
  res = pick(t, dir, 'pull_request')
  t.is(res.code, 0, res.stderr)
  t.is(res.output, picked('', true, true, true), 'not a merge commit: every workspace')
})

test('ci.yml: affected selects a changed workspace, and every one when a select-all file changed', (t) => {
  let dir = tmpDir(t, 'ci-pick-')
  prRepo(dir, (d) => fs.writeFileSync(path.join(d, 'packages/web-member/index.js'), 'module.exports = 3\n'))
  let res = pick(t, dir, 'pull_request')
  t.is(res.code, 0, res.stderr)
  t.is(res.output, picked('HEAD^1', false, false, true), 'web-member only')
  dir = tmpDir(t, 'ci-pick-')
  prRepo(dir, (d) => fs.appendFileSync(path.join(d, 'scripts/affected.js'), '\n'))
  res = pick(t, dir, 'pull_request')
  t.is(res.code, 0, res.stderr)
  t.is(res.output, picked('HEAD^1', true, true, true), 'a change under scripts/ runs every workspace')
})

test('ci.yml: a selector error fails affected and writes no output', (t) => {
  const dir = tmpDir(t, 'ci-pick-')
  prRepo(dir, (d) => fs.writeFileSync(path.join(d, 'apps/cli/package.json'), JSON.stringify({ name: 'cli', scripts: { test: 'jest' } })))
  for (const event of ['pull_request', 'push']) {
    const res = pick(t, dir, event)
    t.not(res.code, 0, event + ' fails')
    t.is(res.output, '', event + ' writes nothing, so no shard is skipped')
  }
})
