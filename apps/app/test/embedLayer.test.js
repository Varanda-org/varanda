'use strict'

// The player layer of a list (src/ui/EmbedLayer.js) and the card's hand-off
// to it (src/ui/MusicEmbedCard.js). Both files pull in react-native, so the
// card's unmount cleanup, its mount effect and the host's orphanTick are
// lifted from their source and run against the real embedLive slots and the
// real embedKeep registry.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '../src')
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const cardRaw = read('ui', 'MusicEmbedCard.js')
const card = withoutComments(cardRaw)
const layerRaw = read('ui', 'EmbedLayer.js')
const layer = withoutComments(layerRaw)
const list = read('ui', 'RefreshableList.js')

function sliceBetween (src, start, end) {
  const a = src.indexOf(start)
  if (a === -1) throw new Error('not found: ' + start)
  const b = src.indexOf(end, a)
  if (b === -1) throw new Error('not found: ' + end)
  return src.slice(a, b)
}

// The card's unmount cleanup, as written.
function liftCleanup () {
  const body = sliceBetween(cardRaw, '    return () => {\n      alive.current = false', '\n  }, [])')
  const names = ['alive', 'stateRef', 'EMBED_WAITING', 'EMBED_IDLE', 'embedSlots', 'hosted', 'release', 'host', 'playbackClaimCount', 'claims', 'touchedNow']
  return new Function(...names, body) // eslint-disable-line no-new-func
}

// The card's mount effect, without its cleanup, and its first state.
function liftMount () {
  const body = sliceBetween(cardRaw, '    const kept = key ? host.keep.claim(key) : null', '    // A new key while mounted')
  const names = ['key', 'host', 'release', 'hosted', 'stateRef', 'setState', 'apply', 'EMBED_PARKED', 'EMBED_IDLE', 'playbackClaimCount', 'claims', 'touchedNow', 'setReady', 'keptReady', 'embedSlots', 'touchSeen']
  return new Function(...names, body) // eslint-disable-line no-new-func
}

// The card's touchedNow(), keptReady() and slotParts(), as written.
function liftCardHelper (name, params, extra = []) {
  const m = cardRaw.match(new RegExp('function ' + name + ' \\(' + params.join(', ') + '\\) \\{([\\s\\S]*?)\\n\\}'))
  if (!m) throw new Error(name + ' not found')
  return new Function(...extra, ...params, m[1]) // eslint-disable-line no-new-func
}

// The card's keep subscription callback, as written.
function liftKeepListener () {
  const start = '    const offKeep = host.keep.subscribe(() => {\n'
  const body = sliceBetween(cardRaw, start, '\n    })\n    const offContent').slice(start.length)
  return new Function('hosted', 'host', 'release', 'apply', 'EMBED_IDLE', 'keptReady', 'setReady', body) // eslint-disable-line no-new-func
}

// The card's real apply(), as musicEmbedCard.test.js lifts it.
function liftApply () {
  const start = cardRaw.indexOf('  const apply = (')
  const end = cardRaw.indexOf('  useEffect(() => {\n    alive.current = true')
  if (start === -1 || end === -1) throw new Error('apply() not found')
  const names = ['embedSlots', 'release', 'stateRef', 'base', 'win', 'alive', 'setState', 'EMBED_PARKED', 'EMBED_IDLE', 'EMBED_WAITING', 'hosted', 'host', 'Date', 'readerTouchNow', 'request']
  return new Function(...names, cardRaw.slice(start, end) + '\nreturn apply') // eslint-disable-line no-new-func
}

function liftInitial () {
  const m = cardRaw.match(/const \[state, setState\] = useState\(\(\) => \((.*?)\)\)\n/)
  if (!m) throw new Error('initial state not found')
  return new Function('key', 'host', 'EMBED_PARKED', 'EMBED_IDLE', 'return ' + m[1]) // eslint-disable-line no-new-func
}

function liftOrphanRowTick () {
  const grace = layerRaw.match(/export const EMBED_ROW_GRACE_TICKS = (\d+)\n/)
  const m = layerRaw.match(/export function orphanRowTick \(entries, mounted, counts\) \{([\s\S]*?)\n\}/)
  if (!grace || !m) throw new Error('orphanRowTick not found')
  const fn = new Function('EMBED_ROW_GRACE_TICKS', 'entries', 'mounted', 'counts', m[1]) // eslint-disable-line no-new-func
  return { grace: Number(grace[1]), tick: (entries, mounted, counts) => fn(Number(grace[1]), entries, mounted, counts) }
}

// The host's count of mounted rows.
function liftRowMounted () {
  const start = '    rowMounted: (row) => {\n'
  const body = sliceBetween(layerRaw, start, '\n    },\n    claimsSeen').slice(start.length)
  return new Function('rows', 'row', body) // eslint-disable-line no-new-func
}

// rowKeyOf and keptRowKeys, as written.
function liftKeptRowKeys () {
  const rk = layerRaw.match(/export function rowKeyOf \(keyExtractor, item, index\) \{([\s\S]*?)\n\}/)
  const m = layerRaw.match(/export function keptRowKeys \(data, keyExtractor\) \{([\s\S]*?)\n\}/)
  if (!rk || !m) throw new Error('keptRowKeys not found')
  const rowKeyOf = new Function('keyExtractor', 'item', 'index', rk[1]) // eslint-disable-line no-new-func
  const fn = new Function('rowKeyOf', 'data', 'keyExtractor', m[1]) // eslint-disable-line no-new-func
  return { rowKeyOf, keptRowKeys: (data, keyExtractor) => fn(rowKeyOf, data, keyExtractor) }
}

