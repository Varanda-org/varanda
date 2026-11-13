'use strict'

const test = require('brittle')

const ORIGIN = 'https://varanda.example'
const AT = 1731340800000
const ID = AT + '-' + 'a'.repeat(32)
const OTHER = (AT + 1) + '-' + 'b'.repeat(32)
const load = () => import('../src/shareIntake.web.js')
const key = (id, name = 'meta') => ORIGIN + '/__varanda-share/' + id + '/' + name

function replaceGlobal (t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  t.teardown(() => {
    if (original) Object.defineProperty(globalThis, name, original)
    else delete globalThis[name]
  })
}

function fake (t) {
  const entries = new Map()
  const opened = []
  const deleted = []
  const cache = {
    async keys () { return Array.from(entries.keys(), (url) => new Request(url)) },
    async match (request) {
      const response = entries.get(typeof request === 'string' ? request : request.url)
      return response ? response.clone() : undefined
    },
    async delete (request) {
      const url = typeof request === 'string' ? request : request.url
      deleted.push(url)
      return entries.delete(url)
    }
  }
  replaceGlobal(t, 'caches', {
    async open (name) {
      opened.push(name)
      return cache
    }
  })
  return { entries, cache, opened, deleted }
}

function store (entries, id = ID, fields = {}) {
  const meta = {
    v: 1,
    id,
    at: Number(id.slice(0, 13)),
    title: 'Título',
    text: 'Texto compartilhado',
    url: 'https://example.com/foto',
    total: 0,
    files: [],
    ...fields
  }
  entries.set(key(id), new Response(JSON.stringify(meta)))
  return meta
}

test('web intake imports without caches and listen stays quiet', async (t) => {
  replaceGlobal(t, 'caches', undefined)
  const web = await load()
  t.alike(Object.keys(web).sort(), ['clear', 'listen', 'peek', 'release', 'sweep'])
  t.is(await web.peek(), null)
  t.is(await web.clear(), undefined)
  t.is(await web.release(ID), undefined)
  t.is(await web.sweep(1000), undefined)
  let called = false
  const off = web.listen(() => { called = true })
  t.is(typeof off, 'function')
  t.is(off(), undefined)
  t.is(off(), undefined)
  t.is(called, false)
})

test('web intake returns null for an empty cache', async (t) => {
  const { entries, opened } = fake(t)
  const web = await load()
  t.is(await web.peek(), null)
  t.alike(opened, ['varanda-share'])
  t.is(entries.size, 0)
})

test('web intake reads the same stored share twice without consuming it', async (t) => {
  const { entries } = fake(t)
  const web = await load()
  const types = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  const files = types.map((mime, n) => ({ n, mime }))
  const meta = store(entries, ID, { total: 4, files, extra: 'ignored' })
  for (const { n } of files) entries.set(key(ID, n), new Response('bytes-' + n))
  const before = Array.from(entries.keys())
  const first = await web.peek()
  const second = await web.peek()
  t.alike({ ...first, files: [] }, {
    id: ID,
    at: AT,
    title: meta.title,
    text: meta.text,
    url: meta.url,
    total: 4,
    files: []
  })
  t.alike(second, first)
  t.is(first.files.length, 4)
  for (let n = 0; n < files.length; n++) {
    const file = first.files[n]
    t.ok(file instanceof File)
    t.is(file.name, 'foto-' + n)
    t.is(file.type, types[n])
    t.is(file.size, 7)
    t.is(await file.text(), 'bytes-' + n)
    t.is(await second.files[n].text(), await file.text())
  }
  t.alike(Array.from(entries.keys()), before)
  const { acceptShare } = await import('../src/sharedIntent.js')
  const accepted = acceptShare(first, AT)
  t.is(accepted.id, ID)
  t.is(accepted.files[0], first.files[0])
  t.is(accepted.failed, 0)
})

test('web intake chooses the newest id regardless of insertion order', async (t) => {
  const { entries } = fake(t)
  const web = await load()
  store(entries, OTHER, { text: 'Mais recente' })
  store(entries)
  entries.set(key(ID, 0), new Response('older file'))
  const got = await web.peek()
  t.is(got.id, OTHER)
  t.is(got.at, AT + 1)
  t.is(got.text, 'Mais recente')
  t.is(entries.size, 3)
})

