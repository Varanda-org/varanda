/* global document */

// The photos of a post under its text (1 to 4, gridLayout in
// ../media/plan.js): one keeps its aspect ratio (clamped 0.5..2), two side
// by side, three as one big and two stacked, four as 2x2; rounded corners.
// Each tile is a MediaView; a tap opens the full-screen viewer, which fits the
// photo, moves between items with swipes, the arrow buttons or the keyboard
// arrows (web, only while open), closes with its button or Escape, and labels
// each photo 'foto N de M'. Descriptors are passed through untouched:
// MediaView validates them before any request. persist (default true) goes to
// every tile and the viewer: false for authors the device does not follow.

import { useEffect, useRef, useState } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MAX_MEDIA_PER_POST, gridLayout } from '../media/plan'
import { Icon } from './Icon'
import { MediaView } from './MediaView'

const GAP = 2
const SWIPE_PX = 50

function ratioOf (d) {
  const r = d && d.width > 0 && d.height > 0 ? d.width / d.height : 1
  return Number.isFinite(r) ? Math.max(0.5, Math.min(2, r)) : 1
}

function Viewer ({ author, media, index, onIndex, onClose, persist }) {
  const insets = useSafeAreaInsets()
  const open = index !== null
  const count = media.length
  const touch = useRef(null)
  const go = (delta) => {
    if (index === null) return
    const next = index + delta
    if (next >= 0 && next < count) onIndex(next)
  }
  const goRef = useRef(go)
  goRef.current = go
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open || Platform.OS !== 'web' || typeof document === 'undefined') return
    const onKey = (event) => {
      if (event.key === 'ArrowLeft') goRef.current(-1)
      else if (event.key === 'ArrowRight') goRef.current(1)
      else if (event.key === 'Escape') {
        // Handled here: the app's own Escape (closing a pushed screen) must
        // not also run.
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  const label = 'foto ' + (index + 1) + ' de ' + count
  return (
    <Modal visible animationType='fade' transparent={false} statusBarTranslucent onRequestClose={onClose}>
      <View style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
        <View style={styles.viewerTop}>
          <Pressable accessibilityRole='button' accessibilityLabel='fechar' onPress={onClose} hitSlop={10} style={styles.viewerBtn}>
            <Icon name='x' size={26} color='#ffffff' />
          </Pressable>
          {count > 1 ? <Text style={styles.viewerCount}>{(index + 1) + ' de ' + count}</Text> : null}
          <View style={styles.viewerBtn} />
        </View>
        <View
          style={styles.viewerBody}
          onTouchStart={(e) => {
            const t = e.nativeEvent.touches && e.nativeEvent.touches[0]
            touch.current = t ? t.pageX : null
          }}
          onTouchEnd={(e) => {
            const t = e.nativeEvent.changedTouches && e.nativeEvent.changedTouches[0]
            if (touch.current === null || !t) return
            const dx = t.pageX - touch.current
            touch.current = null
            if (dx <= -SWIPE_PX) go(1)
            else if (dx >= SWIPE_PX) go(-1)
          }}
        >
          <MediaView
            key={index}
            author={author}
            descriptor={media[index]}
            label={label}
            fit='contain'
            dark
            persist={persist}
            style={styles.viewerImage}
          />
          {index > 0
            ? (
              <Pressable accessibilityRole='button' accessibilityLabel='foto anterior' onPress={() => go(-1)} style={[styles.arrow, styles.arrowLeft]}>
                <Icon name='chevron-left' size={30} color='#ffffff' />
              </Pressable>
              )
            : null}
          {index < count - 1
            ? (
              <Pressable accessibilityRole='button' accessibilityLabel='próxima foto' onPress={() => go(1)} style={[styles.arrow, styles.arrowRight]}>
                <Icon name='chevron-right' size={30} color='#ffffff' />
              </Pressable>
              )
            : null}
        </View>
      </View>
    </Modal>
  )
}

export function MediaGrid ({ author, media, persist = true }) {
  const [viewing, setViewing] = useState(null)
  if (!Array.isArray(media) || media.length === 0) return null
  const items = media.slice(0, MAX_MEDIA_PER_POST)
  const layout = gridLayout(items.length)
  const n = items.length
  const tile = (i, style) => (
    <MediaView
      key={i}
      author={author}
      descriptor={items[i]}
      persist={persist}
      label={'foto ' + (i + 1) + ' de ' + n}
      style={[styles.cell, style]}
      onPress={() => setViewing(i)}
    />
  )
  let body
  if (layout === 'one') {
    body = tile(0, { width: '100%', aspectRatio: ratioOf(items[0]) })
  } else if (layout === 'two') {
    body = <View style={[styles.box, styles.row]}>{tile(0, styles.flex)}{tile(1, styles.flex)}</View>
  } else if (layout === 'three') {
    body = (
      <View style={[styles.box, styles.row]}>
        {tile(0, styles.flex)}
        <View style={[styles.flex, styles.column]}>{tile(1, styles.flex)}{tile(2, styles.flex)}</View>
      </View>
    )
  } else {
    body = (
      <View style={[styles.box, styles.column]}>
        <View style={[styles.flex, styles.row]}>{tile(0, styles.flex)}{tile(1, styles.flex)}</View>
        <View style={[styles.flex, styles.row]}>{tile(2, styles.flex)}{tile(3, styles.flex)}</View>
      </View>
    )
  }
  return (
    <View style={styles.grid}>
      {body}
      <Viewer author={author} media={items} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} persist={persist} />
    </View>
  )
}

const styles = StyleSheet.create({
  grid: { marginTop: 8, borderRadius: 14, overflow: 'hidden' },
  box: { width: '100%', aspectRatio: 16 / 9, gap: GAP },
  row: { flexDirection: 'row', gap: GAP },
  column: { flexDirection: 'column', gap: GAP },
  flex: { flex: 1 },
  cell: { position: 'relative' },
  viewer: { flex: 1, backgroundColor: '#000000' },
  viewerTop: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 },
  viewerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  viewerCount: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  viewerBody: { flex: 1, justifyContent: 'center' },
  viewerImage: { flex: 1 },
  arrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -24,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)'
  },
  arrowLeft: { left: 12 },
  arrowRight: { right: 12 }
})
