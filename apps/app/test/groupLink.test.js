'use strict'

// The group-link helpers (src/groupLink.js), loaded through import().
const test = require('brittle')

const load = () => import('../src/groupLink.js')
const A = 'ab'.repeat(32)

test('parseGroupPath accepts a lowercase hex64 with or without a trailing slash', async (t) => {
  const { parseGroupPath } = await load()
  t.is(parseGroupPath('/g/' + A), A)
  t.is(parseGroupPath('/g/' + A + '/'), A)
})

test('parseGroupPath refuses uppercase, wrong length and extra segments', async (t) => {
  const { parseGroupPath } = await load()
  t.is(parseGroupPath('/g/' + A.toUpperCase()), null)
  t.is(parseGroupPath('/g/' + A.slice(1)), null)
  t.is(parseGroupPath('/g/' + A + 'a'), null)
  t.is(parseGroupPath('/g/' + A + '/x'), null)
  t.is(parseGroupPath('/g/' + A + '?x=1'), null)
  t.is(parseGroupPath('/g//' + A), null)
  t.is(parseGroupPath('/m/' + A), null)
  t.is(parseGroupPath('/g/' + 'zz'.repeat(32)), null)
  t.is(parseGroupPath(null), null)
  t.is(parseGroupPath('/g/' + A + ' '), null)
})

test('isGroupPath is a prefix test', async (t) => {
  const { isGroupPath } = await load()
  t.ok(isGroupPath('/g/anything'))
  t.absent(isGroupPath('/m/' + A))
  t.absent(isGroupPath('/'))
  t.absent(isGroupPath(undefined))
})

function fake (pathname, search = '', hash = '') {
  const calls = []
  return {
    location: { pathname, search, hash },
    history: { state: { idx: 1 }, replaceState (s, title, url) { calls.push({ s, url }) } },
    calls
  }
}

test('captureGroupLink returns the key and cleans the path, keeping search and hash', async (t) => {
  const { captureGroupLink } = await load()
  const f = fake('/g/' + A, '?conta=1', '#token=x')
  t.is(captureGroupLink(f), A)
  t.is(f.calls.length, 1)
  t.is(f.calls[0].url, '/?conta=1#token=x')
  t.alike(f.calls[0].s, { idx: 1 })
})

test('captureGroupLink cleans an invalid group path and returns null', async (t) => {
  const { captureGroupLink } = await load()
  const f = fake('/g/' + A.toUpperCase())
  t.is(captureGroupLink(f), null)
  t.is(f.calls.length, 1)
  t.is(f.calls[0].url, '/')
})

test('captureGroupLink leaves other paths alone and survives a broken history', async (t) => {
  const { captureGroupLink } = await load()
  const f = fake('/m/' + A)
  t.is(captureGroupLink(f), null)
  t.is(f.calls.length, 0)
  t.is(captureGroupLink(), null)
  const g = fake('/g/' + A)
  g.history.replaceState = () => { throw new Error('denied') }
  t.is(captureGroupLink(g), A)
})

test('parseCommunityPath accepts only a strict lowercase /c/<hex64>', async (t) => {
  const { parseCommunityPath, isCommunityPath, communityLink } = await load()
  t.is(parseCommunityPath('/c/' + A), A)
  t.is(parseCommunityPath('/c/' + A + '/'), A)
  t.is(parseCommunityPath('/c/' + A.toUpperCase()), null)
  t.is(parseCommunityPath('/c/' + A.slice(1)), null)
  t.is(parseCommunityPath('/c/' + A + 'a'), null)
  t.is(parseCommunityPath('/c/' + A + '/x'), null)
  t.is(parseCommunityPath('/c/' + A + '?x=1'), null)
  t.is(parseCommunityPath(null), null)
  t.ok(isCommunityPath('/c/anything'))
  t.absent(isCommunityPath('/g/' + A))
  t.is(communityLink(A.toUpperCase()), '/c/' + A)
  t.is(communityLink('nope'), null)
})

test('captureCommunityLink returns the key, cleans the path and keeps search and hash', async (t) => {
  const { captureCommunityLink } = await load()
  const f = fake('/c/' + A, '?conta=1', '#token=x')
  t.is(captureCommunityLink(f), A)
  t.is(f.calls.length, 1)
  t.is(f.calls[0].url, '/?conta=1#token=x')
  const bad = fake('/c/' + A.toUpperCase())
  t.is(captureCommunityLink(bad), null)
  t.is(bad.calls[0].url, '/')
  const other = fake('/m/' + A)
  t.is(captureCommunityLink(other), null)
  t.is(other.calls.length, 0)
})

test('group and community links never mix', async (t) => {
  const { parseGroupPath, parseCommunityPath, captureGroupLink, captureCommunityLink } = await load()
  t.is(parseGroupPath('/c/' + A), null)
  t.is(parseCommunityPath('/g/' + A), null)
  const g = fake('/g/' + A)
  t.is(captureCommunityLink(g), null)
  t.is(g.calls.length, 0)
  const c = fake('/c/' + A)
  t.is(captureGroupLink(c), null)
  t.is(c.calls.length, 0)
})

