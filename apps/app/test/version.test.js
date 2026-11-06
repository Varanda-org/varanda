'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/version.js')

const A = 'a'.repeat(40)
const B = '0123456789abcdef0123456789abcdef01234567'
const R = '0123456789abcdef'
const BUILT = '2026-11-05T12:34:56Z'
const GOOD_BODY = '{"v":1,"commit":"' + A + '"}\n'

function headers (map) {
  return { get: (name) => (Object.prototype.hasOwnProperty.call(map, name.toLowerCase()) ? map[name.toLowerCase()] : null) }
}

function streamBody (text, { chunk = 8 } = {}) {
  const bytes = Buffer.from(text)
  let offset = 0
  const state = { cancelled: false }
  const reader = {
    read: async () => {
      if (offset >= bytes.length) return { done: true, value: undefined }
      const value = new Uint8Array(bytes.subarray(offset, offset + chunk))
      offset += chunk
      return { done: false, value }
    },
    cancel: async () => { state.cancelled = true }
  }
  return { body: { getReader: () => reader }, state }
}

function response ({ status = 200, url = '', redirected = false, type = 'application/json', length, body = null, text = null } = {}) {
  const map = {}
  if (type !== null) map['content-type'] = type
  if (length !== undefined) map['content-length'] = length
  const res = { status, url, redirected, headers: headers(map), body }
  res.text = async () => {
    if (text === null) throw new Error('no text')
    return text
  }
  return res
}

test('buildInfo keeps only exact matches', async (t) => {
  const { buildInfo } = await load()
  t.alike(buildInfo({ kind: 'web', commit: A, builtAt: BUILT, release: R }), { kind: 'web', commit: A, builtAt: BUILT, release: R })
  t.alike(buildInfo({ kind: 'android', commit: B }), { kind: 'android', commit: B, builtAt: null, release: null })
  t.alike(buildInfo({ kind: 'ios' }).kind, 'ios')
  t.alike(buildInfo(), { kind: null, commit: null, builtAt: null, release: null })
  t.alike(buildInfo({ kind: {}, commit: [], builtAt: 1, release: Symbol('x') }), { kind: null, commit: null, builtAt: null, release: null })

  const bad = ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), ' ' + 'a'.repeat(39), 'a'.repeat(40) + '\n', 'desconhecido', '<script>', 42, null, {}]
  for (const commit of bad) t.is(buildInfo({ commit }).commit, null, 'commit ' + JSON.stringify(commit))
  for (const release of ['A'.repeat(16), 'a'.repeat(15), 'a'.repeat(17), ' ' + 'a'.repeat(16), 'desconhecido', '<script>', 7]) {
    t.is(buildInfo({ release }).release, null, 'release ' + JSON.stringify(release))
  }
  for (const builtAt of ['2026-11-05T12:34:56', '2026-11-05t12:34:56Z', ' 2026-11-05T12:34:56Z', '2026-13-05T12:34:56Z', '2026-11-32T12:34:56Z', '2026-11-05T24:00:00Z', '2026-11-05T12:60:00Z', '2026-11-05T12:34:56.000Z', 'desconhecido', '<script>']) {
    t.is(buildInfo({ builtAt }).builtAt, null, 'builtAt ' + builtAt)
  }
  for (const kind of ['Web', 'WEB', ' web', 'desktop', 'toString', '__proto__', 'desconhecido', '<script>', 1]) {
    t.is(buildInfo({ kind }).kind, null, 'kind ' + String(kind))
  }
})

test('shortCommit shortens a valid commit only', async (t) => {
  const { shortCommit, UNKNOWN } = await load()
  t.is(UNKNOWN, 'desconhecido')
  t.is(shortCommit(B), '0123456')
  t.is(shortCommit('A'.repeat(40)), UNKNOWN)
  t.is(shortCommit('a'.repeat(39)), UNKNOWN)
  t.is(shortCommit('<script>'), UNKNOWN)
  t.is(shortCommit(null), UNKNOWN)
})

