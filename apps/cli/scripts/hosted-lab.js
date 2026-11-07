'use strict'

// The hosted lab: a whole hosted installation on this machine, for checking
// the web app signed in, in Chrome, without Google, a domain or a phone:
//   node scripts/hosted-lab.js [--host 127.0.0.1] [--port 8080] [--ui <dist dir> | --expo <http://127.0.0.1:8081>]
//                              [--dataset <semente> [--dataset-size 60x150] [--rajada]]
// It starts a loopback hyperdht testnet (or uses VARANDA_BOOTSTRAP, which must
// be loopback, e.g. from scripts/local-dht.js), an association, a certified
// seeder with its WebSocket listener (as `seed --ws-port`), and the account
// service through createAccountServer with the stub of ./oauth-stub.js in
// place of Google, no age check (GET /account/age/policy answers
// { required: false }), an issuer certified by the lab association and the
// terms store on. Passkey, terms and the account flow are the real ones.
// One origin, http://localhost:<port>, carries what Caddy carries in a
// deployment: /varanda.json, /seeder, /media/*, /index/*, /account/*, and
// everything else goes to the Expo web dev server or to an exported dist.
// --dataset fills the lab with other members' diaries once it is up
// (./lab-dataset.js, from the plan of ../lib/lab-dataset-plan.js) and
// writes reader-setup.js, which the signed-in dev page runs to follow them;
// --rajada then keeps posting on a few of them, one post a second.
// Binds loopback only and never prints a key.

const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')
const http = require('node:http')
const { parseDatasetSize } = require('../lib/lab-dataset-plan')

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const DEFAULT_PORT = 8080
const DEFAULT_EXPO = 'http://127.0.0.1:8081'
const DEFAULT_DATASET_SIZE = { members: 60, blocksPerMember: 150 }

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
}

const USAGE = [
  'uso: node scripts/hosted-lab.js [--host 127.0.0.1] [--port 8080] [--ui <dist> | --expo <http://127.0.0.1:8081>]',
  '                                [--dataset <semente> [--dataset-size <membros>x<blocos>] [--rajada]]',
  '  --dataset <semente>      cria diários de outros membros (fotos, respostas, citações, curtidas,',
  '                           repostagens e duas comunidades) e escreve reader-setup.js',
  '  --dataset-size 60x150    quantos membros e quantos blocos por diário (padrão 60x150)',
  '  --rajada                 depois do conjunto, um post novo por segundo em 5 membros até o Ctrl-C'
].join('\n')

class LabUsageError extends Error {}

function loopbackHost (host) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase())
}

// The browser drops a default port from Origin, and the account service
// compares Origin exactly, so port 80 is spelled without it.
function labOrigin (port) {
  return port === 80 ? 'http://localhost' : 'http://localhost:' + port
}

// The proxy rewrites Host to the backend's trusted loopback authority, so it
// has to make the DNS-rebinding check itself: a page on evil.example that
// resolves to 127.0.0.1 arrives with Host evil.example and stops here.
function allowedHost (host, port) {
  if (typeof host !== 'string') return false
  const h = host.toLowerCase()
  if (h === 'localhost:' + port || h === '127.0.0.1:' + port) return true
  return port === 80 && (h === 'localhost' || h === '127.0.0.1')
}

function parseArgs (argv) {
  const opts = { host: '127.0.0.1', port: DEFAULT_PORT, ui: null, expo: DEFAULT_EXPO, dataset: null, datasetSize: DEFAULT_DATASET_SIZE, rajada: false }
  let sizeGiven = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new LabUsageError('falta o valor de ' + a)
      return v
    }
    if (a === '--host') opts.host = value()
    else if (a === '--port') opts.port = Number(value())
    else if (a === '--ui') opts.ui = path.resolve(value())
    else if (a === '--expo') opts.expo = value()
    else if (a === '--dataset') opts.dataset = value()
    else if (a === '--dataset-size') {
      sizeGiven = true
      opts.datasetSize = parseDatasetSize(value())
      if (opts.datasetSize === null) throw new LabUsageError('--dataset-size deve ser <membros>x<blocos>, por exemplo 60x150')
    } else if (a === '--rajada') opts.rajada = true
    else if (a === '--help' || a === '-h') opts.help = true
    else throw new LabUsageError('opção desconhecida: ' + a)
  }
  if (opts.dataset !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(opts.dataset)) throw new LabUsageError('--dataset deve ser uma semente de letras, números, - ou _')
  if (opts.dataset === null && (sizeGiven || opts.rajada)) throw new LabUsageError('--dataset-size e --rajada exigem --dataset')
  if (!loopbackHost(opts.host)) throw new LabUsageError('--host deve ser 127.0.0.1 ou localhost')
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new LabUsageError('--port inválida')
  let expo
  try {
    expo = new URL(opts.expo)
  } catch {
    throw new LabUsageError('--expo inválido')
  }
  if (expo.protocol !== 'http:' || !loopbackHost(expo.hostname) || expo.pathname !== '/' || expo.search !== '') {
    throw new LabUsageError('--expo deve ser http://127.0.0.1:<porta> ou http://localhost:<porta>')
  }
  opts.expo = expo.origin
  if (opts.ui !== null && !fs.existsSync(path.join(opts.ui, 'index.html'))) throw new LabUsageError('--ui sem index.html')
  return opts
}

