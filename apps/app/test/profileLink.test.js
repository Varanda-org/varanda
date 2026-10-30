'use strict'

// The profile-link helpers (src/profileLink.js). ES module loaded through
// import(); storage, location and history are in-memory fakes.
const test = require('brittle')

const load = () => import('../src/profileLink.js')
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const NOW = 1_800_000_000_000

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
const newRec = (extra = {}) => ({ v: 1, username: 'ana', key: null, state: 'new', recipient: null, at: NOW, ...extra })

test('parseProfilePath accepts usernames and keys', async (t) => {
  const { parseProfilePath } = await load()
  t.alike(parseProfilePath('/@ana'), { username: 'ana' })
  t.alike(parseProfilePath('/@Ana'), { username: 'ana' })
  t.alike(parseProfilePath('/@ana/'), { username: 'ana' })
  t.alike(parseProfilePath('/m/' + A), { key: A })
  t.alike(parseProfilePath('/m/' + A.toUpperCase()), { key: A })
  t.alike(parseProfilePath('/m/' + A + '/'), { key: A })
})

test('parseProfilePath rejects everything else', async (t) => {
  const { parseProfilePath } = await load()
  const bad = [
    null, 5, undefined, '', '/', '/@', '/@an', '/@' + 'a'.repeat(21), '/@@ana', '/@ana%20', '/@%61na',
    '//@ana', '/@ana//', '/@ana/x', '/@../ana', '/@ana\\', '/@ a', '/@ana ', ' /@ana', '/@e905a4',
    '/@1ana', '/@ana-b', '/m/' + A.slice(1), '/m/' + A + '0', '/m/' + A + '/x', '/m//' + A,
    '/m/' + A.slice(2) + 'zz', '/@ana?x=1', '/x/@ana', '/' + 'a'.repeat(80), '/m/' + A + '/'.repeat(20)
  ]
  for (const p of bad) t.is(parseProfilePath(p), null, String(p))
})

test('isProfilePath is a prefix test', async (t) => {
  const { isProfilePath } = await load()
  t.ok(isProfilePath('/@x'))
  t.ok(isProfilePath('/m/zz'))
  t.absent(isProfilePath('/'))
  t.absent(isProfilePath('/mm'))
  t.absent(isProfilePath(null))
})

test('buildProfileUrl prefers the username and round-trips', async (t) => {
  const { buildProfileUrl, parseProfilePath } = await load()
  const origin = 'https://varanda.example'
  const u1 = buildProfileUrl({ origin, username: '@Ana', publicKey: A })
  t.is(u1, origin + '/@ana')
  t.alike(parseProfilePath(new URL(u1).pathname), { username: 'ana' })
  const u2 = buildProfileUrl({ origin, username: null, publicKey: A })
  t.is(u2, origin + '/m/' + A)
  t.alike(parseProfilePath(new URL(u2).pathname), { key: A })
  t.is(buildProfileUrl({ origin: 'https://x.example:8443', username: 'bia' }), 'https://x.example:8443/@bia')
  t.is(buildProfileUrl({ origin, username: 'e905a4', publicKey: 'nope' }), null)
  t.is(buildProfileUrl({ origin, publicKey: A.toUpperCase() }), null)
})

test('buildProfileUrl rejects bad origins', async (t) => {
  const { buildProfileUrl } = await load()
  const bad = [
    'http://varanda.example', 'https://u:p@varanda.example', 'https://varanda.example/app',
    'https://varanda.example/', 'javascript:alert(1)', 'https://varanda.example?x=1', 'not a url', '', null, 5
  ]
  for (const origin of bad) t.is(buildProfileUrl({ origin, username: 'ana', publicKey: A }), null, String(origin))
  t.is(buildProfileUrl(), null)
})

test('encodeInvite / decodeInvite round-trip, frozen, six fields', async (t) => {
  const { encodeInvite, decodeInvite } = await load()
  const rec = decodeInvite(raw({ ...newRec(), extra: 1, ['__proto__']: { polluted: true } }), NOW)
  t.alike(rec, newRec())
  t.ok(Object.isFrozen(rec))
  t.is(rec.polluted, undefined)
  t.is({}.polluted, undefined)
  t.alike(Object.keys(JSON.parse(encodeInvite(rec))), ['v', 'username', 'key', 'state', 'recipient', 'at'])
  t.alike(decodeInvite(encodeInvite(rec), NOW), rec)
  const keyRec = { v: 1, username: null, key: A, state: 'accepted', recipient: B, at: NOW - 1000 }
  t.alike(decodeInvite(raw(keyRec), NOW), keyRec)
})