test('web intake ignores bad metadata and malformed keys', async (t) => {
  const { entries } = fake(t)
  const web = await load()
  const valid = store(entries, OTHER)
  const bad = [
    '{',
    'null',
    '[]',
    JSON.stringify({ ...valid, v: 2 }),
    JSON.stringify({ ...valid, v: '1' }),
    JSON.stringify({ ...valid, id: ID }),
    JSON.stringify({ ...valid, at: AT }),
    JSON.stringify({ ...valid, at: String(AT + 1) }),
    JSON.stringify({ ...valid, files: null }),
    JSON.stringify({ ...valid, files: {} })
  ]
  for (const body of bad) {
    entries.clear()
    entries.set(key(OTHER), new Response(body))
    t.is(await web.peek(), null, body)
    store(entries)
    t.is((await web.peek()).id, ID, 'an invalid newer meta does not hide a valid share')
  }
  entries.clear()
  entries.set(key(OTHER), null)
  t.is(await web.peek(), null, 'a missing meta response is ignored')
  entries.clear()
  for (const url of [
    key('bad'),
    key(OTHER + 'x'),
    key(OTHER) + '/extra',
    key(OTHER) + '?query=1',
    key(OTHER) + '#fragment',
    ORIGIN + '/other/' + OTHER + '/meta'
  ]) entries.set(url, new Response(JSON.stringify(valid)))
  t.is(await web.peek(), null)
})

test('web intake skips missing and unsupported files', async (t) => {
  const { entries } = fake(t)
  const web = await load()
  store(entries, ID, {
    total: 10,
    files: [
      { n: 0, mime: 'image/png' },
      { n: 1, mime: 'image/jpeg' },
      { n: 2, mime: 'video/mp4' },
      { n: 3, mime: 'image/gif' },
      { n: 4, mime: 'image/webp' },
      { n: '../elsewhere', mime: 'image/png' },
      { n: -1, mime: 'image/png' },
      { n: 0.5, mime: 'image/png' },
      { n: 5, mime: 'image/svg+xml' },
      null
    ]
  })
  for (const n of [0, 2, 3, 4, 5]) entries.set(key(ID, n), new Response('bytes'))
  const got = await web.peek()
  t.alike(got.files.map((file) => file.name), ['foto-0', 'foto-3', 'foto-4'])
  t.alike(got.files.map((file) => file.type), ['image/png', 'image/gif', 'image/webp'])
  t.is(got.total, 10)
  t.is(await got.files[1].text(), 'bytes')
  t.is(entries.size, 6)
})

test('web intake keeps a share whose photo cannot be read yet', async (t) => {
  const { entries, cache, deleted } = fake(t)
  const web = await load()
  store(entries, ID, { total: 2, files: [{ n: 0, mime: 'image/png' }, { n: 1, mime: 'image/jpeg' }] })
  entries.set(key(ID, 0), new Response('zero'))
  entries.set(key(ID, 1), new Response('one'))
  const match = cache.match
  let failing = 'blob'
  cache.match = async (url) => {
    if (url === key(ID, 1) && failing === 'blob') return { async blob () { throw new Error('unreadable') } }
    if (url === key(ID, 1) && failing === 'match') throw new Error('unreadable')
    return match(url)
  }
  t.is(await web.peek(), null, 'a body that throws is not offered without its photos')
  failing = 'match'
  t.is(await web.peek(), null, 'nor a lookup that throws')
  t.is(entries.size, 3, 'nothing removed')
  t.alike(deleted, [])
  failing = null
  const got = await web.peek()
  t.is(got.id, ID, 'offered once it reads')
  t.alike(got.files.map((file) => file.name), ['foto-0', 'foto-1'])
})

test('web intake release validates ids and removes only that share', async (t) => {
  const { entries, opened } = fake(t)
  const web = await load()
  store(entries)
  entries.set(key(ID, 0), new Response('photo'))
  store(entries, OTHER)
  entries.set(key(OTHER, 0), new Response('other photo'))
  entries.set(ORIGIN + '/unrelated', new Response('unrelated'))
  entries.set(key(ID + 'x'), new Response('malformed'))
  const before = Array.from(entries.keys())
  for (const id of [null, undefined, '', 1, {}, ID.toUpperCase(), ID + '\n', ID + '/meta', ID.slice(1)]) {
    t.is(await web.release(id), undefined)
  }
  t.alike(opened, [])
  t.alike(Array.from(entries.keys()), before)
  t.is(await web.release(ID), undefined)
  t.alike(Array.from(entries.keys()), before.filter((url) => !url.startsWith(key(ID, ''))))
  t.is((await web.peek()).id, OTHER)
  t.is(await web.release(ID), undefined)
})