// VARANDA_BOOTSTRAP, when set, must name loopback nodes only: the lab never
// joins another DHT. -> null (unset: the lab starts its own testnet) or the list.
function bootstrapFromEnv (value) {
  if (value === undefined || value === '') return null
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean)
  if (list.length === 0) throw new LabUsageError('VARANDA_BOOTSTRAP vazio')
  for (const entry of list) {
    const i = entry.lastIndexOf(':')
    const host = i > 0 ? entry.slice(0, i) : ''
    const port = Number(entry.slice(i + 1))
    if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new LabUsageError('VARANDA_BOOTSTRAP deve apontar só para 127.0.0.1:<porta>')
    }
  }
  return list
}

// Which backend a request path goes to.
function routeOf (pathname) {
  if (pathname === '/varanda.json') return 'config'
  if (pathname === '/seeder') return 'seeder'
  if (pathname.startsWith('/media/') || pathname.startsWith('/index/')) return 'seeder'
  if (pathname === '/account' || pathname.startsWith('/account/')) return 'account'
  return 'ui'
}

function pathnameOf (url) {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

// hostname: '127.0.0.1' for the lab's own listeners, or the --expo hostname
// (127.0.0.1 or localhost, already checked) for the dev server.
function proxyHttp (req, res, port, hostname = '127.0.0.1') {
  // The seeder listener and the account service both check Host against their
  // own listen address (DNS-rebinding defence); the Origin stays the page's.
  const headers = { ...req.headers, host: hostname + ':' + port }
  const up = http.request({ host: hostname, port, method: req.method, path: req.url, headers }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.rawHeaders)
    upRes.pipe(res)
  })
  up.on('error', () => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('serviço do laboratório indisponível')
  })
  req.pipe(up)
}

// sockets: the set of open upgraded sockets, which closeAllConnections() does
// not reach; close() destroys them.
function proxyUpgrade (req, socket, head, port, sockets, hostname = '127.0.0.1') {
  const up = net.connect(port, hostname, () => {
    const lines = [req.method + ' ' + req.url + ' HTTP/1.1']
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'host') continue
      lines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1])
    }
    lines.push('Host: ' + hostname + ':' + port)
    up.write(lines.join('\r\n') + '\r\n\r\n')
    if (head && head.length > 0) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
  sockets.add(socket)
  sockets.add(up)
  socket.once('close', () => sockets.delete(socket))
  up.once('close', () => sockets.delete(up))
  up.on('error', () => socket.destroy())
  socket.on('error', () => up.destroy())
  socket.on('close', () => up.destroy())
  up.on('close', () => socket.destroy())
}

function serveStatic (req, res, dir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    return res.end()
  }
  let rel
  try {
    rel = decodeURIComponent(pathnameOf(req.url))
  } catch {
    res.writeHead(400)
    return res.end()
  }
  const root = path.resolve(dir)
  let file = path.resolve(root, '.' + path.posix.normalize('/' + rel))
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(404)
    return res.end()
  }
  let stat = null
  try { stat = fs.statSync(file) } catch {}
  if (stat !== null && stat.isDirectory()) {
    file = path.join(file, 'index.html')
    try { stat = fs.statSync(file) } catch { stat = null }
  }
  // A client-side route (/@nome, /g/<key>) is the app's index.html.
  if (stat === null || !stat.isFile()) file = path.join(root, 'index.html')
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
}