test('decodeInvite rejects tampered and junk values', async (t) => {
  const { decodeInvite, INVITE_TTL_MS } = await load()
  const bad = {
    notString: 5,
    oversized: raw(newRec({ pad: 'x'.repeat(600) })),
    notJson: '{nope',
    array: '[1]',
    nullJson: 'null',
    number: '42',
    version: raw(newRec({ v: 2 })),
    uppercaseName: raw(newRec({ username: 'Ana' })),
    atName: raw(newRec({ username: '@ana' })),
    twoTargets: raw(newRec({ key: A })),
    noTarget: raw(newRec({ username: null })),
    keyAndUndefinedName: raw({ v: 1, key: A, state: 'new', recipient: null, at: NOW }),
    uppercaseKey: raw(newRec({ username: null, key: A.toUpperCase() })),
    state: raw(newRec({ state: 'followed' })),
    recipientWithoutAccepted: raw(newRec({ recipient: A })),
    acceptedWithoutRecipient: raw(newRec({ state: 'accepted' })),
    acceptedBadRecipient: raw(newRec({ state: 'accepted', recipient: 'x' })),
    atString: raw(newRec({ at: String(NOW) })),
    atFloat: raw(newRec({ at: NOW + 0.5 })),
    future: raw(newRec({ at: NOW + 60001 })),
    expired: raw(newRec({ at: NOW - INVITE_TTL_MS - 1 })),
    followStyle: raw({ op: 'follow.add', key: A }),
    followStyle2: raw({ v: 1, follow: A, state: 'accepted', recipient: A, at: NOW })
  }
  for (const [name, value] of Object.entries(bad)) t.is(decodeInvite(value, NOW), null, name)
  t.ok(decodeInvite(raw(newRec({ at: NOW + 60000 })), NOW), 'small skew ok')
  t.ok(decodeInvite(raw(newRec({ at: NOW - INVITE_TTL_MS })), NOW), 'ttl edge ok')
})

test('readInvite / writeInvite / clearInvite never throw', async (t) => {
  const { readInvite, writeInvite, clearInvite, decodeInvite, INVITE_KEY } = await load()
  const s = memoryStorage()
  t.is(readInvite(s, NOW), null)
  const rec = decodeInvite(raw(newRec()), NOW)
  t.is(writeInvite(s, rec), true)
  t.alike(readInvite(s, NOW), rec)
  t.is(clearInvite(s), true)
  t.is(s.map.has(INVITE_KEY), false)

  s.setItem(INVITE_KEY, 'junk')
  t.is(readInvite(s, NOW), null)
  t.is(s.map.has(INVITE_KEY), false, 'invalid value removed')

  t.is(readInvite(null, NOW), null)
  t.is(writeInvite(null, rec), false)
  t.is(clearInvite(null), false)
  t.is(readInvite(throwingStorage(), NOW), null)
  t.is(writeInvite(throwingStorage(), rec), false)
  t.is(clearInvite(throwingStorage()), false)
})

test('captureInvite stores a fresh invite and cleans the path', async (t) => {
  const { captureInvite, INVITE_KEY } = await load()
  const s = memoryStorage()
  const b = fakeBrowser('/@Ana', '?conta=ok', '#token=x')
  const rec = captureInvite({ ...b, storage: s, now: NOW })
  t.alike(rec, newRec())
  t.ok(Object.isFrozen(rec))
  t.alike(b.calls, [{ s: { idx: 3 }, title: '', url: '/?conta=ok#token=x' }])
  t.is(b.calls[0].s, b.history.state, 'history.state kept')
  t.ok(s.map.has(INVITE_KEY))

  const k = fakeBrowser('/m/' + A.toUpperCase())
  t.alike(captureInvite({ ...k, storage: memoryStorage(), now: NOW }), { v: 1, username: null, key: A, state: 'new', recipient: null, at: NOW })
  t.is(k.calls[0].url, '/')
})

test('captureInvite cleans invalid profile paths without storing', async (t) => {
  const { captureInvite } = await load()
  for (const p of ['/@@ana', '/m/123', '/@ana/x', '/@%61na']) {
    const s = memoryStorage()
    const b = fakeBrowser(p, '?conta=erro')
    t.is(captureInvite({ ...b, storage: s, now: NOW }), null, p)
    t.is(b.calls.length, 1)
    t.is(b.calls[0].url, '/?conta=erro')
    t.is(s.map.size, 0)
  }
})