function liftOrphanTick () {
  const m = layerRaw.match(/export function orphanTick \(entries, claimsChanged, yielding, engaged\) \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('orphanTick not found')
  return new Function('entries', 'claimsChanged', 'yielding', 'engaged', m[1]) // eslint-disable-line no-new-func
}

// The host's tick, as written, against the given slots, keep and stub
// screen reader, with the real orphanTick, orphanRowTick and touchedNow.
async function liftHostTick (slots, keep, reader, playback) {
  const live = await import('../src/embedLive.js')
  const t = layerRaw.match(/export function touchedNow \(release\) \{([\s\S]*?)\n\}/)
  const r = layerRaw.match(/function readerTouchNow \(\) \{([\s\S]*?)\n\}/)
  if (!t || !r) throw new Error('touchedNow or readerTouchNow not found')
  const touchedFn = new Function('embedTouched', 'embedSlots', 'screenReaderOn', 'screenReaderKnown', 'release', t[1]) // eslint-disable-line no-new-func
  const readerFn = new Function('embedTouched', 'screenReaderOn', 'screenReaderKnown', r[1]) // eslint-disable-line no-new-func
  const start = '  const tick = () => {\n'
  const body = sliceBetween(layerRaw, start, '\n  }\n  const sync = () => {').slice(start.length)
  const names = ['playbackClaimCount', 'seen', 'orphanTick', 'keep', 'embedSlots', 'readerTouchNow', 'touchedNow', 'orphanRowTick', 'rows', 'grace']
  const fn = new Function(...names, body) // eslint-disable-line no-new-func
  const orphanTick = liftOrphanTick()
  const rowTick = liftOrphanRowTick().tick
  return () => fn(
    () => playback.count,
    playback.count,
    orphanTick,
    keep,
    slots,
    () => readerFn(live.embedTouched, () => reader.on, () => reader.known),
    (release) => touchedFn(live.embedTouched, slots, () => reader.on, () => reader.known, release),
    rowTick,
    new Map(),
    new Map()
  )
}

// touchedNow, heldDrops and the Layer's sync, as written, against the real
// embedLive holds; the screen reader and the slots are passed in.
async function liftHeld (reader = { on: false, known: true }) {
  const live = await import('../src/embedLive.js')
  const slots = live.createEmbedSlots(4)
  const t = layerRaw.match(/export function touchedNow \(release\) \{([\s\S]*?)\n\}/)
  const h = layerRaw.match(/export function heldDrops \(entries, shown, locked, touched\) \{([\s\S]*?)\n\}/)
  if (!t || !h) throw new Error('touchedNow or heldDrops not found')
  const touchedFn = new Function('embedTouched', 'embedSlots', 'screenReaderOn', 'screenReaderKnown', 'release', t[1]) // eslint-disable-line no-new-func
  const touchedNow = (release) => touchedFn(live.embedTouched, slots, () => reader.on, () => reader.known, release)
  const heldFn = new Function('embedStays', 'entries', 'shown', 'locked', 'touched', h[1]) // eslint-disable-line no-new-func
  const heldDrops = (entries, shown, locked, touched) => heldFn(live.embedStays, entries, shown, locked, touched)
  const leaf = layerRaw.slice(layerRaw.indexOf('function Layer ({ host })'))
  const start = '    const sync = () => {\n'
  const body = sliceBetween(leaf, start, '\n    }\n    sync()').slice(start.length)
  const syncFn = new Function('host', 'visible', 'depth', 'embedsHeldAll', 'embedsHeld', 'heldDrops', 'touchedNow', body) // eslint-disable-line no-new-func
  const sync = (host, visible, depth) => syncFn(host, visible, depth, live.embedsHeldAll, live.embedsHeld, heldDrops, touchedNow)
  return { live, slots, touchedNow, heldDrops, sync }
}

// Two kept frames on their own slots: a touched one and an untouched one.
async function twoKept (slots) {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const keep = createEmbedKeep()
  const spec = Object.freeze({ embedUrl: 'https://open.spotify.com/embed/track/x', height: 152, width: 300 })
  const touched = slots.acquire()
  const untouched = slots.acquire()
  keep.show('touched', spec, touched, 'row-1')
  keep.show('untouched', spec, untouched, 'row-2')
  slots.engage(touched, true)
  return { keep, host: { keep }, touched, untouched }
}

async function setup () {
  const live = await import('../src/embedLive.js')
  const { createEmbedKeep, embedKey } = await import('../src/embedKeep.js')
  const slots = live.createEmbedSlots(2)
  let acquired = 0
  const spied = { ...slots, acquire: () => { acquired++; return slots.acquire() } }
  const keep = createEmbedKeep()
  const playback = { count: 0, seen: null }
  const playbackClaimCount = () => playback.count
  const host = { keep, claimsSeen: () => (playback.seen === null ? playback.count : playback.seen) }
  const makeApply = liftApply()
  const reader = { on: false, known: true }
  const touchedFn = liftCardHelper('touchedNow', ['release'], ['embedTouched', 'embedSlots', 'screenReaderOn', 'screenReaderKnown'])
  const touchedNow = (release) => touchedFn(live.embedTouched, spied, () => reader.on, () => reader.known, release)
  const readerFn = liftCardHelper('readerTouchNow', [], ['embedTouched', 'screenReaderOn', 'screenReaderKnown'])
  const readerTouchNow = () => readerFn(live.embedTouched, () => reader.on, () => reader.known)
  const keptReadyFn = liftCardHelper('keptReady', ['host', 'key'])
  const key = embedKey('row-1', undefined, 'https://open.spotify.com/embed/track/x')
  const spec = Object.freeze({ embedUrl: 'https://open.spotify.com/embed/track/x', height: 152, width: 300 })
  // A card live through the host: one slot, one kept entry under key.
  const goLive = () => {
    const release = spied.acquire()
    keep.show(key, spec, release, 'row-1')
    keep.place(key, { x: 0, y: 10, w: 300, h: 152 })
    return {
      alive: { current: true },
      stateRef: { current: live.EMBED_LIVE },
      hosted: { current: key },
      release: { current: release },
      claims: { current: playback.count }
    }
  }
  const unmount = (c) => liftCleanup()(c.alive, c.stateRef, live.EMBED_WAITING, live.EMBED_IDLE, spied, c.hosted, c.release, host, playbackClaimCount, c.claims, touchedNow)()
  // real: the card's own apply() instead of a recorder.
  const mount = (real = false) => {
    const first = liftInitial()(key, host, live.EMBED_PARKED, live.EMBED_IDLE)
    const c = {
      stateRef: { current: first },
      release: { current: null },
      hosted: { current: '' },
      claims: { current: playback.count },
      touchSeen: { current: false },
      alive: { current: true },
      applied: [],
      shown: [],
      // The first commit's ready, then each setReady.
      ready: [keptReadyFn(host, key)]
    }
    const setState = (s) => c.shown.push(s)
    const apply = real
      ? makeApply(spied, c.release, c.stateRef, { current: false }, { width: 390, height: 844 }, c.alive, setState, live.EMBED_PARKED, live.EMBED_IDLE, live.EMBED_WAITING, c.hosted, host, Date, readerTouchNow, { current: '' })
      : null
    const record = (s) => { c.applied.push(s); if (apply) apply(s) }
    liftMount()(key, host, c.release, c.hosted, c.stateRef, setState, record, live.EMBED_PARKED, live.EMBED_IDLE, playbackClaimCount, c.claims, touchedNow, (r) => c.ready.push(r), keptReadyFn, spied, c.touchSeen)
    return c
  }
  return { live, slots: spied, keep, key, spec, goLive, unmount, mount, makeApply, host, playback, reader, touchedNow, readerTouchNow, keptReady: keptReadyFn, acquired: () => acquired }
}

test('an unmounted row keeps its loaded frame and its slot', async (t) => {
  const { live, slots, keep, key, goLive, unmount, mount, acquired } = await setup()
  const c = goLive()
  const release = c.release.current
  t.is(slots.count(), 1)
  unmount(c)
  t.is(slots.count(), 1, 'the slot stays taken by the kept frame')
  t.ok(keep.has(key), 'the frame stays in the layer')
  t.ok(keep.hasOrphan(), 'as an orphan')
  t.is(keep.list()[0].rect, null, 'hidden while its row is gone')
  t.is(c.release.current, null)
  t.is(c.hosted.current, '')
  const before = acquired()
  const back = mount()
  t.is(back.shown.length, 0, 'the card starts parked, with no state change')
  t.is(back.stateRef.current, live.EMBED_PARKED, 'the returning card starts parked')
  t.is(back.release.current, release, 'with the same release, so the same frame')
  t.is(back.hosted.current, key)
  t.is(back.applied.length, 0, 'nothing closes it')
  t.is(acquired(), before, 'no new slot is taken')
  t.absent(keep.hasOrphan(), 'the card owns the frame again')
  t.is(slots.count(), 1)
})

test('claim hands back the same release', async (t) => {
  const { keep, key, goLive, unmount } = await setup()
  const c = goLive()
  const release = c.release.current
  unmount(c)
  const kept = keep.claim(key)
  t.ok(kept)
  t.is(kept.release, release)
})

test('a list already gone releases the slot on unmount', async (t) => {
  const { keep, slots, goLive, unmount } = await setup()
  const c = goLive()
  keep.dispose()
  t.is(slots.count(), 0, 'disposing the keep released the kept frame')
  const d = goLive()
  t.is(slots.count(), 1)
  unmount(d)
  t.is(slots.count(), 0, 'a refused orphan releases its slot')
  t.absent(keep.hasOrphan())
  unmount(c)
  t.is(slots.count(), 0)
})

test('a card that never went through the host releases on unmount', async (t) => {
  const { live, slots, keep, unmount } = await setup()
  const release = slots.acquire()
  unmount({ alive: { current: true }, stateRef: { current: live.EMBED_LIVE }, hosted: { current: '' }, release: { current: release } })
  t.is(slots.count(), 0)
  t.is(keep.list().length, 0)
})

test('a returning card with no kept frame closes its parked state', async (t) => {
  const { live, mount } = await setup()
  const c = mount()
  t.is(c.stateRef.current, live.EMBED_IDLE, 'nothing kept: it starts idle')
  t.is(c.applied.length, 0)
  t.is(c.release.current, null)
})

test('a newcomer takes the slot of an orphan through orphanTick', async (t) => {
  const { slots, keep, key, goLive, unmount } = await setup()
  const orphanTick = liftOrphanTick()
  const c = goLive()
  const other = slots.acquire()
  t.is(typeof other, 'function')
  unmount(c)
  t.is(slots.count(), 2)
  t.alike(orphanTick(keep.list(), false, slots.yielding), [], 'nobody asked yet')
  t.is(slots.acquire(), null, 'a third card finds both slots taken')
  t.ok(slots.yielding(keep.list()[0].release), 'the orphan is asked to yield')
  const drop = orphanTick(keep.list(), false, slots.yielding)
  t.alike(drop, [key], 'the tick drops the asked orphan')
  for (const k of drop) keep.drop(k)
  t.absent(keep.has(key))
  t.is(slots.count(), 1, 'its slot is free')
  t.is(typeof slots.acquire(), 'function', 'the newcomer gets it')
  other()
})

test('an orphan asked by a preload stays while a screen reader runs or is unknown', async (t) => {
  const live = await import('../src/embedLive.js')
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const slots = live.createEmbedSlots(1)
  const keep = createEmbedKeep()
  const reader = { on: false, known: true }
  const playback = { count: 0 }
  const tick = await liftHostTick(slots, keep, reader, playback)
  const spec = Object.freeze({ embedUrl: 'https://open.spotify.com/embed/track/x', height: 152, width: 300 })
  const release = slots.acquire()
  keep.show('o', spec, release, 'row-1')
  slots.park(release, true)
  keep.orphan('o')
  t.is(slots.acquire(300), null, 'a preload finds the slot taken')
  t.ok(slots.yielding(release), 'and marks the orphan, counted as farthest')
  reader.on = true
  tick()
  t.ok(keep.has('o'), 'a running screen reader keeps the orphan')
  reader.on = false
  reader.known = false
  tick()
  t.ok(keep.has('o'), 'so does a screen reader that has not answered')
  reader.known = true
  tick()
  t.absent(keep.has('o'), 'with the reader known off, the orphan yields')
  t.is(slots.count(), 0, 'and its slot is free')
})

test('orphanTick drops every orphan after another player started', async (t) => {
  const orphanTick = liftOrphanTick()
  const entries = [
    { key: 'a', orphan: true, release: () => {} },
    { key: 'b', orphan: false, release: () => {} },
    { key: 'c', orphan: true, release: () => {} }
  ]
  t.alike(orphanTick(entries, true, () => false), ['a', 'c'], 'a mounted card checks for itself')
  t.alike(orphanTick(entries, false, () => false), [])
  t.alike(orphanTick(entries, false, () => { throw new Error('x') }), [], 'a throwing check keeps the frame')
  t.alike(orphanTick(null, true, () => true), [])
  t.alike(orphanTick([null, undefined, 1], true, () => true), [])
})

test('the list renders through EmbedScroll', (t) => {
  const flat = list.slice(list.indexOf('<FlatList'), list.indexOf('\n        />', list.indexOf('<FlatList')))
  t.ok(flat.includes('renderScrollComponent={renderScroll}'), 'FlatList gets renderScroll')
  t.ok(flat.indexOf('renderScrollComponent={renderScroll}') > flat.indexOf('viewabilityConfig='), 'after viewabilityConfig')
  t.ok(flat.includes('renderItem={renderRow}'), 'rows carry their key')
  t.ok(list.includes("import { EmbedRow, keptRowKeys, orphanCuts, renderScroll, rowKeyOf, rowOrder, touchedNow, useEmbedHost } from './EmbedLayer'"))
  t.ok(list.includes('const host = useEmbedHost()'))
  t.ok(list.includes('<EmbedHost.Provider value={host}>'))
  t.ok(list.includes('<EmbedRow row={rowKeyOf(keyOf.current, info.item, info.index)}>{renderItem(info)}</EmbedRow>'), 'each row registers with the host')
  t.ok(list.includes('const next = orphanCuts(host.keep.list(), c.kept, c.order, c.deadlines, Date.now(), touchedNow)'), 'rows that left the data, or became a tombstone, drop their kept frame, unless only cut off past the end')
  t.ok(/const orphans = host\.keep\.list\(\)\.filter\(\(entry\) => entry\.orphan === true\)\.map\(\(entry\) => entry\.row\)\s*c\.order = rowOrder\(data, keyOf\.current, c\.order, orphans\)\s*c\.kept = keptRowKeys\(data, keyOf\.current\)\s*pruneOrphans\(\)\s*\}, \[data\]\)/.test(list), 'every data change prunes')
  const handler = list.slice(list.indexOf('const handleContentSizeChange = useCallback'), list.indexOf('}, [check])', list.indexOf('const handleContentSizeChange = useCallback')))
  t.ok(handler.indexOf('host.contentChanged()') > handler.indexOf('check()'), 'moved rows re-place their frames')
  t.absent(list.includes('removeClippedSubviews'), 'no clipped subviews')
})

