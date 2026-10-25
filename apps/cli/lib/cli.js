const path = require('node:path')
const { UsageError } = require('@varanda/core/lib/errors')
const { validBootstrap } = require('@varanda/core/lib/config')

const HELP = `varanda — protótipo de rede social P2P (fase 0)
Uso: node bin/varanda.js <comando> [subcomando] [opções]
Comandos:
  assoc init|show|certify    chave da associação de teste e certificados de membro
  assoc certify-seeder       certifica a chave de um semeador (--seeder)
  assoc certify-issuer       certifica a chave do emissor do serviço de conta (--issuer)
  assoc certify-moderator    certifica a chave da moderação (--moderator)
  id create|show             identidade (chave pública do diário)
  cert add                   grava o certificado como bloco 0 do diário
  profile set                define nome e bio
  post                       publica um texto (--text)
  reply                      responde a uma publicação (--to <chave>:<seq> --text)
  follow|unfollow|follows    segue ou deixa de seguir uma chave pública
  log                        mostra os blocos locais de um diário
  feed                       feed com as publicações dos diários seguidos
  sync                       sincroniza com pares e com o semeador (--once, --timeout-ms)
  seed                       semeador sempre ligado (--health-port, --ws-port)
  seed key|cert add          chave do semeador e seu certificado (--cert-file)
  seed list|status           diários admitidos e estado do semeador
  seed drop <chave>          apaga um diário do semeador parado
  account                    serviço de vínculo de conta Google (--account-port, --account-host)
  account key                chave do emissor do serviço de conta (imprime só a pública)
  account cert add           grava o certificado do emissor (--cert-file <f>)
  account status             estado do serviço de conta
  account export             exporta os vínculos de conta do serviço parado
  account reports            exporta as denúncias com os e-mails do vínculo (--member)
  mod init|show              chave da moderação e estado da lista de bloqueio
  mod cert add               grava o certificado da moderação (--cert-file <f>)
  mod block|unblock <chave>  bloqueia ou desbloqueia uma conta e publica a lista
  mod revoke-issuer <chave>  revoga a chave de um emissor e publica a lista
  mod unrevoke-issuer        desfaz a revogação de um emissor (<chave>)
  mod publish                reenvia a lista gravada ao semeador (--seeder)
  mod apply                  revisa as decisões do painel, assina e publica (--server, --yes)
  help                       esta ajuda
Opções globais:
  --data <dir>               diretório de dados (ou VARANDA_DATA, padrão ./data)
  --association <hex>        chave pública da associação (ou VARANDA_ASSOCIATION)
  --bootstrap <host:porta>   repetível (ou VARANDA_BOOTSTRAP, separado por vírgula)
  --dht-host <ip>            endereço local da DHT (ou VARANDA_DHT_HOST)
  --json                     saída JSON na última linha
Opções dos comandos:
  --member --seeder --age-band --method --out --cert-file --name --bio --text
  --to --author --limit --once --timeout-ms --health-port --health-host --ws-port --ws-host
  --ws-origin --issuer --account-port --account-host --moderator --no-publish --new-list --server --yes`

const booleanFlags = new Set(['--json', '--once', '--no-publish', '--new-list', '--yes', '--help', '-h'])
const stringFlags = new Set([
  '--data', '--association', '--timeout-ms', '--member', '--seeder',
  '--age-band', '--method', '--out', '--cert-file', '--name', '--bio',
  '--text', '--to', '--author', '--limit', '--bootstrap', '--dht-host',
  '--health-port', '--health-host', '--ws-port', '--ws-host', '--ws-origin',
  '--issuer', '--account-port', '--account-host', '--moderator', '--server'
])

function key (value, message = 'chave inválida') {
  if (value == null) return null
  if (value.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(value)) throw new UsageError(message)
  return value.toLowerCase()
}

function integer (value, name) {
  if (value == null) return null
  const number = Number(value)
  if (!/^[0-9]+$/.test(value) || !Number.isInteger(number) || number < 1) {
    throw new UsageError(name + ' inválido')
  }
  return number
}

// A TCP port, 0 (the system picks a free one) to 65535, canonical decimal.
function port (value, name) {
  if (value == null) return null
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > 65535) throw new UsageError(name + ' inválido')
  return Number(value)
}

function bootstrapList (rawValues) {
  const entries = []
  for (const raw of rawValues) {
    for (const piece of raw.split(',')) {
      const entry = piece.trim()
      if (!entry) continue
      if (!validBootstrap(entry)) throw new UsageError('bootstrap inválido ' + entry)
      entries.push(entry)
    }
  }
  return entries
}

// Browser origins allowed on the seeder's WebSocket entry: each one exactly
// as a browser sends it (scheme http or https, host, optional port; no path,
// no trailing slash). Values may also be comma-separated.
function originList (rawValues) {
  const origins = []
  for (const raw of rawValues) {
    for (const piece of raw.split(',')) {
      const value = piece.trim()
      if (!value) continue
      let url = null
      try {
        url = new URL(value)
      } catch {}
      if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
        throw new UsageError('ws-origin inválido ' + value)
      }
      origins.push(value)
    }
  }
  return origins
}

