'use strict'

// Saved posts (src/savedPosts.js). ES module loaded through import(); read
// and write are in-memory fakes.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/savedPosts.js')
const O1 = 'https://bora.varanda.app'
const O2 = 'https://outra.example.org'
const key = (i) => i.toString(16).padStart(64, '0')
const ref = (i, seq = 1) => ({ author: key(i), seq })

function disk (initial = null) {
  const d = { raw: initial, writes: 0 }
  d.read = async () => d.raw
  d.write = async (raw) => { d.writes++; d.raw = raw }
  return d
}

test('add, has, load and remove', async (t) => {
  const s = await load()
  const store = s.createSavedStore({ ...disk(), now: () => 5 })
  t.alike(await store.load(O1, key(9)), [])
  t.alike(await store.add(O1, key(9), ref(1)), { ok: true, persisted: true })
  t.alike(await store.add(O1, key(9), ref(2, 5)), { ok: true, persisted: true })
  t.ok(await store.has(O1, key(9), ref(1)))
  t.absent(await store.has(O1, key(9), ref(1, 2)))
  t.alike(await store.load(O1, key(9)), [{ ...ref(2, 5), savedAt: 5 }, { ...ref(1), savedAt: 5 }], 'newest first')
  t.ok(await store.remove(O1, key(9), ref(1)))
  t.absent(await store.has(O1, key(9), ref(1)))
  t.alike(await store.add(O1, key(9), { author: 'x', seq: 1 }), { ok: false, reason: 'invalid', persisted: false })
  t.alike(await store.add(O1, key(9), ref(3, 0)), { ok: false, reason: 'invalid', persisted: false })
})

test('two accounts and two origins stay apart', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  await store.add(O1, key(8), ref(1))
  await store.add(O1, key(9), ref(2))
  await store.add(O2, key(8), ref(3))
  t.alike((await store.load(O1, key(8))).map((e) => e.author), [key(1)])
  t.alike((await store.load(O1, key(9))).map((e) => e.author), [key(2)])
  t.alike((await store.load(O2, key(8))).map((e) => e.author), [key(3)])
  t.absent(await store.has(O1, key(9), ref(1)))
  const again = s.createSavedStore(d)
  t.alike((await again.load(O1, key(8))).map((e) => e.author), [key(1)], 'survives a new store')
})

test('the cap refuses with a reason and drops nothing', async (t) => {
  const s = await load()
  const store = s.createSavedStore(disk())
  for (let i = 1; i <= s.MAX_SAVED; i++) t.ok((await store.add(O1, key(9), ref(i))).ok)
  t.alike(await store.add(O1, key(9), ref(500)), { ok: false, reason: 'full', persisted: false })
  t.is((await store.load(O1, key(9))).length, s.MAX_SAVED)
  t.ok(await store.has(O1, key(9), ref(1)), 'oldest kept')
  t.ok((await store.add(O1, key(9), ref(1))).ok, 'saving a saved post is fine')
  t.ok((await store.add(O1, key(8), ref(500))).ok, 'another account is not full')
  await store.remove(O1, key(9), ref(1))
  t.ok((await store.add(O1, key(9), ref(500))).ok, 'room after a removal')
})

test('malformed storage is untrusted', async (t) => {
  const s = await load()
  for (const raw of [null, '', 'nope', '{', '[]', '{"v":2,"scopes":[]}', '{"v":1}', '{"v":1,"scopes":"x"}']) {
    t.is(s.sanitize(raw).size, 0, String(raw))
  }
  const good = { author: key(1), seq: 1, savedAt: 7 }
  const raw = JSON.stringify({
    v: 1,
    scopes: [
      null,
      { origin: 'javascript:alert(1)', key: key(9), entries: [good] },
      { origin: O1, key: 'short', entries: [good] },
      { origin: O1, key: key(9), entries: 'x' },
      {
        origin: O1,
        key: key(9),
        entries: [
          good,
          { ...good },
          { author: key(2), seq: 0 },
          { author: key(2), seq: 1.5 },
          { author: 'ZZ', seq: 1 },
          { author: key(3), seq: 2, savedAt: 'late', title: 'peer text' },
          null,
          7
        ]
      },
      { origin: O1, key: key(9), entries: [{ author: key(4), seq: 1 }] }
    ]
  })
  const map = s.sanitize(raw)
  t.is(map.size, 1)
  const entries = [...map.values()][0].entries
  t.alike(entries, [good, { author: key(3), seq: 2, savedAt: 0 }], 'no extra field survives')
  const store = s.createSavedStore(disk(raw))
  t.is((await store.load(O1, key(9))).length, 2)
})

