// The app shell: the first connection, the setup step (on the web's browser
// node first 'Entrar' with the passkey, then identity and member
// certificate) and then three tabs (A Rua, Seguindo, Diário) with the top
// bar and its sync chip, the publish button and the sheets (Publicar,
// Ajustes). Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { NodeProvider, useNode } from './src/node'
import { NamesProvider, useNames } from './src/names'
import { OutboxProvider, useOutbox, useOutboxDrain } from './src/outboxProvider'
import { Btn, ErrorText, Soft, colors, errorText } from './src/ui'
import { Fab } from './src/ui/Fab'
import { loadIcons } from './src/ui/Icon'
import { SyncChip } from './src/ui/SyncChip'
import { TabBar } from './src/ui/TabBar'
import { TopBar } from './src/ui/TopBar'
import { layout, type } from './src/ui/theme'
import Ajustes from './src/screens/Ajustes'
import ARua from './src/screens/ARua'
import Conexao from './src/screens/Conexao'
import Diario from './src/screens/Diario'
import Identidade from './src/screens/Identidade'
import Publicar from './src/screens/Publicar'
import Seguindo from './src/screens/Seguindo'

// Inlined by Expo at build time; set only for the iOS worklet gate
// (docs/ios-gate.md).
const GATE_URL = process.env.EXPO_PUBLIC_VARANDA_GATE_URL

const TOAST_MS = 2500

// True when node.info confirms an identity and a member certificate.
function setupComplete (info) {
  return info !== null && info.publicKey !== null && info.memberCert === true
}

