'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ref = { identity: 'b'.repeat(64), author: 'a'.repeat(64), seq: 7 }
const start = Date.parse('2026-11-13T12:00:00.000Z')
const found = { mime: 'image/jpeg', w: 160, h: 320, ms: 0, at: new Date(start).toISOString() }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function deferred () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

async function setup (options = {}) {
  const { createMomentPreviews, sharedPreviews } = await import('../src/momentPreviews.js')
  let time = start
  let timerId = 0
  const timers = new Map()
  const calls = { lookup: [], read: [], url: [], revoke: [], forget: [] }
  const request = async (method, params) => {
    calls.lookup.push({ method, params })
    return options.lookup ? options.lookup() : found
  }
  const media = options.locked
    ? null
    : {
        read: async (params) => {
          calls.read.push(params)
          return options.read ? options.read() : { mime: found.mime, bytes: new Uint8Array([1, 2]) }
        },
        forgetReadFile: (name) => calls.forget.push(name)
      }
  const deps = {
    now: () => time,
    setTimer: (fn, ms) => {
      const id = ++timerId
      timers.set(id, { fn, at: time + ms })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    urlFromBytes: (bytes, mime) => {
      calls.url.push({ bytes: [...bytes], mime })
      if (options.urlFromBytes) return options.urlFromBytes()
      return 'blob:' + calls.url.length
    },
    revokeUrl: (uri) => calls.revoke.push(uri)
  }
  const store = createMomentPreviews({ request, media, ...deps })
  return {
    store,
    request,
    media,
    deps,
    sharedPreviews,
    calls,
    timers,
    watch: (key = ref) => {
      const states = []
      const unwatch = store.watch(key, (state) => states.push(state))
      return { states, unwatch }
    },
    advance: async (ms) => {
      const end = time + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        time = next[1].at
        timers.delete(next[0])
        next[1].fn()
        await flush()
      }
      time = end
      await flush()
    }
  }
}

test('three watchers share one image and one poll loop', async (t) => {
  const h = await setup()
  const watchers = [h.watch(), h.watch(), h.watch()]
  await flush()
  t.alike(h.calls.lookup, [{ method: 'moment.lookup', params: { author: ref.author, seq: ref.seq } }])
  t.alike(h.calls.read, [{ kind: 'moment', author: ref.author, seq: ref.seq }])
  const state = watchers[0].states[0]
  t.alike({ kind: state.kind, uri: state.uri, size: state.size }, { kind: 'image', uri: 'blob:1', size: { width: 36, height: 72 } })
  for (const watcher of watchers) t.is(watcher.states[0], state)
  const late = h.watch()
  t.is(late.states[0], state, 'a settled entry is delivered synchronously')
  await h.advance(15000)
  t.is(h.calls.lookup.length, 2)
  t.is(h.calls.read.length, 1)
  t.alike([...h.timers.values()].map((timer) => timer.at).sort((a, b) => a - b), [start + 30000, start + 86400000])
  for (const watcher of [...watchers, late]) watcher.unwatch()
})

test('joining a pending lookup does not start another lookup', async (t) => {
  const pending = deferred()
  const h = await setup({ lookup: () => pending.promise })
  const a = h.watch()
  const b = h.watch()
  t.is(h.calls.lookup.length, 1)
  t.alike(a.states, [])
  t.alike(b.states, [])
  await h.advance(30000)
  t.is(h.calls.lookup.length, 1)
  pending.resolve(found)
  await flush()
  t.is(a.states[0].kind, 'image')
  t.is(a.states[0], b.states[0])
  t.is(h.calls.read.length, 1)
  a.unwatch()
  b.unwatch()
})

