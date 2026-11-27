'use strict'

// src/media/peekPhotoStore.js over an in-memory backend: binding, caps,
// expiry, checks on read, drops, retain, wipe, ordering and failures.
const test = require('brittle')
const load = () => import('../src/media/peekPhotoStore.js')

const A = 'a1'.repeat(32)
const B = 'b2'.repeat(32)
const CORE = 'c3'.repeat(32)
const OTHER = 'd4'.repeat(32)
const DAY = 24 * 60 * 60 * 1000

const ME = { origin: 'https://bora.varanda.app', association: 'f6'.repeat(32), owner: A }

function desc (over = {}) {
  return { core: CORE, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 4, sha256: 'e5'.repeat(32), width: 10, height: 20, ...over }
}

const bytesOf = (n, fill = 7) => new Uint8Array(n).fill(fill)

const sameBinding = (a, b) => !!a && !!b && a.origin === b.origin && a.association === b.association && a.owner === b.owner

function memoryBackend () {
  const state = { binding: null, meta: new Map(), bytes: new Map(), calls: [] }
  const b = {
    state,
    async getBinding () { state.calls.push('getBinding'); return state.binding },
    async setBinding (x) { state.calls.push('setBinding'); state.binding = { ...x }; return true },
    async list () { state.calls.push('list'); return [...state.meta.values()].map((r) => ({ ...r })) },
    async get (name, binding) {
      state.calls.push('get')
      if (!sameBinding(state.binding, binding)) return false
      const v = state.bytes.get(name)
      return v ? v.slice() : null
    },
    async put (row, bytes, binding) {
      state.calls.push('put')
      if (!sameBinding(state.binding, binding)) return false
      state.meta.set(row.name, { ...row })
      state.bytes.set(row.name, bytes.slice())
      return true
    },
    async remove (names) { state.calls.push('remove'); for (const n of names) { state.meta.delete(n); state.bytes.delete(n) } return true },
    async clear () { state.calls.push('clear'); state.binding = null; state.meta.clear(); state.bytes.clear(); return true }
  }
  return b
}

async function setup (opts = {}) {
  const { createPeekPhotoStore } = await load()
  const backend = memoryBackend()
  const clock = { t: 1000 * DAY }
  const store = createPeekPhotoStore({ backend, now: () => clock.t, ...opts })
  return { store, backend, clock }
}

test('a read under a binding another tab replaced answers null and keeps the entry', async (t) => {
  const { store, backend } = await setup()
  t.is(await store.bind(ME), true)
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), true)
  backend.state.binding = { ...ME, owner: OTHER }
  t.is(await store.read('peekPosts', B, desc()), null, 'the bytes of the old binding are not handed out')
  t.ok(backend.state.bytes.has('peekPosts/' + B + '-' + CORE + '-1-1'), 'nothing removed for the other account')
  backend.state.binding = { ...ME }
  t.alike(await store.read('peekPosts', B, desc()), bytesOf(4))
})

test('nothing is read or written before a bind', async (t) => {
  const { store, backend } = await setup()
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), false)
  t.is(await store.read('peekPosts', B, desc()), null)
  t.is(await store.dropAuthors([B]), false, 'a drop is only remembered for the bind')
  t.is(await store.dropRanges([{ core: CORE, start: 0, blocks: 9 }]), false)
  t.is(await store.retain(['peekPosts'], []), false)
  t.alike(backend.state.calls, [], 'the backend was never touched')
  t.is(await store.bind(null), true)
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), false, 'a null binding drops puts')
  t.alike(backend.state.calls, [], 'a null binding touches nothing')
})