test('EmbedScroll forwards its ref and draws the layer after the rows', (t) => {
  t.ok(layer.includes('export const EmbedScroll = forwardRef(function EmbedScroll (props, ref) {'))
  t.ok(/if \(typeof ref === 'function'\) ref\(node\)\s*else if \(ref\) ref\.current = node/.test(layer), 'the forwarded ref gets the ScrollView')
  t.ok(/<ScrollView \{\.\.\.props\} ref=\{merged\}>\s*\{props\.children\}\s*<EmbedLayer \/>\s*<\/ScrollView>/.test(layer), 'children first, then the layer')
  t.ok(layer.includes("const inner = scroll && typeof scroll.getInnerViewRef === 'function' ? scroll.getInnerViewRef() : null"))
  t.ok(layer.includes('host.setContent(inner)'), 'the content container is published')
  t.ok(layer.includes('export function renderScroll (p) {\n  return <EmbedScroll {...p} />\n}'))
})

test('the layer keeps every frame mounted', (t) => {
  t.ok(layer.includes('useSyncExternalStore(keep.subscribe, keep.list, keep.list)'), 'reads the keep through useSyncExternalStore')
  t.ok(layer.includes("pointerEvents='box-none'"), 'the layer takes no touch of its own')
  t.ok(layer.includes('StyleSheet.absoluteFill'))
  t.ok(layer.includes('<Animated.View collapsable={false} pointerEvents={parked ? \'none\' : \'auto\'} style={fading ? [framePlace(entry), { opacity }] : framePlace(entry)}>'), 'keyed by entry, and a parked frame takes no touch')
  t.ok(layer.includes("{ position: 'absolute', left: 0, top: 0, width: spec.width, height: spec.height, opacity: 0 }"), 'a parked frame keeps its size')
  t.ok(layer.includes('const parked = rect === null || entry.ready !== true'), 'a frame whose page has not loaded is parked')
  t.absent(/display:\s*'none'/.test(layer), 'never display none')
  t.ok(/const onGone = useCallback\(\(\) => \{\s*embedSlots\.shrink\(Date\.now\(\)\)\s*keep\.drop\(id\)\s*\}, \[keep, id\]\)/.test(layer), 'a dead process lowers the cap and drops its entry')
  t.ok(layer.includes('memo(function KeptFrame'))
  t.ok(/setInterval\(tick, EMBED_TICK_MS\)/.test(layer))
  t.ok(/const locked = embedsHeldAll\(\)\s*for \(const key of heldDrops\(host\.keep\.list\(\), visible && !embedsHeld\(depth\), locked, touchedNow\)\) host\.keep\.drop\(key\)/.test(layer), 'leaving the screen or a hold drops the touched frames, a lock every one')
  t.ok(layer.includes('keep.dispose()'))
})

test('EmbedLayer stays shared by every platform', (t) => {
  t.absent(layerRaw.includes('Platform'), 'no Platform.OS')
  t.absent(layerRaw.includes('removeClippedSubviews'))
  for (const api of ['window.', 'document.', 'navigator.', 'localStorage']) t.absent(layer.includes(api), 'no ' + api)
  t.absent(layerRaw.includes('\u2014'), 'no em dash')
})

