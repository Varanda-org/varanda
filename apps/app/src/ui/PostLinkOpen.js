// The card a first visit sees when it opened a shared post link (App.js
// decides when, through postLink.js postOpeningGate). Entrar goes on to the
// terms gate as the intro's last card would; Como funciona shows the intro
// cards and comes back here; Agora não hides the card for this load only.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { statusBarStyle } from '../appearance'
import { ENTER_LABEL, HOW_LABEL, LATER_LABEL } from '../inviteCardCopy'
import { Btn } from './index'
import { fonts, layout, space, type } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function PostLinkOpen ({ onEnter, onHow, onLater, sidePad = 0, edges }) {
  const styles = useStyles(makeStyles)
  const { scheme } = useTheme()
  return (
    <SafeAreaView style={[styles.root, { paddingHorizontal: sidePad }]} edges={edges}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.column}>
          <Text accessibilityRole='header' style={styles.title}>Você abriu o link de uma publicação</Text>
          <Text style={styles.body}>Para ver, entre na Varanda ou crie sua conta. Pode ser preciso um convite.</Text>
          <View style={styles.actions}>
            <Btn block large label={ENTER_LABEL} onPress={onEnter} />
            <View style={styles.links}>
              <Pressable accessibilityRole='button' onPress={onHow} hitSlop={8} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
                <Text style={styles.linkText}>{HOW_LABEL}</Text>
              </Pressable>
              <Pressable accessibilityRole='button' onPress={onLater} hitSlop={8} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
                <Text style={styles.linkText}>{LATER_LABEL}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </ScrollView>
      <StatusBar style={statusBarStyle(scheme)} />
    </SafeAreaView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1, justifyContent: 'center', padding: space.lg },
  column: { width: '100%', maxWidth: layout.column, alignSelf: 'center', gap: space.sm },
  title: { ...type.heroTitle, fontFamily: fonts.title, color: colors.ink, textAlign: 'center' },
  body: { fontSize: 16, lineHeight: 22, color: colors.soft, textAlign: 'center' },
  actions: { gap: space.sm, marginTop: space.sm },
  links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: space.sm },
  link: { minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.xs },
  linkText: { fontSize: 15, fontWeight: '700', color: colors.ink },
  pressed: { opacity: 0.6 }
})
