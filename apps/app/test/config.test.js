'use strict'

// The Conectar / Conexão form rules (src/config.js). src/config.js is an ES
// module bundled by Metro; import() loads it here through Node's module
// syntax detection (Node 20.19 and newer).
const test = require('brittle')
const core = require('@varanda/core/lib/config')

const ASSOC = 'ab'.repeat(32)
const load = () => import('../src/config.js')
const publicForm = (dhtHost) => ({ association: ASSOC, bootstrapText: '', publicDht: true, dhtHost })

test('public DHT: a loopback DHT host is refused (issue #10)', async (t) => {
  const { checkForm } = await load()
  for (const host of ['127.0.0.1', ' 127.0.0.1 ', '127.8.9.10', 'localhost', 'LocalHost', '::1', '[::1]']) {
    const r = checkForm(publicForm(host))
    t.is(r.config, undefined, JSON.stringify(host) + ': no config')
    t.is(r.error, 'com a DHT pública, apague o endereço local da DHT: ' + host.trim() + ' só alcança este aparelho')
  }
})

test('public DHT: no host, or a host that is not loopback, is accepted', async (t) => {
  const { checkForm } = await load()
  t.alike(checkForm(publicForm('')).config, { association: ASSOC, bootstrap: null, dhtHost: null, allowPublicDht: true })
  t.alike(checkForm(publicForm('   ')).config, { association: ASSOC, bootstrap: null, dhtHost: null, allowPublicDht: true })
  for (const host of ['0.0.0.0', '192.168.1.5', '10.0.0.2', '128.0.0.1']) {
    t.is(checkForm(publicForm(host)).config.dhtHost, host, host)
  }
  // The bootstrap text is ignored by the screen when the switch is on, and
  // still refused here when both are given.
  t.is(checkForm({ ...publicForm(''), bootstrapText: '127.0.0.1:49737' }).error, 'bootstrap e DHT pública são exclusivos')
})

test('private bootstrap: a loopback DHT host is still accepted', async (t) => {
  const { checkForm } = await load()
  t.alike(checkForm({ association: ASSOC, bootstrapText: '127.0.0.1:49737', publicDht: false, dhtHost: '127.0.0.1' }).config, {
    association: ASSOC,
    bootstrap: ['127.0.0.1:49737'],
    dhtHost: '127.0.0.1',
    allowPublicDht: false
  })
})

test('revive: a loopback host saved with the public DHT is dropped, the rest kept', async (t) => {
  const { revive } = await load()
  t.alike(revive({ association: ASSOC, bootstrap: null, dhtHost: '127.0.0.1', allowPublicDht: true }), {
    association: ASSOC,
    bootstrap: null,
    dhtHost: null,
    allowPublicDht: true
  })
  t.is(revive({ association: ASSOC, bootstrap: null, dhtHost: '192.168.1.5', allowPublicDht: true }).dhtHost, '192.168.1.5')
  t.is(revive({ association: ASSOC, bootstrap: ['127.0.0.1:49737'], dhtHost: '127.0.0.1', allowPublicDht: false }).dhtHost, '127.0.0.1')
})

test('isLoopbackAddress matches packages/core', async (t) => {
  const { isLoopbackAddress } = await load()
  const cases = ['127.0.0.1', '127.255.255.255', '127.0.0.256', '127.1', 'localhost', 'LOCALHOST', 'localhost.example', '::1', '[::1]', '::2', '0.0.0.0', '128.0.0.1', '10.0.0.1', '']
  for (const host of cases) t.is(isLoopbackAddress(host), core.isLoopbackAddress(host), JSON.stringify(host))
  t.ok(isLoopbackAddress('127.0.0.1'))
  t.absent(isLoopbackAddress('127.0.0.256'))
})

test('web: the seeder address follows the browser node rule', async (t) => {
  const { validSeederUrl } = await load()
  const { checkSeederUrl } = require('@varanda/web-member/lib/seeder-url')
  const cases = [
    'ws://127.0.0.1:8789/seeder', 'wss://semeador.example/seeder', 'wss://semeador.example', 'WSS://Semeador.Example:443/x',
    'ws://[::1]:8789/seeder', 'http://semeador.example/seeder', 'https://semeador.example/', 'ftp://x/', 'ws://user:pw@x/',
    'ws://user@x/', 'ws://x/?a=1', 'ws://x/?', 'ws://x/#f', 'ws://x/#', 'ws://', 'ws:x', '', ' ws://x/', 'ws://x /y', 'ws://x/' + 'a'.repeat(2048)
  ]
  for (const c of cases) {
    let node = true
    try { checkSeederUrl(c) } catch { node = false }
    t.is(validSeederUrl(c), node, JSON.stringify(c.slice(0, 40)) + ': same verdict as the node')
  }
  t.ok(validSeederUrl('wss://semeador.example/seeder'))
  t.absent(validSeederUrl('http://semeador.example/seeder'))
})

