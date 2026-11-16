'use strict'

const test = require('brittle')
const { createHmac } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/onceMarks.js')
const MEMBER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const PAGE = 'c'.repeat(64)
const KEY = '0123456789abcdef'.repeat(4)
const KEY2 = 'fedcba9876543210'.repeat(4)
const expected = (key, kind, member, id) => createHmac('sha256', Buffer.from(key, 'hex')).update('varanda-once-v1\n' + kind + '\n' + member + '\n' + id).digest('hex').slice(0, 32)

function keyed (createOnceRegistry) {
  const r = createOnceRegistry()
  r.setKey(MEMBER, KEY)
  return r
}

test('onceToken matches the known-answer vector', async (t) => {
  const { onceToken } = await load()
  t.is(onceToken(KEY, 'page-dm-notice', MEMBER, PAGE), expected(KEY, 'page-dm-notice', MEMBER, PAGE))
  t.is(onceToken(KEY, 'invite-drop', MEMBER, '2026-11-09T03:00:00.000Z#1'), expected(KEY, 'invite-drop', MEMBER, '2026-11-09T03:00:00.000Z#1'))
  t.is(onceToken(KEY, 'page-dm-notice', MEMBER, 'Página ç'), expected(KEY, 'page-dm-notice', MEMBER, 'Página ç'), 'UTF-8 id')
  t.ok(/^[0-9a-f]{32}$/.test(onceToken(KEY, 'invite-drop', MEMBER, 'x')))
})

test('onceToken validates key, kind, member and id', async (t) => {
  const { onceToken } = await load()
  for (const key of [null, undefined, '', 'a', KEY.toUpperCase(), KEY.slice(1), KEY + '0', 5]) t.is(onceToken(key, 'invite-drop', MEMBER, 'x'), null, 'key ' + String(key))
  t.is(onceToken(KEY, 'other', MEMBER, 'x'), null)
  t.is(onceToken(KEY, 'invite-drop', 'a', 'x'), null)
  t.is(onceToken(KEY, 'invite-drop', MEMBER.toUpperCase(), 'x'), null)
  t.is(onceToken(KEY, 'invite-drop', MEMBER, ''), null)
  t.is(onceToken(KEY, 'invite-drop', MEMBER, 'a\nb'), null)
  t.is(onceToken(KEY, 'invite-drop', MEMBER, 'x'.repeat(201)), null)
  t.is(onceToken(KEY, 'invite-drop', MEMBER, 5), null)
  t.ok(onceToken(KEY, 'invite-drop', MEMBER, 'x'.repeat(200)))
})

test('keys, kinds and members give different tokens', async (t) => {
  const { onceToken } = await load()
  t.not(onceToken(KEY, 'page-dm-notice', MEMBER, 'x'), onceToken(KEY, 'invite-drop', MEMBER, 'x'))
  t.not(onceToken(KEY, 'invite-drop', MEMBER, 'x'), onceToken(KEY, 'invite-drop', OTHER, 'x'))
  t.not(onceToken(KEY, 'invite-drop', MEMBER, 'x'), onceToken(KEY2, 'invite-drop', MEMBER, 'x'))
})

test('once ids', async (t) => {
  const { inviteDropOnceId } = await load()
  const rec = { v: 1, member: MEMBER, resetsAt: '2026-11-09T03:00:00.000Z', seenOpened: 2 }
  t.is(inviteDropOnceId(rec), '2026-11-09T03:00:00.000Z#2')
  t.is(inviteDropOnceId({ ...rec, v: 2 }), null)
  t.is(inviteDropOnceId(null), null)
})

