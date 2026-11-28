'use strict'

const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const { isIP } = require('node:net')
const { apiBase, parseOrigin, validHostname } = require('./bunny.js')

const EDGE = 'X-Varanda-Edge'
const REAL = 'X-Real-IP'
const FORWARDED = 'X-Forwarded-For'
// The origin echoes only requests with this header, which a link or another
// site's page cannot send, so no visitor's address lands in a cached answer.
const ASK = { 'X-Varanda-Precheck': '1' }
const ECHO_KEYS = ['zona', 'chave', 'x-real-ip', 'x-forwarded-for']
const MAX_ECHO_BYTES = 4096
const REQUEST_TIMEOUT_MS = 10_000
const USAGE = 'Uso: node scripts/bunny-precheck.js --origin https://<domínio> --hostname <hostname-de-mídia> [--ipv6]'

class UsageError extends Error {}

function parseArgs (argv) {
  const refused = ['--key', '--secret', '--api-key', '--env-file']
  if (argv.some((arg) => refused.includes(arg.split('=', 1)[0]))) {
    throw new UsageError('Opção recusada. Esta ferramenta nunca recebe o segredo nem a chave da API.')
  }
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }

  const flags = { '--origin': 'origin', '--hostname': 'hostname', '--ipv6': 'ipv6' }
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!Object.hasOwn(flags, flag)) throw new UsageError('Opção desconhecida.')
    const name = flags[flag]
    if (Object.hasOwn(opts, name)) throw new UsageError('Opção repetida: ' + flag + '.')
    if (name === 'ipv6') {
      opts.ipv6 = true
      continue
    }
    const value = argv[++i]
    if (!value || value.startsWith('-')) throw new UsageError('Falta um valor para ' + flag + '.')
    opts[name] = value
  }
  opts.origin = parseOrigin(opts.origin)
  if (!opts.origin) throw new UsageError('Use --origin https://<domínio>, sem caminho.')
  if (!validHostname(opts.hostname)) throw new UsageError('Use --hostname com um nome DNS em minúsculas.')
  if (new URL(opts.origin).hostname === opts.hostname) {
    throw new UsageError('O hostname de mídia deve ser diferente do hostname da origem.')
  }
  return opts
}

function fakes (token) {
  const [x, y, z, w] = crypto.createHash('sha256').update(token).digest()
  const octet = (byte) => 1 + byte % 254
  const p2Real = octet(x)
  const p3 = octet(w)
  return {
    p2Real: '203.0.113.' + p2Real,
    p2Fwd: ['198.51.100.' + octet(y), '192.0.2.' + octet(z)],
    p3: '203.0.113.' + (p3 === p2Real ? 1 + p3 % 254 : p3)
  }
}

function parseEcho (body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_ECHO_BYTES) return null
  const lines = body.split('\n')
  if (lines.at(-1) === '') lines.pop()

  const echo = {}
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon === -1) return null
    const key = line.slice(0, colon)
    if (!ECHO_KEYS.includes(key) || Object.hasOwn(echo, key)) return null
    echo[key] = line.slice(colon + (line[colon + 1] === ' ' ? 2 : 1))
  }

  if (!Object.hasOwn(echo, 'chave')) return null
  if (echo.zona === 'media' && lines.length === 2) return echo
  if ((echo.zona === 'media-cdn' || echo.zona === 'media-cdn-borda') && lines.length === 4) return echo
  return null
}

