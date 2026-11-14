'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

test('embedKey validates its parts', async (t) => {
  const { embedKey } = await import('../src/embedKeep.js')
  t.is(embedKey('row', 'quote', 'https://player'), 'row:quote|https://player')
  t.is(embedKey('row', undefined, 'https://player'), 'row|https://player')
  t.is(embedKey('row', '', 'https://player'), 'row|https://player')
  for (const bad of ['', null, undefined, 1, {}, Symbol('key')]) {
    t.is(embedKey(bad, undefined, 'url'), '', 'invalid row key')
    t.is(embedKey('row', undefined, bad), '', 'invalid URL')
  }
  for (const bad of [null, 1, {}, false, Symbol('part')]) {
    t.is(embedKey('row', bad, 'url'), '', 'invalid part')
  }
})

test('show preserves ownership and updates spec and row', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const release = () => {}
  const spec = { url: 'first' }
  const next = { url: 'second' }
  let changes = 0
  keep.subscribe(() => { changes++ })
  t.is(keep.has('key'), false)
  for (const bad of ['', null, undefined, 1, {}]) t.is(keep.show(bad, spec, release), false)
  t.is(keep.show('key', spec, null), false)
  t.is(changes, 0)
  t.is(keep.show('key', spec, release), true)
  t.is(keep.has('key'), true)
  const first = keep.list()[0]
  t.alike(first, { key: 'key', row: '', spec, rect: null, release, orphan: false, ready: false })
  t.ok(Object.isFrozen(first))
  t.is(keep.show('key', next, () => {}, 'other'), false)
  t.is(keep.list()[0], first)
  t.is(changes, 1)
  t.is(keep.show('key', next, release, 'row'), true)
  t.is(keep.list()[0].spec, next)
  t.is(keep.list()[0].row, 'row')
  t.not(keep.list()[0], first)
  t.is(first.spec, spec, 'old entry is unchanged')
  t.ok(Object.isFrozen(keep.list()[0]))
  t.is(changes, 2)
  const snapshot = keep.list()
  t.is(keep.show('key', next, release, 'row'), true)
  t.is(keep.list(), snapshot, 'unchanged show keeps the snapshot')
  t.is(changes, 2)
})

test('orphan and claim retain the provider ownership', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const spec = { url: 'player' }
  let releases = 0
  const release = () => { releases++ }
  keep.show('key', spec, release, 'row')
  keep.place('key', { x: 1, y: 2, w: 3, h: 4 })
  const placed = keep.list()[0]
  t.is(keep.hasOrphan(), false)
  t.is(keep.claim('key'), null)
  t.is(keep.claim('unknown'), null)
  t.is(keep.orphan('unknown'), false)
  t.is(keep.orphan('key'), true)
  const orphaned = keep.list()[0]
  t.not(orphaned, placed)
  t.ok(Object.isFrozen(orphaned))
  t.is(orphaned.rect, null)
  t.is(orphaned.orphan, true)
  t.is(placed.orphan, false)
  t.is(keep.hasOrphan(), true)
  const snapshot = keep.list()
  t.is(keep.orphan('key'), true)
  t.is(keep.list(), snapshot, 'orphaning twice is a no-op')
  const claimed = keep.claim('key')
  t.is(claimed.release, release)
  t.is(claimed.spec, spec)
  t.not(keep.list()[0], orphaned)
  t.ok(Object.isFrozen(keep.list()[0]))
  t.is(orphaned.orphan, true, 'claim leaves the old entry unchanged')
  t.is(keep.hasOrphan(), false)
  t.is(keep.claim('key'), null)
  t.is(releases, 0, 'orphan and claim never release the player')
  keep.orphan('key')
  t.is(keep.drop('key'), true)
  t.is(keep.hasOrphan(), false)
  t.is(keep.has('key'), false)
  t.is(keep.drop('key'), false)
  t.is(releases, 1)
})