test('registry without a key never marks nor reads a mark', async (t) => {
  const { createOnceRegistry, onceToken } = await load()
  const r = createOnceRegistry()
  const marks = []
  r.onMark((m) => marks.push(m))
  r.setRemote(MEMBER, [onceToken(KEY, 'page-dm-notice', MEMBER, PAGE)])
  t.is(r.has('page-dm-notice', MEMBER, PAGE), false, 'no key, no reading')
  t.is(r.mark('invite-drop', MEMBER, 'x'), null)
  t.alike(marks, [])
  t.alike(r.unsynced(MEMBER), [])
  r.setKey(MEMBER, 'nope')
  r.setKey(MEMBER, KEY.toUpperCase())
  t.is(r.mark('invite-drop', MEMBER, 'x'), null, 'an invalid key is no key')
  r.setKey(MEMBER, KEY)
  t.is(r.has('page-dm-notice', MEMBER, PAGE), true)
  r.forget(MEMBER)
  t.is(r.has('page-dm-notice', MEMBER, PAGE), false, 'forget drops key and remote set')
  t.is(r.remoteKnown(MEMBER), false)
})

test('registry sees remote and local marks', async (t) => {
  const { createOnceRegistry, onceToken } = await load()
  const r = keyed(createOnceRegistry)
  t.is(r.has('page-dm-notice', MEMBER, PAGE), false)
  r.setRemote(MEMBER, [onceToken(KEY, 'page-dm-notice', MEMBER, PAGE)])
  t.is(r.has('page-dm-notice', MEMBER, PAGE), true)
  t.is(r.isRemote('page-dm-notice', MEMBER, PAGE), true)
  t.is(r.has('page-dm-notice', OTHER, PAGE), false)
  t.is(r.has('bad', MEMBER, PAGE), false)
  t.is(r.mark('invite-drop', MEMBER, 'x'), onceToken(KEY, 'invite-drop', MEMBER, 'x'))
  t.is(r.has('invite-drop', MEMBER, 'x'), true)
  t.is(r.isRemote('invite-drop', MEMBER, 'x'), false)
  r.setRemote(MEMBER, [])
  t.is(r.has('page-dm-notice', MEMBER, PAGE), false)
  t.is(r.has('invite-drop', MEMBER, 'x'), true, 'local mark survives a remote replace')
  t.is(r.mark('bad', MEMBER, 'x'), null)
})

test('mark notifies once per new token and survives a throwing listener', async (t) => {
  const { createOnceRegistry, onceToken } = await load()
  const r = keyed(createOnceRegistry)
  const seen = []
  r.onMark(() => { throw new Error('boom') })
  const off = r.onMark((m) => seen.push(m))
  r.mark('invite-drop', MEMBER, 'x')
  r.mark('invite-drop', MEMBER, 'x')
  t.alike(seen, [{ member: MEMBER, token: onceToken(KEY, 'invite-drop', MEMBER, 'x') }])
  r.setRemote(MEMBER, [onceToken(KEY, 'invite-drop', MEMBER, 'y')])
  t.is(r.mark('invite-drop', MEMBER, 'y'), onceToken(KEY, 'invite-drop', MEMBER, 'y'))
  t.is(seen.length, 1, 'known remotely: no listener')
  off()
  r.mark('invite-drop', MEMBER, 'z')
  t.is(seen.length, 1)
})

test('setRemote, setKey and forget notify only on change', async (t) => {
  const { createOnceRegistry } = await load()
  const r = createOnceRegistry()
  let n = 0
  const off = r.onChange(() => { n++ })
  const tok = 'd'.repeat(32)
  r.setRemote(MEMBER, [tok, 'short', 5, tok.toUpperCase()])
  t.is(n, 1)
  r.setRemote(MEMBER, [tok])
  t.is(n, 1)
  r.setRemote('bad', [tok])
  t.is(n, 1)
  r.setRemote(MEMBER, 'nope')
  t.is(n, 2)
  r.setRemote(MEMBER, null)
  t.is(n, 2)
  r.setKey(MEMBER, KEY)
  t.is(n, 3)
  r.setKey(MEMBER, KEY)
  t.is(n, 3)
  r.forget(MEMBER)
  t.is(n, 4)
  r.forget(MEMBER)
  t.is(n, 4)
  off()
  r.setRemote(MEMBER, [tok])
  t.is(n, 4)
})

