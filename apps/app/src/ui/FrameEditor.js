// The post framing step: an inline panel (no Modal) where every photo of a
// post gets the same frame (Retrato, Quadrado or Paisagem) and its own crop.
// Follows AvatarEditor.js: dragging, the buttons and the keyboard (web) all
// move the crop of the photo on screen through ../media/crop.js, always with
// the chosen frame's ratio. A fixed photo (a GIF) is never cropped.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, PanResponder, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { ZOOM_STEP, clampCrop, displayRect, initialCrop, limitsOf, nudge, panBy, zoomBy, zoomPercent } from '../media/crop'
import { FRAMES, frameById } from '../media/frame'
import { HELP } from '../help'
import { HelpButton } from './Help'
import { ErrorText, Row, Soft } from './index'
import { Pill } from './Pill'
import { IconAction } from './TopActions'
import { useEscapeLayer } from './escapeLayer'
import { type } from './theme'
import { useStyles } from './ThemeProvider'

// Web only: keyboard handlers, tabIndex and focus exist only in the browser.
const WEB = Platform.OS === 'web'
const KEY_MOVES = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
const NO_LIMITS = { zoomIn: false, zoomOut: false, left: false, right: false, up: false, down: false }

function isInitial (crop) {
  const start = initialCrop()
  return crop.zoom === start.zoom && crop.cx === start.cx && crop.cy === start.cy
}

function ratioFor (id) {
  const frame = frameById(id)
  return frame ? frame.ratio : 1
}

function clampAll (photos, crops, ratio) {
  const out = {}
  for (const photo of photos) {
    out[photo.id] = clampCrop(crops[photo.id] || initialCrop(), photo, ratio)
  }
  return out
}

function startCrops (photos, ratio) {
  const base = {}
  for (const photo of photos) base[photo.id] = photo.crop || initialCrop()
  return clampAll(photos, base, ratio)
}