// Seq is canonical decimal (no leading zeros) and a safe integer >= 1.
// Block 0 is the member certificate, so it is not a reply target.
function replyTo (value) {
  if (value == null) return null
  const match = /^([0-9a-fA-F]{64}):([1-9][0-9]*)$/.exec(value)
  if (!match) throw new UsageError('referência inválida')
  const seq = Number(match[2])
  if (!Number.isSafeInteger(seq) || String(seq) !== match[2]) throw new UsageError('referência inválida')
  return { author: match[1].toLowerCase(), seq }
}

function parseArgs (argv, env = process.env, cwd = process.cwd()) {
  const values = new Map()
  const positionals = []
  const bootstraps = []
  const wsOriginFlags = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (booleanFlags.has(token)) {
      values.set(token === '-h' ? '--help' : token, true)
    } else if (stringFlags.has(token)) {
      // The next token is the value even when it starts with "-".
      // Only a missing token is "falta o valor".
      const value = argv[i + 1]
      if (value === undefined) throw new UsageError('falta o valor de ' + token)
      i++
      if (token === '--bootstrap') bootstraps.push(value)
      else if (token === '--ws-origin') wsOriginFlags.push(value)
      else values.set(token, value)
    } else if (token.startsWith('-')) {
      throw new UsageError('opção desconhecida ' + token)
    } else {
      positionals.push(token)
    }
  }

  const get = (name) => values.get('--' + name) ?? null
  // Any --bootstrap flag wins over VARANDA_BOOTSTRAP. A bootstrap source that is
  // present but yields no entry (empty string, only commas or spaces) is a usage
  // error: silently falling back to the public DHT would move private-network
  // traffic onto the internet. Only an absent flag and an unset variable mean
  // "public DHT".
  const source = bootstraps.length ? bootstraps : (env.VARANDA_BOOTSTRAP !== undefined ? [env.VARANDA_BOOTSTRAP] : [])
  const bootstrap = bootstrapList(source)
  if (source.length > 0 && bootstrap.length === 0) throw new UsageError('bootstrap inválido (vazio)')

  const dhtHost = get('dht-host') ?? env.VARANDA_DHT_HOST ?? null
  if (dhtHost !== null && (!dhtHost || /\s/.test(dhtHost))) throw new UsageError('dht-host inválido')

  const healthHost = get('health-host') ?? env.VARANDA_HEALTH_HOST ?? null
  if (healthHost !== null && (!healthHost || /\s/.test(healthHost))) throw new UsageError('health-host inválido')

  const accountHost = get('account-host') ?? env.VARANDA_ACCOUNT_HOST ?? null
  if (accountHost !== null && (!accountHost || /\s/.test(accountHost))) throw new UsageError('account-host inválido')

  const wsHost = get('ws-host') ?? env.VARANDA_WS_HOST ?? null
  if (wsHost !== null && (!wsHost || /\s/.test(wsHost))) throw new UsageError('ws-host inválido')

  // Any --ws-origin flag wins over VARANDA_WS_ORIGIN; a source that is present
  // but yields no origin is a usage error (it would silently fall back to the
  // loopback-only default).
  const originSource = wsOriginFlags.length ? wsOriginFlags : (env.VARANDA_WS_ORIGIN !== undefined ? [env.VARANDA_WS_ORIGIN] : [])
  const wsOrigins = originList(originSource)
  if (originSource.length > 0 && wsOrigins.length === 0) throw new UsageError('ws-origin inválido (vazio)')

  return {
    command: positionals.shift() ?? null,
    positionals,
    help: get('help') === true,
    json: get('json') === true,
    once: get('once') === true,
    noPublish: get('no-publish') === true,
    newList: get('new-list') === true,
    yes: get('yes') === true,
    dataDir: path.resolve(cwd, get('data') || env.VARANDA_DATA || './data'),
    association: key(get('association') || env.VARANDA_ASSOCIATION || null, 'chave da associação inválida'),
    bootstrap: bootstrap.length ? bootstrap : undefined,
    timeoutMs: integer(get('timeout-ms'), 'timeout-ms'),
    member: key(get('member')),
    seeder: key(get('seeder')),
    issuer: key(get('issuer')),
    moderator: key(get('moderator')),
    dhtHost,
    healthPort: port(get('health-port') ?? env.VARANDA_HEALTH_PORT ?? null, 'health-port'),
    healthHost,
    wsPort: port(get('ws-port') ?? env.VARANDA_WS_PORT ?? null, 'ws-port'),
    wsHost,
    wsOrigins: wsOrigins.length ? wsOrigins : null,
    accountPort: port(get('account-port') ?? env.VARANDA_ACCOUNT_PORT ?? null, 'account-port'),
    accountHost,
    ageBand: get('age-band'),
    method: get('method'),
    out: get('out') === null ? null : path.resolve(cwd, get('out')),
    certFile: get('cert-file') === null ? null : path.resolve(cwd, get('cert-file')),
    name: get('name'),
    bio: get('bio'),
    text: get('text'),
    to: replyTo(get('to')),
    author: key(get('author')),
    limit: integer(get('limit'), 'limit'),
    // Raw: `mod apply` checks it is an origin (mod-apply.js).
    server: get('server'),
    cwd
  }
}

module.exports = { parseArgs, HELP, UsageError }
