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

test('native store is inert', async (t) => {
  const n = await loadNative()
  t.is(n.captureSignupInvite(), null)
  t.is(n.loadSignupInvite(), null)
  t.is(n.dropSignupInvite(), false)
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
