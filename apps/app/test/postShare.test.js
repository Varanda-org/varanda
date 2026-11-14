'use strict'

// The publish flow's pure parts: the rpc state mapping (src/postShare.js),
// the /p/policy probe (src/postPublicPolicy.js) with a stubbed fetch, and
// source checks on the sheet. Nothing touches the network.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const loadShare = () => import('../src/postShare.js')
const loadPolicy = () => import('../src/postPublicPolicy.js')
const loadInstallation = () => import('../src/installation.js')

const REF = 'ab'.repeat(32) + ':7'
const UNCERTAIN = 'Não deu para confirmar. Abra de novo para conferir.'
const SRC = path.join(__dirname, '../src')
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8')

function caller (answer) {
  const calls = []
  const call = async (method, params) => {
    calls.push([method, params])
    if (answer instanceof Error || (answer && answer.throws)) throw answer.throws || answer
    return answer
  }
  return { calls, call }
}

function rpcError (code, message, uncertain = false) {
  return Object.assign(new Error(message), { code, uncertain })
}

test('readShared maps a share seq to on and null to off', async (t) => {
  const { readShared } = await loadShare()
  const on = caller({ shareSeq: 12 })
  t.alike(await readShared(on.call, REF), { state: 'on', shareSeq: 12, message: '' })
  t.alike(on.calls, [['post.shared', { to: REF }]])
  t.alike(await readShared(caller({ shareSeq: null }).call, REF), { state: 'off', shareSeq: null, message: '' })
})

test('publish and unpublish map their results without claiming more', async (t) => {
  const { publish, unpublish } = await loadShare()
  const made = caller({ shareSeq: 9, created: true })
  t.alike(await publish(made.call, REF), { state: 'on', shareSeq: 9, message: '' })
  t.alike(made.calls, [['post.share', { to: REF }]])
  t.alike(await publish(caller({ shareSeq: 9, created: false }).call, REF), { state: 'on', shareSeq: 9, message: '' })
  const gone = caller({ ok: true, changed: true })
  t.alike(await unpublish(gone.call, REF), { state: 'off', shareSeq: null, message: '' })
  t.alike(gone.calls, [['post.unshare', { to: REF }]])
  t.alike(await unpublish(caller({ ok: true, changed: false }).call, REF), { state: 'off', shareSeq: null, message: '' })
})

test('an answer of the wrong shape is uncertain, never on or off', async (t) => {
  const { readShared, publish, unpublish } = await loadShare()
  const unknown = { state: 'uncertain', shareSeq: null, message: UNCERTAIN }
  for (const bad of [null, undefined, [], {}, { shareSeq: 0 }, { shareSeq: '12' }, { shareSeq: 1.5 }]) {
    t.alike(await readShared(caller(bad).call, REF), unknown, 'post.shared ' + JSON.stringify(bad))
  }
  for (const bad of [{ shareSeq: null, created: true }, { shareSeq: 3 }, { shareSeq: 3, created: 'yes' }]) {
    t.alike(await publish(caller(bad).call, REF), unknown, 'post.share ' + JSON.stringify(bad))
  }
  for (const bad of [{ ok: false, changed: true }, { changed: true }, { ok: true }]) {
    t.alike(await unpublish(caller(bad).call, REF), unknown, 'post.unshare ' + JSON.stringify(bad))
  }
})

test('uncertain errors, timeouts and transport failures are uncertain', async (t) => {
  const { readShared, publish, unpublish } = await loadShare()
  const unknown = { state: 'uncertain', shareSeq: null, message: UNCERTAIN }
  const errors = [
    rpcError('USAGE', 'referência inválida', true),
    rpcError('TIMEOUT', 'tempo esgotado'),
    rpcError('CLOSED', 'conexão encerrada'),
    rpcError('INTERNAL', 'erro interno'),
    new TypeError('Failed to fetch'),
    { throws: 'not an error object' }
  ]
  for (const fn of [readShared, publish, unpublish]) {
    for (const err of errors) {
      const c = caller(err)
      t.alike(await fn(c.call, REF), unknown, fn.name + ' ' + (err.code || err.message || 'string'))
      t.is(c.calls.length, 1, 'never retried')
    }
  }
})

