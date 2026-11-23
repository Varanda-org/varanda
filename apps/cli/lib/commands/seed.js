'use strict'

const { Seeder } = require('@varanda/core/lib/seeder')
const clock = require('@varanda/core/lib/clock')
const { UsageError } = require('../cli')
const { startHealth, DEFAULT_HOST } = require('../health')
const { safe, jsonLine } = require('@varanda/core/lib/safe')
const { createPushRelay } = require('../push-relay')
const { createPostageFile, createBlobPostageFile } = require('../dm-postage-file')

const USAGE = 'node bin/varanda.js seed [key|cert add|list|drop <chave>|status]'

function print (flags, result, line) {
  process.stdout.write((flags.json ? jsonLine(result) : line) + '\n')
}

function short (hex) {
  return safe(String(hex).slice(0, 8))
}

function url (host, port) {
  return 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port
}

function wsUrl (host, port) {
  return 'ws://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port + '/seeder'
}

function eventLine (event) {
  switch (event.event) {
    case 'ready': return 'seed ready'
    case 'standby': return 'seed em espera: aguardando as portas do processo anterior'
    case 'health': return 'health ' + safe(url(event.host, event.port))
    case 'ws': return 'ws ' + safe(wsUrl(event.host, event.port))
    case 'peer': return 'peer ' + safe(event.role) + ' ' + short(event.peerKey)
    case 'admitted': return 'admitted ' + safe(event.key) + ' ' + safe(event.length)
    case 'rejected': return 'rejected ' + safe(event.key) + ' ' + safe(event.reason)
    case 'have': return 'have ' + safe(event.key) + ' ' + safe(event.length)
    case 'fatal': return 'fatal ' + safe(event.key) + ' ' + safe(event.reason)
    case 'media-admitted': return 'media admitted ' + safe(event.key) + ' ' + safe(event.diary) + ' ' + safe(event.length)
    case 'media-rejected': return 'media rejected ' + safe(event.key) + ' ' + safe(event.diary) + ' ' + safe(event.reason)
    case 'blocklist': return 'blocklist ' + safe(event.seq)
    case 'push': return 'push ' + safe(event.reason)
    case 'dm': return 'dm ' + safe(event.reason)
    case 'dm-stamp': return 'dm-stamp ' + safe(event.reason)
    case 'visit': return 'visit ' + safe(event.reason)
    case 'blob': return 'blob ' + safe(event.reason)
    default: return safe(event.event)
  }
}

// err.busy marks a port in use, which a standby start waits out.
function busy () {
  const err = new Error('porta em uso')
  err.busy = true
  return err
}

async function listenHealth (flags, seeder) {
  try {
    return await startHealth({ host: flags.healthHost || DEFAULT_HOST, port: flags.healthPort, stats: () => seeder.stats() })
  } catch (err) {
    if (err.code === 'EADDRINUSE') throw busy()
    throw new Error('não foi possível abrir o endpoint de saúde (' + safe(err.code || err.message) + ')')
  }
}

// Only the keys that are set (not null): an unset variable keeps the default.
function setKeys (limits) {
  const out = {}
  for (const [name, value] of Object.entries(limits || {})) {
    if (value !== null && value !== undefined) out[name] = value
  }
  return out
}

// How long the WebSocket listener holds an app's /seeder upgrade while the
// seeder starts, instead of a 503 at once: 8 s plus Caddy's 5 s dial hold
// stays under the app's 15 s dial timeout.
const WS_START_HOLD_MS = 8000