test('the card shows through the host and places the frame against the content container', (t) => {
  t.ok(card.includes("const key = host && !draft ? embedKey(rowKey, part, embed.embedUrl) : ''"))
  const show = card.slice(card.indexOf('const shown = host.keep.show(key, {'), card.indexOf('}, release.current, rowKey)'))
  for (const field of ['embedUrl: embed.embedUrl', 'html: embedHtml(embed)', 'baseUrl: EMBED_BASE_URL', 'allowTop: topNavigationAllowed', 'height', 'width', "title: 'Player do ' + name", 'onOpen: openFromPlayer']) {
    t.ok(show.includes(field), field)
  }
  t.ok(card.includes('}, [live, height, width, key, shift])'), 'shown on going live and on a size, key or row shift change only')
  t.ok(card.includes('const content = host.content()'))
  t.ok(card.includes('view.measureLayout(content, (x, y, w, h) => {'), 'measured against the scroll content container')
  t.absent(/measureLayout\([^,]*layer/i.test(card), 'never against the layer')
  t.ok(card.includes('put({ x: x - o.x, y: y - o.y, w, h })'), 'shifted into the layer')
  t.ok(card.includes('const offContent = host.onContentChange(placeFrame)'))
  t.ok(card.includes('onLayout={() => placeFrame()}'))
  t.ok(/placeFrame\(\)\s*if \(missed\) settle\(true, false\)/.test(card), 'placed on every check')
  t.ok(card.includes('useState(() => keptWidth(host, key))'), 'a returning card is active on its first commit')
})

test('a quote is its own entry', (t) => {
  const quote = withoutComments(read('ui', 'QuoteCard.js'))
  t.ok(quote.includes("persist: q.persist === true }} part='q' />"))
})

test('a hosted card leaving live drops its entry and releases once', async (t) => {
  const { live, slots, keep, key, spec, makeApply, host, readerTouchNow } = await setup()
  const real = slots.acquire()
  let calls = 0
  const release = () => { calls++; real() }
  const other = slots.acquire()
  t.is(typeof other, 'function')
  keep.show(key, spec, release, 'row-1')
  const c = { stateRef: { current: live.EMBED_LIVE }, release: { current: release }, hosted: { current: key }, alive: { current: true } }
  const apply = makeApply(slots, c.release, c.stateRef, { current: false }, { width: 390, height: 844 }, c.alive, () => {}, live.EMBED_PARKED, live.EMBED_IDLE, live.EMBED_WAITING, c.hosted, host, Date, readerTouchNow, { current: '' })
  apply(live.EMBED_IDLE)
  t.absent(keep.has(key), 'the entry is gone')
  t.is(calls, 1, 'the release runs exactly once')
  t.is(c.release.current, null)
  t.is(slots.count(), 1)
  t.is(typeof slots.acquire(), 'function', 'a third card gets the freed slot')
  other()
})

test('an orphan in a row that stays goes after the grace', async (t) => {
  const { keep, key, goLive, unmount } = await setup()
  const { grace, tick } = liftOrphanRowTick()
  t.is(grace, 2, 'two ticks, about a second')
  unmount(goLive())
  t.ok(keep.hasOrphan())
  const here = (row) => row === 'row-1'
  let r = tick(keep.list(), here, new Map())
  t.alike(r.drop, [], 'kept on the first tick')
  t.is(r.counts.get(key), 1)
  r = tick(keep.list(), here, r.counts)
  t.alike(r.drop, [key], 'dropped once the grace is used up')
  for (const k of r.drop) keep.drop(k)
  t.absent(keep.has(key))
})

test('an orphan whose row is gone, or that a card takes back, keeps its frame', async (t) => {
  const { keep, key, goLive, unmount } = await setup()
  const { tick } = liftOrphanRowTick()
  unmount(goLive())
  const gone = () => false
  let r = tick(keep.list(), gone, new Map())
  r = tick(keep.list(), gone, r.counts)
  r = tick(keep.list(), gone, r.counts)
  t.alike(r.drop, [], 'a row not mounted never drops it')
  t.is(r.counts.size, 0)
  const here = (row) => row === 'row-1'
  r = tick(keep.list(), here, new Map())
  t.is(r.counts.get(key), 1)
  r = tick(keep.list(), gone, r.counts)
  t.is(r.counts.size, 0, 'the row leaving resets the count')
  r = tick(keep.list(), here, r.counts)
  t.alike(r.drop, [], 'counted again from one')
  t.ok(keep.claim(key), 'a card takes it back inside the grace')
  r = tick(keep.list(), here, r.counts)
  t.alike(r.drop, [])
  t.is(r.counts.size, 0, 'the claim clears it')
  t.ok(keep.has(key))
  t.alike(tick(null, here, null).drop, [])
  t.alike(tick([{ key: 'x', orphan: true, row: 'r' }], () => { throw new Error('x') }, null).drop, [], 'a throwing check keeps the frame')
})

test('a row counts as mounted until its last mount goes', (t) => {
  const rowMounted = liftRowMounted()
  const rows = new Map()
  const a = rowMounted(rows, 'row-1')
  const b = rowMounted(rows, 'row-1')
  a()
  a()
  t.ok(rows.has('row-1'), 'one unmount, even run twice, leaves the other')
  b()
  t.absent(rows.has('row-1'))
  t.is(rows.size, 0)
  rowMounted(rows, '')()
  t.is(rows.size, 0, 'a row with no key is never counted')
})

test('a card unmounted after another player started drops its touched frame', async (t) => {
  const { slots, keep, key, goLive, unmount, playback } = await setup()
  const c = goLive()
  slots.engage(c.release.current, true)
  playback.count = 1
  unmount(c)
  t.absent(keep.has(key), 'no orphan to miss the new player')
  t.absent(keep.hasOrphan())
  t.is(slots.count(), 0, 'its slot is free')
})

test('a card that takes a touched frame back after another player started closes it', async (t) => {
  const { live, slots, keep, key, goLive, unmount, mount, playback } = await setup()
  const touched = goLive()
  slots.engage(touched.release.current, true)
  unmount(touched)
  t.ok(keep.hasOrphan())
  playback.seen = 0
  playback.count = 1
  const c = mount(true)
  t.alike(c.applied, [live.EMBED_IDLE], 'closed at once')
  t.is(c.stateRef.current, live.EMBED_IDLE)
  t.absent(keep.has(key))
  t.is(slots.count(), 0)
})

test('a card that takes a frame back with no new player keeps it', async (t) => {
  const { live, slots, keep, key, goLive, unmount, mount, playback } = await setup()
  unmount(goLive())
  playback.count = 3
  playback.seen = 3
  const c = mount(true)
  t.alike(c.applied, [])
  t.is(c.stateRef.current, live.EMBED_PARKED)
  t.is(c.claims.current, 3, 'counted from what the list last saw')
  t.ok(keep.has(key))
  t.is(slots.count(), 1)
})

test('the list keeps renderRow stable across renders', (t) => {
  const row = list.slice(list.indexOf('const renderRow = useCallback('), list.indexOf('\n', list.indexOf('</EmbedRow>')) + 20)
  t.ok(/<\/EmbedRow>\n {2}\), \[renderItem\]\)\n$/.test(row), 'renderRow depends on renderItem only')
  t.ok(list.includes('const keyOf = useRef(keyExtractor)\n  keyOf.current = keyExtractor'), 'the key extractor is read through a ref')
  t.ok(/pruneOrphans\(\)\s*\}, \[data\]\)/.test(list), 'the prune depends on data only')
  t.ok(/if \(next\.wait !== null\) c\.timer = setTimeout\(pruneOrphans, next\.wait\)\s*\}, \[host\]\)/.test(list), 'its callback on the host only')
  t.absent(list.includes('function rowKeyOf'), 'the list reads row keys through the layer')
  const rowKeyOf = layerRaw.slice(layerRaw.indexOf('export function rowKeyOf'), layerRaw.indexOf('\n}\n', layerRaw.indexOf('export function rowKeyOf')))
  t.ok(rowKeyOf.includes("if (typeof keyExtractor !== 'function') return ''"), 'a missing key extractor keeps the row inline')
  t.ok(/try \{\s*return String\(keyExtractor\(item, index\)\)\s*\} catch \{\s*return ''\s*\}/.test(rowKeyOf), 'a throwing one too')
})

test('the host reads no context; the layer leaf does', (t) => {
  const start = layer.indexOf('export function useEmbedHost ()')
  const hook = layer.slice(start, layer.indexOf('\n}\n', start))
  t.ok(hook.length > 0)
  t.absent(hook.includes('useContext'), 'useEmbedHost has no useContext')
  const leaf = layer.slice(layer.indexOf('function Layer ({ host })'), layer.indexOf('export const EmbedScroll'))
  t.ok(leaf.includes('useContext(ScreenVisible)') && leaf.includes('useContext(SheetDepth)'), 'Layer reads the screen and the sheet')
  t.ok(/heldDrops\(host\.keep\.list\(\), visible && !embedsHeld\(depth\), locked, touchedNow\)/.test(leaf))
  t.absent(layer.includes('dropAll()'), 'the layer never drops every frame unread')
})

test('the host ticks rows and keeps the playback count it saw', (t) => {
  t.ok(layer.includes('const next = orphanRowTick(keep.list(), (row) => rows.has(row), grace)'), 'the tick drops orphans of mounted rows')
  t.ok(layer.includes('claimsSeen: () => (seen === null ? playbackClaimCount() : seen)'))
  t.ok(layer.includes('useEffect(() => (host && row ? host.rowMounted(row) : undefined), [host, row])'), 'EmbedRow registers its row')
  t.ok(layer.includes('<EmbedRowKey.Provider value={row}>{children}</EmbedRowKey.Provider>'))
})