function Member () {
  const node = useNode()
  const names = useNames()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const ready = node.phase === 'ready'
  // Once the node was ready the tree stays mounted for good: a disconnect,
  // another tab taking over or a restart only changes the sync chip, so
  // drafts survive.
  const [seen, setSeen] = useState(false)
  useEffect(() => { if (ready) setSeen(true) }, [ready])

  const [tab, setTab] = useState('rua')
  const [composer, setComposer] = useState({ open: false, reply: null })
  const [ajustes, setAjustes] = useState(null)
  const [version, setVersion] = useState(0)
  const [info, setInfo] = useState(null)
  const [infoError, setInfoError] = useState('')
  // Latched once node.info confirmed the identity and the certificate: a
  // later failed or slow read never hides the tabs again.
  const [setupDone, setSetupDone] = useState(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)

  // Stable (Identidade and Ajustes re-read node.info when it changes).
  const takeInfo = useCallback((i) => {
    setInfo(i)
    setInfoError('')
  }, [])

  // Browser node: the passkey identity. Every page load starts locked; the
  // tabs show only while it is unlocked and node.info is about that key.
  const passkey = node.passkey
  const pkStatus = passkey !== null ? passkey.status : null
  const locked = passkey !== null && (pkStatus === null || pkStatus.unlocked !== true)
  const generation = passkey !== null ? passkey.generation : 0
  const generationRef = useRef(generation)
  generationRef.current = generation

  const readInfo = useCallback(async () => {
    const gen = generationRef.current
    try {
      const i = await node.request('node.info', {})
      // A read sent before an unlock, lock or reset describes another key.
      if (gen === generationRef.current) takeInfo(i)
    } catch (err) {
      if (gen === generationRef.current) setInfoError(errorText(err))
    }
  }, [node.request, takeInfo])

  // Unlock, lock and reset change the identity: the info read before is
  // stale and the setup is confirmed again.
  useEffect(() => {
    setInfo(null)
    setInfoError('')
    setSetupDone(false)
  }, [generation])

  // With a passkey the setup step reads node.info through Identidade (which
  // holds it back while the sync after an unlock runs, since any member
  // request would preempt that run); the shell reads it once the tabs show.
  const shellReads = passkey === null || setupDone
  useEffect(() => { if (ready && !locked && shellReads) readInfo() }, [ready, locked, shellReads, generation, version, readInfo])

  const confirmed = setupComplete(info) &&
    (passkey === null || (!locked && pkStatus !== null && info.publicKey === pkStatus.publicKey))
  useEffect(() => { if (confirmed) setSetupDone(true) }, [confirmed])
  useEffect(() => {
    if (!locked) return
    setSetupDone(false)
    setInfo(null)
  }, [locked])
  const setupStep = locked || (!setupDone && !confirmed)

  // The feed carries only followed authors' names: look the own name up
  // once (one log.read through the names cache) for the Publicar avatar.
  const ownKey = info ? info.publicKey : null
  const { resolve } = names
  useEffect(() => { if (setupDone && ownKey) resolve(ownKey) }, [setupDone, ownKey, resolve])

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const showToast = (text) => {
    clearTimeout(toastTimer.current)
    setToast(text)
    toastTimer.current = setTimeout(() => setToast(''), TOAST_MS)
  }

  // The outbox (browser node) is sent only while a publish could go out
  // right now: unlocked, set up (the member certificate exists), not
  // recovering, online, and with no sync run active or starting (the write
  // gate inside post.create would preempt a run the person started).
  const outbox = useOutbox()
  useOutboxDrain({
    enabled: ready && !locked && setupDone && !(passkey && passkey.recovering) &&
      node.online !== false && node.sync.active === null && node.sync.starting !== true &&
      outbox.available,
    author: ownKey,
    association: node.config ? node.config.association : null
  })
  // A queued post went out: A Rua and Diário show it.
  const lastSent = outbox.lastSent
  const lastSentRef = useRef(lastSent.n)
  useEffect(() => {
    if (lastSent.n === lastSentRef.current) return
    lastSentRef.current = lastSent.n
    setVersion((v) => v + 1)
    showToast(lastSent.kind === 'reply' ? 'resposta publicada da fila de saída' : 'publicado da fila de saída')
  }, [lastSent])

  // The chip always opens Sincronizar; that screen offers Conexão when the
  // node is disconnected.
  const openChip = () => setAjustes('sincronizar')
  const startReply = (r) => setComposer({ open: true, reply: r })

  if (!ready && !seen) {
    // loading, connecting, the native Conectar form, or a web error.
    if (node.phase === 'loading' || (node.phase === 'connecting' && !node.canConfigure)) {
      return (
        <SafeAreaView style={styles.center} edges={['top', 'bottom']}>
          <Text style={styles.brand}>Varanda</Text>
          <Text style={styles.soft}>conectando…</Text>
          <StatusBar style='dark' />
        </SafeAreaView>
      )
    }
    return (
      <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
        <Conexao />
        <StatusBar style='dark' />
      </SafeAreaView>
    )
  }

  const chip = <SyncChip onPress={openChip} />
  const connectionLink = (
    <Pressable
      style={[styles.link, { paddingBottom: 14 + insets.bottom }]}
      accessibilityRole='button'
      accessibilityLabel='Conexão'
      onPress={() => setAjustes('conexao')}
      hitSlop={4}
    >
      <Text style={styles.linkText}>Conexão</Text>
    </Pressable>
  )

  // On a wide web window the setup step and the tabs share one centred column.
  const wide = Platform.OS === 'web' && width > layout.column
  let content
  if (setupStep) {
    // The first setup (identity, member certificate) before the tabs. The
    // tabs never render before a successful node.info confirms both.
    let body
    if (passkey !== null || info !== null) {
      // embedded: the top bar above already carries the 'Identidade' title
      body = <Identidade active={ready} embedded onInfo={takeInfo} />
    } else if (infoError) {
      body = (
        <View style={styles.setupBody}>
          <ErrorText>{infoError}</ErrorText>
          <Btn label='tentar de novo' onPress={readInfo} disabled={!ready} />
        </View>
      )
    } else {
      body = <View style={styles.setupBody}><Soft>carregando…</Soft></View>
    }
    content = (
      <View style={[styles.shell, wide && styles.shellWide]}>
        <TopBar title={locked ? 'Entrar' : 'Identidade'} right={chip} />
        <View style={styles.flex}>{body}</View>
        {connectionLink}
      </View>
    )
  } else {
    // The three tabs stay mounted (drafts and scroll survive a tab change);
    // `active` makes a screen reload its data when it is shown, and again
    // when the connection comes back.
    const on = (id) => tab === id && ready
    const shown = (id) => (tab === id ? styles.flex : styles.hidden)
    content = (
      <View style={[styles.shell, wide && styles.shellWide]}>
        {tab !== 'diario'
          ? <TopBar title={tab === 'rua' ? 'A Rua' : 'Seguindo'} right={chip} />
          : null}
        <View style={styles.flex}>
          <View style={shown('rua')}><ARua active={on('rua')} refresh={version} onReply={startReply} /></View>
          <View style={shown('seguindo')}><Seguindo active={on('seguindo')} /></View>
          <View style={shown('diario')}>
            <Diario active={on('diario')} refresh={version} onSettings={setAjustes} onReply={startReply} />
          </View>
        </View>
        {toast
          ? (
            <View style={[styles.toast, { bottom: layout.tabBar + insets.bottom + 12 }]} pointerEvents='none'>
              <Text style={styles.toastText} accessibilityRole='alert'>{toast}</Text>
            </View>
            )
          : null}
        <Fab onPress={() => setComposer((c) => ({ ...c, open: true }))} />
        <TabBar current={tab} onSelect={setTab} />
      </View>
    )
  }

  const me = {
    publicKey: info ? info.publicKey : null,
    name: info && info.publicKey ? (names.nameOf(info.publicKey) || null) : null
  }
  // Light over the Diário band. The sheets leave the status bar over the
  // (dimmed) screen behind, so they keep it light there too.
  const light = tab === 'diario' && !setupStep

  return (
    <View style={styles.root}>
      {content}
      <Publicar
        open={composer.open}
        reply={composer.reply}
        me={me}
        onClose={() => setComposer((c) => ({ ...c, open: false }))}
        onClearReply={() => setComposer((c) => ({ ...c, reply: null }))}
        onPublished={(kind, sentRef) => {
          // The reply context is dropped only if it is still the one sent.
          setComposer((c) => ({ open: false, reply: c.reply && c.reply.ref === sentRef ? null : c.reply }))
          // Kept in the outbox: nothing new in the diary yet.
          if (kind === 'queued-post' || kind === 'queued-reply') return showToast('guardado na fila de saída')
          setVersion((v) => v + 1)
          showToast(kind === 'reply' ? 'resposta publicada' : 'publicado')
        }}
      />
      <Ajustes screen={ajustes} onNavigate={setAjustes} onClose={() => setAjustes(null)} onInfo={takeInfo} />
      <StatusBar style={light ? 'light' : 'dark'} />
    </View>
  )
}

export default function App () {
  useEffect(() => { loadIcons().catch(() => {}) }, [])
  if (GATE_URL) {
    const GateScreen = require('./src/gate/GateScreen').default
    return (
      <SafeAreaProvider>
        <GateScreen url={GATE_URL} />
      </SafeAreaProvider>
    )
  }
  return (
    <SafeAreaProvider>
      <NodeProvider>
        <NamesProvider>
          <OutboxProvider>
            <Member />
          </OutboxProvider>
        </NamesProvider>
      </NodeProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1, backgroundColor: colors.bg },
  hidden: { display: 'none' },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 8 },
  brand: { fontSize: 18, fontWeight: '700', color: colors.accent },
  soft: { fontSize: 14, color: colors.soft },
  shell: { flex: 1, width: '100%', maxWidth: layout.column, alignSelf: 'center', backgroundColor: colors.bg },
  shellWide: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.line },
  setupBody: { padding: 16, gap: 12 },
  link: { alignItems: 'center', paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.bg },
  linkText: { fontSize: 15, fontWeight: '600', color: colors.accent },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: colors.ink,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14
  },
  toastText: { ...type.counter, color: '#ffffff' }
})
