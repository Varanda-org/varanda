const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')

// The workflows that wait for an environment approval carry the same
// supersede job: only the newest run asks for approval. Checked with line and
// regex rules like deploy.test.js (no YAML parser available); comment lines
// are dropped so prose cannot satisfy or trip a rule.
const REF = '$' + '{{ github.ref }}'
const GATED = [
  { file: 'deploy.yml', job: 'deploy', needs: '[check, supersede]', before: 'check', group: 'deploy-' + REF },
  { file: 'ios-release.yml', job: 'testflight', needs: 'supersede', before: null, group: 'ios-release-' + REF },
  { file: 'android-release.yml', job: 'play', needs: 'supersede', before: null, group: 'android-release-' + REF },
  { file: 'site.yml', job: 'deploy', needs: '[build, supersede]', before: 'build', group: 'pages' }
]
const GO = " && needs.supersede.outputs.go == 'true'"

function load (file) {
  const yml = fs.readFileSync(path.join(repoRoot, '.github/workflows', file), 'utf8')
  const lines = yml.split('\n').filter((l) => !/^\s*#/.test(l))
  const block = (startRe, endRe, from = lines) => {
    const start = from.findIndex((l) => startRe.test(l))
    if (start === -1) return []
    let end = from.length
    for (let i = start + 1; i < from.length; i++) {
      if (endRe.test(from[i])) { end = i; break }
    }
    return from.slice(start, end)
  }
  return { yml, code: lines.join('\n'), lines, block }
}

const ifOf = (job) => ((job.join('\n').match(/^ {4}if:\s*(.+?)\s*$/m) || [])[1])
const stepsOf = (job, block) => block(/^ {4}steps:\s*$/, /^ {4}\S/, job).join('\n')

for (const g of GATED) {
  test(g.file + ': only the newest run waits for approval', (t) => {
    const { yml, code, block } = load(g.file)
    const sup = block(/^ {2}supersede:\s*$/, /^ {2}\S/)
    const gated = block(new RegExp('^ {2}' + g.job + ':\\s*$'), /^ {2}\S/)
    t.ok(sup.length && gated.length, 'supersede and ' + g.job + ' found')
    const s = sup.join('\n')
    const j = gated.join('\n')

    t.absent(/^concurrency:/m.test(code), 'no workflow concurrency (a waiting run would hold a newer one back)')
    t.absent(/cancel-in-progress:\s*true/.test(code), 'nothing cancels a running job')
    t.ok(/^ {4}concurrency:\s*$/m.test(j), g.job + ' has its own concurrency')
    t.ok(new RegExp('^ {6}group:\\s*' + g.group.replace(/[$.{}]/g, '\\$&') + '\\s*$', 'm').test(j), g.job + ' group is ' + g.group)
    t.ok(/^ {6}cancel-in-progress:\s*false\s*$/m.test(j), g.job + ' cancel-in-progress is false')
    t.ok(/^ {4}environment:\s*$/m.test(j), g.job + ' is the job behind the environment')

    t.ok(new RegExp('^ {4}needs:\\s*' + g.needs.replace(/[[\]]/g, '\\$&') + '\\s*$', 'm').test(j), g.job + ' needs ' + g.needs)
    if (g.before) t.ok(new RegExp('^ {4}needs:\\s*' + g.before + '\\s*$', 'm').test(s), 'supersede needs ' + g.before)
    else t.absent(/^ {4}needs:/m.test(s), 'supersede runs first')
    t.ok(ifOf(sup), 'supersede is guarded')
    t.is(ifOf(gated), ifOf(sup) + GO, g.job + ' has the same guard plus the supersede output')

    t.alike(block(/^ {4}permissions:\s*$/, /^ {4}\S/, sup).slice(1).map((l) => l.trim()).filter(Boolean), ['actions: write'], 'supersede may only read and cancel runs')
    t.ok(/^ {6}go:\s*\$\{\{ steps\.runs\.outputs\.go \}\}\s*$/m.test(s), 'supersede exports go')
    t.ok(/^ {10}GH_TOKEN:\s*\$\{\{ github\.token \}\}\s*$/m.test(s), 'the token is the job token')
    for (const bad of [/\buses:/, /^ {4}environment:/m, /\bsecrets\./, /\bvars\.(?!VARANDA_(DEPLOY|IOS_RELEASE|ANDROID_RELEASE)\b)/, /continue-on-error/]) {
      t.absent(bad.test(s), 'supersede has no ' + bad)
    }
    t.absent(yml.includes('—'), 'no em dash')
  })
}

test('supersede: the same steps in every gated workflow, and a narrow script', (t) => {
  const steps = GATED.map((g) => {
    const w = load(g.file)
    return stepsOf(w.block(/^ {2}supersede:\s*$/, /^ {2}\S/), w.block)
  })
  t.ok(steps[0].length > 0, 'steps found')
  for (let i = 1; i < steps.length; i++) t.is(steps[i], steps[0], GATED[i].file + ' matches deploy.yml')

  const s = steps[0]
  t.ok(/^ {10}set -euo pipefail\s*$/m.test(s), 'fails closed: an API error skips the deploy')
  t.ok(/workflows\/\$wf\/runs\?branch=main&per_page=100"/.test(s), 'only runs on main of this workflow')
  t.ok(/select\(\.run_number > \$n\)/.test(s), 'a newer run supersedes this one')
  t.ok(/select\(\.run_number < \$n and \.status == "waiting"\)/.test(s), 'only older runs waiting for approval are cancelled')
  t.is((s.match(/-X\s+\S+/g) || []).join(), '-X POST', 'one write')
  t.ok(/gh api -X POST "\$api\/runs\/\$id\/cancel"/.test(s), 'the write is a run cancel')
  const recheck = s.indexOf('[ "$(gh api "$api/runs/$id" --jq .status)" = waiting ] || continue')
  t.ok(recheck !== -1 && recheck < s.indexOf('/cancel'), 'the status is read again right before the cancel')
  for (const bad of ['pending_deployments', 'force-cancel', 'rerun', 'dispatches']) {
    t.absent(s.includes(bad), 'absent from the script: ' + bad)
  }
  t.absent(script().includes('${' + '{'), 'nothing from the contexts is spliced into the script')
})

// The script itself, run against a fake gh (real bash and jq, as on the runner).
function hasTools (t) {
  for (const bin of ['bash', 'jq']) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    if (probe.error || probe.status !== 0) {
      t.comment(bin + ' not found: skipping the behavioural check')
      return false
    }
  }
  return true
}

function script () {
  const { block } = load('deploy.yml')
  const sup = block(/^ {2}supersede:\s*$/, /^ {2}\S/)
  const start = sup.findIndex((l) => /^ {8}run: \|\s*$/.test(l))
  const body = []
  for (const l of sup.slice(start + 1)) {
    if (l.trim() !== '' && !/^ {10}/.test(l)) break
    body.push(l.slice(10))
  }
  return body.join('\n') + '\n'
}

// state: { runs: [{ id, run_number, status }], recheck: { id: status }, failCancel: [id], failList }
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\\n')
const post = args[1] === '-X'
const url = post ? args[3] : args[1]
const jq = args.indexOf('--jq') === -1 ? null : args[args.indexOf('--jq') + 1]
let m
if (post && (m = url.match(/^repos\\/o\\/r\\/actions\\/runs\\/(\\d+)\\/cancel$/))) {
  process.exit((state.failCancel || []).includes(Number(m[1])) ? 1 : 0)
} else if ((m = url.match(/^repos\\/o\\/r\\/actions\\/runs\\/(\\d+)$/))) {
  const id = Number(m[1])
  const run = state.runs.find((r) => r.id === id) || {}
  const out = { id, workflow_id: 77, status: (state.recheck || {})[id] || run.status }
  process.stdout.write((jq ? String(out[jq.slice(1)]) : JSON.stringify(out)) + '\\n')
} else if (url === 'repos/o/r/actions/workflows/77/runs?branch=main&per_page=100') {
  if (state.failList) process.exit(1)
  process.stdout.write(JSON.stringify({ workflow_runs: state.runs }) + '\\n')
} else {
  process.stderr.write('fake gh: unexpected ' + args.join(' ') + '\\n')
  process.exit(2)
}
`

test('supersede: cancels only older runs still waiting, skips when a newer run exists', (t) => {
  if (!hasTools(t)) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-supersede-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  const file = path.join(dir, 'supersede.sh')
  fs.writeFileSync(file, script())

  const run = (self, state) => {
    const paths = { state: path.join(dir, 'state.json'), log: path.join(dir, 'gh.log'), out: path.join(dir, 'out') }
    fs.writeFileSync(paths.state, JSON.stringify(state))
    for (const p of [paths.log, paths.out]) fs.writeFileSync(p, '')
    const me = state.runs.find((r) => r.run_number === self)
    const res = spawnSync('bash', [file], {
      encoding: 'utf8',
      env: {
        PATH: bin + path.delimiter + process.env.PATH,
        FAKE_GH_STATE: paths.state,
        FAKE_GH_LOG: paths.log,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_RUN_ID: String(me.id),
        GITHUB_RUN_NUMBER: String(self),
        GITHUB_OUTPUT: paths.out
      }
    })
    const log = fs.readFileSync(paths.log, 'utf8').split('\n').filter(Boolean)
    const cancelled = log.filter((l) => l.startsWith('api -X POST ')).map((l) => Number(l.match(/runs\/(\d+)\/cancel$/)[1]))
    return { res, cancelled, out: fs.readFileSync(paths.out, 'utf8').trim() }
  }

  const runs = [
    { id: 1012, run_number: 12, status: 'in_progress' },
    { id: 1011, run_number: 11, status: 'waiting' },
    { id: 1010, run_number: 10, status: 'in_progress' },
    { id: 1009, run_number: 9, status: 'waiting' },
    { id: 1008, run_number: 8, status: 'completed' }
  ]
  const newest = run(12, { runs })
  t.is(newest.res.status, 0, 'newest run: ok ' + newest.res.stderr)
  t.alike(newest.cancelled, [1011, 1009], 'cancels the older runs waiting for approval, never the running deploy')
  t.is(newest.out, 'go=true', 'the newest run goes on to the approval')

  const older = run(11, { runs })
  t.is(older.res.status, 0, 'older run: ok ' + older.res.stderr)
  t.alike(older.cancelled, [], 'a superseded run cancels nothing')
  t.is(older.out, 'go=false', 'a superseded run skips the approval')

  const approved = run(12, { runs, recheck: { 1011: 'queued' } })
  t.alike(approved.cancelled, [1009], 'a run approved since the list is left alone')
  t.is(approved.out, 'go=true')

  const refused = run(12, { runs, failCancel: [1011] })
  t.is(refused.res.status, 0, 'a refused cancel does not stop the run')
  t.ok(/::warning::/.test(refused.res.stdout), 'a refused cancel is reported')
  t.alike(refused.cancelled, [1011, 1009], 'the other cancels still happen')
  t.is(refused.out, 'go=true')

  const broken = run(12, { runs, failList: true })
  t.not(broken.res.status, 0, 'an API error fails the job')
  t.is(broken.out, '', 'and the gated job is skipped')
})