test('web intake release deletes metadata before bodies', async (t) => {
  const { entries, deleted } = fake(t)
  const web = await load()
  entries.set(key(ID, 0), new Response('photo'))
  entries.set(key(ID, 1), new Response('other photo'))
  store(entries)
  await web.release(ID)
  t.alike(deleted, [key(ID), key(ID, 0), key(ID, 1)])
  t.is(entries.size, 0)
})

test('web intake does not offer a share after an interrupted release', async (t) => {
  const { entries, cache, deleted } = fake(t)
  const web = await load()
  entries.set(key(ID, 0), new Response('photo'))
  store(entries, ID, { total: 1, files: [{ n: 0, mime: 'image/png' }] })
  const remove = cache.delete
  cache.delete = async (request) => {
    if (deleted.length) throw new Error('interrupted')
    return remove(request)
  }
  t.is(await web.release(ID), undefined)
  t.is(await web.peek(), null)
  t.ok(entries.has(key(ID, 0)))
  t.absent(entries.has(key(ID)))
})

test('web intake clear removes every stored share, metadata before bodies', async (t) => {
  const { entries, deleted } = fake(t)
  const web = await load()
  const dateNow = Date.now
  Date.now = () => AT
  t.teardown(() => { Date.now = dateNow })
  const later = (AT + 60000) + '-' + 'f'.repeat(32)
  entries.set(key(ID, 0), new Response('photo'))
  store(entries)
  store(entries, OTHER)
  entries.set(key(OTHER, 0), new Response('other photo'))
  store(entries, later)
  entries.set(ORIGIN + '/unrelated', new Response('unrelated'))
  t.is(await web.clear(), undefined)
  t.is(await web.peek(), null, 'nothing is offered afterwards, a share stamped later than now included')
  t.alike(Array.from(entries.keys()), [ORIGIN + '/unrelated'])
  for (const id of [ID, OTHER]) {
    t.ok(deleted.indexOf(key(id)) < deleted.indexOf(key(id, 0)), 'meta goes first')
  }
})

test('web intake clear never throws on cache failures', async (t) => {
  const { entries, cache } = fake(t)
  const web = await load()
  store(entries)
  cache.delete = async () => { throw new Error('denied') }
  t.is(await web.clear(), undefined)
  cache.keys = async () => { throw new Error('denied') }
  t.is(await web.clear(), undefined)
  globalThis.caches = { open () { throw new Error('denied') } }
  t.is(await web.clear(), undefined)
})

test('web intake sweep deletes expired metadata before bodies', async (t) => {
  const { entries, deleted } = fake(t)
  const web = await load()
  const dateNow = Date.now
  Date.now = () => AT + 1000
  t.teardown(() => { Date.now = dateNow })
  entries.set(key(ID, 0), new Response('photo'))
  store(entries)
  await web.sweep(100)
  t.alike(deleted, [key(ID), key(ID, 0)])
  t.is(entries.size, 0)
})

test('web intake considers only the first ten file entries', async (t) => {
  const { entries, cache } = fake(t)
  const web = await load()
  const files = Array.from({ length: 12 }, (_, n) => ({ n, mime: 'image/png' }))
  store(entries, ID, { total: 12, files })
  for (const { n } of files) entries.set(key(ID, n), new Response('photo'))
  const matched = []
  const match = cache.match
  cache.match = async (url) => {
    matched.push(url)
    return match(url)
  }
  const got = await web.peek()
  t.alike(got.files.map((file) => file.name), files.slice(0, 10).map(({ n }) => 'foto-' + n))
  t.alike(matched, [key(ID), ...files.slice(0, 10).map(({ n }) => key(ID, n))])
  t.is(got.total, 12)
})

test('web intake reads each file number only once', async (t) => {
  const { entries, cache } = fake(t)
  const web = await load()
  store(entries, ID, { files: [{ n: 0, mime: 'image/png' }, { n: 0, mime: 'image/gif' }] })
  entries.set(key(ID, 0), new Response('photo'))
  let reads = 0
  const match = cache.match
  cache.match = async (url) => {
    if (url === key(ID, 0)) reads++
    return match(url)
  }
  const got = await web.peek()
  t.is(got.files.length, 1)
  t.is(got.files[0].type, 'image/png')
  t.is(reads, 1)
})

test('web intake skips bodies larger than fifty MiB', async (t) => {
  const { entries, cache } = fake(t)
  const web = await load()
  store(entries, ID, { total: 1, files: [{ n: 0, mime: 'image/png' }] })
  const match = cache.match
  cache.match = async (url) => {
    if (url === key(ID, 0)) return { async blob () { return { size: 50 * 1024 * 1024 + 1, type: 'image/png' } } }
    return match(url)
  }
  const got = await web.peek()
  t.alike(got.files, [])
  t.is(got.total, 1)
})

