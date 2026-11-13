const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
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
const AFFECTED = path.join(repoRoot, 'scripts/affected.js')
const RUNNER_VARS = ['VARANDA_TEST_SHARD', 'VARANDA_TEST_CONCURRENCY', 'VARANDA_TEST_SKIP_WORKSPACES', 'VARANDA_TEST_TIMEOUT_MS', 'VARANDA_TEST_DURATIONS']
// Set while a git hook runs; they would point the fixture repos' git at
// another repository.
const GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']

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
  for (const name of [...RUNNER_VARS, ...GIT_VARS]) delete childEnv[name]
  childEnv.VARANDA_TEST_TIMEOUT_MS = '20000'
  // Never the real cache under node_modules: fixture paths would land in it.
  childEnv.VARANDA_TEST_DURATIONS = path.join(path.dirname(logFile), 'durations.json')
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

// A throwaway monorepo whose root lists pkgs/*; a null script means a
// workspace without a test script.
const COMMON = 'node ../../scripts/run-tests.js'

function monorepo (dir, workspaces, patterns = ['pkgs/*']) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, workspaces: patterns }))
  for (const [name, script] of Object.entries(workspaces)) {
    const ws = path.join(dir, 'pkgs', name)
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name, scripts: script ? { test: script } : {} }))
  }
}

function wsHeader (ws, name) {
  return '# pkgs/' + ws + '/test/' + fixtureName(name)
}

function durationKey (dir, name) {
  return path.relative(repoRoot, path.join(fs.realpathSync(dir), 'test', fixtureName(name))).split(path.sep).join('/')
}

test('workspaces mode pools every workspace, each file in its own directory', async (t) => {
  const { dir, logFile } = tree(t)
  monorepo(dir, { one: COMMON, two: COMMON, three: null })
  // a and b wait for each other from different workspaces, so both pass only
  // when one pool spans the workspaces.
  const logCwd = "log('cwd', { cwd: process.cwd() }); "
  fixture(path.join(dir, 'pkgs/one'), 'a', logCwd + "touch('a-started'); done((await waitFor('b-started', 10000)) ? 0 : 1)")
  fixture(path.join(dir, 'pkgs/two'), 'b', logCwd + "touch('b-started'); done((await waitFor('a-started', 10000)) ? 0 : 1)")
  fixture(path.join(dir, 'pkgs/two'), 'c', logCwd + 'done()')
  const res = await runRunner(t, { cwd: dir, logFile, args: ['--workspaces'], env: { VARANDA_TEST_CONCURRENCY: '2' } }).done
  t.is(res.code, 0)
  const wsHeaders = res.stdout.split('\n').filter((line) => line.startsWith('# pkgs/')).sort()
  t.alike(wsHeaders, [wsHeader('one', 'a'), wsHeader('two', 'b'), wsHeader('two', 'c')])
  const cwds = {}
  for (const e of readLog(logFile)) if (e.ev === 'cwd') cwds[e.name] = fs.realpathSync(e.cwd)
  const wsDir = (ws) => fs.realpathSync(path.join(dir, 'pkgs', ws))
  t.alike(cwds, { a: wsDir('one'), b: wsDir('two'), c: wsDir('two') }, 'each file runs from its workspace')
  t.is(lastLine(res.stdout), '# 3 arquivo(s) de teste, 0 falha(s)')
})

test('workspaces mode honours the skip list', async (t) => {
  const { dir, logFile } = tree(t)
  monorepo(dir, { one: COMMON, two: COMMON })
  fixture(path.join(dir, 'pkgs/one'), 'a', 'done()')
  fixture(path.join(dir, 'pkgs/two'), 'b', 'done()')
  let res = await runRunner(t, { cwd: dir, logFile, args: ['--workspaces'], env: { VARANDA_TEST_SKIP_WORKSPACES: 'pkgs/two' } }).done
  t.is(res.code, 0)
  t.ok(res.stdout.startsWith('# workspace pkgs/two pulado (coberto por outro job)\n'), 'skip line first')
  t.alike(readLog(logFile).filter((e) => e.ev === 'end').map((e) => e.name), ['a'], 'only the kept workspace ran')
  t.is(lastLine(res.stdout), '# 1 arquivo(s) de teste, 0 falha(s)')
  res = await runRunner(t, { cwd: dir, logFile, args: ['--workspaces'], env: { VARANDA_TEST_SKIP_WORKSPACES: 'pkgs/one,pkgs/two' } }).done
  t.is(res.code, 0, 'every workspace skipped')
  t.is(res.stdout, '# workspace pkgs/one pulado (coberto por outro job)\n# workspace pkgs/two pulado (coberto por outro job)\n')
})

