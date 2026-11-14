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
// A kept frame closes when the list's screen stops being the one looked at or
// a sheet, a menu or a lock holds the players, when another player starts in
// the app, when a newly visible card needs its slot (two at most app-wide,
// ../embedLive), when its row leaves the list's data or its message is hidden
// or deleted, and when its content process dies.

import { forwardRef, memo, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Animated, ScrollView, StyleSheet, View } from 'react-native'
import { createEmbedKeep } from '../embedKeep'
import { EMBED_TICK_MS, embedSlots, embedsHeld, onEmbedHold } from '../embedLive'
import { playbackClaimCount } from '../media/chatMedia'
import { EmbedFrame } from './EmbedFrame'
import { EmbedHost, EmbedRowKey, ScreenVisible, SheetDepth } from './screenVisible'

const ORIGIN = Object.freeze({ x: 0, y: 0 })

// The keys of the frames one tick of the host closes. A card whose row is gone
// has no check of its own, so the host yields for it: every orphan goes when
// another player started since the last tick, and an orphan asked to give its
// slot to a newly visible card goes at once, since nobody can see it.
export function orphanTick (entries, claimsChanged, yielding) {
  const keys = []
  if (!Array.isArray(entries)) return keys
  for (const entry of entries) {
    if (!entry || entry.orphan !== true) continue
    let drop = claimsChanged === true
    if (!drop) {
      try { drop = typeof yielding === 'function' && yielding(entry.release) === true } catch {}
    }
    if (drop) keys.push(entry.key)
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
    for (const key of orphanTick(keep.list(), changed, embedSlots.yielding)) keep.drop(key)
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

const KeptFrame = memo(function KeptFrame ({ spec, parked, keep, id }) {
  const onGone = useCallback(() => keep.drop(id), [keep, id])
  return (
    <EmbedFrame
      embedUrl={spec.embedUrl}
      html={spec.html}
      baseUrl={spec.baseUrl}
      allowTop={spec.allowTop}
      height={spec.height}
      title={spec.title}
      // A parked frame has no card on the screen: an open it asks for is
      // not the person's.
      onOpen={parked ? undefined : spec.onOpen}
      parked={parked}
      onGone={onGone}
    />
  )
})

// A frame is never unmounted, re-keyed, sized to 0 or taken out of the layout
// while its entry is kept: any of those would reload the provider page. One
// whose card is not placed just turns transparent and stops taking touches.
export function EmbedLayer () {
  const host = useContext(EmbedHost)
  if (!host) return null
  return <Layer host={host} />
}

// Where a kept frame is drawn. A placed frame follows its row's shift (a
// swipe to reply), which its card's slot does not report: layout measures
// ignore transforms. A parked frame is out of sight and stays put.
export function framePlace (entry) {
  const { rect, spec } = entry
  if (rect === null) return { position: 'absolute', left: 0, top: 0, width: spec.width, height: spec.height, opacity: 0 }
  const place = { position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h }
  if (spec.shift !== null && typeof spec.shift === 'object') place.transform = [{ translateX: spec.shift }]
  return place
}

// The leaf reads the screen and the sheet, not the list, so a tab switch
// renders the layer alone.
function Layer ({ host }) {
  const { keep, onLayerLayout } = host
  const visible = useContext(ScreenVisible)
  const depth = useContext(SheetDepth)
  useEffect(() => {
    const sync = () => {
      if (!visible || embedsHeld(depth)) host.keep.dropAll()
    }
    sync()
    return onEmbedHold(sync)
  }, [host, visible, depth])
  const entries = useSyncExternalStore(keep.subscribe, keep.list, keep.list)
  return (
    <View collapsable={false} pointerEvents='box-none' onLayout={onLayerLayout} style={[StyleSheet.absoluteFill, styles.layer]}>
      {entries.map((entry) => {
        const { rect, spec } = entry
        const parked = rect === null
        return (
          <Animated.View key={entry.key} collapsable={false} pointerEvents={parked ? 'none' : 'auto'} style={framePlace(entry)}>
            <KeptFrame spec={spec} parked={parked} keep={keep} id={entry.key} />
          </Animated.View>
        )
      })}
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