test('a frame nobody can see opens nothing', (t) => {
  const m = layerRaw.match(/export function frameOpens \(parked, shown, held\) \{([\s\S]*?)\n\}/)
  t.ok(m, 'frameOpens found')
  const frameOpens = new Function('parked', 'shown', 'held', m[1]) // eslint-disable-line no-new-func
  t.is(frameOpens(false, true, false), true, 'loaded, placed, shown and not held: it opens')
  t.is(frameOpens(true, true, false), false, 'parked or not loaded: nothing')
  t.is(frameOpens(false, false, false), false, 'a hidden screen: nothing')
  t.is(frameOpens(false, true, true), false, 'a sheet, a menu or a lock holds the players: nothing')
  t.is(frameOpens(false, undefined, false), false, 'an unread screen counts as hidden')
  t.is(frameOpens(false, true, undefined), false, 'an unread hold counts as held')
  t.ok(layer.includes('onOpen={opens ? spec.onOpen : undefined}'), 'the frame gets onOpen only when it opens')
  t.ok(layer.includes('const held = useSyncExternalStore(onEmbedHold, () => embedsHeld(depth), () => embedsHeld(depth))'), 'the layer renders again when a hold changes')
  t.absent(layer.includes('onOpen={parked ? undefined : spec.onOpen}'))
})

// rowOrder, cutOff and orphanCuts, as written.
function liftCuts () {
  const { rowKeyOf } = liftKeptRowKeys()
  const cut = layerRaw.match(/export const EMBED_CUT_MS = (\d+)\n/)
  const ro = layerRaw.match(/export function rowOrder \(data, keyExtractor, order, keep\) \{([\s\S]*?)\n\}/)
  const co = layerRaw.match(/export function cutOff \(row, order\) \{([\s\S]*?)\n\}/)
  const oc = layerRaw.match(/export function orphanCuts \(entries, kept, order, deadlines, now, touched\) \{([\s\S]*?)\n\}/)
  if (!cut || !ro || !co || !oc) throw new Error('the cut helpers not found')
  const EMBED_CUT_MS = Number(cut[1])
  const roFn = new Function('rowKeyOf', 'data', 'keyExtractor', 'order', 'keep', ro[1]) // eslint-disable-line no-new-func
  const cutOff = new Function('row', 'order', co[1]) // eslint-disable-line no-new-func
  const ocFn = new Function('EMBED_CUT_MS', 'cutOff', 'entries', 'kept', 'order', 'deadlines', 'now', 'touched', oc[1]) // eslint-disable-line no-new-func
  return {
    EMBED_CUT_MS,
    rowOrder: (data, keyExtractor, order, keep) => roFn(rowKeyOf, data, keyExtractor, order, keep),
    cutOff,
    orphanCuts: (entries, kept, order, deadlines, now, touched) => ocFn(EMBED_CUT_MS, cutOff, entries, kept, order, deadlines, now, touched)
  }
}

// The list's prune callback, its data effect and its unmount cleanup, as
// written, rendered through stub hooks with a fake clock and fake timers,
// against the real cut helpers, keptRowKeys and a real keep.
async function liftPrune () {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const { keptRowKeys } = liftKeptRowKeys()
  const cuts = liftCuts()
  const start = list.indexOf('  const cut = useRef(')
  const effect = list.indexOf('  }, [data])', start)
  const end = list.indexOf('  }, [])', effect)
  if (start === -1 || effect === -1 || end === -1) throw new Error('the prune effect not found')
  const body = list.slice(start, end + '  }, [])'.length)
  const names = ['useRef', 'useCallback', 'useEffect', 'orphanCuts', 'keptRowKeys', 'rowOrder', 'touchedNow', 'host', 'keyOf', 'data', 'Date', 'setTimeout', 'clearTimeout']
  const hook = new Function(...names, body) // eslint-disable-line no-new-func
  const keep = createEmbedKeep()
  const host = { keep }
  const keyOf = { current: (item) => item.key }
  const touchedSet = new Set()
  const clock = { now: 1000 }
  const timers = new Map()
  let timerId = 0
  const refs = []
  const callbacks = []
  const deps = []
  const cleanups = []
  const render = (data) => {
    let r = 0
    let c = 0
    let e = 0
    const effects = []
    hook(
      (init) => { const i = r++; if (!refs[i]) refs[i] = { current: init }; return refs[i] },
      (fn) => { const i = c++; if (!callbacks[i]) callbacks[i] = fn; return callbacks[i] },
      (fn, d) => { effects.push({ i: e++, fn, d }) },
      cuts.orphanCuts, keptRowKeys, cuts.rowOrder,
      (release) => touchedSet.has(release),
      host, keyOf, data,
      { now: () => clock.now },
      (fn, ms) => { timers.set(++timerId, { fn, at: clock.now + ms }); return timerId },
      (id) => { timers.delete(id) }
    )
    for (const { i, fn, d } of effects) {
      const prev = deps[i]
      if (prev && prev.length === d.length && prev.every((v, k) => Object.is(v, d[k]))) continue
      deps[i] = d
      if (typeof cleanups[i] === 'function') cleanups[i]()
      cleanups[i] = fn()
    }
  }
  const advance = (ms) => {
    clock.now += ms
    // A re-prune that keeps rescheduling itself at once must fail, not hang.
    for (let n = 0; n < 100; n++) {
      const due = [...timers].filter(([, timer]) => timer.at <= clock.now).sort((x, y) => x[1].at - y[1].at)[0]
      if (!due) return
      timers.delete(due[0])
      due[1].fn()
    }
    throw new Error('the re-prune never settles')
  }
  const unmount = () => { for (const fn of cleanups) if (typeof fn === 'function') fn() }
  const released = new Map()
  const orphanOf = (row, touched = false) => {
    const key = row + '|https://open.spotify.com/embed/track/' + row
    const release = () => { released.set(key, (released.get(key) || 0) + 1) }
    keep.show(key, { embedUrl: 'x' }, release, row)
    keep.orphan(key)
    if (touched) touchedSet.add(release)
    return key
  }
  const rows = (...keys) => keys.map((key) => ({ key }))
  return { run: render, keep, orphanOf, rows, advance, unmount, timers, released, cut: () => refs[0].current, EMBED_CUT_MS: cuts.EMBED_CUT_MS }
}

test('a first page read again keeps the orphans of the rows it cut off', async (t) => {
  const { run, keep, orphanOf, rows } = await liftPrune()
  run(rows('a', 'b', 'c', 'd', 'e', 'f'))
  const d = orphanOf('d')
  const f = orphanOf('f')
  run(rows('a', 'b', 'c'))
  t.ok(keep.has(d) && keep.has(f), 'rows cut off past the end keep their frames')
  run(rows('n', 'a', 'b', 'c', 'd', 'e', 'f'))
  t.ok(keep.has(d) && keep.has(f), 'and the list pages back to them')
  run(rows('n', 'a', 'b', 'c', 'e', 'f'))
  t.absent(keep.has(d), 'a row taken out between two others drops its frame')
  t.ok(keep.has(f))
  const b = orphanOf('b')
  run(rows('n', 'a'))
  t.ok(keep.has(b) && keep.has(f), 'cut off again, nothing drops')
  run(rows('n', 'a', 'c', 'e', 'f'))
  t.absent(keep.has(b), 'a row missing once the rows after it came back drops its frame')
  t.ok(keep.has(f))
  run([{ key: 'n' }, { key: 'a' }, { key: 'c' }, { key: 'e' }, { key: 'f', deleted: true }])
  t.absent(keep.has(f), 'a tombstone still drops at once')
})