test('refusals are errors in plain words, never the raw message', async (t) => {
  const { readShared, publish, unpublish, errorState } = await loadShare()
  const cases = [
    ['USAGE', 'referência inválida', 'Não encontramos esta publicação. Ela pode ter sido apagada.'],
    ['USAGE', 'o registro não é uma publicação', 'Só uma publicação pode ir para a web.'],
    ['USAGE', 'limite do diário atingido', 'Seu diário chegou ao limite de registros.'],
    ['USAGE', 'limite de publicações na web atingido', 'Você chegou ao limite de publicações na web.'],
    ['USAGE', 'identidade bloqueada: entre com a passkey', 'Entre com sua passkey para continuar.'],
    ['NOT_FOUND', 'identidade não encontrada', 'Entre na sua conta para continuar.'],
    ['USAGE', 'A página pública de uma publicação só pode ser ligada pelo app ou pelo navegador.', 'Publicar na web só funciona pelo app ou pelo navegador.'],
    ['USAGE', 'sincronize com o semeador antes de publicar', 'Sem conexão com o servidor agora. Tente de novo em instantes.']
  ]
  for (const fn of [readShared, publish, unpublish]) {
    for (const [code, raw, words] of cases) {
      const c = caller(rpcError(code, raw))
      t.alike(await fn(c.call, REF), { state: 'error', shareSeq: null, message: words }, fn.name + ' ' + raw)
      t.is(c.calls.length, 1, 'never retried')
    }
  }
  const odd = 'algo que o nó disse /tmp/x'
  t.alike(errorState(rpcError('USAGE', odd), 'read'), { state: 'error', shareSeq: null, message: 'Não deu para ver se esta publicação está na web.' })
  t.alike(errorState(rpcError('USAGE', odd), 'publish'), { state: 'error', shareSeq: null, message: 'Não deu para publicar na web.' })
  t.alike(errorState(rpcError('LOCKED', odd), 'unpublish'), { state: 'error', shareSeq: null, message: 'Não deu para tirar da web.' })
})

test('a bad ref or a missing call never reaches the node', async (t) => {
  const { readShared, publish } = await loadShare()
  const c = caller({ shareSeq: null })
  for (const ref of [null, '', 'ab'.repeat(32) + '/7', 'ab'.repeat(32) + ':0', 'AB'.repeat(32) + ':7', 'ab'.repeat(31) + ':7']) {
    t.is((await readShared(c.call, ref)).state, 'error')
  }
  t.is((await publish(null, REF)).state, 'error')
  t.is(c.calls.length, 0)
})

function stubFetch (t, answer) {
  const calls = []
  const before = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return typeof answer === 'function' ? answer(url, init) : answer
  }
  t.teardown(() => { globalThis.fetch = before })
  return calls
}

function reply (status, body, extra = {}) {
  return { status, redirected: false, text: async () => body, ...extra }
}

test('the probe is true only for 200 with enabled === true', async (t) => {
  const { postPublicEnabled, forgetPostPublicPolicy } = await loadPolicy()
  const origin = 'https://bora.example'
  const cases = [
    [reply(200, '{"enabled":true}'), true],
    [reply(200, '{"enabled":false}'), false],
    [reply(200, '{"enabled":"true"}'), false],
    [reply(200, '{"enabled":1}'), false],
    [reply(200, '{}'), false],
    [reply(404, '{"enabled":true}'), false],
    [reply(204, ''), false],
    [reply(200, 'not json'), false],
    [reply(200, '[true]'), false],
    [reply(200, 'true'), false],
    [reply(200, 'null'), false],
    [reply(200, '"enabled"'), false],
    [reply(200, '{"enabled":true}', { redirected: true }), false],
    [reply(503, '', { redirected: true }), false],
    // React Native leaves `redirected` unset: the final URL decides.
    [reply(200, '{"enabled":true}', { redirected: undefined, url: 'https://other.example/p/policy' }), false],
    [reply(200, '{"enabled":true}', { redirected: undefined, url: 'https://bora.example/p/other' }), false],
    [reply(200, '{"enabled":true}', { redirected: undefined, url: 'https://bora.example/p/policy?x=1' }), false],
    [reply(200, '{"enabled":true}', { redirected: undefined, url: 'https://u@bora.example/p/policy' }), false],
    [reply(200, '{"enabled":true}', { redirected: undefined, url: 'not a url' }), false],
    [reply(200, '{"enabled":true}', { redirected: undefined, url: 'https://bora.example/p/policy' }), true],
    [reply(200, '{"enabled":true}', { redirected: undefined, url: '' }), true]
  ]
  for (const [res, expected] of cases) {
    forgetPostPublicPolicy()
    const calls = stubFetch(t, res)
    t.is(await postPublicEnabled(origin), expected, res.status + ' ' + JSON.stringify(res.redirected) + ' ' + JSON.stringify(await res.text()))
    t.is(calls.length, 1)
    t.is(calls[0].url, origin + '/p/policy')
    const init = calls[0].init
    t.is(init.credentials, 'omit')
    t.absent('cache' in init, 'no cache option: React Native would add a query')
    t.is(init.method, 'GET')
    t.absent('headers' in init, 'no custom header')
    t.absent('body' in init)
    t.ok(init.signal && typeof init.signal.aborted === 'boolean', 'a deadline signal')
  }
  forgetPostPublicPolicy()
})