test('bind records the binding, and a put then reads back', async (t) => {
  const { store, backend } = await setup()
  t.is(await store.bind(ME), true)
  t.alike(backend.state.binding, ME)
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), true)
  t.alike(await store.read('peekPosts', B, desc()), bytesOf(4))
  t.is(await store.read('peekAvatars', B, desc()), null, 'a post photo never answers for an avatar')
  const row = backend.state.meta.get('peekPosts/' + B + '-' + CORE + '-1-1')
  t.alike(Object.keys(row).sort(), ['author', 'blocks', 'core', 'kind', 'mime', 'name', 'savedAt', 'sha256', 'size', 'start'])
  t.is(await store.bind(null), true)
  t.is(await store.read('peekPosts', B, desc()), null, 'unbound reads answer null')
  t.is(await store.bind(ME), true)
  t.alike(await store.read('peekPosts', B, desc()), bytesOf(4), 'the same binding keeps the entries')
})

test('bind clears on another owner, origin or association', async (t) => {
  for (const change of [{ owner: B }, { origin: 'https://outra.example' }, { association: '09'.repeat(32) }]) {
    const { store, backend } = await setup()
    await store.bind(ME)
    await store.put('peekPosts', B, desc(), bytesOf(4))
    t.is(await store.bind({ ...ME, ...change }), true)
    t.is(backend.state.meta.size, 0, Object.keys(change)[0] + ': entries cleared')
    t.alike(backend.state.binding, { ...ME, ...change })
    t.is(await store.read('peekPosts', B, desc()), null)
  }
})

test('bind with nothing recorded clears what is there', async (t) => {
  const { store, backend } = await setup()
  backend.state.meta.set('x', { name: 'x' })
  backend.state.bytes.set('x', bytesOf(1))
  await store.bind(ME)
  t.is(backend.state.meta.size, 0)
  t.is(backend.state.bytes.size, 0)
})

test('caps by bytes and by files, oldest first', async (t) => {
  {
    const { store, backend, clock } = await setup({ maxBytes: 10 })
    await store.bind(ME)
    await store.put('peekPosts', B, desc({ start: 1, bytes: 4 }), bytesOf(4))
    clock.t += 1
    await store.put('peekPosts', B, desc({ start: 2, bytes: 4 }), bytesOf(4))
    clock.t += 1
    t.is(await store.put('peekPosts', B, desc({ start: 3, bytes: 4 }), bytesOf(4)), true)
    t.alike([...backend.state.meta.values()].map((r) => r.start).sort(), [2, 3], 'the oldest went to fit the byte cap')
    t.is(await store.put('peekPosts', B, desc({ start: 4, bytes: 11 }), bytesOf(11)), false, 'above maxBytes is refused')
    t.is(backend.state.meta.size, 2, 'and evicts nothing')
  }
  {
    const { store, backend, clock } = await setup({ maxFiles: 2 })
    await store.bind(ME)
    await store.put('peekAvatars', B, desc({ start: 1 }), bytesOf(4))
    clock.t += 1
    await store.put('peekPosts', B, desc({ start: 2 }), bytesOf(4))
    clock.t += 1
    await store.put('peekPosts', B, desc({ start: 3 }), bytesOf(4))
    t.alike([...backend.state.meta.values()].map((r) => r.start).sort(), [2, 3], 'the oldest went to fit the file cap')
    await store.put('peekPosts', B, desc({ start: 3 }), bytesOf(4))
    t.is(backend.state.meta.size, 2, 'replacing an entry evicts nothing')
  }
})

test('put refuses bytes of the wrong length or type', async (t) => {
  const { store, backend } = await setup()
  await store.bind(ME)
  t.is(await store.put('peekPosts', B, desc(), bytesOf(3)), false)
  t.is(await store.put('peekPosts', B, desc(), [1, 2, 3, 4]), false)
  t.is(await store.put('posts', B, desc(), bytesOf(4)), false, 'unknown kind')
  t.is(await store.put('peekPosts', 'nope', desc(), bytesOf(4)), false, 'bad author')
  t.is(await store.put('peekPosts', B, { ...desc(), extra: 1 }, bytesOf(4)), false, 'bad descriptor')
  t.is(backend.state.meta.size, 0)
})

