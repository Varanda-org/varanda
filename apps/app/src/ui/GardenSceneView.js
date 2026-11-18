// The Varandinha balcony. Boxes and pot drawings come from gardenScene.js,
// enfeites from gardenDecor.js.
// A ripe pot sways until the person asks for less motion, then it stands still.

import { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native'
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg'
import { decorDrawing, decorPalette } from './gardenDecor'
import { DECOR_IDS, gardenLayout, gardenPalette, plantShapes, potBase } from './gardenScene'
import { hiddenFromReaders } from './SplashSceneView'
import { loopTiming } from './loopMotion'

// The native driver is a platform API react-native-web does not have, so this
// picks the driver, never the behaviour.
const native = Platform.select({ web: false, default: true })

// One full lean to each side and back to upright, as a sine sampled at 16
// stops, so the sway slows to a stop at each peak. 0 and STEPS are both
// upright, so the loop can jump back without a visible snap.
const SWAY_MS = 3400
const STEPS = 16
const MAX_TILT = 2.5

function tiltRange (index) {
  const sign = index % 2 === 0 ? 1 : -1
  const out = []
  for (let k = 0; k <= STEPS; k++) {
    out.push((sign * MAX_TILT * Math.sin(2 * Math.PI * k / STEPS)).toFixed(3) + 'deg')
  }
  return out
}

function createSway () {
  const sway = new Animated.Value(0)
  const inputRange = []
  for (let k = 0; k <= STEPS; k++) inputRange.push(k)
  const tilts = [0, 1, 2, 3, 4, 5].map((index) => sway.interpolate({
    inputRange,
    outputRange: tiltRange(index)
  }))
  return { sway, tilts }
}

function useKnownReduceMotion () {
  const [reduce, setReduce] = useState(null)
  useEffect(() => {
    let live = true
    let sub = null
    let eventWon = false
    const apply = (value) => {
      if (live) setReduce(value !== false)
    }
    const onEvent = (value) => {
      eventWon = true
      apply(value)
    }
    try {
      // Promise.resolve keeps a platform that answers synchronously on the same path.
      Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((value) => {
        if (!eventWon) apply(value)
      }, () => {})
      sub = AccessibilityInfo.addEventListener('reduceMotionChanged', onEvent)
    } catch {}
    return () => {
      live = false
      try {
        if (sub && typeof sub.remove === 'function') sub.remove()
      } catch {}
    }
  }, [])
  return reduce
}

function viewAt (pots, index) {
  try {
    if (!Array.isArray(pots)) return null
    const view = pots[index]
    return view === undefined ? null : view
  } catch {
    return null
  }
}

function isRipe (view) {
  try {
    if (view === null || typeof view !== 'object') return false
    return view.ripe === true
  } catch {
    return false
  }
}

function labelAt (labels, index) {
  if (!Array.isArray(labels)) return ''
  const label = labels[index]
  return typeof label === 'string' ? label : ''
}

function Shape ({ shape, fill }) {
  if (shape.kind === 'rect') return <Rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill={fill} />
  if (shape.kind === 'circle') return <Circle cx={shape.cx} cy={shape.cy} r={shape.r} fill={fill} />
  if (shape.kind === 'ellipse') return <Ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} fill={fill} />
  if (shape.kind === 'path') return <Path d={shape.d} fill={fill} />
  return null
}

function Drawing ({ pot, shapes, palette }) {
  return (
    <Svg width={pot.w} height={pot.h} viewBox='0 0 100 100' preserveAspectRatio='xMidYMid meet'>
      {shapes.map((shape, i) => <Shape key={i} shape={shape} fill={palette[shape.fill]} />)}
    </Svg>
  )
}

// Pot and soil stand still; only the plant leans, pivoting at the soil line.
// The square drawing sits in the slot's middle, so local y 64 is 0.14 of the
// slot's width below the slot's centre.
function Art ({ pot, view, palette, tilt }) {
  const size = { position: 'absolute', left: 0, top: 0, width: pot.w, height: pot.h }
  const pivot = Math.round(pot.w * 14 / 100)
  const plant = <Drawing pot={pot} shapes={plantShapes(view)} palette={palette} />
  return (
    <View pointerEvents='none' style={size} {...hiddenFromReaders}>
      <Drawing pot={pot} shapes={potBase(view)} palette={palette} />
      {tilt
        ? (
          <Animated.View
            style={[size, { transform: [{ translateY: pivot }, { rotate: tilt }, { translateY: -pivot }] }]}
          >
            {plant}
          </Animated.View>
          )
        : <View style={size}>{plant}</View>}
    </View>
  )
}

// Only this many entries are read, as in the layout, so a hostile length
// spends no time.
const DECOR_LIST_MAX = 8

