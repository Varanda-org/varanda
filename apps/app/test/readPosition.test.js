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

test('atEnd counts the last few pixels as the end and an unmeasured frame as not', async (t) => {
  const { atEnd, END_SLOP } = await import('../src/readPosition.js')
  t.ok(atEnd({ y: 600, contentHeight: 1000, layoutHeight: 400 }))
  t.ok(atEnd({ y: 600 - END_SLOP, contentHeight: 1000, layoutHeight: 400 }), 'within the slop')
  t.absent(atEnd({ y: 600 - END_SLOP - 1, contentHeight: 1000, layoutHeight: 400 }))
  t.ok(atEnd({ y: 0, contentHeight: 300, layoutHeight: 400 }), 'a short list is always at the end')
  t.absent(atEnd({}), 'unmeasured')
  t.absent(atEnd({ y: NaN, contentHeight: 1000, layoutHeight: 400 }))
})

test('awayAfterFrame: only the person leaves the end, and a landing in progress stays away', async (t) => {
  const { awayAfterFrame } = await import('../src/readPosition.js')
  t.is(awayAfterFrame({ away: true, pinned: true, bottom: true }), false, 'reaching the end')
  t.is(awayAfterFrame({ away: false, pinned: true, bottom: false }), false, 'an automatic frame above the end while pinned')
  t.is(awayAfterFrame({ away: false, pinned: false, bottom: false }), true, 'the person scrolled up')
  t.is(awayAfterFrame({ away: true, pinned: true, bottom: false }), true, 'stays away until the end')
  t.is(awayAfterFrame({ away: false, pinned: false, bottom: false, resized: true }), false, 'a resize does not leave the end')
  t.is(awayAfterFrame({ away: true, pinned: true, bottom: true, resized: true }), false, 'a resize that shows the end reaches it')
  // The regression: an estimate scroll during the landing clamps at the end
  // of a partly measured list. That frame cleared away, and the next row
  // pulled the view down past the unread run.
  t.is(awayAfterFrame({ away: true, pinned: true, bottom: true, heading: true }), true, 'a landing clamped at the end stays away')
  t.is(awayAfterFrame({ away: true, pinned: false, bottom: true, resized: true, heading: true }), true)
})

test('landingAway reads the sizes, and a list not laid out yet is away', async (t) => {
  const { landingAway } = await import('../src/readPosition.js')
  // The regression: the web landed on the first message of a never-read chat
  // before the list measured itself. Its zero sizes read as the end, and the
  // jump button never showed.
  t.is(landingAway({ y: 0, contentHeight: 0, layoutHeight: 0 }), true, 'nothing measured yet')
  t.is(landingAway({ y: 0, contentHeight: 2680, layoutHeight: 0 }), true, 'no list height yet')
  t.is(landingAway({ y: 0, contentHeight: 0, layoutHeight: 600 }), true, 'no content height yet')
  t.is(landingAway({}), true)
  t.is(landingAway({ y: 0, contentHeight: 2680, layoutHeight: 600 }), true, 'landed at the top of a long chat')
  t.is(landingAway({ y: 0, contentHeight: 300, layoutHeight: 600 }), false, 'the whole chat fits on screen')
  t.is(landingAway({ y: 2080, contentHeight: 2680, layoutHeight: 600 }), false, 'landed clamped at the end')
})

test('unreadBelow counts the other side\'s rows after the cursor, or from the open target before it', async (t) => {
  const { unreadBelow } = await import('../src/readPosition.js')
  const rows = [{ key: 'r1' }, { key: 'm1', mine: true }, { key: 'u1' }, { key: 'u2' }, { key: 'm2', mine: true }, { key: 'u3' }]
  t.is(unreadBelow({ rows, cursorKey: null, openKey: 'u1' }), 3, 'the whole unread run from the target, without own rows')
  t.is(unreadBelow({ rows, cursorKey: 'u1', openKey: 'u1' }), 2, 'the cursor row itself was read')
  t.is(unreadBelow({ rows, cursorKey: 'u3', openKey: 'u1' }), 0, 'read to the end')
  t.is(unreadBelow({ rows, cursorKey: null, openKey: 'older' }), 4, 'a target on a page not loaded yet: every loaded row of the other side')
  t.is(unreadBelow({ rows, cursorKey: 'gone', openKey: 'u1' }), 0, 'a cursor no longer listed counts nothing')
  t.is(unreadBelow({ rows, cursorKey: null, openKey: null }), 0, 'an end open has nothing unread below')
  t.is(unreadBelow({ rows: null, cursorKey: null, openKey: 'u1' }), 0)
})

test('jumpState shows the button whenever away, with the count capped at 99+', async (t) => {
  const { jumpState } = await import('../src/readPosition.js')
  t.alike(jumpState({ away: false, unread: 5 }), { show: false, count: 0, text: '', hint: undefined }, 'at the end: hidden, whatever the count')
  t.alike(jumpState({ away: true, unread: 0 }), { show: true, count: 0, text: '', hint: undefined }, 'away with nothing unread: the button alone')
  t.alike(jumpState({ away: true, unread: 1 }), { show: true, count: 1, text: '1', hint: '1 mensagem nova' })
  t.alike(jumpState({ away: true, unread: 25 }), { show: true, count: 25, text: '25', hint: '25 mensagens novas' })
  t.alike(jumpState({ away: true, unread: 99 }), { show: true, count: 99, text: '99', hint: '99 mensagens novas' })
  t.alike(jumpState({ away: true, unread: 140 }), { show: true, count: 140, text: '99+', hint: 'mais de 99 mensagens novas' })
  t.is(jumpState({ away: true, unread: -2 }).text, '')
  t.is(jumpState({ away: true, unread: NaN }).text, '')
  for (const value of Object.values(jumpState({ away: true, unread: 140 }))) {
    if (typeof value === 'string') t.absent(value.includes('\u2014'), 'no em dash')
  }
})