test('captureInvite: an invalid profile path drops a stored accepted invite', async (t) => {
  const { captureInvite, INVITE_KEY } = await load()
  const s = memoryStorage({ [INVITE_KEY]: raw({ v: 1, username: 'bia', key: null, state: 'accepted', recipient: A, at: NOW - 10 }) })
  const b = fakeBrowser('/@ana/extra', '?conta=ok')
  t.is(captureInvite({ ...b, storage: s, now: NOW }), null)
  t.is(s.map.size, 0, 'storage empty afterwards')
  t.is(b.calls[0].url, '/?conta=ok')
})

test('captureInvite: a failed write still removes the old invite', async (t) => {
  const { captureInvite, readInvite, INVITE_KEY } = await load()
  const s = memoryStorage({ [INVITE_KEY]: raw({ v: 1, username: 'bia', key: null, state: 'accepted', recipient: A, at: NOW - 10 }) })
  s.setItem = () => { throw new Error('QuotaExceededError') }
  const rec = captureInvite({ ...fakeBrowser('/@ana'), storage: s, now: NOW })
  t.alike(rec, newRec(), 'fresh record from memory')
  t.ok(Object.isFrozen(rec))
  t.is(s.map.has(INVITE_KEY), false, 'old record gone')
  t.is(readInvite(s, NOW + 1000), null, 'a later read finds nothing')
})

test('captureInvite replaces an accepted record with a new one', async (t) => {
  const { captureInvite, INVITE_KEY } = await load()
  const s = memoryStorage({ [INVITE_KEY]: raw({ v: 1, username: 'bia', key: null, state: 'accepted', recipient: A, at: NOW - 10 }) })
  const rec = captureInvite({ ...fakeBrowser('/@ana'), storage: s, now: NOW })
  t.alike(rec, newRec())
  t.alike(JSON.parse(s.getItem(INVITE_KEY)), newRec())
})

test('captureInvite leaves other paths alone', async (t) => {
  const { captureInvite, INVITE_KEY } = await load()
  const stored = raw({ v: 1, username: 'bia', key: null, state: 'accepted', recipient: A, at: NOW - 10 })
  for (const p of ['/', '/index.html', '/mm']) {
    const s = memoryStorage({ [INVITE_KEY]: stored })
    const b = fakeBrowser(p, '?conta=ok')
    const rec = captureInvite({ ...b, storage: s, now: NOW })
    t.is(rec.state, 'accepted', p)
    t.is(b.calls.length, 0)
    t.is(s.getItem(INVITE_KEY), stored)
  }
  const empty = fakeBrowser('/')
  t.is(captureInvite({ ...empty, storage: memoryStorage(), now: NOW }), null)
})

test('captureInvite survives a throwing replaceState and throwing storage', async (t) => {
  const { captureInvite } = await load()
  const s = memoryStorage()
  const b = fakeBrowser('/@ana')
  b.history.replaceState = () => { throw new Error('SecurityError') }
  t.alike(captureInvite({ ...b, storage: s, now: NOW }), newRec(), 'write kept')
  t.ok(s.map.size === 1)

  const c = fakeBrowser('/@ana', '', '#token=y')
  const rec = captureInvite({ ...c, storage: throwingStorage(), now: NOW })
  t.alike(rec, newRec(), 'fresh record returned when storage fails')
  t.ok(Object.isFrozen(rec))
  t.is(c.calls[0].url, '/#token=y')

  t.alike(captureInvite({ ...fakeBrowser('/@ana'), storage: null, now: NOW }), newRec())
  t.is(captureInvite({ ...fakeBrowser('/'), storage: throwingStorage(), now: NOW }), null)
  t.is(captureInvite({}), null)
  t.is(captureInvite(), null)
  t.is(captureInvite({ location: { pathname: '/@ana' }, history: null, storage: null, now: NOW }).username, 'ana')
})

