const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { tmpDir, until } = require('./helpers/net')

// Every case runs the real runner against a throwaway fixture tree, never the
// real suite. The runner spawns each fixture in its own process group, so
// killing the runner's group does not reach them: fixtures log their pid,
// grandchild pids and VARANDA_TEST_TMPDIR, and teardown kills and removes
// all of them itself instead of trusting the runner's cleanup.
// When this file is SIGKILLed by its own runner no teardown runs, so the
// runner under test stays in this file's group (not detached) and dies with
// it, its TMPDIR points inside this file's temp root so the outer runner
// removes every nested root, and every idle fixture and grandchild exits on
// its own after IDLE_MS.
const repoRoot = path.resolve(__dirname, '../../..')
const RUNNER = path.join(repoRoot, 'scripts/run-tests.js')
const RUNNER_VARS = ['VARANDA_TEST_SHARD', 'VARANDA_TEST_CONCURRENCY', 'VARANDA_TEST_SKIP_WORKSPACES', 'VARANDA_TEST_TIMEOUT_MS']

const PRELUDE = `
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const LOG = process.env.RT_LOG
const DIR = path.dirname(LOG)
const log = (ev, extra) => fs.appendFileSync(LOG, JSON.stringify({ ev, name: NAME, pid: process.pid, root: process.env.VARANDA_TEST_TMPDIR, ...extra }) + '\\n')
const touch = (name) => fs.writeFileSync(path.join(DIR, name), '')
const waitFor = (name, ms) => new Promise((resolve) => {
  const deadline = Date.now() + ms
  const tick = () => {
    if (fs.existsSync(path.join(DIR, name))) return resolve(true)
    if (Date.now() > deadline) return resolve(false)
    setTimeout(tick, 20)
  }
  tick()
})
const write = (stream, data) => new Promise((resolve) => stream.write(data, resolve))
const IDLE_MS = 8000
const idle = () => setTimeout(() => process.exit(1), IDLE_MS)
const spawnIdle = (ms = IDLE_MS, opts = {}) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + ms + ')', 'run-tests-fixture-grandchild'], { stdio: 'inherit', ...opts })
  log('grandchild', { grandchild: child.pid })
  return child
}
const done = (code = 0) => {
  log('end')
  process.exitCode = code
}
log('start')
`

function fixtureName (name) {
  return 'run-tests-fixture-' + name + '.test.js'
}

function fixture (dir, name, body) {
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true })
  const src = 'const NAME = ' + JSON.stringify(name) + '\n' + PRELUDE + 'void (async () => {\n' + body + '\n})()\n'
  fs.writeFileSync(path.join(dir, 'test', fixtureName(name)), src)
}

function header (name) {
  return '# test/' + fixtureName(name)
}

function readLog (logFile) {
  let text = ''
  try { text = fs.readFileSync(logFile, 'utf8') } catch {}
  const entries = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try { entries.push(JSON.parse(line)) } catch {}
  }
  return entries
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function loggedPids (entries) {
  const pids = new Set()
  for (const e of entries) {
    if (e.pid) pids.add(e.pid)
    if (e.grandchild) pids.add(e.grandchild)
  }
  return [...pids]
}

function tree (t) {
  const dir = tmpDir(t, 'run-tests-fixture-')
  return { dir, logFile: path.join(dir, 'log.jsonl') }
}

function runRunner (t, { cwd, logFile, args = [], env = {} }) {
  const childEnv = { ...process.env, RT_LOG: logFile, TMPDIR: path.dirname(logFile) }
  for (const name of RUNNER_VARS) delete childEnv[name]
  childEnv.VARANDA_TEST_TIMEOUT_MS = '20000'
  Object.assign(childEnv, env)
  const child = spawn(process.execPath, [RUNNER, ...args], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const out = []
  const err = []
  child.stdout.on('data', (chunk) => out.push(chunk))
  child.stderr.on('data', (chunk) => err.push(chunk))
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() })
    })
  })
  t.teardown(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, 'SIGTERM') } catch {}
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2000))])
      try { process.kill(child.pid, 'SIGKILL') } catch {}
    }
    const entries = readLog(logFile)
    for (const pid of loggedPids(entries)) {
      try { process.kill(-pid, 'SIGKILL') } catch {}
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    for (const e of entries) {
      if (!e.root) continue
      try { fs.rmSync(e.root, { recursive: true, force: true }) } catch {}
    }
  }, { force: true })
  return { child, done }
}

function headers (stdout) {
  return stdout.split('\n').filter((line) => line.startsWith('# test/'))
}

function lastLine (stdout) {
  const lines = stdout.split('\n').filter(Boolean)
  return lines[lines.length - 1]
}