test('web: checkWebForm, webFormOf and reviveWeb', async (t) => {
  const { checkWebForm, webFormOf, reviveWeb } = await load()
  const { checkSeederUrl } = require('@varanda/web-member/lib/seeder-url')
  const ok = checkWebForm({ association: ' ' + ASSOC.toUpperCase() + ' ', seederUrl: ' WSS://Semeador.Example/seeder ' })
  t.alike(ok.config, { association: ASSOC, seederUrl: 'wss://semeador.example/seeder' })
  t.is(ok.config.seederUrl, checkSeederUrl('wss://semeador.example/seeder'), 'normalized as the node normalizes it')
  t.is(checkWebForm({ association: 'xyz', seederUrl: 'wss://x/' }).error, 'chave da associação inválida (64 dígitos hexadecimais)')
  t.is(checkWebForm({ association: ASSOC, seederUrl: 'https://x/' }).error, 'endereço do semeador inválido: use ws:// ou wss://, sem usuário, consulta ou fragmento')
  t.is(checkWebForm({ association: ASSOC, seederUrl: 'ws://x/seeder' }, { secure: true }).error, 'nesta página segura (https), o endereço do semeador deve começar com wss://')
  t.ok(checkWebForm({ association: ASSOC, seederUrl: 'ws://127.0.0.1:8789/seeder' }).config, 'ws:// from an http page')
  t.alike(webFormOf(null), { association: '', seederUrl: '' })
  t.alike(webFormOf(ok.config), { association: ASSOC, seederUrl: 'wss://semeador.example/seeder' })
  t.alike(reviveWeb({ association: ASSOC, seederUrl: 'wss://semeador.example/seeder', extra: 1 }), ok.config)
  for (const bad of [null, [], 'x', { association: ASSOC }, { association: ASSOC, seederUrl: 'http://x/' }]) {
    t.is(reviveWeb(bad), null, JSON.stringify(bad))
  }
})

test('web: hostedConfigOf builds the seeder address from the page host', async (t) => {
  const { hostedConfigOf } = await load()
  t.alike(hostedConfigOf({ v: 1, association: ASSOC }, { host: 'varanda.example', secure: true }).config,
    { association: ASSOC, seederUrl: 'wss://varanda.example/seeder' })
  t.alike(hostedConfigOf({ v: 1, association: ASSOC.toUpperCase() }, { host: 'localhost:8081', secure: false }).config,
    { association: ASSOC, seederUrl: 'ws://localhost:8081/seeder' }, 'ws:// on http, port kept, key lower-cased')
  t.alike(hostedConfigOf({ v: 1, association: ASSOC, seederUrl: 'wss://evil.example/x' }, { host: 'varanda.example', secure: true }).config,
    { association: ASSOC, seederUrl: 'wss://varanda.example/seeder' }, 'an address in the JSON is ignored')
  const bad = [
    [{ v: 2, association: ASSOC }, 'wrong v'], [{ association: ASSOC }, 'missing v'],
    [{ v: 1 }, 'missing association'], [{ v: 1, association: 'xyz' }, 'invalid association'],
    [{ v: 1, association: 7 }, 'non-string association'], [[], 'array'], [null, 'null'], ['x', 'string']
  ]
  for (const [input, why] of bad) {
    const r = hostedConfigOf(input, { host: 'varanda.example', secure: true })
    t.is(r.config, undefined, why + ': no config')
    t.ok(typeof r.error === 'string', why + ': error')
  }
  t.is(hostedConfigOf({ v: 1, association: ASSOC }, { host: 'a.example/evil', secure: true }).config, undefined, 'host with a path')
  t.is(hostedConfigOf({ v: 1, association: ASSOC }, { host: 'u@a.example', secure: true }).config, undefined, 'host with credentials')
})

test('web: isHostedPage', async (t) => {
  const { isHostedPage } = await load()
  const page = (mode, protocol, hostname) => isHostedPage({ mode, protocol, hostname })
  t.ok(page('browser', 'https:', 'varanda.example'))
  t.absent(page('browser', 'http:', 'varanda.example'))
  t.absent(page('serve', 'https:', 'varanda.example'))
  for (const h of ['localhost', 'LocalHost', '127.0.0.1', '[::1]']) t.absent(page('browser', 'https:', h), h)
})