export function FrameEditor ({ photos, frameId, lockedFrameId, pending, error, onCancel, onApply }) {
  const styles = useStyles(makeStyles)
  const list = Array.isArray(photos) ? photos : []
  const locked = typeof lockedFrameId === 'string' && frameById(lockedFrameId) ? lockedFrameId : null
  const [chosen, setChosen] = useState(() => locked || (frameById(frameId) ? frameId : 'square'))
  const current = locked || chosen
  const ratio = ratioFor(current)
  const [crops, setCrops] = useState(() => startCrops(list, ratio))
  const [index, setIndex] = useState(0)
  const at = Math.min(index, Math.max(0, list.length - 1))
  const photo = list[at] || null
  const crop = (photo && crops[photo.id]) || initialCrop()
  const fixed = !!photo && photo.fixed === true

  const { width: winW, height: winH } = useWindowDimensions()
  let viewW = Math.max(1, Math.min(winW - 32, 420))
  let viewH = viewW / ratio
  const maxH = winH * 0.55
  if (viewH > maxH && maxH > 0) {
    viewH = maxH
    viewW = viewH * ratio
  }

  // The responder reads these at gesture time, not at creation time.
  const live = useRef({ crop, photo, viewW, ratio, pending, fixed })
  live.current = { crop, photo, viewW, ratio, pending, fixed }
  const dragStart = useRef(null)
  const headerRef = useRef(null)

  useEffect(() => {
    if (!WEB) return
    try { headerRef.current && headerRef.current.focus() } catch {}
  }, [])

  const setPhotoCrop = (id, next) => setCrops((all) => ({ ...all, [id]: next }))

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !live.current.pending && !live.current.fixed,
    onMoveShouldSetPanResponder: () => !live.current.pending && !live.current.fixed,
    onPanResponderGrant: () => { dragStart.current = { id: live.current.photo && live.current.photo.id, crop: live.current.crop } },
    onPanResponderMove: (_, g) => {
      const { photo: p, viewW: side, ratio: r } = live.current
      const start = dragStart.current
      if (start && p && start.id === p.id) setPhotoCrop(p.id, panBy(start.crop, g.dx, g.dy, p, side, r))
    },
    onPanResponderRelease: () => { dragStart.current = null },
    onPanResponderTerminate: () => { dragStart.current = null }
  }), [])

  const off = pending === true
  const still = off || fixed || !photo
  const limits = photo && !fixed ? limitsOf(crop, photo, ratio) : NO_LIMITS
  const update = (fn) => {
    if (!photo || fixed) return
    setCrops((all) => ({ ...all, [photo.id]: fn(all[photo.id] || initialCrop()) }))
  }
  const move = (dir) => update((c) => nudge(c, dir, photo, ratio))
  const zoomIn = () => update((c) => zoomBy(c, ZOOM_STEP, photo, ratio))
  const zoomOut = () => update((c) => zoomBy(c, 1 / ZOOM_STEP, photo, ratio))
  const reset = () => update(() => initialCrop())

  const pickFrame = (id) => {
    if (off || locked || id === current) return
    dragStart.current = null
    setChosen(id)
    setCrops((all) => clampAll(list, all, ratioFor(id)))
  }
  const page = (step) => {
    dragStart.current = null
    setIndex((i) => Math.min(Math.max(0, i + step), Math.max(0, list.length - 1)))
  }
  const apply = () => {
    const out = {}
    for (const p of list) {
      const c = clampCrop(crops[p.id] || initialCrop(), p, ratio)
      out[p.id] = { zoom: c.zoom, cx: c.cx, cy: c.cy }
    }
    onApply({ frameId: current, crops: out })
  }

  // Every handled key is swallowed: arrows would scroll the page, and Escape
  // would reach App.js and the sheet underneath.
  const keyOf = (e) => (e && e.nativeEvent ? e.nativeEvent.key : e && e.key)
  const swallow = (e) => {
    try { e.preventDefault() } catch {}
    try { e.stopPropagation() } catch {}
  }
  // The help sheet is a portal whose keys still bubble here: ignore them.
  const outside = (e) => typeof e?.currentTarget?.contains === 'function' && !!e.target && !e.currentTarget.contains(e.target)
  const onKeyDown = (e) => {
    if (outside(e)) return
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
  // The editor is the top Escape layer while it is open (src/ui/escapeLayer.js).
  useEscapeLayer(true, () => { if (!off && onCancel) onCancel() }, 'editor')
  const onKeyUp = (e) => {
    if (outside(e)) return
    if (keyOf(e) !== 'Escape') return
    swallow(e)
    if (!off && onCancel) onCancel()
  }

  const percent = zoomPercent(crop)
  const webViewport = WEB ? { tabIndex: 0 } : null
  // Keys bubble up here from the focused stage or button; no tabIndex on the
  // panel itself, so the sheet's focus trap does not stop on it.
  const webPanel = WEB ? { onKeyDown, onKeyUp } : null
  const rect = photo && !fixed ? displayRect(crop, photo, viewW, ratio) : null

  return (
    <View style={styles.panel} {...webPanel}>
      <View style={styles.titleRow}>
        <Text ref={headerRef} style={styles.header} accessibilityRole='header' {...(WEB ? { tabIndex: -1 } : null)}>
          Enquadrar fotos
        </Text>
        <HelpButton doc={HELP.enquadramento} />
      </View>
      <View style={styles.chips} accessibilityRole='radiogroup'>
        {FRAMES.map((frame) => {
          const checked = frame.id === current
          const disabled = off || (locked !== null && !checked)
          return (
            <Pressable
              key={frame.id}
              accessibilityRole='radio'
              accessibilityState={{ checked, disabled }}
              aria-checked={checked}
              accessibilityLabel={frame.label}
              disabled={disabled}
              onPress={() => pickFrame(frame.id)}
              hitSlop={4}
              style={({ pressed }) => [styles.chip, checked ? styles.chipOn : styles.chipOff, disabled && styles.off, pressed && styles.pressed]}
            >
              <Text style={checked ? styles.chipTextOn : styles.chipTextOff}>{frame.label}</Text>
            </Pressable>
          )
        })}
      </View>
      <View
        accessible
        accessibilityLabel='Enquadramento da foto'
        style={[styles.viewport, { width: viewW, height: viewH }, WEB && !fixed && styles.webDrag]}
        {...webViewport}
        {...responder.panHandlers}
      >
        {photo && fixed
          ? <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} resizeMode='contain' />
          : null}
        {photo && rect
          ? (
            <Image
              source={{ uri: photo.uri }}
              style={{ position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
              resizeMode='stretch'
            />
            )
          : null}
      </View>
      {fixed ? <Soft>GIF aparece inteiro, sem corte.</Soft> : null}
      {list.length > 1
        ? (
          <View style={styles.pager}>
            <IconAction icon='voltar' label='foto anterior' onPress={() => page(-1)} disabled={off || at === 0} />
            <Text
              style={styles.zoom}
              accessibilityLiveRegion='polite'
              {...(WEB ? { 'aria-live': 'polite' } : null)}
            >
              {'foto ' + (at + 1) + ' de ' + list.length}
            </Text>
            <IconAction icon='seta' label='próxima foto' onPress={() => page(1)} disabled={off || at >= list.length - 1} />
          </View>
          )
        : null}
      <Text
        style={styles.zoom}
        accessibilityLiveRegion='polite'
        {...(WEB ? { 'aria-live': 'polite' } : null)}
      >
        {'Zoom de ' + percent + '%'}
      </Text>
      <Row>
        <Pill label='Aproximar' onPress={zoomIn} disabled={still || !limits.zoomIn} />
        <Pill label='Afastar' onPress={zoomOut} disabled={still || !limits.zoomOut} />
        <Pill label='Centralizar' onPress={reset} disabled={still || isInitial(crop)} />
      </Row>
      <View style={styles.moveControls}>
        <Row>
          <IconAction icon='esquerda' label='mover para a esquerda' onPress={() => move('left')} disabled={still || !limits.left} />
          <IconAction icon='direita' label='mover para a direita' onPress={() => move('right')} disabled={still || !limits.right} />
        </Row>
        <Row>
          <IconAction icon='seta_cima' label='mover para cima' onPress={() => move('up')} disabled={still || !limits.up} />
          <IconAction icon='baixo' label='mover para baixo' onPress={() => move('down')} disabled={still || !limits.down} />
        </Row>
      </View>
      <ErrorText>{error}</ErrorText>
      <Row>
        <Pill label='Cancelar' onPress={onCancel} disabled={off} />
        <Pill label='Aplicar' filled pending={pending} onPress={apply} />
      </Row>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  panel: { gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  header: { ...type.section, color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 999, minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.accent, paddingVertical: 9.5, paddingHorizontal: 17 },
  chipOff: { borderWidth: 1.5, borderColor: colors.outline, paddingVertical: 8, paddingHorizontal: 15 },
  chipTextOn: { ...type.rowName, textAlign: 'center', color: colors.accentInk },
  chipTextOff: { ...type.rowName, textAlign: 'center', color: colors.ink },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  viewport: { alignSelf: 'flex-start', overflow: 'hidden', borderRadius: 14, backgroundColor: colors.line },
  webDrag: { touchAction: 'none', cursor: 'grab', userSelect: 'none' },
  pager: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  moveControls: { alignSelf: 'flex-start', gap: 8 },
  zoom: { fontSize: 14, lineHeight: 20, color: colors.soft }
})