test('discovers test/*.test.js in sorted order', async (t) => {
  const { dir, logFile } = tree(t)
  for (const name of ['b', 'c', 'a']) fixture(dir, name, 'done()')
  fs.writeFileSync(path.join(dir, 'test', 'helper.js'), 'throw new Error("not a test")\n')
  const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: '1' } }).done
  t.is(res.code, 0)
  t.alike(headers(res.stdout), [header('a'), header('b'), header('c')])
  t.is(lastLine(res.stdout), '# 3 arquivo(s) de teste, 0 falha(s)')
})

test('argv files keep argv order', async (t) => {
  const { dir, logFile } = tree(t)
  for (const name of ['a', 'b', 'c']) fixture(dir, name, 'done()')
  const args = ['test/' + fixtureName('c'), 'test/' + fixtureName('a')]
  const res = await runRunner(t, { cwd: dir, logFile, args, env: { VARANDA_TEST_CONCURRENCY: '1' } }).done
  t.is(res.code, 0)
  t.alike(headers(res.stdout), [header('c'), header('a')])
  t.is(lastLine(res.stdout), '# 2 arquivo(s) de teste, 0 falha(s)')
})

test('an empty selection exits 1', async (t) => {
  const { dir, logFile } = tree(t)
  let res = await runRunner(t, { cwd: dir, logFile }).done
  t.is(res.code, 1, 'no test dir')
  t.is(res.stdout, '# nenhum arquivo de teste\n')
  fs.mkdirSync(path.join(dir, 'test'))
  res = await runRunner(t, { cwd: dir, logFile }).done
  t.is(res.code, 1, 'empty test dir')
  t.is(res.stdout, '# nenhum arquivo de teste\n')
})

test('shards 1/2 and 2/2 are disjoint round robin and cover the list', async (t) => {
  const { dir, logFile } = tree(t)
  const names = ['a', 'b', 'c', 'd', 'e']
  for (const name of names) fixture(dir, name, 'done()')
  const one = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_SHARD: '1/2' } }).done
  const two = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_SHARD: '2/2' } }).done
  t.is(one.code, 0)
  t.is(two.code, 0)
  const h1 = headers(one.stdout).sort()
  const h2 = headers(two.stdout).sort()
  t.alike(h1, ['a', 'c', 'e'].map(header))
  t.alike(h2, ['b', 'd'].map(header))
  t.absent(h1.some((h) => h2.includes(h)), 'disjoint')
  t.alike([...h1, ...h2].sort(), names.map(header), 'union is the full list')
  t.is(lastLine(one.stdout), '# 3 arquivo(s) de teste, 0 falha(s)')
  t.is(lastLine(two.stdout), '# 2 arquivo(s) de teste, 0 falha(s)')
})

test('invalid shards exit 1 before any fixture runs', async (t) => {
  const { dir, logFile } = tree(t)
  fixture(dir, 'a', 'done()')
  for (const value of ['0/2', '3/2', '1/0', 'x', '1 / 2']) {
    const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_SHARD: value } }).done
    t.is(res.code, 1, value)
    t.is(res.stdout, '# VARANDA_TEST_SHARD inválido: ' + value + ' (use índice/total, ex. 1/2)\n', value)
  }
  t.alike(readLog(logFile), [], 'nothing ran')
})

test('a shard that selects nothing exits 1', async (t) => {
  const { dir, logFile } = tree(t)
  fixture(dir, 'a', 'done()')
  const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_SHARD: '2/2' } }).done
  t.is(res.code, 1)
  t.is(res.stdout, '# nenhum arquivo neste fragmento\n')
  t.alike(readLog(logFile), [], 'nothing ran')
})

test('empty-string variables behave as unset', async (t) => {
  const { dir, logFile } = tree(t)
  fixture(dir, 'a', 'done()')
  fixture(dir, 'b', 'done()')
  const env = { VARANDA_TEST_SHARD: '', VARANDA_TEST_CONCURRENCY: '', VARANDA_TEST_SKIP_WORKSPACES: '' }
  const res = await runRunner(t, { cwd: dir, logFile, env }).done
  t.is(res.code, 0)
  t.alike(headers(res.stdout).sort(), [header('a'), header('b')])
  t.is(lastLine(res.stdout), '# 2 arquivo(s) de teste, 0 falha(s)')
})

test('invalid concurrency exits 1 before any fixture runs', async (t) => {
  const { dir, logFile } = tree(t)
  fixture(dir, 'a', 'done()')
  for (const value of ['0', '-1', '1.5', 'abc']) {
    const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: value } }).done
    t.is(res.code, 1, value)
    t.is(res.stdout, '# VARANDA_TEST_CONCURRENCY inválido: ' + value + '\n', value)
  }
  t.alike(readLog(logFile), [], 'nothing ran')
})