test('a cut-off tail waits EMBED_CUT_MS for its row, then goes with no further change', async (t) => {
  const { run, keep, orphanOf, rows, advance, timers, released, cut, EMBED_CUT_MS } = await liftPrune()
  t.is(EMBED_CUT_MS, 5000)
  run(rows('a', 'b'))
  const b = orphanOf('b')
  run(rows('a'))
  t.ok(keep.has(b), 'an untouched orphan of the last row cut off stays for now')
  t.is(timers.size, 1, 'one re-prune is scheduled')
  advance(EMBED_CUT_MS - 1)
  t.ok(keep.has(b), 'still kept just before the deadline')
  advance(1)
  t.absent(keep.has(b), 'still missing at the deadline: dropped')
  t.is(released.get(b), 1, 'its slot released once')
  t.is(timers.size, 0, 'nothing left to wait for')

  run(rows('a', 'b'))
  const again = orphanOf('b')
  run(rows('a'))
  advance(EMBED_CUT_MS - 1000)
  run(rows('a', 'b'))
  t.ok(keep.has(again), 'the row came back before the deadline: kept')
  t.is(cut().deadlines.size, 0, 'and its deadline cleared')
  t.is(timers.size, 0, 'the re-prune cancelled')
  advance(EMBED_CUT_MS)
  t.ok(keep.has(again), 'the old deadline no longer counts')
  run(rows('a'))
  advance(EMBED_CUT_MS - 1)
  t.ok(keep.has(again), 'missing again: a new deadline starts')
  advance(1)
  t.absent(keep.has(again), 'and drops it')
})

test('a touched orphan of a removed tail goes at once', async (t) => {
  const { run, keep, orphanOf, rows, timers } = await liftPrune()
  run(rows('a', 'b'))
  const b = orphanOf('b', true)
  run(rows('a'))
  t.absent(keep.has(b), 'it may be playing with no card')
  t.is(timers.size, 0)
})

test('replaced data drops every old orphan at once', async (t) => {
  const { run, keep, orphanOf, rows } = await liftPrune()
  run(rows('a', 'b'))
  const a = orphanOf('a')
  const b = orphanOf('b')
  run(rows('c', 'd'))
  t.absent(keep.has(a), 'no row before it is present')
  t.absent(keep.has(b))
})

test('emptied data keeps untouched orphans until the deadline, not touched ones', async (t) => {
  const { run, keep, orphanOf, rows, advance, EMBED_CUT_MS } = await liftPrune()
  run(rows('a', 'b'))
  const a = orphanOf('a')
  const b = orphanOf('b', true)
  run([])
  t.ok(keep.has(a), 'untouched: kept for now')
  t.absent(keep.has(b), 'touched: dropped at once')
  advance(EMBED_CUT_MS)
  t.absent(keep.has(a), 'dropped at the deadline')
})

test('a first page read again, with or without a prepend, keeps the older rows for now', async (t) => {
  const { run, keep, orphanOf, rows } = await liftPrune()
  run(rows('r1', 'r2', 'r3', 'r4', 'r5', 'r6'))
  const older = ['r4', 'r5', 'r6'].map((row) => orphanOf(row))
  run(rows('r1', 'r2', 'r3'))
  t.ok(older.every((key) => keep.has(key)), 'cut off past the end')
  run(rows('r0', 'r1', 'r2', 'r3'))
  t.ok(older.every((key) => keep.has(key)), 'a prepend plus a cut: the same')
})

test('a row taken out between two others drops at once', async (t) => {
  const { run, keep, orphanOf, rows } = await liftPrune()
  run(rows('a', 'b', 'c'))
  const b = orphanOf('b')
  run(rows('a', 'c'))
  t.absent(keep.has(b))
})

test('a removed tail goes when the list pages on without it', async (t) => {
  const { run, keep, orphanOf, rows, timers } = await liftPrune()
  run(rows('a', 'b'))
  const b = orphanOf('b')
  run(rows('a'))
  t.ok(keep.has(b))
  run(rows('a', 'c', 'd'))
  t.absent(keep.has(b), 'the list goes on past where it was')
  t.is(timers.size, 0)
})

test('the list clears its re-prune on unmount', async (t) => {
  const { run, orphanOf, rows, unmount, timers } = await liftPrune()
  run(rows('a', 'b'))
  orphanOf('b')
  run(rows('a'))
  t.is(timers.size, 1)
  unmount()
  t.is(timers.size, 0)
})

test('the list forgets rows no orphan walks back through', async (t) => {
  const { run, orphanOf, rows, advance, cut, EMBED_CUT_MS } = await liftPrune()
  for (let i = 0; i < 50; i++) run(rows('s' + i))
  t.is(cut().order.before.size, 1, 'data replaced again and again keeps one row')
  run(rows('a', 'b', 'c', 'd'))
  orphanOf('d')
  run(rows('a', 'b'))
  t.ok(cut().order.before.has('d') && cut().order.before.has('c'), 'a cut-off orphan keeps the rows back to the new end')
  advance(EMBED_CUT_MS)
  run(rows('a', 'b'))
  t.absent(cut().order.before.has('d') || cut().order.before.has('c'), 'once its frame went, the next change forgets them')
})

test('rowOrder, cutOff and orphanCuts', (t) => {
  const { rowOrder, cutOff, orphanCuts, EMBED_CUT_MS } = liftCuts()
  const keyOf = (item) => item.key
  const first = rowOrder([{ key: 'a' }, { key: 'b' }], keyOf, null)
  t.alike([...first.before], [['a', null], ['b', 'a']])
  t.alike([...first.present], ['a', 'b'])
  t.is(first.last, 'b')
  const next = rowOrder([{ key: 'a' }], keyOf, first, ['b'])
  t.is(next.before.get('b'), 'a', 'an orphan row that left keeps the row it came after')
  t.is(first.before.size, 2, 'the earlier record is not changed')
  t.ok(cutOff('b', next), 'after the last row: cut off')
  t.absent(cutOff('b', rowOrder([{ key: 'a' }, { key: 'c' }], keyOf, next, ['b'])), 'the list goes on: taken out')
  t.absent(rowOrder([{ key: 'a' }], keyOf, first).before.has('b'), 'a row that left with no orphan is forgotten')
  t.absent(rowOrder([{ key: 'a' }], keyOf, next, []).before.has('b'), 'and so is one whose orphan went')
  const six = rowOrder(['a', 'b', 'c', 'd', 'e', 'f'].map((key) => ({ key })), keyOf, null)
  const three = rowOrder([{ key: 'a' }, { key: 'b' }, { key: 'c' }], keyOf, six, ['f', 'zz', 'b'])
  t.alike([...three.before].sort(), [['a', null], ['b', 'a'], ['c', 'b'], ['d', 'c'], ['e', 'd'], ['f', 'e']], 'the rows an orphan walks back through stay, an unknown one adds nothing')
  t.ok(cutOff('f', three), 'so the orphan past them is still cut off')
  t.alike([...rowOrder([{ key: 'z' }], keyOf, { before: new Map([['x', 'y'], ['y', 'x']]) }, ['x']).before].sort(), [['x', 'y'], ['y', 'x'], ['z', null]], 'a cycle ends')
  let churn = null
  for (let i = 0; i < 1000; i++) churn = rowOrder([{ key: 'r' + i }], keyOf, churn, [])
  t.is(churn.before.size, 1, 'replacing the data a thousand times keeps one row')
  for (const data of [null, undefined, {}, 'ab']) {
    const empty = rowOrder(data, keyOf, null)
    t.is(empty.present.size, 0, 'non-array data has no rows')
    t.is(empty.last, null)
    t.ok(cutOff('x', empty), 'empty data cuts every row off')
  }
  t.absent(cutOff('x', { before: new Map([['x', 'y'], ['y', 'x']]), present: new Set(['z']), last: 'z' }), 'a cycle ends, taken out')
  t.absent(cutOff('x', null), 'bad input cuts nothing off')
  t.absent(cutOff('x', rowOrder([{ key: 'a' }], keyOf, null)), 'a row never seen, with data: taken out')

  const order = rowOrder([{ key: 'a' }], keyOf, first, ['b'])
  const release = () => {}
  const entry = { key: 'kb', row: 'b', orphan: true, release }
  const kept = new Set(['a'])
  const waiting = orphanCuts([entry], kept, order, new Map(), 100, () => false)
  t.alike(waiting.drop, [])
  t.is(waiting.deadlines.get('b'), 100 + EMBED_CUT_MS)
  t.is(waiting.wait, EMBED_CUT_MS)
  const later = orphanCuts([entry], kept, order, waiting.deadlines, 100 + EMBED_CUT_MS - 10, () => false)
  t.is(later.wait, 10, 'the deadline is kept, not restarted')
  t.alike(orphanCuts([entry], kept, order, waiting.deadlines, 100 + EMBED_CUT_MS, () => false).drop, ['kb'], 'dropped at the deadline')
  t.alike(orphanCuts([entry], kept, order, new Map(), 100).drop, ['kb'], 'a missing touched counts as touched')
  t.alike(orphanCuts([entry], kept, order, new Map(), 100, () => { throw new Error('x') }).drop, ['kb'], 'a throwing one too')
  t.alike(orphanCuts([entry], new Set(['a', 'b']), order, waiting.deadlines, 100, () => true).drop, [], 'a kept row stays, even touched')
  t.is(orphanCuts([entry], new Set(['a', 'b']), order, waiting.deadlines, 100, () => true).deadlines.size, 0, 'and loses its deadline')
  const tomb = rowOrder([{ key: 'a' }, { key: 'b' }], keyOf, null)
  t.alike(orphanCuts([entry], kept, tomb, new Map(), 100, () => false).drop, ['kb'], 'a tombstone drops at once')
  t.alike(orphanCuts([{ ...entry, orphan: false }], kept, order, new Map(), 100, () => true).drop, [], 'only orphans')
  t.alike(orphanCuts(null, kept, order, new Map(), 100, () => true), { drop: [], deadlines: new Map(), wait: null })
})

