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
  const names = ['alive', 'stateRef', 'EMBED_WAITING', 'EMBED_IDLE', 'embedSlots', 'hosted', 'release', 'host', 'playbackClaimCount', 'claims']
  return new Function(...names, body) // eslint-disable-line no-new-func
}

// The card's mount effect, without its cleanup, and its first state.
function liftMount () {
  const body = sliceBetween(cardRaw, '    const kept = key ? host.keep.claim(key) : null', '    // A new key while mounted')
  const names = ['key', 'host', 'release', 'hosted', 'stateRef', 'setState', 'apply', 'EMBED_PARKED', 'EMBED_IDLE', 'playbackClaimCount', 'claims']
  return new Function(...names, body) // eslint-disable-line no-new-func
}

// The card's real apply(), as musicEmbedCard.test.js lifts it.
function liftApply () {
  const start = cardRaw.indexOf('  const apply = (')
  const end = cardRaw.indexOf('  useEffect(() => {\n    alive.current = true')
  if (start === -1 || end === -1) throw new Error('apply() not found')
  const names = ['embedSlots', 'release', 'stateRef', 'base', 'win', 'alive', 'setState', 'EMBED_PARKED', 'EMBED_IDLE', 'EMBED_WAITING', 'hosted', 'host']
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
  const m = layerRaw.match(/export function orphanTick \(entries, claimsChanged, yielding\) \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('orphanTick not found')
  return new Function('entries', 'claimsChanged', 'yielding', m[1]) // eslint-disable-line no-new-func
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
  const unmount = (c) => liftCleanup()(c.alive, c.stateRef, live.EMBED_WAITING, live.EMBED_IDLE, spied, c.hosted, c.release, host, playbackClaimCount, c.claims)()
  // real: the card's own apply() instead of a recorder.
  const mount = (real = false) => {
    const first = liftInitial()(key, host, live.EMBED_PARKED, live.EMBED_IDLE)
    const c = {
      stateRef: { current: first },
      release: { current: null },
      hosted: { current: '' },
      claims: { current: playback.count },
      alive: { current: true },
      applied: [],
      shown: []
    }
    const setState = (s) => c.shown.push(s)
    const apply = real
      ? makeApply(spied, c.release, c.stateRef, { current: false }, { width: 390, height: 844 }, c.alive, setState, live.EMBED_PARKED, live.EMBED_IDLE, live.EMBED_WAITING, c.hosted, host)
      : null
    const record = (s) => { c.applied.push(s); if (apply) apply(s) }
    liftMount()(key, host, c.release, c.hosted, c.stateRef, setState, record, live.EMBED_PARKED, live.EMBED_IDLE, playbackClaimCount, c.claims)
    return c
  }
  return { live, slots: spied, keep, key, spec, goLive, unmount, mount, makeApply, host, playback, acquired: () => acquired }
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
  t.ok(list.includes("import { EmbedRow, keptRowKeys, renderScroll, rowKeyOf, useEmbedHost } from './EmbedLayer'"))
  t.ok(list.includes('const host = useEmbedHost()'))
  t.ok(list.includes('<EmbedHost.Provider value={host}>'))
  t.ok(list.includes('<EmbedRow row={rowKeyOf(keyOf.current, info.item, info.index)}>{renderItem(info)}</EmbedRow>'), 'each row registers with the host')
  t.ok(/if \(!host\.keep\.hasOrphan\(\)\) return\s*const kept = keptRowKeys\(data, keyOf\.current\)\s*host\.keep\.prune\(\(row\) => kept\.has\(row\)\)\s*\}, \[data\]\)/.test(list), 'rows that left the data, or became a tombstone, drop their kept frame')
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
  t.ok(layer.includes('<Animated.View key={entry.key} collapsable={false} pointerEvents={parked ? \'none\' : \'auto\'} style={framePlace(entry)}>'), 'keyed by entry, and a parked frame takes no touch')
  t.ok(layer.includes("{ position: 'absolute', left: 0, top: 0, width: spec.width, height: spec.height, opacity: 0 }"), 'a parked frame keeps its size')
  t.ok(layer.includes('const parked = rect === null'))
  t.absent(/display:\s*'none'/.test(layer), 'never display none')
  t.ok(layer.includes('const onGone = useCallback(() => keep.drop(id), [keep, id])'), 'a dead process drops its entry')
  t.ok(layer.includes('memo(function KeptFrame'))
  t.ok(/setInterval\(tick, EMBED_TICK_MS\)/.test(layer))
  t.ok(/if \(!visible \|\| embedsHeld\(depth\)\) host\.keep\.dropAll\(\)/.test(layer), 'leaving the screen or a hold drops every kept frame')
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
  const { live, slots, keep, key, spec, makeApply, host } = await setup()
  const real = slots.acquire()
  let calls = 0
  const release = () => { calls++; real() }
  const other = slots.acquire()
  t.is(typeof other, 'function')
  keep.show(key, spec, release, 'row-1')
  const c = { stateRef: { current: live.EMBED_LIVE }, release: { current: release }, hosted: { current: key }, alive: { current: true } }
  const apply = makeApply(slots, c.release, c.stateRef, { current: false }, { width: 390, height: 844 }, c.alive, () => {}, live.EMBED_PARKED, live.EMBED_IDLE, live.EMBED_WAITING, c.hosted, host)
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

