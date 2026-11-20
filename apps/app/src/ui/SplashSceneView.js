// The splash scene: the varanda with the chair, an araucária beside it and a
// sunset band behind, above a still petit-pavê street where people walk.
// Purely decorative; the geometry and every box come from the pure
// splashScene.js, the cast from splashStreet.js, and Splash.js owns the
// Animated values.

import { useMemo } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import Svg, { Defs, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg'
import { FLYERS, birdBob, butterflyDrift } from './splashMotion'
import { CHAIR_PATHS, CHAIR_VIEWBOX, LETTERING, SCENE, SKY_STOPS, SUN_STOPS, birdArt, butterflyArt, farTile, nearTiles, treeArt, varandaArt } from './splashScene'
import { STREET, ballArc, figureArt, kidHop, poseSwap, streetLayout } from './splashStreet'

// react-native-web 0.21 reads only aria-hidden; native reads the other two.
export const hiddenFromReaders = {
  'aria-hidden': true,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants'
}

const viewBoxSize = (viewBox) => {
  const [, , w, h] = viewBox.split(' ').map(Number)
  return { w, h }
}

function Shape ({ shape, palette }) {
  return (
    <Path
      d={shape.d}
      fill={shape.fill ? palette[shape.fill] : 'none'}
      stroke={shape.stroke ? palette[shape.stroke] : undefined}
      strokeWidth={shape.width}
      strokeLinecap={shape.cap}
      strokeLinejoin={shape.join}
      opacity={shape.opacity}
    />
  )
}

// One Svg per strip with the tiles side by side: the joints overhang the tile
// edges a little, and inside one Svg the next tile simply draws over them.
function stripSvg (tiles, count, k, palette) {
  const { w: vbW, h: vbH } = viewBoxSize(tiles[0].viewBox)
  const width = count * tiles[0].width * k
  const height = tiles[0].height * k
  const groups = []
  for (let i = 0; i < count; i++) {
    const tile = tiles[i % tiles.length]
    groups.push(
      <G key={i} transform={'translate(' + i * vbW + ' 0)'}>
        {tile.shapes.map((shape, j) => <Shape key={j} shape={shape} palette={palette} />)}
      </G>
    )
  }
  return {
    width,
    svg: (
      <Svg width={width} height={height} viewBox={'0 0 ' + count * vbW + ' ' + vbH} preserveAspectRatio='none'>
        <Rect x={0} y={0} width={count * vbW} height={vbH} fill={palette.pedra} />
        {groups}
      </Svg>
    )
  }
}

// react-native-web puts these Svgs in the DOM, so the gradient ids must not
// clash with anything else on the page, the overlay's vps- ids included.
function skySvg (w, h, palette) {
  return (
    <Svg width={w} height={h}>
      <Defs>
        <LinearGradient id='splash-ceu' x1='0' y1='0' x2='0' y2='1'>
          {SKY_STOPS.map((s) => <Stop key={s.offset} offset={s.offset} stopColor={palette[s.key]} />)}
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={w} height={h} fill='url(#splash-ceu)' />
    </Svg>
  )
}

function sunSvg (size, palette) {
  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id='splash-sol' cx='50%' cy='50%' r='50%'>
          {SUN_STOPS.map((s) => <Stop key={s.offset} offset={s.offset} stopColor={palette[s.key]} stopOpacity={s.opacity} />)}
        </RadialGradient>
      </Defs>
      <Rect x={0} y={0} width={size} height={size} fill='url(#splash-sol)' />
    </Svg>
  )
}

function artSvg (art, w, h, palette) {
  return (
    <Svg width={w} height={h} viewBox={art.viewBox}>
      {art.shapes.map((shape, j) => <Shape key={j} shape={shape} palette={palette} />)}
    </Svg>
  )
}

// `flyers` holds the Animated values Splash.js loops: one 0..1 crossing per
// bird, and the butterfly's flap and drift. Each bird is drawn twice, one
// crossing apart, so when its loop jumps back the copy already stands where
// it was and the jump never shows.
function flyerArt (layout, palette, flyers) {
  const { k, width } = layout
  const bird = birdArt()
  const birds = layout.birds.flatMap((b, i) => {
    const f = FLYERS.birds[i]
    const span = width + b.w
    const start = f.phase * span - b.w
    const bob = birdBob(f)
    const translateY = flyers.birds[i].interpolate({ inputRange: bob.input, outputRange: bob.output.map((y) => y * k) })
    const svg = artSvg(bird, b.w, b.h, palette)
    return [0, -span].map((offset) => ({
      key: i + ':' + offset,
      top: b.y,
      translateX: flyers.birds[i].interpolate({ inputRange: [0, 1], outputRange: [start + offset, start + offset + span] }),
      translateY,
      svg
    }))
  })
  const drift = butterflyDrift(FLYERS.butterfly)
  const bf = layout.butterfly
  return {
    birds,
    butterfly: {
      svg: artSvg(butterflyArt(), bf.w, bf.h, palette),
      translateX: flyers.drift.interpolate({ inputRange: drift.input, outputRange: drift.x.map((x) => x * k) }),
      translateY: flyers.drift.interpolate({ inputRange: drift.input, outputRange: drift.y.map((y) => y * k) }),
      scaleX: flyers.flap.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, FLYERS.butterfly.fold, 1] })
    }
  }
}

