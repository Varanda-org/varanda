// A compact emoji panel for the composer, drawn inline under the text (no
// second modal over the sheet): a search field that filters by name, a row of
// group tabs (../emoji.js EMOJI_GROUPS) and a grid of 44px targets, each
// labelled with its name; the grid scrolls inside the panel.
// onPick(emoji) inserts; the composer checks the length limit.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { EMOJI_GROUPS, filterEmoji } from '../emoji'
import { useStyles, useTheme } from './ThemeProvider'

const EMPTY = 'Nenhum emoji encontrado'

export function EmojiPicker ({ open, onPick }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [group, setGroup] = useState(0)
  const [query, setQuery] = useState('')
  const searchFocused = useRef(false)
  const dismissOnClose = useRef(false)
  // Android may keep the IME up when a focused field is unmounted, and the
  // unmount can blur the field before the effects run, so the focus is read
  // here, during the render that closes the panel. Only our own field counts,
  // so the composer's keyboard is left alone.
  if (!open && searchFocused.current) dismissOnClose.current = true
  // Reopening starts with a clean search; the chosen group is kept.
  useEffect(() => {
    if (open) return
    setQuery('')
    if (dismissOnClose.current) {
      dismissOnClose.current = false
      searchFocused.current = false
      Keyboard.dismiss()
    }
  }, [open])
  // The sheet can drop the panel while it is still open. A layout cleanup
  // runs before the field's own unmount blur clears searchFocused.
  useLayoutEffect(() => () => {
    if (searchFocused.current) Keyboard.dismiss()
  }, [])
  const hits = open ? filterEmoji(query) : null
  const none = open && hits !== null && hits.length === 0
  // iOS has no accessibilityLiveRegion, so the empty result is spoken here.
  useEffect(() => {
    if (none && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(EMPTY)
  }, [none])
  if (!open) return null
  const current = EMOJI_GROUPS[group] || EMOJI_GROUPS[0]
  const shown = hits || current.emojis
  return (
    <View style={styles.panel} accessibilityLabel='emojis'>
      <TextInput
        value={query}
        onChangeText={setQuery}
        onFocus={() => { searchFocused.current = true }}
        onBlur={() => { searchFocused.current = false }}
        placeholder='buscar emoji'
        placeholderTextColor={colors.placeholder}
        accessibilityLabel='buscar emoji'
        autoCorrect={false}
        autoCapitalize='none'
        spellCheck={false}
        returnKeyType='search'
        style={styles.search}
      />
      {hits === null && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} keyboardShouldPersistTaps='handled' accessibilityRole='tablist'>
          {EMOJI_GROUPS.map((g, i) => (
            <Pressable
              key={g.label}
              accessibilityRole='tab'
              accessibilityState={{ selected: i === group }}
              aria-selected={i === group}
              onPress={() => setGroup(i)}
              style={[styles.tab, i === group && styles.tabOn]}
            >
              <Text style={[styles.tabText, i === group && styles.tabTextOn]}>{g.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {/* Mounted before its text changes: a live region inserted together with its text is often not announced. */}
      <Text style={none ? styles.empty : styles.hidden} accessibilityLiveRegion='polite' aria-live='polite'>{none ? EMPTY : ''}</Text>
      {/* A new key remounts the grid at the top when its rows change. */}
      <ScrollView key={hits ? 'q:' + query.trim() : 'g:' + group} style={styles.scroll} nestedScrollEnabled keyboardShouldPersistTaps='handled'>
        {shown.length === 0
          ? null
          : (
            <View style={styles.grid}>
              {shown.map((item) => (
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
            )}
      </ScrollView>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  panel: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.bg
  },
  search: {
    height: 36,
    borderRadius: 10,
    paddingHorizontal: 10,
    marginHorizontal: 8,
    marginBottom: 6,
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line
  },
  tabs: { gap: 6, paddingHorizontal: 8, paddingBottom: 6 },
  tab: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, minHeight: 44, justifyContent: 'center' },
  tabOn: { backgroundColor: colors.accentSoft },
  tabText: { fontSize: 13, lineHeight: 16, fontWeight: '600', color: colors.soft },
  tabTextOn: { color: colors.accent },
  scroll: { maxHeight: 220 },
  empty: { color: colors.soft, fontSize: 14, padding: 12 },
  hidden: { height: 0 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 4 },
  cell: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  pressed: { backgroundColor: colors.accentSoft },
  emoji: { fontSize: 26, lineHeight: 32 }
})