test('dropAll and dispose release every entry once', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const releases = [0, 0]
  for (let i = 0; i < 2; i++) keep.show('key' + i, {}, () => { releases[i]++ })
  keep.orphan('key0')
  keep.dropAll()
  t.alike(releases, [1, 1])
  t.alike(keep.list(), [])
  const empty = keep.list()
  keep.dropAll()
  t.is(keep.list(), empty)
  t.alike(releases, [1, 1])
  keep.show('last', {}, () => { releases[0]++ })
  keep.dispose()
  keep.dispose()
  t.alike(releases, [2, 1])
  t.alike(keep.list(), [])
  t.is(keep.orphan('last'), false)
  t.is(keep.orphan('unknown'), false)
  t.is(keep.show('new', {}, () => {}), false)
  t.is(keep.hasOrphan(), false)
})

test('prune checks only orphan row keys and keeps a throwing predicate', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const released = []
  for (const key of ['live', 'kept', 'gone', 'throws']) {
    keep.show(key, {}, () => { released.push(key) }, 'row-' + key)
    if (key !== 'live') keep.orphan(key)
  }
  const calls = []
  keep.prune((row, key) => {
    calls.push([row, key])
    if (key === 'throws') throw new Error('predicate failed')
    return key === 'kept'
  })
  t.alike(calls, [['row-kept', 'kept'], ['row-gone', 'gone'], ['row-throws', 'throws']])
  t.alike(released, ['gone'])
  t.alike(keep.list().map((entry) => entry.key), ['live', 'kept', 'throws'])
  keep.prune(() => false)
  t.alike(released, ['gone', 'kept', 'throws'])
  t.is(keep.has('live'), true, 'non-orphans stay when the predicate fails')
  t.is(keep.hasOrphan(), false)
})

test('dropOrphans keeps claimed and active entries', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const released = []
  for (const key of ['active', 'claimed', 'orphan1', 'orphan2']) {
    keep.show(key, {}, () => { released.push(key) })
    if (key !== 'active') keep.orphan(key)
  }
  keep.claim('claimed')
  keep.dropOrphans()
  t.alike(released, ['orphan1', 'orphan2'])
  t.alike(keep.list().map((entry) => entry.key), ['active', 'claimed'])
  t.is(keep.hasOrphan(), false)
  const snapshot = keep.list()
  keep.dropOrphans()
  t.is(keep.list(), snapshot)
})

test('throwing releases and listeners do not stop cleanup or notification', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  let throws = 0
  let releases = 0
  let changes = 0
  const offThrow = keep.subscribe(() => { throw new Error('listener failed') })
  const off = keep.subscribe(() => { changes++ })
  keep.show('throws', {}, () => {
    throws++
    keep.drop('throws')
    throw new Error('release failed')
  })
  keep.show('other', {}, () => { releases++ })
  t.is(changes, 2)
  keep.dropAll()
  t.is(throws, 1)
  t.is(releases, 1)
  t.is(changes, 3)
  keep.dropAll()
  t.is(throws, 1)
  t.is(releases, 1)
  t.is(changes, 3)
  off()
  off()
  offThrow()
  keep.show('new', {}, () => {})
  t.is(changes, 3, 'unsubscribe stops notifications')
})

test('place validates rectangles and preserves unchanged snapshots and entries', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const empty = keep.list()
  t.is(keep.list(), empty)
  keep.show('first', {}, () => {})
  t.not(keep.list(), empty)
  keep.show('other', {}, () => {})
  const before = keep.list()
  const first = before[0]
  const other = before[1]
  let changes = 0
  keep.subscribe(() => { changes++ })
  keep.place('unknown', { x: 0, y: 0, w: 1, h: 1 })
  keep.place('first', null)
  t.is(keep.list(), before)
  const rect = { x: -1, y: 2, w: 30, h: 40 }
  t.is(keep.place('first', rect), undefined)
  const placed = keep.list()
  t.is(keep.list(), placed)
  t.not(placed, before)
  t.not(placed[0], first)
  t.is(placed[1], other, 'unchanged entries keep their identity')
  t.ok(Object.isFrozen(placed[0]))
  t.alike(placed[0].rect, rect)
  t.is(first.rect, null)
  keep.place('first', { ...rect })
  t.is(changes, 1, 'the same rectangle twice notifies once')
  t.is(keep.list(), placed)
  rect.y = 99
  t.is(placed[0].rect.y, 2, 'caller mutation cannot change the stored rectangle')
  const invalid = [null, undefined, {}, { x: 0, y: 0, w: 0, h: 1 }, { x: 0, y: 0, w: 1, h: 0 }]
  for (const field of ['x', 'y', 'w', 'h']) {
    for (const value of [NaN, Infinity, -Infinity, '1', undefined]) {
      invalid.push({ x: 0, y: 0, w: 1, h: 1, [field]: value })
    }
  }
  invalid.push({ x: 0, y: 0, w: -1, h: 1 }, { x: 0, y: 0, w: 1, h: -1 })
  for (const bad of invalid) {
    keep.place('first', { x: 0, y: 0, w: 1, h: 1 })
    keep.place('first', bad)
    t.is(keep.list()[0].rect, null)
    const snapshot = keep.list()
    const count = changes
    keep.place('first', bad)
    t.is(keep.list(), snapshot, 'null to null keeps the snapshot')
    t.is(changes, count, 'null to null does not notify')
  }
})