// The transcoder and the listener options, built once: a standby start
// retries the bind without making a new transcoder each time.
function prepareWs (flags, seeder) {
  // Loaded only with --ws-port: without it the ws module is never touched.
  const { startSeedWs, DEFAULT_HOST: WS_HOST } = require('../seed-ws')
  const { createOgTranscoder } = require('../og-transcode')
  const transcoder = flags.postsOrigin || flags.publicOrigin ? createOgTranscoder() : null
  if (transcoder) {
    transcoder.ready().then(({ avif }) => {
      print(flags, { event: 'photo-preview', avif }, 'prévia de fotos: avif ' + safe(avif))
    })
  }
  const options = {
    host: flags.wsHost || WS_HOST,
    port: flags.wsPort,
    seeder,
    origins: flags.wsOrigins,
    sockets: flags.maxSockets ?? null,
    media: setKeys(flags.media),
    index: setKeys(flags.index),
    triageToken: flags.triageToken,
    publicOrigin: flags.publicOrigin ?? null,
    postsOrigin: flags.postsOrigin ?? null,
    transcoder,
    startHoldMs: WS_START_HOLD_MS
  }
  return {
    async closeTranscoder () { if (transcoder) await transcoder.close() },
    async bind () {
      try {
        const ws = await startSeedWs(options)
        return {
          ...ws,
          async close () {
            try { await ws.close() } finally { if (transcoder) await transcoder.close() }
          }
        }
      } catch (err) {
        if (err.code === 'EADDRINUSE') throw busy()
        throw new Error('não foi possível abrir o websocket (' + safe(err.code || err.message) + ')')
      }
    }
  }
}

async function listenWs (flags, seeder) {
  const prepared = prepareWs(flags, seeder)
  try {
    return await prepared.bind()
  } catch (err) {
    await prepared.closeTranscoder()
    throw err
  }
}

// What a start would throw for a missing key or a bad certificate, read
// without the lock or the store, so a standby process fails at once instead
// of waiting only to fail at seeder.start().
function checkStartable (flags) {
  const status = Seeder.status(flags.dataDir, flags.association)
  if (status.publicKey === null) throw new Error('chave do semeador não encontrada (use seed key)')
  if (status.certificate === 'missing') throw new Error('certificado do semeador não encontrado (use seed cert add)')
  if (status.certificate !== 'ok') throw new Error('certificado do semeador inválido (' + safe(status.certificate) + ')')
}

const START_WAIT_RETRY_MS = 100

function noop () {}

// The seeder's dm option: direct messages are on unless --no-dm, and with
// them the blob stamps, the blob channel and the /blob route (all off with
// --no-dm). The postage key files (dm-postage.json and blob-postage.json, two
// separate key pairs) are read or made only when a peer first needs them,
// never here. onNotice hands a DM notice box to the push relay when there is
// one; without it the seeder still acks each wake and drops the box.
function dmOption (flags, onNotice = noop) {
  if (flags.noDm === true) return null
  const dm = { postage: createPostageFile(flags.dataDir), blobPostage: createBlobPostageFile(flags.dataDir), onNotice }
  if (flags.blobBytes != null) dm.blobBytes = flags.blobBytes
  return dm
}

