const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

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

// The legs table: the same six workers per Node version. The skip list of
// `others` is not listed here: it is derived from the other five below.
const LEGS = {
  'core-1': { WORKSPACE: 'packages/core', VARANDA_TEST_SHARD: '1/2' },
  'core-2': { WORKSPACE: 'packages/core', VARANDA_TEST_SHARD: '2/2' },
  'cli-1': { WORKSPACE: 'apps/cli', VARANDA_TEST_SHARD: '1/2' },
  'cli-2': { WORKSPACE: 'apps/cli', VARANDA_TEST_SHARD: '2/2' },
  'web-member': { WORKSPACE: 'packages/web-member' },
  others: {}
}
const NODES = ['20', '24']
const workerIds = (node) => Object.keys(LEGS).map((suite) => suite + '-' + node)
const WORKERS = NODES.flatMap(workerIds)

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

test('ci.yml: actions pinned to the expected commits', (t) => {
  const pins = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020'
  }
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.is(uses.length, 2, 'two uses: lines (the anchor reuses them)')
  for (const u of uses) {
    const [name, ref] = u.split('@')
    t.ok(/^[0-9a-f]{40}$/.test(ref), 'pinned to a 40-hex SHA: ' + u)
    t.is(ref, pins[name], 'expected pin for ' + name)
  }
  t.alike(uses.map((u) => u.split('@')[0]).sort(), Object.keys(pins).sort())
  t.ok(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false/.test(code), 'checkout has persist-credentials: false')
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

test('ci.yml: the twelve workers have the expected shape', (t) => {
  t.is((code.match(/&test-steps/g) || []).length, 1, 'one &test-steps anchor')
  t.is((code.match(/\*test-steps/g) || []).length, 11, 'eleven *test-steps aliases')
  let anchors = 0
  for (const id of WORKERS) {
    const text = job(id)
    t.ok(text, id + ' found')
    const node = id.slice(-2)
    t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(text), id + ' runs-on ubuntu-24.04')
    t.ok(/^ {4}timeout-minutes:\s*\d+\s*$/m.test(text), id + ' has timeout-minutes')
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
      if (suite === 'others') expected.VARANDA_TEST_SKIP_WORKSPACES = e.VARANDA_TEST_SKIP_WORKSPACES
      t.alike(e, expected, id + ' env')
    }
  }
})

test('ci.yml: the skip list of others equals the workspaces of the other five', (t) => {
  for (const node of NODES) {
    const covered = new Set(workerIds(node).filter((id) => !id.startsWith('others-')).map((id) => env(job(id)).WORKSPACE))
    const e = env(job('others-' + node))
    t.absent('WORKSPACE' in e, 'others-' + node + ' has no WORKSPACE')
    t.absent('VARANDA_TEST_SHARD' in e, 'others-' + node + ' has no shard')
    const skip = String(e.VARANDA_TEST_SKIP_WORKSPACES || '').split(',')
    t.is(new Set(skip).size, skip.length, 'others-' + node + ' skip list has no duplicates')
    t.alike(skip.slice().sort(), [...covered].sort(), 'others-' + node + ' skip list')
  }
})

test('ci.yml: the shared steps', (t) => {
  const steps = job(WORKERS.find((id) => /&test-steps/.test(job(id))))
  const order = ['npm ci --ignore-scripts', 'npm run lint', 'if \\[ -n "\\$WORKSPACE" \\]; then npm test -w "\\$WORKSPACE"; else npm test; fi', 'npm run demo']
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
    t.is(list.length, 6, id + ' needs six jobs')
    t.alike(list.slice().sort(), workerIds(node).sort(), id + ' needs exactly its six workers')
    t.absent(/\buses:/.test(text), id + ' has no uses:')
    t.ok(/^ {4}runs-on:\s*ubuntu-24\.04\s*$/m.test(text), id + ' runs-on ubuntu-24.04')
    t.ok(/RESULTS:\s*\$\{\{ join\(needs\.\*\.result, ' '\) \}\}/.test(text), id + ' reads every result through env')
    t.ok(text.includes('[ "$#" -eq 6 ] || exit 1'), id + ' checks the count')
    t.ok(text.includes('for r in "$@"; do [ "$r" = success ] || exit 1; done'), id + ' requires success from each')
  }
})

test('ci.yml: only the gates carry the required names', (t) => {
  for (const node of NODES) {
    const re = new RegExp('^\\s+name:\\s*test \\(' + node + '\\)\\s*$')
    const hits = lines.map((l, i) => [l, i]).filter(([l]) => re.test(l))
    t.is(hits.length, 1, 'name: test (' + node + ') appears once')
  }
  const jobNames = lines.filter((l) => /^ {4}name:/.test(l))
  t.is(jobNames.length, WORKERS.length + NODES.length, 'every job has a name')
  for (const id of WORKERS) {
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