test('concurrency 1 never overlaps two files', async (t) => {
  const { dir, logFile } = tree(t)
  // a gives b a chance to start while it is still running; b must not.
  fixture(dir, 'a', "touch('a-started'); await waitFor('b-started', 1000); done()")
  fixture(dir, 'b', "touch('b-started'); done()")
  const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: '1' } }).done
  t.is(res.code, 0)
  const order = readLog(logFile).map((e) => e.ev + ':' + e.name)
  t.alike(order, ['start:a', 'end:a', 'start:b', 'end:b'])
})

test('concurrency 2 overlaps two files and starts a third only when a slot frees', async (t) => {
  const { dir, logFile } = tree(t)
  // Each waits for the other, so both pass only when they run at once.
  fixture(dir, 'a', "touch('a-started'); done((await waitFor('b-started', 10000)) ? 0 : 1)")
  fixture(dir, 'b', "touch('b-started'); done((await waitFor('a-started', 10000)) ? 0 : 1)")
  fixture(dir, 'c', 'done()')
  const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: '2' } }).done
  t.is(res.code, 0)
  const order = readLog(logFile).map((e) => e.ev + ':' + e.name)
  const firstEnd = Math.min(order.indexOf('end:a'), order.indexOf('end:b'))
  t.ok(firstEnd >= 0)
  t.ok(order.indexOf('start:c') > firstEnd, 'c starts after a slot frees')
  t.is(lastLine(res.stdout), '# 3 arquivo(s) de teste, 0 falha(s)')
})

test('pooled output arrives complete and contiguous through a pipe', async (t) => {
  const { dir, logFile } = tree(t)
  const bigLines = 24 * 1024
  const smallLines = 1200
  const line = (ch) => ch.repeat(63) + '\n'
  fixture(dir, 'a', [
    "touch('a-started')",
    "await waitFor('b-started', 10000)",
    'for (let i = 0; i < ' + bigLines + ' / 64; i++) await write(process.stdout, ' + JSON.stringify(line('A')) + '.repeat(64))',
    "await write(process.stderr, 'a-err\\n')",
    'done()'
  ].join('\n'))
  fixture(dir, 'b', [
    "touch('b-started')",
    "await waitFor('a-started', 10000)",
    'for (let i = 0; i < ' + smallLines + '; i++) await write(process.stdout, ' + JSON.stringify(line('B')) + ')',
    "await write(process.stderr, 'b-err\\n')",
    'done()'
  ].join('\n'))
  const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: '2' } }).done
  t.is(res.code, 0)
  t.ok(bigLines * 64 > 1024 * 1024, 'payload exceeds 1 MiB')
  const countOf = (text, ch) => text.split(ch).length - 1
  t.is(countOf(res.stdout, 'A'), bigLines * 63, 'every A byte arrived')
  t.is(countOf(res.stdout, 'B'), smallLines * 63, 'every B byte arrived')
  const countLine = '# 2 arquivo(s) de teste, 0 falha(s)\n'
  const end = res.stdout.indexOf(countLine)
  t.ok(end >= 0, 'count line present')
  t.is(res.stdout.slice(end), countLine, 'count line comes last')
  // stdout and stderr are separate pipes, so only the block, not the order
  // inside it, is asserted.
  const starts = ['a', 'b'].map((name) => res.stdout.indexOf(header(name) + '\n'))
  for (const [i, name, ch, other] of [[0, 'a', 'A', 'B'], [1, 'b', 'B', 'A']]) {
    t.ok(starts[i] >= 0, 'header ' + name)
    const next = starts[1 - i] > starts[i] ? starts[1 - i] : end
    const block = res.stdout.slice(starts[i], next)
    t.is(countOf(block, ch), countOf(res.stdout, ch), name + ' output is all inside its block')
    t.is(countOf(block, other), 0, name + ' block has no output from the other file')
    t.ok(block.includes(name + '-err\n'), name + ' stderr is inside its block')
  }
})

test('a failing file lets the others run and is named in list order', async (t) => {
  const { dir, logFile } = tree(t)
  fixture(dir, 'a', "await waitFor('c-ended', 10000); done(1)")
  fixture(dir, 'b', 'done()')
  fixture(dir, 'c', "done(1); touch('c-ended')")
  const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: '2' } }).done
  t.is(res.code, 1)
  const order = readLog(logFile).map((e) => e.ev + ':' + e.name)
  t.ok(order.includes('end:b'), 'sibling ran')
  const tail = res.stdout.split('\n').filter(Boolean).slice(-3)
  t.alike(tail, [
    '# falha: test/' + fixtureName('a'),
    '# falha: test/' + fixtureName('c'),
    '# 3 arquivo(s) de teste, 2 falha(s)'
  ])
})