test('a card unmounted after another player started drops its frame', async (t) => {
  const { slots, keep, key, goLive, unmount, playback } = await setup()
  const c = goLive()
  playback.count = 1
  unmount(c)
  t.absent(keep.has(key), 'no orphan to miss the new player')
  t.absent(keep.hasOrphan())
  t.is(slots.count(), 0, 'its slot is free')
})

test('a card that takes a frame back after another player started closes it', async (t) => {
  const { live, slots, keep, key, goLive, unmount, mount, playback } = await setup()
  unmount(goLive())
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
  t.ok(/host\.keep\.prune\(\(row\) => kept\.has\(row\)\)\s*\}, \[data\]\)/.test(list), 'the prune depends on data only')
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
  t.ok(/if \(!visible \|\| embedsHeld\(depth\)\) host\.keep\.dropAll\(\)/.test(leaf))
})

test('the host ticks rows and keeps the playback count it saw', (t) => {
  t.ok(layer.includes('const next = orphanRowTick(keep.list(), (row) => rows.has(row), grace)'), 'the tick drops orphans of mounted rows')
  t.ok(layer.includes('claimsSeen: () => (seen === null ? playbackClaimCount() : seen)'))
  t.ok(layer.includes('useEffect(() => (host && row ? host.rowMounted(row) : undefined), [host, row])'), 'EmbedRow registers its row')
  t.ok(layer.includes('<EmbedRowKey.Provider value={row}>{children}</EmbedRowKey.Provider>'))
})

test('a parked frame opens nothing', (t) => {
  t.ok(layer.includes('onOpen={parked ? undefined : spec.onOpen}'))
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
  const placed = framePlace({ rect, spec })
  t.alike(placed, { position: 'absolute', left: 4, top: 900, width: 280, height: 152 })
  t.absent(placed.transform)
  const shift = { animated: true }
  const moved = framePlace({ rect, spec: { ...spec, shift } })
  t.is(moved.transform[0].translateX, shift, 'the same Animated value as the row')
  t.is(moved.top, 900)
  t.absent(framePlace({ rect: null, spec: { ...spec, shift } }).transform, 'parked ignores the shift')
})

test('every kept frame wrapper is an Animated.View, so a shift never remounts it', (t) => {
  t.ok(/<Animated\.View key=\{entry\.key\}[^>]*style=\{framePlace\(entry\)\}/.test(layer))
  t.absent(layer.includes('<View key={entry.key}'))
})
