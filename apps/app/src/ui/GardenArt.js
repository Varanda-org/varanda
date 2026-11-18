// Shared Varandinha pieces in the "Pôr do sol" look: the shape renderer and
// gradients, small drawings, the pot art with its stage dots and drop badge,
// and the sticker cards and buttons of the sheets. Colours and geometry come
// from gardenStyle.js and gardenScene.js; this file only draws them.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg'
import { POT_BOX, RIPE_GLOW, plantShapes, potBase, potCues } from './gardenScene'
import { THIRST_BADGE, dotRow, gardenCardStyles, gardenGradients, gardenTokens, ripeOf } from './gardenStyle'
import { hiddenFromReaders } from './SplashSceneView'
import { fonts } from './theme'
import { useTheme } from './ThemeProvider'

const POT_VIEWBOX = POT_BOX.x + ' ' + POT_BOX.y + ' ' + POT_BOX.w + ' ' + POT_BOX.h

// One id per gradient and scheme. On the web every Svg shares the document,
// so a light and a dark copy must never answer to the same id.
export function gradId (name, scheme) {
  return 'varandinha-' + name + '-' + (scheme === 'dark' ? 'dark' : 'light')
}

export function GardenDefs ({ scheme, ids }) {
  const grads = gardenGradients(scheme)
  return (
    <Defs>
      {ids.map((id) => {
        const g = grads[id]
        if (!g) return null
        const stops = g.stops.map((stop, i) => (
          <Stop key={i} offset={stop.offset} stopColor={stop.color} stopOpacity={stop.opacity} />
        ))
        return g.kind === 'linear'
          ? <LinearGradient key={id} id={gradId(id, scheme)} x1='0' y1='0' x2='0' y2='1'>{stops}</LinearGradient>
          : <RadialGradient key={id} id={gradId(id, scheme)} cx='50%' cy='50%' r='50%'>{stops}</RadialGradient>
      })}
    </Defs>
  )
}

function paint (shape, palette, scheme) {
  const props = {}
  if (typeof shape.grad === 'string') props.fill = 'url(#' + gradId(shape.grad, scheme) + ')'
  else props.fill = shape.fill === 'none' ? 'none' : palette[shape.fill]
  if (typeof shape.stroke === 'string') {
    props.stroke = palette[shape.stroke]
    props.strokeWidth = typeof shape.sw === 'number' ? shape.sw : 1
    props.strokeLinejoin = 'round'
    if (shape.cap === 'round') props.strokeLinecap = 'round'
    if (Array.isArray(shape.dash)) props.strokeDasharray = shape.dash
  }
  if (typeof shape.opacity === 'number') props.opacity = shape.opacity
  return props
}

function Shape ({ shape, palette, scheme }) {
  const p = paint(shape, palette, scheme)
  if (shape.kind === 'rect') return <Rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.rx} {...p} />
  if (shape.kind === 'circle') return <Circle cx={shape.cx} cy={shape.cy} r={shape.r} {...p} />
  if (shape.kind === 'ellipse') return <Ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...p} />
  if (shape.kind === 'path') return <Path d={shape.d} {...p} />
  return null
}

// A lamp marked glow gets a soft halo behind it at night.
function Halo ({ shape, scheme }) {
  const cx = shape.kind === 'rect' ? shape.x + shape.w / 2 : shape.cx
  const cy = shape.kind === 'rect' ? shape.y + shape.h / 2 : shape.cy
  const size = shape.kind === 'circle' ? shape.r : Math.max(shape.rx || 0, shape.ry || 0, (shape.w || 0) / 2)
  if (!(size > 0)) return null
  return <Circle cx={cx} cy={cy} r={size * 3} fill={'url(#' + gradId('glow', scheme) + ')'} />
}

export function ShapeList ({ shapes, palette, scheme }) {
  if (!Array.isArray(shapes)) return null
  const night = scheme === 'dark'
  const out = []
  shapes.forEach((shape, i) => {
    if (night && shape.glow === true) out.push(<Halo key={'h' + i} shape={shape} scheme={scheme} />)
    out.push(<Shape key={i} shape={shape} palette={palette} scheme={scheme} />)
  })
  return out
}

function gradsOf (shapes, night) {
  const ids = []
  for (const shape of shapes) {
    if (typeof shape.grad === 'string' && !ids.includes(shape.grad)) ids.push(shape.grad)
    if (night && shape.glow === true && !ids.includes('glow')) ids.push('glow')
  }
  return ids
}

// A { w, h, shapes } drawing (gardenStyle.js giftDrawing, STALL_DRAWING,
// THIRST_BADGE, gardenDecor.js decorDrawing) at a width, in the scheme's
// colours. Decorative: readers skip it, the row beside it says what it is.
export function GardenDrawing ({ drawing, width, palette }) {
  const { scheme } = useTheme()
  if (!drawing || !(drawing.w > 0) || !(drawing.h > 0) || !Array.isArray(drawing.shapes)) return null
  const w = typeof width === 'number' && width > 0 ? width : drawing.w
  const h = w * drawing.h / drawing.w
  const colours = palette || gardenTokens(scheme)
  const ids = gradsOf(drawing.shapes, scheme === 'dark')
  return (
    <View pointerEvents='none' style={{ width: w, height: h }} {...hiddenFromReaders}>
      <Svg width={w} height={h} viewBox={'0 0 ' + drawing.w + ' ' + drawing.h}>
        {ids.length > 0 ? <GardenDefs scheme={scheme} ids={ids} /> : null}
        <ShapeList shapes={drawing.shapes} palette={colours} scheme={scheme} />
      </Svg>
    </View>
  )
}