test('keptRowKeys leaves out hidden and deleted items', (t) => {
  const { keptRowKeys, rowKeyOf } = liftKeptRowKeys()
  const keyOf = (item) => item.key
  const kept = keptRowKeys([
    { key: 'a' },
    { key: 'b', hidden: true },
    { key: 'c', deleted: true },
    { key: 'd', hidden: false },
    { key: 'e', deleted: false }
  ], keyOf)
  t.ok(kept instanceof Set)
  t.alike([...kept], ['a', 'd', 'e'], 'a hidden or a deleted item is not kept; a normal one is')
  t.ok(keptRowKeys([{ key: 'x', hidden: 'yes' }], keyOf).has('x'), 'only true makes a tombstone')
  const before = [{ key: 'a' }, { key: 'b' }]
  const after = keptRowKeys([{ key: 'new' }, ...before], keyOf)
  t.ok(after.has('a') && after.has('b'), 'a prepend keeps every old key')
  t.ok(after.has('new'))
  t.alike([...keptRowKeys([null, 7], (item, index) => 'r' + index)], ['r0', 'r1'], 'a null or non-object item is no tombstone')
  for (const data of [null, undefined, {}, 'ab', 3]) t.is(keptRowKeys(data, keyOf).size, 0, 'non-array data keeps nothing')
  t.alike([...keptRowKeys([{ key: 'a' }], undefined)], [''], 'a missing key extractor gives the inline key')
  t.alike([...keptRowKeys([{ key: 'a' }], () => { throw new Error('x') })], [''], 'a throwing one too')
  t.alike([...keptRowKeys([null], keyOf)], [''], 'a key extractor that throws on a null item')
  t.is(rowKeyOf(keyOf, { key: 5 }, 0), '5', 'keys are strings')
  t.is(rowKeyOf(null, { key: 'a' }, 0), '')
})

test('a kept frame whose message turns into a tombstone is pruned', async (t) => {
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const { keptRowKeys } = liftKeptRowKeys()
  const keyOf = (item) => item.key
  const spec = Object.freeze({ embedUrl: 'https://open.spotify.com/embed/track/x', height: 152, width: 300 })
  const orphaned = () => {
    const keep = createEmbedKeep()
    let released = 0
    keep.show('m1|x', spec, () => { released++ }, 'm1')
    keep.orphan('m1|x')
    return { keep, released: () => released }
  }

  const hidden = orphaned()
  const keptHidden = keptRowKeys([{ key: 'm0' }, { key: 'm1', hidden: true }], keyOf)
  hidden.keep.prune((row) => keptHidden.has(row))
  t.absent(hidden.keep.has('m1|x'), 'a hidden message drops its frame')
  t.is(hidden.released(), 1, 'and releases its slot once')

  const deleted = orphaned()
  const keptDeleted = keptRowKeys([{ key: 'm1', deleted: true }], keyOf)
  deleted.keep.prune((row) => keptDeleted.has(row))
  t.absent(deleted.keep.has('m1|x'), 'a deleted message too')
  t.is(deleted.released(), 1)

  const normal = orphaned()
  const keptNormal = keptRowKeys([{ key: 'm1' }], keyOf)
  normal.keep.prune((row) => keptNormal.has(row))
  t.ok(normal.keep.has('m1|x'), 'a message that stays keeps its frame')
  t.is(normal.released(), 0)
})

