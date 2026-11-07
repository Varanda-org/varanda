'use strict'

// The signup invite helpers (src/signupInvite.js) and the native store. ES
// modules loaded through import(); storage, location and history are
// in-memory fakes.
const test = require('brittle')

const load = () => import('../src/signupInvite.js')
const loadNative = () => import('../src/signupInviteStore.native.js')
const CODE = 'aB3_-'.repeat(8) + 'xyz'
const CODE2 = 'Z'.repeat(43)
const NOW = 1_800_000_000_000
const KEY = 'varanda-signup-invite'

function memoryStorage (initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

const throwingStorage = () => ({
  getItem () { throw new Error('denied') },
  setItem () { throw new Error('denied') },
  removeItem () { throw new Error('denied') }
})

function fakeBrowser (pathname, search = '', hash = '', state = { idx: 3 }) {
  const calls = []
  const location = { pathname, search, hash }
  const history = {
    state,
    replaceState (s, title, url) { calls.push({ s, title, url }) }
  }
  return { location, history, calls }
}

const raw = (o) => JSON.stringify(o)
const stored = (code = CODE2, at = NOW) => memoryStorage({ [KEY]: raw({ v: 1, code, at }), other: 'x' })

test('constants: the key, the TTL and the code shape', async (t) => {
  const m = await load()
  t.is(m.SIGNUP_INVITE_KEY, KEY)
  t.is(m.SIGNUP_INVITE_TTL_MS, 24 * 3600000)
  t.is(CODE.length, 43)
  t.ok(m.CODE_RE.test(CODE))
  t.absent(m.CODE_RE.test(CODE.slice(1)))
})

test('no export name collides with profileLink.js', async (t) => {
  const mine = Object.keys(await load())
  const theirs = new Set(Object.keys(await import('../src/profileLink.js')))
  for (const k of mine) t.absent(theirs.has(k), k)
})

test('parseSignupInvitePath accepts the strict shape only', async (t) => {
  const { parseSignupInvitePath, isSignupInvitePath } = await load()
  t.is(parseSignupInvitePath('/convite/' + CODE), CODE)
  t.is(parseSignupInvitePath('/convite/' + CODE + '/'), CODE)
  const bad = [
    null, 5, '', '/', '/convite', '/convite/', '/convite/abc', '/convite/' + CODE + 'a',
    '/convite/' + CODE + '/x', '/convite//' + CODE, '//convite/' + CODE, '/convite/' + CODE.slice(2) + '%41',
    '/convite/' + CODE.slice(1) + '.', '/Convite/' + CODE, '/convite/' + CODE + '/'.repeat(40)
  ]
  for (const p of bad) t.is(parseSignupInvitePath(p), null, String(p))
  t.ok(isSignupInvitePath('/convite'))
  t.ok(isSignupInvitePath('/convite/'))
  t.ok(isSignupInvitePath('/convite/abc'))
  t.absent(isSignupInvitePath('/convitex'))
  t.absent(isSignupInvitePath('/convites'))
  t.absent(isSignupInvitePath('/convite-x'))
  t.absent(isSignupInvitePath('/'))
  t.absent(isSignupInvitePath('/@ana'))
  t.absent(isSignupInvitePath(null))
})

test('capture: look-alike paths are not invite paths', async (t) => {
  const { captureSignupInvite } = await load()
  for (const p of ['/convites', '/convitex', '/convite-x']) {
    const storage = stored()
    const before = storage.map.get(KEY)
    const b = fakeBrowser(p, '?q=1')
    t.alike(captureSignupInvite({ ...b, storage, now: NOW }), { v: 1, code: CODE2, at: NOW }, p)
    t.is(storage.map.get(KEY), before, p)
    t.is(b.calls.length, 0, p)
  }
  for (const p of ['/convite', '/convite/abc']) {
    const storage = stored()
    const b = fakeBrowser(p, '?q=1')
    t.is(captureSignupInvite({ ...b, storage, now: NOW }), null, p)
    t.absent(storage.map.has(KEY), p)
    t.alike(b.calls.map((c) => c.url), ['/?q=1'], p)
  }
})

test('capture: a valid path stores a fresh record and rewrites to / keeping search and hash', async (t) => {
  const { captureSignupInvite } = await load()
  const storage = stored()
  const b = fakeBrowser('/convite/' + CODE, '?conta=ok&x=%20', '#token=abc')
  const rec = captureSignupInvite({ ...b, storage, now: NOW })
  t.alike(rec, { v: 1, code: CODE, at: NOW })
  t.ok(Object.isFrozen(rec))
  t.alike(JSON.parse(storage.map.get(KEY)), { v: 1, code: CODE, at: NOW })
  t.is(storage.map.get('other'), 'x')
  t.alike(b.calls, [{ s: { idx: 3 }, title: '', url: '/?conta=ok&x=%20#token=abc' }])
})

test('capture: invalid /convite paths clear an older code and still rewrite', async (t) => {
  const { captureSignupInvite } = await load()
  for (const p of ['/convite', '/convite/abc', '/convite/' + CODE + '/x', '/convite/%41' + CODE.slice(3), '/convite//' + CODE]) {
    const storage = stored()
    const b = fakeBrowser(p, '?q=1', '#h')
    t.is(captureSignupInvite({ ...b, storage, now: NOW }), null, p)
    t.absent(storage.map.has(KEY), p)
    t.alike(b.calls.map((c) => c.url), ['/?q=1#h'], p)
  }
})

test('capture: other paths never write or clear and keep the code', async (t) => {
  const { captureSignupInvite } = await load()
  for (const p of ['/@ana', '/', '/m/' + 'ab'.repeat(32)]) {
    const storage = stored()
    const before = storage.map.get(KEY)
    const b = fakeBrowser(p, '?conta=ok')
    t.alike(captureSignupInvite({ ...b, storage, now: NOW + 1000 }), { v: 1, code: CODE2, at: NOW }, p)
    t.is(storage.map.get(KEY), before, p)
    t.is(b.calls.length, 0, p)
  }
  const empty = memoryStorage()
  t.is(captureSignupInvite({ ...fakeBrowser('/'), storage: empty, now: NOW }), null)
  t.is(empty.map.size, 0)
})

test('capture: throwing storage still returns the record and cleans the path', async (t) => {
  const { captureSignupInvite } = await load()
  const b = fakeBrowser('/convite/' + CODE, '?a=1')
  t.alike(captureSignupInvite({ ...b, storage: throwingStorage(), now: NOW }), { v: 1, code: CODE, at: NOW })
  t.alike(b.calls.map((c) => c.url), ['/?a=1'])
  const b2 = fakeBrowser('/convite/' + CODE)
  t.alike(captureSignupInvite({ ...b2, storage: null, now: NOW }), { v: 1, code: CODE, at: NOW })
  t.is(captureSignupInvite({ ...fakeBrowser('/'), storage: throwingStorage(), now: NOW }), null)
})

test('capture: a throwing replaceState does not lose the record', async (t) => {
  const { captureSignupInvite } = await load()
  const storage = memoryStorage()
  const location = { pathname: '/convite/' + CODE, search: '', hash: '' }
  const history = { state: null, replaceState () { throw new Error('sandboxed') } }
  t.alike(captureSignupInvite({ location, history, storage, now: NOW }), { v: 1, code: CODE, at: NOW })
  t.ok(storage.map.has(KEY))
  t.is(captureSignupInvite(), null)
})

test('decode: TTL, future skew and shape', async (t) => {
  const { decodeSignupInvite, SIGNUP_INVITE_TTL_MS } = await load()
  const ok = { v: 1, code: CODE, at: NOW }
  t.alike(decodeSignupInvite(raw(ok), NOW), ok)
  t.alike(decodeSignupInvite(ok, NOW), ok, 'an in-memory record')
  t.alike(decodeSignupInvite(raw(ok), NOW + SIGNUP_INVITE_TTL_MS), ok)
  t.is(decodeSignupInvite(raw(ok), NOW + SIGNUP_INVITE_TTL_MS + 1), null, 'expired')
  t.alike(decodeSignupInvite(raw(ok), NOW - 60000), ok)
  t.is(decodeSignupInvite(raw(ok), NOW - 60001), null, 'too far in the future')
  const extra = decodeSignupInvite('{"v":1,"code":"' + CODE + '","at":' + NOW + ',"__proto__":{"x":1},"y":2}', NOW)
  t.alike(Object.keys(extra), ['v', 'code', 'at'])
  t.is(extra.x, undefined)
  const bad = [
    null, 5, '', 'nope', '[]', raw({ ...ok, v: 2 }), raw({ ...ok, code: 'abc' }), raw({ ...ok, code: 5 }),
    raw({ ...ok, at: 1.5 }), raw({ ...ok, at: String(NOW) }), raw({ code: CODE, at: NOW }), 'x'.repeat(600)
  ]
  for (const r of bad) t.is(decodeSignupInvite(r, NOW), null, String(r).slice(0, 40))
})

test('read/write/clear guard storage', async (t) => {
  const { readSignupInvite, writeSignupInvite, clearSignupInvite } = await load()
  const s = memoryStorage()
  const rec = { v: 1, code: CODE, at: NOW }
  t.ok(writeSignupInvite(s, rec))
  t.alike(readSignupInvite(s, NOW), rec)
  t.ok(clearSignupInvite(s))
  t.is(readSignupInvite(s, NOW), null)
  const junk = memoryStorage({ [KEY]: 'junk' })
  t.is(readSignupInvite(junk, NOW), null)
  t.absent(junk.map.has(KEY), 'a doubtful record is removed')
  for (const st of [null, undefined, throwingStorage()]) {
    t.is(readSignupInvite(st, NOW), null)
    t.is(writeSignupInvite(st, rec), false)
    t.is(clearSignupInvite(st), false)
  }
  t.is(writeSignupInvite(s, null), false)
})

test('holder: falls back to the in-memory record when storage refuses', async (t) => {
  const { createSignupInviteHolder, SIGNUP_INVITE_TTL_MS } = await load()
  let now = NOW
  const h = createSignupInviteHolder({ getStorage: throwingStorage, now: () => now })
  t.alike(h.capture(fakeBrowser('/convite/' + CODE)), { v: 1, code: CODE, at: NOW })
  t.alike(h.load(), { v: 1, code: CODE, at: NOW }, 'after the path is cleaned')
  now = NOW + SIGNUP_INVITE_TTL_MS + 1
  t.is(h.load(), null, 'the in-memory copy expires too')
  now = NOW
  h.capture(fakeBrowser('/convite/' + CODE))
  t.is(h.drop(), false)
  t.is(h.load(), null, 'drop clears memory as well')
  const gone = createSignupInviteHolder({ getStorage () { throw new Error('denied') }, now: () => NOW })
  t.alike(gone.capture(fakeBrowser('/convite/' + CODE)), { v: 1, code: CODE, at: NOW })
  t.alike(gone.load(), { v: 1, code: CODE, at: NOW })
})

test('holder: a second capture on the cleaned path keeps the in-memory record', async (t) => {
  const { createSignupInviteHolder } = await load()
  const location = { pathname: '/convite/' + CODE, search: '?a=1', hash: '' }
  const history = {
    state: null,
    replaceState (s, title, url) { location.pathname = url.split(/[?#]/)[0] }
  }
  const h = createSignupInviteHolder({ getStorage: throwingStorage, now: () => NOW })
  t.alike(h.capture({ location, history }), { v: 1, code: CODE, at: NOW })
  t.is(location.pathname, '/')
  t.alike(h.capture({ location, history }), { v: 1, code: CODE, at: NOW })
  t.alike(h.load(), { v: 1, code: CODE, at: NOW })
})

test('holder: storage wins and drop clears it', async (t) => {
  const { createSignupInviteHolder } = await load()
  const s = memoryStorage()
  const h = createSignupInviteHolder({ getStorage: () => s, now: () => NOW })
  h.capture(fakeBrowser('/convite/' + CODE))
  s.map.set(KEY, raw({ v: 1, code: CODE2, at: NOW }))
  t.alike(h.load(), { v: 1, code: CODE2, at: NOW })
  t.ok(h.drop())
  t.absent(s.map.has(KEY))
  t.is(h.load(), null)
})

test('native store: varanda:/// and installation links, paste, session memory', async (t) => {
  const n = await loadNative()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => { setInstallation(null); n.dropSignupInvite() })
  t.is(n.captureSignupInvite(), null, 'nothing held at start')
  t.is(n.loadSignupInvite(), null)
  t.is(n.captureSignupInvite('varanda://convite/' + CODE), null, 'a host form is refused')
  t.is(n.captureSignupInvite('varanda:///@ana'), null, 'a profile link is not an invite')
  t.is(n.loadSignupInvite(), null)
  const rec = n.captureSignupInvite('varanda:///convite/' + CODE)
  t.is(rec.code, CODE)
  t.is(n.loadSignupInvite().code, CODE)
  t.is(n.captureSignupInvite().code, CODE, 'the import-time capture reads the held code')
  t.is(n.captureSignupInvite('varanda://conta?conta=ok'), null, 'other URLs change nothing')
  t.is(n.loadSignupInvite().code, CODE)
  t.is(n.captureSignupInvite('https://varanda.example/convite/' + CODE2), null, 'no installation yet')
  t.ok(setInstallation('https://varanda.example'))
  t.is(n.captureSignupInvite('https://evil.example/convite/' + CODE2), null)
  t.is(n.captureSignupInvite('https://varanda.example/convite/' + CODE2).code, CODE2, 'a newer link wins')
  t.is(n.loadSignupInvite().code, CODE2)
  t.is(n.captureSignupInvite(CODE), null, 'a bare code only through the paste field')
  t.is(n.captureSignupInvite(' ' + CODE + ' ', { paste: true }).code, CODE)
  t.is(n.captureSignupInvite('nope', { paste: true }), null)
  t.is(n.loadSignupInvite().code, CODE)
  t.ok(n.dropSignupInvite())
  t.is(n.loadSignupInvite(), null)
})

test('buildSignupInviteUrl follows the service origin rules', async (t) => {
  const { buildSignupInviteUrl, parseSignupInvitePath } = await load()
  const u = buildSignupInviteUrl({ origin: 'https://varanda.example', code: CODE })
  t.is(u, 'https://varanda.example/convite/' + CODE)
  t.is(parseSignupInvitePath(new URL(u).pathname), CODE)
  t.is(buildSignupInviteUrl({ origin: 'https://x.example:8443', code: CODE }), 'https://x.example:8443/convite/' + CODE)
  t.is(buildSignupInviteUrl({ origin: 'http://127.0.0.1:8790', code: CODE }), 'http://127.0.0.1:8790/convite/' + CODE)
  for (const origin of ['http://localhost', 'http://localhost:8790', 'https://x.example/', 'https://x.example/app', 'http://x.example', 'https://X.example', 'https://u@x.example', null]) {
    t.is(buildSignupInviteUrl({ origin, code: CODE }), null, String(origin))
  }
  t.is(buildSignupInviteUrl({ origin: 'https://x.example', code: CODE.slice(1) }), null, 'short code')
  t.is(buildSignupInviteUrl({ origin: 'https://x.example', code: null }), null)
  t.is(buildSignupInviteUrl(), null)
})

test('texts and the weekly count', async (t) => {
  const m = await load()
  const account = await import('../src/account.js')
  t.is(m.INVITE_NEEDED_TEXT, 'Para entrar, abra o link de convite que alguém da rede te enviou. Nada sobre você fica guardado enquanto o convite não for usado.')
  t.is(m.INVITE_NEEDED_TEXT, account.toError('convite-obrigatorio').message)
  t.is(m.INVITE_READY_TEXT, 'Convite pronto para usar.')
  t.is(m.INVITE_VALID_TEXT, 'Esse link serve para uma pessoa só e vale 7 dias. Nada sobre quem recebe o link fica guardado.')
  t.is(m.WEEK_RESET_TEXT, 'Os convites renovam toda segunda-feira, no horário de Brasília, e os que sobram não acumulam.')
  t.is(m.inviteCountText({ used: 1, remaining: 4, perWeek: 5 }), 'Restam 4 de 5 convites nesta semana.')
  t.is(m.inviteCountText({ used: 4, remaining: 1, perWeek: 5 }), 'Resta 1 de 5 convites nesta semana.')
  t.is(m.inviteCountText({ used: 0, remaining: 1, perWeek: 1 }), 'Resta 1 de 1 convite nesta semana.')
  t.is(m.inviteCountText({ used: 5, remaining: 0, perWeek: 5 }), 'Seus convites desta semana acabaram.')
  t.is(m.inviteCountText({ remaining: 6, perWeek: 5 }), '')
  t.is(m.inviteCountText({ remaining: -1, perWeek: 5 }), '')
  t.is(m.inviteCountText(), '')
  t.is(m.allowanceText(5), 'Você pode criar até 5 convites por semana.')
  t.is(m.allowanceText(1), 'Você pode criar até 1 convite por semana.')
  t.is(m.allowanceText(100), 'Você pode criar até 100 convites por semana.')
  for (const bad of [0, 101, -1, 1.5, '5', null, undefined, NaN]) t.is(m.allowanceText(bad), '', String(bad))
  t.absent(m.allowanceText(3).includes(String.fromCharCode(0x2014)))
  for (const k of ['INVITE_NEEDED_TEXT', 'INVITE_READY_TEXT', 'INVITE_VALID_TEXT', 'WEEK_RESET_TEXT']) {
    t.absent(m[k].includes(String.fromCharCode(0x2014)), k)
  }
})

test('invite drop texts are the approved Portuguese', async (t) => {
  const m = await load()
  t.is(m.INVITE_DROP_TITLE, 'Chegou um convite pra sua varanda')
  t.is(m.INVITE_DROP_BODY, 'Escolha com carinho quem você quer chamar: alguém próximo, que faz falta na conversa.')
  t.is(m.DROPS_HINT_TEXT, 'Os convites chegam de surpresa, um de cada vez, com um aviso. Escolha com carinho quem você quer chamar.')
  for (const key of ['INVITE_DROP_TITLE', 'INVITE_DROP_BODY', 'DROPS_HINT_TEXT']) {
    t.absent(m[key].includes('\u2014'), key)
  }
})

test('dropView: weekly counts and surprise drops without promising another slot this week', async (t) => {
  const { dropView } = await load()
  const cases = [
    ['semanal', 5, 1, 4, 5, 'Restam 4 de 5 convites nesta semana.', true],
    ['semanal', 5, 4, 1, 5, 'Resta 1 de 5 convites nesta semana.', true],
    ['semanal', 1, 0, 1, 1, 'Resta 1 de 1 convite nesta semana.', true],
    ['semanal', 5, 5, 0, 5, 'Seus convites desta semana acabaram.', false],
    ['semanal', 1, 6, 0, 1, 'Seus convites desta semana acabaram.', false],
    ['sorteio', 0, 0, 0, 5, 'Seu convite desta semana ainda não chegou. Ele aparece de surpresa, com um aviso.', false],
    ['sorteio', 1, 0, 1, 5, 'Você tem 1 convite para usar até o fim da semana.', true],
    ['sorteio', 3, 1, 2, 5, 'Você tem 2 convites para usar até o fim da semana.', true],
    ['sorteio', 5, 0, 5, 5, 'Você tem 5 convites para usar até o fim da semana.', true],
    ['sorteio', 1, 1, 0, 5, 'O próximo convite chega de surpresa.', false],
    ['sorteio', 5, 5, 0, 5, 'O próximo convite chega de surpresa.', false],
    ['sorteio', 1, 6, 0, 1, 'O próximo convite chega de surpresa.', false],
    ['sorteio', 1, Number.MAX_SAFE_INTEGER, 0, 1, 'O próximo convite chega de surpresa.', false]
  ]
  for (const [mode, opened, used, remaining, perWeek, text, enabled] of cases) {
    const input = { mode, opened, used, remaining, perWeek }
    t.alike(dropView(input), { text, enabled }, JSON.stringify(input))
    t.absent(dropView(input).text.includes('\u2014'))
  }
})

test('dropView: doubtful counts and modes produce no text and stay disabled', async (t) => {
  const { dropView } = await load()
  const summary = { mode: 'sorteio', opened: 2, used: 1, remaining: 1, perWeek: 5 }
  const empty = { text: '', enabled: false }
  t.alike(dropView(), empty)
  t.alike(dropView({ ...summary, mode: 'x' }), empty)
  t.alike(dropView({ mode: 'semanal', opened: 2, used: 1, remaining: 1, perWeek: 5 }), empty, 'the weekly mode opens the whole allowance')
  for (const mode of ['semanal', 'sorteio']) {
    for (const [key, values] of Object.entries({
      opened: [undefined, -1, 6, 1.5, '2', null, NaN, Infinity],
      used: [undefined, -1, 1.5, '1', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1],
      remaining: [undefined, -1, 0, 3, 1.5, '1', null, NaN, Infinity],
      perWeek: [undefined, 0, 101, -1, 1.5, '5', null, NaN, Infinity]
    })) {
      for (const value of values) t.alike(dropView({ ...summary, mode, [key]: value }), empty, mode + ': ' + key + '=' + value)
    }
  }
})

const rpc = require('@varanda/rpc')
const CARD_KEY = 'varanda-signup-invite-card'
const ORIGIN = 'https://varanda.example'

function cardUrl ({ origin = ORIGIN, code = CODE, design = 'cordel', message = 'Vem pra varanda!' } = {}) {
  return rpc.buildInviteCardUrl({
    origin, code, design, name: 'Ana', message, expires: 2_000_000_000, member: 'ab'.repeat(32), signature: 'cd'.repeat(64)
  })
}
const cardBody = (url) => url.slice(url.indexOf('#c1.') + 4)
const cardQuery = (url) => url.slice(url.indexOf('?'), url.indexOf('#'))

test('card: a plain /convite path stores only the code and keeps #token= byte for byte', async (t) => {
  const { captureSignupInvite } = await load()
  const storage = memoryStorage({ [CARD_KEY]: raw({ v: 1, code: CODE2, body: 'x', at: NOW }) })
  const b = fakeBrowser('/convite/' + CODE, '?conta=ok', '#token=a%20b&x=1')
  t.alike(captureSignupInvite({ ...b, storage, now: NOW, origin: ORIGIN }), { v: 1, code: CODE, at: NOW })
  t.absent(storage.map.has(CARD_KEY), 'a new /convite path clears the previous card')
  t.alike(b.calls.map((c) => c.url), ['/?conta=ok#token=a%20b&x=1'])
})

test('card: a #c1. card is stored bound to its code and leaves the address bar in the same pass', async (t) => {
  const { createSignupInviteHolder, decodeSignupInviteCard } = await load()
  const url = cardUrl()
  const body = cardBody(url)
  const s = memoryStorage()
  const h = createSignupInviteHolder({ getStorage: () => s, now: () => NOW })
  const location = { pathname: '/convite/' + CODE, search: cardQuery(url) + '&conta=ok', hash: '#c1.' + body + '&token=abc' }
  const urls = []
  const history = {
    state: null,
    replaceState (st, title, u) {
      urls.push(u)
      t.ok(s.map.has(CARD_KEY), 'stored before the bar changes')
    }
  }
  t.alike(h.capture({ location, history, origin: ORIGIN }), { v: 1, code: CODE, at: NOW })
  t.alike(urls, ['/?conta=ok#token=abc'])
  t.absent(urls[0].includes('c='), 'no ?c left')
  t.absent(urls[0].includes('#c1.'), 'no card fragment left')
  t.alike(JSON.parse(s.map.get(CARD_KEY)), { v: 1, code: CODE, body, at: NOW })
  const card = h.loadCard()
  t.alike(card, { v: 1, code: CODE, body, at: NOW })
  t.ok(Object.isFrozen(card))
  t.alike(decodeSignupInviteCard(s.map.get(CARD_KEY), NOW), card)
  t.ok(h.drop())
  t.alike(h.loadCard(), card, 'drop() keeps the card')
  t.ok(h.dropCard())
  t.is(h.loadCard(), null)
})

test('card: a short origin may carry a body longer than 320 characters', async (t) => {
  const { createSignupInviteHolder, decodeSignupInviteCard } = await load()
  const origin = 'https://v.test'
  const room = rpc.messageRoom({ origin, code: CODE, design: 'cordel', name: 'Ana', expires: 2_000_000_000 })
  const url = cardUrl({ origin, message: 'a'.repeat(room) })
  t.is(url.length <= 400, true, 'a valid link')
  const body = cardBody(url)
  t.ok(body.length > 320, 'body longer than the bora.varanda.app room: ' + body.length)
  const s = memoryStorage()
  const h = createSignupInviteHolder({ getStorage: () => s, now: () => NOW })
  const location = { pathname: '/convite/' + CODE, search: cardQuery(url), hash: '#c1.' + body }
  h.capture({ location, history: { state: null, replaceState () {} }, origin })
  t.alike(h.loadCard(), { v: 1, code: CODE, body, at: NOW }, 'stored')
  t.alike(decodeSignupInviteCard(s.map.get(CARD_KEY), NOW), { v: 1, code: CODE, body, at: NOW }, 'decodes')
})

test('card: query and hash cleaning keep the other pieces in order', async (t) => {
  const { captureSignupInvite } = await load()
  const url = cardUrl()
  const piece = '#c1.' + cardBody(url)
  const q = cardQuery(url).slice(1)
  const cases = [
    ['?' + q, piece, '/'],
    ['?a=1&' + q + '&b=%20', piece, '/?a=1&b=%20'],
    ['', piece, '/'],
    ['?' + q, piece + '&token=x&y', '/#token=x&y'],
    ['?a=1', '#token=x', '/?a=1#token=x'],
    ['?' + q + '&c=9', piece, '/']
  ]
  for (const [search, hash, expected] of cases) {
    const b = fakeBrowser('/convite/' + CODE + '/', search, hash)
    captureSignupInvite({ ...b, storage: memoryStorage(), now: NOW, origin: ORIGIN })
    t.alike(b.calls.map((c) => c.url), [expected], search + hash.slice(0, 8))
  }
})

test('card: trailing slash, missing ?c, and a card without a code', async (t) => {
  const { captureSignupInvite } = await load()
  const url = cardUrl()
  const body = cardBody(url)
  const s1 = memoryStorage()
  captureSignupInvite({ ...fakeBrowser('/convite/' + CODE + '/', cardQuery(url), '#c1.' + body), storage: s1, now: NOW, origin: ORIGIN })
  t.is(JSON.parse(s1.map.get(CARD_KEY)).body, body, 'trailing slash')
  const s2 = memoryStorage()
  captureSignupInvite({ ...fakeBrowser('/convite/' + CODE, '', '#c1.' + body), storage: s2, now: NOW, origin: ORIGIN })
  t.is(JSON.parse(s2.map.get(CARD_KEY)).body, body, '?c is optional')
  const s3 = memoryStorage()
  const b3 = fakeBrowser('/convite/abc', cardQuery(url), '#c1.' + body)
  t.is(captureSignupInvite({ ...b3, storage: s3, now: NOW, origin: ORIGIN }), null)
  t.absent(s3.map.has(CARD_KEY), 'no card without a valid code')
  t.alike(b3.calls.map((c) => c.url), ['/'])
})

test('card: a doubtful card never clears a valid code', async (t) => {
  const { captureSignupInvite } = await load()
  const url = cardUrl()
  const body = cardBody(url)
  const index = rpc.designIndex('cordel')
  const bad = [
    ['?c=' + (index + 1), '#c1.' + body, 'a ?c that disagrees with the signed design'],
    ['?c=x', '#c1.' + body, 'a malformed ?c'],
    ['?c=' + index + '&c=' + index, '#c1.' + body, 'a repeated ?c'],
    ['', '#c1.' + body.slice(0, -2), 'a truncated body'],
    ['', '#c1.' + body + '!', 'a stray character'],
    ['', '#c1.' + 'A'.repeat(321), 'an oversized body'],
    ['', '#c1.', 'an empty body']
  ]
  for (const [search, hash, label] of bad) {
    const storage = memoryStorage()
    const b = fakeBrowser('/convite/' + CODE, search, hash)
    t.alike(captureSignupInvite({ ...b, storage, now: NOW, origin: ORIGIN }), { v: 1, code: CODE, at: NOW }, label)
    t.ok(storage.map.has(KEY), label)
    t.absent(storage.map.has(CARD_KEY), label)
    t.absent(b.calls[0].url.includes('c='), label)
    t.absent(b.calls[0].url.includes('#c1.'), label)
  }
  const storage = memoryStorage()
  captureSignupInvite({ ...fakeBrowser('/convite/' + CODE, '', '#c1.' + body), storage, now: NOW, origin: 'http://localhost' })
  t.absent(storage.map.has(CARD_KEY), 'an origin the codec refuses')
})

test('card: decode applies TTL, skew and shape and re-parses the body', async (t) => {
  const { decodeSignupInviteCard, makeCardRecord, SIGNUP_INVITE_TTL_MS, SIGNUP_INVITE_CARD_KEY } = await load()
  t.is(SIGNUP_INVITE_CARD_KEY, CARD_KEY)
  const body = cardBody(cardUrl())
  const ok = { v: 1, code: CODE, body, at: NOW }
  t.alike(makeCardRecord(CODE, body, NOW), ok)
  t.alike(decodeSignupInviteCard(raw(ok), NOW), ok)
  t.alike(decodeSignupInviteCard(ok, NOW), ok, 'an in-memory record')
  t.alike(decodeSignupInviteCard(raw(ok), NOW + SIGNUP_INVITE_TTL_MS), ok)
  t.is(decodeSignupInviteCard(raw(ok), NOW + SIGNUP_INVITE_TTL_MS + 1), null, 'expired')
  t.alike(decodeSignupInviteCard(raw(ok), NOW - 60000), ok)
  t.is(decodeSignupInviteCard(raw(ok), NOW - 60001), null, 'too far in the future')
  const extra = decodeSignupInviteCard(raw({ ...ok, verified: true, y: 2 }), NOW)
  t.alike(Object.keys(extra), ['v', 'code', 'body', 'at'])
  t.is(extra.verified, undefined, 'never a verified flag')
  const bad = [
    null, 'nope', '[]', raw({ ...ok, v: 2 }), raw({ ...ok, code: 'abc' }), raw({ ...ok, body: 5 }),
    raw({ ...ok, body: '' }), raw({ ...ok, body: body.slice(0, -2) }), raw({ ...ok, body: 'A'.repeat(321) }),
    raw({ ...ok, at: 1.5 }), 'x'.repeat(600)
  ]
  for (const r of bad) t.is(decodeSignupInviteCard(r, NOW), null, String(r).slice(0, 40))
})

test('card holder: TTL on every load, memory when storage refuses, keepCard validates', async (t) => {
  const { createSignupInviteHolder, SIGNUP_INVITE_TTL_MS } = await load()
  const url = cardUrl()
  const body = cardBody(url)
  let now = NOW
  const h = createSignupInviteHolder({ getStorage: throwingStorage, now: () => now })
  h.capture({ ...fakeBrowser('/convite/' + CODE, cardQuery(url), '#c1.' + body), origin: ORIGIN })
  t.alike(h.loadCard(), { v: 1, code: CODE, body, at: NOW }, 'kept in memory')
  h.capture(fakeBrowser('/'))
  t.is(h.loadCard().body, body, 'a later capture on / keeps it')
  now = NOW + SIGNUP_INVITE_TTL_MS + 1
  t.is(h.loadCard(), null, 'expires on load')
  now = NOW
  t.is(h.keepCard(CODE, 'junk'), null)
  t.is(h.keepCard('abc', body), null)
  t.is(h.keepCard(CODE, body).body, body)
  h.capture(fakeBrowser('/convite/' + CODE2))
  t.is(h.loadCard(), null, 'a new /convite path clears the previous card')
})

test('native store: varanda:/// and pasted https card links keep both code and card', async (t) => {
  const n = await loadNative()
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => { setInstallation(null); n.dropSignupInvite(); n.dropSignupInviteCard() })
  const url = cardUrl()
  const body = cardBody(url)
  const scheme = 'varanda:///convite/' + CODE + cardQuery(url) + '#c1.' + body
  t.is(n.captureSignupInvite(scheme).code, CODE)
  t.alike(n.loadSignupInviteCard(), { v: 1, code: CODE, body, at: n.loadSignupInviteCard().at })
  t.is(n.captureSignupInvite('varanda:///convite/' + CODE2).code, CODE2)
  t.is(n.loadSignupInviteCard(), null, 'a newer plain link drops the card')
  t.ok(setInstallation(ORIGIN))
  t.is(n.captureSignupInvite('  ' + url + '\n', { paste: true }).code, CODE)
  t.is(n.loadSignupInviteCard().body, body)
  t.is(n.loadSignupInviteCard().code, CODE)
  t.ok(n.dropSignupInvite())
  t.is(n.loadSignupInviteCard().body, body, 'dropping the code keeps the card')
  t.ok(n.dropSignupInviteCard())
  t.is(n.loadSignupInviteCard(), null)
  const long = 'varanda:///convite/' + CODE + '#c1.' + 'A'.repeat(401 - 'varanda:///convite/'.length - 43 - 4)
  t.is(long.length, 401)
  t.is(n.captureSignupInvite(long), null)
  t.is(n.loadSignupInvite(), null, 'a 401-char URL keeps no code')
  t.is(n.loadSignupInviteCard(), null, 'nor a card')
})