test('too many saved entries or scopes are cut', async (t) => {
  const s = await load()
  const entries = Array.from({ length: s.MAX_SAVED + 20 }, (_, i) => ({ author: key(i + 1), seq: 1, savedAt: 1 }))
  const scopes = Array.from({ length: s.MAX_ORIGINS + 3 }, (_, i) => ({ origin: O1, key: key(i + 1), entries: [entries[0]] }))
  const kept = [...s.sanitize(JSON.stringify({ v: 1, scopes })).values()].map((x) => x.key)
  t.alike(kept, scopes.slice(-s.MAX_ORIGINS).map((x) => x.key), 'the last scopes are kept')
  t.is([...s.sanitize(JSON.stringify({ v: 1, scopes: [{ origin: O1, key: key(1), entries }] })).values()][0].entries.length, s.MAX_SAVED)
  t.is(s.sanitize(JSON.stringify({ v: 1, scopes })).size, s.MAX_ORIGINS)
})

test('forgetScope removes only that account', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  await store.add(O1, key(8), ref(1))
  await store.add(O1, key(9), ref(2))
  t.ok(await store.forgetScope(O1, key(8)))
  t.alike(await store.load(O1, key(8)), [])
  t.is((await store.load(O1, key(9))).length, 1)
  t.absent(d.raw.includes(key(1)), 'gone from storage')
  t.ok(await store.forgetScope(O2, key(8)), 'unknown scope is fine')
  t.absent(await store.forgetScope('nope', key(8)))
})

test('forgetKey removes the account under every origin and keeps the others', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  await store.add(O1, key(8), ref(1))
  await store.add(O2, key(8), ref(2))
  await store.add(O1, key(9), ref(3))
  t.ok(await store.forgetKey(key(8)))
  t.alike(await store.load(O1, key(8)), [])
  t.alike(await store.load(O2, key(8)), [])
  t.is((await store.load(O1, key(9))).length, 1)
  t.ok(await store.forgetKey(key(8)), 'nothing left to forget is fine')
  t.absent(await store.forgetKey('nope'))
})

test('forgetKey with a failed read keeps memory only and answers false', async (t) => {
  const s = await load()
  const d = disk()
  await s.createSavedStore(d).add(O1, key(8), ref(1))
  const before = d.raw
  d.writes = 0
  const store = s.createSavedStore({ read: async () => { throw new Error('r') }, write: d.write })
  t.absent(await store.forgetKey(key(8)))
  t.is(d.writes, 0, 'nothing written')
  t.is(d.raw, before, 'storage untouched')
})

test('storage that throws never rejects', async (t) => {
  const s = await load()
  const store = s.createSavedStore({ read: async () => { throw new Error('r') }, write: async () => { throw new Error('w') } })
  t.alike(await store.add(O1, key(9), ref(1)), { ok: true, persisted: false })
  t.ok(await store.has(O1, key(9), ref(1)), 'shown for this run')
  t.absent(await store.remove(O1, key(9), ref(1)))
})

test('a failed read never wipes the lists: memory only, persisted false', async (t) => {
  const s = await load()
  const d = disk()
  const first = s.createSavedStore(d)
  await first.add(O1, key(9), ref(1))
  const before = d.raw
  let failRead = false
  const store = s.createSavedStore({
    read: async () => { if (failRead) throw new Error('r'); return d.raw },
    write: d.write
  })
  t.is((await store.load(O1, key(9))).length, 1)
  d.writes = 0
  failRead = true
  t.alike(await store.add(O1, key(9), ref(2)), { ok: true, persisted: false })
  t.alike(await store.add(O1, key(9), ref(2)), { ok: true, persisted: false }, 'a saved ref is not claimed persisted')
  t.absent(await store.remove(O1, key(9), ref(1)))
  t.absent(await store.forgetScope(O1, key(9)))
  t.is(d.writes, 0, 'nothing written')
  t.is(d.raw, before, 'storage untouched')
  failRead = false
  t.is((await store.load(O1, key(9))).length, 1, 'the next good read wins')
})

test('scopes: never dropped silently, an emptied scope makes room', async (t) => {
  const s = await load()
  const store = s.createSavedStore(disk())
  for (let i = 1; i <= s.MAX_ORIGINS; i++) t.ok((await store.add(O1, key(i), ref(100))).ok)
  t.alike(await store.add(O1, key(50), ref(1)), { ok: false, reason: 'scopes', persisted: false })
  t.is((await store.load(O1, key(1))).length, 1, 'oldest scope kept')
  t.ok((await store.add(O1, key(1), ref(2))).ok, 'an existing scope can still add')
  t.ok(await store.remove(O1, key(3), ref(100)), 'a scope emptied by a remove')
  t.alike(await store.add(O1, key(50), ref(1)), { ok: true, persisted: true })
  t.is((await store.load(O1, key(50))).length, 1)
  t.alike(await store.load(O1, key(3)), [])
  t.ok(await store.forgetScope(O1, key(4)))
  t.ok((await store.add(O2, key(51), ref(1))).ok, 'a forgotten scope makes room too')
  t.ok(typeof s.SAVED_SCOPES_TEXT === 'string' && s.SAVED_SCOPES_TEXT.length > 0)
})

