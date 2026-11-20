import { Component } from 'react'
import { StatusBar } from 'expo-status-bar'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { crashDetails } from '../crashReport'
import { signalCrash } from '../crashSignal'
import { runningRelease } from '../runningRelease'
import { copyText } from '../share'
import { shareNav } from '../shareNav'
import { announce, liveRegion } from './copyNote'
import { dropPreSplash } from './dropPreSplash'

// The same build Ajustes copies; Platform.OS is a value here, checked by buildInfo.
const BUILD = { kind: Platform.OS, commit: process.env.EXPO_PUBLIC_VARANDA_COMMIT, builtAt: process.env.EXPO_PUBLIC_VARANDA_BUILD_DATE, release: runningRelease() }

export const CRASH_TITLE = 'O Varanda parou'
export const CRASH_BODY = 'Algo deu errado e o app não consegue continuar. Feche o Varanda e abra de novo.'
export const CRASH_NOTE = 'Os detalhes dizem só a versão do app e o tipo do erro, nada do que você escreveu.'

// It sits outside ThemeProvider and SafeAreaProvider, so the colours are the
// light palette's, fixed, and the padding clears a status bar on its own.
// There is no retry: the app keeps its tree mounted on purpose (App.js), so a
// remount could start a second node over the first.
export class CrashBoundary extends Component {
  constructor (props) {
    super(props)
    this.state = { details: null, note: '' }
    this.copyTurn = 0
    this.noteTimer = null
    this.handleCopy = this.handleCopy.bind(this)
  }

  static getDerivedStateFromError (error) {
    return { details: crashDetails(error, BUILD) }
  }

  componentDidCatch () {
    signalCrash()
  }

  // A throw in the first render mounts the boundary already crashed; a later
  // one updates it.
  componentDidMount () {
    if (this.state.details !== null) dropPreSplash()
  }

  componentDidUpdate (prevProps, prevState) {
    if (prevState.details === null && this.state.details !== null) dropPreSplash()
  }

  componentWillUnmount () {
    clearTimeout(this.noteTimer)
  }

  async handleCopy () {
    const turn = ++this.copyTurn
    const ok = await copyText(shareNav(), this.state.details)
    if (turn !== this.copyTurn) return
    const note = ok ? 'Detalhes copiados.' : 'Não foi possível copiar.'
    this.setState({ note })
    announce(note)
    clearTimeout(this.noteTimer)
    this.noteTimer = setTimeout(() => this.setState({ note: '' }), 2000)
  }

  render () {
    if (this.state.details === null) return this.props.children
    return (
      <ScrollView style={styles.page} contentContainerStyle={styles.content}>
        <StatusBar style='dark' />
        <Text accessibilityRole='header' style={styles.title}>{CRASH_TITLE}</Text>
        <Text style={styles.body}>{CRASH_BODY}</Text>
        <Text style={styles.soft}>{CRASH_NOTE}</Text>
        <Text selectable style={styles.details}>{this.state.details}</Text>
        <Pressable
          accessibilityRole='button'
          onPress={this.handleCopy}
          style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
        >
          <Text style={styles.buttonText}>Copiar detalhes</Text>
        </Pressable>
        <View accessibilityLiveRegion={liveRegion}>
          <Text style={styles.soft}>{this.state.note}</Text>
        </View>
      </ScrollView>
    )
  }
}

export function withCrashBoundary (Root) {
  return function CrashSafeRoot (props) {
    return (
      <CrashBoundary>
        <Root {...props} />
      </CrashBoundary>
    )
  }
}

const PAPER = '#fbf8f3'
const INK = '#1f2a24'
const SOFT = '#4a554e'
const ACCENT = '#1d6b4f'
const ACCENT_INK = '#ffffff'
const LINE = 'rgba(31,42,36,0.10)'

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: PAPER },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingTop: 64, paddingBottom: 48, gap: 16 },
  title: { color: INK, fontSize: 24, fontWeight: '600', lineHeight: 32 },
  body: { color: INK, fontSize: 16, lineHeight: 24 },
  soft: { color: SOFT, fontSize: 14, lineHeight: 20 },
  details: { color: INK, fontSize: 13, lineHeight: 18, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: LINE },
  button: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 20, borderRadius: 999, backgroundColor: ACCENT },
  pressed: { opacity: 0.8 },
  buttonText: { color: ACCENT_INK, fontSize: 15, fontWeight: '600', lineHeight: 18 }
})