test('parseDeployedCommit accepts only { v: 1, commit }', async (t) => {
  const { parseDeployedCommit, MAX_VERSION_BYTES } = await load()
  t.is(MAX_VERSION_BYTES, 256)
  t.is(parseDeployedCommit(GOOD_BODY), A)
  t.is(parseDeployedCommit('{"commit":"' + A + '","v":1}'), A)
  t.is(parseDeployedCommit('{"v":1,"commit":"' + A + '","x":1}'), null)
  t.is(parseDeployedCommit('{"v":1}'), null)
  t.is(parseDeployedCommit('{"commit":"' + A + '"}'), null)
  t.is(parseDeployedCommit('{"v":"1","commit":"' + A + '"}'), null)
  t.is(parseDeployedCommit('{"v":2,"commit":"' + A + '"}'), null)
  t.is(parseDeployedCommit('["' + A + '"]'), null)
  t.is(parseDeployedCommit('null'), null)
  t.is(parseDeployedCommit('{"v":1,"commit":"' + 'A'.repeat(40) + '"}'), null)
  t.is(parseDeployedCommit('{"v":1,"commit":"' + 'a'.repeat(39) + '"}'), null)
  const padded = ('{"v":1,"commit":"' + A + '"}').padEnd(257, ' ')
  t.is(padded.length, 257)
  t.is(parseDeployedCommit(padded), null)
  t.is(parseDeployedCommit(padded.slice(0, 256)), A)
  t.is(parseDeployedCommit('not json'), null)
  t.is(parseDeployedCommit(''), null)
  t.is(parseDeployedCommit(null), null)
  t.is(parseDeployedCommit(42), null)
})

test('redirectedAway rejects anything but the version path', async (t) => {
  const { redirectedAway, VERSION_PATH } = await load()
  t.is(VERSION_PATH, '/version.json')
  const installation = 'https://varanda.example'
  t.is(redirectedAway({ redirected: true, url: installation + '/version.json' }), true)
  t.is(redirectedAway({ url: installation + '/version.json' }), false)
  t.is(redirectedAway({ url: installation + '/version.json' }, { installation }), false)
  t.is(redirectedAway({ url: installation + '/version.json?x=1' }), true)
  t.is(redirectedAway({ url: 'https://u:p@varanda.example/version.json' }), true)
  t.is(redirectedAway({ url: 'https://u@varanda.example/version.json' }), true)
  t.is(redirectedAway({ url: installation + '/login' }), true)
  t.is(redirectedAway({ url: 'https://other.example/version.json' }, { installation }), true)
  t.is(redirectedAway({ url: 'https://other.example/version.json' }), false)
  t.is(redirectedAway({ url: 'https://other.example/version.json' }, { installation: '' }), false)
  t.is(redirectedAway({ url: '' }), false)
  t.is(redirectedAway({}), false)
  t.is(redirectedAway(), false)
  t.is(redirectedAway({ url: 'not a url' }), true)
})

test('fetchDeployedCommit reads a streamed body', async (t) => {
  const { fetchDeployedCommit } = await load()
  const calls = []
  const { body } = streamBody(GOOD_BODY)
  const signal = {}
  const result = await fetchDeployedCommit({
    signal,
    fetch: async (url, opts) => { calls.push([url, opts]); return response({ url: 'https://varanda.example/version.json', body }) }
  })
  t.alike(result, { status: 'ok', commit: A })
  t.is(calls.length, 1)
  t.is(calls[0][0], '/version.json')
  t.alike(Object.keys(calls[0][1]).sort(), ['credentials', 'redirect', 'signal'])
  t.is(calls[0][1].credentials, 'omit')
  t.is(calls[0][1].redirect, 'error')
  t.is(calls[0][1].signal, signal)
})

