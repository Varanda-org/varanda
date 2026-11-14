// A horizontal row of filter chips (Todas, Não lidas, ...). One is selected;
// each chip is a 44 pt tall touch target with accessibilityState.selected.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { tap } from './haptics'
import { useStyles } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

// options: [{ id, label, count? }]. A count above zero shows after the label.
export function FilterChips ({ options, selected, onSelect }) {
  const styles = useStyles(makeStyles)
  const list = Array.isArray(options) ? options : []
  return (
    <View style={styles.wrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps='handled'>
        {list.map((option) => {
          const on = option.id === selected
          const count = Number.isInteger(option.count) && option.count > 0 ? option.count : 0
          return (
            <Pressable
              key={option.id}
              accessibilityRole='button'
              accessibilityState={{ selected: on }}
              accessibilityLabel={option.label + (count > 0 ? ', ' + count : '')}
              onPress={() => {
                if (!on) tap('select')
                onSelect(option.id)
              }}
              style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
            >
              <View style={[styles.chip, on && styles.chipOn]}>
                <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1}>{option.label + (count > 0 ? ' ' + count : '')}</Text>
              </View>
            </Pressable>
          )
        })}
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { borderBottomWidth: 1, borderBottomColor: colors.line },
  row: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm, alignItems: 'center' },
  hit: { minHeight: layout.hit, justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  label: { ...type.pill, color: colors.ink },
  labelOn: { color: colors.bg, fontWeight: '700' }
})
