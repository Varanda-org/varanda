// The iOS worklet gate, app side (docs/ios-gate.md). Driven by
// scripts/gate-server.js on the Mac over HTTP (the simulator reaches the
// Mac's loopback):
//   GET  /config  -> { runId, association, bootstrap, peerKey, peerPost, phase, reload }
//   POST /certify { publicKey } -> { cert }
//   POST /report  { step, ok, detail }
// The driver keeps the state across app kills: `phase` says where this
// launch resumes ('fresh' -> steps a-d, 'relaunched' -> steps e-i, and with
// `reload` 'reloaded' -> step j, after a full JS reload of the same process).

import { AppState, DevSettings } from 'react-native'
import { startNode, startProbe, terminateNode, documentPath } from '../client'

const APP_POST = 'post do app (gate)'

function describe (err) {
  if (err && typeof err === 'object') return (err.code ? err.code + ' ' : '') + String(err.message)
  return String(err)
}

async function http (base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (!res.ok) throw new Error(method + ' ' + path + ' -> HTTP ' + res.status)
  return res.json()
}

function waitFor (predicate, timeoutMs, name) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      let value
      try { value = predicate() } catch (err) { return reject(err) }
      if (value) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error('tempo esgotado: ' + name))
      setTimeout(tick, 100)
    }
    tick()
  })
}

// AppState went to the background and came back to the foreground.
function waitBackgroundAndBack (timeoutMs) {
  return new Promise((resolve, reject) => {
    let wentAway = false
    const timer = setTimeout(() => {
      sub.remove()
      reject(new Error('tempo esgotado: segundo plano'))
    }, timeoutMs)
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') wentAway = true
      if (next === 'active' && wentAway) {
        clearTimeout(timer)
        sub.remove()
        resolve()
      }
    })
  })
}