// One pot as it stands on the balcony, still: glow when ripe, clay and soil,
// the plant, then the stage dots and the drop badge. size is the width.
export function PotArt ({ view, size, cues }) {
  const { scheme } = useTheme()
  const w = typeof size === 'number' && size > 0 ? size : 64
  const h = w * POT_BOX.h / POT_BOX.w
  const ripe = ripeOf(view)
  const shapes = (ripe ? [RIPE_GLOW] : [])
    .concat(potBase(view), plantShapes(view), cues === false ? [] : potCues(view))
  return (
    <View pointerEvents='none' style={{ width: w, height: h }} {...hiddenFromReaders}>
      <Svg width={w} height={h} viewBox={POT_VIEWBOX}>
        {ripe ? <GardenDefs scheme={scheme} ids={GLOW_ONLY} /> : null}
        <ShapeList shapes={shapes} palette={gardenTokens(scheme)} scheme={scheme} />
      </Svg>
    </View>
  )
}

const GLOW_ONLY = ['glow']

// The four growth dots on their own, filled up to the pot's stage.
export function StageDots ({ view, width }) {
  const { scheme } = useTheme()
  const w = typeof width === 'number' && width > 0 ? width : 48
  return (
    <View pointerEvents='none' style={{ width: w, height: w / 4 }} {...hiddenFromReaders}>
      <Svg width={w} height={w / 4} viewBox='0 0 40 10'>
        <ShapeList shapes={dotRow(view, 20, 5, 3.6, 10)} palette={gardenTokens(scheme)} scheme={scheme} />
      </Svg>
    </View>
  )
}

export function ThirstBadge ({ size }) {
  return <GardenDrawing drawing={THIRST_BADGE} width={typeof size === 'number' ? size : 24} />
}

// Built once per scheme, on first use: on react-native-web StyleSheet.create
// compiles CSS classes when called.
const SHEETS = {}

function sheetFor (scheme) {
  const key = scheme === 'dark' ? 'dark' : 'light'
  if (SHEETS[key] === undefined) {
    const base = gardenCardStyles(gardenTokens(key))
    for (const name of ['rowName', 'tileName', 'btnLabel']) base[name] = { ...base[name], fontFamily: fonts.title }
    SHEETS[key] = StyleSheet.create(base)
  }
  return SHEETS[key]
}

export function useGardenStyles () {
  const { scheme } = useTheme()
  return sheetFor(scheme)
}

// A cream card (navy at night) with an ink edge, lifted on a hard ink
// shadow. With onPress it is one button, pressed down onto its shadow.
export function StickerCard ({ children, onPress, accessibilityLabel, accessibilityRole, accessibilityHint, accessibilityState, disabled, style, faceStyle }) {
  const s = useGardenStyles()
  if (typeof onPress !== 'function') {
    return (
      <View style={[s.cardWrap, style]}>
        <View pointerEvents='none' style={s.cardLift} />
        <View style={[s.card, faceStyle]}>{children}</View>
      </View>
    )
  }
  const off = disabled === true
  return (
    <Pressable
      accessibilityRole={accessibilityRole || 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ ...accessibilityState, disabled: off }}
      disabled={off}
      onPress={onPress}
      style={[s.cardWrap, style]}
    >
      {({ pressed }) => (
        <>
          <View pointerEvents='none' style={s.cardLift} />
          <View style={[s.card, faceStyle, off && s.btnOff, pressed && !off && s.cardPressed]}>{children}</View>
        </>
      )}
    </Pressable>
  )
}

// The sheets' buttons in the sticker face. Same props as Btn (ui/index.js),
// which takes no style.
export function GardenButton ({ label, onPress, disabled, pending, secondary, danger, accessibilityLabel }) {
  const s = useGardenStyles()
  const off = disabled === true || pending === true
  const face = [s.btn, danger ? s.btnDanger : secondary ? s.btnSecondary : s.btnPrimary]
  const text = [s.btnLabel, danger ? s.btnLabelDanger : secondary ? s.btnLabelSecondary : null]
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress}
      style={[s.btnWrap, off && s.btnOff]}
    >
      {({ pressed }) => (
        <>
          <View pointerEvents='none' style={s.btnLift} />
          <View style={[face, pressed && !off && s.btnPressed]}>
            <Text style={text}>{pending ? label + '…' : label}</Text>
          </View>
        </>
      )}
    </Pressable>
  )
}

export function GardenSection ({ title }) {
  const s = useGardenStyles()
  return <Text accessibilityRole='header' style={s.section}>{title}</Text>
}