function liftFramePlace () {
  const m = layerRaw.match(/export function framePlace \(entry\) \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('framePlace not found')
  return new Function('entry', m[1]) // eslint-disable-line no-new-func
}

test('a placed frame follows its row shift, a parked one never moves', (t) => {
  const framePlace = liftFramePlace()
  const spec = { width: 300, height: 152, shift: null }
  const parked = framePlace({ rect: null, spec })
  t.alike(parked, { position: 'absolute', left: 0, top: 0, width: 300, height: 152, opacity: 0 })
  t.absent(parked.transform)
  const rect = { x: 4, y: 900, w: 280, h: 152 }
  const placed = framePlace({ rect, spec, ready: true })
  t.alike(placed, { position: 'absolute', left: 4, top: 900, width: 280, height: 152 })
  t.absent(placed.transform)
  const shift = { animated: true }
  const moved = framePlace({ rect, spec: { ...spec, shift }, ready: true })
  t.is(moved.transform[0].translateX, shift, 'the same Animated value as the row')
  t.is(moved.top, 900)
  t.absent(framePlace({ rect: null, spec: { ...spec, shift } }).transform, 'parked ignores the shift')
})

test('every kept frame wrapper is an Animated.View, so a shift never remounts it', (t) => {
  t.ok(layer.includes('<Kept key={entry.key}'), 'each entry renders through Kept, keyed by entry')
  t.ok(/<Animated\.View collapsable=\{false\}[^>]*style=\{fading \? \[framePlace\(entry\), \{ opacity \}\] : framePlace\(entry\)\}/.test(layer), 'the wrapper places by framePlace in both branches')
  t.ok(layer.includes('useReveal(entry.ready === true)'), 'the fade is keyed on ready only')
  t.absent(/useReveal\([^)]*rect/.test(layer), 'a row coming back never fades again')
  t.ok(layer.includes('const fading = !parked && !settled'), 'the fade style applies only while fading')
  t.absent(layer.includes('<View key={entry.key}'))
})

test('another player closes only the orphans the person touched', async (t) => {
  const orphanTick = liftOrphanTick()
  const touched = () => {}
  const untouched = () => {}
  const entries = [
    { key: 'a', orphan: true, release: touched },
    { key: 'b', orphan: true, release: untouched },
    { key: 'c', orphan: false, release: touched }
  ]
  const engaged = (release) => release === touched
  t.alike(orphanTick(entries, true, () => false, engaged), ['a'], 'the untouched orphan stays loaded')
  t.alike(orphanTick(entries, false, () => false, engaged), [], 'no new player, nothing closes')
  t.alike(orphanTick(entries, true, (release) => release === untouched, engaged), ['a', 'b'], 'an untouched orphan still yields its slot')
  t.alike(orphanTick(entries, true, () => false), ['a', 'b'], 'a missing engaged counts as touched')
  t.alike(orphanTick(entries, true, () => false, () => { throw new Error('x') }), ['a', 'b'], 'a throwing one too')
  t.alike(orphanTick(entries, true, () => false, () => undefined), ['a', 'b'], 'only false keeps it')

  const { slots, touchedNow } = await liftHeld()
  const a = slots.acquire()
  const b = slots.acquire()
  slots.engage(a, true)
  const real = [{ key: 'a', orphan: true, release: a }, { key: 'b', orphan: true, release: b }]
  t.alike(orphanTick(real, true, slots.yielding, touchedNow), ['a'], 'the host reads the real engagement')
  t.ok(layer.includes('orphanTick(keep.list(), changed, yielding, touchedNow)'), 'the host tick passes touchedNow')
  t.ok(/return embedTouched\(embedSlots\.engaged\(release\), screenReaderOn\(\), screenReaderKnown\(\)\)/.test(layer), 'read at the moment of the decision')
})

test('a hidden screen or a sheet closes only the touched kept frames', async (t) => {
  const { live, slots, sync } = await liftHeld()
  const hidden = await twoKept(slots)
  sync(hidden.host, true, 0)
  t.ok(hidden.keep.has('touched') && hidden.keep.has('untouched'), 'a shown screen closes nothing')
  sync(hidden.host, false, 0)
  t.absent(hidden.keep.has('touched'), 'a hidden screen closes the touched frame')
  t.ok(hidden.keep.has('untouched'), 'and keeps the untouched one loaded')
  t.is(slots.count(), 1, 'the touched frame gave back its slot')
  hidden.keep.dispose()

  const sheet = await twoKept(slots)
  const off = live.holdEmbeds()
  try {
    sync(sheet.host, true, 1)
    t.ok(sheet.keep.has('touched'), 'a list inside the sheet keeps its frames')
    sync(sheet.host, true, 0)
    t.absent(sheet.keep.has('touched'), 'a sheet over the screen closes the touched frame')
    t.ok(sheet.keep.has('untouched'), 'and keeps the untouched one loaded')
  } finally {
    off()
    sheet.keep.dispose()
  }
})

test('an unknown or running screen reader counts as a touch', async (t) => {
  const reader = { on: false, known: false }
  const { slots, sync } = await liftHeld(reader)
  const unknown = await twoKept(slots)
  sync(unknown.host, false, 0)
  t.is(unknown.keep.list().length, 0, 'no answer from the reader yet: every frame closes')
  unknown.keep.dispose()
  reader.known = true
  reader.on = true
  const on = await twoKept(slots)
  sync(on.host, false, 0)
  t.is(on.keep.list().length, 0, 'a running reader: every frame closes')
  on.keep.dispose()
})

test('a lock or the background closes every kept frame', async (t) => {
  const { live, slots, sync, heldDrops } = await liftHeld()
  const locked = await twoKept(slots)
  const off = live.holdAllEmbeds()
  try {
    sync(locked.host, true, 0)
    t.is(locked.keep.list().length, 0, 'the untouched frame closes too')
    t.is(slots.count(), 0, 'every slot is free')
  } finally {
    off()
    locked.keep.dispose()
  }
  const entries = [{ key: 'u', release: () => {} }]
  t.alike(heldDrops(entries, true, true, () => false), ['u'], 'locked closes even on a shown screen')
  t.alike(heldDrops(entries, false, undefined, () => false), ['u'], 'an unread lock counts as locked')
  t.alike(heldDrops(entries, false, false, () => { throw new Error('x') }), ['u'], 'a throwing touched counts as touched')
  t.alike(heldDrops(entries, false, false), ['u'], 'a missing one too')
  t.alike(heldDrops(null, false, true, () => true), [])
})

test('a frame whose provider page has not loaded sits on its slot, transparent', (t) => {
  const framePlace = liftFramePlace()
  const spec = { width: 300, height: 152, shift: null }
  const rect = { x: 4, y: 900, w: 280, h: 152 }
  t.alike(framePlace({ rect, spec, ready: false }), { position: 'absolute', left: 4, top: 900, width: 280, height: 152, opacity: 0 }, 'placed, with opacity 0')
  t.alike(framePlace({ rect, spec }), { position: 'absolute', left: 4, top: 900, width: 280, height: 152, opacity: 0 }, 'a missing flag counts as not loaded')
  t.absent('opacity' in framePlace({ rect, spec, ready: true }), 'a loaded one shows')
  t.ok(layer.includes('<KeptFrame spec={spec} parked={parked} opens={frameOpens(parked, visible, held)} keep={keep} id={entry.key} release={entry.release} />'), 'the frame is parked, so the card under it takes the screen reader')
  t.ok(layer.includes('const onReady = useCallback(() => keep.ready(id), [keep, id])'))
  t.ok(layer.includes('const onEngage = useCallback((on) => embedSlots.engage(release, on, playbackClaimCount()), [release])'))
  t.ok(/onReady=\{onReady\}\s*onEngage=\{onEngage\}/.test(layer), 'both reach the frame')
})

test('several frames gone in the same window lower the cap one step', async (t) => {
  const live = await import('../src/embedLive.js')
  const { createEmbedKeep } = await import('../src/embedKeep.js')
  const start = 'const onGone = useCallback(() => {\n'
  const body = sliceBetween(layerRaw, start, '\n  }, [keep, id])').slice(start.length)
  const onGone = new Function('embedSlots', 'keep', 'id', body) // eslint-disable-line no-new-func
  const slots = live.createEmbedSlots(live.EMBED_LIVE_MAX)
  const keep = createEmbedKeep()
  const spec = Object.freeze({ embedUrl: 'https://open.spotify.com/embed/track/x', height: 152, width: 300 })
  for (const id of ['a', 'b', 'c']) keep.show(id, spec, slots.acquire(), 'row-' + id)
  t.is(slots.count(), 3)
  for (const id of ['a', 'b', 'c']) onGone(slots, keep, id)
  t.is(slots.limit(), live.EMBED_LIVE_MAX - 1, 'one step for the whole burst')
  t.is(keep.list().length, 0, 'every dead frame leaves the layer')
  t.is(slots.count(), 0, 'and gives back its slot')
})

test('an untouched frame survives a playback claim when its card unmounts', async (t) => {
  const { slots, keep, key, goLive, unmount, playback, reader } = await setup()
  const c = goLive()
  const release = c.release.current
  playback.count = 1
  unmount(c)
  t.ok(keep.has(key), 'it cannot be playing, so the list keeps it')
  t.ok(keep.hasOrphan())
  t.is(slots.count(), 1)
  t.is(keep.list()[0].release, release)
  keep.dispose()
  reader.known = false
  const d = goLive()
  playback.count = 2
  unmount(d)
  t.absent(keep.has(key), 'with a screen reader that has not answered, it counts as touched')
})

test('a card that takes an untouched frame back after another player started keeps it', async (t) => {
  const { live, slots, keep, key, goLive, unmount, mount, playback } = await setup()
  unmount(goLive())
  playback.seen = 0
  playback.count = 1
  const c = mount(true)
  t.alike(c.applied, [], 'nothing closes it')
  t.is(c.stateRef.current, live.EMBED_PARKED)
  t.ok(keep.has(key))
  t.is(slots.count(), 1)
})

test('a returning card with a ready kept frame draws no stand-in on its first commit', async (t) => {
  const { keep, key, goLive, unmount, mount } = await setup()
  const slotParts = liftCardHelper('slotParts', ['live', 'hosted', 'ready'])
  t.ok(card.includes('const [ready, setReady] = useState(() => keptReady(host, key))'), 'the first ready is read from the kept entry')
  const c = goLive()
  keep.ready(key)
  unmount(c)
  const back = mount(true)
  t.is(back.ready[0], true, 'ready on the first commit')
  t.alike(slotParts(back.stateRef.current.live, true, back.ready[0]), { standIn: false, empty: true, frame: false }, 'the empty slot, with no stored card over the frame')
  t.is(back.ready[back.ready.length - 1], true, 'the claim keeps it ready')
})

test('a returning card whose kept frame has not loaded keeps the stored card', async (t) => {
  const { keep, goLive, unmount, mount } = await setup()
  const slotParts = liftCardHelper('slotParts', ['live', 'hosted', 'ready'])
  unmount(goLive())
  t.is(keep.list()[0].ready, false)
  const back = mount(true)
  t.is(back.ready[0], false)
  t.alike(slotParts(back.stateRef.current.live, true, back.ready[0]), { standIn: true, empty: false, frame: false }, 'the stored card stays until the page has loaded')
  t.is(back.ready[back.ready.length - 1], false)
})

test('the stored card stays drawn until the kept entry is ready', async (t) => {
  const { live, keep, key, goLive, keptReady } = await setup()
  const listener = liftKeepListener()
  const c = goLive()
  const ready = []
  const applied = []
  const off = keep.subscribe(() => listener(c.hosted, { keep }, c.release, (s) => applied.push(s), live.EMBED_IDLE, keptReady, (r) => ready.push(r)))
  keep.place(key, { x: 0, y: 20, w: 300, h: 152 })
  t.alike(ready, [], 'a frame placed but still loading leaves the stored card')
  keep.ready(key)
  t.alike(ready, [true], 'the loaded page swaps it for the empty slot')
  t.alike(applied, [])
  keep.drop(key)
  t.alike(applied, [live.EMBED_IDLE], 'a dropped frame brings the stored card back')
  t.is(c.hosted.current, '')
  t.is(c.release.current, null)
  off()
})