test('workspaces mode refuses what it cannot pool, before any file runs', async (t) => {
  const cases = [
    [{ one: COMMON, two: 'jest' }, ['pkgs/*'], ['--workspaces'], '# workspace pkgs/two: o script de teste não é este executor (jest)\n'],
    [{ one: COMMON, two: COMMON }, ['pkgs/*'], ['--workspaces'], '# workspace pkgs/two: nenhum arquivo de teste\n'],
    [{ one: COMMON }, ['pkgs/**'], ['--workspaces'], '# padrão de workspace não suportado: pkgs/**\n'],
    [{ one: COMMON }, ['pkgs/*'], ['--workspaces', 'x.test.js'], '# --workspaces não aceita arquivos\n'],
    [{ one: COMMON }, ['pkgs/*'], ['--workspaces', '--affected=main', 'x.test.js'], '# --workspaces não aceita arquivos\n'],
    [{ one: COMMON }, ['pkgs/*'], ['--workspaces', '--affected'], '# --affected precisa de uma referência: --affected=<ref> (ex. origin/main)\n'],
    [{ one: COMMON }, ['pkgs/*'], ['--workspaces', '--affected='], '# --affected precisa de uma referência: --affected=<ref> (ex. origin/main)\n'],
    [{ one: COMMON }, ['pkgs/*'], ['--workspaces', '--affected=a', '--affected=b'], '# --affected aceita uma só referência\n'],
    [{ one: COMMON }, ['pkgs/*'], ['--affected=main'], '# --affected só vale com --workspaces\n']
  ]
  for (const [workspaces, patterns, args, expected] of cases) {
    const { dir, logFile } = tree(t)
    monorepo(dir, workspaces, patterns)
    fixture(path.join(dir, 'pkgs/one'), 'a', 'done()')
    const res = await runRunner(t, { cwd: dir, logFile, args }).done
    t.is(res.code, 1, expected.trim())
    t.is(res.stdout, expected)
    t.alike(readLog(logFile), [], 'nothing ran')
  }
})

function gitWith (dir, extraEnv, ...args) {
  const env = { ...process.env }
  for (const name of GIT_VARS) delete env[name]
  Object.assign(env, extraEnv)
  const config = ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null']
  const res = spawnSync('git', [...config, ...args], { cwd: dir, env, encoding: 'utf8' })
  if (res.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + (res.stderr || res.error))
  return res.stdout.trim()
}

function gitIn (dir, ...args) {
  return gitWith(dir, {}, ...args)
}

// A throwaway git repo for --affected, one commit: pkgs/app requires a file
// of pkgs/core, pkgs/cli reads the root README.md, and nothing names pkgs/cli.
function affectedRepo (dir) {
  monorepo(dir, { app: COMMON, cli: COMMON, core: COMMON })
  fs.writeFileSync(path.join(dir, 'pkgs/core/index.js'), 'module.exports = 1\n')
  fixture(path.join(dir, 'pkgs/core'), 'core', 'done()')
  fixture(path.join(dir, 'pkgs/app'), 'app', "require('../../core/index.js'); done()")
  fixture(path.join(dir, 'pkgs/cli'), 'cli', "fs.readFileSync(path.join(__dirname, '../../../README.md')); done()")
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'log-*.jsonl\ndurations.json\nvaranda-run-*\n')
  gitIn(dir, 'init', '-q')
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '-q', '-m', 'base')
  return gitIn(dir, 'rev-parse', 'HEAD')
}