test('an unsynced mark survives a member reset and a debounce, until remote', async (t) => {
  const { createOnceRegistry, withOnceTokens } = await load()
  const r = keyed(createOnceRegistry)
  const token = r.mark('page-dm-notice', MEMBER, PAGE)
  const reported = 'e'.repeat(32)
  t.alike(withOnceTokens({ own: [reported], pages: {} }, r.unsynced(MEMBER)).own, [token, reported], 'first in the pass')
  // The seen member goes away and comes back: the shell's pending list resets.
  r.forget(MEMBER)
  t.alike(r.unsynced(MEMBER), [token], 'kept across forget')
  r.setKey(MEMBER, KEY)
  const sent = withOnceTokens({ own: [], pages: {} }, r.unsynced(MEMBER))
  t.alike(sent.own, [token], 'the next pass still sends it')
  t.alike(withOnceTokens({ own: [], pages: {} }, r.unsynced(MEMBER)).own, [token], 'and again after a debounce, nothing answered')
  r.setRemote(MEMBER, ['f'.repeat(32)])
  t.alike(r.unsynced(MEMBER), [token], 'a remote set without it keeps it')
  r.setRemote(MEMBER, [token])
  t.alike(r.unsynced(MEMBER), [], 'held remotely: no longer sent')
  t.alike(withOnceTokens({ own: [reported] }, r.unsynced(MEMBER)), { own: [reported], pages: {} })
  t.is(r.mark('page-dm-notice', MEMBER, PAGE), token)
  t.alike(r.unsynced(MEMBER), [], 'a remote token is not marked again')
})

test('a delivered mark stops going out', async (t) => {
  const { createOnceRegistry, withOnceTokens } = await load()
  const r = keyed(createOnceRegistry)
  const a = r.mark('invite-drop', MEMBER, 'a')
  const b = r.mark('invite-drop', MEMBER, 'b')
  r.delivered(MEMBER, [a])
  t.alike(r.unsynced(MEMBER), [b])
  r.delivered(MEMBER, 'nope')
  t.alike(r.unsynced(MEMBER), [b])
  t.alike(withOnceTokens(null, [b, b, 'bad']).own, [b])
})

test('syncedPageNoticeStore', async (t) => {
  const { createOnceRegistry, syncedPageNoticeStore, onceToken } = await load()
  const { pageNoticeSeen, notePageNotice, pageNoticeKey } = await import('../src/pageNotice.js')
  const data = new Map()
  const base = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
  const r = keyed(createOnceRegistry)
  t.is(syncedPageNoticeStore(base, null, r), base)
  t.is(syncedPageNoticeStore(base, MEMBER, null), base)
  const store = syncedPageNoticeStore(base, MEMBER, r)
  t.is(pageNoticeSeen(store, PAGE), false)
  r.setRemote(MEMBER, [onceToken(KEY, 'page-dm-notice', MEMBER, PAGE)])
  t.is(pageNoticeSeen(store, PAGE), true)
  t.is(pageNoticeSeen(store, 'e'.repeat(64)), false)
  const marks = []
  r.onMark((m) => marks.push(m))
  notePageNotice(store, 'e'.repeat(64))
  t.alike([...data.keys()], ['varanda-once-' + onceToken(KEY, 'page-dm-notice', MEMBER, 'e'.repeat(64))], 'with a key, only the opaque device entry')
  t.is(data.get(pageNoticeKey('e'.repeat(64))), undefined, 'no entry named after the Página')
  t.is(marks.length, 1)
  store.setItem(pageNoticeKey(PAGE), '0')
  store.setItem('other-key', '1')
  t.is(marks.length, 1)
  t.is(data.get('other-key'), '1', 'other keys pass through')
  const broken = syncedPageNoticeStore({ getItem () { throw new Error('r') }, setItem () { throw new Error('w') } }, MEMBER, r)
  t.is(broken.getItem(pageNoticeKey('f'.repeat(64))), null)
  t.is(broken.getItem(pageNoticeKey(PAGE)), '1')
  t.execution(() => broken.setItem(pageNoticeKey('f'.repeat(64)), '1'))
  t.is(marks.length, 2)
})

