// The layer a list draws its loaded provider players in. FlatList unmounts a
// row a few screens away and offers no way to keep one mounted, so a player
// drawn inside its row would be lost, and a fresh load would start when the
// person scrolls back. The list's own scroll content holds one layer, after
// the rows: it scrolls with them natively, and a frame in it outlives its
// row. A card keeps an empty slot of the player's size and tells the layer
// where that slot is (../embedKeep place); while its row is gone the frame
// stays loaded, hidden and out of the screen reader, until the row comes back
// and its card takes the same frame again.
//
// A kept frame stays transparent, out of touches and out of the screen reader
// until the provider page has loaded (../embedKeep ready), so the card under
// it shows, and takes the tap and the screen reader, meanwhile.
//
// When the list's screen stops being the one looked at, or a sheet or a menu
// holds the players, a frame the person touched closes, since it may be
// playing, and an untouched one stays loaded (../embedLive embedStays); a
// running or unknown screen reader counts as a touch. A lock or the
// background closes every kept frame. An orphan the person touched also
// closes when another player starts in the app. A kept frame closes when a
// newly visible card needs its slot (../embedLive), when its row leaves the
// list's data (an untouched one cut off past the end waits EMBED_CUT_MS for
// it to come back) or its message is hidden or deleted, and when its content
// process dies, which also lowers the app-wide cap (../embedLive shrink).

import { forwardRef, memo, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Animated, ScrollView, StyleSheet, View } from 'react-native'
import { createEmbedKeep } from '../embedKeep'
import { EMBED_TICK_MS, embedSlots, embedStays, embedTouched, embedsHeld, embedsHeldAll, onEmbedHold } from '../embedLive'
import { playbackClaimCount } from '../media/chatMedia'
import { EmbedFrame } from './EmbedFrame'
import { useReveal } from './useReveal'
import { screenReaderKnown, screenReaderOn } from './screenReader'
import { EmbedHost, EmbedRowKey, ScreenVisible, SheetDepth } from './screenVisible'

const ORIGIN = Object.freeze({ x: 0, y: 0 })

// The keys of the frames one tick of the host closes. A card whose row is gone
// has no check of its own, so the host yields for it: an orphan the person
// touched goes when another player started since the last tick, since it may
// be playing, and an orphan asked to give its slot to a newly visible card
// goes at once, since nobody can see it. engaged(release) tells a touched
// frame; a missing or throwing one counts as touched.
export function orphanTick (entries, claimsChanged, yielding, engaged) {
  const keys = []
  if (!Array.isArray(entries)) return keys
  for (const entry of entries) {
    if (!entry || entry.orphan !== true) continue
    let drop = false
    if (claimsChanged === true) {
      drop = true
      try { drop = typeof engaged !== 'function' || engaged(entry.release) !== false } catch {}
    }
    if (!drop) {
      try { drop = typeof yielding === 'function' && yielding(entry.release) === true } catch {}
    }
    if (drop) keys.push(entry.key)
  }
  return keys
}

// Read at the moment of each decision: the reader can be turned on, and the
// frame touched, at any time after it loaded.
export function touchedNow (release) {
  return embedTouched(embedSlots.engaged(release), screenReaderOn(), screenReaderKnown())
}

// What the slot pool is told when an orphan is asked to yield: while a screen
// reader runs, or has not answered yet, every frame counts as touched.
function readerTouchNow () {
  return embedTouched(false, screenReaderOn(), screenReaderKnown())
}

// The keys of the kept frames to close while the screen is not shown (another
// screen, a sheet, a menu or a lock holds the players). A touched frame may be
// playing with nobody looking; an untouched one stays loaded, unless the
// device is locked or in the background. A missing or throwing touched counts
// as touched.
export function heldDrops (entries, shown, locked, touched) {
  const keys = []
  if (!Array.isArray(entries) || (shown === true && locked === false)) return keys
  for (const entry of entries) {
    if (!entry) continue
    let on = true
    try { on = typeof touched !== 'function' || touched(entry.release) !== false } catch {}
    if (!embedStays(on, locked)) keys.push(entry.key)
  }
  return keys
}

// How many ticks in a row an orphan may wait while its row is mounted. A
// card that leaves a row that stays (a deleted message drawn as a notice, a
// quote whose post went missing) has no row to come back to, but a quote
// that shows "loading" for a moment unmounts its card and mounts it again in
// the same row: the grace, about a second, lets that card take its frame back.
export const EMBED_ROW_GRACE_TICKS = 2

