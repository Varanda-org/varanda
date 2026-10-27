// The app shell: the first connection, the onboarding (src/onboarding.js
// decides the step: on the web's browser node 'Entrar' with the passkey, the
// account link; natively identity and member certificate; then the own name)
// and then five tabs (A Rua, Espiadinha, Seguindo, Avisos, Diário) with the top bar, the
// 'Sem internet' note under it (only while offline), the 'Instalar o Varanda'
// note under it too (hosted web, phones and iPad; below 'Sem internet' when
// both show; its close is remembered for 30 days), the publish button and
// the sheets (Publicar, Ajustes). Sync is automatic and silent: this shell
// owns the intent (node.setAutoSync) and nothing else in the UI starts or
// stops a run; its details live in Ajustes → Sincronização. Above the tabs a
// small screen stack (src/nav.js) opens Conversa (a post and its replies) and
// Membro (a profile) as full-screen layers; the tabs stay mounted below.
// Back: the browser Back button (src/history.web.js; an in-app back calls
// history.back() so the history and the stack never drift), Escape on the
// web, the Android Back button (BackHandler); an open sheet closes first.
// Design: apps/site/artwork/app-design.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { BackHandler, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { NodeProvider, useNode } from './src/node'
import { NamesProvider, useNames } from './src/names'
import { parseReturn } from './src/account'
import * as nav from './src/nav'
import { bindHistory } from './src/history'
import { STEP_TITLES, onboardingStep } from './src/onboarding'
import { OutboxProvider, useOutbox, useOutboxDrain } from './src/outboxProvider'
import { Btn, ErrorText, Soft, Spinner, colors, errorText } from './src/ui'
import { Fab } from './src/ui/Fab'
import { OfflineNote } from './src/ui/OfflineNote'
import { InstallNote } from './src/ui/InstallNote'
import { useInstall } from './src/install'
import { loadIcons } from './src/ui/Icon'
import { TabBar } from './src/ui/TabBar'
import { TopBar } from './src/ui/TopBar'
import { layout, type } from './src/ui/theme'
import Avisos from './src/screens/Avisos'
import Ajustes from './src/screens/Ajustes'
import ARua from './src/screens/ARua'
import Conexao from './src/screens/Conexao'
import Conversa from './src/screens/Conversa'
import Denunciar from './src/screens/Denunciar'
import Diario from './src/screens/Diario'
import Espiadinha from './src/screens/Espiadinha'
import Identidade from './src/screens/Identidade'
import Membro from './src/screens/Membro'
import Perfil from './src/screens/Perfil'
import Publicar from './src/screens/Publicar'
import Seguindo from './src/screens/Seguindo'

// Inlined by Expo at build time; set only for the iOS worklet gate
// (docs/ios-gate.md).
const GATE_URL = process.env.EXPO_PUBLIC_VARANDA_GATE_URL

const TOAST_MS = 2500
const TAB_TITLES = { rua: 'A Rua', espiadinha: 'Espiadinha', seguindo: 'Seguindo', avisos: 'Avisos' }
// 'Um instante' offers 'Continuar mesmo assim' after this long.
const SLOW_LOOKUP_MS = 10000
// While the own profile is still unknown, it is asked again this often (the
// cache retries a failed key only when asked after its retry delay).
const LOOKUP_RETRY_MS = 5000
const READY_TOAST = 'Tudo pronto. Siga pessoas para encher a Rua.'

// The steps the setup branch (Identidade) renders; the others belong to the
// shell (spinner, Perfil, the tabs).
const SETUP_STEPS = new Set(['entrar', 'recuperando', 'vinculo', 'identidade', 'certificado'])

// True when this page load is the return from the Google step of the account
// link (?conta=…). Read at import, before any screen renders; only read here:
// Identidade's LinkCard is the one that removes the query. Native has no
// location.
const LINK_RETURN = (() => {
  try { return parseReturn(globalThis.location?.search) !== null } catch { return false }
})()

// True when node.info confirms an identity and a member certificate.
function setupComplete (info) {
  return info !== null && info.publicKey !== null && info.memberCert === true
}