test('syncedPageNoticeStore before the member key writes nothing to the device', async (t) => {
  const { createOnceRegistry, syncedPageNoticeStore, onceToken } = await load()
  const { pageNoticeKey } = await import('../src/pageNotice.js')
  const data = new Map()
  const base = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
  const r = createOnceRegistry()
  r.setKey(OTHER, KEY)
  const marks = []
  r.onMark((m) => marks.push(m))
  const store = syncedPageNoticeStore(base, MEMBER, r)
  t.is(store.getItem(pageNoticeKey(PAGE)), null)
  store.setItem(pageNoticeKey(PAGE), '1')
  store.setItem(pageNoticeKey('e'.repeat(64)), '0')
  t.alike([...data.entries()], [], 'nothing named after the Página, nothing at all')
  t.is(store.getItem(pageNoticeKey(PAGE)), '1', 'waits in memory for this member')
  t.is(syncedPageNoticeStore(base, OTHER, r).getItem(pageNoticeKey(PAGE)), null, 'not for another member')
  t.alike(r.unsynced(MEMBER), [])
  t.alike(marks, [])
  store.setItem('other-key', '1')
  t.alike([...data.entries()], [['other-key', '1']], 'other keys pass through')
  data.clear()

  const token = onceToken(KEY2, 'page-dm-notice', MEMBER, PAGE)
  r.setKey(MEMBER, KEY2)
  t.ok(r.has('page-dm-notice', MEMBER, PAGE), 'the key turns it into a mark of this member')
  t.alike(r.unsynced(MEMBER), [token])
  t.alike(marks, [{ member: MEMBER, token }])
  t.is(r.waiting('page-dm-notice', MEMBER, PAGE), false)
  t.alike([...data.entries()], [], 'the registry does not touch the device')
  t.is(store.getItem(pageNoticeKey('f'.repeat(64))), null)
  t.alike([...data.entries()], [['varanda-once-' + token, '1']], 'the next read writes the opaque entry')
  store.getItem(pageNoticeKey(PAGE))
  t.is(data.size, 1, 'once')
  t.alike(r.takeOwed('page-dm-notice', MEMBER), [])
})

test('the waiting set: valid ids only, dropped by forget', async (t) => {
  const { createOnceRegistry } = await load()
  const r = createOnceRegistry()
  t.is(r.wait('page-dm-notice', 'a', PAGE), false)
  t.is(r.wait('other', MEMBER, PAGE), false)
  t.is(r.wait('page-dm-notice', MEMBER, ''), false)
  t.is(r.wait('page-dm-notice', MEMBER, PAGE), true)
  t.is(r.waiting('page-dm-notice', MEMBER, PAGE), true)
  t.is(r.waiting('invite-drop', MEMBER, PAGE), false)
  r.forget(MEMBER)
  t.is(r.waiting('page-dm-notice', MEMBER, PAGE), false, 'memory only, the notice may show again')
  r.setKey(MEMBER, KEY)
  t.is(r.has('page-dm-notice', MEMBER, PAGE), false)
  t.is(r.wait('page-dm-notice', MEMBER, PAGE), false, 'with the key, mark instead')
  r.wait('page-dm-notice', OTHER, PAGE)
  r.forget(OTHER)
  r.setKey(OTHER, KEY)
  t.alike(r.takeOwed('page-dm-notice', OTHER), [], 'nothing owed after forget')
})