// Each run logs to its own file, so `ran` names only what that run started.
async function runAffected (t, dir, ref) {
  const logFile = path.join(dir, 'log-' + Math.random().toString(36).slice(2) + '.jsonl')
  const res = await runRunner(t, { cwd: dir, logFile, args: ['--workspaces', '--affected=' + ref] }).done
  return { ...res, ran: readLog(logFile).filter((e) => e.ev === 'end').map((e) => e.name).sort() }
}

function unaffected (ref, ...names) {
  return names.map((ws) => '# workspace pkgs/' + ws + ' pulado (não afetado desde ' + ref + ')\n').join('')
}

test('--affected runs each changed workspace and every workspace that reaches it, from the merge base', async (t) => {
  const { dir } = tree(t)
  const base = affectedRepo(dir)
  fs.writeFileSync(path.join(dir, 'pkgs/core/index.js'), 'module.exports = 2\n')
  let res = await runAffected(t, dir, base)
  t.is(res.code, 0)
  t.ok(res.stdout.startsWith(unaffected(base, 'cli')), 'cli named as not affected')
  t.alike(res.ran, ['app', 'core'], 'core changed and app requires it')
  t.is(lastLine(res.stdout), '# 2 arquivo(s) de teste, 0 falha(s)')
  // up moves on after side leaves it: its core change is not a change of side.
  gitIn(dir, 'commit', '-q', '-am', 'core')
  gitIn(dir, 'branch', 'up')
  gitIn(dir, 'checkout', '-q', '-b', 'side', base)
  fs.writeFileSync(path.join(dir, 'pkgs/cli/extra.js'), 'module.exports = 3\n')
  res = await runAffected(t, dir, 'up')
  t.is(res.code, 0)
  t.ok(res.stdout.startsWith(unaffected('up', 'app', 'core')), 'app and core named as not affected')
  t.alike(res.ran, ['cli'], 'an untracked file counts, a change only up has does not')
})

test('--affected follows a root file only into the workspaces that name it, and a select-all file runs every one', async (t) => {
  const { dir } = tree(t)
  affectedRepo(dir)
  fs.appendFileSync(path.join(dir, 'README.md'), 'more\n')
  let res = await runAffected(t, dir, 'HEAD')
  t.is(res.code, 0)
  t.alike(res.ran, ['cli'], 'only cli reads README.md')
  gitIn(dir, 'checkout', '--', 'README.md')
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x\n')
  res = await runAffected(t, dir, 'HEAD')
  t.is(res.code, 0, 'nothing affected passes')
  t.is(res.stdout, unaffected('HEAD', 'app', 'cli', 'core') + '# nenhum teste afetado desde HEAD\n')
  t.alike(res.ran, [])
  const pkgFile = path.join(dir, 'package.json')
  fs.writeFileSync(pkgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkgFile, 'utf8')), description: 'x' }))
  res = await runAffected(t, dir, 'HEAD')
  t.is(res.code, 0)
  t.ok(res.stdout.startsWith('# todos os workspaces afetados desde HEAD: package.json mudou\n'), 'says why')
  t.alike(res.ran, ['app', 'cli', 'core'])
})

test('--affected: nothing changed, a tree ref, and refs git refuses', async (t) => {
  const { dir } = tree(t)
  affectedRepo(dir)
  let res = await runAffected(t, dir, 'HEAD')
  t.is(res.code, 0, 'nothing changed passes')
  t.is(res.stdout, '# nada mudou desde HEAD\n')
  t.alike(res.ran, [])
  // A tree (the last green run) is compared as is: what it holds is not a
  // change, a file still untracked included. It is written the way a green
  // run's tree is, through a throwaway index, so the real one never sees it.
  fs.writeFileSync(path.join(dir, 'pkgs/core/index.js'), 'module.exports = 2\n')
  fs.writeFileSync(path.join(dir, 'pkgs/core/new.js'), 'module.exports = 4\n')
  const greenIndex = { GIT_INDEX_FILE: path.join(dir, '.git', 'green-index') }
  gitWith(dir, greenIndex, 'add', '-A')
  const green = gitWith(dir, greenIndex, 'write-tree')
  fs.writeFileSync(path.join(dir, 'pkgs/cli/extra.js'), 'module.exports = 3\n')
  res = await runAffected(t, dir, green)
  t.is(res.code, 0)
  t.alike(res.ran, ['cli'], 'only the file added after the green run counts')
  t.is(gitIn(dir, 'diff', '--cached', '--name-only'), '', 'the real index is untouched')
  t.is(gitIn(dir, 'ls-files', '--others', '--exclude-standard'), 'pkgs/cli/extra.js\npkgs/core/new.js')
  for (const [ref, expected] of [['nope', 'referência desconhecida: nope'], ['-p', 'referência inválida: -p']]) {
    res = await runAffected(t, dir, ref)
    t.is(res.code, 1, ref)
    t.is(res.stdout, '# --affected: ' + expected + '\n')
    t.alike(res.ran, [], 'nothing ran')
  }
})

