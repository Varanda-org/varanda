// The eight profile themes as swatches, plus "Padrão" (the usual sunset band).
// Each swatch is a 44 pt target that shows the band color of the current
// scheme with the accent as a dot; the chosen one gets a ring and a check.

import { StyleSheet, Text, View } from 'react-native'
import { THEMES, themeColors } from '../profileThemes.js'
import { TEXTS } from '../profileExtraView.js'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { layout, radius, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function ThemePicker ({ value, onChange, disabled = false }) {
  const styles = useStyles(makeStyles)
  const { scheme, colors } = useTheme()
  const options = [{ id: null, label: TEXTS.themeNone }, ...THEMES.map((t) => ({ id: t.id, label: t.label }))]
  return (
    <View style={styles.row} accessibilityRole='radiogroup' accessibilityLabel={TEXTS.themeTitle}>
      {options.map((o) => {
        const selected = (value || null) === o.id
        const c = o.id === null ? null : themeColors(o.id, scheme)
        return (
          <PressScale
            key={o.id || 'padrao'}
            accessibilityRole='radio'
            accessibilityLabel={'Tema ' + o.label}
            accessibilityState={{ selected, checked: selected }}
            disabled={disabled}
            onPress={() => onChange(o.id)}
            style={[styles.item, disabled && styles.off]}
          >
            <View style={[styles.swatch, selected && styles.swatchOn, { backgroundColor: c === null ? colors.warm : c.band }]}>
              {c === null ? <View style={styles.sun} /> : <View style={[styles.dot, { backgroundColor: c.accent }]} />}
              {selected ? <View style={styles.check}><Icon name='ok' size={14} color={colors.accentInk} /></View> : null}
            </View>
            <Text style={[styles.label, selected && styles.labelOn]} numberOfLines={1}>{o.label}</Text>
          </PressScale>
        )
      })}
    </View>
  )
}

const SIZE = layout.hit + 4

const makeStyles = (colors) => StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  item: { alignItems: 'center', minWidth: layout.hit + space.md, minHeight: layout.hit, gap: space.xs },
  off: { opacity: 0.5 },
  swatch: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.line },
  swatchOn: { borderColor: colors.accent },
  dot: { width: 16, height: 16, borderRadius: 8 },
  sun: { width: 16, height: 16, borderRadius: 8, backgroundColor: '#e8805a' },
  check: { position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: radius.pill, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  label: { ...type.caption, color: colors.soft },
  labelOn: { color: colors.ink, fontWeight: '700' }
})