test('syncedPageNoticeStore offers again only the member-bound device entry', async (t) => {
  const { createOnceRegistry, syncedPageNoticeStore, onceToken } = await load()
  const { pageNoticeKey } = await import('../src/pageNotice.js')
  const shown = 'e'.repeat(64)
  const legacy = 'f'.repeat(64)
  const opaque = (page) => 'varanda-once-' + onceToken(KEY, 'page-dm-notice', MEMBER, page)
  const data = new Map([[opaque(PAGE), '1'], [opaque(shown), '1'], [pageNoticeKey(legacy), '1']])
  const base = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
  const r = createOnceRegistry()
  const marks = []
  r.onMark((m) => marks.push(m.token))
  const store = syncedPageNoticeStore(base, MEMBER, r)
  t.is(store.getItem(pageNoticeKey(PAGE)), null, 'no key: the opaque name is unknown')
  t.is(store.getItem(pageNoticeKey(legacy)), '1', 'no key: the legacy flag answers, as before')
  r.setKey(MEMBER, KEY)
  t.is(store.getItem(pageNoticeKey(PAGE)), '1')
  t.alike(marks, [], 'no pass answered yet: nothing offered')
  r.setRemote(MEMBER, [onceToken(KEY, 'page-dm-notice', MEMBER, shown)])
  t.is(store.getItem(pageNoticeKey(legacy)), '1', 'a legacy page-keyed flag still reads as shown here')
  t.alike(marks, [], 'but is never offered: it may be another member\'s')
  t.is(store.getItem(pageNoticeKey(PAGE)), '1')
  t.is(store.getItem(pageNoticeKey(shown)), '1')
  t.alike(marks, [onceToken(KEY, 'page-dm-notice', MEMBER, PAGE)], 'only the page the document lacks')
  t.is(store.getItem(pageNoticeKey(PAGE)), '1')
  t.is(marks.length, 1, 'no churn: a local token is not offered twice')
  const other = syncedPageNoticeStore(base, OTHER, r)
  r.setKey(OTHER, KEY2)
  r.setRemote(OTHER, [])
  t.is(other.getItem(pageNoticeKey(PAGE)), null, 'another member does not read this member\'s entry')
  t.is(marks.length, 1)
})

test('the page notice wipe removes both device flag kinds and nothing else', async (t) => {
  const { wipePageNotices } = await import('../src/pageNoticeStore.web.js')
  const { wipeLocalCaches } = await import('../src/localCaches.js')
  const names = ['varanda-page-dm-notice-' + PAGE, 'varanda-once-' + '0'.repeat(32), 'varanda-invite-seen', 'varanda-onceish', 'other']
  const fill = () => new Map(names.map((n) => [n, '1']))
  let data = fill()
  const localStorage = {
    get length () { return data.size },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v) },
    removeItem: (k) => { data.delete(k) }
  }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true })
  try {
    wipePageNotices()
    t.alike([...data.keys()], ['varanda-invite-seen', 'varanda-onceish', 'other'])
    data = fill()
    wipeLocalCaches()
    t.alike([...data.keys()], ['varanda-invite-seen', 'varanda-onceish', 'other'], 'registered with the local-cache wipe')
    localStorage.removeItem = () => { throw new Error('denied') }
    t.execution(() => wipePageNotices())
    Object.defineProperty(globalThis, 'localStorage', { get () { throw new Error('denied') }, configurable: true })
    t.execution(() => wipePageNotices())
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete globalThis.localStorage
  }
})

test('the native page notice wipe deletes both device flag kinds from the documents dir', async (t) => {
  const { pageNoticeFlags } = await import('../src/pageNotice.js')
  const src = readFileSync(join(__dirname, '../src/pageNoticeStore.native.js'), 'utf8')
  t.ok(src.includes('registerLocalCache({ wipe: wipePageNotices })'))
  const fn = src.match(/export function wipePageNotices \(\) \{[^]*?\n\}/)[0].replace(/^export /, '')
  const files = new Set(['varanda-page-dm-notice-' + PAGE + '.json', 'varanda-once-' + '0'.repeat(32) + '.json', 'varanda-invite-seen.json', 'other.json'])
  class File {
    constructor (dir, name) { this.path = dir + '/' + name; this.name = name }
    get exists () { return files.has(this.name) }
    delete () { files.delete(this.name) }
  }
  class Directory {
    constructor (dir) { this.dir = dir }
    list () { return [...files].map((n) => new File(this.dir, n)) }
  }
  // eslint-disable-next-line no-new-func
  const wipe = new Function('Directory', 'File', 'Paths', 'pageNoticeFlags', fn + '\nreturn wipePageNotices')(Directory, File, { document: '/docs' }, pageNoticeFlags)
  wipe()
  t.alike([...files], ['varanda-invite-seen.json', 'other.json'])
  class Broken { list () { throw new Error('io') } }
  // eslint-disable-next-line no-new-func
  const broken = new Function('Directory', 'File', 'Paths', 'pageNoticeFlags', fn + '\nreturn wipePageNotices')(Broken, File, { document: '/docs' }, pageNoticeFlags)
  t.execution(() => broken())
})