test('embedKeep stays pure', async (t) => {
  await import('../src/embedKeep.js')
  const source = fs.readFileSync(path.join(__dirname, '../src/embedKeep.js'), 'utf8')
  t.absent(/^\s*import\b/m.test(source), 'no import statement')
  t.absent(/\brequire\s*\(/.test(source), 'no require call')
  t.absent(source.includes('\u2014'), 'no em dash')
})

test('place on an orphan stores nothing until claim', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const spec = { url: 'player' }
  const release = () => {}
  const rect = { x: 1, y: 2, w: 3, h: 4 }
  keep.show('key', spec, release, 'row')
  keep.orphan('key')
  const orphaned = keep.list()[0]
  const snapshot = keep.list()
  let changes = 0
  keep.subscribe(() => { changes++ })
  t.is(keep.place('key', rect), undefined)
  t.is(changes, 0, 'place on an orphan calls no listener')
  t.is(keep.list(), snapshot, 'place on an orphan keeps the snapshot')
  t.is(keep.list()[0], orphaned)
  t.is(orphaned.rect, null)
  t.is(orphaned.orphan, true)
  const claimed = keep.claim('key')
  t.is(claimed.release, release)
  t.is(claimed.spec, spec)
  keep.place('key', rect)
  t.alike(keep.list()[0].rect, rect)
  t.is(keep.list()[0].orphan, false)
  t.is(orphaned.rect, null, 'place leaves the orphan entry unchanged')
  t.is(changes, 2, 'claim and the later place each notify')
})

test('list returns the same frozen snapshot until the registry changes', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const empty = keep.list()
  t.ok(Object.isFrozen(empty))
  t.is(keep.list(), empty, 'no change returns the same snapshot')
  keep.show('key', {}, () => {})
  const shown = keep.list()
  t.ok(Object.isFrozen(shown))
  t.not(shown, empty)
  t.is(keep.list(), shown, 'no change returns the same snapshot')
  keep.dropAll()
  const cleared = keep.list()
  t.ok(Object.isFrozen(cleared))
  t.not(cleared, shown)
  t.not(cleared, empty)
  t.is(keep.list(), cleared, 'no change returns the same snapshot')
  t.alike(cleared, [])
})

