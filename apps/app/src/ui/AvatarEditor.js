// The profile photo crop editor: an inline panel the caller shows in place
// of the form (no Modal), and the caller restores focus when it closes.
// `source` is { uri, width, height } from openImage (avatarEncode.web.js);
// `error` is a ready text (errorText). onConfirm receives cropRect(crop,
// source), so the round viewport and both previews show exactly what is
// exported. Dragging, the buttons and the keyboard (web) all move the same
// crop through ../media/crop.js.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, PanResponder, Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { ZOOM_STEP, cropRect, displayRect, initialCrop, limitsOf, nudge, panBy, zoomBy, zoomPercent } from '../media/crop'
import { ErrorText, Row, Soft } from './index'
import { Pill } from './Pill'
import { colors, type } from './theme'

const WEB = Platform.OS === 'web'
const KEY_MOVES = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

function isInitial (crop) {
  const start = initialCrop()
  return crop.zoom === start.zoom && crop.cx === start.cx && crop.cy === start.cy
}

function Framed ({ source, crop, side, style }) {
  const rect = displayRect(crop, source, side)
  return (
    <View style={[styles.round, { width: side, height: side, borderRadius: side / 2 }, style]} pointerEvents='none'>
      <Image
        source={{ uri: source.uri }}
        style={{ position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        resizeMode='stretch'
      />
    </View>
  )
}

export function AvatarEditor ({ source, pending, error, onCancel, onConfirm }) {
  const { width } = useWindowDimensions()
  const view = Math.max(1, Math.min(280, width - 48))
  const [crop, setCrop] = useState(initialCrop)
  // The responder reads these at gesture time, not at creation time.
  const live = useRef({ crop, view, source, pending })
  live.current = { crop, view, source, pending }
  const dragStart = useRef(null)
  const headerRef = useRef(null)

  useEffect(() => {
    if (!WEB) return
    try { headerRef.current && headerRef.current.focus() } catch {}
  }, [])

  // A new photo starts centred, never with the previous photo's framing.
  const srcUri = source && source.uri
  const srcW = source && source.width
  const srcH = source && source.height
  useEffect(() => {
    dragStart.current = null
    setCrop(initialCrop())
  }, [srcUri, srcW, srcH])

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !live.current.pending,
    onMoveShouldSetPanResponder: () => !live.current.pending,
    onPanResponderGrant: () => { dragStart.current = live.current.crop },
    onPanResponderMove: (_, g) => {
      const { source: src, view: side } = live.current
      if (dragStart.current) setCrop(panBy(dragStart.current, g.dx, g.dy, src, side))
    },
    onPanResponderRelease: () => { dragStart.current = null },
    onPanResponderTerminate: () => { dragStart.current = null }
  }), [])

  const limits = limitsOf(crop, source)
  const off = pending === true
  const move = (dir) => setCrop((c) => nudge(c, dir, source))
  const zoomIn = () => setCrop((c) => zoomBy(c, ZOOM_STEP, source))
  const zoomOut = () => setCrop((c) => zoomBy(c, 1 / ZOOM_STEP, source))
  const reset = () => setCrop(initialCrop())

  // Every handled key is swallowed: arrows would scroll the page, and Escape
  // would reach App.js (keydown, goes back) and the sheet Modal (keyup,
  // closes Ajustes and drops the draft).
  const keyOf = (e) => (e && e.nativeEvent ? e.nativeEvent.key : e && e.key)
  const swallow = (e) => {
    try { e.preventDefault() } catch {}
    try { e.stopPropagation() } catch {}
  }
  const onKeyDown = (e) => {
    const key = keyOf(e)
    let action = null
    // Escape cancels on keyup: cancelling here unmounts the panel, and its
    // keyup would then reach the sheet Modal.
    if (key === 'Escape') action = () => {}
    else if (Object.hasOwn(KEY_MOVES, key)) action = () => move(KEY_MOVES[key])
    else if (key === '+' || key === '=') action = zoomIn
    else if (key === '-') action = zoomOut
    else if (key === '0') action = reset
    if (!action) return
    swallow(e)
    if (!off) action()
  }
  const onKeyUp = (e) => {
    if (keyOf(e) !== 'Escape') return
    swallow(e)
    if (!off && onCancel) onCancel()
  }

  const percent = zoomPercent(crop)
  const webViewport = WEB ? { tabIndex: 0 } : null
  // tabIndex -1: a click on the panel's plain text keeps focus inside it, so
  // the keys stay handled here instead of reaching the page and the sheet.
  const webPanel = WEB ? { onKeyDown, onKeyUp, tabIndex: -1 } : null

  return (
    <View style={styles.panel} {...webPanel}>
      <Text ref={headerRef} style={styles.header} accessibilityRole='header' {...(WEB ? { tabIndex: -1 } : null)}>
        Ajustar foto
      </Text>
      <Soft>Arraste para escolher o enquadramento. Use os botões ou as setas do teclado para mover e aproximar.</Soft>
      <View style={styles.stage}>
        <View
          accessible
          accessibilityLabel='Enquadramento da foto'
          style={[styles.round, styles.viewport, { width: view, height: view, borderRadius: view / 2 }, WEB && styles.webDrag]}
          {...webViewport}
          {...responder.panHandlers}
        >
          <Framed source={source} crop={crop} side={view} />
        </View>
        <View style={styles.previews} aria-hidden accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
          <Framed source={source} crop={crop} side={88} />
          <Framed source={source} crop={crop} side={44} />
        </View>
      </View>
      <Text
        style={styles.zoom}
        accessibilityLiveRegion='polite'
        {...(WEB ? { 'aria-live': 'polite' } : null)}
      >
        {'zoom de ' + percent + '%'}
      </Text>
      <Row>
        <Pill label='Aproximar' onPress={zoomIn} disabled={off || !limits.zoomIn} />
        <Pill label='Afastar' onPress={zoomOut} disabled={off || !limits.zoomOut} />
        <Pill label='Centralizar' onPress={reset} disabled={off || isInitial(crop)} />
      </Row>
      <Row>
        <Pill label='Mover para a esquerda' onPress={() => move('left')} disabled={off || !limits.left} />
        <Pill label='Mover para a direita' onPress={() => move('right')} disabled={off || !limits.right} />
        <Pill label='Mover para cima' onPress={() => move('up')} disabled={off || !limits.up} />
        <Pill label='Mover para baixo' onPress={() => move('down')} disabled={off || !limits.down} />
      </Row>
      <ErrorText>{error}</ErrorText>
      <Row>
        <Pill label='Cancelar' onPress={onCancel} disabled={off} />
        <Pill label='Usar foto' filled pending={off} onPress={() => onConfirm(cropRect(crop, source))} />
      </Row>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { gap: 12 },
  header: { ...type.section, color: colors.ink },
  stage: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 16 },
  round: { overflow: 'hidden', backgroundColor: colors.line },
  viewport: { alignSelf: 'flex-start' },
  webDrag: { touchAction: 'none', cursor: 'grab', userSelect: 'none' },
  previews: { gap: 12, alignItems: 'center' },
  zoom: { fontSize: 14, lineHeight: 20, color: colors.soft }
})
