'use strict'

const { Seeder } = require('@varanda/core/lib/seeder')
const { UsageError } = require('../cli')
const { startHealth, DEFAULT_HOST } = require('../health')
const { safe, jsonLine } = require('@varanda/core/lib/safe')
const { createPushRelay } = require('../push-relay')

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
    default: return safe(event.event)
  }
}

async function listenHealth (flags, seeder) {
  try {
    return await startHealth({ host: flags.healthHost || DEFAULT_HOST, port: flags.healthPort, stats: () => seeder.stats() })
  } catch (err) {
    if (err.code === 'EADDRINUSE') throw new Error('porta em uso')
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

async function listenWs (flags, seeder) {
  // Loaded only with --ws-port: without it the ws module is never touched.
  const { startSeedWs, DEFAULT_HOST: WS_HOST } = require('../seed-ws')
  try {
    return await startSeedWs({
      host: flags.wsHost || WS_HOST,
      port: flags.wsPort,
      seeder,
      origins: flags.wsOrigins,
      sockets: flags.maxSockets ?? null,
      media: setKeys(flags.media),
      index: setKeys(flags.index),
      triageToken: flags.triageToken
    })
  } catch (err) {
    if (err.code === 'EADDRINUSE') throw new Error('porta em uso')
    throw new Error('não foi possível abrir o websocket (' + safe(err.code || err.message) + ')')
  }
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
  // Without VARANDA_PUSH_TOKEN no relay exists and the seeder skips push work.
  const relay = flags.pushToken == null ? null : createPushRelay({ baseUrl: flags.accountHttp, token: flags.pushToken })
  if (relay !== null) options.onPush = (ev) => relay.send(ev)
  log({ event: 'push', reason: relay === null ? 'desligado' : 'ligado' })
  const seeder = new Seeder(options)
  // Handlers go in BEFORE start(): a signal during startup (DHT join) must not
  // take Node's default terminate path; the seeder is closed once start settles.
  let onSignal
  const stopped = new Promise((resolve) => {
    onSignal = () => resolve()
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })
  // The health and WebSocket endpoints listen before start(), so a busy port fails before
  // the data dir or the network is touched; it answers 503 until ready.
  let health = null
  let ws = null
  try {
    if (flags.healthPort !== null) {
      health = await listenHealth(flags, seeder)
      log({ event: 'health', host: health.host, port: health.port })
    }
    if (flags.wsPort !== null) {
      ws = await listenWs(flags, seeder)
      log({ event: 'ws', host: ws.host, port: ws.port })
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
  try {
    // A fatal purge failure closes the seeder by itself.
    await Promise.race([stopped, seeder.closed])
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (relay) relay.close()
    await seeder.close()
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
  commands: {
    seed: { summary: 'semeador sempre ligado', run }
  }
}