test('7-day expiry on read and on bind', async (t) => {
  {
    const { store, backend, clock } = await setup()
    await store.bind(ME)
    await store.put('peekPosts', B, desc(), bytesOf(4))
    clock.t += 7 * DAY
    t.alike(await store.read('peekPosts', B, desc()), bytesOf(4), 'exactly seven days still reads')
    clock.t += 1
    t.is(await store.read('peekPosts', B, desc()), null)
    t.is(backend.state.meta.size, 0, 'the expired entry is removed')
  }
  {
    const { store, backend, clock } = await setup()
    await store.bind(ME)
    await store.put('peekPosts', B, desc({ start: 1 }), bytesOf(4))
    clock.t += 3 * DAY
    await store.put('peekPosts', B, desc({ start: 2 }), bytesOf(4))
    clock.t += 5 * DAY
    await store.bind(null)
    await store.bind(ME)
    t.alike([...backend.state.meta.values()].map((r) => r.start), [2], 'bind removed the expired entry only')
  }
})

test('size, hash and mime mismatches remove the entry', async (t) => {
  for (const over of [{ bytes: 5 }, { sha256: '00'.repeat(32) }, { mime: 'image/png' }]) {
    const { store, backend } = await setup()
    await store.bind(ME)
    await store.put('peekPosts', B, desc(), bytesOf(4))
    t.is(await store.read('peekPosts', B, desc(over)), null, Object.keys(over)[0] + ' mismatch')
    t.is(backend.state.meta.size, 0, Object.keys(over)[0] + ': entry removed')
  }
  const { store, backend } = await setup()
  await store.bind(ME)
  await store.put('peekPosts', B, desc(), bytesOf(4))
  backend.state.bytes.set([...backend.state.bytes.keys()][0], bytesOf(3))
  t.is(await store.read('peekPosts', B, desc()), null, 'stored bytes of another length')
  t.is(backend.state.meta.size, 0)
})

test('dropAuthors, dropRanges and retain', async (t) => {
  const { store, backend } = await setup()
  await store.bind(ME)
  await store.put('peekPosts', A, desc({ start: 1 }), bytesOf(4))
  await store.put('peekPosts', B, desc({ start: 10 }), bytesOf(4))
  await store.put('peekAvatars', B, desc({ start: 20, core: OTHER }), bytesOf(4))
  t.is(await store.dropAuthors([A.toUpperCase()]), true)
  t.alike([...backend.state.meta.values()].map((r) => r.start).sort((x, y) => x - y), [10, 20])
  t.is(await store.dropRanges([{ core: CORE, start: 9, blocks: 2 }]), true)
  t.alike([...backend.state.meta.values()].map((r) => r.start), [20], 'only the overlapping range on that core went')
  t.is(await store.dropRanges([{ core: OTHER, start: 21, blocks: 5 }]), true)
  t.is(backend.state.meta.size, 1, 'a range that does not overlap keeps it')

  await store.put('peekPosts', B, desc({ start: 30 }), bytesOf(4))
  await store.put('peekPosts', B, desc({ start: 40 }), bytesOf(4))
  t.is(await store.retain(['peekPosts'], [{ kind: 'peekPosts', author: B, d: desc({ start: 40 }) }]), true)
  t.alike([...backend.state.meta.values()].map((r) => r.start).sort((x, y) => x - y), [20, 40], 'other kinds and named entries stay')
  t.is(await store.retain(['peekPosts', 'peekAvatars'], []), true)
  t.is(backend.state.meta.size, 0, 'an empty list removes all of those kinds')
  t.is(backend.state.bytes.size, 0, 'with their bytes')
})

test('wipe clears entries and the binding, and unbinds', async (t) => {
  const { store, backend } = await setup()
  await store.bind(ME)
  await store.put('peekPosts', B, desc(), bytesOf(4))
  t.is(await store.wipe(), true)
  t.is(backend.state.meta.size, 0)
  t.is(backend.state.binding, null)
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), false, 'unbound after a wipe')
  t.is(backend.state.meta.size, 0)
})

