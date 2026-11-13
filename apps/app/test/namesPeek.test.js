'use strict'

// Naming a key whose profile record is still in the middle of a diary the
// browser node has not downloaded (src/namesPeek.js, #436).
const test = require('brittle')
const load = () => import('../src/namesPeek.js')

const KEY = 'ab'.repeat(32)
const KEY2 = 'cd'.repeat(32)
const WEB_ONLY = Object.assign(new Error('leitura sob demanda só na versão web'), { code: 'USAGE' })

function harness (over = {}) {
  const calls = { lookup: [], peek: [] }
  const deps = {
    enabled: true,
    lookup: async (key) => { calls.lookup.push(key); return { ok: true, value: { profileSeq: 7, usernameSeq: 3 } } },
    peek: async (params) => {
      calls.peek.push(params)
      return { key: params.author, length: 99, entries: [], invalid: [], missing: [], profile: { name: 'Ana', bio: 'oi', avatar: null }, username: 'ana' }
    },
    ...over
  }
  return { calls, deps }
}

test('a key without a name gets the verified profile named by the index', async (t) => {
  const { createNamePeeker } = await load()
  const { calls, deps } = harness()
  const peeker = createNamePeeker(deps)
  t.is(peeker.enqueue([KEY]), 1)
  const done = await peeker.next()
  t.alike(calls.lookup, [KEY], 'the index is asked for the key')
  t.alike(calls.peek, [{ author: KEY, seqs: [3, 7], profileSeq: 7, usernameSeq: 3 }], 'diary.peek reads the blocks the index names')
  t.alike(done, { key: KEY, fields: { name: 'Ana', username: 'ana', bio: 'oi', avatar: null } })
  t.alike(peeker.foundFor(KEY), { fields: done.fields, base: null }, 'remembered for the next profile.read')
})

test('params: sorted distinct seqs, hints only when valid, null when the index names none', async (t) => {
  const { peekParams } = await load()
  t.alike(peekParams(KEY, { profileSeq: 5, usernameSeq: 5 }), { author: KEY, seqs: [5], profileSeq: 5, usernameSeq: 5 })
  t.alike(peekParams(KEY, { profileSeq: 9, usernameSeq: null }), { author: KEY, seqs: [9], profileSeq: 9 })
  t.alike(peekParams(KEY, { profileSeq: null, usernameSeq: 4 }), { author: KEY, seqs: [4], usernameSeq: 4 })
  t.is(peekParams(KEY, { profileSeq: null, usernameSeq: null }), null)
  t.is(peekParams(KEY, { profileSeq: 0, usernameSeq: -1 }), null, 'seqs start at 1')
  t.is(peekParams(KEY, { profileSeq: 1.5, usernameSeq: '2' }), null)
  t.is(peekParams(KEY, null), null)
})

test('an answer with no name and no @nome names nobody', async (t) => {
  const { peekFields } = await load()
  t.is(peekFields(null), null)
  t.is(peekFields({ profile: null, username: null }), null)
  t.is(peekFields({ profile: { name: '', bio: 'x', avatar: null }, username: '' }), null)
  t.alike(peekFields({ profile: null, username: 'ana' }), { name: null, username: 'ana' }, 'an @nome alone is enough')
})

test('no new request when the index has nothing, the node is the core node or the key is named', async (t) => {
  const { createNamePeeker } = await load()

  const none = harness({ lookup: async () => ({ ok: false }) })
  const a = createNamePeeker(none.deps)
  a.enqueue([KEY])
  t.alike(await a.next(), { key: KEY, fields: null }, 'seeder without an index')
  t.is(none.calls.peek.length, 0, 'no diary.peek')

  const blind = harness({ lookup: async () => ({ ok: true, value: { profileSeq: null, usernameSeq: null } }) })
  const b = createNamePeeker(blind.deps)
  b.enqueue([KEY])
  await b.next()
  t.is(blind.calls.peek.length, 0, 'an index with no profile block')

  const off = harness()
  const c = createNamePeeker({ ...off.deps, enabled: false })
  t.is(c.enqueue([KEY]), 0, 'not the browser node')
  t.is(await c.next(), null)
  t.is(off.calls.lookup.length + off.calls.peek.length, 0)

  const core = harness({ peek: async () => { throw WEB_ONLY } })
  const d = createNamePeeker(core.deps)
  d.enqueue([KEY, KEY2])
  t.alike(await d.next(), { key: KEY, fields: null })
  t.ok(d.off, 'the core node answered USAGE: switched off')
  t.is(d.size, 0, 'the queue is dropped')
  t.is(d.enqueue([KEY2]), 0)
  t.is(await d.next(), null)
  t.is(core.calls.lookup.length, 1, 'one index read in all')
})