async function runSeeder (flags) {
  const log = (event) => {
    process.stdout.write((flags.json ? jsonLine(event) : eventLine(event)) + '\n')
  }
  const options = {
    dataDir: flags.dataDir,
    associationKey: flags.association,
    bootstrap: flags.bootstrap,
    host: flags.dhtHost || undefined,
    log
  }
  // Web limits from the environment; unset ones keep the seeder's defaults.
  if (flags.maxExternal != null) options.maxExternal = flags.maxExternal
  if (flags.frameMemory != null) options.maxFrameMemory = flags.frameMemory
  if (flags.storageBytes != null) options.storageBytes = flags.storageBytes
  // Without VARANDA_PUSH_TOKEN no relay exists and the seeder skips push work.
  const relay = flags.pushToken == null ? null : createPushRelay({ baseUrl: flags.accountHttp, token: flags.pushToken, log })
  if (relay !== null) {
    options.onPush = (ev) => relay.send(ev)
    options.onGroupNotice = (ev) => relay.sendGroup(ev)
  }
  log({ event: 'push', reason: relay === null ? 'desligado' : 'ligado' })
  options.dm = dmOption(flags, relay === null ? noop : (box) => { relay.sendDm(box) })
  const seeder = new Seeder(options)
  // Handlers go in BEFORE start(): a signal during startup (DHT join) must not
  // take Node's default terminate path; the seeder is closed once start settles.
  let onSignal
  let stopStartedAt = 0
  const stopped = new Promise((resolve) => {
    onSignal = () => { if (stopStartedAt === 0) stopStartedAt = Date.now(); resolve() }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })
  // The health and WebSocket endpoints listen before start(), so a busy port fails before
  // the data dir or the network is touched; until the seeder accepts, a /seeder upgrade is
  // held up to WS_START_HOLD_MS and the other routes answer 503.
  let health = null
  let ws = null
  // Standby (VARANDA_START_WAIT with a health port): ws first, then health,
  // each retried while busy. The store is opened only after both are bound:
  // the previous process frees health only once its store has closed, and
  // seeder.start() before that could take over its lock (both are pid 1 in
  // containers).
  if (flags.startWait != null && flags.healthPort !== null) {
    let prepared = null
    let deadline = null
    const waitFor = async (bind) => {
      for (;;) {
        try {
          return await bind()
        } catch (err) {
          if (!err.busy) throw err
          if (deadline === null) {
            checkStartable(flags)
            log({ event: 'standby', at: Date.now() })
            deadline = clock.now() + flags.startWait * 1000
          }
          if (clock.now() >= deadline) throw err
          await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, START_WAIT_RETRY_MS))])
          if (stopStartedAt !== 0) return null
        }
      }
    }
    let quit = false
    try {
      if (flags.wsPort !== null) {
        prepared = prepareWs(flags, seeder)
        ws = await waitFor(() => prepared.bind())
        if (ws === null) quit = true
        else log({ event: 'ws', host: ws.host, port: ws.port, at: Date.now() })
      }
      if (!quit) {
        health = await waitFor(() => listenHealth(flags, seeder))
        if (health === null) quit = true
        else log({ event: 'health', host: health.host, port: health.port })
      }
      if (!quit && stopStartedAt !== 0) quit = true
      if (!quit) await seeder.start()
    } catch (err) {
      quit = err
    }
    if (quit !== false) {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      if (relay) relay.close()
      if (health) await health.close()
      if (ws) await ws.close()
      else if (prepared) await prepared.closeTranscoder()
      if (quit !== true) throw quit
      return 0
    }
  } else {
    try {
      if (flags.healthPort !== null) {
        health = await listenHealth(flags, seeder)
        log({ event: 'health', host: health.host, port: health.port })
      }
      if (flags.wsPort !== null) {
        ws = await listenWs(flags, seeder)
        log({ event: 'ws', host: ws.host, port: ws.port, at: Date.now() })
      }
      await seeder.start()
    } catch (err) {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      if (relay) relay.close()
      if (health) await health.close()
      if (ws) await ws.close()
      throw err
    }
  }
  try {
    // A fatal purge failure closes the seeder by itself.
    await Promise.race([stopped, seeder.closed])
  } finally {
    // Drain start: the signal. When the seeder closed itself (fatal), its
    // store is already closed here, so closeMs would measure nothing: it is
    // left out and `fatal: true` is logged instead.
    const selfClosed = stopStartedAt === 0
    if (selfClosed) stopStartedAt = Date.now()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (relay) relay.close()
    // Before seeder.close(), which destroys the app clients' sockets (a bare
    // 1006): they get 1012 'reiniciando' instead. Adds at most about 1 s.
    // drain() also stops listening, so a redial during seeder.close() is
    // refused (Caddy retries it for up to 5 s) rather than answered 503.
    // stopListeningAt: drain() stops listening first, so this is its epoch ms
    // to within the call; with the next process's ws `at` it gives the dark
    // port time across a deploy.
    const stopListeningAt = Date.now()
    if (ws) await ws.drain()
    const drainedAt = Date.now()
    await seeder.close()
    const timing = { event: 'stopped', drainMs: drainedAt - stopStartedAt }
    if (selfClosed) timing.fatal = true
    else timing.closeMs = Date.now() - stopStartedAt
    // Only when a WebSocket listener actually stopped.
    if (ws) timing.stopListeningAt = stopListeningAt
    log(timing)
    // Health closes only after the store has: a standby process binds health
    // last, so its seeder.start() never meets a store still open here.
    if (health) await health.close()
    if (ws) await ws.close()
  }
  return seeder.fatal ? 1 : 0
}