test('a put overtaken by a wipe, drop or retain writes nothing', async (t) => {
  for (const mutate of [
    (s) => s.wipe(),
    (s) => s.dropAuthors([B]),
    (s) => s.dropRanges([{ core: CORE, start: 0, blocks: 5 }]),
    (s) => s.retain(['peekPosts'], []),
    (s) => s.bind({ ...ME, owner: B })
  ]) {
    const { store, backend } = await setup()
    await store.bind(ME)
    const pending = store.put('peekPosts', B, desc(), bytesOf(4))
    const done = mutate(store)
    t.is(await pending, false, 'the put gives up')
    await done
    t.is(backend.state.meta.size, 0, 'nothing was recreated')
  }
  {
    const { store, backend } = await setup()
    await store.bind(ME)
    const gate = {}
    const list = backend.list
    backend.list = async () => { await new Promise((resolve) => { gate.open = resolve }); return list() }
    const pending = store.put('peekPosts', B, desc(), bytesOf(4))
    await new Promise((resolve) => setImmediate(resolve))
    const done = store.wipe()
    gate.open()
    t.is(await pending, false, 'a put already awaiting the backend gives up')
    await done
    t.is(backend.state.meta.size, 0)
  }
})

test('a read in flight when the binding changes answers null', async (t) => {
  const { store } = await setup()
  await store.bind(ME)
  await store.put('peekPosts', B, desc(), bytesOf(4))
  const pending = store.read('peekPosts', B, desc())
  store.wipe()
  t.is(await pending, null)
})

test('a failing backend never throws', async (t) => {
  const { createPeekPhotoStore } = await load()
  const fail = async () => { throw new Error('boom') }
  const backend = { getBinding: fail, setBinding: fail, list: fail, get: fail, put: fail, remove: fail, clear: fail }
  const store = createPeekPhotoStore({ backend })
  t.is(await store.bind(ME), false)
  t.is(await store.read('peekPosts', B, desc()), null)
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), false)
  t.is(await store.dropAuthors([B]), false, 'unbound: only remembered for the next bind')
  t.is(await store.dropRanges([{ core: CORE, start: 0, blocks: 1 }]), false)
  t.is(await store.retain(['peekPosts'], []), false)
  t.is(await store.wipe(), false)

  const listFails = memoryBackend()
  const s4 = createPeekPhotoStore({ backend: listFails })
  await s4.bind(ME)
  listFails.list = fail
  t.is(await s4.dropAuthors([B]), false, 'a bound drop whose listing fails answers false')

  const half = memoryBackend()
  const s2 = createPeekPhotoStore({ backend: half })
  await s2.bind(ME)
  half.put = fail
  half.get = fail
  t.is(await s2.put('peekPosts', B, desc(), bytesOf(4)), false)
  t.is(await s2.read('peekPosts', B, desc()), null)
  half.list = async () => 'not an array'
  t.is(await s2.read('peekPosts', B, desc()), null)

  const sync = memoryBackend()
  const s3 = createPeekPhotoStore({ backend: sync })
  sync.getBinding = () => { throw new Error('sync boom') }
  t.is(await s3.bind(ME), false, 'a synchronous throw is caught too')
  t.is(await s3.put('peekPosts', B, desc(), bytesOf(4)), false, 'and leaves the store unbound')
})

test('a failed bind leaves the store unbound', async (t) => {
  const { createPeekPhotoStore } = await load()
  const backend = memoryBackend()
  backend.clear = async () => false
  const store = createPeekPhotoStore({ backend })
  t.is(await store.bind(ME), false)
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), false)
  t.is(backend.state.meta.size, 0)
})

