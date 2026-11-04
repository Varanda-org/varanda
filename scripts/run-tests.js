// Runs brittle test files one per child process, a bounded number at a time.
// Each child is spawned detached so it leads its own process group; on
// timeout (VARANDA_TEST_TIMEOUT_MS, default 180000) or on the runner's own
// SIGINT/SIGTERM the whole group is killed with SIGKILL, so grandchildren
// spawned by a test never outlive it (process groups are POSIX only).
// Each file gets its own temp root (VARANDA_TEST_TMPDIR, under os.tmpdir(),
// prefix 'varanda-run-') that the runner removes after the child exits for
// any reason, so a SIGKILLed test (no 'exit' handler runs) leaves nothing.
// Pool (VARANDA_TEST_CONCURRENCY): the default is half the cores, capped at
// 4, because every file starts its own hyperdht testnet and several asserts
// are sub-100 ms timing bounds that move under load (AGENTS.md). Concurrent
// testnets cannot collide on ports: dht-rpc falls back to an ephemeral port
// when 49737 is taken. 1 keeps the old sequential, live-streaming output.
// Above 1, each child's output is captured and printed as one block when it
// ends, so files never interleave; a child is settled on 'close' and every
// write is awaited, because process.exit right after a large write to a pipe
// drops the unflushed tail.
// Workspaces (--workspaces, the root `npm test`): one pool over the test
// files of every workspace, each file run from its own workspace directory.
// Running the workspaces one after another left the pool idle while each
// workspace drained to its slowest file. Only a workspace whose test script
// is this runner can join the pool; any other script fails the run, so a
// workspace is never dropped silently.
// Longest first: above 1, files start in descending order of their last
// measured duration (never measured: first), because a slow file started
// last sets the end of the run. The durations live in
// node_modules/.cache/varanda-test-durations.json (VARANDA_TEST_DURATIONS
// overrides the path), never in git; a missing or unreadable file only means
// list order. Sequential runs keep list order.
// Shard (VARANDA_TEST_SHARD=I/N) splits round robin over the selection, so
// the split is deterministic and appending a file moves no other file. A
// shard that selects nothing fails, so a mistyped CI job never goes green.
// Skip (VARANDA_TEST_SKIP_WORKSPACES) lets CI run a workspace in a dedicated
// sharded job and skip it in the job that runs the root `npm test`.
// Every variable treats an empty string as unset, since an unset value in a
// workflow env expands to an empty string.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const RUNNER = 'scripts/run-tests.js'

function envValue (name) {
  const value = process.env[name]
  return value === undefined || value === '' ? null : value
}

function posix (p) {
  return p.split(path.sep).join('/')
}

const live = new Map()
let stopping = false
let writeChain = Promise.resolve()

function out (text) {
  writeChain = writeChain.then(() => new Promise((resolve) => {
    process.stdout.write(text, () => resolve())
  }))
  return writeChain
}

async function finalExit (text, code) {
  await out(text)
  process.exit(code)
}

function killGroup (child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch {}
  }
}

// Synchronous on purpose: the signal and error paths exit right after, and
// no child 'exit' handler runs once they do.
function killAllLive () {
  stopping = true
  for (const [child, { root }] of live) {
    killGroup(child)
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  }
  live.clear()
}

function onSignal (signal, code) {
  process.on(signal, () => {
    if (stopping) return
    killAllLive()
    process.exit(code)
  })
}

function skipList () {
  const list = envValue('VARANDA_TEST_SKIP_WORKSPACES')
  if (list === null) return []
  return list.split(',').map((entry) => entry.trim()).filter(Boolean)
}

function workspaceSkipped () {
  const current = posix(path.relative(ROOT, process.cwd()))
  return skipList().includes(current) ? current : null
}

function parseShard () {
  const raw = envValue('VARANDA_TEST_SHARD')
  if (raw === null) return null
  const m = /^(\d+)\/(\d+)$/.exec(raw)
  const index = m ? Number(m[1]) : 0
  const total = m ? Number(m[2]) : 0
  if (!m || total < 1 || index < 1 || index > total) {
    return { error: '# VARANDA_TEST_SHARD inválido: ' + raw + ' (use índice/total, ex. 1/2)' }
  }
  return { index, total }
}

function parseConcurrency () {
  const raw = envValue('VARANDA_TEST_CONCURRENCY')
  if (raw === null) {
    const avail = os.availableParallelism ? os.availableParallelism() : os.cpus().length
    return { value: Math.max(1, Math.min(4, Math.floor(avail / 2))) }
  }
  if (!/^[1-9]\d*$/.test(raw)) return { error: '# VARANDA_TEST_CONCURRENCY inválido: ' + raw }
  return { value: Number(raw) }
}

