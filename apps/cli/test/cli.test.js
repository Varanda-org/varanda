const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const { testnet } = require('./helpers/net')
const { parseArgs, HELP, UsageError } = require('../lib/cli')

const root = path.resolve(__dirname, '..')
const bin = path.join(root, 'bin/varanda.js')
const upperKey = 'ABCDEF01'.repeat(8)
const lowerKey = upperKey.toLowerCase()
const expectedHelp = `varanda — protótipo de rede social P2P (fase 0)
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
  delete                     apaga uma publicação ou versão do perfil (--to <chave>:<seq>)
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
  account push-key           chave dos avisos push da versão web (imprime só a pública)
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
  group create               cria um grupo público (--name, --join open|approval)
  group join|leave <chave>   entra no grupo (ou pede entrada) e sai dele
  group post <chave>         publica no grupo (--text)
  group read <chave>         lê o grupo, das mais novas (--limit, --before <at>,<escritor>,<seq>)
  group list                 grupos dos quais você participa
  group info|members|requests <chave>  dados do grupo, membros e pedidos de entrada
  group admit|ban|admin <chave>        modera um membro (--member, --undo desfaz)
  group hide <chave>         oculta uma mensagem (--to <escritor>:<seq>, --undo)
  group meta <chave>         muda nome ou entrada do grupo (--name, --join)
  help                       esta ajuda
Opções globais:
  --data <dir>               diretório de dados (ou VARANDA_DATA, padrão ./data)
  --association <hex>        chave pública da associação (ou VARANDA_ASSOCIATION)
  --bootstrap <host:porta>   repetível (ou VARANDA_BOOTSTRAP, separado por vírgula)
  --dht-host <ip>            endereço local da DHT (ou VARANDA_DHT_HOST)
  --json                     saída JSON na última linha
Opções dos comandos:
  --member --seeder --age-band --method --out --cert-file --name --bio --text
  --to --author --limit --before --once --timeout-ms --health-port --health-host --ws-port --ws-host
  --ws-origin --issuer --account-port --account-host --moderator --no-publish --new-list --server --yes
  --join --undo
  --timeout-ms vai até 2147483647 ms. No assoc certify*, --out recusa arquivo existente e link simbólico.`

function parse (argv = [], env = {}) {
  return parseArgs(argv, env, root)
}

function usage (t, argv, message, env = {}) {
  let error
  try {
    parse(argv, env)
  } catch (err) {
    error = err
  }
  t.ok(error instanceof Error && error instanceof UsageError, JSON.stringify(argv) + ' throws UsageError')
  t.is(error && error.code, 'USAGE')
  if (message) t.is(error && error.message, message)
}

function spawn (argv, extraEnv = {}) {
  const env = { ...process.env }
  delete env.VARANDA_PUSH_TOKEN
  delete env.VARANDA_ACCOUNT_HTTP
  for (const name of ['VARANDA_DATA', 'VARANDA_ASSOCIATION', 'VARANDA_BOOTSTRAP', 'VARANDA_DHT_HOST', 'VARANDA_HEALTH_PORT', 'VARANDA_HEALTH_HOST', 'VARANDA_WS_PORT', 'VARANDA_WS_HOST', 'VARANDA_WS_ORIGIN', 'VARANDA_MAX_EXTERNAL', 'VARANDA_MAX_SOCKETS', 'VARANDA_FRAME_MEMORY', 'VARANDA_MEDIA_MAX_IN_FLIGHT', 'VARANDA_MEDIA_RATE', 'VARANDA_MEDIA_BURST', 'VARANDA_INDEX_MAX_IN_FLIGHT', 'VARANDA_INDEX_RATE', 'VARANDA_INDEX_BURST']) delete env[name]
  return spawnSync(process.execPath, [bin, ...argv], {
    cwd: root,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 10000
  })
}

