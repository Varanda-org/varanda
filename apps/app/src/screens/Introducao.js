// First-run intro cards, shown once per device before the Termos gate. Buttons
// alone navigate (swipe and arrow keys are extras). Presentation only: it
// never records anything, the caller does that from onDone.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { INTRO_CARDS } from '../intro'
import { Icon } from '../ui/Icon'
import { Body, Btn, Title, colors } from '../ui'
import { layout } from '../ui/theme'

const SKIP_LABEL = 'Pular'
const BACK_LABEL = 'Voltar'
const NEXT_LABEL = 'Próximo'
const START_LABEL = 'Começar'

function announcement (index) {
  return 'Cartão ' + (index + 1) + ' de ' + INTRO_CARDS.length + ': ' + INTRO_CARDS[index].title
}

export default function Introducao ({ onDone, sidePad = 0, edges }) {
  const [width, setWidth] = useState(0)
  const [index, setIndex] = useState(0)
  const [reduceMotion, setReduceMotion] = useState(false)
  const scroller = useRef(null)
  const done = useRef(false)
  const last = INTRO_CARDS.length - 1

  useEffect(() => {
    let alive = true
    try {
      Promise.resolve(AccessibilityInfo.isReduceMotionEnabled())
        .then((on) => { if (alive) setReduceMotion(on === true) })
        .catch(() => {})
    } catch {}
    return () => { alive = false }
  }, [])

  const finish = useCallback(() => {
    if (done.current) return
    done.current = true
    if (typeof onDone === 'function') onDone()
  }, [onDone])

  // While a button-driven scroll animates, the intermediate offsets still
  // round to the previous card; they must not pull the index back. The web
  // ScrollView never reports a drag or a momentum end, so a gesture that
  // interrupts the animation would leave the target set: a timer clears it.
  const target = useRef(null)
  const targetTimer = useRef(null)
  useEffect(() => () => clearTimeout(targetTimer.current), [])

  const lastX = useRef(0)
  const syncIndex = useCallback((x) => {
    lastX.current = x
    if (width <= 0) return
    if (target.current !== null) {
      if (Math.abs(x - target.current * width) > 1) return
      target.current = null
    }
    const next = Math.min(last, Math.max(0, Math.round(x / width)))
    setIndex(next)
  }, [width, last])

  const goTo = useCallback((i) => {
    const next = Math.min(last, Math.max(0, i))
    setIndex(next)
    if (scroller.current && width > 0) {
      target.current = reduceMotion ? null : next
      clearTimeout(targetTimer.current)
      if (!reduceMotion) {
        targetTimer.current = setTimeout(() => {
          target.current = null
          setIndex(Math.min(last, Math.max(0, Math.round(lastX.current / width))))
        }, 800)
      }
      scroller.current.scrollTo({ x: next * width, y: 0, animated: !reduceMotion })
    }
  }, [width, last, reduceMotion])

  // accessibilityLiveRegion is Android-only; VoiceOver needs an announcement.
  const announced = useRef(false)
  useEffect(() => {
    if (!announced.current) { announced.current = true; return }
    if (Platform.OS !== 'ios') return
    try { AccessibilityInfo.announceForAccessibility(announcement(index)) } catch {}
  }, [index])

  // A new width (rotation, split screen) keeps the current card in place: the
  // pages resize but the scroll offset would stay at the old pixel position.
  const indexRef = useRef(0)
  indexRef.current = index
  useEffect(() => {
    if (scroller.current && width > 0) scroller.current.scrollTo({ x: indexRef.current * width, y: 0, animated: false })
  }, [width])

  const onKeyDown = Platform.OS === 'web'
    ? (event) => {
        const key = event && event.nativeEvent ? event.nativeEvent.key : event && event.key
        if (key === 'ArrowRight') goTo(index + 1)
        else if (key === 'ArrowLeft') goTo(index - 1)
      }
    : undefined

  return (
    <SafeAreaView style={[styles.root, { paddingHorizontal: sidePad }]} edges={edges}>
      <View style={styles.flex} onKeyDown={onKeyDown}>
        <View style={styles.top}>
          {index < last
            ? (
              <Pressable accessibilityRole='button' onPress={finish} hitSlop={8} style={({ pressed }) => [styles.skip, pressed && styles.pressed]}>
                <Text style={styles.skipText}>{SKIP_LABEL}</Text>
              </Pressable>
              )
            : null}
        </View>
        <ScrollView
          ref={scroller}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          style={styles.flex}
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          onScroll={(event) => syncIndex(event.nativeEvent.contentOffset.x)}
          onScrollBeginDrag={() => { target.current = null }}
          onMomentumScrollEnd={(event) => { target.current = null; syncIndex(event.nativeEvent.contentOffset.x) }}
        >
          {INTRO_CARDS.map((card, i) => (
            <ScrollView
              key={card.id}
              style={{ width }}
              contentContainerStyle={styles.pageContent}
              accessibilityElementsHidden={i !== index}
              importantForAccessibility={i === index ? 'auto' : 'no-hide-descendants'}
            >
              {/* react-native-web ignores the two props above; aria-hidden is what it emits. */}
              <View style={styles.column} aria-hidden={i !== index}>
                <View style={styles.circle}>
                  <Icon name={card.icon} size={56} color={colors.accent} />
                </View>
                <Title>{card.title}</Title>
                <Body style={styles.body}>{card.body}</Body>
              </View>
            </ScrollView>
          ))}
        </ScrollView>
        <Text style={styles.hidden} accessibilityLiveRegion='polite'>{announcement(index)}</Text>
        <View style={styles.footer}>
          <View style={styles.dots} accessible={false} importantForAccessibility='no-hide-descendants'>
            {INTRO_CARDS.map((card, i) => (
              <View key={card.id} style={[styles.dot, i === index ? styles.dotActive : i < index ? styles.dotDone : styles.dotPending]} />
            ))}
          </View>
          <View style={styles.actions}>
            <View style={styles.side}>
              {index > 0 ? <Btn secondary label={BACK_LABEL} onPress={() => goTo(index - 1)} /> : null}
            </View>
            <Btn label={index === last ? START_LABEL : NEXT_LABEL} onPress={index === last ? finish : () => goTo(index + 1)} />
          </View>
        </View>
      </View>
      <StatusBar style='dark' />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  top: { minHeight: 48, alignItems: 'flex-end', justifyContent: 'center', paddingHorizontal: 16 },
  skip: { paddingVertical: 8, paddingHorizontal: 8, minHeight: 40, justifyContent: 'center' },
  skipText: { fontSize: 15, fontWeight: '700', color: colors.soft },
  pressed: { opacity: 0.7 },
  pageContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  column: { width: '100%', maxWidth: layout.column, alignSelf: 'center', alignItems: 'center', gap: 16 },
  circle: { width: 112, height: 112, borderRadius: 56, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  body: { textAlign: 'center' },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  footer: { width: '100%', maxWidth: layout.column, alignSelf: 'center', paddingHorizontal: 24, paddingBottom: 24, gap: 20 },
  dots: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotActive: { backgroundColor: colors.accent },
  dotDone: { backgroundColor: colors.accent, opacity: 0.5 },
  dotPending: { backgroundColor: colors.line },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  side: { minWidth: 96 }
})
