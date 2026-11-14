import { useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { SEARCH_CLEAR } from '../topics'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, radius, space, type, webInputReset } from './theme'

export function SearchField ({ label, placeholder, value = '', onChangeText, maxLength, onSubmitEditing, inputRef, autoFocus = false, right, clearLabel = SEARCH_CLEAR }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  const [focused, setFocused] = useState(false)
  return (
    <View style={[styles.search, focused && styles.searchFocused]}>
      <Icon name='lupa' size={20} color={colors.soft} />
      <TextInput
        ref={inputRef}
        style={[styles.input, webInputReset]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder}
        accessibilityLabel={label}
        maxLength={maxLength}
        returnKeyType='search'
        onSubmitEditing={onSubmitEditing}
        autoFocus={autoFocus}
        autoCapitalize='none'
        autoCorrect={false}
        spellCheck={false}
      />
      {value !== ''
        ? (
          <Pressable accessibilityRole='button' accessibilityLabel={clearLabel} hitSlop={space.md} onPress={() => onChangeText('')} style={styles.clear}>
            <Icon name='fechar' size={18} color={colors.soft} />
          </Pressable>
          )
        : null}
      {right || null}
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    minHeight: layout.hit,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.inputOff
  },
  searchFocused: { borderColor: colors.accent, backgroundColor: colors.card },
  input: { ...type.postText, flex: 1, minWidth: 0, minHeight: layout.hit - 3, paddingVertical: 0, color: colors.ink },
  // The 44 pt target overlaps the 1.5 pt border instead of growing the field.
  clear: { minWidth: layout.hit, minHeight: layout.hit, marginVertical: -1.5, alignItems: 'center', justifyContent: 'center' }
})