test('a removal called while the first bind is pending does not cancel it', async (t) => {
  for (const remove of [
    (s) => s.retain(['peekPosts'], []),
    (s) => s.dropAuthors([B]),
    (s) => s.dropRanges([{ core: CORE, start: 0, blocks: 5 }])
  ]) {
    const { store, backend } = await setup()
    const bound = store.bind(ME)
    const removed = remove(store)
    t.is(await bound, true, 'the bind still succeeds')
    t.is(await removed, true, 'the removal runs after it')
    t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), true, 'the store is on')
    t.alike(await store.read('peekPosts', B, desc()), bytesOf(4))
    t.is(backend.state.meta.size, 1)
  }
})

test('a failed repeat bind of the same identity turns the store off', async (t) => {
  const { store, backend } = await setup()
  await store.bind(ME)
  await store.put('peekPosts', B, desc(), bytesOf(4))
  const getBinding = backend.getBinding
  backend.getBinding = async () => { throw new Error('boom') }
  t.is(await store.bind(ME), false)
  t.is(await store.read('peekPosts', B, desc()), null, 'reads are off')
  t.is(await store.put('peekPosts', B, desc({ start: 2 }), bytesOf(4)), false, 'puts are off')
  backend.getBinding = getBinding
  t.is(await store.bind(ME), true)
  t.alike(await store.read('peekPosts', B, desc()), bytesOf(4), 'a successful bind turns it back on')
})

async function twoStores () {
  const { createPeekPhotoStore } = await load()
  const backend = memoryBackend()
  const first = createPeekPhotoStore({ backend })
  await first.bind(ME)
  await first.put('peekPosts', B, desc({ start: 1 }), bytesOf(4))
  await first.put('peekPosts', A, desc({ start: 10, core: OTHER }), bytesOf(4))
  return { backend, second: createPeekPhotoStore({ backend }) }
}

test('drops called before the first bind are applied by it', async (t) => {
  {
    const { backend, second } = await twoStores()
    t.is(await second.dropAuthors([B]), false, 'not applied yet')
    t.is(await second.bind(ME), true)
    t.is(await second.read('peekPosts', B, desc({ start: 1 })), null, 'the dropped author is gone')
    t.alike(await second.read('peekPosts', A, desc({ start: 10, core: OTHER })), bytesOf(4), 'others stay')
    t.is(backend.state.meta.size, 1)
  }
  {
    const { second } = await twoStores()
    t.is(await second.dropRanges([{ core: CORE, start: 1, blocks: 1 }]), false)
    t.is(await second.bind(ME), true)
    t.is(await second.read('peekPosts', B, desc({ start: 1 })), null, 'the dropped range is gone')
    t.alike(await second.read('peekPosts', A, desc({ start: 10, core: OTHER })), bytesOf(4))
  }
  {
    const { second } = await twoStores()
    t.is(await second.retain(['peekPosts'], [{ kind: 'peekPosts', author: A, d: desc({ start: 10, core: OTHER }) }]), false)
    t.is(await second.bind(ME), true)
    t.is(await second.read('peekPosts', B, desc({ start: 1 })), null, 'retain applies too')
    t.alike(await second.read('peekPosts', A, desc({ start: 10, core: OTHER })), bytesOf(4))
  }
  {
    const { backend, second } = await twoStores()
    for (let i = 0; i < 70; i++) await second.dropAuthors(['00'.repeat(32)])
    t.is(await second.bind(ME), true)
    t.is(backend.state.meta.size, 0, 'too many remembered drops clear everything')
  }
  {
    const { backend, second } = await twoStores()
    await second.dropAuthors([B])
    const remove = backend.remove
    backend.remove = async () => false
    t.is(await second.bind(ME), false, 'a bind that cannot apply them fails')
    backend.remove = remove
    t.is(await second.bind(ME), true)
    t.is(await second.read('peekPosts', B, desc({ start: 1 })), null, 'and the next bind still applies them')
  }
})