// startLabProxy({ host, port, association, seederPort, accountPort, ui })
// -> Promise<{ host, port, origin, close }>. ui is { dir } (an exported dist)
// or { url } (the Expo web dev server, loopback http).
function startLabProxy ({ host = '127.0.0.1', port = DEFAULT_PORT, association, seederPort, accountPort, ui }) {
  if (!loopbackHost(host)) throw new TypeError('host must be loopback')
  if (typeof association !== 'string' || !/^[0-9a-f]{64}$/.test(association)) throw new TypeError('association must be 64 lowercase hex characters')
  const uiUrl = ui && ui.url ? new URL(ui.url) : null
  if (uiUrl !== null && !loopbackHost(uiUrl.hostname)) throw new TypeError('ui.url must be loopback')
  const uiPort = uiUrl !== null ? Number(uiUrl.port || 80) : null
  const uiHost = uiUrl !== null ? uiUrl.hostname : null
  const config = JSON.stringify({ v: 1, association })
  const sockets = new Set()
  // Known once listening (port 0 picks one); nothing is served before that.
  let bound = null

  const server = http.createServer((req, res) => {
    if (!allowedHost(req.headers.host, bound)) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      return res.end('host inválido')
    }
    const route = routeOf(pathnameOf(req.url))
    if (route === 'config') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(config)
    }
    if (route === 'seeder') return proxyHttp(req, res, seederPort)
    if (route === 'account') return proxyHttp(req, res, accountPort)
    if (uiPort !== null) return proxyHttp(req, res, uiPort, uiHost)
    return serveStatic(req, res, ui.dir)
  })
  // WebSockets: /seeder, and the dev server's own (Metro hot reload).
  server.on('upgrade', (req, socket, head) => {
    if (!allowedHost(req.headers.host, bound)) {
      const body = Buffer.from('host inválido')
      socket.on('error', () => {})
      socket.end('HTTP/1.1 421 Misdirected Request\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ' + body.length + '\r\nconnection: close\r\n\r\n' + body.toString())
      return
    }
    const route = routeOf(pathnameOf(req.url))
    if (route === 'seeder' && pathnameOf(req.url) === '/seeder') return proxyUpgrade(req, socket, head, seederPort, sockets)
    if (route === 'ui' && uiPort !== null) return proxyUpgrade(req, socket, head, uiPort, sockets, uiHost)
    socket.destroy()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      server.on('error', () => {})
      bound = server.address().port
      const close = () => new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
        for (const s of sockets) s.destroy()
        sockets.clear()
      })
      resolve({ host, port: bound, origin: labOrigin(bound), close })
    })
  })
}

function log (line) {
  console.log('[lab] ' + line)
}

function steps (origin, opts) {
  return [
    '',
    'Laboratório hospedado pronto em ' + origin,
    'Interface: ' + (opts.ui !== null ? 'dist exportado em ' + opts.ui : 'servidor web do Expo em ' + opts.expo + ' (npm run web -w apps/app)'),
    '',
    'No Chrome:',
    '  1. Abra ' + origin + ' (use localhost, não 127.0.0.1: o rp.id da passkey não pode ser um IP).',
    '  2. DevTools > More tools > WebAuthn: ative o ambiente de autenticador virtual e adicione',
    '     um autenticador ctap2, transporte internal, com chaves residentes, verificação do usuário',
    '     e PRF. Sem PRF o app segue o caminho de passkey sem PRF.',
    '  3. Toque em Entrar e siga a conta: no lugar do Google aparece a página do laboratório;',
    '     escolha Pessoa 1. Os termos e a passkey são os de verdade.',
    '  4. Para a segunda pessoa, abra outro perfil do Chrome (não uma aba), repita os passos 1 a 3',
    '     com o autenticador virtual daquele perfil e escolha Pessoa 2.',
    '  5. Troque uma mensagem direta e um post de grupo entre os dois perfis.',
    '',
    'Fora do escopo: entrar de verdade no app nativo.',
    '  - A configuração hospedada do app nativo exige https (apps/app/src/config.js:169).',
    '  - O rp.id não pode ser um IP (apps/app/src/installation.js:43-49).',
    '  - No iOS, entrar com passkey espera o domínio associado (docs/development.md:146).',
    '  - O build de debug do Android não atende o assetlinks da instalação (docs/development.md:199).',
    '',
    'Ctrl-C encerra e apaga os dados do laboratório.'
  ].join('\n')
}

