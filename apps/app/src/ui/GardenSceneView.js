// The Varandinha balcony. Boxes and drawings come from gardenScene.js,
// enfeites from gardenDecor.js, the renderer from GardenArt.js.
// A ripe pot sways and its glow breathes until the person asks for less
// motion, then both stand still.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native'
import Svg, { G } from 'react-native-svg'
import { GardenDefs, ShapeList } from './GardenArt'
import { decorDrawing, decorPalette } from './gardenDecor'
import { DECOR_IDS, POT_BOX, RIPE_GLOW, SOIL_Y, backdropShapes, gardenLayout, gardenPalette, plantShapes, potBase, potCues, railShapes } from './gardenScene'
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

const POT_VIEWBOX = POT_BOX.x + ' ' + POT_BOX.y + ' ' + POT_BOX.w + ' ' + POT_BOX.h
const BACKDROP_GRADS = ['sky', 'halo', 'glow']
const GLOW_ONLY = ['glow']

function tiltRange (index) {
  const sign = index % 2 === 0 ? 1 : -1
  const out = []
  for (let k = 0; k <= STEPS; k++) {
    out.push((sign * MAX_TILT * Math.sin(2 * Math.PI * k / STEPS)).toFixed(3) + 'deg')
  }
  return out
}

// The glow is brightest when the plant stands upright and dims at the far
// end of the lean, on the same clock, so it needs no loop of its own.
function glowRange () {
  const out = []
  for (let k = 0; k <= STEPS; k++) out.push(Number((0.75 + 0.25 * Math.cos(2 * Math.PI * k / STEPS)).toFixed(3)))
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
  const glow = sway.interpolate({ inputRange, outputRange: glowRange() })
  return { sway, tilts, glow }
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

// One pot layer: the pot box fitted in the slot, so every layer of a pot
// shares its coordinates.
function Layer ({ pot, shapes, palette, scheme, grads }) {
  return (
    <Svg width={pot.w} height={pot.h} viewBox={POT_VIEWBOX} preserveAspectRatio='xMidYMid meet'>
      {grads ? <GardenDefs scheme={scheme} ids={grads} /> : null}
      <ShapeList shapes={shapes} palette={palette} scheme={scheme} />
    </Svg>
  )
}

// A still pot is one drawing. A moving one splits in three: the breathing
// glow, the clay with its dots, and the plant, which leans about the soil.
function Art ({ pot, view, palette, scheme, tilt, glow }) {
  const size = { position: 'absolute', left: 0, top: 0, width: pot.w, height: pot.h }
  const ripe = isRipe(view)
  if (!tilt) {
    const shapes = (ripe ? [RIPE_GLOW] : []).concat(potBase(view), plantShapes(view), potCues(view))
    return (
      <View pointerEvents='none' style={size} {...hiddenFromReaders}>
        <Layer pot={pot} shapes={shapes} palette={palette} scheme={scheme} grads={ripe ? GLOW_ONLY : null} />
      </View>
    )
  }
  const scale = Math.min(pot.w / POT_BOX.w, pot.h / POT_BOX.h)
  const pivot = Math.round((SOIL_Y - (POT_BOX.y + POT_BOX.h / 2)) * scale)
  return (
    <View pointerEvents='none' style={size} {...hiddenFromReaders}>
      <Animated.View style={[size, { opacity: glow }]}>
        <Layer pot={pot} shapes={[RIPE_GLOW]} palette={palette} scheme={scheme} grads={GLOW_ONLY} />
      </Animated.View>
      <View style={size}>
        <Layer pot={pot} shapes={potBase(view).concat(potCues(view))} palette={palette} scheme={scheme} />
      </View>
      <Animated.View
        style={[size, { transform: [{ translateY: pivot }, { rotate: tilt }, { translateY: -pivot }] }]}
      >
        <Layer pot={pot} shapes={plantShapes(view)} palette={palette} scheme={scheme} />
      </Animated.View>
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
function DecorArt ({ id, rect, palette, scheme }) {
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
        <ShapeList shapes={shapes} palette={palette} scheme={scheme} />
      </G>
    )
  } catch {
    return null
  }
}

// Sky, city, floor and roof, then the enfeites, then the railing over them.
// It changes only with the frame, the enfeites or the scheme, so the
// screen's clock tick never redraws it.
const Backdrop = memo(function Backdrop ({ layout, scheme }) {
  const palette = gardenPalette(scheme)
  return (
    <View pointerEvents='none' style={StyleSheet.absoluteFill} {...hiddenFromReaders}>
      <Svg width={layout.width} height={layout.height}>
        <GardenDefs scheme={scheme} ids={BACKDROP_GRADS} />
        <ShapeList shapes={backdropShapes(layout, scheme)} palette={palette} scheme={scheme} />
        {layout.decor
          ? Object.keys(layout.decor).map((id) => (
            <DecorArt key={id} id={id} rect={layout.decor[id]} palette={decorPalette(scheme)} scheme={scheme} />
          ))
          : null}
        <ShapeList shapes={railShapes(layout)} palette={palette} scheme={scheme} />
      </Svg>
    </View>
  )
})

export function GardenSceneView ({ width, pots, scheme, labels, onPressPot, decor }) {
  const motion = useRef(null)
  if (motion.current === null) motion.current = createSway()
  const decorIds = joinedDecor(decor)
  const layout = useMemo(() => gardenLayout(width, {
    decor: decorIds === '' ? [] : decorIds.split(',')
  }), [width, decorIds])
  const palette = gardenPalette(scheme)
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
      {layout.height > 0 ? <Backdrop layout={layout} scheme={scheme} /> : null}
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
              scheme={scheme}
              tilt={moving ? motion.current.tilts[pot.index] : null}
              glow={motion.current.glow}
            />
          </Pressable>
        )
      })}
    </View>
  )
}
