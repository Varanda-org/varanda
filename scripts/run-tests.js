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
// Shard (VARANDA_TEST_SHARD=I/N) splits round robin over the selection, so
// the split is deterministic and appending a file moves no other file. A
// shard that selects nothing fails, so a mistyped CI job never goes green.
// Skip (VARANDA_TEST_SKIP_WORKSPACES) lets CI run a workspace in a dedicated
// sharded job and skip it in the job that runs `npm test --workspaces`.
// Every variable treats an empty string as unset, since an unset value in a
// workflow env expands to an empty string.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

function envValue (name) {
  const value = process.env[name]
  return value === undefined || value === '' ? null : value
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

function workspaceSkipped () {
  const list = envValue('VARANDA_TEST_SKIP_WORKSPACES')
  if (list === null) return null
  const current = path.relative(path.resolve(__dirname, '..'), process.cwd()).split(path.sep).join('/')
  const entries = list.split(',').map((entry) => entry.trim()).filter(Boolean)
  return entries.includes(current) ? current : null
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

function selectFiles () {
  const files = process.argv.slice(2)
  if (files.length > 0) return files
  const dir = 'test'
  return fs.existsSync(dir)
    ? fs.readdirSync(dir)
      .filter((name) => name.endsWith('.test.js'))
      .sort()
      .map((name) => path.join(dir, name))
    : []
}

// Only a finite positive value is accepted: setTimeout throws on Infinity or
// negative delays, which would crash the runner after a detached spawn.
const requested = Number(process.env.VARANDA_TEST_TIMEOUT_MS)
const timeout = Number.isFinite(requested) && requested > 0 && requested <= 2147483647 ? requested : 180000

// Resolves true when the file passed.
function runFile (file, pooled) {
  return new Promise((resolve) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-run-'))
    const env = { ...process.env, VARANDA_TEST_TMPDIR: root }
    let child
    try {
      child = spawn(process.execPath, [file], {
        stdio: pooled ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        detached: true,
        env
      })
    } catch (err) {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
      throw err
    }
    live.set(child, { root, file })
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
      note('# tempo esgotado: ' + file)
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
        out(Buffer.concat([Buffer.from('# ' + file + '\n'), ...chunks]))
      }
      resolve(ok)
    }
    const settle = (status, signal) => {
      if (timedOut) return finish(false)
      if (signal) {
        note('# encerrado pelo sinal ' + signal + ': ' + file)
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

async function runPool (files, size) {
  const results = new Array(files.length).fill(true)
  const pooled = size > 1
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      if (stopping) return
      const i = next++
      if (!pooled) await out('# ' + files[i] + '\n')
      results[i] = await runFile(files[i], pooled)
    }
  }
  const workers = []
  for (let n = 0; n < size; n++) workers.push(worker())
  await Promise.all(workers)
  return results
}

async function main () {
  const skipped = workspaceSkipped()
  if (skipped !== null) return finalExit('# workspace ' + skipped + ' pulado (coberto por outro job)\n', 0)
  const shard = parseShard()
  if (shard && shard.error) return finalExit(shard.error + '\n', 1)
  const concurrency = parseConcurrency()
  if (concurrency.error) return finalExit(concurrency.error + '\n', 1)

  let files = selectFiles()
  if (files.length === 0) return finalExit('# nenhum arquivo de teste\n', 1)
  if (shard) {
    files = files.filter((file, i) => i % shard.total === shard.index - 1)
    if (files.length === 0) return finalExit('# nenhum arquivo neste fragmento\n', 1)
  }

  onSignal('SIGINT', 130)
  onSignal('SIGTERM', 143)

  const results = await runPool(files, Math.min(concurrency.value, files.length))
  const failed = files.filter((file, i) => !results[i])
  for (const file of failed) out('# falha: ' + file + '\n')
  return finalExit('# ' + files.length + ' arquivo(s) de teste, ' + failed.length + ' falha(s)\n', failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  killAllLive()
  finalExit('# erro no executor de testes: ' + err.message + '\n', 1)
})