// The dataset after the lab is up: progress in the log, then how to point
// the signed-in page at it. Errors are logged; the lab keeps running.
async function fillDataset ({ opts, root, origin, association, issuer, seeder, seederWsUrl, cleanups }) {
  const { planDataset } = require('../lib/lab-dataset-plan')
  const { runDataset } = require('./lab-dataset')
  const { members, blocksPerMember } = opts.datasetSize
  const plan = planDataset({ seed: opts.dataset, members, blocksPerMember })
  log('conjunto de dados "' + opts.dataset + '": ' + members + ' membros, ' + plan.totals.blocks + ' blocos, ' + plan.totals.photos + ' fotos; criando...')
  // The seeder's own copy is what the app reads, so "pronto" waits for it;
  // contiguous, since a core's length grows before its blocks arrive.
  const heldLength = (key) => {
    const served = seeder._served.get(key)
    return served && served.core ? served.core.contiguousLength : 0
  }
  const result = await runDataset({ seederWsUrl, origin, association, issuer, plan, root: path.join(root, 'dataset'), log, heldLength, keep: opts.rajada ? 5 : 0 })
  cleanups.push(() => result.close())
  log('conjunto de dados pronto em ' + (result.ms / 1000).toFixed(1) + ' s: ' + result.members.length + ' diários no semeador, ' + result.communities.length + ' comunidades')
  console.log([
    '',
    'Para o leitor seguir o conjunto: ' + result.setupFile,
    '  Abra o app com o build de desenvolvimento (EXPO_PUBLIC_VARANDA_PERF=1 npm run web -w apps/app),',
    '  entre com a conta, abra o console do DevTools e cole o conteúdo desse arquivo.',
    '  As chaves públicas seguidas também estão em ' + result.followsFile + '.',
    ''
  ].join('\n'))
  if (opts.rajada) {
    const stop = await result.startRajada({
      onPost: ({ n, username }) => { if (n % 10 === 0) log('rajada: ' + n + ' posts (último de @' + username + ')') }
    })
    cleanups.push(async () => log('rajada encerrada com ' + await stop() + ' posts'))
    log('rajada no ar: um post por segundo em ' + Math.min(5, members) + ' membros até o Ctrl-C')
  }
}