function certificateLine (certificate) {
  if (certificate === 'ok') return 'certificado: válido'
  if (certificate === 'missing') return 'certificado: ausente (use seed cert add)'
  return 'certificado: inválido (' + safe(certificate) + ')'
}

function statusLines (status) {
  return [
    'associação: ' + status.association,
    'chave do semeador: ' + (status.publicKey === null ? 'ausente (use seed key)' : status.publicKey),
    certificateLine(status.certificate),
    'diários admitidos: ' + status.admitted,
    'lista de bloqueio: ' + (status.blocklist === null ? 'nenhuma' : 'seq ' + status.blocklist.seq + ' de ' + safe(status.blocklist.date)),
    ...(status.blocklistHeld ? ['admissões: seguradas até chegar uma lista de bloqueio verificada'] : []),
    'estado: ' + (status.running ? 'em execução' : 'parado')
  ].join('\n')
}

// One line per diary, its media and group cores indented under it.
function listLines ({ admitted }) {
  if (admitted.length === 0) return 'nenhum diário admitido'
  const lines = []
  for (const e of admitted) {
    lines.push(e.key + ' ' + e.length + ' blocos ' + e.byteLength + ' bytes')
    for (const m of e.media || []) lines.push('  mídia ' + m.key + ' ' + m.length + ' blocos ' + m.byteLength + ' bytes')
    for (const g of e.groups || []) lines.push('  grupo ' + safe(g.key) + ' (grupo ' + safe(g.group).slice(0, 8) + ') ' + safe(g.length) + ' blocos ' + safe(g.byteLength) + ' bytes')
  }
  return lines.join('\n')
}

function diaryKey (value) {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new UsageError('chave inválida')
  return value.toLowerCase()
}

async function run (flags) {
  const [sub, subsub] = flags.positionals
  if (sub === undefined) return runSeeder(flags)

  if (sub === 'key' && subsub === undefined) {
    Seeder.ensureConfig(flags.dataDir, flags.association)
    const { publicKey } = Seeder.createKey(flags.dataDir)
    print(flags, { publicKey }, 'chave do semeador: ' + publicKey)
    return 0
  }

  if (sub === 'cert' && subsub === 'add' && flags.positionals.length === 2) {
    if (!flags.certFile) throw new UsageError('informe --cert-file <arquivo>')
    const association = Seeder.ensureConfig(flags.dataDir, flags.association)
    const result = Seeder.addCert(flags.dataDir, flags.certFile, association)
    print(flags, result, 'certificado do semeador gravado')
    return 0
  }

  if (sub === 'status' && subsub === undefined) {
    const status = Seeder.status(flags.dataDir, flags.association)
    print(flags, status, statusLines(status))
    return 0
  }

  if (sub === 'list' && subsub === undefined) {
    const result = await Seeder.list(flags.dataDir, flags.association)
    print(flags, result, listLines(result))
    return 0
  }

  if (sub === 'drop' && flags.positionals.length <= 2) {
    if (subsub === undefined) throw new UsageError('informe a chave do diário')
    const result = await Seeder.drop(flags.dataDir, flags.association, diaryKey(subsub))
    print(flags, result, 'diário removido do semeador: ' + result.key)
    return 0
  }

  throw new UsageError(USAGE)
}

module.exports = {
  listLines,
  dmOption,
  commands: {
    seed: { summary: 'semeador sempre ligado', run }
  }
}
