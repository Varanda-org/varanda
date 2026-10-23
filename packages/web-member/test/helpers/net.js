// Test helpers. Tests register their own closes (swarms first, then stores)
// with the default order 0 so they run before the tmp-dir removal (100) and
// the testnet destroy (Infinity). Register application teardowns
// (swarm.destroy, store.close, seeder.close) with { force: true } as well:
// brittle 4.5.0 skips non-forced teardowns when the test body threw.
// Every test file creates the testnet through this helper even when it is
// pure, and no test constructs HyperDHT or Hyperswarm without the helper's
// bootstrap list (the public DHT is never touched).
// Every DHT a test creates binds loopback only: pass localSwarmOptions(bootstrap)
// as { bootstrap, host } to runSync/Seeder, and bootstrapFlags(bootstrap) to the
// CLI (it appends '--dht-host', '127.0.0.1').
// tmpDir records every directory in a module-level Set and a single
// process 'exit' handler removes whatever is still there, because brittle's
// t.timeout path runs no teardown at all; the teardown removes the entry it
// cleans. Directories are created under VARANDA_TEST_TMPDIR when the runner
// sets it (a per-file root it removes after the child exits, even after a
// SIGKILL where no 'exit' handler runs), else under os.tmpdir(); the exit
// handler and the teardowns cover a file run alone with node test/<file>.
// until() gives the still-pending predicate promise a no-op catch when the
// deadline wins, so a late rejection is never unhandled.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TIMED_OUT = Symbol('timed out')

async function testnet (t, size = 3) {
  const raw = await require('hyperdht/testnet')(size)
  const bootstrap = raw.bootstrap.map(({ host, port }) => {
    const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    return h + ':' + port
  })
  t.teardown(() => raw.destroy(), { order: Infinity, force: true })
  return { bootstrap, raw }
}

const tmpDirs = new Set()
let exitHandlerArmed = false

function removeTmpDirsSync () {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
    tmpDirs.delete(dir)
  }
}

function tmpDir (t, prefix = 'varanda-') {
  const base = process.env.VARANDA_TEST_TMPDIR || os.tmpdir()
  const dir = fs.mkdtempSync(path.join(base, prefix))
  tmpDirs.add(dir)
  if (!exitHandlerArmed) {
    exitHandlerArmed = true
    process.once('exit', removeTmpDirsSync)
  }
  t.teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    tmpDirs.delete(dir)
  }, { order: 100, force: true })
  return dir
}

function localSwarmOptions (bootstrap) {
  return { bootstrap, host: '127.0.0.1' }
}

function bootstrapFlags (bootstrap) {
  return [...bootstrap.flatMap((b) => ['--bootstrap', b]), '--dht-host', '127.0.0.1']
}

// Polls predicate (sync or async) until it returns a truthy value; falsy
// results (false, 0, '', null, undefined) mean "not yet". Each call is raced
// against the remaining time, so a predicate that never settles still
// rejects with Error('tempo esgotado: ' + name) at the deadline. A predicate
// that throws rejects immediately with that error. When the deadline wins,
// the still-pending predicate promise gets a no-op catch so a late rejection
// is not unhandled.
async function until (predicate, { timeoutMs = 15000, intervalMs = 25, name = 'condição' } = {}) {
  const deadline = Date.now() + timeoutMs
  const timeoutError = () => new Error('tempo esgotado: ' + name)
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw timeoutError()
    let timer
    const expired = new Promise((resolve) => {
      timer = setTimeout(resolve, remaining, TIMED_OUT)
    })
    const attempt = Promise.resolve().then(predicate)
    let result
    try {
      result = await Promise.race([attempt, expired])
    } finally {
      clearTimeout(timer)
    }
    if (result === TIMED_OUT) {
      attempt.catch(() => {})
      throw timeoutError()
    }
    if (result) return result
    const wait = Math.min(intervalMs, deadline - Date.now())
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

module.exports = { testnet, tmpDir, localSwarmOptions, bootstrapFlags, until }
