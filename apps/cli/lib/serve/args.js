'use strict'

// Command line of varanda-serve. Its own flags are parsed here; the member
// flags (--data, --association, --bootstrap, --dht-host) and the VARANDA_*
// variables go through the CLI's parseArgs unchanged. Everything else is
// 'opção desconhecida'. The token is never a flag (visible in `ps`) and never
// a fixed value: it is generated on every start, so a URL left in the
// browser's history stops working when the process ends.

const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const { randomBytes } = require('hypercore-crypto')
const { parseArgs, UsageError } = require('../cli')
const { readConfig } = require('@varanda/core/lib/store')

const HELP = `varanda-serve — nó Varanda local para a interface web
Uso: node bin/varanda-serve.js [opções]
Escuta só em 127.0.0.1. O token é gerado a cada início e impresso uma vez.
Opções:
  --port <n>                 porta local (padrão 8787; 0 = qualquer porta livre)
  --origin <url>             origem permitida no WebSocket, repetível (ex.: http://localhost:8081)
  --ui <dir>                 diretório com a exportação web estática a servir
  --account-origin <url>     origem https pública do serviço de conta, liga as Páginas no app (ex.: https://varanda.org)
  --public-dht               usa a DHT pública (opt-in; exclusivo com --bootstrap)
  --data <dir>               diretório de dados do membro (ou VARANDA_DATA, padrão ./data)
  --association <hex>        chave pública da associação (ou VARANDA_ASSOCIATION)
  --bootstrap <host:porta>   repetível (ou VARANDA_BOOTSTRAP, separado por vírgula)
  --dht-host <ip>            endereço local da DHT (ou VARANDA_DHT_HOST)
  --help                     esta ajuda`

const DEFAULT_PORT = 8787
const DEFAULT_OPEN_TIMEOUT_MS = 5000

const memberFlags = new Set(['--data', '--association', '--bootstrap', '--dht-host'])
const ownStringFlags = new Set(['--port', '--origin', '--ui', '--account-origin'])

function port (value) {
  if (!/^[0-9]{1,5}$/.test(value) || Number(value) > 65535) throw new UsageError('porta inválida')
  return Number(value)
}

// An exact origin: scheme http(s), host, optional port; no path, query,
// fragment or credentials, already in canonical form.
function origin (value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new UsageError('origem inválida ' + value)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
    throw new UsageError('origem inválida ' + value)
  }
  return value
}

// The account service the app's Páginas call: a public https origin only
// (the app's pageGate ignores anything else), in canonical form. Not a secret.
function accountOrigin (value) {
  let url = null
  try {
    url = new URL(value)
  } catch {}
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.origin !== value) {
    throw new UsageError('--account-origin inválido: use https://<host>')
  }
  return value
}

function uiRoot (value, cwd) {
  let real
  try {
    real = fs.realpathSync(path.resolve(cwd, value))
  } catch {
    throw new UsageError('--ui não é um diretório')
  }
  if (!fs.statSync(real).isDirectory()) throw new UsageError('--ui não é um diretório')
  return real
}

// A fixed token would keep a URL recorded in the browser's history valid
// across restarts, so the old variable is refused instead of ignored.
function resolveToken (env) {
  if (env.VARANDA_SERVE_TOKEN !== undefined) throw new UsageError('VARANDA_SERVE_TOKEN não é aceito: o token é gerado a cada início')
  return b4a.toString(randomBytes(32), 'hex')
}

// Test hook only (README): a shorter session.open deadline, never a longer one.
function openTimeout (env) {
  const raw = env.VARANDA_SERVE_OPEN_TIMEOUT_MS
  if (raw === undefined) return DEFAULT_OPEN_TIMEOUT_MS
  const n = Number(raw)
  if (!/^[1-9][0-9]{0,3}$/.test(raw) || n > DEFAULT_OPEN_TIMEOUT_MS) throw new UsageError('VARANDA_SERVE_OPEN_TIMEOUT_MS inválido')
  return n
}

// The association: the flag or VARANDA_ASSOCIATION, else the one recorded in
// an existing config.json (as the CLI's trustRoot reads it).
function association (flags) {
  if (flags.association) return flags.association
  let config = null
  try {
    config = readConfig(flags.dataDir)
  } catch {
    throw new UsageError('diretório não é de um membro')
  }
  if (config !== null && typeof config === 'object' && typeof config.association === 'string') return config.association
  throw new UsageError('informe --association <hex>')
}

// -> { help: true } or the full configuration. Throws UsageError.
function parseServeArgs (argv, env = process.env, cwd = process.cwd()) {
  const rest = []
  const origins = []
  let portValue = null
  let ui = null
  let accountOriginValue = null
  let publicDht = false
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--help' || token === '-h') {
      help = true
    } else if (token === '--public-dht') {
      publicDht = true
    } else if (ownStringFlags.has(token) || memberFlags.has(token)) {
      const value = argv[i + 1]
      if (value === undefined) throw new UsageError('falta o valor de ' + token)
      i++
      if (token === '--port') portValue = value
      else if (token === '--origin') origins.push(value)
      else if (token === '--ui') ui = value
      else if (token === '--account-origin') accountOriginValue = value
      else rest.push(token, value)
    } else if (token.startsWith('-')) {
      throw new UsageError('opção desconhecida ' + token)
    } else {
      throw new UsageError('argumento inesperado ' + token)
    }
  }
  if (help) return { help: true }

  const flags = parseArgs(rest, env, cwd)
  const listenPort = portValue === null ? DEFAULT_PORT : port(portValue)
  const allowed = origins.map(origin)
  const root = ui === null ? null : uiRoot(ui, cwd)
  const account = accountOriginValue === null ? null : accountOrigin(accountOriginValue)
  if (root === null && allowed.length === 0) throw new UsageError('informe --origin ou --ui')
  if (publicDht && flags.bootstrap !== undefined) throw new UsageError('--bootstrap e --public-dht são exclusivos')
  if (!publicDht && flags.bootstrap === undefined) throw new UsageError('informe --bootstrap ou --public-dht')
  const token = resolveToken(env)
  const openTimeoutMs = openTimeout(env)

  return {
    help: false,
    port: listenPort,
    origins: allowed,
    uiRoot: root,
    token,
    openTimeoutMs,
    accountOrigin: account,
    session: {
      dataDir: flags.dataDir,
      association: association(flags),
      bootstrap: publicDht ? null : flags.bootstrap,
      dhtHost: flags.dhtHost,
      allowPublicDht: publicDht
    }
  }
}

module.exports = { parseServeArgs, HELP, DEFAULT_PORT, DEFAULT_OPEN_TIMEOUT_MS }
