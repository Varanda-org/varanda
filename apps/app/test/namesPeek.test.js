'use strict'

// Naming a key whose profile record is still in the middle of a diary the
// browser node has not downloaded (src/namesPeek.js, #436).
const test = require('brittle')
const load = () => import('../src/namesPeek.js')

const KEY = 'ab'.repeat(32)
const KEY2 = 'cd'.repeat(32)
const WEB_ONLY = Object.assign(new Error('leitura sob demanda só na versão web'), { code: 'USAGE' })

function keyAt (n) {
  return n.toString(16).padStart(2, '0').repeat(32)
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

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
  const late = harness({ lookup: async () => (ready ? { ok: true, value: { profileSeq: 7, usernameSeq: null } } : { ok: false, reason: 'network' }) })
  const c = createNamePeeker(late.deps)
  c.enqueue([KEY])
  t.alike(await c.next(), { key: KEY, fields: null }, 'the index is not ready yet')
  ready = true
  t.is(c.enqueue([KEY]), 1, 'a not ready index gets another turn')
  t.is((await c.next()).fields.name, 'Ana')
  t.is(c.enqueue([KEY]), 0, 'a hit is not asked again')

  for (const reason of ['not-found', 'malformed', 'invalid-input']) {
    const final = harness({ lookup: async () => ({ ok: false, reason }) })
    const e = createNamePeeker(final.deps)
    e.enqueue([KEY])
    await e.next()
    t.is(e.enqueue([KEY]), 0, 'an index answer of ' + reason + ' is final')
  }
  for (const reason of ['network', 'timeout', 'rate-limited', 'status']) {
    const passing = harness({ lookup: async () => ({ ok: false, reason }) })
    const e = createNamePeeker(passing.deps)
    e.enqueue([KEY])
    await e.next()
    t.is(e.enqueue([KEY]), 1, 'an index failure of ' + reason + ' gets another turn')
  }

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

test('a key queued for the peek and then answered missing is dropped, and a peek in flight does not land', async (t) => {
  const { createNamePeeker, foldRead, peekApply } = await load()
  const { calls, deps } = harness()
  const peeker = createNamePeeker(deps)
  const unnamed = { name: null, username: null, bio: null, avatar: null, loaded: true }

  t.is(peeker.enqueue([KEY]), 1, 'a profile.read left the key without a name')
  const out = foldRead({ profiles: [], missing: [KEY] }, peeker)
  t.is(out.entries.get(KEY), null, 'the next profile.read says missing')
  t.is(peeker.size, 0, 'the key left the queue')
  t.is(await peeker.next(), null, 'next asks nothing')
  t.is(calls.lookup.length + calls.peek.length, 0)

  peeker.enqueue([KEY2])
  const flight = peeker.next()
  foldRead({ profiles: [], missing: [KEY2] }, peeker)
  const done = await flight
  t.ok(done.fields, 'the read was already under way')
  t.is(peekApply(null, done.fields), null, 'but a key stored as missing is not named')
  t.is(peekApply(undefined, done.fields), null, 'nor one with no entry at all')
  t.is(peekApply({ ...unnamed, name: 'Bia' }, done.fields), null, 'nor one that shows a name')
  t.is(peekApply(unnamed, done.fields).name, 'Ana', 'an entry still without a name gets it')
})

test('a blank answer with an @nome is not queued for the peek, which may still read a deleted profile', async (t) => {
  const { createNamePeeker, foldRead, peekApply } = await load()
  const AV = { core: 'cd'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: 'ef'.repeat(32), width: 512, height: 512 }
  // The seeder index may still name the deleted profile block.
  const { calls, deps } = harness({ peek: async () => ({ profile: { name: 'Ana', bio: 'oi', avatar: AV }, username: 'ana' }) })
  const peeker = createNamePeeker(deps)
  const blank = { author: KEY, name: null, username: 'ana', bio: null, avatar: null }
  const out = foldRead({ profiles: [blank], missing: [] }, peeker)
  t.alike(out.lonely, [], 'not queued')
  t.is(peeker.enqueue(out.lonely), 0)
  t.is(await peeker.next(), null)
  t.is(calls.peek.length, 0, 'nothing read')
  t.is(peekApply(out.entries.get(KEY), { name: 'Ana', username: 'ana', bio: 'oi', avatar: AV }), null, 'and a peek in flight does not land on it')
})

test('the entry names.js stores for a blank answer lets the peek fill it', async (t) => {
  const { createNamePeeker, foldRead, peekApply } = await load()
  const { settleProfile, applySeed } = await import('../src/namesCache.js')
  const AV = { core: 'cd'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: 'ef'.repeat(32), width: 512, height: 512 }
  const { deps } = harness({ peek: async () => ({ profile: { name: 'Bia', bio: 'nova', avatar: AV }, username: null }) })
  const peeker = createNamePeeker(deps)
  const old = applySeed(null, { name: 'Ana', avatar: { ...AV, core: 'aa'.repeat(32) } })
  const out = foldRead({ profiles: [{ author: KEY, name: null, username: null, bio: null, avatar: null }], missing: [] }, peeker)
  t.alike(out.lonely, [KEY], 'queued: no name and no @nome')
  // As names.js settles it, given the entry it replaces too.
  const stored = settleProfile(out.entries.get(KEY), undefined, old).entry
  t.is(peeker.enqueue(out.lonely), 1)
  const done = await peeker.next()
  const filled = peekApply(stored, done.fields)
  t.ok(filled, 'the peek lands on the stored entry')
  t.is(filled && filled.name, 'Bia', 'with the verified name')
  t.is(filled && filled.bio, 'nova', 'bio')
  t.alike(filled && filled.avatar, AV, 'and photo, not the older seed')
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

test('nextBatch looks the batch up together and never has more than 2 peeks in flight', async (t) => {
  const { createNamePeeker } = await load()
  const keys = Array.from({ length: 8 }, (_, i) => keyAt(i + 1))
  const looked = []
  let lookupOpen = 0
  let lookupMost = 0
  let peekOpen = 0
  let peekMost = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const peeker = createNamePeeker({
    enabled: true,
    lookup: async (key) => {
      looked.push(key)
      lookupOpen++
      lookupMost = Math.max(lookupMost, lookupOpen)
      await tick()
      lookupOpen--
      return { ok: true, value: { profileSeq: 4, usernameSeq: null } }
    },
    peek: async (params) => {
      if (peekOpen === 0) t.is(looked.length, keys.length, 'the batch is looked up before a peek starts')
      peekOpen++
      peekMost = Math.max(peekMost, peekOpen)
      await gate
      peekOpen--
      return { profile: { name: params.author.slice(0, 2), bio: null, avatar: null }, username: null }
    }
  })
  peeker.enqueue(keys)
  const flight = peeker.nextBatch()
  const open = () => peekOpen
  for (let i = 0; i < 20 && open() < 2; i++) await tick()
  t.is(lookupMost, 8, 'the eight index lookups run together')
  t.is(peekOpen, 2, 'two peeks are in flight')
  t.is(peekMost, 2)
  t.is(peeker.size, 0, 'the batch has left the queue')
  release()
  const done = await flight
  t.alike(done.map((row) => row.key), keys, 'queue order')
  t.is(peekMost, 2, 'later peeks of the batch stay within two')
  t.ok(done.every((row) => row.fields && row.fields.name))
})

test('a web-only refusal in a batch turns the peeker off', async (t) => {
  const { createNamePeeker } = await load()
  const keys = Array.from({ length: 10 }, (_, i) => keyAt(i + 1))
  let peeks = 0
  const h = harness({
    peek: async () => {
      peeks++
      throw WEB_ONLY
    }
  })
  const peeker = createNamePeeker(h.deps)
  peeker.enqueue(keys)
  const done = await peeker.nextBatch()
  t.is(done.length, 8, 'the batch already taken is answered')
  t.ok(done.every((row) => row.fields === null))
  t.ok(peeker.off, 'the core node answered USAGE: switched off')
  t.is(peeker.size, 0, 'keys not yet taken leave the queue too')
  t.is(peeks, 2, 'no peek starts after the refusal')
  t.is(peeker.enqueue([keyAt(20)]), 0)
  t.is((await peeker.nextBatch()).length, 0)
  t.is(await peeker.next(), null)
  t.is(h.calls.lookup.length, 8, 'the batch was looked up, and nothing further')
})

test('nextBatch keeps the retry cap: three tries, and a failure is not sent again by itself', async (t) => {
  const { createNamePeeker } = await load()
  let n = 0
  const h = harness({ peek: async () => { n++; throw new Error('semeador indisponível') } })
  const peeker = createNamePeeker(h.deps)
  peeker.enqueue([KEY, KEY2])
  t.is((await peeker.nextBatch()).length, 2)
  t.is(peeker.size, 0, 'nothing is retried by itself')
  t.is(peeker.enqueue([KEY, KEY2]), 2, 'listed anew: one more turn')
  await peeker.nextBatch()
  t.is(peeker.enqueue([KEY, KEY2]), 2, 'and a third')
  await peeker.nextBatch()
  t.is(peeker.enqueue([KEY, KEY2]), 0, 'then given up for the scope')
  t.is(n, 6, 'three tries for each of the two keys')
  t.is(peeker.off, false, 'a plain failure keeps the peeker on')
})

test('25 queued keys finish on the peek critical path, not one gap per key', async (t) => {
  const { createNamePeeker } = await load()
  // Nominal diary.peek cost. The schedule is stepped by hand, so the figure
  // does not depend on how slow the timers are under load.
  const PEEK_LATENCY_MS = 40
  const keys = Array.from({ length: 25 }, (_, i) => keyAt(i + 1))
  const waiting = []
  let open = 0
  let most = 0
  const peeker = createNamePeeker({
    enabled: true,
    lookup: async () => ({ ok: true, value: { profileSeq: 2, usernameSeq: null } }),
    peek: () => {
      open++
      most = Math.max(most, open)
      return new Promise((resolve) => {
        waiting.push(() => {
          open--
          resolve({ profile: { name: 'Ana', bio: null, avatar: null }, username: null })
        })
      })
    }
  })
  peeker.enqueue(keys)
  const rows = []
  let done = false
  const started = Date.now()
  const flight = (async () => {
    while (rows.length < keys.length) {
      const batch = await peeker.nextBatch()
      if (batch.length === 0) break
      rows.push(...batch)
    }
    done = true
  })()
  let waves = 0
  const finished = () => done
  for (let guard = 0; guard < 40 && !finished(); guard++) {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    if (waiting.length === 0) continue
    const wave = waiting.splice(0, waiting.length)
    t.ok(wave.length <= 2, 'a wave has at most 2 peeks')
    waves++
    for (const release of wave) release()
  }
  const elapsed = Date.now() - started
  t.ok(done, 'the queue drained')
  if (!done) return
  await flight
  const measured = waves * PEEK_LATENCY_MS
  const serial = keys.length * PEEK_LATENCY_MS
  t.comment('measured ' + measured + ' ms (' + waves + ' waves x ' + PEEK_LATENCY_MS + ' ms peek latency; wall ' + elapsed + ' ms)')
  t.is(rows.length, 25)
  t.ok(most <= 2, 'never more than 2 peeks in flight')
  t.is(waves, 13, 'ceil(8/2) waves for three batches, plus the last key')
  t.ok(measured < serial, 'measured ' + measured + ' ms, under ' + serial + ' ms of one peek after another')
})

test('nextBatch asks lookupMany once per batch', async (t) => {
  const { createNamePeeker } = await load()
  const keys = Array.from({ length: 10 }, (_, i) => keyAt(i + 1))
  const seen = []
  let perKey = 0
  const peeker = createNamePeeker({
    enabled: true,
    lookup: async () => { perKey++; return { ok: false, reason: 'status' } },
    lookupMany: async (authors) => {
      seen.push(authors.slice())
      return authors.map(() => ({ ok: true, value: { profileSeq: 3, usernameSeq: null } }))
    },
    peek: async () => ({ profile: { name: 'Ana', bio: null, avatar: null }, username: null })
  })
  peeker.enqueue(keys)
  const done = await peeker.nextBatch()
  t.is(seen.length, 1, 'one index call for the batch')
  t.alike(seen[0], keys.slice(0, 8))
  t.is(perKey, 0, 'the per-key lookup is not used')
  t.is(done.length, 8)
  t.is(peeker.size, 2, 'the rest waits for the next batch')
  t.is(done[0].fields.name, 'Ana')
})

test('names.js batches name peeks on the back lane and keeps the profile gap', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/names.js'), 'utf8')
  t.ok(src.includes('lookupMany: (authors) => fetchMembers(authors)'), 'index lookups go through fetchMembers')
  t.ok(src.includes('const done = await peeker.nextBatch()'))
  t.absent(src.includes('lastPeekRef'), 'no clock between name peeks')
  t.ok(src.includes('const wait = lastBatchRef.current + MIN_GAP_MS - now'), 'profile batches keep their gap')
  t.ok(src.includes('lastBatchRef.current + MIN_GAP_MS - Date.now()'), 'the first peek still waits out that gap')
  t.ok(src.includes('if (mountedRef.current && (frontRef.current.size > 0 || backRef.current.size > 0)) schedule(MIN_GAP_MS)'))
  const peekAt = src.indexOf('peekFlushRef.current = async')
  const peekFlush = src.slice(peekAt, src.indexOf('useEffect(() => {\n    mountedRef', peekAt))
  t.ok(peekFlush.includes('if (busyRef.current || !gateRef.current)'))
  t.ok(peekFlush.includes('if (!quietOk(now))'))
  t.ok(peekFlush.includes('schedulePeek(0)'), 'the next name batch is not held for a second')
  t.absent(peekFlush.includes('MIN_GAP_MS'), 'the peek flush itself has no fixed gap')
  const wireAt = src.indexOf('peekerRef.current = createNamePeeker')
  const wire = src.slice(wireAt, src.indexOf('if (peekTimerRef.current !== null)', wireAt))
  t.ok(wire.includes("diaryPeekSlots.run(() => requestRef.current('diary.peek', params))"))
  t.absent(wire.includes('front: true'), 'name peeks stay on the back lane')
})

test('a stopped peeker takes no further job, so an old session issues no new peek', async (t) => {
  const { createNamePeeker } = await load()
  const peeks = []
  const releases = []
  const peeker = createNamePeeker({
    enabled: true,
    lookup: async () => ({ ok: true, value: { profileSeq: 3, usernameSeq: 2 } }),
    lookupMany: async (authors) => authors.map(() => ({ ok: true, value: { profileSeq: 3, usernameSeq: 2 } })),
    peek: (params) => {
      peeks.push(params)
      return new Promise((resolve) => { releases.push(resolve) })
    }
  })
  peeker.enqueue(Array.from({ length: 8 }, (_, i) => keyAt(i + 1)))
  const flight = peeker.nextBatch()
  for (let i = 0; i < 20 && peeks.length < 2; i++) await tick()
  const started = peeks.length
  t.ok(started > 0, 'the batch started peeking')
  peeker.stop()
  t.ok(peeker.off, 'the stopped peeker is off')
  t.is(peeker.size, 0, 'its queue is cleared')
  for (let i = 0; i < 6; i++) { for (const release of releases.splice(0)) release(null); await tick() }
  await flight
  t.is(peeks.length, started, 'no peek starts after stop')
})