test('dropAuthors, dropRanges and retain take any iterable', async (t) => {
  const { store, backend } = await setup()
  await store.bind(ME)
  await store.put('peekPosts', A, desc({ start: 1 }), bytesOf(4))
  await store.put('peekPosts', B, desc({ start: 10 }), bytesOf(4))
  await store.put('peekAvatars', B, desc({ start: 20 }), bytesOf(4))
  t.is(await store.dropAuthors(new Set([A])), true)
  t.alike([...backend.state.meta.values()].map((r) => r.start).sort((x, y) => x - y), [10, 20], 'a Set of authors')
  t.is(await store.dropRanges(new Set([{ core: CORE, start: 10, blocks: 1 }])), true)
  t.alike([...backend.state.meta.values()].map((r) => r.start), [20], 'a Set of ranges')
  t.is(await store.retain(new Set(['peekAvatars']), new Set()), true)
  t.is(backend.state.meta.size, 0, 'Sets for retain')
  t.is(await store.dropAuthors('a1'.repeat(32)), false, 'a string is not a list')
  t.is(await store.dropAuthors(null), false)
})

test('keepOnlyAuthors deletes the unlisted authors in the queue, under this binding only', async (t) => {
  {
    const { store, backend } = await setup()
    await store.bind(ME)
    await store.put('peekPosts', A, desc({ start: 1 }), bytesOf(4))
    await store.put('peekPosts', B, desc({ start: 10 }), bytesOf(4))
    await store.put('peekAvatars', B, desc({ start: 20 }), bytesOf(4))
    t.is(await store.keepOnlyAuthors(new Set([A.toUpperCase()])), true)
    t.alike([...backend.state.meta.values()].map((r) => r.start), [1], 'only the listed author stays')
    t.is(await store.keepOnlyAuthors([]), true)
    t.is(backend.state.meta.size, 0, 'an empty list keeps nobody')
    t.is(await store.keepOnlyAuthors(A), false, 'a string is not a list')
    t.is(await store.keepOnlyAuthors(null), false)
  }
  {
    const { backend, second } = await twoStores()
    t.is(await second.keepOnlyAuthors([A]), false, 'not bound yet')
    t.is(await second.bind(ME), true)
    t.alike(await second.read('peekPosts', B, desc({ start: 1 })), bytesOf(4), 'and not kept for the first bind')
    t.is(backend.state.meta.size, 2)
  }
  {
    const { store, backend } = await setup()
    await store.bind(ME)
    await store.put('peekPosts', B, desc(), bytesOf(4))
    const wiped = store.wipe()
    t.is(await store.keepOnlyAuthors([A]), false, 'a wipe queued before turns it off')
    t.is(await wiped, true)
    t.absent(backend.state.calls.includes('remove'))
  }
  {
    const { store, backend } = await setup()
    await store.bind(ME)
    await store.put('peekPosts', B, desc(), bytesOf(4))
    const gate = {}
    const list = backend.list
    backend.list = async () => { await new Promise((resolve) => { gate.open = resolve }); return list() }
    const pending = store.keepOnlyAuthors([A])
    await new Promise((resolve) => setImmediate(resolve))
    const rebound = store.bind({ ...ME, owner: B })
    backend.list = list
    gate.open()
    t.is(await pending, false, 'a rebind while it lists gives up')
    t.absent(backend.state.calls.includes('remove'), 'and removes nothing for the old binding')
    await rebound
  }
})

test('a put after another tab rebinds or wipes writes nothing', async (t) => {
  const { store, backend } = await setup()
  await store.bind(ME)
  backend.state.binding = { ...ME, owner: B }
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), false, 'another owner is stored')
  t.is(backend.state.meta.size, 0)
  backend.state.binding = null
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), false, 'the binding was wiped')
  t.is(backend.state.meta.size, 0)
  backend.state.binding = { ...ME }
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), true, 'the same binding writes')
})

const SHA = 'f7'.repeat(32)
const SHA2 = '8a'.repeat(32)

async function copySetup (opts = {}) {
  const m = await load()
  return setup({ kinds: m.COPY_PHOTO_KINDS, maxBytes: m.COPY_PHOTO_MAX_BYTES, maxFiles: m.COPY_PHOTO_MAX_FILES, maxAgeMs: m.COPY_PHOTO_MAX_AGE_MS, ...opts })
}

