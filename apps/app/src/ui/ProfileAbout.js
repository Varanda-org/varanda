// The "Sobre mim" link under the profile bio and the sheet it opens.

import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Icon } from './Icon'
import { PressScale } from './PressScale'
import { Sheet } from './Sheet'
import { useStyles, useTheme } from './ThemeProvider'
import { layout, space, type } from './theme'

export function AboutLink ({ label, hint, onPress }) {
  const styles = useStyles(makeStyles)
  const { colors } = useTheme()
  return (
    <PressScale
      onPress={onPress}
      accessibilityRole='button'
      accessibilityLabel={label + (hint ? ', ' + hint : '')}
      style={styles.link}
    >
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <Icon name='seta' size={16} color={colors.accent} />
        {hint ? <Text style={styles.hint} numberOfLines={1}>{hint}</Text> : null}
      </View>
    </PressScale>
  )
}

export function AboutSheet ({ open, onClose, title, children }) {
  const styles = useStyles(makeStyles)
  return (
    <Sheet open={open} onClose={onClose} title={title} closeLabel='Fechar'>
      <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.body}>
        {children}
      </ScrollView>
    </Sheet>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  link: { minHeight: layout.hit, alignSelf: 'flex-start', maxWidth: '100%', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  label: { ...type.more, color: colors.accent },
  hint: { ...type.postMeta, color: colors.soft, flexShrink: 1 },
  body: { paddingVertical: space.lg, gap: space.md }
})