async function main () {
  let opts
  let envBootstrap
  try {
    opts = parseArgs(process.argv.slice(2))
    envBootstrap = bootstrapFromEnv(process.env.VARANDA_BOOTSTRAP)
  } catch (err) {
    if (!(err instanceof LabUsageError)) throw err
    process.stderr.write('erro: ' + err.message + '\n' + USAGE + '\n')
    process.exitCode = 2
    return
  }
  if (opts.help) {
    console.log(USAGE)
    return
  }

  // Loaded only now, so a refused argument never touches the core or the network.
  const createTestnet = require('hyperdht/testnet')
  const b4a = require('b4a')
  const crypto = require('hypercore-crypto')
  const { initAssociation, issueIssuerCertificate, issueSeederCertificate } = require('@varanda/core/lib/assoc')
  const { saveKeyPairFile } = require('@varanda/core/lib/cert')
  const { Seeder } = require('@varanda/core/lib/seeder')
  const { startSeedWs } = require('../lib/seed-ws')
  const { createPostageFile } = require('../lib/dm-postage-file')
  const { createAccountServer, loadIssuer, KEY_FILE, CERT_FILE } = require('../lib/account/server')
  const { openAccountStore } = require('../lib/account/store')
  const { openTermsStore } = require('../lib/account/terms-store')
  const { openModerationStore } = require('../lib/account/moderation-store')
  const { openPasskeyStore } = require('../lib/account/passkey-store')
  const { createOAuthStub } = require('./oauth-stub')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-lab-'))
  const cleanups = []
  const shutdown = async () => {
    for (const fn of cleanups.reverse()) {
      try { await fn() } catch {}
    }
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  }
  let onSignal
  let starting = true
  const stopped = new Promise((resolve) => {
    onSignal = () => {
      // During startup (a DHT lookup can hang) nothing waits on `stopped` yet:
      // clean up what already started and leave instead of finishing startup.
      if (starting) {
        setTimeout(() => process.exit(130), 5000).unref()
        shutdown().finally(() => process.exit(130))
        return
      }
      resolve()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })

  try {
    let bootstrap = envBootstrap
    if (bootstrap === null) {
      const testnet = await createTestnet(3, { host: '127.0.0.1' })
      cleanups.push(() => testnet.destroy())
      bootstrap = testnet.bootstrap.map(({ port }) => '127.0.0.1:' + port)
      log('DHT local de teste em 127.0.0.1')
    } else {
      log('DHT local de VARANDA_BOOTSTRAP')
    }

    const assocDir = path.join(root, 'assoc')
    const { publicKey: association } = initAssociation(assocDir)
    log('associação do laboratório criada')

    const seedDir = path.join(root, 'seeder')
    Seeder.ensureConfig(seedDir, association)
    const { publicKey: seederKey } = Seeder.createKey(seedDir)
    const seederCertFile = path.join(root, 'seeder-cert.json')
    fs.writeFileSync(seederCertFile, JSON.stringify(issueSeederCertificate(assocDir, { seeder: seederKey })))
    Seeder.addCert(seedDir, seederCertFile, association)
    const seeder = new Seeder({
      dataDir: seedDir,
      bootstrap,
      host: '127.0.0.1',
      dm: { postage: createPostageFile(seedDir), onDrop: () => {} }
    })
    const ws = await startSeedWs({ host: '127.0.0.1', port: 0, seeder })
    cleanups.push(() => ws.close())
    await seeder.start()
    cleanups.push(() => seeder.close())
    log('semeador certificado no ar')

    const origin = labOrigin(opts.port)
    const accountDir = path.join(root, 'account')
    const kp = crypto.keyPair()
    saveKeyPairFile(path.join(accountDir, KEY_FILE), kp)
    const issuerCert = issueIssuerCertificate(assocDir, { issuer: b4a.toString(kp.publicKey, 'hex') })
    fs.writeFileSync(path.join(accountDir, CERT_FILE), JSON.stringify(issuerCert), { mode: 0o600 })
    const issuer = loadIssuer(accountDir, association)
    if (issuer === null) throw new Error('emissor do laboratório inválido')

    const google = createOAuthStub({ redirectUri: origin + '/account/callback' })
    const stub = await google.listen({ host: '127.0.0.1', port: 0 })
    cleanups.push(() => stub.close())

    const store = openAccountStore(accountDir)
    const terms = openTermsStore(accountDir)
    // The moderation desk without its panel (no Google moderators): Excluir
    // conta queues its block here and refuses without it.
    const moderation = openModerationStore(accountDir, { association })
    // The passkey public keys and waiting deletions (passkeys.json): the
    // passkey created in the lab browser is enrolled right after the link,
    // so Excluir conta there runs with the server-side check.
    const passkeys = openPasskeyStore(accountDir)
    const account = createAccountServer({ association, origin, google, store, issuer, terms, moderation, passkeys, didit: null, ages: null })
    const accountListener = await account.listen({ host: '127.0.0.1', port: 0 })
    cleanups.push(() => accountListener.close())
    log('serviço de conta no ar (Google substituído pela página do laboratório)')

    const proxy = await startLabProxy({
      host: opts.host,
      port: opts.port,
      association,
      seederPort: ws.port,
      accountPort: accountListener.port,
      ui: opts.ui !== null ? { dir: opts.ui } : { url: opts.expo }
    })
    cleanups.push(() => proxy.close())
    console.log(steps(origin, opts))

    starting = false
    if (opts.dataset !== null) {
      fillDataset({ opts, root, origin, association, issuer, seeder, seederWsUrl: 'ws://127.0.0.1:' + ws.port + '/seeder', cleanups })
        .catch((err) => log('conjunto de dados falhou: ' + (err && err.message ? err.message : String(err))))
    }
    await stopped
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    // Armed before cleanup, so a backend that never finishes closing cannot
    // keep the lab alive after Ctrl-C.
    setTimeout(() => process.exit(process.exitCode), 5000).unref()
    await shutdown()
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('erro: ' + (err && err.message ? err.message : String(err)) + '\n')
    process.exitCode = 1
  }).finally(() => {
    setTimeout(() => process.exit(process.exitCode), 2000).unref()
  })
}

module.exports = { parseArgs, bootstrapFromEnv, routeOf, labOrigin, allowedHost, startLabProxy, LabUsageError, DEFAULT_PORT }