test('copy constants beside the peek ones', async (t) => {
  const m = await load()
  t.alike(m.COPY_PHOTO_KINDS, ['copyAvatars', 'copyPosts', 'copyGroupThumbs'])
  t.is(m.COPY_GROUP_THUMBS, 'copyGroupThumbs')
  t.is(m.COPY_PHOTO_MAX_BYTES, 8 * 1024 * 1024)
  t.is(m.COPY_PHOTO_MAX_FILES, 200)
  t.is(m.COPY_PHOTO_MAX_AGE_MS, 14 * DAY)
  t.is(m.GROUP_THUMB_MAX_BYTES, 256 * 1024)
  t.alike(m.PEEK_PHOTO_KINDS, ['peekAvatars', 'peekPosts'], 'the peek kinds are unchanged')
})

test('the kinds option: a store holds only its own kinds', async (t) => {
  const peek = await setup()
  await peek.store.bind(ME)
  t.is(await peek.store.put('copyPosts', B, desc(), bytesOf(4)), false, 'the peek store refuses a copy kind')
  t.is(await peek.store.putThumb(B, SHA, bytesOf(4), 'image/jpeg'), false, 'and a group picture')
  t.is(await peek.store.readThumb(B, SHA), null)
  t.is(await peek.store.retainThumbs([]), false)
  t.is(peek.backend.state.meta.size, 0)

  const { store, backend } = await copySetup()
  await store.bind(ME)
  t.is(await store.put('peekPosts', B, desc(), bytesOf(4)), false, 'the copy store refuses a peek kind')
  t.is(await store.put('copyGroupThumbs', B, desc(), bytesOf(4)), false, 'a group picture goes through putThumb only')
  t.is(await store.put('copyPosts', B, desc(), bytesOf(4)), true)
  t.is(await store.put('copyAvatars', B, desc(), bytesOf(4)), true)
  t.alike([...backend.state.meta.keys()].sort(), ['copyAvatars/' + B + '-' + CORE + '-1-1', 'copyPosts/' + B + '-' + CORE + '-1-1'])
  t.alike(await store.read('copyPosts', B, desc()), bytesOf(4))
  t.is(await store.read('peekPosts', B, desc()), null)
  backend.state.meta.set('peekPosts/x', { name: 'peekPosts/x', kind: 'peekPosts' })
  await store.bind(null)
  await store.bind(ME)
  t.absent(backend.state.meta.has('peekPosts/x'), 'a row of a foreign kind is removed at bind')
})

test('group pictures: put, read back, limits and checks', async (t) => {
  const m = await load()
  const { store, backend, clock } = await copySetup()
  await store.bind(ME)
  t.is(await store.putThumb(B.toUpperCase(), SHA, bytesOf(10), 'image/jpeg'), true)
  const name = 'copyGroupThumbs/' + B + '-' + SHA
  t.alike(backend.state.meta.get(name), { name, kind: 'copyGroupThumbs', author: B, sha256: SHA, mime: 'image/jpeg', size: 10, savedAt: clock.t })
  t.alike(await store.readThumb(B, SHA), bytesOf(10))
  t.is(await store.readThumb(B, SHA2), null)
  for (const [author, sha, bytes, mime, why] of [
    ['nope', SHA, bytesOf(4), 'image/jpeg', 'author'],
    [B, 'zz'.repeat(32), bytesOf(4), 'image/jpeg', 'hash'],
    [B, SHA2, bytesOf(4), 'text/html', 'mime'],
    [B, SHA2, bytesOf(4), 'image/png', 'a type the live draw never shows'],
    [B, SHA2, new Uint8Array(0), 'image/jpeg', 'empty'],
    [B, SHA2, bytesOf(m.GROUP_THUMB_MAX_BYTES + 1), 'image/jpeg', 'over 256 KiB'],
    [B, SHA2, [1, 2], 'image/jpeg', 'bytes only']
  ]) t.is(await store.putThumb(author, sha, bytes, mime), false, why)
  t.is(backend.state.meta.size, 1)
  t.is(await store.putThumb(B, SHA2, bytesOf(m.GROUP_THUMB_MAX_BYTES), 'image/jpeg'), true, 'exactly 256 KiB is kept')

  backend.state.bytes.set(name, bytesOf(9))
  t.is(await store.readThumb(B, SHA), null, 'stored bytes of another length')
  t.absent(backend.state.meta.has(name), 'remove the entry')
  backend.state.meta.set(name, { name, kind: 'copyGroupThumbs', author: B, sha256: SHA, mime: 'image/png', size: m.GROUP_THUMB_MAX_BYTES + 1, savedAt: clock.t })
  t.is(await store.readThumb(B, SHA), null, 'an oversized row does not answer')
  t.absent(backend.state.meta.has(name))
})

