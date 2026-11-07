// The signup invite card, opened before the intro cards on a first visit
// (App.js decides when, through inviteCardCopy.js openingGate). Entrar goes
// on to the terms gate as the intro's last card would; Como funciona shows
// the intro cards and comes back here; Agora não hides the card for this
// load only. The name, message and username are peer text: InviteCard runs
// them through displayText.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { statusBarStyle } from '../appearance'
import { ENTER_LABEL, HOW_LABEL, LATER_LABEL } from '../inviteCardCopy'
import { InviteCard } from './InviteCard'
import { Btn } from './index'
import { layout, space } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function InviteCardOpen ({ card, username = null, expiryText = '', onEnter, onHow, onLater, sidePad = 0, edges }) {
  const styles = useStyles(makeStyles)
  const { scheme } = useTheme()
  return (
    <SafeAreaView style={[styles.root, { paddingHorizontal: sidePad }]} edges={edges}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.column}>
          <InviteCard design={card.design} name={card.name} message={card.message} username={username} expiryText={expiryText}>
            <View style={styles.actions}>
              <Btn label={ENTER_LABEL} onPress={onEnter} />
              <View style={styles.links}>
                <Pressable accessibilityRole='button' onPress={onHow} hitSlop={8} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
                  <Text style={styles.linkText}>{HOW_LABEL}</Text>
                </Pressable>
                <Pressable accessibilityRole='button' onPress={onLater} hitSlop={8} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
                  <Text style={styles.linkText}>{LATER_LABEL}</Text>
                </Pressable>
              </View>
            </View>
          </InviteCard>
        </View>
      </ScrollView>
      <StatusBar style={statusBarStyle(scheme)} />
    </SafeAreaView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1, justifyContent: 'center', padding: space.lg },
  column: { width: '100%', maxWidth: layout.column, alignSelf: 'center', alignItems: 'center' },
  actions: { gap: space.sm, marginTop: space.sm },
  links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: space.sm },
  link: { minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.xs },
  linkText: { fontSize: 15, fontWeight: '700', color: colors.ink },
  pressed: { opacity: 0.6 }
})