test('a key is tried a few times at most: a passing failure is asked again only when listed anew, a hit never', async (t) => {
  const { createNamePeeker } = await load()
  let n = 0
  const flaky = harness({ peek: async () => { n++; throw Object.assign(new Error('semeador indisponível'), { code: 'NOT_FOUND' }) } })
  const a = createNamePeeker(flaky.deps)
  a.enqueue([KEY])
  t.alike(await a.next(), { key: KEY, fields: null })
  t.is(a.size, 0, 'nothing is retried by itself')
  t.is(await a.next(), null)
  t.is(n, 1)
  t.is(a.enqueue([KEY]), 1, 'listed anew: one more turn')
  await a.next()
  t.is(a.enqueue([KEY]), 1, 'and a third')
  await a.next()
  t.is(a.enqueue([KEY]), 0, 'then given up for the scope')
  t.is(n, 3)
  t.not(a.off, 'a plain failure keeps the other keys going')

  let ready = false
  const late = harness({ lookup: async () => (ready ? { ok: true, value: { profileSeq: 7, usernameSeq: null } } : { ok: false }) })
  const c = createNamePeeker(late.deps)
  c.enqueue([KEY])
  t.alike(await c.next(), { key: KEY, fields: null }, 'the index is not ready yet')
  ready = true
  t.is(c.enqueue([KEY]), 1, 'a not ready index gets another turn')
  t.is((await c.next()).fields.name, 'Ana')
  t.is(c.enqueue([KEY]), 0, 'a hit is not asked again')

  const none = harness({ lookup: async () => ({ ok: true, value: {} }) })
  const d = createNamePeeker(none.deps)
  d.enqueue([KEY])
  await d.next()
  t.is(d.enqueue([KEY]), 0, 'an index that names no block is a final answer')

  const ok = harness()
  const b = createNamePeeker(ok.deps)
  b.enqueue([KEY, KEY, KEY2])
  t.is(b.size, 2, 'duplicates collapse')
  await b.next()
  t.is(b.enqueue([KEY]), 1, 'only the second key waits: the first was found')
  await b.next()
  t.is(ok.calls.peek.length, 2)
  t.is(b.enqueue([KEY, KEY2]), 0)
})

test('one key at a time, in the order they were queued', async (t) => {
  const { createNamePeeker } = await load()
  let open = 0
  let most = 0
  const h = harness({
    peek: async (params) => {
      open++
      most = Math.max(most, open)
      await new Promise((resolve) => setImmediate(resolve))
      open--
      return { profile: { name: params.author.slice(0, 2), bio: null, avatar: null }, username: null }
    }
  })
  const peeker = createNamePeeker(h.deps)
  peeker.enqueue([KEY, KEY2])
  const first = await peeker.next()
  const second = await peeker.next()
  t.is(first.key, KEY)
  t.is(second.key, KEY2)
  t.is(most, 1)
})

test('withPeek fills only what profile.read left empty and marks the entry loaded', async (t) => {
  const { withPeek, unnamed } = await load()
  const fields = { name: 'Ana', username: 'ana', bio: 'oi', avatar: null }
  t.ok(unnamed(null))
  t.ok(unnamed({ name: null, username: null, bio: 'só bio', avatar: null, loaded: true }))
  t.absent(unnamed({ name: null, username: 'ana', bio: null, avatar: null, loaded: true }))
  t.alike(withPeek(null, fields), { name: 'Ana', username: 'ana', bio: 'oi', avatar: null, loaded: true }, 'a missing profile')
  t.alike(
    withPeek({ name: null, username: null, bio: null, avatar: null, loaded: true, page: true, closed: false, moved: false }, fields),
    { name: 'Ana', username: 'ana', bio: 'oi', avatar: null, loaded: true, page: true, closed: false, moved: false },
    'the page flags stay'
  )
  t.is(withPeek(null, { name: null, username: null }), null, 'nothing to fill')
})

test('withPeek never replaces what profile.read already brought', async (t) => {
  const { withPeek, partial } = await load()
  const fields = { name: 'Ana', username: 'ana', bio: 'oi', avatar: null }
  const onlyUsername = { name: null, username: 'ana2', bio: null, avatar: null, loaded: true }
  t.ok(partial(onlyUsername))
  t.absent(partial({ name: 'A', username: 'a', bio: null, avatar: null, loaded: true }))
  t.alike(
    withPeek(onlyUsername, fields),
    { name: 'Ana', username: 'ana2', bio: 'oi', avatar: null, loaded: true },
    'the name fills in, the @nome stays'
  )
  const onlyName = { name: 'Bia', username: null, bio: 'minha', avatar: null, loaded: true }
  t.alike(
    withPeek(onlyName, fields),
    { name: 'Bia', username: 'ana', bio: 'minha', avatar: null, loaded: true },
    'the @nome fills in, name and bio stay'
  )
})

test('foldRead: a key in missing stores null even after a successful peek, and is not peeked', async (t) => {
  const { createNamePeeker, foldRead, withPeek } = await load()
  const { deps } = harness()
  const peeker = createNamePeeker(deps)
  peeker.enqueue([KEY])
  const done = await peeker.next()
  peeker.remember(KEY, null)
  t.ok(done.fields, 'the peek named the key')
  const out = foldRead({ profiles: [], missing: [KEY.toUpperCase()] }, peeker)
  t.is(out.entries.get(KEY), null, 'missing stores null')
  t.alike(out.lonely, [], 'and the key is not queued for a peek')
  t.ok(withPeek(null, done.fields), 'the fields themselves are still there')
})

test('foldRead: the peeked fields come back only while the local copy has not moved since the peek', async (t) => {
  const { createNamePeeker, foldRead } = await load()
  const { deps } = harness()
  const peeker = createNamePeeker(deps)
  peeker.enqueue([KEY])
  await peeker.next()
  const base = { name: null, username: null, bio: null, avatar: null, loaded: true }
  peeker.remember(KEY, base)
  const read = (p) => foldRead({ profiles: [{ author: KEY, name: null, username: null, bio: null, avatar: null, ...p }], missing: [] }, peeker).entries.get(KEY)

  t.is(read({}).name, 'Ana', 'nothing new downloaded: the peeked name stays')
  t.is(read({}).username, 'ana')
  t.is(read({ username: 'ana2' }).username, 'ana2', 'a newer @nome wins')
  t.is(read({ username: 'ana2' }).name, 'Ana', 'and the name does not blink out meanwhile')
  const empty = read({ name: 'Bia', bio: null })
  t.is(empty.name, 'Bia', 'a newer profile record wins')
  t.is(empty.bio, null, 'its removed bio is not brought back')
  t.is(empty.username, 'ana', 'the untouched @nome still fills')
})