test('the legacy page notice wipe removes only page-named flags', async (t) => {
  const { wipeLegacyPageNotices } = await import('../src/pageNoticeStore.web.js')
  const { legacyPageNoticeFlags } = await import('../src/pageNotice.js')
  t.alike(legacyPageNoticeFlags(['varanda-page-dm-notice-' + PAGE, 'varanda-page-dm-notice-x.json', 'varanda-once-' + '0'.repeat(32), null, 5, 'other']), ['varanda-page-dm-notice-' + PAGE, 'varanda-page-dm-notice-x.json'])
  const data = new Map(['varanda-page-dm-notice-' + PAGE, 'varanda-page-dm-notice-' + 'e'.repeat(64), 'varanda-once-' + '0'.repeat(32), 'varanda-invite-seen', 'other'].map((n) => [n, '1']))
  const localStorage = {
    get length () { return data.size },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v) },
    removeItem: (k) => { data.delete(k) }
  }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true })
  try {
    wipeLegacyPageNotices()
    t.alike([...data.keys()], ['varanda-once-' + '0'.repeat(32), 'varanda-invite-seen', 'other'])
    data.set('varanda-page-dm-notice-' + PAGE, '1')
    localStorage.removeItem = () => { throw new Error('denied') }
    t.execution(() => wipeLegacyPageNotices())
    Object.defineProperty(globalThis, 'localStorage', { get () { throw new Error('denied') }, configurable: true })
    t.execution(() => wipeLegacyPageNotices())
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete globalThis.localStorage
  }
})

test('the native legacy page notice wipe deletes only page-named flags', async (t) => {
  const { legacyPageNoticeFlags } = await import('../src/pageNotice.js')
  const src = readFileSync(join(__dirname, '../src/pageNoticeStore.native.js'), 'utf8')
  const fn = src.match(/export function wipeLegacyPageNotices \(\) \{[^]*?\n\}/)[0].replace(/^export /, '')
  const files = new Set(['varanda-page-dm-notice-' + PAGE + '.json', 'varanda-once-' + '0'.repeat(32) + '.json', 'varanda-invite-seen.json', 'other.json'])
  class File {
    constructor (dir, name) { this.path = dir + '/' + name; this.name = name }
    get exists () { return files.has(this.name) }
    delete () { files.delete(this.name) }
  }
  class Directory {
    constructor (dir) { this.dir = dir }
    list () { return [...files].map((n) => new File(this.dir, n)) }
  }
  const make = (Dir, F) => new Function('Directory', 'File', 'Paths', 'legacyPageNoticeFlags', fn + '\nreturn wipeLegacyPageNotices')(Dir, F, { document: '/docs' }, legacyPageNoticeFlags) // eslint-disable-line no-new-func
  make(Directory, File)()
  t.alike([...files], ['varanda-once-' + '0'.repeat(32) + '.json', 'varanda-invite-seen.json', 'other.json'])
  class Broken { list () { throw new Error('io') } }
  t.execution(() => make(Broken, File)())
  class Odd { list () { return null } }
  t.execution(() => make(Odd, File)())
  files.add('varanda-page-dm-notice-' + PAGE + '.json')
  class Stuck extends File { delete () { throw new Error('busy') } }
  t.execution(() => make(Directory, Stuck)())
})

test('the module is pure', (t) => {
  const src = readFileSync(join(__dirname, '../src/onceMarks.js'), 'utf8')
  for (const bad of ['react', 'react-native', 'require(', 'fetch']) t.absent(src.includes(bad), bad)
  t.absent(src.includes(String.fromCharCode(0x2014)))
})