test('re-entrant release and listeners leave the registry consistent', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const spec = { url: 'player' }
  const innerSpec = { url: 'inner' }
  const release = () => {}
  const innerRelease = () => {}

  const keep = createEmbedKeep()
  let finished = false
  let shown = null
  let keyReleases = 0
  let otherReleases = 0
  t.is(keep.show('key', { url: 'key' }, () => {
    keyReleases++
    shown = keep.show('other', { url: 'other' }, () => { otherReleases++ })
    keep.dropAll()
    finished = true
  }), true)
  t.is(keep.drop('key'), true)
  t.ok(finished, 'a release may show another key and dropAll')
  t.is(shown, true)
  t.is(keyReleases, 1)
  t.is(otherReleases, 1)
  t.alike(keep.list().map((entry) => entry.key), ['key', 'other'].filter((key) => keep.has(key)))
  t.is(keep.has('key'), false, 'list matches has')
  t.is(keep.has('other'), false, 'list matches has')
  t.ok(Object.isFrozen(keep.list()))
  t.is(keep.show('after', {}, () => {}), true)

  const onClaim = createEmbedKeep()
  let claimReleases = 0
  onClaim.show('key', spec, () => { claimReleases++ }, 'row')
  onClaim.orphan('key')
  onClaim.subscribe(() => { onClaim.drop('key') })
  t.is(onClaim.claim('key'), null, 'a listener that drops the key during claim')
  t.is(onClaim.has('key'), false)
  t.alike(onClaim.list(), [])
  t.is(claimReleases, 1)

  const onShow = createEmbedKeep()
  let showReleases = 0
  onShow.subscribe(() => { onShow.drop('key') })
  t.is(onShow.show('key', spec, () => { showReleases++ }), false, 'a listener that drops the key during show')
  t.is(onShow.has('key'), false)
  t.alike(onShow.list(), [])
  t.is(showReleases, 1)

  const onNotify = createEmbedKeep()
  let inner = null
  let guard = false
  onNotify.subscribe(() => {
    if (guard) return
    guard = true
    inner = onNotify.show('other', innerSpec, innerRelease)
  })
  t.is(onNotify.show('key', spec, release, 'row'), true, 'a listener may show another key during show')
  t.is(inner, true)
  t.alike(onNotify.list().map((entry) => entry.key), ['key', 'other'])
  t.is(onNotify.list()[0].spec, spec)
  t.is(onNotify.list()[1].spec, innerSpec)
  t.is(onNotify.list()[0].release, release)
  t.is(onNotify.list()[1].release, innerRelease)
  t.is(onNotify.has('key'), true)
  t.is(onNotify.has('other'), true)

  const onClaimNotify = createEmbedKeep()
  let claimInner = null
  let claimGuard = false
  onClaimNotify.show('key', spec, release, 'row')
  onClaimNotify.orphan('key')
  onClaimNotify.subscribe(() => {
    if (claimGuard) return
    claimGuard = true
    claimInner = onClaimNotify.show('other', innerSpec, innerRelease)
  })
  const claimed = onClaimNotify.claim('key')
  t.is(claimInner, true)
  t.ok(claimed, 'a listener may show another key during claim')
  t.is(claimed && claimed.release, release)
  t.is(claimed && claimed.spec, spec)
  t.alike(onClaimNotify.list().map((entry) => entry.key), ['key', 'other'])
  t.is(onClaimNotify.list()[0].orphan, false)
  t.is(onClaimNotify.has('key'), true)
  t.is(onClaimNotify.has('other'), true)
})

test('ready is set once and survives show, place, orphan and claim', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const release = () => {}
  const spec = { url: 'player' }
  let changes = 0
  keep.subscribe(() => { changes++ })
  keep.show('key', spec, release, 'row')
  t.is(keep.list()[0].ready, false, 'a new entry is not ready')
  t.is(changes, 1)
  const snapshot = keep.list()
  t.is(keep.ready('unknown'), undefined)
  t.is(keep.list(), snapshot, 'an unknown key changes nothing')
  t.is(changes, 1, 'and notifies nobody')
  const before = keep.list()[0]
  keep.ready('key')
  const after = keep.list()[0]
  t.is(after.ready, true)
  t.not(after, before, 'a frozen replacement entry')
  t.ok(Object.isFrozen(after))
  t.is(before.ready, false, 'the old entry is unchanged')
  t.is(after.spec, spec)
  t.is(after.release, release)
  t.is(changes, 2, 'the change notifies')
  const readySnapshot = keep.list()
  keep.ready('key')
  t.is(keep.list(), readySnapshot, 'a second ready keeps the snapshot')
  t.is(changes, 2, 'and notifies nobody')
  keep.show('key', { url: 'other' }, release, 'row2')
  t.is(keep.list()[0].ready, true, 'show keeps ready')
  keep.place('key', { x: 1, y: 2, w: 3, h: 4 })
  t.is(keep.list()[0].ready, true, 'place keeps ready')
  keep.orphan('key')
  t.is(keep.list()[0].ready, true, 'orphan keeps ready')
  t.ok(keep.claim('key'))
  t.is(keep.list()[0].ready, true, 'claim keeps ready')
  keep.drop('key')
  keep.show('key', spec, release, 'row')
  t.is(keep.list()[0].ready, false, 'a new entry for the same key starts not ready')
})