// `street` holds the Animated values Splash.js loops: one 0..1 crossing per
// lane, one stride per lane, and the standing row's idle clock. Each walker
// is drawn twice, one track apart, so when its lane loop jumps back the copy
// already stands where it was and the jump never shows. `start` includes the
// mover's phase, the way a bird's start includes its phase, so one lane value
// keeps the two walkers half a track apart.
function streetArt (layout, palette, street) {
  const placed = streetLayout(layout)
  const k = layout.k
  // One pose swap per stride: the stride value runs 0..1 over strideMs and
  // pose a is showing again at 1, so the restart never flashes a leg.
  const swap = poseSwap(1)
  const strideOpacity = [0, 1].map((i) => ({
    a: street.strides[i].interpolate({ inputRange: swap.input, outputRange: swap.a }),
    b: street.strides[i].interpolate({ inputRange: swap.input, outputRange: swap.b })
  }))
  const lanes = [[], []]
  placed.movers.forEach((mover, n) => {
    const art = figureArt(mover.figure, mover.tint)
    const i = mover.lane === 'vindo' ? 1 : 0
    const track = mover.track
    const start = mover.start + mover.phase * track
    const bodySvg = artSvg({ viewBox: art.viewBox, shapes: art.body }, mover.w, mover.h, palette)
    const aSvg = artSvg({ viewBox: art.viewBox, shapes: art.a }, mover.w, mover.h, palette)
    const bSvg = artSvg({ viewBox: art.viewBox, shapes: art.b }, mover.w, mover.h, palette)
    for (const offset of [0, -track]) {
      const translateX = street.lanes[i].interpolate({ inputRange: [0, 1], outputRange: [start + offset, start + offset + track] })
      lanes[i].push(
        <Animated.View
          key={n + ':' + offset}
          style={[styles.at, { left: 0, top: mover.top, width: mover.w, height: mover.h, transform: [{ translateX }] }]}
        >
          {bodySvg}
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: strideOpacity[i].a }]}>
            {aSvg}
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: strideOpacity[i].b }]}>
            {bSvg}
          </Animated.View>
        </Animated.View>
      )
    }
  })
  const idleSwap = poseSwap(STREET.idle.poseCycles)
  const idleA = street.idle.interpolate({ inputRange: idleSwap.input, outputRange: idleSwap.a })
  const idleB = street.idle.interpolate({ inputRange: idleSwap.input, outputRange: idleSwap.b })
  let kid = 0
  const standing = placed.standing.map((s, index) => {
    const art = figureArt(s.figure, s.tint)
    const body = artSvg({ viewBox: art.viewBox, shapes: art.body }, s.w, s.h, palette)
    const place = [styles.at, { left: s.left, top: s.top, width: s.w, height: s.h }]
    // The whole figure moves, so a hop or a toss cannot be clipped by its own box.
    if (s.figure === 'crianca') {
      const hop = kidHop(kid)
      kid += 1
      const translateY = street.idle.interpolate({ inputRange: hop.input, outputRange: hop.y.map((y) => y * k) })
      const transform = s.mirrored ? [{ translateY }, { scaleX: -1 }] : [{ translateY }]
      return (
        <Animated.View key={index} style={[place, { transform }]}>
          {body}
        </Animated.View>
      )
    }
    if (s.figure === 'bola') {
      const arc = ballArc()
      const translateX = street.idle.interpolate({ inputRange: arc.input, outputRange: arc.x.map((x) => x * k) })
      const translateY = street.idle.interpolate({ inputRange: arc.input, outputRange: arc.y.map((y) => y * k) })
      return (
        <Animated.View key={index} style={[place, { transform: [{ translateX }, { translateY }] }]}>
          {body}
        </Animated.View>
      )
    }
    return (
      <View key={index} style={place}>
        {body}
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: idleA }]}>
          {artSvg({ viewBox: art.viewBox, shapes: art.a }, s.w, s.h, palette)}
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: idleB }]}>
          {artSvg({ viewBox: art.viewBox, shapes: art.b }, s.w, s.h, palette)}
        </Animated.View>
      </View>
    )
  })
  // The vindo lane is the full band flipped about its middle, so the same
  // left-to-right walk reads from the right edge. Back lane, then the people
  // standing, then the front lane passing in front of them.
  const laneBox = { position: 'absolute', left: 0, top: 0, width: placed.band.width, height: placed.band.height }
  return (
    <>
      <View style={[laneBox, { transform: [{ scaleX: -1 }] }]}>{lanes[1]}</View>
      {standing}
      <View style={laneBox}>{lanes[0]}</View>
    </>
  )
}