test('different sequences and identities have separate previews', async (t) => {
  const h = await setup()
  const watchers = [h.watch(), h.watch({ ...ref, seq: 8 }), h.watch({ ...ref, identity: 'c'.repeat(64) })]
  await flush()
  t.alike(h.calls.lookup.map((call) => call.params.seq), [7, 8, 7])
  t.alike(h.calls.read.map((call) => call.seq), [7, 8, 7])
  t.alike(watchers.map((watcher) => watcher.states[0].uri), ['blob:1', 'blob:2', 'blob:3'])
  for (const watcher of watchers) watcher.unwatch()
})

test('only the last unwatch releases the image and a later watch starts fresh', async (t) => {
  const h = await setup()
  const watchers = [h.watch(), h.watch(), h.watch()]
  await flush()
  watchers[0].unwatch()
  watchers[0].unwatch()
  watchers[1].unwatch()
  t.alike(h.calls.revoke, [])
  watchers[2].unwatch()
  watchers[2].unwatch()
  t.alike(h.calls.revoke, ['blob:1'])
  t.is(h.timers.size, 0)
  const fresh = h.watch()
  await flush()
  t.is(h.calls.lookup.length, 2)
  t.is(h.calls.read.length, 2)
  t.is(fresh.states[0].uri, 'blob:2')
  fresh.unwatch()
  t.alike(h.calls.revoke, ['blob:1', 'blob:2'])
})

test('lookup failure, deletion, deadline and image failure drop every watcher', async (t) => {
  for (const reason of ['lookup', 'deleted', 'deadline', 'image']) {
    let first = true
    const h = await setup({
      lookup: () => {
        if (first) {
          first = false
          return reason === 'deadline' ? { ...found, at: new Date(start - 86400000 + 5000).toISOString() } : found
        }
        if (reason === 'lookup') throw new Error('gone')
        return null
      }
    })
    const watchers = [h.watch(), h.watch(), h.watch()]
    await flush()
    if (reason === 'image') watchers[0].states[0].handleError()
    else await h.advance(reason === 'deadline' ? 5000 : 15000)
    for (const watcher of watchers) t.alike(watcher.states.map((state) => state.kind), ['image', 'gone'], reason)
    t.alike(h.calls.revoke, ['blob:1'])
    t.is(h.timers.size, 0)
    const late = h.watch()
    t.alike(late.states, [{ kind: 'gone' }], 'a new bubble sees the current state at once')
    await h.advance(30000)
    t.is(h.calls.lookup.length, { lookup: 3, deleted: 2, deadline: 1, image: 2 }[reason], 'a failure is asked again once by the new bubble; not showing or the deadline is final')
    for (const watcher of [...watchers, late]) t.is(watcher.states.at(-1).kind, 'gone', reason)
    watchers[0].states[0].handleError()
    for (const watcher of [...watchers, late]) watcher.unwatch()
    t.alike(h.calls.revoke, ['blob:1'], 'release runs once')
  }
})

test('a new bubble retries a failed preview and a recovery reaches every bubble', async (t) => {
  let fail = true
  const h = await setup({
    read: () => {
      if (fail) throw new Error('not here yet')
      return { mime: found.mime, bytes: new Uint8Array([1, 2]) }
    }
  })
  const a = h.watch()
  await flush()
  t.alike(a.states, [{ kind: 'gone' }])
  t.is(h.timers.size, 0)
  fail = false
  const b = h.watch()
  t.alike(b.states, [{ kind: 'gone' }])
  await flush()
  t.is(h.calls.lookup.length, 2)
  t.is(h.calls.read.length, 2)
  t.is(a.states.at(-1).kind, 'image')
  t.is(b.states.at(-1).uri, a.states.at(-1).uri)
  const c = h.watch()
  await flush()
  t.is(h.calls.lookup.length, 2, 'a showing preview is not asked again')
  t.is(c.states.at(-1).uri, a.states.at(-1).uri)
  for (const watcher of [a, b, c]) watcher.unwatch()
  t.alike(h.calls.revoke, ['blob:1'])
  t.is(h.timers.size, 0)
})