// The orphans whose row stays mounted and that have used up the grace, and
// the counts for the next tick. An orphan whose row is not mounted, or that
// a card claimed, starts again from zero.
export function orphanRowTick (entries, mounted, counts) {
  const drop = []
  const next = new Map()
  if (!Array.isArray(entries)) return { drop, counts: next }
  for (const entry of entries) {
    if (!entry || entry.orphan !== true) continue
    let here = false
    try { here = typeof mounted === 'function' && mounted(entry.row) === true } catch {}
    if (!here) continue
    const n = (counts instanceof Map && Number.isInteger(counts.get(entry.key)) ? counts.get(entry.key) : 0) + 1
    if (n >= EMBED_ROW_GRACE_TICKS) drop.push(entry.key)
    else next.set(entry.key, n)
  }
  return { drop, counts: next }
}

// '' when the key cannot be read: that row's players are drawn in the row,
// never kept by the list.
export function rowKeyOf (keyExtractor, item, index) {
  if (typeof keyExtractor !== 'function') return ''
  try {
    return String(keyExtractor(item, index))
  } catch {
    return ''
  }
}

// The rows whose kept frame may stay. A hidden or deleted message keeps its
// row as a notice with no card (the rule of ./Bubble.js), so a frame kept for
// it would stay loaded, and in contact with the provider, with nothing to
// show it in.
export function keptRowKeys (data, keyExtractor) {
  const rows = new Set()
  if (!Array.isArray(data)) return rows
  data.forEach((item, index) => {
    if (item && typeof item === 'object' && (item.hidden === true || item.deleted === true)) return
    rows.add(rowKeyOf(keyExtractor, item, index))
  })
  return rows
}

// How long an untouched orphan whose row was cut off past the end of the
// data waits for the row to come back: a list that reads its first page
// again (a tab coming back, a refresh) drops the older rows for a moment.
export const EMBED_CUT_MS = 5000

// The rows of data, the last row, and the row each one came after (null for
// the first). A row that left the data keeps the one it last came after only
// while one of the `keep` rows (the orphans) walks back through it, so a
// later change can still tell where that orphan was and nothing else piles up.
export function rowOrder (data, keyExtractor, order, keep) {
  const prior = order && order.before instanceof Map ? order.before : new Map()
  const rows = Array.isArray(data) ? data.map((item, index) => rowKeyOf(keyExtractor, item, index)) : []
  const before = new Map()
  rows.forEach((row, i) => before.set(row, i > 0 ? rows[i - 1] : null))
  for (const start of Array.isArray(keep) ? keep : []) {
    let at = start
    while (typeof at === 'string' && !before.has(at) && prior.has(at)) {
      before.set(at, prior.get(at))
      at = prior.get(at)
    }
  }
  return { before, present: new Set(rows), last: rows.length > 0 ? rows[rows.length - 1] : null }
}

// Whether a row missing from the data was only cut off past its end: the
// data is empty, or the nearest row still present before it is the last
// one. Otherwise the list goes on past where it was, or was replaced, so the
// row was taken out for good.
export function cutOff (row, order) {
  if (!order || !(order.present instanceof Set) || !(order.before instanceof Map)) return false
  if (order.present.size === 0) return true
  const seen = new Set()
  let at = row
  while (!seen.has(at)) {
    seen.add(at)
    const prev = order.before.get(at)
    if (typeof prev !== 'string') return false
    if (order.present.has(prev)) return prev === order.last
    at = prev
  }
  return false
}

// The orphans to drop at now, the deadline of each row cut off past the end
// (kept from the change that first found it missing), and the wait until the
// earliest one, or null. A tombstone, a touched orphan (it may be playing; a
// missing or throwing touched counts as touched) and a row taken out drop
// now; a row back in the data loses its deadline.
export function orphanCuts (entries, kept, order, deadlines, now, touched) {
  const drop = []
  const next = new Map()
  let wait = null
  if (!Array.isArray(entries)) return { drop, deadlines: next, wait }
  for (const entry of entries) {
    if (!entry || entry.orphan !== true) continue
    const row = entry.row
    if (kept instanceof Set && kept.has(row)) continue
    let gone = !!order && order.present instanceof Set && order.present.has(row)
    if (!gone) {
      let on = true
      try { on = typeof touched !== 'function' || touched(entry.release) !== false } catch {}
      gone = on || !cutOff(row, order)
    }
    const at = deadlines instanceof Map && Number.isFinite(deadlines.get(row)) ? deadlines.get(row) : now + EMBED_CUT_MS
    if (gone || !(now < at)) {
      drop.push(entry.key)
      continue
    }
    next.set(row, at)
    if (wait === null || at - now < wait) wait = at - now
  }
  return { drop, deadlines: next, wait }
}

