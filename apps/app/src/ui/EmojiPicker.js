// A compact emoji panel for the composer, drawn inline under the text (no
// second modal over the sheet): a row of group tabs (../emoji.js
// EMOJI_GROUPS) and a grid of 44px targets, each labelled with its name.
// onPick(emoji) inserts; the composer checks the length limit.

import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { EMOJI_GROUPS } from '../emoji'
import { colors } from './theme'

export function EmojiPicker ({ open, onPick }) {
  const [group, setGroup] = useState(0)
  if (!open) return null
  const current = EMOJI_GROUPS[group] || EMOJI_GROUPS[0]
  return (
    <View style={styles.panel} accessibilityLabel='emojis'>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} keyboardShouldPersistTaps='handled'>
        {EMOJI_GROUPS.map((g, i) => (
          <Pressable
            key={g.label}
            accessibilityRole='tab'
            accessibilityState={{ selected: i === group }}
            onPress={() => setGroup(i)}
            style={[styles.tab, i === group && styles.tabOn]}
          >
            <Text style={[styles.tabText, i === group && styles.tabTextOn]}>{g.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.grid}>
        {current.emojis.map((item) => (
          <Pressable
            key={item.e}
            accessibilityRole='button'
            accessibilityLabel={item.name}
            onPress={() => onPick(item.e)}
            style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
          >
            <Text style={styles.emoji}>{item.e}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.bg
  },
  tabs: { gap: 6, paddingHorizontal: 8, paddingBottom: 6 },
  tab: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, minHeight: 32, justifyContent: 'center' },
  tabOn: { backgroundColor: colors.accentSoft },
  tabText: { fontSize: 13, lineHeight: 16, fontWeight: '600', color: colors.soft },
  tabTextOn: { color: colors.accent },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 4 },
  cell: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  pressed: { backgroundColor: colors.accentSoft },
  emoji: { fontSize: 26, lineHeight: 32 }
})