test('a read from before a failure cannot add a second image after the retry', async (t) => {
  const reads = []
  let lookups = 0
  const h = await setup({
    lookup: () => {
      lookups++
      if (lookups === 2) throw new Error('offline')
      return found
    },
    read: () => {
      const read = deferred()
      reads.push(read)
      return read.promise
    }
  })
  const a = h.watch()
  await flush()
  t.is(reads.length, 1)
  await h.advance(15000)
  t.alike(a.states, [{ kind: 'gone' }])
  const b = h.watch()
  await flush()
  t.is(reads.length, 2)
  const stale = new Uint8Array([9])
  reads[0].resolve({ mime: found.mime, bytes: stale })
  await flush()
  t.is(stale[0], 0)
  t.is(h.calls.url.length, 0, 'the stale read makes no URL')
  t.is(a.states.at(-1).kind, 'gone', 'and does not drop the retry')
  reads[1].resolve({ mime: found.mime, bytes: new Uint8Array([1]) })
  await flush()
  t.is(h.calls.url.length, 1)
  t.is(a.states.at(-1).uri, 'blob:1')
  t.is(b.states.at(-1).uri, 'blob:1')
  a.states[a.states.length - 1].handleError()
  t.is(a.states.at(-1).kind, 'gone')
  t.alike(h.calls.revoke, ['blob:1'])
  a.unwatch()
  b.unwatch()
  t.alike(h.calls.revoke, ['blob:1'])
  t.is(h.timers.size, 0)
})

test('a retry asked while an older poll is out still asks again when that poll fails', async (t) => {
  let lookups = 0
  let failPoll
  let reads = 0
  let failRead
  const h = await setup({
    lookup: () => {
      lookups++
      if (lookups === 2) return new Promise((resolve, reject) => { failPoll = reject })
      return found
    },
    read: () => {
      reads++
      if (reads === 1) return new Promise((resolve, reject) => { failRead = reject })
      return { mime: found.mime, bytes: new Uint8Array([1]) }
    }
  })
  const a = h.watch()
  await flush()
  await h.advance(15000)
  t.is(h.calls.lookup.length, 2, 'the poll is out')
  failRead(new Error('not here yet'))
  await flush()
  t.alike(a.states, [{ kind: 'gone' }])
  const b = h.watch()
  await flush()
  t.is(h.calls.lookup.length, 2, 'no second lookup while one is out')
  failPoll(new Error('offline'))
  await flush()
  t.is(h.calls.lookup.length, 3, 'the retry is asked once the older poll settles')
  t.is(a.states.at(-1).uri, 'blob:1')
  t.is(b.states.at(-1).uri, 'blob:1')
  a.unwatch()
  b.unwatch()
  t.alike(h.calls.revoke, ['blob:1'])
  t.is(h.timers.size, 0)
})

test('video previews fit 72 pt and never read media', async (t) => {
  const h = await setup({ lookup: () => ({ ...found, mime: 'video/mp4', ms: 5000 }) })
  const a = h.watch()
  const b = h.watch()
  await flush()
  t.alike(a.states, [{ kind: 'video', size: { width: 36, height: 72 } }])
  t.alike(b.states, a.states)
  t.alike(h.calls.read, [])
  a.unwatch()
  b.unwatch()
})

test('a late read only forgets its file and zeros its bytes after the last unwatch', async (t) => {
  const pending = deferred()
  const h = await setup({ read: () => pending.promise })
  const a = h.watch()
  await flush()
  t.is(h.calls.read.length, 1)
  a.unwatch()
  const bytes = new Uint8Array([1, 2])
  pending.resolve({ mime: found.mime, bytes, uri: 'file:///cache/late.bin' })
  await flush()
  t.alike(bytes, new Uint8Array([0, 0]))
  t.alike(h.calls.forget, ['late.bin'])
  t.alike(h.calls.url, [])
  t.alike(a.states, [])
  t.is(h.timers.size, 0)
})