test('fetchDeployedCommit reads text with a bounded content-length', async (t) => {
  const { fetchDeployedCommit } = await load()
  const installation = 'https://varanda.example'
  let asked = null
  const result = await fetchDeployedCommit({
    installation,
    fetch: async (url) => { asked = url; return response({ url: installation + '/version.json', type: 'application/json; charset=utf-8', length: String(GOOD_BODY.length), text: GOOD_BODY }) }
  })
  t.is(asked, installation + '/version.json')
  t.alike(result, { status: 'ok', commit: A })
})

test('fetchDeployedCommit is unavailable on every bad answer', async (t) => {
  const { fetchDeployedCommit } = await load()
  const installation = 'https://varanda.example'
  const url = installation + '/version.json'
  const unavailable = { status: 'unavailable' }
  const run = (res, opts = {}) => fetchDeployedCommit({ installation, fetch: async () => res, ...opts })

  t.alike(await run(response({ url, text: GOOD_BODY })), unavailable, 'no content-length, no stream')
  t.alike(await run(response({ url, length: '257', text: GOOD_BODY })), unavailable, 'declared oversize')
  t.alike(await run(response({ url, length: '01', text: GOOD_BODY })), unavailable, 'malformed content-length')
  t.alike(await run(response({ url, length: '10', text: GOOD_BODY + ' '.repeat(300) })), unavailable, 'text longer than declared bound')

  const big = streamBody(GOOD_BODY + ' '.repeat(300))
  t.alike(await run(response({ url, body: big.body })), unavailable, 'oversize stream')
  t.is(big.state.cancelled, true, 'reader cancelled')

  t.alike(await run(response({ url, status: 404, text: GOOD_BODY, length: '59' })), unavailable, '404')
  t.alike(await run(response({ url, status: 500, text: GOOD_BODY, length: '59' })), unavailable, '500')
  t.alike(await run(response({ url, type: 'text/html', text: GOOD_BODY, length: '59' })), unavailable, 'text/html')
  t.alike(await run(response({ url, type: null, text: GOOD_BODY, length: '59' })), unavailable, 'no content-type')
  t.alike(await run(response({ url, redirected: true, text: GOOD_BODY, length: '59' })), unavailable, 'redirected')
  t.alike(await run(response({ url: url + '?x=1', text: GOOD_BODY, length: '59' })), unavailable, 'query in final url')
  t.alike(await run(response({ url: 'https://other.example/version.json', text: GOOD_BODY, length: '59' })), unavailable, 'other origin')
  t.alike(await run(response({ url, text: '{"v":1,"commit":"<script>"}', length: '27' })), unavailable, 'invalid commit')
  t.alike(await run(null, { fetch: async () => { throw new Error('offline') } }), unavailable, 'fetch throws')
  // null, not undefined: undefined would fall back to the real globalThis.fetch
  // and reach the network.
  t.alike(await run(null, { fetch: null }), unavailable, 'no fetch')

  const throwingHeaders = response({ url, text: GOOD_BODY })
  throwingHeaders.headers = { get: () => { throw new Error('boom') } }
  t.alike(await run(throwingHeaders), unavailable, 'headers throw')

  let cancelled = false
  const html = response({ url, type: 'text/html' })
  html.body = { cancel: async () => { cancelled = true } }
  t.alike(await run(html), unavailable)
  t.is(cancelled, true, 'body cancelled on a rejected answer')
})

