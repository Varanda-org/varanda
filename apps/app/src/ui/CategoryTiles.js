import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { CAT_LABELS } from '../feira'
import { CATEGORY_ICONS } from '../feiraBrowse'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, space, type } from './theme'

const OPTIONS = [{ id: 'todas', label: 'Todas' }, ...Object.entries(CAT_LABELS).map(([id, label]) => ({ id, label }))]

export function CategoryTiles ({ value = 'todas', onChange }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps='handled'>
      {OPTIONS.map(({ id, label }) => (
        <PressScale
          key={id}
          accessibilityLabel={label}
          accessibilityState={{ selected: value === id }}
          onPress={() => onChange(id)}
          style={styles.tile}
        >
          <View style={[styles.disc, value === id && styles.selected]} accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
            <Icon name={id === 'todas' ? 'grade' : CATEGORY_ICONS[id]} color={value === id ? colors.bg : colors.ink} />
          </View>
          <Text style={styles.label} numberOfLines={1}>{label}</Text>
        </PressScale>
      ))}
    </ScrollView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.md },
  tile: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', gap: space.xs },
  disc: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  selected: { backgroundColor: colors.ink },
  label: { ...type.chip, color: colors.ink }
})