test('acceptInvite binds consent to one key', async (t) => {
  const { acceptInvite, decodeInvite } = await load()
  const rec = decodeInvite(raw(newRec()), NOW)
  const acc = acceptInvite(rec, A, NOW + 5)
  t.alike(acc, { v: 1, username: 'ana', key: null, state: 'accepted', recipient: A, at: NOW + 5 })
  t.ok(Object.isFrozen(acc))
  t.is(acceptInvite(null, A, NOW), null)
  t.is(acceptInvite(rec, 'x', NOW), null)
  t.is(acceptInvite(rec, A.toUpperCase(), NOW), null)
})

test('inviteAction decision table', async (t) => {
  const { inviteAction } = await load()
  const fresh = newRec()
  const accA = newRec({ state: 'accepted', recipient: A })
  const base = { invite: fresh, hosted: true, statusKnown: true, locked: false, resumed: false, cardShown: false, unlockedKey: null, ownKey: null, atTabs: true }
  const at = (o) => inviteAction({ ...base, ...o })

  t.is(at({ invite: null }), 'none')
  t.is(at({ statusKnown: false }), 'wait')
  t.is(at({ statusKnown: false, hosted: false }), 'wait')
  t.is(at({ hosted: false }), 'drop')
  t.is(at({ hosted: 'yes' }), 'drop')
  t.is(at({ locked: true }), 'card')
  t.is(at({ locked: true, cardShown: true, unlockedKey: A }), 'card')

  // First passkey ceremony: key not known yet.
  t.is(at({ cardShown: true, unlockedKey: null }), 'wait')
  t.is(at({ cardShown: true, unlockedKey: null, atTabs: false }), 'wait')

  t.is(at({ cardShown: true, unlockedKey: A }), 'accept')
  t.is(at({ invite: newRec({ state: 'accepted', recipient: B }), cardShown: true, unlockedKey: A }), 'accept')
  t.is(at({ invite: accA, cardShown: true, unlockedKey: A, ownKey: A, acceptedHere: true }), 'follow')
  t.is(at({ invite: accA, cardShown: true, unlockedKey: A, ownKey: A }), 'confirm')
  t.is(at({ invite: accA, cardShown: true, unlockedKey: A, ownKey: A, atTabs: false }), 'wait')

  // Without consent given in this page load, never 'follow' (an accepted
  // record after a reload may be planted): at most 'confirm'.
  for (const resumed of [true, false]) {
    for (const cardShown of [true, false]) {
      const r = at({ invite: accA, resumed, cardShown, unlockedKey: A, ownKey: A })
      t.ok(r !== 'follow', 'not accepted here -> ' + r)
    }
  }
  t.is(at({ invite: accA, ownKey: A, acceptedHere: 'yes' }), 'confirm')

  // cardShown false: never accept.
  for (const unlockedKey of [null, A, B]) {
    for (const atTabs of [true, false]) {
      t.not(at({ cardShown: false, unlockedKey, ownKey: unlockedKey, atTabs }), 'accept')
    }
  }

  // resumed + 'new': never accept or follow.
  for (const cardShown of [true, false]) {
    for (const atTabs of [true, false]) {
      const r = at({ resumed: true, cardShown, unlockedKey: A, ownKey: A, atTabs })
      t.ok(r !== 'accept' && r !== 'follow', 'resumed new -> ' + r)
    }
  }
  t.is(at({ resumed: true, cardShown: true, unlockedKey: A, ownKey: A }), 'open')

  // resumed + accepted for the same key + atTabs (the Google return) -> confirm.
  t.is(at({ invite: accA, resumed: true, cardShown: true, unlockedKey: A, ownKey: A }), 'confirm')
  t.is(at({ invite: accA, resumed: true, ownKey: A }), 'confirm')
  t.is(at({ invite: accA, resumed: true, ownKey: A, atTabs: false }), 'wait')

  // Accepted for A, signed in as B -> open.
  t.is(at({ invite: accA, ownKey: B }), 'open')
  t.is(at({ invite: accA, ownKey: null }), 'open')
  t.is(at({ ownKey: A }), 'open')
  t.is(at({ atTabs: false }), 'wait')
  t.is(inviteAction(), 'none')
})