test('parseCertificateText: curly quotes from iOS smart punctuation are read as plain quotes', async (t) => {
  const { parseCertificateText } = await load()
  const plain = '{"v":1,"member":"' + ASSOC + '"}'
  const expected = { v: 1, member: ASSOC }
  t.alike(parseCertificateText(plain).cert, expected, 'plain quotes')
  for (const [open, close] of [['“', '”'], ['„', '”'], ['‟', '″']]) {
    let n = 0
    const curly = plain.replace(/"/g, () => (n++ % 2 === 0 ? open : close))
    t.alike(parseCertificateText(curly).cert, expected, open + close)
  }
})

test('parseCertificateText: invalid JSON and non-objects', async (t) => {
  const { parseCertificateText } = await load()
  t.alike(parseCertificateText('{"v":'), { error: 'JSON inválido' })
  t.alike(parseCertificateText(''), { error: 'JSON inválido' })
  for (const text of ['[]', 'null', '7', '"x"']) {
    t.alike(parseCertificateText(text), { error: 'o certificado deve ser um objeto JSON' }, text)
  }
})

test('formOf: no config gives an empty form, a config round-trips through checkForm', async (t) => {
  const { formOf, checkForm } = await load()
  t.alike(formOf(null), { association: '', bootstrapText: '', publicDht: false, dhtHost: '' })
  t.alike(formOf(undefined), { association: '', bootstrapText: '', publicDht: false, dhtHost: '' })
  const bootstrap = { association: ASSOC, bootstrap: ['a.example:49737', '10.0.0.2:1'], dhtHost: '10.0.0.5', allowPublicDht: false }
  t.alike(formOf(bootstrap), { association: ASSOC, bootstrapText: 'a.example:49737\n10.0.0.2:1', publicDht: false, dhtHost: '10.0.0.5' })
  t.alike(checkForm(formOf(bootstrap)).config, bootstrap, 'bootstrap config')
  const pub = { association: ASSOC, bootstrap: null, dhtHost: null, allowPublicDht: true }
  t.alike(formOf(pub), { association: ASSOC, bootstrapText: '', publicDht: true, dhtHost: '' })
  t.alike(checkForm(formOf(pub)).config, pub, 'public DHT config')
})

test('nativeHostedConfigOf: the installation /varanda.json for the app', async (t) => {
  const { nativeHostedConfigOf } = await load()
  const json = { v: 1, association: ASSOC.toUpperCase() }
  t.alike(nativeHostedConfigOf(json, { installation: 'https://varanda.example' }), {
    config: {
      kind: 'hosted',
      installationUrl: 'https://varanda.example',
      association: ASSOC,
      seederUrl: 'wss://varanda.example/seeder',
      rpId: 'varanda.example'
    }
  })
  const port = nativeHostedConfigOf(json, { installation: 'https://varanda.example:8443/' }).config
  t.is(port.installationUrl, 'https://varanda.example:8443')
  t.is(port.seederUrl, 'wss://varanda.example:8443/seeder', 'a non-default port stays')
  t.is(port.rpId, 'varanda.example')

  t.is(nativeHostedConfigOf({ v: 2, association: ASSOC }, { installation: 'https://varanda.example' }).error,
    'versão da configuração da instalação não suportada')
  for (const bad of [{ v: 1 }, { v: 1, association: 'ab' }, { v: 1, association: 'zz'.repeat(32) }, { v: 1, association: 7 }]) {
    t.is(nativeHostedConfigOf(bad, { installation: 'https://varanda.example' }).error,
      'chave da associação inválida (64 dígitos hexadecimais)', JSON.stringify(bad))
  }
  for (const bad of [null, [], 'x']) {
    t.is(nativeHostedConfigOf(bad, { installation: 'https://varanda.example' }).error, 'configuração da instalação inválida')
  }
  for (const installation of ['http://varanda.example', 'http://localhost:8080', 'ws://varanda.example',
    'https://varanda.example/x', 'https://varanda.example?x', 'https://u:p@varanda.example', 'https://Varanda.example',
    'https://varanda.example:443', 'https://127.0.0.1', 'https://[::1]', 'varanda.example', '', null, undefined, 42]) {
    t.is(nativeHostedConfigOf({ v: 1, association: ASSOC }, { installation }).error, 'endereço da instalação inválido', String(installation))
  }
  t.is(nativeHostedConfigOf({ v: 1, association: ASSOC }).error, 'endereço da instalação inválido')
})