test('a pooled run starts unmeasured files first, then the slowest, and records every duration', async (t) => {
  const { dir, logFile } = tree(t)
  for (const name of ['a', 'b', 'c']) fixture(dir, name, 'done()')
  const durations = path.join(dir, 'durations.json')
  fs.writeFileSync(durations, JSON.stringify({ [durationKey(dir, 'a')]: 1, [durationKey(dir, 'c')]: 50 }))
  const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: '2', VARANDA_TEST_DURATIONS: durations } }).done
  t.is(res.code, 0)
  const starts = readLog(logFile).filter((e) => e.ev === 'start').map((e) => e.name)
  t.alike(starts.slice(0, 2).sort(), ['b', 'c'], 'b (never measured) and c (slowest) take the two slots')
  t.is(starts[2], 'a', 'the fastest starts last')
  const saved = JSON.parse(fs.readFileSync(durations, 'utf8'))
  for (const name of ['a', 'b', 'c']) t.ok(Number.isFinite(saved[durationKey(dir, name)]), 'duration recorded: ' + name)
  const seen = readLog(logFile).length
  fs.writeFileSync(durations, JSON.stringify({ [durationKey(dir, 'a')]: 1, [durationKey(dir, 'c')]: 50 }))
  const serial = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: '1', VARANDA_TEST_DURATIONS: durations } }).done
  t.is(serial.code, 0)
  const serialStarts = readLog(logFile).slice(seen).filter((e) => e.ev === 'start').map((e) => e.name)
  t.alike(serialStarts, ['a', 'b', 'c'], 'a sequential run keeps list order')
})

test('an unreadable durations file means list order and is replaced', async (t) => {
  const { dir, logFile } = tree(t)
  // a and b pass only if they hold the two slots together, as list order gives.
  fixture(dir, 'a', "touch('a-started'); done((await waitFor('b-started', 10000)) ? 0 : 1)")
  fixture(dir, 'b', "touch('b-started'); done((await waitFor('a-started', 10000)) ? 0 : 1)")
  fixture(dir, 'c', 'done()')
  const durations = path.join(dir, 'durations.json')
  fs.writeFileSync(durations, '{ not json')
  const res = await runRunner(t, { cwd: dir, logFile, env: { VARANDA_TEST_CONCURRENCY: '2', VARANDA_TEST_DURATIONS: durations } }).done
  t.is(res.code, 0)
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(durations, 'utf8')) } catch {}
  t.ok(saved && Object.keys(saved).length === 3, 'replaced by valid JSON')
})

test('the root npm test pools every workspace through this runner', (t) => {
  const root = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  t.is(root.scripts.test, 'node scripts/run-tests.js --workspaces')
  for (const parent of ['packages', 'apps']) {
    for (const name of fs.readdirSync(path.join(repoRoot, parent))) {
      const file = path.join(repoRoot, parent, name, 'package.json')
      if (!fs.existsSync(file)) continue
      const script = (JSON.parse(fs.readFileSync(file, 'utf8')).scripts || {}).test
      if (script) t.is(script, COMMON, parent + '/' + name)
    }
  }
})

test('the runner has no em dash', (t) => {
  t.absent(fs.readFileSync(RUNNER, 'utf8').includes('\u2014'))
  t.absent(fs.readFileSync(AFFECTED, 'utf8').includes('\u2014'))
})