test('resolveInvite', async (t) => {
  const { resolveInvite } = await load()
  t.alike(await resolveInvite({ username: null, key: A }, () => { throw new Error('unused') }), { status: 'ready', key: A })
  const rec = newRec()
  const asked = []
  const ok = await resolveInvite(rec, async (name) => {
    asked.push(name)
    return { member: A, usernameRecord: { member: A, username: 'ana' } }
  })
  t.alike(ok, { status: 'ready', key: A })
  t.alike(asked, ['ana'])
  t.alike(await resolveInvite(rec, async () => { throw new Error('offline') }), { status: 'unavailable' })
  t.alike(await resolveInvite(rec, () => { throw new Error('sync') }), { status: 'unavailable' })
  t.alike(await resolveInvite(rec, async () => null), { status: 'not-found' })
  t.alike(await resolveInvite(rec, async () => ({ member: 'x', usernameRecord: { member: 'x', username: 'ana' } })), { status: 'not-found' })
  t.alike(await resolveInvite(rec, async () => ({ member: A, usernameRecord: { member: B, username: 'ana' } })), { status: 'not-found' }, 'member mismatch')
  t.alike(await resolveInvite(rec, async () => ({ member: A, usernameRecord: { member: A, username: 'bia' } })), { status: 'not-found' }, 'name mismatch')
  t.alike(await resolveInvite(rec, async () => ({ member: A })), { status: 'not-found' })
})

test('pt-BR copy', async (t) => {
  const m = await load()
  t.is(m.inviteCardText(newRec()), '@ana convidou você. Entre para seguir.')
  t.is(m.inviteCardText({ username: null, key: A }), 'Alguém convidou você. Entre para seguir.')
  t.is(m.followedText({ username: 'ana', changed: true }), 'Agora você segue @ana.')
  t.is(m.followedText({ username: 'ana', changed: false }), 'Você já segue @ana.')
  t.is(m.followedText({ username: null, changed: true }), 'Agora você segue esta pessoa.')
  t.is(m.followedText({ username: null, changed: false }), 'Você já segue esta pessoa.')
  t.is(m.confirmText({ username: 'ana' }), 'Para seguir @ana, toque em Seguir.')
  t.is(m.confirmText({ username: null }), 'Para seguir esta pessoa, toque em Seguir.')
  t.is(m.confirmText({ username: 'Bad Name' }), 'Para seguir esta pessoa, toque em Seguir.')
  t.is(m.NOT_FOUND_TEXT, 'Não encontramos esse @nome.')
  t.is(m.OFFLINE_TEXT, 'Sem conexão: o perfil abre quando a conexão voltar.')
  t.is(m.OPEN_IN_BROWSER_TEXT, 'Para entrar e seguir, abra este link no Chrome ou no Safari.')
  t.is(m.INVITE_KEY, 'varanda-profile-invite')
  t.is(m.INVITE_TTL_MS, 3600000)
  for (const text of [m.inviteCardText({ username: null, key: A })]) t.absent(text.includes(A))
})

test('native store: links open a fresh invite in memory, never consent', async (t) => {
  const m = await load()
  const n = await import('../src/profileLinkStore.native.js')
  const { setInstallation } = await import('../src/installation.js')
  t.teardown(() => { setInstallation(null); n.dropInvite() })
  t.is(n.captureInvite(), null, 'nothing held at start')
  t.is(n.captureInvite('varanda://@ana'), null, 'a host form is refused')
  t.is(n.captureInvite('varanda:///convite/' + 'Z'.repeat(43)), null, 'an invite link is not a profile')
  t.is(n.loadInvite(), null)
  const rec = n.captureInvite('varanda:///@Ana')
  t.alike({ ...rec }, { v: 1, username: 'ana', key: null, state: 'new', recipient: null, at: rec.at })
  t.is(n.loadInvite().username, 'ana')
  t.ok(n.saveInvite(m.acceptInvite(n.loadInvite(), B, Date.now())))
  t.is(n.loadInvite().state, 'accepted')
  t.is(n.captureInvite('varanda://idade?volta=1'), null, 'other URLs change nothing')
  t.is(n.loadInvite().state, 'accepted')
  t.ok(setInstallation('https://varanda.example'))
  t.is(n.captureInvite('https://evil.example/m/' + A), null)
  const next = n.captureInvite('https://varanda.example/m/' + A)
  t.is(next.key, A)
  t.is(next.state, 'new', 'a newer link never inherits the earlier consent')
  t.is(n.loadInvite().state, 'new')
  t.is(n.captureInvite('varanda:///@ana', Date.now() - m.INVITE_TTL_MS - 1).username, 'ana')
  t.is(n.loadInvite(), null, 'the 1 h limit applies to the memory record')
  t.is(n.captureInvite('varanda:///@ana').username, 'ana')
  t.ok(n.dropInvite())
  t.is(n.loadInvite(), null)
})
