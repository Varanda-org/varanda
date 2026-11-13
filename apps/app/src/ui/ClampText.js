// Caption line cap and the "ver mais" control, used by PostRow.
// The decision lives in ../postClamp.js. The web build never calls
// onTextLayout (react-native-web 0.21), so the estimate stands there.
// Native reports the lines it drew. A count that fills the cap is the cut
// layout, not proof the rest fits, so that count is left out.
// The caller should pass the body's measured width from onLayout when available.

import { useCallback, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, useWindowDimensions } from 'react-native'
import { acceptMeasurement, clampPlan, refine } from '../postClamp.js'
import { TEXT_CAP } from './Sheet'
import { useStyles } from './ThemeProvider'
import { layout, space, type } from './theme'

const ROW_PADDING = space.lg * 2
// PostRow's avatar and gap also reduce the body's available text width.
const AVATAR_SIZE = 44
const AVATAR_GAP = 12

const CONTROL_LABELS = {
  mais: 'mais, ver texto completo',
  'ver mais': 'ver mais, texto completo',
  menos: 'menos, recolher texto'
}
// The web ignores hitSlop, so padding reaches the 44 pt target. Only the
// bottom half overlaps what follows (later siblings stay on top there); the
// top keeps its own space, so the control never covers the caption's last
// line, whose links and mentions must stay tappable.
const verticalHitSlop = Math.max(0, (layout.hit - type.more.lineHeight) / 2)

export function useClamp ({ text, hasMedia, width, forceExpanded } = {}) {
  const { width: windowWidth, fontScale } = useWindowDimensions()
  const defaultWidth = Math.min(windowWidth, layout.column) - ROW_PADDING - AVATAR_SIZE - AVATAR_GAP
  const textWidth = Number.isFinite(width) && width > 0 ? width : defaultWidth
  const [expanded, setExpanded] = useState(false)
  const [measuredLines, setMeasuredLines] = useState(undefined)
  const [prevText, setPrevText] = useState(text)
  const [prevWidth, setPrevWidth] = useState(textWidth)
  const [prevFontScale, setPrevFontScale] = useState(fontScale)
  // A layout event from a previous caption, width or scale must not count.
  const generation = useRef(0)

  const textChanged = text !== prevText
  // Layout widths jitter by fractions of a point; only a real change resets.
  const measurementChanged = textChanged || Math.abs(textWidth - prevWidth) >= 0.5 || fontScale !== prevFontScale
  if (measurementChanged) {
    generation.current += 1
    setPrevWidth(textWidth)
    setPrevFontScale(fontScale)
    setMeasuredLines(undefined)
  }
  if (textChanged) {
    setPrevText(text)
    setExpanded(false)
  }
  const layoutGeneration = generation.current
  const open = forceExpanded === true || (!textChanged && expanded)
  const measured = measurementChanged ? undefined : measuredLines
  const plan = clampPlan({
    text,
    hasMedia,
    width: textWidth,
    fontSize: type.postText.fontSize,
    fontScale,
    expanded: open
  })
  const view = refine(plan, measured)
  // The cap this render paints. The callback closes over it, so an event
  // from the cut text is not read as a later, uncapped measurement.
  const renderedCap = view.lines

  const onTextLayout = useCallback((event) => {
    if (generation.current !== layoutGeneration) return
    const lines = event && event.nativeEvent && event.nativeEvent.lines
    if (!Array.isArray(lines)) return
    const count = lines.length
    setMeasuredLines((prev) => acceptMeasurement({ prev, count, renderedCap }))
  }, [layoutGeneration, renderedCap])

  const toggle = useCallback(() => {
    setExpanded((value) => !value)
  }, [])

  return {
    // 0 leaves the caption uncapped.
    numberOfLines: view.lines,
    control: forceExpanded === true ? null : view.control,
    onTextLayout,
    toggle,
    expanded: open
  }
}

export function ClampControl ({ control, onPress }) {
  const styles = useStyles(makeStyles)
  if (control !== 'mais' && control !== 'ver mais' && control !== 'menos') return null
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={CONTROL_LABELS[control]}
      accessibilityState={{ expanded: control === 'menos' }}
      // react-native-web does not map accessibilityState.expanded.
      aria-expanded={control === 'menos'}
      onPress={onPress}
      style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
    >
      <Text style={styles.text} maxFontSizeMultiplier={TEXT_CAP}>{control}</Text>
    </Pressable>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  hit: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    minWidth: layout.hit,
    paddingVertical: verticalHitSlop,
    marginBottom: -verticalHitSlop
  },
  pressed: { opacity: 0.6 },
  text: { ...type.more, color: colors.accent }
})