function testFiles (cwd) {
  const dir = path.join(cwd, 'test')
  return fs.existsSync(dir)
    ? fs.readdirSync(dir)
      .filter((name) => name.endsWith('.test.js'))
      .sort()
      .map((name) => path.join('test', name))
    : []
}

function selectFiles (args) {
  const cwd = process.cwd()
  const files = args.length > 0 ? args : testFiles(cwd)
  return files.map((file) => ({ cwd, file, label: file }))
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Only `dir/*` patterns are read, the only kind the root package.json uses;
// any other pattern fails instead of being half understood.
function listWorkspaces (root) {
  let pkg
  try { pkg = readJson(path.join(root, 'package.json')) } catch (err) {
    return { error: '# package.json da raiz ilegível: ' + err.message }
  }
  const dirs = []
  for (const pattern of Array.isArray(pkg.workspaces) ? pkg.workspaces : []) {
    if (!/^[\w.-]+(\/[\w.-]+)*\/\*$/.test(pattern)) return { error: '# padrão de workspace não suportado: ' + pattern }
    const parent = pattern.slice(0, -2)
    const names = fs.existsSync(path.join(root, parent)) ? fs.readdirSync(path.join(root, parent)) : []
    for (const name of names) {
      if (fs.existsSync(path.join(root, parent, name, 'package.json'))) dirs.push(parent + '/' + name)
    }
  }
  return { dirs: [...new Set(dirs)].sort() }
}

function selectWorkspaceFiles (root) {
  const listed = listWorkspaces(root)
  if (listed.error) return listed
  const skip = skipList()
  const entries = []
  const skipped = []
  for (const dir of listed.dirs) {
    const cwd = path.join(root, dir)
    let pkg
    try { pkg = readJson(path.join(cwd, 'package.json')) } catch (err) {
      return { error: '# package.json ilegível em ' + dir + ': ' + err.message }
    }
    const script = pkg.scripts && pkg.scripts.test
    if (!script) continue
    const m = /^node (\S+)$/.exec(script.trim())
    if (!m || path.resolve(cwd, m[1]) !== path.join(root, RUNNER)) {
      return { error: '# workspace ' + dir + ': o script de teste não é este executor (' + script + ')' }
    }
    if (skip.includes(dir)) {
      skipped.push(dir)
      continue
    }
    const files = testFiles(cwd)
    if (files.length === 0) return { error: '# workspace ' + dir + ': nenhum arquivo de teste' }
    for (const file of files) entries.push({ cwd, file, label: dir + '/' + posix(file) })
  }
  return { entries, skipped }
}

function durationsPath () {
  return envValue('VARANDA_TEST_DURATIONS') || path.join(ROOT, 'node_modules', '.cache', 'varanda-test-durations.json')
}

function durationKey (entry) {
  return posix(path.relative(ROOT, path.resolve(entry.cwd, entry.file)))
}

function loadDurations () {
  try {
    const data = readJson(durationsPath())
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

// Written to a temp file and renamed, so a reader never sees half a file.
function saveDurations (known, entries, results) {
  const next = { ...known }
  entries.forEach((entry, i) => { next[durationKey(entry)] = results[i].ms })
  const file = durationsPath()
  const tmp = file + '.' + process.pid + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(next) + '\n')
    fs.renameSync(tmp, file)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

function runOrder (entries, known, pooled) {
  const order = entries.map((entry, i) => i)
  if (!pooled) return order
  const ms = (i) => {
    const value = known[durationKey(entries[i])]
    return Number.isFinite(value) && value >= 0 ? value : Infinity
  }
  return order.sort((a, b) => (ms(b) - ms(a)) || (a - b))
}

// Only a finite positive value is accepted: setTimeout throws on Infinity or
// negative delays, which would crash the runner after a detached spawn.
const requested = Number(process.env.VARANDA_TEST_TIMEOUT_MS)
const timeout = Number.isFinite(requested) && requested > 0 && requested <= 2147483647 ? requested : 180000

// Resolves { ok, ms }: whether the file passed, and how long it took.
function runFile (entry, pooled) {
  return new Promise((resolve) => {
    const started = Date.now()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-run-'))
    const env = { ...process.env, VARANDA_TEST_TMPDIR: root }
    let child
    try {
      child = spawn(process.execPath, [entry.file], {
        cwd: entry.cwd,
        stdio: pooled ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        detached: true,
        env
      })
    } catch (err) {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
      throw err
    }
    live.set(child, { root, file: entry.label })
    const chunks = []
    if (pooled) {
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.stderr.on('data', (chunk) => chunks.push(chunk))
    }
    // Keeps a runner line or the next file's header off the end of a last
    // output line that has no newline.
    const endLine = () => {
      const last = chunks[chunks.length - 1]
      if (last && last.length > 0 && last[last.length - 1] !== 10) chunks.push(Buffer.from('\n'))
    }
    const note = (line) => {
      if (!pooled) return out(line + '\n')
      endLine()
      chunks.push(Buffer.from(line + '\n'))
    }
    let timedOut = false
    let closeGuard = null
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child)
      note('# tempo esgotado: ' + entry.label)
    }, timeout)
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(closeGuard)
      live.delete(child)
      try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
      if (pooled) {
        endLine()
        out(Buffer.concat([Buffer.from('# ' + entry.label + '\n'), ...chunks]))
      }
      resolve({ ok, ms: Date.now() - started })
    }
    const settle = (status, signal) => {
      if (timedOut) return finish(false)
      if (signal) {
        note('# encerrado pelo sinal ' + signal + ': ' + entry.label)
        return finish(false)
      }
      finish(status === 0)
    }
    child.on('error', () => finish(false))
    child.on('exit', (status, signal) => {
      // The deadline is for the test process, not for draining its pipes, so
      // a file that exited in time is never reported as timed out.
      if (!timedOut) clearTimeout(timer)
      // The test exited; make sure nothing it spawned keeps running.
      killGroup(child)
      if (!pooled) return settle(status, signal)
      // A grandchild that left the group could hold the pipes open forever,
      // so stop waiting for 'close' after a grace period.
      closeGuard = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
      }, 5000)
    })
    if (pooled) child.on('close', settle)
  })
}

