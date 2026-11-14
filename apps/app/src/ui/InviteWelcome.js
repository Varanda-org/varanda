// The regional welcome around a personal invite card: motifs of the design
// arrive around the screen and a short header rises above the card, once per
// mount. The choreography and its gates live in ../inviteWelcomeMotion.js;
// this file only binds them to Animated values. Everything here is decoration
// and app copy: the peer text stays inside InviteCard.

import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View } from 'react-native'
import { INVITE_CARD_MAX_WIDTH, Shape } from './InviteCardFrame'
import { layoutMotif, motifsFor, welcomeStage } from '../inviteWelcomeStage'
import { MAX_MOTIFS, WELCOME_BEZIER, createEntrance, motifMotion, welcomeMotion } from '../inviteWelcomeMotion'
import { regionOf, welcomeCopy } from '../inviteWelcomeCopy'
import { tap } from './haptics'
import { useTheme } from './ThemeProvider'
import { radius, space, type } from './theme'

// The native driver is a platform API that react-native-web does not have;
// this picks the driver only, never the behaviour.
const native = Platform.OS !== 'web'

// react-native-web 0.21 reads only aria-hidden; native reads the other two.
const hiddenFromReaders = {
  'aria-hidden': true,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants'
}

export function useWelcomeEntrance (region, measured) {
  const values = useRef(null)
  if (values.current === null) {
    values.current = {
      p: Array.from({ length: MAX_MOTIFS }, () => new Animated.Value(0)),
      text: { tag: new Animated.Value(0), title: new Animated.Value(0), line: new Animated.Value(0) }
    }
  }
  // The stagger is read when the entrance starts, which can be after a prop change.
  const regionRef = useRef(region)
  regionRef.current = region
  const controller = useRef(null)
  // A settled scene renders at rest without the Animated values. On the native
  // driver a stopped animation reports its mid value back after setValue(1),
  // and a later commit would draw that pose.
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    const { p, text } = values.current
    const all = [...p, text.tag, text.title, text.line]
    let running = null
    const stop = () => {
      const composite = running
      running = null
      if (composite) composite.stop()
    }
    const entrance = createEntrance({
      // Promise.resolve keeps a platform that answers synchronously on the same path.
      query: () => Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()),
      subscribe: (cb) => {
        const s = AccessibilityInfo.addEventListener('reduceMotionChanged', cb)
        return () => s && typeof s.remove === 'function' && s.remove()
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle),
      play: (onFinished) => {
        const easing = Easing.bezier(...WELCOME_BEZIER)
        const beats = welcomeMotion(false)
        const timing = (value, { delay, duration }) => Animated.timing(value, {
          toValue: 1,
          delay,
          duration,
          easing,
          useNativeDriver: native,
          isInteraction: false
        })
        const composite = Animated.parallel([
          ...p.map((value, i) => timing(value, motifMotion(regionRef.current, i, 0, false))),
          timing(text.tag, beats.tag),
          timing(text.title, beats.title),
          timing(text.line, beats.line)
        ])
        running = composite
        composite.start(({ finished }) => {
          if (running === composite) running = null
          onFinished(finished)
        })
      },
      settle: () => {
        stop()
        for (const value of all) value.setValue(1)
        setSettled(true)
      },
      haptic: () => tap('success')
    })
    controller.current = entrance
    return () => {
      controller.current = null
      entrance.dispose()
      stop()
    }
  }, [])

  // Declared after the mount effect, so the controller exists when this first runs.
  useEffect(() => {
    if (controller.current) controller.current.measure(measured)
  }, [measured])

  return { ...values.current, settled }
}

const rest = (value, from) => value.interpolate({ inputRange: [0, 1], outputRange: [from, 0] })

export function InviteWelcomeStage ({ design, box, entrance }) {
  const { scheme } = useTheme()
  const slots = box ? welcomeStage({ design, width: box.width, height: box.height }).slots : []
  const motifs = motifsFor(design)
  const region = regionOf(design)
  return (
    <View style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]} pointerEvents='none' accessible={false} {...hiddenFromReaders}>
      {slots.map((slot) => {
        const value = entrance.p[slot.order]
        const m = motifMotion(region, slot.order, slot.side, false)
        const motif = layoutMotif(motifs[slot.variant], slot.size, scheme)
        const box = { position: 'absolute', left: slot.left, top: slot.top, width: slot.width, height: slot.height }
        return (
          <Animated.View
            key={slot.key}
            style={entrance.settled
              ? box
              : {
                  ...box,
                  opacity: value,
                  transform: [
                    { translateX: rest(value, m.from.translateX) },
                    { translateY: rest(value, m.from.translateY) },
                    { scale: value.interpolate({ inputRange: [0, 1], outputRange: [m.from.scale, 1] }) },
                    { rotate: value.interpolate({ inputRange: [0, 1], outputRange: [m.from.rotate + 'deg', '0deg'] }) }
                  ]
                }}
          >
            {motif.items.map((item, i) => <Shape key={i} item={item} />)}
          </Animated.View>
        )
      })}
    </View>
  )
}

const rise = (value, beat) => ({ opacity: value, transform: [{ translateY: rest(value, beat.from.translateY) }] })

// ink is the art ink, not colors.ink: the words sit on the design ground, and
// inviteCardArt.js pairs every ground with that ink (contrast pinned in
// test/inviteWelcomeStage.test.js).
export function InviteWelcomeHeader ({ design, entrance, bg, ink }) {
  const copy = welcomeCopy(design)
  const beats = welcomeMotion(false)
  const { tag, title, line } = entrance.text
  const at = (value, beat) => entrance.settled ? null : rise(value, beat)
  // The plate has the colour of the ground, so it is invisible, and it keeps
  // a motif from showing through the words when the content scrolls over the top row.
  return (
    <View style={[styles.plate, { backgroundColor: bg }]}>
      {typeof copy.tag === 'string'
        ? (
          <Animated.Text accessibilityLabel={copy.tagLabel} style={[styles.tag, { color: ink }, at(tag, beats.tag)]}>
            {copy.tag}
          </Animated.Text>
          )
        : null}
      <Animated.Text accessibilityRole='header' style={[styles.title, { color: ink }, at(title, beats.title)]}>
        {copy.title}
      </Animated.Text>
      <Animated.Text style={[styles.line, { color: ink }, at(line, beats.line)]}>
        {copy.line}
      </Animated.Text>
    </View>
  )
}

const styles = StyleSheet.create({
  plate: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: INVITE_CARD_MAX_WIDTH,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    marginBottom: space.md,
    alignItems: 'center',
    gap: space.xs
  },
  tag: { ...type.replyMark, fontWeight: '700', letterSpacing: 0.4, textAlign: 'center' },
  title: { ...type.profileName, fontSize: 26, lineHeight: 30, textAlign: 'center' },
  line: { ...type.postText, textAlign: 'center' }
})
