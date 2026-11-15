'use strict'

// The browser outbox's storage keys (src/outboxMigrate.js): the sealed queue
// under its own key, and the v1 items an older build keeps under the old key
// merged in by id, against an in-memory storage. The module imports ./outbox
// without an extension, as Metro resolves it, so a module hook adds '.js'
// for relative imports under src/.
const fs = require('node:fs')
const path = require('node:path')
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const hooks = `
export async function resolve (specifier, context, next) {
  if (/^\\.\\.?\\/[^.]*$/.test(specifier) && context.parentURL && context.parentURL.includes('/src/')) {
    return next(specifier + '.js', context)
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const load = async () => ({ o: await import('../src/outbox.js'), m: await import('../src/outboxMigrate.js') })

const A = 'a'.repeat(64)
const ASSOC = 'c'.repeat(64)
const T0 = Date.parse('2026-11-15T12:00:00.000Z')
const BOX = 'Qk9Y'.repeat(20)
const idOf = (n) => n.toString(16).padStart(16, '0')

// A sealed (v2) item, as the new build stores it.
function sealed (o, n) {
  return o.enqueue([], { author: A, association: ASSOC, kind: 'post', to: null, text: 'x', box: BOX, now: T0 + n, id: idOf(n) })[0]
}

// A clear (v1) item, as a build from before the seal stores it.
function legacy (o, n, text = 'antigo ' + n) {
  const { box, ...rest } = o.storedItem(sealed(o, n))
  return { ...rest, v: 1, to: null, text }
}

const legacyValue = (items) => JSON.stringify({ v: 1, items })

// localStorage in memory. `hooks.afterSet(key)` runs after each setItem.
function memoryStorage (initial = {}, hooks = {}) {
  const data = new Map(Object.entries(initial))
  const writes = []
  return {
    data,
    writes,
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => {
      if (hooks.setItem) hooks.setItem(key)
      writes.push(['set', key])
      data.set(key, String(value))
      if (hooks.afterSet) hooks.afterSet(key)
    },
    removeItem: (key) => {
      if (hooks.removeItem) hooks.removeItem(key)
      writes.push(['remove', key])
      data.delete(key)
    }
  }
}

test('the keys: a new key for the sealed queue, the old one watched too', async (t) => {
  const { m } = await load()
  t.is(m.OUTBOX_KEY, 'varanda-web-outbox-v2')
  t.is(m.LEGACY_OUTBOX_KEY, 'varanda-web-outbox')
  t.ok(m.isOutboxKey(m.OUTBOX_KEY))
  t.ok(m.isOutboxKey(m.LEGACY_OUTBOX_KEY), 'an older build in another tab writes here')
  t.ok(m.isOutboxKey(null), 'storage cleared')
  t.absent(m.isOutboxKey('varanda-web-outbox-v3'))
  t.absent(m.isOutboxKey('outra'))
})

test('nothing under the old key: the queue as stored, nothing written', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.OUTBOX_KEY]: o.serializeOutbox([sealed(o, 1)]) })
  t.alike(m.loadMigrated(storage).map((i) => i.id), [idOf(1)])
  t.alike(storage.writes, [])
  t.alike(m.loadMigrated(memoryStorage()), [], 'empty storage')
})

test('the old key\'s items are merged by id, then the old key is removed', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({
    [m.OUTBOX_KEY]: o.serializeOutbox([sealed(o, 1), sealed(o, 2)]),
    [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 2), legacy(o, 3), legacy(o, 3, 'repetido')])
  })
  const items = m.loadMigrated(storage)
  t.alike(items.map((i) => [i.id, i.v]), [[idOf(1), 2], [idOf(2), 2], [idOf(3), 1]], 'a queued id keeps the queued item; a repeated id is merged once')
  t.is(items[2].text, 'antigo 3')
  t.alike(o.parseOutbox(storage.data.get(m.OUTBOX_KEY)), items, 'saved under the new key')
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY), 'the old key removed')
  t.alike(storage.writes, [['set', m.OUTBOX_KEY], ['set', m.MERGED_IDS_KEY], ['remove', m.LEGACY_OUTBOX_KEY]], 'saved before the removal')
  t.alike(JSON.parse(storage.data.get(m.MERGED_IDS_KEY)), [idOf(2), idOf(3)], 'the merged id is remembered, and the one already queued')
})

test('a crash after the merge and before the removal only merges the same ids again', async (t) => {
  const { o, m } = await load()
  // The page dies right after the merge was saved: the removal never happens.
  const storage = memoryStorage({
    [m.OUTBOX_KEY]: o.serializeOutbox([sealed(o, 1)]),
    [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 2), legacy(o, 3)])
  }, { removeItem: () => { throw new Error('crash') } })
  m.loadMigrated(storage)
  t.alike(storage.writes, [['set', m.OUTBOX_KEY], ['set', m.MERGED_IDS_KEY]], 'merged, not removed')
  t.ok(storage.data.has(m.LEGACY_OUTBOX_KEY), 'the old key is still there')
  const reloaded = memoryStorage(Object.fromEntries(storage.data))
  const items = m.loadMigrated(reloaded)
  t.alike(items.map((i) => i.id), [idOf(1), idOf(2), idOf(3)], 'no duplicates')
  t.alike(o.parseOutbox(reloaded.data.get(m.OUTBOX_KEY)).map((i) => i.id), [idOf(1), idOf(2), idOf(3)])
  t.alike(reloaded.writes, [['remove', m.LEGACY_OUTBOX_KEY]], 'nothing new to merge: only the removal')
})

test('an old tab writing between the merge and the removal: the old key stays and is merged next time', async (t) => {
  const { o, m } = await load()
  let wrote = false
  const storage = memoryStorage({
    [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1)])
  }, {
    afterSet: (key) => {
      if (key !== m.OUTBOX_KEY || wrote) return
      wrote = true
      storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([legacy(o, 1), legacy(o, 2)]))
    }
  })
  t.alike(m.loadMigrated(storage).map((i) => i.id), [idOf(1)])
  t.ok(storage.data.has(m.LEGACY_OUTBOX_KEY), 'changed since it was read: not removed')
  t.alike(m.loadMigrated(storage).map((i) => i.id), [idOf(1), idOf(2)], 'the item written meanwhile is merged')
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
})

test('an older build in another tab: fresh v1 items are migrated, its empty write erases nothing', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.OUTBOX_KEY]: o.serializeOutbox([sealed(o, 1), sealed(o, 2)]) })
  const before = storage.data.get(m.OUTBOX_KEY)
  // The old tab sent or deleted its last item: it writes an empty v1 queue.
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([]))
  t.ok(m.isOutboxKey(m.LEGACY_OUTBOX_KEY), 'the storage event reaches this tab')
  t.alike(m.loadMigrated(storage).map((i) => i.id), [idOf(1), idOf(2)], 'the sealed queue is intact')
  t.is(storage.data.get(m.OUTBOX_KEY), before, 'not rewritten')
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
  // The old tab queues a new post while offline.
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([legacy(o, 3, 'escrito na aba antiga')]))
  const items = m.loadMigrated(storage)
  t.alike(items.map((i) => [i.id, i.v]), [[idOf(1), 2], [idOf(2), 2], [idOf(3), 1]], 'migrated, to be sealed after the unlock')
  t.is(items[2].text, 'escrito na aba antiga')
})

test('a merge that cannot be saved keeps the old key and leaves its items out', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({
    [m.OUTBOX_KEY]: o.serializeOutbox([sealed(o, 1)]),
    [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 2)])
  }, { setItem: () => { throw new Error('QuotaExceededError') } })
  t.alike(m.loadMigrated(storage).map((i) => i.id), [idOf(1)])
  t.ok(storage.data.has(m.LEGACY_OUTBOX_KEY), 'nothing lost')
  const removing = memoryStorage({
    [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 2)])
  }, { removeItem: () => { throw new Error('blocked') } })
  t.alike(m.loadMigrated(removing).map((i) => i.id), [idOf(2)], 'a removal that fails is tried again on the next load')
})

// What an old tab writes back after it handled an item it still held.
const sentBy = (o, n, state, extra = {}) => ({ ...legacy(o, n), state, floorSeq: 3, attemptAt: T0 + 5, ...extra })
const stateOf = (items, n) => items.find((i) => i.id === idOf(n)).state

test('a plain upgrade: the old items arrive queued, the old key goes, nothing else changes', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1), legacy(o, 2)]) })
  const items = m.loadMigrated(storage)
  t.alike(items.map((i) => [i.id, i.state]), [[idOf(1), 'queued'], [idOf(2), 'queued']])
  t.ok(o.parseOutbox(storage.data.get(m.OUTBOX_KEY)).every((i) => m.followsLegacy(i)), 'stored with the mark of an item merged from the old key')
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
  t.alike(m.loadMigrated(storage).map((i) => i.state), ['queued', 'queued'], 'nothing under the old key: left as it is')
})

test('an item the old tab is already sending is merged as uncertain, never queued', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([sentBy(o, 1, 'sending'), legacy(o, 2)]) })
  const items = m.loadMigrated(storage)
  t.is(stateOf(items, 1), 'uncertain', 'its request may still be in flight')
  t.is(items[0].lastError, o.UNCERTAIN_MESSAGE)
  t.absent(m.followsLegacy(items[0]), 'not marked: nothing to follow')
  t.is(stateOf(items, 2), 'queued')
  t.is(o.sendingOf(items, A, ASSOC), null, 'nothing left for a reconciliation to put back to queued')
  t.alike(o.parseOutbox(storage.data.get(m.OUTBOX_KEY)), items, 'saved')
})

test('an old tab that sent a merged item: this tab\'s copy follows it, never back to queued', async (t) => {
  const { o, m } = await load()
  for (const [theirs, expected] of [['sending', 'uncertain'], ['uncertain', 'uncertain'], ['failed', 'failed']]) {
    const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1), legacy(o, 2)]) })
    m.loadMigrated(storage)
    // The old tab still holds both, sends the first and rewrites the old key.
    storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([sentBy(o, 1, theirs, { lastError: 'falhou' }), legacy(o, 2)]))
    const items = m.loadMigrated(storage)
    t.is(stateOf(items, 1), expected, 'the old tab\'s ' + theirs + ' item')
    t.is(stateOf(items, 2), 'queued', 'the other one is still queued')
    t.alike(o.parseOutbox(storage.data.get(m.OUTBOX_KEY)), items, 'saved')
    t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
    // Settled: a later old-key value no longer matters for that id.
    storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([legacy(o, 2)]))
    t.is(stateOf(m.loadMigrated(storage), 1), expected)
  }
})

test('an old tab that claimed a merged item and then wrote the queue without it: each value it wrote counts, in order', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1), legacy(o, 2)]) })
  m.loadMigrated(storage)
  // Two storage events: the claim, then the queue without the item it sent.
  const claimed = legacyValue([sentBy(o, 1, 'sending'), legacy(o, 2)])
  const sent = legacyValue([legacy(o, 2)])
  storage.data.set(m.LEGACY_OUTBOX_KEY, sent)
  const items = m.loadMigrated(storage, claimed)
  t.is(stateOf(items, 1), 'uncertain')
  t.is(stateOf(items, 2), 'queued')
  t.is(items.find((i) => i.id === idOf(1)).lastError, o.UNCERTAIN_MESSAGE, 'the usual uncertain message')
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
  t.alike(m.loadMigrated(storage, sent).map((i) => [i.id, i.state]), [[idOf(1), 'uncertain'], [idOf(2), 'queued']], 'the second event changes nothing')
})

test('an old tab that still holds the item queued, or writes without it, changes nothing', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1)]) })
  m.loadMigrated(storage)
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([legacy(o, 1), legacy(o, 2)]))
  t.alike(m.loadMigrated(storage).map((i) => [i.id, i.state]), [[idOf(1), 'queued'], [idOf(2), 'queued']])
  // Without the item: no evidence that it went out (it cannot hold it any more).
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([legacy(o, 3)]))
  t.alike(m.loadMigrated(storage).map((i) => [i.id, i.state]), [[idOf(1), 'queued'], [idOf(2), 'queued'], [idOf(3), 'queued']])
  // Its claim still counts later on.
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([sentBy(o, 1, 'sending')]))
  t.is(stateOf(m.loadMigrated(storage), 1), 'uncertain')
})

test('after the merge, an old tab\'s empty queue or a value it cannot have written downgrades nothing', async (t) => {
  const { o, m } = await load()
  const values = [legacyValue([]), '{', 'null', JSON.stringify({ v: 3, items: [sentBy(o, 1, 'sending')] })]
  for (const value of values) {
    const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1)]) })
    m.loadMigrated(storage)
    t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY), 'removed by the merge')
    t.is(stateOf(m.loadMigrated(storage, value), 1), 'queued', 'in a storage event: ' + value)
    // The old tab now reads an empty queue: a wake, a retry or the filter after a send writes it.
    storage.data.set(m.LEGACY_OUTBOX_KEY, value)
    const items = m.loadMigrated(storage)
    t.is(stateOf(items, 1), 'queued', 'under the old key: ' + value)
    t.ok(m.followsLegacy(items[0]), 'still follows the old tab')
    t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
  }
})

test('a storage event\'s value counts even when the old key is already gone', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1), legacy(o, 2)]) })
  m.loadMigrated(storage)
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY), 'removed by the merge')
  // The old tab claimed the first one right before the removal: only the event
  // carries its write.
  const items = m.loadMigrated(storage, legacyValue([sentBy(o, 1, 'sending'), legacy(o, 2)]))
  t.is(stateOf(items, 1), 'uncertain')
  t.is(stateOf(items, 2), 'queued')
  t.alike(o.parseOutbox(storage.data.get(m.OUTBOX_KEY)), items, 'saved')
  t.alike(m.loadMigrated(storage, null), items, 'the removal\'s own event changes nothing')
})

test('two windows of this build: the one that did not merge follows the old tab too, and so does a later visit', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1), legacy(o, 2)]) })
  // Window 1 merges the old key.
  m.loadMigrated(storage)
  // The old tab claims the first item (its write defeated the removal, or came
  // right after it). Window 2 handles the event first and removes the old key.
  const claimed = legacyValue([sentBy(o, 1, 'sending'), legacy(o, 2)])
  storage.data.set(m.LEGACY_OUTBOX_KEY, claimed)
  const second = m.loadMigrated(storage, claimed)
  t.is(stateOf(second, 1), 'uncertain', 'window 2')
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
  // Window 1 handles the same event later: the old key is already gone.
  const first = m.loadMigrated(storage, claimed)
  t.is(stateOf(first, 1), 'uncertain', 'window 1, from the shared queue')
  t.is(stateOf(first, 2), 'queued')
  // A later visit: the second item still follows the old tab.
  const later = memoryStorage(Object.fromEntries(storage.data))
  later.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([sentBy(o, 2, 'failed', { lastError: 'falhou' })]))
  const reloaded = m.loadMigrated(later)
  t.is(stateOf(reloaded, 2), 'failed')
  t.is(reloaded.find((i) => i.id === idOf(2)).lastError, 'falhou')
})

test('an item this tab claimed ignores the old tab; one the person only released still follows it', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1), legacy(o, 2), legacy(o, 3)]) })
  const items = m.loadMigrated(storage)
  // This tab sent the first one (the claim is saved before the request). The
  // person released the second ("Enviar" keeps the mark: the drain has not
  // claimed it yet) and discarded the third.
  const mine = o.claim(items, idOf(1), { now: T0 + 9, floorSeq: 7 })
  storage.data.set(m.OUTBOX_KEY, o.serializeOutbox(m.forgetMigrated(mine, idOf(3)).filter((i) => i.id !== idOf(3))))
  // The old tab's claim of the second one arrives before this tab claims it.
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([sentBy(o, 1, 'failed'), sentBy(o, 2, 'sending'), sentBy(o, 3, 'sending')]))
  const after = m.loadMigrated(storage)
  t.alike(after.map((i) => [i.id, i.state]), [[idOf(1), 'sending'], [idOf(2), 'uncertain']], 'the claimed one is not rewritten; the released one is never sent twice; the discarded one is not merged again')
  t.absent(after.some((i) => m.followsLegacy(i)), 'nothing follows the old tab any more')
  t.is(after[1].migrated, undefined, 'settled: the mark is gone')
  t.is(m.forgetMigrated(after, idOf(2)), after, 'nothing to forget: the same array')
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
})

test('an id merged before is not merged again when the old key comes back', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1), legacy(o, 2)]) })
  m.loadMigrated(storage)
  // Sent here, and discarded here.
  storage.data.set(m.OUTBOX_KEY, o.serializeOutbox([]))
  // An old tab's write raced the removal: the old key is back with both.
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([legacy(o, 1), legacy(o, 2), legacy(o, 3)]))
  t.alike(m.loadMigrated(storage).map((i) => i.id), [idOf(3)], 'only the new one')
  t.alike(JSON.parse(storage.data.get(m.MERGED_IDS_KEY)), [idOf(1), idOf(2), idOf(3)])
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
  // A malformed or oversized list counts as none.
  for (const list of ['{', JSON.stringify({ ids: [idOf(1)] }), JSON.stringify(Array.from({ length: m.MERGED_IDS_MAX + 1 }, (_, i) => idOf(i + 1)))]) {
    const planted = memoryStorage({ [m.MERGED_IDS_KEY]: list, [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1)]) })
    t.alike(m.loadMigrated(planted).map((i) => i.id), [idOf(1)], 'merged: ' + list.slice(0, 20))
  }
  // Only the newest MERGED_IDS_MAX ids are kept.
  const full = Array.from({ length: m.MERGED_IDS_MAX }, (_, i) => idOf(1000 + i))
  const capped = memoryStorage({ [m.MERGED_IDS_KEY]: JSON.stringify(full), [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1)]) })
  m.loadMigrated(capped)
  t.alike(JSON.parse(capped.data.get(m.MERGED_IDS_KEY)), [...full.slice(1), idOf(1)])
})

test('everything under the old key is merged even past OUTBOX_MAX, and the old key goes', async (t) => {
  const { o, m } = await load()
  const mine = Array.from({ length: o.OUTBOX_MAX - 1 }, (_, i) => sealed(o, i + 1))
  const storage = memoryStorage({
    [m.OUTBOX_KEY]: o.serializeOutbox(mine),
    [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 100), legacy(o, 101), legacy(o, 102)])
  })
  const items = m.loadMigrated(storage)
  t.is(items.length, o.OUTBOX_MAX + 2, 'over the cap: nothing is left behind for the old tab to claim')
  t.alike(items.slice(-3).map((i) => i.id), [idOf(100), idOf(101), idOf(102)])
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY), 'removed')
  t.exception(() => o.enqueue(items, { author: A, association: ASSOC, kind: 'post', to: null, text: 'x', box: BOX, now: T0 + 999, id: idOf(999) }), 'a new post here is refused as full')
})

test('ids already in the queue are recorded too: a list that was not saved heals on the next load', async (t) => {
  const { o, m } = await load()
  let crash = true
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1), legacy(o, 2)]) }, {
    setItem: (key) => { if (crash && key === m.MERGED_IDS_KEY) throw new Error('crash') },
    removeItem: () => { if (crash) throw new Error('crash') }
  })
  // The merge was saved; the page died before the list and the removal.
  m.loadMigrated(storage)
  t.absent(storage.data.has(m.MERGED_IDS_KEY))
  t.ok(storage.data.has(m.LEGACY_OUTBOX_KEY))
  crash = false
  t.alike(m.loadMigrated(storage).map((i) => i.id), [idOf(1), idOf(2)], 'nothing new to merge')
  t.is(storage.data.get(m.MERGED_IDS_KEY), JSON.stringify([idOf(1), idOf(2)]), 'the ids found in the queue are recorded')
  t.absent(storage.data.has(m.LEGACY_OUTBOX_KEY))
  // Sent here; then the old key comes back with it.
  storage.data.set(m.OUTBOX_KEY, o.serializeOutbox(o.parseOutbox(storage.data.get(m.OUTBOX_KEY)).filter((i) => i.id !== idOf(1))))
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([legacy(o, 1), legacy(o, 2)]))
  const writes = storage.writes.length
  t.alike(m.loadMigrated(storage).map((i) => i.id), [idOf(2)], 'not merged again')
  t.alike(storage.writes.slice(writes), [['remove', m.LEGACY_OUTBOX_KEY]], 'the list unchanged: not rewritten')
})

test('a storage event passes its value to the merge only for the old key', async (t) => {
  const { m } = await load()
  t.is(m.seenOf({ key: m.LEGACY_OUTBOX_KEY, newValue: 'x' }), 'x')
  t.is(m.seenOf({ key: m.LEGACY_OUTBOX_KEY, newValue: null }), null, 'the removal')
  t.is(m.seenOf({ key: m.OUTBOX_KEY, newValue: 'x' }), null, 'the sealed queue')
  t.is(m.seenOf({ key: null, newValue: null }), null, 'storage cleared')
  t.is(m.seenOf(null), null)
})

test('the provider: "Enviar" and "Tentar de novo" keep the mark, "apagar" drops it, the storage handler passes the event', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'outboxProvider.js'), 'utf8')
  const body = (name) => {
    const start = src.indexOf('const ' + name + ' = useCallback(')
    t.ok(start >= 0, name + ' found')
    return src.slice(start, src.indexOf('\n  }, [', start))
  }
  t.absent(body('release').includes('forgetMigrated'), 'release keeps the mark until the claim')
  t.absent(body('retry').includes('forgetMigrated'), 'retry keeps it too')
  t.ok(body('discard').includes('forgetMigrated('), 'discard drops it')
  t.ok(/const onStorage = \(event\) => \{[^}]*show\(loadOutbox\(seenOf\(event\)\)\)/.test(src), 'the handler passes the event through seenOf')
})

test('a sealed copy of a merged item is still the merged copy; a wake does not touch it', async (t) => {
  const { o, m } = await load()
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1)]) })
  const items = m.loadMigrated(storage)
  // The open pass seals the clear item; the network coming back wakes it.
  const woken = o.wake([o.sealedItem(items[0], BOX)], A, ASSOC, T0 + 99)
  storage.data.set(m.OUTBOX_KEY, o.serializeOutbox(woken))
  t.ok(m.followsLegacy(o.parseOutbox(storage.data.get(m.OUTBOX_KEY))[0]), 'the mark is stored with the sealed item')
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([sentBy(o, 1, 'sending')]))
  t.is(stateOf(m.loadMigrated(storage), 1), 'uncertain')
})

test('the old tab\'s state is applied only once it is saved', async (t) => {
  const { o, m } = await load()
  let blocked = false
  const storage = memoryStorage({ [m.LEGACY_OUTBOX_KEY]: legacyValue([legacy(o, 1)]) }, {
    setItem: () => { if (blocked) throw new Error('QuotaExceededError') }
  })
  m.loadMigrated(storage)
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([sentBy(o, 1, 'sending')]))
  blocked = true
  t.is(stateOf(m.loadMigrated(storage), 1), 'queued', 'not saved: shown as stored')
  t.ok(storage.data.has(m.LEGACY_OUTBOX_KEY), 'the old key stays')
  blocked = false
  t.is(stateOf(m.loadMigrated(storage), 1), 'uncertain', 'the next read applies it')
})

test('a planted mark only makes an item wait', async (t) => {
  const { o, m } = await load()
  const queued = { ...sealed(o, 1), migrated: 'queued|null|null' }
  const sending = { ...o.claim([sealed(o, 2)], idOf(2), { now: T0 + 5, floorSeq: 3 })[0], migrated: 'sending|' + (T0 + 5) + '|3' }
  const notString = { ...sealed(o, 3), migrated: 7 }
  const tooLong = { ...sealed(o, 4), migrated: 'q'.repeat(o.MIGRATED_MAX + 1) }
  const storage = memoryStorage({ [m.OUTBOX_KEY]: JSON.stringify({ v: 2, items: [queued, sending, notString, tooLong] }) })
  const items = m.loadMigrated(storage)
  t.alike(items.map((i) => [i.id, i.state]), [[idOf(1), 'queued'], [idOf(2), 'sending'], [idOf(3), 'queued'], [idOf(4), 'queued']], 'every item kept, nothing changed')
  t.ok(m.followsLegacy(items[0]))
  t.absent(m.followsLegacy(items[1]), 'only a queued item follows the old tab')
  t.is(items[2].migrated, undefined, 'a mark that is not a string is dropped')
  t.is(items[3].migrated, undefined, 'and one too long')
  t.alike(o.parseOutbox(o.serializeOutbox(items)), items, 'the mark survives a round trip')
  // A planted old-key value: the queued item waits, the sending one is left to reconcile.
  storage.data.set(m.LEGACY_OUTBOX_KEY, legacyValue([sentBy(o, 1, 'sending'), sentBy(o, 2, 'failed')]))
  const after = m.loadMigrated(storage)
  t.alike(after.map((i) => [i.id, i.state]), [[idOf(1), 'uncertain'], [idOf(2), 'sending'], [idOf(3), 'queued'], [idOf(4), 'queued']])
})