test('a late lookup cannot read or notify after close', async (t) => {
  const pending = deferred()
  const h = await setup({ lookup: () => pending.promise })
  const a = h.watch()
  a.unwatch()
  pending.resolve(found)
  await flush()
  t.alike(a.states, [])
  t.alike(h.calls.read, [])
  t.is(h.timers.size, 0)
})

test('a pending poll never overlaps and cannot restore an expired image', async (t) => {
  const pending = deferred()
  let calls = 0
  const h = await setup({ lookup: () => ++calls === 1 ? { ...found, at: new Date(start - 86400000 + 50000).toISOString() } : pending.promise })
  const a = h.watch()
  const b = h.watch()
  await flush()
  await h.advance(45000)
  t.is(calls, 2, 'no further polls while the second lookup is pending')
  await h.advance(5000)
  t.alike(a.states.at(-1), { kind: 'gone' })
  t.alike(b.states.at(-1), { kind: 'gone' })
  pending.resolve(found)
  await flush()
  t.is(a.states.length, 2)
  t.is(h.timers.size, 0)
  t.alike(h.calls.revoke, ['blob:1'])
  a.unwatch()
  b.unwatch()
})

test('initial lookup and read failures, including a locked node, fail closed', async (t) => {
  for (const options of [
    { lookup: () => { throw new Error('gone') } },
    { read: () => { throw new Error('gone') } },
    { locked: true },
    { lookup: () => ({ ...found, at: 'invalid' }) },
    { lookup: () => ({ ...found, at: new Date(start - 86400000).toISOString() }) }
  ]) {
    const h = await setup(options)
    const a = h.watch()
    const b = h.watch()
    await flush()
    t.alike(a.states, [{ kind: 'gone' }])
    t.alike(b.states, a.states)
    t.is(h.timers.size, 0)
    a.unwatch()
    b.unwatch()
  }
})

test('native files release once and rejected or throwing image conversion clears bytes', async (t) => {
  const h = await setup({ read: () => ({ mime: found.mime, uri: 'file:///cache/photo.bin' }) })
  const a = h.watch()
  await flush()
  t.is(a.states[0].uri, 'file:///cache/photo.bin')
  t.alike(h.calls.forget, [])
  a.states[0].handleError()
  a.unwatch()
  t.alike(h.calls.forget, ['photo.bin'])
  for (const mismatch of [true, false]) {
    const bytes = new Uint8Array([1, 2])
    const h = await setup({
      read: () => ({ mime: mismatch ? 'image/png' : found.mime, bytes, uri: 'file:///cache/rejected.bin' }),
      urlFromBytes: () => { throw new Error('cannot create URL') }
    })
    const a = h.watch()
    await flush()
    t.alike(a.states, [{ kind: 'gone' }])
    t.alike(bytes, new Uint8Array([0, 0]))
    t.alike(h.calls.forget, ['rejected.bin'])
    t.is(h.timers.size, 0)
    a.unwatch()
  }
})

test('shared stores are cached by request and replaced when media changes', async (t) => {
  const h = await setup()
  const first = h.sharedPreviews(h.request, h.media, h.deps)
  t.is(h.sharedPreviews(h.request, h.media, { ...h.deps }), first)
  const locked = h.sharedPreviews(h.request, null, h.deps)
  t.not(locked, first)
  t.is(h.sharedPreviews(h.request, null, h.deps), locked)
  const unlocked = h.sharedPreviews(h.request, h.media, h.deps)
  t.not(unlocked, locked)
  t.not(unlocked, first)
  t.not(h.sharedPreviews(async () => found, h.media, h.deps), unlocked)
})

test('momentPreviews imports only the pure reaction helpers', (t) => {
  const source = readFileSync(join(__dirname, '../src/momentPreviews.js'), 'utf8')
  const imports = [...source.matchAll(/\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1])
  t.alike(imports, ['./momentReaction.js'])
  t.absent(imports.some((name) => /^(?:react(?:-native)?(?:\/|$)|node:|(?:fs|path|process|timers)(?:\/|$))/.test(name)))
})