test('a network error is false and not cached; a definite answer is cached per origin', async (t) => {
  const { postPublicEnabled, forgetPostPublicPolicy } = await loadPolicy()
  forgetPostPublicPolicy()
  const a = 'https://a.example'
  const b = 'https://b.example'
  let mode = 'down'
  const calls = stubFetch(t, (url) => {
    if (mode === 'down') throw new TypeError('Failed to fetch')
    if (mode === 'body') return { status: 200, redirected: false, text: async () => { throw new TypeError('network lost') } }
    if (mode === 'busy') return reply(503, '')
    if (mode === 'limited') return reply(429, '')
    if (mode === 'slow') return reply(408, '')
    return url.startsWith(a) ? reply(200, '{"enabled":true}') : reply(404, 'nope')
  })
  t.is(await postPublicEnabled(a), false, 'network error')
  t.is(calls.length, 1, 'one request per call, no retry')
  mode = 'body'
  t.is(await postPublicEnabled(a), false, 'body lost')
  mode = 'busy'
  t.is(await postPublicEnabled(a), false, 'server error')
  mode = 'limited'
  t.is(await postPublicEnabled(a), false, 'rate limited')
  mode = 'slow'
  t.is(await postPublicEnabled(a), false, 'request timeout')
  t.is(calls.length, 5, 'none of these were cached')
  mode = 'up'
  t.is(await postPublicEnabled(a), true)
  t.is(await postPublicEnabled(a), true)
  t.is(calls.length, 6, 'true is cached')
  t.is(await postPublicEnabled(b), false)
  t.is(await postPublicEnabled(b), false)
  t.is(calls.length, 7, 'false is cached, per origin')
  t.is(calls[6].url, b + '/p/policy')
  forgetPostPublicPolicy()
  t.is(await postPublicEnabled(a), true)
  t.is(calls.length, 8, 'forgotten after a reset')
  forgetPostPublicPolicy()
})

test('callers asking at once share one request', async (t) => {
  const { postPublicEnabled, forgetPostPublicPolicy } = await loadPolicy()
  forgetPostPublicPolicy()
  const calls = stubFetch(t, reply(200, '{"enabled":true}'))
  const answers = await Promise.all([postPublicEnabled('https://c.example'), postPublicEnabled('https://c.example')])
  t.alike(answers, [true, true])
  t.is(calls.length, 1)
  forgetPostPublicPolicy()
})

test('the probe asks the installation through resolveUrl and refuses other origins', async (t) => {
  const { postPublicEnabled, policyUrl, forgetPostPublicPolicy } = await loadPolicy()
  const { setInstallation } = await loadInstallation()
  forgetPostPublicPolicy()
  t.teardown(() => setInstallation(null))
  const calls = stubFetch(t, reply(200, '{"enabled":true}'))
  setInstallation(null)
  t.is(policyUrl(null), '/p/policy', 'the hosted web app asks its own origin')
  t.is(await postPublicEnabled(null), true)
  t.is(calls[0].url, '/p/policy')
  t.ok(setInstallation('https://bora.example'))
  t.is(policyUrl('https://bora.example'), 'https://bora.example/p/policy')
  t.is(policyUrl('http://localhost:8080'), 'http://localhost:8080/p/policy')
  for (const bad of [undefined, '', 'bora.example', 'http://bora.example', 'https://bora.example/', 'https://bora.example/x', 'https://Bora.example', 'https://u@bora.example', 'https://bora.example?x=1', 'https://bora.example:443', 'ftp://bora.example', 'javascript:alert(1)', 42]) {
    t.is(policyUrl(bad), null, 'refused ' + String(bad))
    t.is(await postPublicEnabled(bad), false)
  }
  t.is(calls.length, 1, 'a refused origin sends nothing')
  forgetPostPublicPolicy()
})

test('a relative probe judges the final path, not the origin', async (t) => {
  const { postPublicEnabled, forgetPostPublicPolicy } = await loadPolicy()
  const { setInstallation } = await loadInstallation()
  t.teardown(() => { setInstallation(null); forgetPostPublicPolicy() })
  setInstallation(null)
  forgetPostPublicPolicy()
  stubFetch(t, reply(200, '{"enabled":true}', { redirected: undefined, url: 'http://localhost:8090/p/policy' }))
  t.is(await postPublicEnabled(null), true, 'the page origin answered itself')
  forgetPostPublicPolicy()
  stubFetch(t, reply(200, '{"enabled":true}', { redirected: undefined, url: 'http://localhost:8090/entrar' }))
  t.is(await postPublicEnabled(null), false, 'another path is a redirect')
})