// Exercise command dispatch without creating modules owned by later tasks.
async function route (modules) {
  const state = { stdout: '', stderr: '', timers: [] }
  const processStub = {
    argv: [process.execPath, bin, 'fixture', 'arg', '--json'],
    exitCode: undefined,
    stdout: { write: text => { state.stdout += text } },
    stderr: { write: text => { state.stderr += text } },
    exit: code => { state.forcedCode = code }
  }
  vm.runInNewContext(fs.readFileSync(bin, 'utf8'), {
    __dirname: path.dirname(bin),
    process: processStub,
    require: name => {
      if (name === 'node:fs') return { readdirSync: () => Object.keys(modules) }
      if (name === 'node:path') return path
      if (name === '../lib/cli') return { HELP, parseArgs: argv => parse(argv) }
      return modules[path.basename(name)]
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unreferenced: false }
      state.timers.push(timer)
      return { unref: () => { timer.unreferenced = true } }
    }
  }, { filename: bin })
  await new Promise(resolve => setImmediate(resolve))
  return { ...state, process: processStub }
}

test('CLI push settings are environment only and validate without echoing values', (t) => {
  for (const command of ['seed', 'account']) {
    const defaults = parse([command])
    t.is(defaults.pushToken, null)
    t.is(defaults.accountHttp, 'http://127.0.0.1:8790')
    t.alike(parse([command], { VARANDA_PUSH_TOKEN: '', VARANDA_ACCOUNT_HTTP: '' }), defaults)
  }
  const pushToken = 'ab0123456789cdef'.repeat(4)
  t.is(parse([], { VARANDA_PUSH_TOKEN: pushToken }).pushToken, pushToken)
  for (const value of [' ', pushToken.toUpperCase(), pushToken.slice(1), pushToken + 'a', 'z'.repeat(64), pushToken + '\n', ' ' + pushToken]) {
    usage(t, [], 'VARANDA_PUSH_TOKEN inválido', { VARANDA_PUSH_TOKEN: value })
  }
  usage(t, ['--push-token', pushToken], 'opção desconhecida --push-token')

  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    for (const port of ['1', '8790', '65535', '00001']) {
      const url = 'http://' + host + ':' + port
      t.is(parse([], { VARANDA_ACCOUNT_HTTP: url }).accountHttp, url)
      t.is(parse([], { VARANDA_ACCOUNT_HTTP: url + '/' }).accountHttp, url)
    }
  }
  for (const value of [
    ' ', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:00000',
    'http://127.0.0.1:65536', 'http://127.0.0.1:100000', 'http://127.0.0.1:-1',
    'http://127.0.0.1:1.5', 'https://127.0.0.1:8790', 'http://0.0.0.0:8790',
    'http://example.com:8790', 'http://localhost.example:8790', 'http://user@localhost:8790',
    'http://127.0.0.1:8790/path', 'http://127.0.0.1:8790//',
    'http://127.0.0.1:8790?query', 'http://127.0.0.1:8790#fragment',
    ' http://127.0.0.1:8790', 'http://127.0.0.1:8790\n'
  ]) {
    usage(t, [], 'VARANDA_ACCOUNT_HTTP inválido', { VARANDA_ACCOUNT_HTTP: value })
  }
  usage(t, ['--account-http', 'http://127.0.0.1:8790'], 'opção desconhecida --account-http')
})