function normIp (s) {
  const version = isIP(s)
  if (version === 4) return s
  // Caddy rate-limit keys are addresses without a scope identifier.
  if (version !== 6 || s.includes('%')) return null
  const ipv6 = new URL('http://[' + s + ']').hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(ipv6)
  if (!mapped) return ipv6
  const high = parseInt(mapped[1], 16)
  const low = parseInt(mapped[2], 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

function printable (s) {
  if (typeof s !== 'string') return '?'
  const ascii = Buffer.from(s).toString('latin1').replace(/[^\x20-\x7e]/g, '?')
  return ascii.length > 100 ? ascii.slice(0, 97) + '...' : ascii
}

function evaluate (echo, truth, { p2Real, p2Fwd, p3 }) {
  if (echo?.zona === 'media-cdn') {
    const key = normIp(echo.chave)
    if (key !== null && [p2Real, ...p2Fwd, p3].includes(key)) {
      return { code: 1, message: 'A chave é um dos endereços falsos do teste.', danger: true }
    }
    if (key === null || key !== normIp(truth)) {
      return { code: 1, message: 'A chave não é o seu endereço.' }
    }
    if (echo['x-real-ip'] !== echo.chave || echo['x-forwarded-for'] !== echo.chave) {
      return { code: 1, message: 'Os dois cabeçalhos devem ter o mesmo valor da chave.' }
    }
    return { code: 0 }
  }
  if (echo?.zona === 'media') {
    return { code: 1, message: 'A zona de distribuição não envia o VARANDA_CDN_SECRET do servidor. Rode bunny.js apply com o mesmo segredo.' }
  }
  if (echo?.zona === 'media-cdn-borda') {
    return { code: 1, message: 'Os dois cabeçalhos não trazem um único endereço igual. As visitas pelo mesmo servidor do Bunny compartilhariam uma janela de limite.' }
  }
  return { code: 2, message: 'Resposta inesperada.' }
}

function requestEcho (url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const transport = url.protocol === 'http:' ? http : https
  return new Promise((resolve, reject) => {
    const req = transport.get(url, options, (res) => {
      const status = res.statusCode

      function finish (body) {
        resolve({ status, body })
        res.destroy()
      }

      res.once('error', reject)
      if (status !== 200 || url.pathname === '/') return finish(null)

      const chunks = []
      let bytes = 0
      res.on('readable', () => {
        if (bytes + res.readableLength > MAX_ECHO_BYTES) return finish(null)
        const chunk = res.read()
        if (chunk === null) return
        bytes += chunk.length
        chunks.push(chunk)
      })
      res.once('end', () => finish(Buffer.concat(chunks, bytes).toString('utf8')))
    })
    req.once('error', reject)
    const timeout = setTimeout(() => {
      reject(Object.assign(new Error(), { code: 'ETIMEDOUT' }))
      req.destroy()
    }, timeoutMs)
    req.once('close', () => clearTimeout(timeout))
  })
}

async function precheck ({ origin, hostname, ipv6 }, base, { stdout, stderr, request }) {
  const token = crypto.randomBytes(8).toString('hex')
  const path = '/media/precheck-' + token + '-'
  const family = ipv6 ? 6 : 4
  const cdn = 'https://' + hostname
  let challenge = null

  async function probe (label, target, path, extraHeaders) {
    let response
    try {
      response = await request(new URL(path, base || target), {
        method: 'GET',
        headers: { Host: new URL(target).host, 'User-Agent': 'varanda-precheck', Accept: 'text/plain', ...extraHeaders },
        family,
        agent: false
      })
    } catch (err) {
      const reason = err.code === 'ETIMEDOUT' ? 'tempo limite excedido' : 'erro de rede'
      stdout.write(label + ': ' + reason + '\n')
      return {}
    }

    const { status, body } = response
    let echo = status === 200 && path !== '/' ? parseEcho(body) : null
    if (label === 'p0' && (echo?.zona !== 'media' || !isIP(echo.chave))) echo = null
    let line = label + ': HTTP ' + status
    if (echo) {
      for (const key of ECHO_KEYS) {
        if (!Object.hasOwn(echo, key)) continue
        const value = challenge ? echo[key].replaceAll(challenge, '(omitido)') : echo[key]
        line += ' ' + key + '="' + printable(value) + '"'
      }
    }
    stdout.write(line + '\n')
    return { status, echo }
  }

  function inconclusive (reason) {
    stderr.write('INCONCLUSIVO: ' + reason + '\n')
    return 2
  }

  const direct = await probe('p0', origin, path + '0', ASK)
  if (direct.status === 404) {
    return inconclusive('O servidor ainda não tem a rota /media/precheck-*. Atualize o servidor.')
  }
  if (!direct.echo) return inconclusive('Resposta inesperada da origem em p0.')
  const truth = direct.echo.chave

  const g0 = await probe('g0', origin, '/')
  if (g0.status === 403) return inconclusive('A origem respondeu 403 sem X-Varanda-Edge. Não foi possível confirmar a proteção.')
  if (g0.status === undefined || (g0.status >= 300 && g0.status < 400)) {
    return inconclusive('Resposta inesperada da origem em g0.')
  }
  challenge = crypto.randomBytes(16).toString('hex')
  const g1 = await probe('g1', origin, '/', { [EDGE]: challenge })
  if (g1.status >= 200 && g1.status < 300) {
    return inconclusive('VARANDA_CDN_SECRET não está definido no servidor ou o servidor está em uma versão antiga.')
  }
  if (g1.status !== 403) return inconclusive('Resposta inesperada da origem em g1.')

  const fake = fakes(token)
  const { p2Real, p2Fwd, p3 } = fake
  const headers = [
    {},
    { [REAL]: p2Real, [FORWARDED]: p2Fwd.join(', ') },
    { [REAL]: p3, [FORWARDED]: p3 }
  ]
  const results = []
  for (const [i, extraHeaders] of headers.entries()) {
    const n = i + 1
    const label = 'p' + n
    const { echo } = await probe(label, cdn, path + n, { ...ASK, ...extraHeaders })
    const result = evaluate(echo, truth, fake)
    results.push(result)
    if (result.code === 1) stdout.write(label + ': FAIL. ' + result.message + '\n')
    if (result.code === 2) stdout.write(label + ': NÃO MEDIDO. ' + result.message + '\n')
  }
  if (results.some(({ code }) => code === 1)) {
    if (results.some(({ danger }) => danger)) {
      stderr.write('PERIGO: uma visita pode escolher a própria chave. Remova VARANDA_CDN_SECRET do servidor e reconfigure imediatamente.\n')
    }
    stderr.write('FAIL: a pré-checagem reprovou.\n')
    return 1
  }
  if (results.some(({ code }) => code === 2)) return inconclusive('Nem todos os pedidos ao Bunny puderam ser medidos.')
  stdout.write('PASS: o Bunny entregou o seu endereço nos dois cabeçalhos em todos os testes.\n')
  return 0
}

async function main (argv, env = process.env, io = {}) {
  const { stdout = process.stdout, stderr = process.stderr, request = requestEcho } = io
  try {
    const opts = parseArgs(argv)
    if (opts.help) {
      stdout.write(USAGE + '\n')
      return 0
    }

    const override = env.VARANDA_PRECHECK_BASE
    const base = override === undefined ? undefined : apiBase(override)
    if (override !== undefined && (!override || override.endsWith('/') || !base)) {
      throw new UsageError('VARANDA_PRECHECK_BASE recusado. Use http://127.0.0.1:<porta> nos testes.')
    }
    if (base) stderr.write('VARANDA_PRECHECK_BASE: todos os pedidos vão para ' + base + ', não para a origem nem para o Bunny.\n')
    return await precheck(opts, base, { stdout, stderr, request })
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(err.message + '\n' + USAGE + '\n')
      return 2
    }
    stderr.write('INCONCLUSIVO: falha na pré-checagem.\n')
    return 2
  }
}

module.exports = { parseEcho, normIp, fakes, evaluate, printable, parseArgs, requestEcho, main }

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
