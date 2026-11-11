/* global document */

// The photos of a post under its text (1 to 4, gridLayout in
// ../media/plan.js). One keeps its aspect ratio (clamped 0.5..2). Two to four
// are a swipeable MediaCarousel with dots and a counter, so each photo gets
// the full width instead of a thumbnail; quote cards pass mosaic to keep the
// compact grid (two side by side, one big and two stacked, 2x2), which has no
// room for dots. A tap opens the full-screen viewer, which fits the photo,
// moves with the same carousel, the arrow buttons or the keyboard arrows (web,
// only while open), closes with its button or Escape, and labels each photo
// 'foto N de M'. Closing leaves the feed on the last photo seen. Descriptors
// are passed through untouched: MediaView validates them before any request.
// persist (default true) goes to every tile and the viewer: false for authors
// the device does not follow. The rounded clip sits on the photo frame, not
// the outer view, so the dots row below it is never cut.

import { useEffect, useRef, useState } from 'react'
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useEscapeLayer } from './escapeLayer'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MAX_MEDIA_PER_POST, gridLayout } from '../media/plan'
import { Icon } from './Icon'
import { MediaCarousel } from './MediaCarousel'
import { MediaView } from './MediaView'
import { counterText, frameRatio, slideLabel } from '../carousel'

const GAP = 2

const stopClick = (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation() }

function ratioOf (d) {
  const r = d && d.width > 0 && d.height > 0 ? d.width / d.height : 1
  return Number.isFinite(r) ? Math.max(0.5, Math.min(2, r)) : 1
}

function Viewer ({ author, media, index, onIndex, onClose, persist }) {
  const insets = useSafeAreaInsets()
  const open = index !== null
  const count = media.length
  const go = (delta) => {
    if (index === null) return
    const next = index + delta
    if (next >= 0 && next < count) onIndex(next)
  }
  const goRef = useRef(go)
  goRef.current = go
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // Escape closes only the viewer, even over a sheet (src/ui/escapeLayer.js).
  useEscapeLayer(!!open, () => closeRef.current(), 'viewer')
  useEffect(() => {
    if (!open || Platform.OS !== 'web' || typeof document === 'undefined') return
    const onKey = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      // Left alone, the browser also scrolls the feed carousel under the
      // viewer, the last strip that was clicked.
      event.preventDefault()
      goRef.current(event.key === 'ArrowLeft' ? -1 : 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <Modal visible animationType='fade' transparent={false} statusBarTranslucent onRequestClose={onClose}>
      <View
        onClick={stopClick}
        onStartShouldSetResponder={() => true}
        style={[styles.viewer, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}
      >
        <View style={styles.viewerTop}>
          <Pressable accessibilityRole='button' accessibilityLabel='fechar' onPress={onClose} hitSlop={10} style={styles.viewerBtn}>
            <Icon name='x' size={26} color='#ffffff' />
          </Pressable>
          {count > 1 ? <Text style={styles.viewerCount}>{counterText(index, count)}</Text> : null}
          <View style={styles.viewerBtn} />
        </View>
        <View style={styles.viewerBody}>
          <MediaCarousel
            author={author}
            media={media}
            persist={persist}
            index={index}
            onIndex={onIndex}
            fit='contain'
            dark
            showDots
            showCounter={false}
            showArrows={false}
            claimTouch
            frameStyle={styles.viewerFrame}
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

export function MediaGrid ({ author, media, persist = true, mosaic = false }) {
  const [viewing, setViewing] = useState(null)
  const [feedIndex, setFeedIndex] = useState(0)
  const [focusTick, setFocusTick] = useState(0)
  const lastViewed = useRef(null)
  // The feed moves to the last photo seen only once the viewer is gone: on
  // the web the closing modal hands focus back to the photo that opened it,
  // and that focus cancels a scroll already under way. The carousel then
  // moves that focus to the photo on screen (focusRequest).
  useEffect(() => {
    if (viewing !== null || lastViewed.current === null) return
    setFeedIndex(lastViewed.current)
    setFocusTick((n) => n + 1)
    lastViewed.current = null
  }, [viewing])
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
      label={slideLabel(i, n)}
      style={[styles.cell, style]}
      onPress={() => setViewing(i)}
    />
  )
  const closeViewer = () => {
    lastViewed.current = viewing
    setViewing(null)
  }
  let body
  if (layout === 'one') {
    body = tile(0, [styles.clip, { width: '100%', aspectRatio: ratioOf(items[0]) }])
  } else if (!mosaic) {
    body = (
      <MediaCarousel
        author={author}
        media={items}
        persist={persist}
        index={feedIndex}
        onIndex={setFeedIndex}
        fit='cover'
        showDots
        showCounter
        showArrows
        onPressItem={(i) => setViewing(i)}
        focusRequest={focusTick}
        frameStyle={[styles.carouselFrame, { aspectRatio: frameRatio(items) }]}
      />
    )
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
      <Viewer
        author={author}
        media={items}
        index={viewing}
        onIndex={setViewing}
        onClose={closeViewer}
        persist={persist}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  grid: { marginTop: 8 },
  clip: { borderRadius: 14, overflow: 'hidden' },
  carouselFrame: { width: '100%', borderRadius: 14, overflow: 'hidden' },
  box: { width: '100%', aspectRatio: 16 / 9, gap: GAP, borderRadius: 14, overflow: 'hidden' },
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
  viewerFrame: { flex: 1 },
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
