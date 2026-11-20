// Pill track for a short choice on the music sheet. Underline tabs stay in
// Segmented, and the active item stays a flat card fill.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { tap } from './haptics'
import { useStyles } from './ThemeProvider'
import { radius, space, type } from './theme'

// options: [{ id, label }].
export function SegmentedControl ({ options, selected, onSelect }) {
  const styles = useStyles(makeStyles)
  const list = Array.isArray(options) ? options : []
  return (
    <View style={styles.track} accessibilityRole='tablist'>
      {list.map((option) => {
        const on = option.id === selected
        return (
          <Pressable
            key={option.id}
            accessibilityRole='tab'
            accessibilityState={{ selected: on }}
            aria-selected={on}
            accessibilityLabel={option.label}
            onPress={() => {
              if (!on) tap('select')
              onSelect(option.id)
            }}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            <View style={[styles.face, on && styles.faceOn]}>
              <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1} maxFontSizeMultiplier={1.5}>{option.label}</Text>
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  track: { flexDirection: 'row', minHeight: 48, paddingHorizontal: space.xs, borderRadius: radius.pill, backgroundColor: colors.inputOff },
  // The item spans the track's height and insets its face by 4 pt, so the
  // touch covers the whole 48 pt row; react-native-web drops hitSlop.
  item: { flex: 1, paddingVertical: space.xs },
  face: { flex: 1, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  faceOn: { backgroundColor: colors.card },
  pressed: { opacity: 0.6 },
  label: { ...type.more, color: colors.soft, textAlign: 'center' },
  labelOn: { color: colors.ink }
})