function createEmbedHost () {
  const keep = createEmbedKeep()
  const listeners = new Set()
  // Mounted rows, counted: a row mounted twice for a moment must not count
  // as gone when one of the two unmounts.
  const rows = new Map()
  let content = null
  let origin = ORIGIN
  let timer = null
  // The playback count the orphans were last checked against. Kept after the
  // ticker stops: the claim that ends the last orphan stops it, and the card
  // that claimed asks for this count right after.
  let seen = null
  let grace = new Map()
  const contentChanged = () => {
    for (const fn of [...listeners]) {
      try { fn() } catch {}
    }
  }
  const tick = () => {
    const count = playbackClaimCount()
    const changed = count !== seen
    seen = count
    // An orphan has no check of its own, so its last parked distance stands.
    const yielding = (release) => embedSlots.yielding(release, undefined, readerTouchNow())
    for (const key of orphanTick(keep.list(), changed, yielding, touchedNow)) keep.drop(key)
    const next = orphanRowTick(keep.list(), (row) => rows.has(row), grace)
    grace = next.counts
    for (const key of next.drop) keep.drop(key)
  }
  const sync = () => {
    if (keep.hasOrphan()) {
      if (timer !== null) return
      // Counted from when the first orphan appears: a card checks for a new
      // player when it unmounts, so one that started before was seen.
      seen = playbackClaimCount()
      grace = new Map()
      timer = setInterval(tick, EMBED_TICK_MS)
    } else if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  return Object.freeze({
    keep,
    setContent: (node) => {
      const next = node || null
      if (next === content) return
      content = next
      contentChanged()
    },
    content: () => content,
    onLayerLayout: (e) => {
      const layout = e && e.nativeEvent ? e.nativeEvent.layout : null
      const x = layout && Number.isFinite(layout.x) ? layout.x : 0
      const y = layout && Number.isFinite(layout.y) ? layout.y : 0
      if (x === origin.x && y === origin.y) return
      origin = Object.freeze({ x, y })
      contentChanged()
    },
    origin: () => origin,
    onContentChange: (fn) => {
      if (typeof fn !== 'function') return () => {}
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    contentChanged,
    rowMounted: (row) => {
      if (typeof row !== 'string' || !row) return () => {}
      rows.set(row, (rows.get(row) || 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        const n = (rows.get(row) || 0) - 1
        if (n > 0) rows.set(row, n)
        else rows.delete(row)
      }
    },
    claimsSeen: () => (seen === null ? playbackClaimCount() : seen),
    start: () => {
      const off = keep.subscribe(sync)
      sync()
      return () => {
        off()
        if (timer !== null) clearInterval(timer)
        timer = null
        keep.dispose()
      }
    }
  })
}

// One per list. The returned object never changes, so the cards and the
// layer may keep it in effects and memo props. It reads no context: the
// list would render again, with all its rows, on every tab switch and sheet.
export function useEmbedHost () {
  const [host] = useState(createEmbedHost)
  useEffect(() => host.start(), [host])
  return host
}

// Gives a row's cards its key and tells the host the row is mounted, so an
// orphan of a row that stays is found (orphanRowTick).
export function EmbedRow ({ row, children }) {
  const host = useContext(EmbedHost)
  useEffect(() => (host && row ? host.rowMounted(row) : undefined), [host, row])
  return <EmbedRowKey.Provider value={row}>{children}</EmbedRowKey.Provider>
}

// Whether a kept frame may hand a link to the system browser: only one on the
// screen, loaded, with the screen shown and no sheet, menu or lock holding
// the players. An open asked for by a frame nobody can see is not the
// person's.
export function frameOpens (parked, shown, held) {
  return parked === false && shown === true && held === false
}

const KeptFrame = memo(function KeptFrame ({ spec, parked, opens, keep, id, release }) {
  // The system reclaimed a content process: fewer frames load from then on.
  // shrink steps once per window, however many frames go at once.
  const onGone = useCallback(() => {
    embedSlots.shrink(Date.now())
    keep.drop(id)
  }, [keep, id])
  const onReady = useCallback(() => keep.ready(id), [keep, id])
  const onEngage = useCallback((on) => embedSlots.engage(release, on, playbackClaimCount()), [release])
  return (
    <EmbedFrame
      embedUrl={spec.embedUrl}
      html={spec.html}
      baseUrl={spec.baseUrl}
      allowTop={spec.allowTop}
      height={spec.height}
      title={spec.title}
      onOpen={opens ? spec.onOpen : undefined}
      parked={parked}
      onGone={onGone}
      onReady={onReady}
      onEngage={onEngage}
    />
  )
})

// A frame is never unmounted, re-keyed, sized to 0 or taken out of the layout
// while its entry is kept: any of those would reload the provider page. One
// whose card is not placed, or whose provider page has not loaded yet, just
// turns transparent and stops taking touches.
export function EmbedLayer () {
  const host = useContext(EmbedHost)
  if (!host) return null
  return <Layer host={host} />
}

// Where a kept frame is drawn. A placed frame follows its row's shift (a
// swipe to reply), which its card's slot does not report: layout measures
// ignore transforms. A parked frame is out of sight and stays put. A placed
// frame whose provider page has not loaded yet already sits on its slot, so
// showing it later moves nothing, but is transparent over the card.
export function framePlace (entry) {
  const { rect, spec } = entry
  if (rect === null) return { position: 'absolute', left: 0, top: 0, width: spec.width, height: spec.height, opacity: 0 }
  const place = { position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h }
  if (entry.ready !== true) place.opacity = 0
  if (spec.shift !== null && typeof spec.shift === 'object') place.transform = [{ translateX: spec.shift }]
  return place
}

// The fade is keyed on ready alone, never on the rect: orphan() sets rect null
// each time a row unmounts, and a loaded player returns with its row without
// fading a second time.
function Kept ({ entry, keep, visible, held }) {
  const { rect, spec } = entry
  const parked = rect === null || entry.ready !== true
  const { opacity, settled } = useReveal(entry.ready === true)
  const fading = !parked && !settled
  return (
    <Animated.View collapsable={false} pointerEvents={parked ? 'none' : 'auto'} style={fading ? [framePlace(entry), { opacity }] : framePlace(entry)}>
      <KeptFrame spec={spec} parked={parked} opens={frameOpens(parked, visible, held)} keep={keep} id={entry.key} release={entry.release} />
    </Animated.View>
  )
}

// The leaf reads the screen and the sheet, not the list, so a tab switch
// renders the layer alone.
function Layer ({ host }) {
  const { keep, onLayerLayout } = host
  const visible = useContext(ScreenVisible)
  const depth = useContext(SheetDepth)
  useEffect(() => {
    const sync = () => {
      const locked = embedsHeldAll()
      for (const key of heldDrops(host.keep.list(), visible && !embedsHeld(depth), locked, touchedNow)) host.keep.drop(key)
    }
    sync()
    return onEmbedHold(sync)
  }, [host, visible, depth])
  const held = useSyncExternalStore(onEmbedHold, () => embedsHeld(depth), () => embedsHeld(depth))
  const entries = useSyncExternalStore(keep.subscribe, keep.list, keep.list)
  return (
    <View collapsable={false} pointerEvents='box-none' onLayout={onLayerLayout} style={[StyleSheet.absoluteFill, styles.layer]}>
      {entries.map((entry) => (
        <Kept key={entry.key} entry={entry} keep={keep} visible={visible} held={held} />
      ))}
    </View>
  )
}

// VirtualizedList clones this element with its cells as children and its own
// ref, and calls scrollToOffset and the rest on that ref, so the ref reaches
// the ScrollView unchanged. The caller's props (refreshControl included) pass
// through as with the default scroll component.
export const EmbedScroll = forwardRef(function EmbedScroll (props, ref) {
  const host = useContext(EmbedHost)
  const own = useRef(null)
  const merged = useCallback((node) => {
    own.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }, [ref])
  useEffect(() => {
    if (!host) return undefined
    const scroll = own.current
    // The content container is the ancestor of the rows and the layer alike:
    // a card measures its slot against it, since the new architecture only
    // measures a view against one of its ancestors.
    const inner = scroll && typeof scroll.getInnerViewRef === 'function' ? scroll.getInnerViewRef() : null
    host.setContent(inner)
    return () => host.setContent(null)
  }, [host])
  return (
    <ScrollView {...props} ref={merged}>
      {props.children}
      <EmbedLayer />
    </ScrollView>
  )
})

export function renderScroll (p) {
  return <EmbedScroll {...p} />
}

const styles = StyleSheet.create({
  layer: { overflow: 'hidden' }
})
