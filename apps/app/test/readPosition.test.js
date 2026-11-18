'use strict'

const test = require('brittle')

test('dmTarget accepts only a non-empty string', async (t) => {
  const { dmTarget } = await import('../src/readPosition.js')
  t.is(dmTarget('ab'), 'ab')
  t.is(dmTarget(''), null)
  t.is(dmTarget(null), null)
  t.is(dmTarget(undefined), null)
  t.is(dmTarget(5), null)
})

test('groupTarget walks toward newer painted rows that are not own', async (t) => {
  const { groupTarget } = await import('../src/readPosition.js')
  const items = [
    { writer: 'w', seq: 5 }, { writer: 'w', seq: 4 }, { writer: 'w', seq: 3 }, { writer: 'w', seq: 2 }
  ]
  const rowKeys = ['w:2', 'w:4', 'w:5']
  const first = (seq) => ({ at: 1, writer: 'w', seq })
  t.is(groupTarget({ items, rowKeys, firstUnread: null }), null)
  t.is(groupTarget({ items, rowKeys, firstUnread: undefined }), null)
  t.is(groupTarget({ items, rowKeys, firstUnread: first(2) }), 'w:2', 'the item itself when painted')
  t.is(groupTarget({ items, rowKeys, firstUnread: first(3) }), 'w:4', 'a hidden item moves to the next newer row')
  t.is(groupTarget({ items, rowKeys, firstUnread: first(3), isOwn: (it) => it.seq === 4 }), 'w:5', 'own rows are skipped')
  t.is(groupTarget({ items, rowKeys, firstUnread: first(3), isOwn: () => true }), null, 'nothing left: open at the end')
  t.is(groupTarget({ items, rowKeys, firstUnread: first(1) }), 'w:1', 'older than loaded returns its key')
  t.is(groupTarget({ items, rowKeys: ['k2'], firstUnread: first(2), keyOf: (it) => 'k' + it.seq }), 'k2', 'custom keyOf')
})

test('openPlan picks end, row or older', async (t) => {
  const { openPlan, OPEN_OLDER_PAGES } = await import('../src/readPosition.js')
  t.is(OPEN_OLDER_PAGES, 3)
  t.alike(openPlan({ targetKey: null, rowKeys: ['a'], hasOlder: true, olderPagesLoaded: 0 }), { kind: 'end' })
  t.alike(openPlan({ targetKey: 'a', rowKeys: ['a', 'b'], hasOlder: true, olderPagesLoaded: 0 }), { kind: 'row', key: 'a' })
  t.alike(openPlan({ targetKey: 'x', rowKeys: ['a'], hasOlder: true, olderPagesLoaded: 2 }), { kind: 'older' })
  t.alike(openPlan({ targetKey: 'x', rowKeys: ['a', 'b'], hasOlder: true, olderPagesLoaded: 3 }), { kind: 'row', key: 'a' }, 'cap reached')
  t.alike(openPlan({ targetKey: 'x', rowKeys: ['a', 'b'], hasOlder: false, olderPagesLoaded: 0 }), { kind: 'row', key: 'a' }, 'nothing older')
  t.alike(openPlan({ targetKey: 'x', rowKeys: [], hasOlder: false, olderPagesLoaded: 0 }), { kind: 'end' })
  t.alike(openPlan({ targetKey: 'x', rowKeys: ['a'], hasOlder: true, olderPagesLoaded: 1, max: 1 }), { kind: 'row', key: 'a' }, 'custom max')
})

test('openPlan waits for the page in flight and stops on a failed one', async (t) => {
  const { openPlan } = await import('../src/readPosition.js')
  const rowKeys = ['a', 'b']
  t.alike(openPlan({ targetKey: 'x', rowKeys, hasOlder: true, olderPagesLoaded: 3, loading: true }), { kind: 'older' }, 'the third page still in flight does not reach the cap')
  t.alike(openPlan({ targetKey: 'x', rowKeys, hasOlder: true, olderPagesLoaded: 3, loading: false }), { kind: 'row', key: 'a' }, 'cap reached once it landed')
  t.alike(openPlan({ targetKey: 'x', rowKeys, hasOlder: true, olderPagesLoaded: 1, failed: true }), { kind: 'row', key: 'a' }, 'a failed page lands on the oldest loaded row, no retry')
  t.alike(openPlan({ targetKey: 'b', rowKeys, hasOlder: true, olderPagesLoaded: 1, loading: true }), { kind: 'row', key: 'b' }, 'a loaded target needs no page')
})

test('latchOpen keeps the first value per scope', async (t) => {
  const { latchOpen } = await import('../src/readPosition.js')
  const first = latchOpen(null, { scope: 'a', value: 'x' })
  t.alike(first, { scope: 'a', value: 'x' })
  t.is(latchOpen(first, { scope: 'a', value: 'y' }), first, 'same scope keeps prev')
  t.alike(latchOpen(first, { scope: 'b', value: 'y' }), { scope: 'b', value: 'y' })
  t.alike(latchOpen(first, { scope: 'b', value: undefined }), { scope: 'b', value: null })
  t.alike(latchOpen(undefined, { scope: 'c', value: 'z' }), { scope: 'c', value: 'z' })
})

test('readCursor only moves forward', async (t) => {
  const { readCursor } = await import('../src/readPosition.js')
  const rowKeys = ['a', 'b', 'c', 'd']
  t.is(readCursor(null, { rowKeys, viewableKeys: ['b', 'c', 'zz'] }), 'c', 'highest viewable row')
  t.is(readCursor('d', { rowKeys, viewableKeys: ['b'] }), 'd', 'never back')
  t.is(readCursor('c', { rowKeys, viewableKeys: ['c'] }), 'c', 'equal keeps prev')
  t.is(readCursor('a', { rowKeys, viewableKeys: ['c'] }), 'c', 'forward')
  t.is(readCursor('gone', { rowKeys, viewableKeys: ['b'] }), 'b', 'prev no longer a row')
  t.is(readCursor('gone', { rowKeys, viewableKeys: [] }), 'gone', 'nothing viewable keeps prev')
  t.is(readCursor(null, { rowKeys, viewableKeys: ['zz'] }), null)
})

test('settleStep counts up to the cap', async (t) => {
  const { settleStep, SETTLE_TRIES, GROWTH_PLACES } = await import('../src/readPosition.js')
  t.is(SETTLE_TRIES, 6)
  t.ok(GROWTH_PLACES > SETTLE_TRIES, 'content-size frames get more passes than timed tries')
  t.alike(settleStep(0), { again: true, next: 1, wait: 50 })
  t.alike(settleStep(5), { again: true, next: 6, wait: 1000 })
  t.alike(settleStep(6), { again: false, next: 7, wait: 1000 })
  t.alike(settleStep(2, 2), { again: false, next: 3, wait: 200 })
})

test('settleStep waits long enough for a slow first layout', async (t) => {
  const { settleStep, SETTLE_TRIES } = await import('../src/readPosition.js')
  // The retries together must outlast the web list's first measure (more
  // than 300 ms seen in Chrome), or every try fails with nothing measured.
  let total = 0
  for (let n = 0; n < SETTLE_TRIES; n++) total += settleStep(n).wait
  t.ok(total >= 2000, 'retries span ' + total + ' ms')
  t.ok(total <= 4000, 'the landing still gives up within seconds')
})