async function runPool (entries, size, order) {
  const results = entries.map(() => ({ ok: true, ms: 0 }))
  const pooled = size > 1
  let next = 0
  const worker = async () => {
    while (next < order.length) {
      if (stopping) return
      const i = order[next++]
      if (!pooled) await out('# ' + entries[i].label + '\n')
      results[i] = await runFile(entries[i], pooled)
    }
  }
  const workers = []
  for (let n = 0; n < size; n++) workers.push(worker())
  await Promise.all(workers)
  return results
}

async function main () {
  const args = process.argv.slice(2)
  const workspaces = args[0] === '--workspaces'
  if (workspaces && args.length > 1) return finalExit('# --workspaces não aceita arquivos\n', 1)
  if (!workspaces) {
    const skipped = workspaceSkipped()
    if (skipped !== null) return finalExit('# workspace ' + skipped + ' pulado (coberto por outro job)\n', 0)
  }
  const shard = parseShard()
  if (shard && shard.error) return finalExit(shard.error + '\n', 1)
  const concurrency = parseConcurrency()
  if (concurrency.error) return finalExit(concurrency.error + '\n', 1)

  let entries
  if (workspaces) {
    const selected = selectWorkspaceFiles(process.cwd())
    if (selected.error) return finalExit(selected.error + '\n', 1)
    for (const dir of selected.skipped) await out('# workspace ' + dir + ' pulado (coberto por outro job)\n')
    if (selected.entries.length === 0 && selected.skipped.length > 0) return finalExit('', 0)
    entries = selected.entries
  } else {
    entries = selectFiles(args)
  }
  if (entries.length === 0) return finalExit('# nenhum arquivo de teste\n', 1)
  if (shard) {
    entries = entries.filter((entry, i) => i % shard.total === shard.index - 1)
    if (entries.length === 0) return finalExit('# nenhum arquivo neste fragmento\n', 1)
  }

  onSignal('SIGINT', 130)
  onSignal('SIGTERM', 143)

  const size = Math.min(concurrency.value, entries.length)
  const known = loadDurations()
  const results = await runPool(entries, size, runOrder(entries, known, size > 1))
  saveDurations(known, entries, results)
  const failed = entries.filter((entry, i) => !results[i].ok)
  for (const entry of failed) out('# falha: ' + entry.label + '\n')
  return finalExit('# ' + entries.length + ' arquivo(s) de teste, ' + failed.length + ' falha(s)\n', failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  killAllLive()
  finalExit('# erro no executor de testes: ' + err.message + '\n', 1)
})
