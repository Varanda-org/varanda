// The signup invite card, opened before the intro cards on a first visit
// (App.js decides when, through inviteCardCopy.js openingGate). Entrar goes
// on to the terms gate as the intro's last card would; Como funciona shows
// the intro cards and comes back here; Agora não hides the card for this
// load only. The welcome stage and header around the card are decoration and
// app copy; the name, message and username are peer text and are rendered
// only inside InviteCard. Coming back from Como funciona mounts this screen
// again, so the welcome plays again: intended, nothing is stored.

import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { statusBarStyle } from '../appearance'
import { artFor } from '../inviteCardArt'
import { ENTER_LABEL, HOW_LABEL, LATER_LABEL } from '../inviteCardCopy'
import { regionOf } from '../inviteWelcomeCopy'
import { welcomeBands } from '../inviteWelcomeStage'
import { InviteCard } from './InviteCard'
import { InviteWelcomeHeader, InviteWelcomeStage, useWelcomeEntrance } from './InviteWelcome'
import { Btn } from './index'
import { layout, space } from './theme'
import { useStyles, useTheme } from './ThemeProvider'

export function InviteCardOpen ({ card, username = null, expiryText = '', onEnter, onHow, onLater, sidePad = 0, edges }) {
  const styles = useStyles(makeStyles)
  const { scheme } = useTheme()
  const win = useWindowDimensions()
  // The window is a first guess until the stage reports its own size.
  const [box, setBox] = useState(null)
  const onLayout = (e) => {
    const { width: w, height: h } = e.nativeEvent.layout
    setBox((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }))
  }
  const art = artFor(card.design)
  const key = scheme === 'dark' ? 'dark' : 'light'
  const bg = art.bg[key]
  const ink = art.ink[key]
  const size = box || win
  const bands = welcomeBands(size.width, size.height)
  const entrance = useWelcomeEntrance(regionOf(card.design), box !== null)
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: bg, paddingHorizontal: sidePad }]} edges={edges}>
      <View style={styles.stage} onLayout={onLayout}>
        <InviteWelcomeStage design={card.design} box={box} entrance={entrance} />
        <ScrollView contentContainerStyle={[styles.content, { paddingTop: Math.max(bands.top, space.lg), paddingBottom: Math.max(bands.bottom, space.lg) }]}>
          <View style={styles.column}>
            <InviteWelcomeHeader design={card.design} entrance={entrance} bg={bg} ink={ink} />
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
      </View>
      <StatusBar style={statusBarStyle(scheme)} />
    </SafeAreaView>
  )
}

const makeStyles = (colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  stage: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: space.lg },
  column: { width: '100%', maxWidth: layout.column, alignSelf: 'center', alignItems: 'center' },
  actions: { gap: space.sm, marginTop: space.sm },
  links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: space.sm },
  link: { minHeight: layout.hit, justifyContent: 'center', paddingHorizontal: space.xs },
  linkText: { fontSize: 15, fontWeight: '700', color: colors.ink },
  pressed: { opacity: 0.6 }
})