function Member () {
  const node = useNode()
  const names = useNames()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const install = useInstall()
  const ready = node.phase === 'ready'
  // Once the node was ready the tree stays mounted for good: a disconnect,
  // another tab taking over or a restart never unmounts the screens, so
  // drafts survive.
  const [seen, setSeen] = useState(false)
  useEffect(() => { if (ready) setSeen(true) }, [ready])

  const [tab, setTab] = useState('rua')
  // Per tab, bumped when its tab is selected again: the screen scrolls to top.
  const [scrollSignal, setScrollSignal] = useState({})
  // reply and quote are mutually exclusive.
  const [composer, setComposer] = useState({ open: false, reply: null, quote: null })
  // The screens pushed above the tabs (src/nav.js), oldest first.
  const [stack, setStack] = useState(nav.EMPTY)
  const stackRef = useRef(stack)
  const [ajustes, setAjustes] = useState(null)
  // The report sheet's target: null | { author, name, username, seq, text }.
  const [report, setReport] = useState(null)
  // 'Pular por enquanto' / 'Continuar mesmo assim': session-only, so the name
  // is asked again only after a reload.
  const [skippedName, setSkippedName] = useState(false)
  // True once this identity reached the tabs in this page session.
  const [reachedTabs, setReachedTabs] = useState(false)
  const [version, setVersion] = useState(0)
  // Avisos has something unseen: a plain dot on its tab, never a number.
  const [avisosNew, setAvisosNew] = useState(false)
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
    setReachedTabs(false)
  }, [generation])

  // With a passkey the setup step reads node.info through Identidade (which
  // holds it back while the sync after an unlock runs, since any member
  // request would preempt that run); the shell reads it once the tabs show.
  const shellReads = passkey === null || setupDone
  useEffect(() => { if (ready && !locked && shellReads) readInfo() }, [ready, locked, shellReads, generation, version, readInfo])

  const confirmed = setupComplete(info) &&
    (passkey === null || (!locked && pkStatus !== null && info.publicKey === pkStatus.publicKey))
  useEffect(() => { if (confirmed) setSetupDone(true) }, [confirmed])
  // A lock, unlock or reset discards the report sheet (and with it any
  // signature still held in its memory).
  useEffect(() => setReport(null), [generation, locked])
  useEffect(() => {
    if (!locked) return
    setSetupDone(false)
    setReachedTabs(false)
    setInfo(null)
  }, [locked])
  const setupStep = locked || (!setupDone && !confirmed)

  // The sync intent: continuous sync is wanted as soon as the certificate is
  // confirmed (the profile step does not gate it), never while locked or
  // while the recovery run after an unlock is on. The provider does the rest.
  const recovering = passkey !== null && passkey.recovering === true
  const { setAutoSync } = node
  useEffect(() => {
    setAutoSync(ready && !locked && setupDone && !recovering)
  }, [ready, locked, setupDone, recovering, setAutoSync])

  // Back from the Google step with a certificate already held: the tabs show
  // after the unlock, so open Ajustes → Conta once, where the account card offers
  // 'confirmar vínculo'. While the setup step shows, its embedded Identidade
  // handles the return.
  const linkReturnRef = useRef(LINK_RETURN)
  useEffect(() => {
    if (setupStep || !linkReturnRef.current) return
    linkReturnRef.current = false
    setAjustes('conta')
  }, [setupStep])

  // The own profile (one profile.read through the profiles cache): the
  // onboarding's name step, the Publicar avatar and the own rows.
  const ownKey = info ? info.publicKey : null
  const { resolve } = names
  useEffect(() => { if (setupDone && ownKey) resolve(ownKey) }, [setupDone, ownKey, resolve])

  // The onboarding step (src/onboarding.js). A failed lookup is not evidence
  // that the profile is absent: profileKnown is true only once the cache
  // answered (or the node has no profile.read).
  const ownProfile = ownKey ? names.profileOf(ownKey) : undefined
  const mode = passkey !== null && node.hosted ? 'hosted' : (node.canConfigure ? 'native' : 'serve')
  const onboarding = onboardingStep({
    mode,
    locked,
    recovering,
    hasIdentity: info !== null && info.publicKey !== null,
    memberCert: info !== null && info.memberCert === true,
    profileKnown: ownProfile !== undefined || names.unsupported === true,
    hasName: !!(ownProfile && ownProfile.name),
    skippedName
  })
  // The latched setupDone rule above decides between the setup branch and the
  // shell's steps; the step machine only names the step within each.
  let { step, index, total } = onboarding
  if (setupStep && !SETUP_STEPS.has(step)) {
    step = mode === 'hosted' ? 'vinculo' : 'certificado'
    index = 1
  } else if (!setupStep && SETUP_STEPS.has(step)) {
    step = 'pronto'
    index = total
  } else if (!setupStep && reachedTabs && (step === 'carregando' || step === 'perfil')) {
    // Latched like setupDone: once this identity reached the tabs, a cleared
    // names cache (a reconnection) never brings the onboarding back, which
    // would unmount the tabs and lose drafts and scroll positions.
    step = 'pronto'
    index = total
  }
  useEffect(() => { if (!setupStep && step === 'pronto') setReachedTabs(true) }, [setupStep, step])

  // 'Um instante': the cache retries the own key while it is unknown, and
  // after SLOW_LOOKUP_MS the person may continue without a name.
  const loadingProfile = step === 'carregando'
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loadingProfile) {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), SLOW_LOOKUP_MS)
    return () => clearTimeout(timer)
  }, [loadingProfile])
  useEffect(() => {
    if (!loadingProfile || !ownKey) return
    const timer = setInterval(() => resolve(ownKey), LOOKUP_RETRY_MS)
    return () => clearInterval(timer)
  }, [loadingProfile, ownKey, resolve])

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const showToast = (text) => {
    clearTimeout(toastTimer.current)
    setToast(text)
    toastTimer.current = setTimeout(() => setToast(''), TOAST_MS)
  }

  // The outbox (browser node) is sent only while a publish could go out
  // right now: unlocked, set up (the member certificate exists), not
  // recovering, online, and with no ONCE run active or starting. A continuous
  // run is preempted and restarted by the node (the browser node skips its
  // own push when the intent is continuous, packages/web-member/lib/session.js
  // L440), so the outbox drains while it is active; only a once run (the
  // recovery, a write gate) must not be interrupted. The approval rule of the
  // outbox (src/outboxProvider.js) is untouched.
  const outbox = useOutbox()
  useOutboxDrain({
    enabled: ready && !locked && setupDone && !(passkey && passkey.recovering) &&
      node.online !== false && node.visible !== false && !(node.sync.active && node.sync.active.once) && node.sync.starting !== true &&
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
    showToast(lastSent.kind === 'reply' ? 'resposta publicada' : 'publicado')
  }, [lastSent])

  // The follows changed (here or on another device, node.followsVersion): A
  // Rua and the follow count reload.
  const followsVersion = node.followsVersion
  const followsVersionRef = useRef(followsVersion)
  useEffect(() => {
    if (followsVersion === followsVersionRef.current) return
    followsVersionRef.current = followsVersion
    setVersion((v) => v + 1)
  }, [followsVersion])
  const followCount = typeof node.followCount === 'number' ? node.followCount : (info ? info.followCount : null)

  const startReply = (r) => setComposer({ open: true, reply: r, quote: null })
  const startQuote = (q) => setComposer({ open: true, reply: null, quote: q })

  // --- the screen stack ---
  const historyRef = useRef(null)
  const commitStack = useCallback((next) => {
    stackRef.current = next
    setStack(next)
  }, [])
  // Web: the browser Back button pops (one history entry per pushed screen).
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const binding = bindHistory({
      depthOf: () => nav.depth(stackRef.current),
      onBack: (n) => {
        if (sheetOpenRef.current) {
          // A sheet is open: Back closes it first and the screen stays. The
          // popstate already stepped the history back, so the entries it
          // dropped are pushed again (history depth stays equal to the stack).
          setComposer((c) => ({ ...c, open: false }))
          setReport(null)
          setAjustes(null)
          const h = globalThis.history
          const d = nav.depth(stackRef.current)
          if (h && typeof h.pushState === 'function') {
            for (let k = d - n + 1; k <= d; k++) {
              try { h.pushState({ varanda: k }, '') } catch {}
            }
          }
          return
        }
        let s = stackRef.current
        for (let i = 0; i < n; i++) s = nav.pop(s)
        commitStack(s)
      }
    })
    historyRef.current = binding
    return () => {
      binding.unbind()
      historyRef.current = null
    }
  }, [commitStack])
  const pushScreen = useCallback((entry) => {
    const next = nav.push(stackRef.current, entry)
    if (next === stackRef.current) return
    commitStack(next)
    if (historyRef.current) historyRef.current.pushed()
  }, [commitStack])
  // The history entry on top is ours (tagged with the stack depth).
  const historyInStep = () => {
    const h = Platform.OS === 'web' ? globalThis.history : null
    const d = nav.depth(stackRef.current)
    return !!h && typeof h.back === 'function' && d > 0 && h.state && h.state.varanda === d ? h : null
  }
  // In-app back (the top bar, Escape): on the web through history.back(), so
  // the popstate handler pops and both stay in step; otherwise directly.
  const goBack = useCallback(() => {
    if (nav.depth(stackRef.current) === 0) return
    const h = historyInStep()
    if (h) h.back()
    else commitStack(nav.pop(stackRef.current))
  }, [commitStack])
  // Empties the stack (and, on the web, steps back over its history entries).
  const clearStack = useCallback(() => {
    const d = nav.depth(stackRef.current)
    if (d === 0) return
    const h = historyInStep()
    commitStack(nav.reset())
    if (h && typeof h.go === 'function') {
      try { h.go(-d) } catch {}
    }
  }, [commitStack])
  const openThread = useCallback(({ ref, seed } = {}) => {
    pushScreen({ screen: 'conversa', key: ref, params: { seed: seed || null } })
  }, [pushScreen])
  const openMember = useCallback((author, seed) => {
    const key = typeof author === 'string' ? author.toLowerCase() : author
    if (typeof ownKey === 'string' && key === ownKey.toLowerCase()) {
      clearStack()
      setTab('diario')
      return
    }
    pushScreen({ screen: 'membro', key, params: { seed: seed || null } })
  }, [pushScreen, clearStack, ownKey])
  // A lock, unlock or reset closes the pushed screens too.
  useEffect(() => clearStack(), [generation, locked, clearStack])

  // A sheet open over the screens closes first (its Modal handles Back and
  // Escape itself).
  const sheetOpen = composer.open || report !== null || ajustes !== null
  const sheetOpenRef = useRef(sheetOpen)
  sheetOpenRef.current = sheetOpen
  useEffect(() => {
    if (Platform.OS === 'android') {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (sheetOpenRef.current || nav.depth(stackRef.current) === 0) return false
        commitStack(nav.pop(stackRef.current))
        return true
      })
      return () => sub.remove()
    }
    if (Platform.OS !== 'web' || typeof globalThis.addEventListener !== 'function') return
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || sheetOpenRef.current || nav.depth(stackRef.current) === 0) return
      goBack()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [commitStack, goBack])
  const openComposer = () => setComposer((c) => ({ ...c, open: true }))
  const reselectTab = (id) => setScrollSignal((s) => ({ ...s, [id]: (s[id] || 0) + 1 }))

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

  // The 'Conexão' footer of the setup steps: only where a person may have to
  // configure the node (native, manual web setups), never on the hosted page.
  const connectionLink = mode === 'hosted'
    ? null
    : (
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
      // embedded: the top bar above already carries the step's title
      body = <Identidade active={ready} embedded setup step={step} index={index} total={total} onInfo={takeInfo} />
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
        <TopBar title={STEP_TITLES[step]} />
        <OfflineNote />
        <View style={styles.flex}>{body}</View>
        {connectionLink}
      </View>
    )
  } else if (step === 'carregando') {
    // The own profile is being looked up (sync already runs in the background).
    content = (
      <View style={[styles.shell, wide && styles.shellWide]}>
        <TopBar title={STEP_TITLES[step]} />
        <OfflineNote />
        <View style={styles.center}>
          <Spinner size='large' />
          {slow
            ? <Btn label='Continuar mesmo assim' secondary onPress={() => setSkippedName(true)} />
            : null}
        </View>
      </View>
    )
  } else if (step === 'perfil') {
    // 'Como você quer aparecer': the saved name goes into the profiles cache
    // (the step machine then shows the tabs) and the welcome toast shows there.
    content = (
      <View style={[styles.shell, wide && styles.shellWide]}>
        <TopBar title={STEP_TITLES[step]} />
        <OfflineNote />
        <View style={styles.flex}>
          <Perfil
            page
            ownKey={ownKey}
            onSaved={(v) => {
              names.learn(ownKey, v)
              showToast(READY_TOAST)
            }}
            onSkip={() => setSkippedName(true)}
            index={index}
            total={total}
          />
        </View>
      </View>
    )
  } else {
    // The five tabs stay mounted (drafts and scroll survive a tab change);
    // `active` makes a screen reload its data when it is shown, and again
    // when the connection comes back.
    const on = (id) => tab === id && ready
    const shown = (id) => (tab === id ? styles.flex : styles.hidden)
    const stacked = nav.depth(stack) > 0
    const screenProps = {
      ownKey,
      onBack: goBack,
      onReply: startReply,
      onQuote: startQuote,
      onReport: setReport,
      onOpenThread: openThread,
      onOpenMember: openMember,
      onToast: showToast,
      onFollowsChanged: () => setVersion((v) => v + 1)
    }
    content = (
      <View style={[styles.shell, wide && styles.shellWide]}>
        {tab !== 'diario'
          ? <TopBar title={TAB_TITLES[tab]} />
          : null}
        <OfflineNote inset={tab === 'diario'} />
        {install.note !== 'none' ? <InstallNote kind={install.note} onInstall={() => { install.promptInstall() }} onClose={() => { install.dismissInstall() }} inset={tab === 'diario' && node.online !== false} /> : null}
        <View style={styles.flex}>
          <View style={shown('rua')}>
            <ARua
              active={on('rua')}
              refresh={version}
              onReply={startReply}
              onReport={setReport}
              onOpenThread={openThread}
              onOpenMember={openMember}
              onQuote={startQuote}
              ownKey={ownKey}
              scrollToTop={scrollSignal.rua}
              followCount={followCount}
              onFollowSomeone={() => setTab('seguindo')}
            />
          </View>
          <View style={shown('espiadinha')}>
            <Espiadinha
              active={on('espiadinha')}
              refresh={version}
              onReply={startReply}
              onReport={setReport}
              onOpenThread={openThread}
              onOpenMember={openMember}
              onQuote={startQuote}
              ownKey={ownKey}
              scrollToTop={scrollSignal.espiadinha}
              onFollowsChanged={() => setVersion((v) => v + 1)}
              onToast={showToast}
            />
          </View>
          <View style={shown('seguindo')}>
            <Seguindo
              active={on('seguindo')}
              onReport={setReport}
              onOpenThread={openThread}
              onOpenMember={openMember}
              onQuote={startQuote}
              scrollToTop={scrollSignal.seguindo}
              onFollowsChanged={() => setVersion((v) => v + 1)}
            />
          </View>
          <View style={shown('avisos')}>
            <Avisos
              active={on('avisos')}
              refresh={version}
              ownKey={ownKey}
              scrollToTop={scrollSignal.avisos}
              onFollowsChanged={() => setVersion((v) => v + 1)}
              onToast={showToast}
              onBadge={setAvisosNew}
            />
          </View>
          <View style={shown('diario')}>
            <Diario
              active={on('diario')}
              refresh={version}
              onSettings={setAjustes}
              onReply={startReply}
              onPublish={openComposer}
              onOpenThread={openThread}
              onOpenMember={openMember}
              onQuote={startQuote}
              ownKey={ownKey}
              scrollToTop={scrollSignal.diario}
            />
          </View>
        </View>
        {stacked
          ? (
            <View style={styles.layer}>
              {stack.map((entry, i) => {
                const Screen = entry.screen === 'conversa' ? Conversa : Membro
                return (
                  <View key={i + ':' + entry.screen + ':' + entry.key} style={i === stack.length - 1 ? styles.flex : styles.hidden}>
                    <Screen entry={entry} {...screenProps} />
                  </View>
                )
              })}
            </View>
            )
          : null}
        {toast
          ? (
            <View style={[styles.toast, { bottom: (stacked ? 0 : layout.tabBar) + insets.bottom + 12 }]} pointerEvents='none'>
              <Text style={styles.toastText} accessibilityRole='alert'>{toast}</Text>
            </View>
            )
          : null}
        <Fab onPress={openComposer} />
        {stacked ? null : <TabBar current={tab} onSelect={setTab} onReselect={reselectTab} badges={{ avisos: avisosNew }} />}
      </View>
    )
  }

  // The own identity for the composer: from the profiles cache, never
  // derived from the key.
  const me = {
    publicKey: ownKey,
    name: ownProfile ? (ownProfile.name || null) : null,
    username: ownProfile ? (ownProfile.username || null) : null
  }
  // Light over the Diário band (dark over the offline note above it). The
  // sheets leave the status bar over the (dimmed) screen behind, so they keep
  // it light there too.
  const light = tab === 'diario' && step === 'pronto' && node.online !== false && nav.depth(stack) === 0

  return (
    <View style={styles.root}>
      {content}
      <Publicar
        open={composer.open}
        reply={composer.reply}
        quote={composer.quote}
        me={me}
        onClose={() => setComposer((c) => ({ ...c, open: false }))}
        onClearReply={() => setComposer((c) => ({ ...c, reply: null }))}
        onClearQuote={() => setComposer((c) => ({ ...c, quote: null }))}
        onPublished={(kind, sentRef) => {
          // The reply context is dropped only if it is still the one sent; a
          // sent quote always drops the quote context.
          setComposer((c) => ({
            open: false,
            reply: c.reply && c.reply.ref === sentRef ? null : c.reply,
            quote: kind === 'quote' || (c.quote && c.quote.ref === sentRef) ? null : c.quote
          }))
          // Kept in the outbox: nothing new in the diary yet.
          if (kind === 'queued-post' || kind === 'queued-reply') return showToast('Vai sair quando a conexão voltar.')
          setVersion((v) => v + 1)
          showToast(kind === 'reply' ? 'resposta publicada' : 'publicado')
        }}
      />
      <Denunciar
        open={report !== null}
        target={report}
        onClose={() => setReport(null)}
        onSent={(text) => {
          setReport(null)
          showToast(text)
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
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg },
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