function memory () {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

const NOW = 1700000000000

test('captureEntryLink stores a community or group link and reads it back after the reload', async (t) => {
  const { captureEntryLink, ENTRY_KEY } = await load()
  t.is(ENTRY_KEY, 'varanda-entry-link')
  for (const [prefix, kind] of [['/c/', 'comunidade'], ['/g/', 'grupo']]) {
    const storage = memory()
    const f = fake(prefix + A, '?conta=1', '#token=x')
    const rec = captureEntryLink({ ...f, storage, now: NOW })
    t.alike(rec, { v: 1, kind, key: A, at: NOW }, kind)
    t.ok(Object.isFrozen(rec))
    t.alike(JSON.parse(storage.map.get('varanda-entry-link')), { v: 1, kind, key: A, at: NOW })
    t.is(f.calls.length, 1)
    t.is(f.calls[0].url, '/?conta=1#token=x')
    const back = fake('/', '?conta=ok')
    t.alike(captureEntryLink({ ...back, storage, now: NOW + 5000 }), { v: 1, kind, key: A, at: NOW })
    t.is(back.calls.length, 0)
  }
})

test('captureEntryLink: a newer link wins and a malformed one clears the old record', async (t) => {
  const { captureEntryLink, readEntry } = await load()
  const B = 'cd'.repeat(32)
  const storage = memory()
  captureEntryLink({ ...fake('/c/' + A), storage, now: NOW })
  t.alike(captureEntryLink({ ...fake('/g/' + B), storage, now: NOW + 1 }), { v: 1, kind: 'grupo', key: B, at: NOW + 1 })
  t.alike(readEntry(storage, NOW + 2), { v: 1, kind: 'grupo', key: B, at: NOW + 1 })
  const bad = fake('/c/' + A.toUpperCase())
  t.is(captureEntryLink({ ...bad, storage, now: NOW + 3 }), null)
  t.absent(storage.map.has('varanda-entry-link'))
  t.is(bad.calls[0].url, '/')
})

test('readEntry drops every doubtful record', async (t) => {
  const { readEntry, decodeEntry } = await load()
  const rec = (o) => JSON.stringify({ v: 1, kind: 'grupo', key: A, at: NOW, ...o })
  const cases = {
    expired: rec({ at: NOW - 3600001 }),
    future: rec({ at: NOW + 60001 }),
    perfil: rec({ kind: 'perfil' }),
    uppercase: rec({ key: A.toUpperCase() }),
    v2: rec({ v: 2 }),
    'non-JSON': '{nope',
    long: rec({ pad: 'x'.repeat(300) })
  }
  for (const [name, raw] of Object.entries(cases)) {
    const storage = memory()
    storage.map.set('varanda-entry-link', raw)
    t.is(readEntry(storage, NOW), null, name)
    t.absent(storage.map.has('varanda-entry-link'), name + ' removed')
  }
  const raw = '{"__proto__":{"y":1},"v":1,"kind":"grupo","key":"' + A + '","at":' + NOW + ',"extra":1}'
  const extra = decodeEntry(raw, NOW)
  t.alike(Object.keys(extra), ['v', 'kind', 'key', 'at'])
  t.is(extra.extra, undefined)
  t.is(extra.y, undefined)
  t.is(Object.getPrototypeOf(extra), Object.prototype)
  t.alike(decodeEntry(rec({ at: NOW - 3600000 }), NOW), { v: 1, kind: 'grupo', key: A, at: NOW - 3600000 })
})

test('entry storage failures never throw', async (t) => {
  const { captureEntryLink, readEntry, writeEntry, clearEntry } = await load()
  const storage = memory()
  storage.setItem = () => { throw new Error('quota') }
  t.alike(captureEntryLink({ ...fake('/c/' + A), storage, now: NOW }), { v: 1, kind: 'comunidade', key: A, at: NOW })
  const broken = { getItem () { throw new Error('denied') }, removeItem () { throw new Error('denied') } }
  t.is(readEntry(broken, NOW), null)
  t.is(readEntry(null, NOW), null)
  t.is(captureEntryLink({ ...fake('/'), storage: null, now: NOW }), null)
  t.is(writeEntry(null, { kind: 'grupo' }), false)
  t.is(clearEntry(broken), false)
  t.is(clearEntry(null), false)
  t.is(captureEntryLink(), null)
})

test('entryPath and entryCardText', async (t) => {
  const { entryPath, entryCardText, ENTRY_TEXT } = await load()
  t.is(entryPath({ kind: 'grupo', key: A }), '/g/' + A)
  t.is(entryPath({ kind: 'comunidade', key: A }), '/c/' + A)
  t.is(entryPath({ kind: 'perfil', key: A }), null)
  t.is(entryPath({ kind: 'grupo', key: A.toUpperCase() }), null)
  t.is(entryPath(), null)
  t.is(entryCardText('comunidade'), ENTRY_TEXT.comunidade)
  t.is(entryCardText('grupo'), ENTRY_TEXT.grupo)
  t.is(entryCardText('perfil'), '')
  t.is(entryCardText('toString'), '')
  t.is(entryCardText(undefined), '')
})

test('entry link stores: web only when hosted, native holds nothing', async (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const web = fs.readFileSync(path.join(__dirname, '../src/groupLinkStore.web.js'), 'utf8')
  t.ok(web.includes('hostedPage !== true'))
  t.ok(web.includes('sessionStorage'))
  t.absent(web.includes('localStorage.'))
  const n = await import('../src/groupLinkStore.native.js')
  t.is(n.captureEntryLink(), null)
  t.is(n.dropEntryLink(), false)
})
