import { useState } from 'react'
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { Sheet } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type } from './theme'

export const STRIP_MAX = 8

export function PublicGroupsBox ({ items, title, note, onOpen }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const { width } = useWindowDimensions()
  const [all, setAll] = useState(false)
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return null

  const chipMax = { maxWidth: Math.max(160, width - 2 * space.lg) }
  const allLabel = 'Ver todos (' + list.length + ')'
  const open = (item) => {
    setAll(false)
    if (typeof onOpen === 'function') onOpen(item.group)
  }
  const groupButton = (item, inSheet) => {
    const name = displayText(item.name)
    const communityName = displayText(item.communityName)
    return (
      <PressScale
        key={item.group}
        accessibilityRole='button'
        accessibilityLabel={[name, communityName].filter(Boolean).join(', ')}
        onPress={() => open(item)}
        style={styles.hit}
      >
        <View style={[styles.groupRow, inSheet ? styles.sheetRow : [styles.chip, chipMax]]}>
          <Icon name='gente' size={inSheet ? 22 : 18} color={colors.soft} />
          <View style={styles.names}>
            <Text style={styles.name} numberOfLines={2}>{name}</Text>
            <Text style={styles.community} numberOfLines={1}>{communityName}</Text>
          </View>
        </View>
      </PressScale>
    )
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title} accessibilityRole='header'>{title}</Text>
      {note ? <Text style={styles.note}>{note}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps='handled'>
        {list.slice(0, STRIP_MAX).map((item) => groupButton(item, false))}
        {list.length > STRIP_MAX
          ? (
            <PressScale accessibilityRole='button' accessibilityLabel={allLabel} onPress={() => setAll(true)} style={styles.hit}>
              <View style={[styles.chip, chipMax]}>
                <Text style={styles.allText}>{allLabel}</Text>
              </View>
            </PressScale>
            )
          : null}
      </ScrollView>
      <Sheet open={all} onClose={() => setAll(false)} title={title} closeLabel='Fechar'>
        <ScrollView style={styles.sheetList} keyboardShouldPersistTaps='handled'>
          {list.map((item) => groupButton(item, true))}
        </ScrollView>
      </Sheet>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  wrap: { paddingTop: space.md, paddingBottom: space.sm, gap: space.xs },
  title: { ...type.section, color: colors.soft, paddingHorizontal: space.lg },
  note: { ...type.meta, color: colors.soft, paddingHorizontal: space.lg },
  row: { paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' },
  hit: { minWidth: layout.hit, minHeight: layout.hit, justifyContent: 'center' },
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chip: {
    minHeight: 40,
    justifyContent: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card
  },
  names: { flexShrink: 1 },
  name: { ...type.pill, color: colors.ink },
  community: { ...type.caption, color: colors.soft },
  allText: { ...type.pill, color: colors.accent },
  sheetList: { maxHeight: 480 },
  sheetRow: { paddingHorizontal: space.lg, paddingVertical: space.sm }
})
