'use strict'

const test = require('brittle')
const http = require('node:http')
const { parseEcho, normIp, fakes, evaluate, printable, requestEcho, main } = require('../../../scripts/bunny-precheck.js')

const TOKEN = '0123456789abcdef'
const ORIGIN = 'https://example.org:8443'
const ORIGIN_HOST = new URL(ORIGIN).host
const HOST = 'media-test.example.org'
const TRUTH = '198.18.0.7'
const BUNNY = '198.18.0.10'
const ARGS = ['--origin', ORIGIN, '--hostname', HOST]
const FAKES = fakes(TOKEN)

function cdnEcho (key = TRUTH) {
  return { zona: 'media-cdn', chave: key, 'x-real-ip': key, 'x-forwarded-for': key }
}

function echoBody (echo) {
  return Object.entries(echo).map(([key, value]) => key + ': ' + value).join('\n')
}

const DIRECT = echoBody({ zona: 'media', chave: TRUTH })
const CDN = echoBody(cdnEcho())
const BORDER = echoBody({ ...cdnEcho(BUNNY), zona: 'media-cdn-borda', 'x-real-ip': '', 'x-forwarded-for': BUNNY + ', ' + TRUTH })

async function run (argv = ARGS, env = {}, request) {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, env, {
    stdout: { write: (line) => { stdout += line } },
    stderr: { write: (line) => { stderr += line } },
    request
  })
  return { code, stdout, stderr }
}

test('bunny precheck: parses the three echo shapes with or without a final newline', (t) => {
  const examples = [
    { zona: 'media', chave: TRUTH },
    cdnEcho(),
    { ...cdnEcho(BUNNY), zona: 'media-cdn-borda', 'x-real-ip': '', 'x-forwarded-for': BUNNY + ', ' + TRUTH }
  ]
  for (const echo of examples) {
    t.alike(parseEcho(echoBody(echo)), echo)
    t.alike(parseEcho(echoBody(echo) + '\n'), echo)
  }
  t.alike(parseEcho('chave:  2001:db8::1 \nzona:media'), { zona: 'media', chave: ' 2001:db8::1 ' })
})

test('bunny precheck: rejects malformed and oversized echoes', (t) => {
  for (const body of [
    null,
    '',
    DIRECT + '\nzona: media',
    CDN.replace('x-real-ip:', 'x-other:'),
    DIRECT.replace('media', 'media-other'),
    'zona: media\n',
    CDN.replace(/\nx-real-ip:[^\n]+/, ''),
    DIRECT + '\nx-real-ip: ' + TRUTH,
    DIRECT.replace('chave:', 'chave'),
    DIRECT + '\n\n',
    DIRECT.padEnd(4097, 'x'),
    DIRECT + 'é'.repeat(2048)
  ]) {
    t.is(parseEcho(body), null)
  }
  const atLimit = DIRECT.padEnd(4096, 'x')
  t.is(parseEcho(atLimit)?.chave, atLimit.split('chave: ')[1])
})