for (const concurrency of ['1', '2']) {
  test('timeout kills the group and removes the root (concurrency ' + concurrency + ')', async (t) => {
    const { dir, logFile } = tree(t)
    fixture(dir, 'a', 'spawnIdle(); idle()')
    fixture(dir, 'b', 'done()')
    const env = { VARANDA_TEST_CONCURRENCY: concurrency, VARANDA_TEST_TIMEOUT_MS: '500' }
    const res = await runRunner(t, { cwd: dir, logFile, env }).done
    t.is(res.code, 1)
    t.ok(res.stdout.includes('# tempo esgotado: test/' + fixtureName('a') + '\n'), 'timeout line')
    t.ok(res.stdout.includes('# falha: test/' + fixtureName('a') + '\n'), 'failure line')
    const entries = readLog(logFile)
    const gc = entries.find((e) => e.ev === 'grandchild')
    t.ok(gc, 'grandchild was logged')
    await until(() => !isAlive(gc.grandchild), { timeoutMs: 5000, name: 'grandchild dead' })
    t.absent(isAlive(gc.grandchild), 'grandchild dead')
    for (const e of entries) t.absent(fs.existsSync(e.root), 'root removed: ' + e.name)
  })
}

test('a file that exits in time passes while a pipe holder outlives the deadline', async (t) => {
  const { dir, logFile } = tree(t)
  // The detached grandchild escapes the group kill and keeps the inherited
  // stdout open for 3 s, past the 1 s deadline but before the 5 s close guard.
  fixture(dir, 'a', 'spawnIdle(3000, { detached: true }).unref(); done()')
  fixture(dir, 'b', 'done()')
  const env = { VARANDA_TEST_CONCURRENCY: '2', VARANDA_TEST_TIMEOUT_MS: '1000' }
  const res = await runRunner(t, { cwd: dir, logFile, env }).done
  t.is(res.code, 0)
  t.absent(res.stdout.includes('# tempo esgotado'), 'no timeout line')
  t.is(lastLine(res.stdout), '# 2 arquivo(s) de teste, 0 falha(s)')
})

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(signal + ' kills every live group and removes every root', async (t) => {
    const { dir, logFile } = tree(t)
    fixture(dir, 'a', 'spawnIdle(); idle()')
    fixture(dir, 'b', 'spawnIdle(); idle()')
    const { child, done } = runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: '2' } })
    await until(() => readLog(logFile).filter((e) => e.ev === 'grandchild').length === 2, { timeoutMs: 10000, name: 'both fixtures live' })
    process.kill(child.pid, signal)
    const res = await done
    t.is(res.code, code)
    const entries = readLog(logFile)
    const pids = loggedPids(entries)
    t.is(pids.length, 4, 'two fixtures and two grandchildren')
    await until(() => pids.every((pid) => !isAlive(pid)), { timeoutMs: 5000, name: 'all pids dead' })
    for (const pid of pids) t.absent(isAlive(pid), 'dead: ' + pid)
    const roots = [...new Set(entries.map((e) => e.root))]
    t.is(roots.length, 2)
    for (const root of roots) t.absent(fs.existsSync(root), 'root removed')
  })
}

test('the skip list skips a matching workspace and nothing else', async (t) => {
  const { dir, logFile } = tree(t)
  fixture(dir, 'a', 'done()')
  const cwd = path.join(repoRoot, 'apps/cli')
  const args = [path.join(dir, 'test', fixtureName('a'))]
  let res = await runRunner(t, { cwd, logFile, args, env: { VARANDA_TEST_SKIP_WORKSPACES: 'packages/core,apps/cli' } }).done
  t.is(res.code, 0)
  t.is(res.stdout, '# workspace apps/cli pulado (coberto por outro job)\n')
  t.alike(readLog(logFile), [], 'nothing ran')
  res = await runRunner(t, { cwd, logFile, args, env: { VARANDA_TEST_SKIP_WORKSPACES: 'packages/core,apps/site' } }).done
  t.is(res.code, 0)
  t.ok(readLog(logFile).some((e) => e.ev === 'end' && e.name === 'a'), 'non-matching list runs the file')
  t.is(lastLine(res.stdout), '# 1 arquivo(s) de teste, 0 falha(s)')
})

test('the runner has no em dash', (t) => {
  t.absent(fs.readFileSync(RUNNER, 'utf8').includes('\u2014'))
})