test('the copy store: 14-day expiry, its own caps, and only retainThumbs prunes group pictures', async (t) => {
  {
    const { store, backend, clock } = await copySetup()
    await store.bind(ME)
    await store.put('copyPosts', B, desc(), bytesOf(4))
    await store.putThumb(B, SHA, bytesOf(4), 'image/jpeg')
    clock.t += 14 * DAY
    t.alike(await store.read('copyPosts', B, desc()), bytesOf(4), 'fourteen days still read')
    clock.t += 1
    t.is(await store.read('copyPosts', B, desc()), null)
    t.is(await store.readThumb(B, SHA), null)
    t.is(backend.state.meta.size, 0, 'expired entries are removed')
  }
  {
    const { store, backend, clock } = await copySetup({ maxFiles: 2 })
    await store.bind(ME)
    await store.put('copyPosts', B, desc({ start: 1 }), bytesOf(4))
    clock.t += 1
    await store.putThumb(B, SHA, bytesOf(4), 'image/jpeg')
    clock.t += 1
    await store.put('copyAvatars', B, desc({ start: 2 }), bytesOf(4))
    t.alike([...backend.state.meta.keys()].sort(), ['copyAvatars/' + B + '-' + CORE + '-2-1', 'copyGroupThumbs/' + B + '-' + SHA], 'group pictures share the file cap, oldest first')
  }
  {
    const { store, backend } = await copySetup()
    await store.bind(ME)
    await store.put('copyPosts', A, desc({ start: 1 }), bytesOf(4))
    await store.putThumb(B, SHA, bytesOf(4), 'image/jpeg')
    await store.putThumb(A, SHA2, bytesOf(4), 'image/jpeg')
    t.is(await store.retain(['copyPosts', 'copyGroupThumbs'], [{ kind: 'copyPosts', author: A, d: desc({ start: 1 }) }]), true)
    t.is(await store.retain(['copyGroupThumbs'], []), true)
    t.is(backend.state.meta.size, 3, 'retain never prunes group pictures')
    t.is(await store.retainThumbs('nope'), false, 'a non-list is ignored')
    t.is(await store.retainThumbs([{ author: B.toUpperCase(), sha: SHA }, null, { author: 'x', sha: SHA2 }]), true)
    t.alike([...backend.state.meta.keys()].sort(), ['copyGroupThumbs/' + B + '-' + SHA, 'copyPosts/' + A + '-' + CORE + '-1-1'], 'unnamed group pictures go, other kinds stay')
    t.is(await store.dropRanges([{ core: CORE, start: 0, blocks: 9 }]), true)
    t.alike([...backend.state.meta.keys()], ['copyGroupThumbs/' + B + '-' + SHA], 'a range revoke does not reach a group picture')
    t.is(await store.dropAuthors([B]), true)
    t.is(backend.state.meta.size, 0, 'a block does')
    await store.putThumb(B, SHA, bytesOf(4), 'image/jpeg')
    t.is(await store.retainThumbs([]), true)
    t.is(backend.state.meta.size, 0, 'an empty list removes every group picture')
  }
})