export function SplashScene ({ layout, palette, bottomInset = 0, ground, varanda, chair, street, flyers }) {
  const { width, k } = layout
  // Splash re-renders on every progress step; the paths are built once per
  // size and scheme so a frame only moves already drawn layers.
  const art = useMemo(() => {
    const v = varandaArt()
    return {
      near: stripSvg(nearTiles(), layout.nearCount, k, palette),
      far: stripSvg([farTile()], layout.farCount, k, palette),
      varanda: (
        <Svg width={layout.varanda.w} height={layout.varanda.h} viewBox={v.viewBox}>
          {v.shapes.map((shape, j) => <Shape key={j} shape={shape} palette={palette} />)}
        </Svg>
      ),
      chair: (
        <Svg width={layout.chair.size} height={layout.chair.size} viewBox={CHAIR_VIEWBOX}>
          {CHAIR_PATHS.map((p, j) => <Path key={j} d={p.d} fill={p.fill} fillOpacity={p.fillOpacity} />)}
        </Svg>
      ),
      tree: artSvg(treeArt(), layout.tree.w, layout.tree.h, palette),
      sky: skySvg(width, layout.sky.height, palette),
      sun: sunSvg(layout.sun.size, palette),
      flyers: flyerArt(layout, palette, flyers),
      street: streetArt(layout, palette, street)
    }
  }, [width, k, palette])

  const rotate = chair.rotate.interpolate({ inputRange: [-6, 0], outputRange: ['-6deg', '0deg'] })
  const { far, near, kerb, rua, sky, sun, tree } = layout
  const varandaMotion = { opacity: varanda.opacity, transform: [{ translateY: varanda.translateY }] }

  return (
    <View
      pointerEvents='none'
      {...hiddenFromReaders}
      style={{ width, height: layout.height + bottomInset, overflow: 'hidden' }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: ground.opacity, transform: [{ translateY: ground.translateY }] }]}>
        <View style={[styles.band, { top: sky.y, height: sky.height }]}>{art.sky}</View>
        <View style={[styles.at, { left: sun.x, top: sun.y }]}>{art.sun}</View>
        <View style={[styles.band, { top: far.y, height: far.height }]}>
          {art.far.svg}
        </View>
        <View style={[styles.band, { top: near.y, height: near.height }]}>
          {art.near.svg}
        </View>
        <View style={[styles.band, { top: near.y, height: near.height, overflow: 'hidden' }]}>
          {art.street}
        </View>
        <View style={[styles.band, { top: kerb.y, height: kerb.height, backgroundColor: palette.meioFio }]} />
        {/* Runs on under the home indicator, so the street reaches the screen's bottom edge. */}
        <View style={[styles.band, { top: rua.y, height: rua.height + bottomInset, backgroundColor: palette.asfalto }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: ground.opacity }]}>
        {art.flyers.birds.map((b) => (
          <Animated.View key={b.key} style={[styles.at, { left: 0, top: b.top, transform: [{ translateX: b.translateX }, { translateY: b.translateY }] }]}>
            {b.svg}
          </Animated.View>
        ))}
      </Animated.View>
      {/* Before the varanda, so on a narrow screen the crown tucks behind it. */}
      <Animated.View style={[styles.at, { left: tree.x, top: tree.y }, varandaMotion]}>
        {art.tree}
      </Animated.View>
      <Animated.View style={[styles.at, { left: layout.varanda.x, top: layout.varanda.y }, varandaMotion]}>
        {art.varanda}
      </Animated.View>
      <Animated.View
        style={[styles.at, {
          left: layout.chair.x,
          top: layout.chair.y,
          opacity: chair.opacity,
          transform: [{ translateY: chair.translateY }, { scale: chair.scale }, { rotate }]
        }]}
      >
        {art.chair}
      </Animated.View>
      <Animated.View style={[styles.at, { left: layout.butterfly.x, top: layout.butterfly.y, opacity: varanda.opacity }]}>
        <Animated.View style={{ transform: [{ translateX: art.flyers.butterfly.translateX }, { translateY: art.flyers.butterfly.translateY }, { scaleX: art.flyers.butterfly.scaleX }] }}>
          {art.flyers.butterfly.svg}
        </Animated.View>
      </Animated.View>
    </View>
  )
}

const LETTERING_SIZE = (() => {
  const { w, h } = viewBoxSize(LETTERING.viewBox)
  return { width: Math.round(SCENE.letteringHeight * w / h), height: SCENE.letteringHeight }
})()

// The brand's hand-drawn VARANDA. Every letter is its own layer with the full
// viewBox, so each rises on its own and stays exactly where the lockup puts
// it, with no per-letter box to compute. `letters` holds the Animated
// { opacity, translateY } that Splash.js owns, one per letter.
export function SplashLettering ({ palette, letters }) {
  const paths = useMemo(
    () => LETTERING.letters.map((l) => <Path key={l.char} d={l.d} fill={palette.letra} />),
    [palette.letra]
  )
  return (
    <View {...hiddenFromReaders} style={LETTERING_SIZE}>
      {paths.map((p, i) => (
        <Animated.View
          key={i}
          style={[StyleSheet.absoluteFill, { opacity: letters[i].opacity, transform: [{ translateY: letters[i].translateY }] }]}
        >
          <Svg width={LETTERING_SIZE.width} height={LETTERING_SIZE.height} viewBox={LETTERING.viewBox}>{p}</Svg>
        </Animated.View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  band: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
  at: { position: 'absolute' }
})