test('web intake skips empty bodies', async (t) => {
  const { entries } = fake(t)
  const web = await load()
  store(entries, ID, { total: 1, files: [{ n: 0, mime: 'image/png' }] })
  entries.set(key(ID, 0), new Response(''))
  const got = await web.peek()
  t.alike(got.files, [])
  t.is(got.total, 1)
})

test('web intake skips oversized metadata and falls back to an older share', async (t) => {
  const { entries, cache } = fake(t)
  const web = await load()
  store(entries)
  const meta = store(entries, OTHER, { text: 'x'.repeat(1048576) })
  const body = JSON.stringify(meta)
  let parsed = false
  const match = cache.match
  cache.match = async (url) => {
    if (url === key(OTHER)) {
      return {
        async text () { return body },
        async json () { parsed = true; return meta }
      }
    }
    return match(url)
  }
  t.ok(body.length > 1048576)
  t.is((await web.peek()).id, ID)
  t.is(parsed, false)
  entries.delete(key(ID))
  t.ok((await web.peek()) === null)
})

test('web intake reads the largest metadata the worker can write', async (t) => {
  const { entries } = fake(t)
  const web = await load()
  const field = '\u0001'.repeat(4000)
  const meta = store(entries, ID, { title: field, text: field, url: field })
  t.ok(JSON.stringify(meta).length > 65536, 'three escaped 4000 character fields')
  t.is((await web.peek()).text, field)
})

test('web intake normalizes non-string fields and invalid totals', async (t) => {
  const { entries } = fake(t)
  const web = await load()
  for (const total of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    store(entries, ID, { title: {}, text: [], url: 42, total })
    const got = await web.peek()
    t.alike([got.title, got.text, got.url], ['', '', ''])
    t.is(got.total, 0)
  }
})

test('web intake sweep uses the id timestamp and preserves the age boundary', async (t) => {
  const { entries, opened } = fake(t)
  const web = await load()
  const now = AT + 1000
  const dateNow = Date.now
  Date.now = () => now
  t.teardown(() => { Date.now = dateNow })
  const boundary = (now - 100) + '-' + 'c'.repeat(32)
  const orphan = (now - 101) + '-' + 'd'.repeat(32)
  store(entries, ID, { at: now })
  entries.set(key(ID, 0), new Response('old'))
  entries.set(key(orphan, 1), new Response('orphan'))
  store(entries, boundary)
  store(entries, now + '-' + 'e'.repeat(32))
  entries.set(key('bad'), new Response('unrelated'))
  entries.set(ORIGIN + '/other/' + ID + '/meta', new Response('unrelated'))
  for (const age of [undefined, null, 0, -1, 0.5, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER + 1]) {
    t.is(await web.sweep(age), undefined)
  }
  t.alike(opened, [])
  const before = Array.from(entries.keys())
  t.is(await web.sweep(100), undefined)
  t.alike(Array.from(entries.keys()), before.filter((url) => !url.startsWith(key(ID, '')) && !url.startsWith(key(orphan, ''))))
  t.ok(entries.has(key(boundary)))
})

test('web intake contains cache failures and continues after a failed deletion', async (t) => {
  const { entries, cache } = fake(t)
  const web = await load()
  const storage = globalThis.caches
  for (const open of [() => { throw new Error('denied') }, async () => { throw new Error('denied') }]) {
    globalThis.caches = { open }
    t.is(await web.peek(), null)
    t.is(await web.release(ID), undefined)
    t.is(await web.sweep(100), undefined)
  }
  globalThis.caches = storage
  const keys = cache.keys
  cache.keys = async () => { throw new Error('denied') }
  t.is(await web.peek(), null)
  t.is(await web.release(ID), undefined)
  t.is(await web.sweep(100), undefined)
  cache.keys = keys
  store(entries, ID, { total: 1, files: [{ n: 0, mime: 'image/png' }] })
  const match = cache.match
  cache.match = async () => { throw new Error('denied') }
  t.is(await web.peek(), null)
  cache.match = match
  entries.set(key(ID, 0), new Response('photo'))
  const remove = cache.delete
  cache.delete = async (request) => {
    if (request.url === key(ID)) throw new Error('denied')
    return remove(request)
  }
  t.is(await web.release(ID), undefined)
  t.ok(entries.has(key(ID)))
  t.ok(entries.has(key(ID, 0)))
  const got = await web.peek()
  t.is(got.id, ID)
  t.is(got.files.length, 1)
  t.is(await got.files[0]?.text(), 'photo')
})