// The memo key is the set of known ids, not the array object. A hole, a getter,
// a throw or an unknown id adds nothing, the same read the layout makes.
function joinedDecor (decor) {
  try {
    if (!Array.isArray(decor)) return ''
    const lenDesc = Object.getOwnPropertyDescriptor(decor, 'length')
    const len = lenDesc && lenDesc.value
    if (!Number.isSafeInteger(len) || len < 0) return ''
    const on = []
    const end = Math.min(len, DECOR_LIST_MAX)
    for (let i = 0; i < end; i++) {
      const desc = Object.getOwnPropertyDescriptor(decor, String(i))
      if (!desc || !('value' in desc) || !desc.enumerable) continue
      const id = desc.value
      if (typeof id === 'string' && DECOR_IDS.includes(id) && !on.includes(id)) on.push(id)
    }
    return DECOR_IDS.filter((id) => on.includes(id)).join(',')
  } catch {
    return ''
  }
}

// One matrix scales about the drawing origin and then shifts it. A transform
// list would depend on which end runs first. Spare room stays above the
// drawing, so a short rect still rests on its floor.
function DecorArt ({ id, rect, palette }) {
  try {
    const drawing = decorDrawing(id)
    const w = drawing.w
    const h = drawing.h
    const shapes = drawing.shapes
    if (!(w > 0) || !(h > 0) || !Array.isArray(shapes) || shapes.length === 0) return null
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null
    const scale = Math.min(rect.w / w, rect.h / h)
    if (!Number.isFinite(scale) || scale <= 0) return null
    const x = rect.x + (rect.w - w * scale) / 2
    const y = rect.y + rect.h - h * scale
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const transform = 'matrix(' + scale + ' 0 0 ' + scale + ' ' + x + ' ' + y + ')'
    return (
      <G transform={transform}>
        {shapes.map((shape, i) => <Shape key={i} shape={shape} fill={palette[shape.fill]} />)}
      </G>
    )
  } catch {
    return null
  }
}

export function GardenSceneView ({ width, pots, scheme, labels, onPressPot, decor }) {
  const motion = useRef(null)
  if (motion.current === null) motion.current = createSway()
  const decorIds = joinedDecor(decor)
  const layout = useMemo(() => gardenLayout(width, {
    decor: decorIds === '' ? [] : decorIds.split(',')
  }), [width, decorIds])
  const palette = gardenPalette(scheme)
  const decorFill = decorPalette(scheme)
  const reduce = useKnownReduceMotion()
  const canPress = typeof onPressPot === 'function'
  const sway = motion.current.sway
  // The pots that render a moving plant. The sway value stops when its last
  // animated view unmounts, so any change of this set restarts the loop.
  const movingKey = layout.height > 0 && reduce === false
    ? layout.pots.filter((pot) => isRipe(viewAt(pots, pot.index))).map((pot) => pot.index).join(',')
    : ''

  useEffect(() => {
    if (movingKey === '') {
      sway.setValue(0)
      return
    }
    sway.setValue(0)
    const loop = Animated.loop(Animated.timing(sway, loopTiming({
      toValue: STEPS,
      duration: SWAY_MS,
      easing: Easing.linear,
      useNativeDriver: native
    })))
    loop.start()
    return () => {
      loop.stop()
      sway.setValue(0)
    }
  }, [movingKey, sway])

  return (
    <View style={{ width: layout.width, height: layout.height, position: 'relative' }}>
      <View pointerEvents='none' style={StyleSheet.absoluteFill} {...hiddenFromReaders}>
        <Svg width={layout.width} height={layout.height}>
          <Rect x={layout.wall.x} y={layout.wall.y} width={layout.wall.w} height={layout.wall.h} fill={palette.wall} />
          <Rect x={layout.floor.x} y={layout.floor.y} width={layout.floor.w} height={layout.floor.h} fill={palette.floor} />
          {layout.decor
            ? Object.keys(layout.decor).map((id) => (
              <DecorArt key={id} id={id} rect={layout.decor[id]} palette={decorFill} />
            ))
            : null}
          {layout.railing.map((bar, i) => (
            <Rect
              key={i}
              x={bar.x}
              y={bar.y}
              width={bar.w}
              height={bar.h}
              fill={palette[bar.fill]}
            />
          ))}
        </Svg>
      </View>
      {layout.height > 0 && layout.pots.map((pot) => {
        const view = viewAt(pots, pot.index)
        const moving = isRipe(view) && reduce === false
        return (
          <Pressable
            key={pot.index}
            accessibilityRole='button'
            accessibilityLabel={labelAt(labels, pot.index)}
            accessibilityState={{ disabled: !canPress }}
            disabled={!canPress}
            onPress={canPress ? () => onPressPot(pot.index) : undefined}
            style={{ position: 'absolute', left: pot.hit.x, top: pot.hit.y, width: pot.hit.w, height: pot.hit.h }}
          >
            <Art
              pot={pot}
              view={view}
              palette={palette}
              tilt={moving ? motion.current.tilts[pot.index] : null}
            />
          </Pressable>
        )
      })}
    </View>
  )
}