test('sanitize skips empty scopes before counting them', async (t) => {
  const s = await load()
  const empty = Array.from({ length: s.MAX_ORIGINS }, (_, i) => ({ origin: O1, key: key(i + 1), entries: [] }))
  const full = { origin: O2, key: key(99), entries: [{ author: key(1), seq: 1, savedAt: 1 }] }
  const map = s.sanitize(JSON.stringify({ v: 1, scopes: [full, ...empty] }))
  t.is(map.size, 1)
})

test('write-only failure: persisted false, gone after a fresh store', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore({ read: d.read, write: async () => { throw new Error('quota') } })
  t.alike(await store.add(O1, key(9), ref(1)), { ok: true, persisted: false })
  const again = s.createSavedStore({ read: d.read, write: d.write })
  t.absent(await again.has(O1, key(9), ref(1)))
  t.alike(await again.add(O1, key(9), ref(1)), { ok: true, persisted: true }, 'a retry writes it')
  t.alike(await again.add(O1, key(9), ref(1)), { ok: true, persisted: true }, 'saved and on disk')
})

test('add strips extra fields from the ref', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore({ ...d, now: () => 3 })
  await store.add(O1, key(9), { author: key(1), seq: 2, text: 'peer text', title: 'x', savedAt: 999 })
  t.alike(await store.load(O1, key(9)), [{ author: key(1), seq: 2, savedAt: 3 }])
  t.alike(JSON.parse(d.raw).scopes[0].entries, [{ author: key(1), seq: 2, savedAt: 3 }])
})

test('invalid origin, key or ref is refused everywhere', async (t) => {
  const s = await load()
  const d = disk()
  const store = s.createSavedStore(d)
  await store.add(O1, key(9), ref(1))
  for (const [o, k] of [['http://bora.varanda.app', key(9)], ['javascript:1', key(9)], [O1 + '/path', key(9)], [null, key(9)], [O1, 'short'], [O1, key(171).toUpperCase()], [O1, null]]) {
    t.alike(await store.add(o, k, ref(2)), { ok: false, reason: 'invalid', persisted: false })
    t.alike(await store.load(o, k), [])
    t.is(await store.has(o, k, ref(1)), false)
    t.is(await store.remove(o, k, ref(1)), false)
  }
  t.is(d.writes, 1, 'only the first add wrote')
})

test('an uppercase author is rejected', async (t) => {
  const s = await load()
  const store = s.createSavedStore(disk())
  t.alike(await store.add(O1, key(9), { author: key(171).toUpperCase(), seq: 1 }), { ok: false, reason: 'invalid', persisted: false })
  t.is(await store.has(O1, key(9), { author: key(171).toUpperCase(), seq: 1 }), false)
})

test('web store persists through localStorage; two stores share one storage', async (t) => {
  const map = new Map()
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) }
  }
  try {
    const s = await load()
    const web = await import('../src/savedPostsStore.web.js')
    t.alike(await web.addSaved(O1, key(9), ref(1)), { ok: true, persisted: true })
    t.ok(await web.hasSaved(O1, key(9), ref(1)))
    t.is(JSON.parse(map.get(s.STORAGE_KEY)).v, 1)
    const read = async () => map.get(s.STORAGE_KEY) || null
    const write = async (raw) => { map.set(s.STORAGE_KEY, raw) }
    const tab1 = s.createSavedStore({ read, write })
    const tab2 = s.createSavedStore({ read, write })
    await tab1.add(O1, key(9), ref(2))
    await tab2.add(O1, key(9), ref(3))
    t.alike((await tab1.load(O1, key(9))).map((e) => e.seq + ':' + e.author.slice(-1)), ['1:3', '1:2', '1:1'].map((x) => x), 'both stores see all saves')
    t.ok(await tab1.remove(O1, key(9), ref(2)))
    t.absent(await tab2.has(O1, key(9), ref(2)))
    t.ok(await tab2.has(O1, key(9), ref(3)))
    t.ok(await web.forgetSavedScope(O1, key(9)))
    t.alike(await tab1.load(O1, key(9)), [])
  } finally {
    delete globalThis.localStorage
  }
})

test('the module holds no network or RPC string', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/savedPosts.js'), 'utf8')
  t.absent(/fetch|XMLHttpRequest|WebSocket|diary\.peek|rpc|http:\/\//i.test(src.replace(/^\s*\/\/.*$/gm, '')))
  t.absent(src.includes(String.fromCharCode(0x2014)))
})
