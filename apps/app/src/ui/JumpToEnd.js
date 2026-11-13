import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { useStyles, useTheme } from './ThemeProvider'
import { type } from './theme'

export function JumpToEnd ({ count = 0, onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <View pointerEvents='box-none' style={styles.anchor}>
      <Pressable accessibilityRole='button' accessibilityLabel='ir para o fim' accessibilityHint={count > 0 ? count + ' novas' : undefined} onPress={onPress} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
        <Icon name='escolher' size={24} color={colors.accent} />
        {count > 0 ? <View style={styles.badge}><Text style={styles.text}>{count + ' novas'}</Text></View> : null}
      </Pressable>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  anchor: { height: 0, zIndex: 2, alignItems: 'flex-end' },
  button: { position: 'absolute', right: 16, bottom: 12, width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.outline, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', bottom: 40, right: 0, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: colors.accent },
  text: { ...type.caption, color: colors.accentInk },
  pressed: { opacity: 0.65 }
})