test('versionLines formats each kind and status', async (t) => {
  const { versionLines, buildInfo } = await load()
  const web = buildInfo({ kind: 'web', commit: B, builtAt: BUILT, release: R })
  const android = buildInfo({ kind: 'android', commit: B, builtAt: BUILT })
  const ios = buildInfo({ kind: 'ios', commit: B, builtAt: BUILT })
  const ok = { status: 'ok', commit: A }

  t.alike(versionLines({ app: web, server: ok }), {
    appLine: 'App: web · 0123456 · 2026-11-05 · release ' + R,
    serverLine: 'Servidor: aaaaaaa'
  })
  t.is(versionLines({ app: android, server: ok }).appLine, 'App: Android · 0123456 · 2026-11-05')
  t.is(versionLines({ app: ios, server: ok }).appLine, 'App: iOS · 0123456 · 2026-11-05')
  t.is(versionLines({ app: buildInfo({ kind: 'web' }), server: ok }).appLine, 'App: web · desconhecido · desconhecido · release desconhecido')
  t.is(versionLines({ app: buildInfo(), server: ok }).appLine, 'App: desconhecido · desconhecido · desconhecido')

  t.is(versionLines({ app: web, server: { status: 'loading' } }).serverLine, 'Servidor: consultando…')
  t.is(versionLines({ app: web, server: { status: 'unavailable' } }).serverLine, 'Servidor: desconhecido')
  t.is(versionLines({ app: web, server: { status: 'unconfigured' } }).serverLine, null)
  t.is(versionLines({ app: web, server: { status: 'ok', commit: '<script>' } }).serverLine, 'Servidor: desconhecido')
  t.is(versionLines({ app: web, server: { status: 'unavailable', commit: A } }).serverLine, 'Servidor: desconhecido')
})

test('versionLines and versionDetails never echo unchecked input', async (t) => {
  const { versionLines, versionDetails } = await load()
  const raw = { kind: 'toString', commit: '<script>', builtAt: '<img>' + 'x'.repeat(20), release: '<b>' }
  const server = { status: 'ok', commit: '<svg>' }
  const { appLine, serverLine } = versionLines({ app: raw, server })
  t.is(appLine, 'App: desconhecido · desconhecido · desconhecido')
  t.is(serverLine, 'Servidor: desconhecido')
  const webRaw = { kind: 'web', commit: 'A'.repeat(40), builtAt: '2026-11-05', release: 'G'.repeat(16) }
  t.is(versionLines({ app: webRaw, server }).appLine, 'App: web · desconhecido · desconhecido · release desconhecido')
  t.is(versionDetails({ app: webRaw, server }), [
    'Varanda',
    'App: web',
    'Commit: desconhecido',
    'Build: desconhecido',
    'Release web: desconhecido',
    'Servidor: desconhecido'
  ].join('\n'))
  t.is(versionDetails({ app: raw, server }), 'Varanda\nApp: desconhecido\nCommit: desconhecido\nBuild: desconhecido\nServidor: desconhecido')
})

test('versionDetails lists the full values', async (t) => {
  const { versionDetails, buildInfo } = await load()
  const web = buildInfo({ kind: 'web', commit: B, builtAt: BUILT, release: R })
  t.is(versionDetails({ app: web, server: { status: 'ok', commit: A } }),
    'Varanda\nApp: web\nCommit: ' + B + '\nBuild: ' + BUILT + '\nRelease web: ' + R + '\nServidor: ' + A)
  const android = buildInfo({ kind: 'android', commit: B, builtAt: BUILT })
  t.is(versionDetails({ app: android, server: { status: 'loading', commit: A } }),
    'Varanda\nApp: Android\nCommit: ' + B + '\nBuild: ' + BUILT + '\nServidor: consultando')
  const ios = buildInfo({ kind: 'ios' })
  t.is(versionDetails({ app: ios, server: { status: 'unconfigured' } }),
    'Varanda\nApp: iOS\nCommit: desconhecido\nBuild: desconhecido\nServidor: sem instalação')
})

test('module source stays pure and free of em dashes', async (t) => {
  const { KIND_LABELS, COMMIT_RE, RELEASE_RE, BUILD_DATE_RE } = await load()
  t.alike(KIND_LABELS, { web: 'web', android: 'Android', ios: 'iOS' })
  t.is(COMMIT_RE.source, '^[0-9a-f]{40}$')
  t.is(RELEASE_RE.source, '^[0-9a-f]{16}$')
  t.is(BUILD_DATE_RE.source, '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$')
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'version.js'), 'utf8')
  t.absent(source.includes('\u2014'), 'no em dash')
  t.absent(/^\s*import\b/m.test(source), 'no imports')
  t.absent(/\bimport\s*\(/.test(source), 'no dynamic imports')
  t.absent(/require\s*\(/.test(source), 'no require')
})