export async function runGate (base, show) {
  // Every line is also sent to the driver as a 'trace' report (fire and
  // forget), so a stalled step shows where it stopped.
  const log = (line) => {
    show(line)
    http(base, 'POST', '/report', { step: 'trace', ok: true, detail: line }).catch(() => {})
  }
  const events = []
  const onEvent = (name, data) => events.push({ name, data })
  const report = async (step, ok, detail) => {
    log((ok ? 'ok   ' : 'FAIL ') + step + ': ' + detail)
    await http(base, 'POST', '/report', { step, ok, detail })
  }
  // Runs one step: a throw is reported as that step's failure and stops.
  const step = async (name, fn) => {
    let detail
    try {
      detail = await fn()
    } catch (err) {
      await report(name, false, describe(err))
      throw err
    }
    await report(name, true, detail)
  }

  const cfg = await http(base, 'GET', '/config')
  log('gate run ' + cfg.runId + ', phase ' + cfg.phase)
  if (cfg.phase === 'done') return
  const dataDir = documentPath() + '/varanda-gate-' + cfg.runId
  const node = await startNode({
    association: cfg.association,
    bootstrap: cfg.bootstrap,
    dataDir,
    diagnostics: true
  }, { onEvent })
  const call = (method, params) => node.client.request(method, params)
  log('node started (recover ' + node.recovered + ')')

  if (cfg.phase === 'fresh') {
    await step('a', async () => {
      const diag = await waitFor(() => events.find((e) => e.name === 'warning' && e.data.line.startsWith('diag ')), 10000, 'diag')
      const line = diag.data.line
      if (!line.includes('structuredClone=function')) throw new Error('structuredClone ausente: ' + line)
      if (!line.includes('O_NOFOLLOW=yes') || !line.includes('O_EXCL=yes')) throw new Error('fachada fs ausente: ' + line)
      return line
    })
    let publicKey
    await step('b', async () => {
      const r = await call('identity.create')
      publicKey = r.publicKey
      return 'identity.create ' + publicKey
    })
    await step('c', async () => {
      const { cert } = await http(base, 'POST', '/certify', { publicKey })
      const r = await call('cert.add', { cert })
      const info = await call('node.info')
      if (info.memberCert !== true) throw new Error('memberCert false')
      return 'cert.add seq ' + r.seq + ', node.info memberCert true'
    })
    await step('d', async () => {
      const r = await call('post.create', { text: APP_POST })
      return 'post.create ' + r.ref
    })
    // A continuous sync holds the data-dir lock while the app is killed, so
    // the relaunch must recover it (step e).
    const { runId } = await call('sync.start', { once: false })
    await waitFor(() => events.find((e) => e.name === 'sync.event' && e.data.runId === runId && e.data.line === 'sync ready'), 30000, 'sync ready')
    await report('ready:kill', true, 'continuous sync ' + runId + ' running (lock held)')
    return
  }

  if (cfg.phase === 'reloaded') {
    await step('j', async () => {
      if (node.recovered !== true) throw new Error('início sem recover')
      const info = await call('node.info')
      const entries = (await call('log.read', {})).entries
      if (!entries.some((e) => e.record.type === 'post' && e.record.text === APP_POST)) throw new Error('post ausente após o reload')
      const { runId } = await call('sync.start', { once: false })
      await waitFor(() => events.find((e) => e.name === 'sync.event' && e.data.runId === runId && e.data.line === 'sync ready'), 30000, 'sync ready')
      return 'startNode after the JS reload opened the store (recover true, no LOCKED), node.info publicKey ' + info.publicKey.slice(0, 8) +
        ', ' + entries.length + ' entries, continuous sync ready'
    })
    await call('sync.stop')
    await report('done', true, 'all app steps finished')
    return
  }

  // phase 'relaunched'
  await step('e', async () => {
    if (node.recovered !== true) throw new Error('cold start sem recover')
    const log = await call('log.read', {})
    const post = log.entries.find((e) => e.record.type === 'post' && e.record.text === APP_POST)
    if (!post) throw new Error('post ausente após relançar (' + log.entries.length + ' entradas)')
    return 'log.read after kill+relaunch: seq ' + post.seq + ' "' + APP_POST + '" (' + log.entries.length + ' entries, recover true)'
  })

  await step('f', async () => {
    await call('follow.add', { key: cfg.peerKey })
    const { runId } = await call('sync.start', { once: true, timeoutMs: 60000 })
    const stopped = await waitFor(() => events.find((e) => e.name === 'sync.stopped' && e.data.runId === runId), 90000, 'sync.stopped')
    const result = stopped.data.result
    if (!result || result.ok !== true) throw new Error('sync once: ' + JSON.stringify(result))
    const feed = await call('feed.read', {})
    const item = feed.items.find((i) => i.author === cfg.peerKey && i.text === cfg.peerPost)
    if (!item) throw new Error('post do par CLI ausente no feed (' + feed.items.length + ' itens)')
    return 'app sync once ' + stopped.data.reason + ' (seederConfirmed ' + result.seederConfirmed + ', downloaded ' +
      JSON.stringify(result.downloaded) + '); feed.read has the CLI peer post "' + item.text + '"'
  })

  await report('ready:background', true, 'waiting for background and foreground')
  await step('g', async () => {
    await waitBackgroundAndBack(180000)
    const info = await call('node.info')
    return 'node.info after background/resume: publicKey ' + info.publicKey.slice(0, 8) + ', sync ' + info.sync.state
  })

  await step('h', async () => {
    const { runId } = await call('sync.start', { once: false })
    await waitFor(() => events.find((e) => e.name === 'sync.event' && e.data.runId === runId && e.data.line === 'sync ready'), 30000, 'sync ready')
    log('h: main sync running, starting the probe worklet')
    const probe = await startProbe({ association: cfg.association, bootstrap: cfg.bootstrap, dataDir })
    log('h: probe open, calling node.info')
    let outcome
    let stopMs = null
    let probeClean = null
    try {
      await probe.client.request('node.info')
      outcome = 'answered'
    } catch (err) {
      outcome = err.code
    } finally {
      log('h: probe answered ' + outcome + ', stopping it')
      const t0 = Date.now()
      probeClean = await probe.stop()
      stopMs = Date.now() - t0
    }
    await call('sync.stop')
    const info = await call('node.info')
    if (outcome !== 'LOCKED') throw new Error('segundo worklet: ' + outcome)
    if (probeClean !== true || stopMs >= 5000) throw new Error('parada do segundo worklet: clean ' + probeClean + ', ' + stopMs + ' ms')
    return 'second worklet (no recover) node.info -> LOCKED; its node.close stop clean in ' + stopMs +
      ' ms; first worklet still answers (' + info.publicKey.slice(0, 8) + ')'
  })

  let running = null
  await step('i', async () => {
    log('i: terminateNode')
    const t0 = Date.now()
    const clean = await terminateNode()
    log('i: stopped (clean ' + clean + '), startNode')
    const stopMs = Date.now() - t0
    if (clean !== true) throw new Error('terminateNode não foi limpo (' + stopMs + ' ms)')
    const t1 = Date.now()
    // recover: false proves node.close released the lock (the app itself
    // always starts with recover after terminating its worklet).
    const again = await startNode({ association: cfg.association, bootstrap: cfg.bootstrap, dataDir }, { onEvent, recover: false })
    running = again
    if (again.recovered !== false) throw new Error('reinício usou recover')
    const info = await again.client.request('node.info')
    const entries = (await again.client.request('log.read', {})).entries
    const startMs = Date.now() - t1
    if (!entries.some((e) => e.record.type === 'post' && e.record.text === APP_POST)) throw new Error('post ausente após reinício')
    return 'terminateNode clean in ' + stopMs + ' ms; startNode without recover + node.info + log.read in ' + startMs +
      ' ms (publicKey ' + info.publicKey.slice(0, 8) + ', ' + entries.length + ' entries)'
  })
  if (cfg.reload === true) {
    // A failure before the reload is step j's result: the driver would
    // otherwise wait out the whole gate timeout for a report that never comes.
    try {
      if (typeof DevSettings.reload !== 'function') throw new Error('sem DevSettings.reload (build de release)')
      // Not Fast Refresh: a full reload makes a new JS context in this same
      // process while the worklet above is still running its continuous sync.
      const { runId } = await running.client.request('sync.start', { once: false })
      await waitFor(() => events.find((e) => e.name === 'sync.event' && e.data.runId === runId && e.data.line === 'sync ready'), 30000, 'sync ready')
      await report('ready:reload', true, 'continuous sync ' + runId + ' running, reloading the JS context')
      DevSettings.reload()
    } catch (err) {
      await report('j', false, 'antes do reload: ' + describe(err))
      throw err
    }
    return
  }
  await report('done', true, 'all app steps finished')
}
