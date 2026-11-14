'use strict'

const test = require('brittle')

const load = () => import('../src/profileBar.js')

test('profile bar leaves the top and pull-to-refresh unchanged', async (t) => {
  const { profileBarState } = await load()
  for (const inset of [0, 24, 47, 59]) {
    for (const reduce of [false, true]) {
      for (const y of [-80, 0]) {
        t.alike(profileBarState(y, inset + 96, reduce, inset + 42), { opacity: 0, interactive: false })
        t.alike(profileBarState(y, inset + 96, reduce, inset + 84), { opacity: 0, interactive: false })
      }
    }
  }
})

test('member back is opaque and interactive before the header back leaves', async (t) => {
  const { profileBarState } = await load()
  for (const inset of [0, 24, 47, 59]) {
    for (const reduce of [false, true]) {
      for (const y of [inset + 38, inset + 42, inset + 52]) {
        t.alike(profileBarState(y, inset + 96, reduce, inset + 42), { opacity: 1, interactive: true })
      }
      t.is(profileBarState(inset + 37, inset + 96, reduce, inset + 42).interactive, false)
    }
  }
})

test('diary controls use their own position near the band bottom', async (t) => {
  const { profileBarState } = await load()
  t.alike(profileBarState(80, 96, false, 84), { opacity: 1, interactive: true })
  t.is(profileBarState(79, 96, false, 84).interactive, false)
  t.is(profileBarState(42, 96, false, 84).interactive, false)
  for (const inset of [0, 24, 47, 59]) {
    for (const reduce of [false, true]) {
      t.alike(profileBarState(inset + 84, inset + 96, reduce, inset + 84), { opacity: 1, interactive: true })
    }
  }
})

test('fade is linear and reduced motion snaps at the same handoff', async (t) => {
  const { profileBarState } = await load()
  t.alike(profileBarState(19, 96, false, 42), { opacity: 0.5, interactive: false })
  t.alike(profileBarState(19, 96, true, 42), { opacity: 0, interactive: false })
  t.alike(profileBarState(37.99, 96, true, 42), { opacity: 0, interactive: false })
  t.alike(profileBarState(38, 96, true, 42), { opacity: 1, interactive: true })
  for (const y of [200, 38, 37, 19, 0, -10]) {
    const state = profileBarState(y, 96, false, 42)
    t.is(state.interactive, state.opacity === 1, 'scrolling back also hands controls back to the header')
    t.ok(state.opacity >= 0 && state.opacity <= 1)
  }
})

test('invalid metrics keep the bar hidden', async (t) => {
  const { profileBarState } = await load()
  for (const bad of [NaN, Infinity, undefined, '42']) {
    t.alike(profileBarState(bad, 96, false, 42), { opacity: 0, interactive: false })
    t.alike(profileBarState(100, bad, false, 42), { opacity: 0, interactive: false })
  }
  for (const bad of [NaN, Infinity, 0, -1, '42']) {
    t.alike(profileBarState(100, 96, false, bad), { opacity: 0, interactive: false })
  }
})

test('tabs pin once their top reaches the bar bottom', async (t) => {
  const { tabsPinned } = await load()
  for (const inset of [0, 24, 47, 59]) {
    const bar = inset + 44
    const top = inset + 420
    t.is(tabsPinned(top - bar - 1, top, bar), false, 'just below the bar')
    t.is(tabsPinned(top - bar, top, bar), true, 'touching the bar')
    t.is(tabsPinned(top + 300, top, bar), true, 'scrolled past')
    t.is(tabsPinned(0, top, bar), false, 'at the top')
    t.is(tabsPinned(-80, top, bar), false, 'pull to refresh')
  }
})

test('unmeasured or invalid tabs never pin', async (t) => {
  const { tabsPinned } = await load()
  for (const bad of [null, undefined, NaN, Infinity, 0, -1, '420']) {
    t.is(tabsPinned(1000, bad, 44), false, 'tabsTop ' + String(bad))
    t.is(tabsPinned(1000, 420, bad), false, 'barHeight ' + String(bad))
  }
  for (const bad of [null, undefined, NaN, Infinity, '1000']) {
    t.is(tabsPinned(bad, 420, 44), false, 'y ' + String(bad))
  }
})

