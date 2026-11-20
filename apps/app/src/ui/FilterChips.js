// A horizontal row of filter chips (Todas, Não lidas, ...). One is selected;
// each chip is a 44 pt tall touch target with accessibilityState.selected.

import { ScrollView, StyleSheet, View } from 'react-native'
import { Chip } from './Chip'
import { tap } from './haptics'
import { useStyles } from './ThemeProvider'
import { space } from './theme'

// options: [{ id, label, count? }]. A count above zero shows after the label.
export function FilterChips ({ options, selected, onSelect }) {
  const styles = useStyles(makeStyles)
  const list = Array.isArray(options) ? options : []
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps='handled'>
        {list.map((option) => {
          const on = option.id === selected
          const count = Number.isInteger(option.count) && option.count > 0 ? option.count : 0
          return (
            <Chip
              key={option.id}
              label={option.label + (count > 0 ? ' ' + count : '')}
              selected={on}
              accessibilityLabel={option.label + (count > 0 ? ', ' + count : '')}
              onPress={() => {
                if (!on) tap('select')
                onSelect(option.id)
              }}
            />
          )
        })}
      </ScrollView>
    </View>
  )
}

const makeStyles = () => StyleSheet.create({
  row: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm, alignItems: 'center' }
})