test('CLI parser, R5 help and command router', async (t) => {
  t.timeout(60000)
  await testnet(t)

  t.is(HELP, expectedHelp)
  t.alike(parse(), {
    command: null,
    positionals: [],
    help: false,
    json: false,
    once: false,
    noPublish: false,
    newList: false,
    yes: false,
    undo: false,
    dataDir: path.join(root, 'data'),
    association: null,
    bootstrap: undefined,
    timeoutMs: null,
    member: null,
    seeder: null,
    issuer: null,
    moderator: null,
    dhtHost: null,
    healthPort: null,
    healthHost: null,
    wsPort: null,
    wsHost: null,
    wsOrigins: null,
    triageToken: null,
    pushToken: null,
    accountHttp: 'http://127.0.0.1:8790',
    accountPort: null,
    accountHost: null,
    maxExternal: null,
    maxSockets: null,
    frameMemory: null,
    media: { maxInFlight: null, rate: null, burst: null },
    index: { maxInFlight: null, rate: null, burst: null },
    ageBand: null,
    method: null,
    out: null,
    certFile: null,
    name: null,
    join: null,
    bio: null,
    text: null,
    to: null,
    author: null,
    limit: null,
    before: null,
    server: null,
    cwd: root
  })
  t.alike(parseArgs([]), parseArgs([], process.env, process.cwd()), 'default env and cwd')
  t.alike(parse(['--json', 'seed', 'cert', '--once', 'add']).positionals, ['cert', 'add'])
  for (const [command, positionals] of [['seed', ['key']], ['seed', ['cert', 'add']], ['seed', ['drop', upperKey]], ['assoc', ['certify-seeder']], ['assoc', ['certify-issuer']], ['assoc', ['certify-moderator']], ['mod', ['cert', 'add']], ['mod', ['unrevoke-issuer', upperKey]]]) {
    const flags = parse([command, ...positionals])
    t.is(flags.command, command)
    t.alike(flags.positionals, positionals)
  }
  for (const flag of ['--help', '-h']) t.is(parse([flag]).help, true)
  t.is(parse(['--json', '--json']).json, true)
  t.is(parse(['--once']).once, true)
  t.is(parse(['mod', 'block', upperKey, '--no-publish']).noPublish, true)
  t.alike(parse(['mod', 'block', upperKey, '--no-publish']).positionals, ['block', upperKey])
  t.is(parse(['mod', 'block', upperKey, '--new-list']).newList, true)
  t.is(parse(['mod', 'block', upperKey, '--seeder', upperKey]).seeder, lowerKey)
  t.alike(parse(['mod', 'publish', '--seeder', upperKey]).positionals, ['publish'])
  // The parser keeps --server raw; mod apply validates it (mod-apply.js).
  t.is(parse(['mod', 'apply', '--server', 'not a url']).server, 'not a url')
  t.is(parse(['mod', 'apply', '--yes']).yes, true)
  t.alike(parse(['mod', 'apply', '--yes']).positionals, ['apply'])
  usage(t, ['--yes=true'], 'opção desconhecida --yes=true')
  usage(t, ['--new-list=true'], 'opção desconhecida --new-list=true')
  usage(t, ['--no-publish=true'], 'opção desconhecida --no-publish=true')
  usage(t, ['--reason', 'spam'], 'opção desconhecida --reason')

  const strings = {
    data: ['relative', 'dataDir', path.join(root, 'relative')],
    association: [upperKey, 'association', lowerKey],
    'timeout-ms': ['12', 'timeoutMs', 12],
    member: [upperKey, 'member', lowerKey],
    seeder: [upperKey, 'seeder', lowerKey],
    issuer: [upperKey, 'issuer', lowerKey],
    moderator: [upperKey, 'moderator', lowerKey],
    'age-band': ['18+', 'ageBand', '18+'],
    method: ['stub', 'method', 'stub'],
    out: ['cert.json', 'out', path.join(root, 'cert.json')],
    'cert-file': ['input.json', 'certFile', path.join(root, 'input.json')],
    name: ['Ana', 'name', 'Ana'],
    bio: ['uma bio', 'bio', 'uma bio'],
    text: ['olá mundo', 'text', 'olá mundo'],
    to: [upperKey + ':2', 'to', { author: lowerKey, seq: 2 }],
    author: [upperKey, 'author', lowerKey],
    limit: ['3', 'limit', 3],
    before: ['5', 'before', '5'],
    'dht-host': ['127.0.0.1', 'dhtHost', '127.0.0.1'],
    'health-port': ['8788', 'healthPort', 8788],
    'health-host': ['0.0.0.0', 'healthHost', '0.0.0.0'],
    'ws-port': ['8789', 'wsPort', 8789],
    'ws-host': ['0.0.0.0', 'wsHost', '0.0.0.0'],
    'account-port': ['8790', 'accountPort', 8790],
    'account-host': ['127.0.0.1', 'accountHost', '127.0.0.1'],
    server: ['https://varanda.example', 'server', 'https://varanda.example']
  }
  for (const [name, [value, property, expected]] of Object.entries(strings)) {
    const flag = '--' + name
    t.alike(parse([flag, 'discarded', flag, value])[property], expected, flag + ' last wins')
    usage(t, [flag], 'falta o valor de ' + flag)
    usage(t, [flag + '=' + value], 'opção desconhecida ' + flag + '=' + value)
  }
  const dashed = parse(['post', '--text', '-1', '--name', '-x', '--json'])
  t.is(dashed.command, 'post')
  t.is(dashed.text, '-1')
  t.is(dashed.name, '-x')
  t.is(dashed.json, true)
  usage(t, ['--timeout-ms', '-1'], 'timeout-ms inválido')
  t.is(parse(['--timeout-ms', '2147483647']).timeoutMs, 2147483647)
  usage(t, ['--timeout-ms', '2147483648'], 'timeout-ms acima do máximo de 2147483647')
  usage(t, ['--timeout-ms', '99999999999999999999'], 'timeout-ms acima do máximo de 2147483647')
  usage(t, ['--member', '-1'], 'chave inválida')
  usage(t, ['post', '--name', 'Ana', '--text'], 'falta o valor de --text')
  for (const flag of ['--bogus', '-x', '--', '--json=true', '--once=false', '--help=true', '--bootstrap=host:1']) {
    usage(t, [flag], 'opção desconhecida ' + flag)
  }
  t.is(parse(['--bio', '']).bio, '')
  t.is(parse(['--data', root]).dataDir, root)
  t.is(parse(['--out', root]).out, root)
  t.is(parse(['--cert-file', root]).certFile, root)
  t.is(parse([], { VARANDA_DATA: 'env-data' }).dataDir, path.join(root, 'env-data'))
  t.is(parse(['--data', 'flag-data'], { VARANDA_DATA: 'env-data' }).dataDir, path.join(root, 'flag-data'))
  t.is(parse(['--data', ''], { VARANDA_DATA: 'env-data' }).dataDir, path.join(root, 'env-data'))
  t.is(parse([], { VARANDA_ASSOCIATION: upperKey }).association, lowerKey)
  t.is(parse(['--association', upperKey], { VARANDA_ASSOCIATION: 'invalid' }).association, lowerKey)
  usage(t, [], 'chave da associação inválida', { VARANDA_ASSOCIATION: 'invalid' })
  for (const invalid of ['', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), upperKey + '\n']) {
    for (const name of ['member', 'author', 'seeder', 'moderator']) usage(t, ['--' + name, invalid], 'chave inválida')
    if (invalid) usage(t, ['--association', invalid], 'chave da associação inválida')
  }

  t.alike(parse(['--bootstrap', 'host:1', '--bootstrap', '127.0.0.1:65535', '--bootstrap', 'host:1'], {
    VARANDA_BOOTSTRAP: 'invalid'
  }).bootstrap, ['host:1', '127.0.0.1:65535', 'host:1'])
  t.alike(parse(['--bootstrap', '10.0.0.1:1000,10.0.0.2:1000'], {
    VARANDA_BOOTSTRAP: 'invalid'
  }).bootstrap, ['10.0.0.1:1000', '10.0.0.2:1000'])
  t.alike(parse(['--bootstrap', ' 10.0.0.1:1000, , 10.0.0.2:1000 , ']).bootstrap, ['10.0.0.1:1000', '10.0.0.2:1000'])
  t.alike(parse([], { VARANDA_BOOTSTRAP: ' host:1, , localhost:65535, ' }).bootstrap, ['host:1', 'localhost:65535'])
  t.alike(parse([], { VARANDA_BOOTSTRAP: '10.0.0.1:1000,10.0.0.2:1000' }).bootstrap, ['10.0.0.1:1000', '10.0.0.2:1000'])
  // A present but empty bootstrap source never falls back to the public DHT.
  usage(t, [], 'bootstrap inválido (vazio)', { VARANDA_BOOTSTRAP: ' , , ' })
  usage(t, [], 'bootstrap inválido (vazio)', { VARANDA_BOOTSTRAP: '' })
  usage(t, ['--bootstrap', ''], 'bootstrap inválido (vazio)', { VARANDA_BOOTSTRAP: 'good:1' })
  usage(t, ['--bootstrap', ' , , '], 'bootstrap inválido (vazio)', { VARANDA_BOOTSTRAP: 'good:1' })
  t.is(parse([], {}).bootstrap, undefined)
  t.alike(parse(['--bootstrap', 'host:1\n'], { VARANDA_BOOTSTRAP: 'bad' }).bootstrap, ['host:1'])
  usage(t, ['--bootstrap'], 'falta o valor de --bootstrap')
  usage(t, ['--bootstrap', '--json'], 'bootstrap inválido --json')
  for (const entry of [
    'host', ':1', 'host:', 'host:0', 'host:65536', 'host:1.5', 'host:-1', 'host:abc', 'host:1e2', 'host name:1',
    '127.0.0.1:1:65535', '::1', '[::1]:4001', '10.0.0.1:0', '10.0.0.1:65536', 'host:080'
  ]) {
    usage(t, ['--bootstrap', entry], 'bootstrap inválido ' + entry, { VARANDA_BOOTSTRAP: 'good:1' })
    usage(t, [], 'bootstrap inválido ' + entry, { VARANDA_BOOTSTRAP: 'good:1,' + entry })
  }
  usage(t, ['--bootstrap', 'good:1', '--bootstrap', 'bad'], 'bootstrap inválido bad')
  usage(t, ['--bootstrap', '10.0.0.1:1000,host:080'], 'bootstrap inválido host:080')

  t.is(parse([], { VARANDA_DHT_HOST: '127.0.0.1' }).dhtHost, '127.0.0.1')
  t.is(parse(['--dht-host', '::1'], { VARANDA_DHT_HOST: 'invalid host' }).dhtHost, '::1')
  for (const host of ['', ' ', '127.0.0.1 ', 'local host', 'local\thost', 'local\nhost']) {
    usage(t, ['--dht-host', host], 'dht-host inválido')
    usage(t, [], 'dht-host inválido', { VARANDA_DHT_HOST: host })
  }
  t.is(parse(['--health-port', '0']).healthPort, 0, 'port 0: the system picks one')
  t.is(parse(['--health-port', '65535']).healthPort, 65535)
  t.is(parse([], { VARANDA_HEALTH_PORT: '8788' }).healthPort, 8788)
  t.is(parse(['--health-port', '9000'], { VARANDA_HEALTH_PORT: 'bad' }).healthPort, 9000)
  for (const value of ['', '-1', '65536', '080', '1.5', 'abc', '1e3', '0x10', ' 1']) {
    usage(t, ['--health-port', value], 'health-port inválido')
    usage(t, [], 'health-port inválido', { VARANDA_HEALTH_PORT: value })
  }
  t.is(parse([], { VARANDA_HEALTH_HOST: '::1' }).healthHost, '::1')
  t.is(parse(['--health-host', '127.0.0.1'], { VARANDA_HEALTH_HOST: 'invalid host' }).healthHost, '127.0.0.1')
  for (const host of ['', ' ', 'local host', 'local\nhost']) {
    usage(t, ['--health-host', host], 'health-host inválido')
    usage(t, [], 'health-host inválido', { VARANDA_HEALTH_HOST: host })
  }
  t.is(parse(['--ws-port', '0']).wsPort, 0, 'port 0: the system picks one')
  t.is(parse(['--ws-port', '65535']).wsPort, 65535)
  t.is(parse([], { VARANDA_WS_PORT: '8789' }).wsPort, 8789)
  t.is(parse(['--ws-port', '9000'], { VARANDA_WS_PORT: 'bad' }).wsPort, 9000)
  for (const value of ['', '-1', '65536', '080', '1.5', 'abc', '1e3', '0x10', ' 1']) {
    usage(t, ['--ws-port', value], 'ws-port inválido')
    usage(t, [], 'ws-port inválido', { VARANDA_WS_PORT: value })
  }
  t.is(parse([], { VARANDA_WS_HOST: '::1' }).wsHost, '::1')
  t.is(parse(['--ws-host', '127.0.0.1'], { VARANDA_WS_HOST: 'invalid host' }).wsHost, '127.0.0.1')
  for (const host of ['', ' ', 'local host', 'local\nhost']) {
    usage(t, ['--ws-host', host], 'ws-host inválido')
    usage(t, [], 'ws-host inválido', { VARANDA_WS_HOST: host })
  }
  t.alike(parse(['--ws-origin', 'https://app.varanda.app']).wsOrigins, ['https://app.varanda.app'])
  t.alike(parse(['--ws-origin', 'https://a.example', '--ws-origin', 'http://localhost:8081']).wsOrigins, ['https://a.example', 'http://localhost:8081'])
  t.alike(parse([], { VARANDA_WS_ORIGIN: 'https://a.example, https://b.example:8443' }).wsOrigins, ['https://a.example', 'https://b.example:8443'])
  t.alike(parse(['--ws-origin', 'https://flag.example'], { VARANDA_WS_ORIGIN: 'not an origin' }).wsOrigins, ['https://flag.example'])
  for (const value of ['https://a.example/', 'https://a.example/path', 'ftp://a.example', 'null', 'a.example', 'https://A.example', 'https://a.example:443', 'https://user@a.example']) {
    usage(t, ['--ws-origin', value], 'ws-origin inválido ' + value)
    usage(t, [], 'ws-origin inválido ' + value, { VARANDA_WS_ORIGIN: value })
  }
  for (const value of ['', ' ', ',', ' , ']) {
    usage(t, ['--ws-origin', value], 'ws-origin inválido (vazio)')
    usage(t, [], 'ws-origin inválido (vazio)', { VARANDA_WS_ORIGIN: value })
  }
  const triageToken = 'ab'.repeat(32)
  t.is(parse([], { VARANDA_TRIAGE_TOKEN: triageToken }).triageToken, triageToken)
  t.is(parse([], { VARANDA_TRIAGE_TOKEN: '' }).triageToken, null)
  for (const value of [' ', 'AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), triageToken + '\n', ' ' + triageToken]) {
    usage(t, [], 'VARANDA_TRIAGE_TOKEN inválido', { VARANDA_TRIAGE_TOKEN: value })
  }
  usage(t, ['--triage-token', triageToken], 'opção desconhecida --triage-token')
  for (const name of ['timeout-ms', 'limit']) {
    for (const value of ['0', '-1', '1.5', 'abc', '', 'Infinity', '1e3', '0x10']) usage(t, ['--' + name, value])
  }
  // The seeder's web limits: environment only, empty means unset, the value is
  // never echoed.
  for (const [name, read, ok, bad] of [
    ['VARANDA_MAX_EXTERNAL', flags => flags.maxExternal, ['64', 64], ['abc', '0', '5000']],
    ['VARANDA_MEDIA_MAX_IN_FLIGHT', flags => flags.media.maxInFlight, ['64', 64], ['abc', '0', '1025']],
    ['VARANDA_INDEX_RATE', flags => flags.index.rate, ['64', 64], ['abc', '0', '100001']],
    ['VARANDA_FRAME_MEMORY', flags => flags.frameMemory, ['67108864', 67108864], ['abc', '8454143', '1073741825']]
  ]) {
    t.is(read(parse([], { [name]: ok[0] })), ok[1], name + ' set')
    t.is(read(parse([], { [name]: ' ' + ok[0] + ' ' })), ok[1], name + ' trimmed')
    t.is(read(parse([], { [name]: '' })), null, name + ' empty is unset')
    t.is(read(parse([], { [name]: '  ' })), null, name + ' blank is unset')
    for (const value of [...bad, '1.5', '-1', '1e3', '0x10', '064']) usage(t, [], name + ' inválido', { [name]: value })
  }
  t.alike(parse([], {
    VARANDA_MAX_EXTERNAL: '512',
    VARANDA_MAX_SOCKETS: '8192',
    VARANDA_FRAME_MEMORY: '8454144',
    VARANDA_MEDIA_MAX_IN_FLIGHT: '1',
    VARANDA_MEDIA_RATE: '100000',
    VARANDA_MEDIA_BURST: '2',
    VARANDA_INDEX_MAX_IN_FLIGHT: '1024',
    VARANDA_INDEX_RATE: '3',
    VARANDA_INDEX_BURST: '4'
  }), {
    ...parse(),
    maxExternal: 512,
    maxSockets: 8192,
    frameMemory: 8454144,
    media: { maxInFlight: 1, rate: 100000, burst: 2 },
    index: { maxInFlight: 1024, rate: 3, burst: 4 }
  }, 'every web limit')
  usage(t, [], 'VARANDA_MAX_SOCKETS inválido', { VARANDA_MAX_SOCKETS: '8193' })
  usage(t, ['--to', upperKey + ':0'], 'referência inválida')
  for (const ref of [
    '', upperKey, upperKey + ':', upperKey + ':00', upperKey + ':02', upperKey + ':-1',
    upperKey + ':1.5', upperKey + ':1:2', upperKey + ':9007199254740992',
    upperKey + ':9007199254740993', 'bad:1', upperKey + ': 1'
  ]) {
    usage(t, ['--to', ref], 'referência inválida')
  }
  t.alike(parse(['--to', upperKey + ':9007199254740991']).to, { author: lowerKey, seq: 9007199254740991 })

  for (const args of [['help'], [], ['--help'], ['-h'], ['nope', '--help']]) {
    const result = spawn(args)
    t.is(result.status, 0)
    t.is(result.stdout, HELP + '\n')
    t.ok(result.stdout.includes('assoc') && result.stdout.includes('seed'))
    t.is(result.stderr, '')
  }
  const unknown = spawn(['nope'])
  t.is(unknown.status, 2)
  t.is(unknown.stderr, 'erro: comando desconhecido: nope\n')
  t.is(unknown.stdout, '')
  const bogus = spawn(['--bogus'])
  t.is(bogus.status, 2)
  t.is(bogus.stderr, 'uso: opção desconhecida --bogus\n' + HELP + '\n')
  t.is(bogus.stdout, '')
  const invalidEnv = spawn(['help'], { VARANDA_BOOTSTRAP: 'invalid' })
  t.is(invalidEnv.status, 2)
  t.is(invalidEnv.stderr, 'uso: bootstrap inválido invalid\n' + HELP + '\n')

  for (const code of [undefined, 0, 7]) {
    let received
    const result = await route({
      'a.js': { commands: { unrelated: { run: () => { throw new Error('wrong command') } } } },
      'b.js': { commands: { fixture: { summary: 'fixture', run: async flags => { received = flags; return code } } } },
      'ignored.txt': null
    })
    t.is(result.process.exitCode, code === undefined ? 0 : code)
    t.alike(received, parse(['fixture', 'arg', '--json']))
    t.is(result.stderr, '')
    t.is(result.timers.length, 1)
    t.is(result.timers[0].delay, 2000)
    t.is(result.timers[0].unreferenced, true)
  }
  for (const [error, code, prefix] of [[new UsageError('argumento inválido'), 2, 'uso: '], [new Error('falhou'), 1, 'erro: ']]) {
    const result = await route({ 'fixture.js': { commands: { fixture: { run: async () => { throw error } } } } })
    t.is(result.process.exitCode, code)
    t.is(result.stderr, prefix + error.message + '\n')
    t.is(result.timers.length, 1)
    t.is(result.timers[0].delay, 2000)
    t.is(result.timers[0].unreferenced, true)
  }
  const duplicate = await route({
    'a.js': { commands: { fixture: {} } },
    'b.js': { commands: { fixture: {} } }
  })
  t.is(duplicate.process.exitCode, 1)
  t.is(duplicate.stderr, 'erro: comando duplicado: fixture\n')
})

test('README and protocol help blocks match the root CLI byte for byte', (t) => {
  const repo = path.resolve(root, '../..')
  const result = spawnSync(process.execPath, [path.join(repo, 'bin/varanda.js'), 'help'], { encoding: 'utf8' })
  t.is(result.status, 0)
  t.is(result.stdout, HELP + '\n')
  for (const [file, heading] of [['README.md', '### Ajuda'], ['docs/protocol.md', '### Help (R5.12, exact)']]) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    const section = text.slice(text.indexOf(heading))
    const block = section.split('```\n')[1]
    t.is(block, result.stdout, file + ' help matches stdout byte for byte')
  }
  const flags = parse(['delete', '--to', upperKey + ':42'])
  t.is(flags.command, 'delete')
  t.alike(flags.to, { author: lowerKey, seq: 42 })
})