test('bunny precheck: normalizes IPv4, IPv6 and IPv4-mapped IPv6', (t) => {
  t.is(normIp('192.0.2.1'), '192.0.2.1')
  t.is(normIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1')
  t.is(normIp('2001:DB8::1'), normIp('2001:db8::1'))
  t.is(normIp('::ffff:192.0.2.1'), '192.0.2.1')
  t.is(normIp('::ffff:c000:201'), '192.0.2.1')
  for (const invalid of ['junk', ' 192.0.2.1', '192.0.2.1/32', '[::1]', 'fe80::1%eth0', undefined]) {
    t.is(normIp(invalid), null)
  }
})

test('bunny precheck: derives four distinct documentation addresses from the token', (t) => {
  const tokens = ['0000000000000000', 'ffffffffffffffff', TOKEN, '0123456789abcdee']
  const sets = new Set()
  for (const token of tokens) {
    const result = fakes(token)
    t.alike(result, fakes(token))
    const addresses = [result.p2Real, ...result.p2Fwd, result.p3]
    t.is(new Set(addresses).size, 4)
    for (const address of addresses) {
      const octet = Number(address.split('.').at(-1))
      t.ok(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(address))
      t.ok(octet >= 1 && octet <= 254)
    }
    sets.add([...addresses].sort().join(','))
  }
  t.is(sets.size, tokens.length)
})

test('bunny precheck: requires the direct IP and exact text in both CDN headers', (t) => {
  t.is(evaluate(cdnEcho(), TRUTH, FAKES).code, 0)
  t.is(evaluate(cdnEcho('2001:db8::1'), '2001:0DB8:0:0:0:0:0:1', FAKES).code, 0)
  t.is(evaluate(cdnEcho('::ffff:c612:7'), TRUTH, FAKES).code, 0)
  t.is(evaluate(cdnEcho(BUNNY), TRUTH, FAKES).code, 1, 'a different key fails')
  t.is(evaluate(cdnEcho('junk'), 'junk', FAKES).code, 1)
  t.is(evaluate({ ...cdnEcho(), 'x-forwarded-for': BUNNY }, TRUTH, FAKES).code, 1)
  t.is(evaluate({ ...cdnEcho(), 'x-real-ip': BUNNY }, TRUTH, FAKES).code, 1)
})

test('bunny precheck: diagnoses direct and border zones and leaves unknown zones unmeasured', (t) => {
  const direct = evaluate(parseEcho(DIRECT), TRUTH, FAKES)
  t.is(direct.code, 1)
  t.ok(direct.message.includes('bunny.js apply'))
  for (const echo of [
    parseEcho(BORDER),
    { ...parseEcho(BORDER), 'x-real-ip': 'a,a', 'x-forwarded-for': 'a' },
    { ...cdnEcho(), zona: 'media-cdn-borda' }
  ]) {
    const result = evaluate(echo, TRUTH, FAKES)
    t.is(result.code, 1, 'the border zone always fails')
    t.ok(result.message?.includes('compartilhariam uma janela'))
  }
  t.is(evaluate({ ...cdnEcho(), zona: 'unknown' }, TRUTH, FAKES).code, 2)
  t.is(evaluate(null, TRUTH, FAKES).code, 2)
})

test('bunny precheck: flags any fake key as dangerous', (t) => {
  for (const fake of [FAKES.p2Real, ...FAKES.p2Fwd, FAKES.p3]) {
    const result = evaluate(cdnEcho(fake), TRUTH, FAKES)
    t.is(result.code, 1)
    t.is(result.danger, true, 'every fake key must raise the danger flag')
  }
  t.is(evaluate(cdnEcho('::ffff:' + FAKES.p3), TRUTH, FAKES).danger, true)
  t.is(evaluate(cdnEcho(FAKES.p3), FAKES.p3, FAKES).danger, true)
})

test('bunny precheck: printable replaces non-ASCII bytes and caps the output', (t) => {
  t.is(printable('a\x00\x1b\n\t\x7fé z'), 'a??????? z')
  t.is(printable('x'.repeat(100)), 'x'.repeat(100))
  t.is(printable('x'.repeat(100) + 'discarded'), 'x'.repeat(97) + '...')
})

test('bunny precheck: help exits zero and invalid arguments are usage errors', async (t) => {
  for (const flag of ['--help', '-h']) {
    const { code, stdout, stderr } = await run([flag])
    t.is(code, 0)
    t.ok(stdout.startsWith('Uso:'))
    t.is(stderr, '')
  }
  for (const args of [
    [],
    ['--origin', ORIGIN],
    ['--hostname', HOST],
    ['--origin', '--hostname', HOST],
    ['--origin', ORIGIN, '--hostname'],
    [...ARGS, '--unknown'],
    [...ARGS, '--ipv6', 'extra'],
    ['--origin', ORIGIN + '/path', '--hostname', HOST],
    ['--origin', ORIGIN, '--hostname', HOST.toUpperCase()],
    ['--origin', ORIGIN, '--hostname', new URL(ORIGIN).hostname]
  ]) {
    const { code, stderr } = await run(args)
    t.is(code, 2)
    t.ok(stderr.includes('Uso:'))
  }
})

test('bunny precheck: refuses secret flags and bases outside loopback', async (t) => {
  for (const flag of ['--key', '--secret', '--api-key', '--env-file']) {
    for (const args of [[flag, 'unused'], [flag + '=unused']]) {
      const { code, stdout, stderr } = await run([...ARGS, ...args])
      t.is(code, 2)
      t.ok(stderr.includes('nunca recebe o segredo nem a chave da API'))
      t.absent((stdout + stderr).includes('unused'))
    }
  }
  for (const base of ['', 'http://example.org:80', 'http://localhost:80', 'https://127.0.0.1:80', 'http://127.0.0.1', 'http://127.0.0.1:80/', 'http://127.0.0.1:65536']) {
    const { code, stderr } = await run(ARGS, { VARANDA_PRECHECK_BASE: base })
    t.is(code, 2)
    t.ok(stderr.includes('VARANDA_PRECHECK_BASE recusado'))
  }
})

test('bunny precheck: uses GET and the selected IP family on all six requests', async (t) => {
  for (const family of [4, 6]) {
    const calls = []
    const request = async (url, options) => {
      calls.push({ host: url.host, options })
      if (url.pathname === '/') return { status: options.headers['X-Varanda-Edge'] ? 403 : 200 }
      return { status: 200, body: url.host === ORIGIN_HOST ? DIRECT : CDN }
    }
    const { code, stderr } = await run(family === 4 ? ARGS : [...ARGS, '--ipv6'], {}, request)
    t.is(code, 0, stderr)
    t.alike(calls.map(({ host }) => host), [ORIGIN_HOST, ORIGIN_HOST, ORIGIN_HOST, HOST, HOST, HOST])
    for (const [i, { options }] of calls.entries()) {
      t.is(options.family, family)
      t.is(options.method, 'GET')
      t.is(options.agent, false)
      t.is(options.headers['X-Varanda-Precheck'], i === 1 || i === 2 ? undefined : '1', 'the echo header only on the echo probes')
    }
  }
})

test('bunny precheck: reports timeouts and sanitizes echoed values', async (t) => {
  let challenge
  const request = async (url, { headers }) => {
    if (url.pathname === '/') {
      challenge = headers['X-Varanda-Edge']
      return challenge ? { status: 403, body: challenge } : { status: 200 }
    }
    if (url.pathname.endsWith('-0')) return { status: 200, body: DIRECT }
    if (url.pathname.endsWith('-1')) throw Object.assign(new Error(challenge), { code: 'ETIMEDOUT' })
    if (url.pathname.endsWith('-2')) return { status: 200, body: BORDER.replace('x-real-ip: ', 'x-real-ip: \x1b' + challenge) }
    return { status: 200, body: CDN }
  }
  const { code, stdout, stderr } = await run(ARGS, {}, request)
  t.is(code, 1)
  t.ok(stdout.includes('p1: tempo limite excedido'))
  t.ok(stdout.includes('p1: NÃO MEDIDO'))
  t.ok(stdout.includes('x-real-ip="?(omitido)"'))
  t.ok(stdout.includes('p3: HTTP 200'))
  t.absent((stdout + stderr).includes(challenge))
  t.absent(stdout.includes('\x1b'))
})

async function server (t, answers) {
  const requests = []
  const server = http.createServer((req, res) => {
    const { host } = req.headers
    const match = /^\/media\/precheck-([0-9a-f]{16})-([0-3])$/.exec(req.url)
    let label
    if (host === ORIGIN_HOST && req.url === '/') label = req.headers['x-varanda-edge'] ? 'g1' : 'g0'
    if (host === ORIGIN_HOST && match?.[2] === '0') label = 'p0'
    if (host === HOST && match && match[2] !== '0') label = 'p' + match[2]
    requests.push({ label, method: req.method, path: req.url, headers: req.headers })
    // Like the Caddy route: without the header, the path goes to the seeder.
    if (match && req.headers['x-varanda-precheck'] !== '1') return res.writeHead(404).end()

    const answer = answers[label]
    if (typeof answer === 'function') return answer(req, res)
    if (typeof answer === 'number') return res.writeHead(answer).end('corpo inesperado')
    if (!label) return res.writeHead(404).end()
    if (label === 'g1') return res.writeHead(403).end(req.headers['x-varanda-edge'])
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(answer ?? (label === 'g0' ? '' : label === 'p0' ? DIRECT : CDN))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.teardown(() => new Promise((resolve) => server.close(resolve)), { force: true })

  return { ...await run(ARGS, { VARANDA_PRECHECK_BASE: 'http://127.0.0.1:' + server.address().port }), requests }
}

test('bunny precheck: HTTP success sends only the intended headers to each host', async (t) => {
  const { code, stdout, stderr, requests } = await server(t, {})
  t.is(code, 0, stderr)
  const token = requests[0]?.path.match(/precheck-([0-9a-f]{16})-0$/)?.[1]
  t.ok(token)
  t.alike(requests.map((r) => [r.label, r.method, r.headers.host, r.path]), [
    ['p0', 'GET', ORIGIN_HOST, '/media/precheck-' + token + '-0'],
    ['g0', 'GET', ORIGIN_HOST, '/'],
    ['g1', 'GET', ORIGIN_HOST, '/'],
    ...[1, 2, 3].map((n) => ['p' + n, 'GET', HOST, '/media/precheck-' + token + '-' + n])
  ])
  if (!token || requests.length !== 6) return
  const [p0, g0, g1, p1, p2, p3] = requests.map((r) => r.headers)
  const challenge = g1['x-varanda-edge']
  t.ok(/^[0-9a-f]{32}$/.test(challenge))
  t.absent((stdout + stderr).includes(challenge))
  for (const headers of [p0, g0, p1, p2, p3]) t.absent(headers['x-varanda-edge'])
  for (const headers of [p0, p1, p2, p3]) t.is(headers['x-varanda-precheck'], '1')
  for (const headers of [g0, g1]) t.absent(headers['x-varanda-precheck'])
  t.ok(stderr.includes('VARANDA_PRECHECK_BASE: todos os pedidos vão para http://127.0.0.1:'))
  for (const headers of [p0, g0, g1, p1]) {
    t.absent(headers['x-real-ip'])
    t.absent(headers['x-forwarded-for'])
  }
  for (const { headers } of requests) {
    t.is(headers['user-agent'], 'varanda-precheck')
    t.is(headers.accept, 'text/plain')
  }
  const { p2Real, p2Fwd, p3: fake } = fakes(token)
  t.is(p2['x-real-ip'], p2Real)
  t.is(p2['x-forwarded-for'], p2Fwd.join(', '))
  t.is(p3['x-real-ip'], fake)
  t.is(p3['x-forwarded-for'], fake)
  t.ok(stdout.includes('p0: HTTP 200 zona="media" chave="' + TRUTH + '"'))
  t.ok(stdout.includes('p3: HTTP 200 zona="media-cdn" chave="' + TRUTH + '"'))
  t.ok(stdout.includes('PASS:'))
})

for (const [name, answers, expected, diagnostic] of [
  ['missing echo route', { p0: 404 }, ['p0'], 'Atualize o servidor'],
  ['unexpected direct echo', { p0: CDN }, ['p0'], 'Resposta inesperada'],
  ['direct key not an address', { p0: echoBody({ zona: 'media', chave: 'abc' }) }, ['p0'], 'Resposta inesperada da origem em p0'],
  ['blocked negative control', { g0: 403 }, ['p0', 'g0'], 'sem X-Varanda-Edge'],
  ['inactive secret gate', { g1: 200 }, ['p0', 'g0', 'g1'], 'VARANDA_CDN_SECRET não está definido'],
  ['unexpected secret gate', { g1: 500 }, ['p0', 'g0', 'g1'], 'Resposta inesperada da origem em g1']
]) {
  test('bunny precheck: HTTP stops before Bunny on ' + name, async (t) => {
    const { code, stdout, stderr, requests } = await server(t, answers)
    t.is(code, 2)
    t.alike(requests.map(({ label }) => label), expected)
    t.absent(requests.some(({ headers }) => headers.host === HOST))
    t.ok(stderr.includes(diagnostic))
    t.absent(stdout.includes('corpo inesperado'))
    t.absent(stdout.includes('media-cdn'))
  })
}

for (const [name, answers, expected, diagnostic] of [
  ['direct zone', { p1: DIRECT }, 1, 'bunny.js apply'],
  ['border zone', { p1: BORDER }, 1, 'x-real-ip="" x-forwarded-for="' + BUNNY + ', ' + TRUTH + '"'],
  ['fake key', { p3: (req, res) => res.end(echoBody(cdnEcho(req.headers['x-real-ip']))) }, 1, 'PERIGO:'],
  ['HTTP error', { p2: 500 }, 2, 'p2: HTTP 500'],
  ['failure and HTTP error', { p1: BORDER, p2: 500 }, 1, 'p2: NÃO MEDIDO'],
  ['redirect', { p1: (req, res) => res.writeHead(301, { Location: '/redirect-target' }).end() }, 2, 'p1: HTTP 301'],
  ['socket error', { p1: (req) => req.socket.destroy() }, 2, 'p1: erro de rede'],
  ['unknown zone', { p1: DIRECT.replace('media', 'unknown') }, 2, 'p1: NÃO MEDIDO'],
  ['oversized echo', { p1: (req, res) => { res.write(CDN.padEnd(4096, 'x')); res.end('x') } }, 2, 'p1: NÃO MEDIDO']
]) {
  test('bunny precheck: HTTP classifies ' + name + ' and completes the probe sequence', async (t) => {
    const { code, stdout, stderr, requests } = await server(t, answers)
    t.is(code, expected)
    t.alike(requests.map(({ label }) => label), ['p0', 'g0', 'g1', 'p1', 'p2', 'p3'])
    t.ok((stdout + stderr).includes(diagnostic))
    t.ok(stderr.includes(expected === 1 ? 'FAIL:' : 'INCONCLUSIVO:'))
    t.absent(stdout.includes('corpo inesperado'))
    if (name === 'fake key') t.ok(stderr.includes('Remova VARANDA_CDN_SECRET do servidor e reconfigure'))
  })
}

test('bunny precheck: a request that gets no answer times out', async (t) => {
  const server = http.createServer(() => {})
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.teardown(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  }, { force: true })
  const url = new URL('/media/precheck-' + TOKEN + '-0', 'http://127.0.0.1:' + server.address().port)
  await t.exception(requestEcho(url, { method: 'GET', agent: false }, 50), /^Error$/)
  const err = await requestEcho(url, { method: 'GET', agent: false }, 50).catch((e) => e)
  t.is(err.code, 'ETIMEDOUT')
})