test('profile bar mounts the tabs copy only while pinned and grows around it', (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/ProfileBar.js'), 'utf8')
  t.ok(src.includes('const pinned = on && bar.pinned === true && !!tabs'), 'pinned needs an interactive bar')
  t.ok(src.includes('{pinned ? <View style={styles.tabs}>{tabs}</View> : null}'), 'the slot is not mounted otherwise')
  t.ok(src.includes('const pin = on && tabsPinned(y, tabsTop, topInset + BAR)'))
  t.ok(src.includes('style={[styles.wrap, { opacity: bar.opacity }]}'), 'the wrap takes its height from the band and the slot')
  t.absent(/wrap: \{[^\n]*height/.test(src), 'no fixed wrap height')
  t.ok(src.includes('backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth'))
  for (const file of ['Diario.js', 'Membro.js']) {
    const screen = fs.readFileSync(path.join(__dirname, '../src/screens', file), 'utf8')
    t.ok(screen.includes('tabs={<Segmented options={tabs} selected={shownTab} onSelect={selectPinnedTab} />}'), file + ': the bar gets the same tabs')
    t.ok(screen.includes('<Segmented options={tabs} selected={shownTab} onSelect={setTab} />'), file + ': the header tabs keep setTab')
    t.ok(screen.includes('const selectPinnedTab = usePinnedTabSelect(bar, listRef, shownTab, setTab)'), file + ': pinned picks go through the boundary scroll')
    t.ok(screen.includes('listRef={listRef}'), file + ': the list ref reaches RefreshableList')
    t.ok(screen.includes('onTabsLayout={(l) => setTabsBottom(l.y + l.height)}'), file + ': header reports the tabs slot')
    t.ok(screen.includes('tabsTop, topInset: insets.top })'), file + ': the hook gets tabsTop')
  }
})

test('a tab picked while pinned reopens the list at the pin boundary', async (t) => {
  const { pinnedTabOffset, tabsPinned } = await load()
  for (const inset of [0, 24, 47, 59]) {
    const bar = inset + 44
    const top = inset + 420
    for (const y of [top - bar, top, top + 3000]) {
      const offset = pinnedTabOffset(y, top, bar)
      t.is(offset, top - bar, 'scrolled ' + y + ': back to the boundary')
      t.ok(tabsPinned(offset, top, bar), 'the tabs stay pinned there')
      t.absent(tabsPinned(offset - 1, top, bar), 'and it is the first pinned offset')
    }
    for (const y of [top - bar - 1, 0, -80]) t.is(pinnedTabOffset(y, top, bar), null, 'not pinned at ' + y + ': no scroll')
  }
  t.is(pinnedTabOffset(100, 30, 44), 0, 'never a negative offset')
  for (const bad of [null, undefined, NaN, Infinity, 0, -1, '420']) {
    t.is(pinnedTabOffset(1000, bad, 44), null, 'tabsTop ' + String(bad))
    t.is(pinnedTabOffset(1000, 420, bad), null, 'barHeight ' + String(bad))
    t.is(pinnedTabOffset(bad, 420, 44), null, 'y ' + String(bad))
  }
})

test('the pinned copy scrolls through the FlatList ref, without animation, after the tab renders', (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/ProfileBar.js'), 'utf8')
  t.ok(src.includes('const pinnedOffset = useCallback(() => pinnedTabOffset(lastY.current, tabsTop, topInset + BAR), [tabsTop, topInset])'))
  t.ok(src.includes('listRef.current?.scrollToOffset?.({ offset: p.offset, animated: false })'))
  t.ok(src.includes('if (p === null || p.id !== selected) return'), 'scrolls only once the picked tab is shown')
  t.ok(src.includes('pending.current = offset === null ? null : { id, offset }'), 'no scroll when not pinned')
  const list = fs.readFileSync(path.join(__dirname, '../src/ui/RefreshableList.js'), 'utf8')
  t.ok(list.includes('else if (listRef) listRef.current = node'), 'RefreshableList hands the FlatList to listRef')
  t.ok(list.includes('list.current.scrollToOffset({'), 'the FlatList node exposes scrollToOffset')
})

test('the list can always scroll to the pin boundary, even on a short tab', async (t) => {
  const { pinnedContentStyle, pinnedTabOffset, tabsPinned } = await load()
  for (const inset of [0, 24, 47, 59]) {
    const bar = inset + 44
    const viewport = 800
    const base = { paddingBottom: 90, minHeight: viewport + inset + 96 + 8 }
    for (const top of [inset + 180, inset + 420, inset + 900.4]) {
      const style = pinnedContentStyle(base, viewport, top, bar)
      t.ok(style.minHeight >= base.minHeight, 'never below the base')
      t.is(style.paddingBottom, 90, 'other keys kept')
      const offset = pinnedTabOffset(top + 2000, top, bar)
      // Largest offset the list allows when the content is only its minimum.
      const maxOffset = style.minHeight - viewport
      t.ok(maxOffset >= offset, 'room to reach the boundary at tabsTop ' + top)
      t.ok(tabsPinned(Math.min(offset, maxOffset), top, bar), 'a clamped scroll still pins')
    }
  }
  const base = { minHeight: 904 }
  for (const bad of [null, undefined, NaN, Infinity, 0, -1, '420']) {
    t.is(pinnedContentStyle(base, 800, bad, 44), base, 'tabsTop ' + String(bad) + ': unchanged')
    t.is(pinnedContentStyle(base, 800, 420, bad), base, 'barHeight ' + String(bad) + ': unchanged')
    t.is(pinnedContentStyle(base, bad, 420, 44), base, 'viewport ' + String(bad) + ': unchanged')
  }
  t.is(pinnedContentStyle({ minHeight: 5000 }, 800, 420, 44).minHeight, 5000, 'a larger base stays')
})

test('both profile lists size their content through pinnedContentStyle', (t) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const read = (file) => fs.readFileSync(path.join(__dirname, '../src/screens', file), 'utf8')
  t.ok(read('Diario.js').includes('contentContainerStyle={pinnedContentStyle({ paddingBottom: bottomPad, minHeight: windowHeight + bandHeight + 8 }, windowHeight, tabsTop, insets.top + BAR)}'))
  t.ok(read('Membro.js').includes('contentContainerStyle={pinnedContentStyle({ paddingBottom: bottomPad, minHeight: windowHeight + insets.top + BAND + 8 }, windowHeight, tabsTop, insets.top + BAR)}'))
})
