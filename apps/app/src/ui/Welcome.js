// The 'entrar' step in screens/Identidade.js keeps the chair, one title and one
// line above its actions for the X/Threads idiom in apps/site/artwork/app-design.md.
// Help lives in the shell bar (App.js), leaving this first choice focused.

import { Image, StyleSheet, Text, View } from 'react-native'
import { fonts, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

// As in TopBar.js and Splash.js, cream keeps the chair's ink outline visible on dark.
const CHAIR_CREAM = '#fbf8f3'

export function WelcomeHeader ({ title, line, children }) {
  const styles = useStyles(makeStyles)
  const { scheme } = useTheme()
  return (
    <View style={styles.column}>
      <View style={styles.hero}>
        <View style={[styles.disc, scheme === 'dark' && styles.discDark]}>
          <Image source={require('../../assets/cadeira.png')} style={{ width: 96, height: 96 }} resizeMode='contain' accessible={false} />
        </View>
        <View style={styles.text}>
          <Text accessibilityRole='header' style={styles.title}>{title}</Text>
          {typeof line === 'string' && line !== '' ? <Text style={styles.line}>{line}</Text> : null}
        </View>
      </View>
      <View style={styles.actions}>{children}</View>
    </View>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  column: { width: '100%', maxWidth: 400, alignSelf: 'center', paddingHorizontal: space.xl, flexGrow: 1 },
  hero: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', minHeight: 200, paddingTop: space.lg, gap: space.lg },
  disc: { width: 112, height: 112, borderRadius: 56, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.accentSoft },
  discDark: { backgroundColor: CHAIR_CREAM },
  text: { gap: space.sm, alignItems: 'center' },
  title: { ...type.heroTitle, fontFamily: fonts.title, color: colors.ink, textAlign: 'center' },
  line: { fontSize: 16, lineHeight: 22, color: colors.soft, textAlign: 'center' },
  actions: { marginTop: space.xxl, gap: space.md }
})
