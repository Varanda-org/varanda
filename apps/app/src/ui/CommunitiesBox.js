// CommunitiesBox: a titled strip of community chips under the profile actions
// (like highlights), with 'Ver todas (N)' opening a sheet with every one when
// there are more than fit. Hidden when empty. items: [{ community, name }];
// names are peer text, so they pass through displayText here.

import { useState } from 'react'
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { Sheet } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

export const STRIP_MAX = 8

export function CommunitiesBox ({ items, total, title, onOpen, onAll }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { width } = useWindowDimensions()
  const [all, setAll] = useState(false)
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return null
  const count = Number.isInteger(total) && total > list.length ? total : list.length
  const open = (item) => {
    setAll(false)
    if (typeof onOpen === 'function') onOpen(item.community)
  }
  const showAll = () => {
    if (typeof onAll === 'function') onAll()
    setAll(true)
  }
  // A chip may take almost the whole width (the strip scrolls), so a name
  // with large text wraps to two lines instead of being cut.
  const chipMax = { maxWidth: Math.max(160, width - 2 * space.lg) }
  const chip = (item) => {
    const name = displayText(item.name)
    return (
      <PressScale
        key={item.community}
        accessibilityRole='button'
        accessibilityLabel={name}
        onPress={() => open(item)}
        style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
      >
        <View style={[styles.chip, chipMax]}>
          <Icon name='gente' size={18} color={colors.soft} />
          <Text style={styles.chipText} numberOfLines={2}>{name}</Text>
        </View>
      </PressScale>
    )
  }
  return (
    <View style={styles.wrap}>
      <Text style={styles.title} accessibilityRole='header'>{title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps='handled'>
        {list.slice(0, STRIP_MAX).map(chip)}
        {count > STRIP_MAX
          ? (
            <PressScale
              accessibilityRole='button'
              accessibilityLabel={'Ver todas (' + count + ')'}
              onPress={showAll}
              style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
            >
              <View style={styles.chip}>
                <Text style={styles.allText} numberOfLines={1}>{'Ver todas (' + count + ')'}</Text>
              </View>
            </PressScale>
            )
          : null}
      </ScrollView>
      <Sheet open={all} onClose={() => setAll(false)} title={title}>
        <ScrollView style={styles.sheetList}>
          {list.map((item) => (
            <PressScale
              key={item.community}
              accessibilityRole='button'
              accessibilityLabel={displayText(item.name)}
              onPress={() => open(item)}
              style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
            >
              <Icon name='gente' size={22} color={colors.soft} />
              <Text style={styles.sheetText} numberOfLines={2}>{displayText(item.name)}</Text>
            </PressScale>
          ))}
        </ScrollView>
      </Sheet>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { paddingTop: space.md, paddingBottom: space.sm, gap: space.xs },
  title: { ...type.section, color: colors.soft, paddingHorizontal: space.lg },
  row: { paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' },
  hit: { minHeight: layout.hit, justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  chip: {
    // Grows with large text instead of cutting the name; the strip scrolls.
    minHeight: 40,
    paddingVertical: space.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card
  },
  chipText: { ...type.pill, color: colors.ink, flexShrink: 1 },
  allText: { ...type.pill, color: colors.accent },
  sheetList: { maxHeight: 480 },
  sheetRow: { minHeight: layout.hit, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  sheetText: { ...type.postName, color: colors.ink, flexShrink: 1 }
})
