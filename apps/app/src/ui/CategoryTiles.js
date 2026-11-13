import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { CAT_LABELS } from '../feira'
import { CATEGORY_ICONS } from '../feiraBrowse'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

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
          style={[styles.tile, value === id && styles.selected]}
        >
          <View accessibilityElementsHidden importantForAccessibility='no-hide-descendants' aria-hidden>
            <Icon name={id === 'todas' ? 'grade' : CATEGORY_ICONS[id]} color={value === id ? colors.accent : colors.ink} />
          </View>
          <Text style={[styles.label, value === id && styles.labelSelected]}>{label}</Text>
        </PressScale>
      ))}
    </ScrollView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  row: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  tile: { minWidth: layout.hit, minHeight: layout.hit, alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.card },
  selected: { backgroundColor: colors.accentSoft },
  label: { ...type.chip, color: colors.ink },
  labelSelected: { color: colors.accent }
})