test('a React Native fetch keeps an enabled answer', async (t) => {
  const { postPublicEnabled, forgetPostPublicPolicy } = await loadPolicy()
  t.teardown(forgetPostPublicPolicy)
  forgetPostPublicPolicy()
  // whatwg-fetch: a no-store or no-cache GET gains ?_=<time>, and the
  // response URL keeps it; `redirected` stays unset.
  stubFetch(t, (url, init) => {
    const sent = init && (init.cache === 'no-store' || init.cache === 'no-cache') ? url + '?_=1763076000000' : url
    return reply(200, '{"enabled":true}', { redirected: undefined, url: sent })
  })
  t.is(await postPublicEnabled('https://bora.example'), true)
})

test('sheet source: consent, sent wording, share on its own tap, no em dash or Platform.OS', (t) => {
  const sheet = read('ui/PostShareSheet.js')
  t.ok(sheet.includes("'Qualquer pessoa na web vai poder ver esta publicação, mesmo sem conta, e quem conhece o seu perfil pode encontrá-la. Você pode desfazer quando quiser. Cópias que outras pessoas já fizeram ficam fora do nosso alcance.'"), 'the consent sentence')
  t.ok(sheet.includes("'Enviado para a web. Se o link ainda não mostrar a publicação, tente de novo em instantes.'"), 'publishing says sent')
  t.ok(sheet.includes("'Pedido enviado para tirar da web. Cópias já feitas ficam fora do nosso alcance.'"), 'withdrawing says sent')
  t.ok(sheet.includes("'Página pública na web'"))
  t.ok(sheet.includes("'Esta publicação está liberada na web para qualquer pessoa, mesmo sem conta.'"), 'the on line names the permission, not what the seeder shows')
  t.absent(/visível/i.test(sheet), 'never says visible: post.shared reads the local diary')
  for (const label of ['Publicar na web', 'Compartilhar', 'Copiar link', 'Tirar da web']) t.ok(sheet.includes("label='" + label + "'"), label)
  t.absent(/confirmad|garantid|já está na web/i.test(sheet), 'never claims the server confirmed it')
  t.ok(sheet.includes("if (r.state === 'on') setView({ phase: 'on', note: POST_SHARE_SENT, error: '' })"), 'a publish lands on the sent note')
  t.ok(sheet.includes('{view.note !== POST_SHARE_SENT ? <Soft>{POST_SHARE_ON}</Soft> : null}'), 'right after a publish the sheet never says visible')
  t.is(sheet.split('{POST_SHARE_ON}').length, 2, 'the visible line is drawn in one place only')
  t.ok(sheet.includes("from './Sheet'"), 'built on ui/Sheet.js')
  // The share and copy handlers call the adapter before any await, and the
  // publish path never opens a share dialog.
  const handlers = sheet.slice(sheet.indexOf('const copy = '), sheet.indexOf('<Sheet '))
  t.ok(handlers.includes('copyText(nav, link)') && handlers.includes('shareUrl(nav, '))
  t.absent(/\basync\b|\bawait\b/.test(handlers), 'no await before the adapter')
  const writer = sheet.slice(sheet.indexOf('const write = '), sheet.indexOf('const nav = '))
  t.ok(writer.length > 0)
  t.absent(/shareUrl|copyText/.test(writer), 'publishing never shares')
  for (const file of ['ui/PostShareSheet.js', 'postShare.js', 'postPublicPolicy.js', 'postPublicContext.js']) {
    const src = read(file)
    t.absent(src.includes(String.fromCharCode(0x2014)), file + ': no em dash')
    t.absent(src.includes('Platform.OS'), file + ': no Platform.OS')
    t.absent(/\b(?:window|document|navigator|localStorage|sessionStorage)\./.test(src), file + ': no browser API')
  }
  for (const file of ['postShare.js', 'postPublicPolicy.js']) {
    const imports = read(file).split('\n').filter((line) => line.startsWith('import '))
    t.absent(imports.some((line) => /react|node:|'fs'|'path'/.test(line)), file + ' stays pure')
  }
  t.absent(read('postShare.js').includes('import '), 'postShare.js takes its call, imports nothing')
})

test('context source: a failed probe is asked again when the app is back online or in view', (t) => {
  const src = read('postPublicContext.js')
  t.ok(src.includes('}, [hosted, origin, awake])'), 'the probe effect re-runs when awake changes')
  t.ok(src.includes('if (hosted !== true || awake !== true) return'), 'nothing is asked while asleep')
  t.ok(src.includes('usePostPublicEnabled(hosted, where, online !== false && visible !== false)'), 'the provider passes online and visible')
})
